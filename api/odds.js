// Vercel serverless function: GET /api/odds
// Pulls Kalshi + Polymarket (public, no key) and FanDuel via The Odds API (key in env ODDS_API_KEY).
const LEAGUES = {
  NBA: { odds: "basketball_nba",         kalshi: "KXNBAGAME",    poly: ["nba"],                              top: false },
  NHL: { odds: "icehockey_nhl",          kalshi: "KXNHLGAME",    poly: ["nhl"],                              top: false },
  CFB: { odds: "americanfootball_ncaaf", kalshi: "KXNCAAFGAME",  poly: ["cfb", "college-football"],          top: true  },
  CBB: { odds: "basketball_ncaab",       kalshi: "KXNCAAMBGAME", poly: ["cbb", "college-basketball"],        top: true  }
};
// Cache lifetimes (ms). FanDuel is slow on purpose to protect your Odds API credits.
const WINDOW_HOURS = { pro: 36, top: 120 };  // NBA/NHL: next 36h. College: next 5 days.
const MAX_PER_DAY = parseInt(process.env.MAX_COLLEGE_PER_DAY, 10) || 10; // college: top N per day by volume
const TTL_FAST = 15000;                                   // Kalshi + Polymarket
const TTL_ODDS = (parseInt(process.env.ODDS_TTL_SECONDS, 10) || 300) * 1000; // FanDuel

const cache = {};
async function cached(key, ttl, fn) {
  const c = cache[key];
  if (c && Date.now() - c.t < ttl) return c.v;
  try { const v = await fn(); cache[key] = { t: Date.now(), v }; return v; }
  catch (e) { return c ? c.v : null; }
}
async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(url.split("?")[0] + " " + r.status);
  return r.json();
}

// ---------- team-name matching ----------
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// strict (college): the school name must appear; a shared mascot ("Tigers", "Bulldogs") alone never counts.
function score(text, team, strict) {
  const t = " " + norm(text) + " ", w = norm(team).split(" ");
  const nick = w[w.length - 1], school = w.slice(0, -1).join(" ");
  let s = 0;
  if (!strict && nick.length >= 3 && t.includes(" " + nick + " ")) s += 2;
  if (school.length >= (strict ? 2 : 4) && t.includes(" " + school + " ")) s += strict ? 3 : 1;
  return s;
}
function side(text, away, home, strict) {
  const a = score(text, away, strict), h = score(text, home, strict);
  return a > h ? 0 : h > a ? 1 : -1;
}

// ---------- Kalshi (official public Trade API, no key) ----------
const KALSHI_HOSTS = ["https://api.elections.kalshi.com", "https://external-api.kalshi.com"];
async function kalshiEvents(series) {
  let err;
  for (const h of KALSHI_HOSTS) {
    try {
      return (await getJSON(`${h}/trade-api/v2/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=200`)).events;
    } catch (e) { err = e; }
  }
  throw err;
}
// Current API returns dollar strings ("0.5600") plus *_size_fp depth; older shape returned cents. Output is in cents.
const toCents = (m, f) => {
  const d = m[f + "_dollars"];
  if (d != null && d !== "") return parseFloat(d) * 100;
  return m[f] != null ? m[f] : null;
};
const pos = v => (v != null && !isNaN(v) && v > 0) ? v : null;
const num = v => (v != null && v !== "" && !isNaN(parseFloat(v))) ? parseFloat(v) : null;
// Midpoint of best bid/ask; if the book is wider than 10c, use the last trade instead.
function kalshiQuote(m) {
  const bid = pos(toCents(m, "yes_bid")), ask = pos(toCents(m, "yes_ask")), last = pos(toCents(m, "last_price"));
  if (bid != null && ask != null) {
    const mid = (ask - bid) <= 10 ? (ask + bid) / 2 : (last != null ? last : (ask + bid) / 2);
    return { mid, bid, ask, bidSize: num(m.yes_bid_size_fp), askSize: num(m.yes_ask_size_fp), src: "book" };
  }
  return last != null ? { mid: last, bid: null, ask: null, src: "last" } : null;
}
function matchKalshi(events, away, home, strict) {
  for (const e of events || []) {
    const ms = (e.markets || []).filter(m => !m.status || ["active", "open"].includes(m.status));
    const blob = [e.title, e.sub_title, ...ms.map(m => m.yes_sub_title || m.subtitle || "")].join(" ");
    if (!(score(blob, away, strict) > 0 && score(blob, home, strict) > 0)) continue;
    const out = [null, null];
    for (const m of ms) {
      const s = side([m.yes_sub_title, m.subtitle, m.title].join(" "), away, home, strict);
      if (s >= 0 && out[s] == null) out[s] = kalshiQuote(m);
    }
    if (out[0] != null || out[1] != null) {
      out.vol = ms.reduce((t, m) => t + (num(m.volume_24h_fp) || num(m.volume_fp) || 0), 0);
      return out;
    }
  }
  return [null, null];
}

// ---------- Polymarket ----------
const parseArr = v => { try { return typeof v === "string" ? JSON.parse(v) : v || []; } catch (e) { return []; } };
function matchPoly(events, away, home, strict) {
  for (const e of events || []) {
    if (!(score(e.title, away, strict) > 0 && score(e.title, home, strict) > 0)) continue;
    for (const m of e.markets || []) {
      const mt = (m.sportsMarketType || "").toLowerCase();
      if (mt && mt !== "moneyline") continue; // skip spreads / totals / props
      const names = parseArr(m.outcomes), prices = parseArr(m.outcomePrices), toks = parseArr(m.clobTokenIds);
      const tok = [null, null], gam = [null, null];
      names.forEach((n, i) => {
        const s = side(n, away, home, strict);
        if (s >= 0) { tok[s] = toks[i] || null; gam[s] = prices[i] != null ? parseFloat(prices[i]) : null; }
      });
      if (gam[0] != null && gam[1] != null) return { tok, gam, vol: num(e.volume24hr) || num(e.volume) || 0 };
    }
  }
  return { tok: [null, null], gam: [null, null] };
}

// ---------- Polymarket CLOB: live order books (public, no auth) ----------
const bookCache = {};
async function loadBooks(tokens) {
  const need = [...new Set(tokens.filter(Boolean))]
    .filter(t => !(bookCache[t] && Date.now() - bookCache[t].t < 10000));
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    try {
      const r = await fetch("https://clob.polymarket.com/books", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk.map(token_id => ({ token_id })))
      });
      if (!r.ok) throw new Error(r.status);
      for (const b of await r.json()) {
        const bids = (b.bids || []).map(x => parseFloat(x.price));
        const asks = (b.asks || []).map(x => parseFloat(x.price));
        bookCache[b.asset_id] = {
          t: Date.now(),
          bid: bids.length ? Math.max(...bids) : null,
          ask: asks.length ? Math.min(...asks) : null,
          last: b.last_trade_price != null ? parseFloat(b.last_trade_price) : null
        };
      }
    } catch (e) { /* fall back to Gamma prices */ }
  }
}
// Mirrors Polymarket's own display: midpoint of best bid/ask, unless the book is wide (>10c), then last trade.
function polyQuote(tok, gam) {
  const b = tok && bookCache[tok];
  if (b && b.bid != null && b.ask != null) {
    const mid = (b.ask - b.bid) <= 0.10 ? (b.ask + b.bid) / 2 : (b.last != null ? b.last : gam != null ? gam : (b.ask + b.bid) / 2);
    return { mid: mid * 100, bid: b.bid * 100, ask: b.ask * 100, src: "clob" };
  }
  return gam != null ? { mid: gam * 100, bid: null, ask: null, src: "gamma" } : null;
}

module.exports = async (req, res) => {
  const key = process.env.ODDS_API_KEY;
  const now = Date.now(), games = [];

  await Promise.all(Object.entries(LEAGUES).map(async ([lg, cfg]) => {
    const [fd, kal, ...poly] = await Promise.all([
      key ? cached("fd" + lg, TTL_ODDS, () => getJSON(
        `https://api.the-odds-api.com/v4/sports/${cfg.odds}/odds/?apiKey=${key}&regions=us&markets=h2h&bookmakers=fanduel&oddsFormat=american`)) : null,
      cached("k" + lg, TTL_FAST, () => kalshiEvents(cfg.kalshi)),
      ...cfg.poly.map(tag => cached("p" + tag, TTL_FAST, () => getJSON(
        `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=${tag}&limit=200`)))
    ]);
    const polyEvents = poly.flat().filter(Boolean);

    // Base list of games: FanDuel's schedule if available, else Kalshi's events
    for (const g of fd || []) {
      const start = Date.parse(g.commence_time);
      if (start > now + (cfg.top ? WINDOW_HOURS.top : WINDOW_HOURS.pro) * 3600e3 || start < now - 4 * 3600e3) continue;
      const o = ((g.bookmakers || [])[0]?.markets || [])[0]?.outcomes || [];
      const a = o.find(x => x.name === g.away_team), h = o.find(x => x.name === g.home_team);
      const k = matchKalshi(kal, g.away_team, g.home_team, cfg.top);
      const p = matchPoly(polyEvents, g.away_team, g.home_team, cfg.top);
      const hasEx = k.some(v => v != null) || p.gam.some(v => v != null);
      if (cfg.top && !hasEx) continue; // college: only games the exchanges list = "top matchups"
      games.push({ league: lg, id: g.id, start, away: g.away_team, home: g.home_team,
        fd: [a ? a.price : null, h ? h.price : null], k, p: null, _p: p, vol: Math.round((k.vol || 0) + (p.vol || 0)) });
    }
  }));

  // College: keep only the top MAX_PER_DAY games per league per day (ET), ranked by exchange volume
  const day = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const buckets = {};
  for (const g of games) if (LEAGUES[g.league].top) (buckets[g.league + "|" + day(g.start)] ||= []).push(g);
  const drop = new Set();
  for (const list of Object.values(buckets)) {
    list.sort((a, b) => b.vol - a.vol).slice(MAX_PER_DAY).forEach(g => drop.add(g));
  }
  for (let i = games.length - 1; i >= 0; i--) if (drop.has(games[i])) games.splice(i, 1);

  await loadBooks(games.flatMap(g => g._p.tok));
  for (const g of games) {
    g.p = [polyQuote(g._p.tok[0], g._p.gam[0]), polyQuote(g._p.tok[1], g._p.gam[1])];
    delete g._p;
  }
  games.sort((a, b) => a.start - b.start);
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  res.status(200).json({ updated: now, hasKey: !!key, games });
};
