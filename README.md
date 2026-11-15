# Market Compare (Vercel)

Live comparison of Kalshi, Polymarket and FanDuel for NBA, NHL, college football and men's college basketball.

## Deploy
1. Install the CLI: `npm i -g vercel` (or push this folder to GitHub and import it at vercel.com/new).
2. From this folder run `vercel` and accept the defaults (no framework, no build command).
3. Add your key: Project → Settings → Environment Variables → `ODDS_API_KEY` = your Odds API key (all environments).
   CLI alternative: `vercel env add ODDS_API_KEY`.
4. Redeploy: `vercel --prod`.

Never put the key in index.html. It only lives in the server function (api/odds.js).

## Time windows and college cap
- NBA and NHL show games starting within the next 36 hours (plus games that started in the last 4 hours).
- College football and men's basketball show the next 5 days, but only games that Kalshi or Polymarket lists, and only the
  top 10 per league per day (Eastern time), ranked by combined exchange volume. Change the cap with `MAX_COLLEGE_PER_DAY`.
  Edit `WINDOW_HOURS` at the top of `api/odds.js` to change the windows.

## Tuning
- `ODDS_TTL_SECONDS` (optional env var, default 300): how often FanDuel is refreshed. Each refresh costs
  1 Odds API credit per league (4 per refresh). Every 5 minutes is about 1,150 credits/day if the page
  is open all day, so watch your plan's quota, or raise this value.
- Kalshi and Polymarket refresh about every 15 seconds (shared across all viewers via Vercel's cache).

## How Polymarket data is gathered
- Gamma API (`gamma-api.polymarket.com/events`) finds the game and its moneyline market, including each outcome's `clobTokenIds`.
- CLOB API (`POST clob.polymarket.com/books`, public, no key) returns the live order book for those tokens in one batch call.
  The page shows the midpoint of best bid and best ask (like polymarket.com does, falling back to last trade if the book is wider than 10 cents), plus the bid/ask.
- If the CLOB call fails, it falls back to Gamma's cached `outcomePrices`.

## How Kalshi data is gathered
- Kalshi's official public Trade API (`/trade-api/v2/events?series_ticker=...&status=open&with_nested_markets=true`) lists each game and its per-team markets.
  Needs no key. Tries `api.elections.kalshi.com`, then `external-api.kalshi.com` if the first fails.
- Reads the current dollar-string fields (`yes_bid_dollars`, `yes_ask_dollars`, `last_price_dollars`) and falls back to the older cents fields.
- Price shown = midpoint of best Yes bid/ask (last trade if the book is wider than 10 cents or one-sided). Only active/open markets are used.
- Kalshi's authenticated order-book endpoints would only add depth beyond the best bid/ask, which this comparison doesn't need, so no Kalshi key is required.

## Things to verify after deploying
- Kalshi series tickers (KXNBAGAME, KXNHLGAME, KXNCAAFGAME, KXNCAAMBGAME) and Polymarket tag slugs
  (nba, nhl, cfb, college-football, cbb, college-basketball) are in LEAGUES at the top of api/odds.js.
  If a league shows no Kalshi/Polymarket prices, check those names first.
- Games are matched across venues by team name. Mismatches show "—" for that venue.
- College leagues only list games that Kalshi or Polymarket also have markets on (that's the "top matchups" filter).
- Open https://YOUR-SITE.vercel.app/api/odds to see the raw JSON for debugging.
