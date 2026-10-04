# market service

Local game + account service behind lyra's `owngames` game source. It owns the
realtime price walk for **Bolsa — Trading Floor**, serves the game itself, and
keeps both the market and every player's statistics on disk.

## run it

```bash
bun services/market/server.mjs      # or: bun run dev:market
```

`bun run dev` also spawns it automatically (see `ALL_DEV_SERVICES` in
`server/dev.mjs`) and `server/prod.mjs` proxies `/owngames/`, `/api/market/` and
`/ws/market` to it.

Environment:

| variable            | default            | purpose                              |
| ------------------- | ------------------ | ------------------------------------ |
| `MARKET_PORT`       | `4006`             | listen port                          |
| `MARKET_HOST`       | `127.0.0.1`        | bind host                            |
| `MARKET_TICK_MS`    | `1000`             | market tick interval (min 200ms)     |
| `MARKET_DATA_DIR`   | `services/market/data` | where the json files are written |
| `MARKET_HISTORY_DELAY_MS` | `15000`        | how often the rolling history files are written |
| `MARKET_ADMIN_NAMES`| *(empty)*          | comma separated account names allowed to open the **remote** admin console (the deploy-time half of the allow-list) |
| `JWT_SECRET`        | *(empty)*          | the same secret cloudsync signs its session JWT with. when set, the market also accepts that JWT (cookie `token`) as a session, resolving/provisioning the market account by username (SSO). unset = SSO off, own accounts only |

## where everything lives

The service is split by *what changes for what reason*, so adding a company, a
headline or a retune never means touching the simulation:

| file                          | what it holds                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `companies.mjs`               | the catalog (`MARKET_SYMBOLS`) and each company's own character: growth, momentum, trend odds/length, cycle, surprise rhythm, news sensitivity, plus the readable tags the UI shows |
| `headlines.mjs`               | the news copy: areas, up/down and surprise templates, and the builders that turn a 0..1 pick into a printed title |
| `tuning.mjs`                  | the game clock, the market model knobs and the rolling candle windows (`HISTORY_WINDOW_DAYS`, `TIMEFRAMES`, `CANDLE_RESOLUTIONS`) |
| `engine.mjs`                  | the simulation itself: the model per game minute, sessions, candle aggregation, the day based rolling eviction and the deep-history backfill. it imports the four files above and re-exports them, so `server.mjs` and the tests keep importing everything from `engine.mjs` |
| `history.mjs`                 | the on-disk rolling history: one file per company and game day, plus that company's daily series. it decides what is new, what belongs to a closed day and which fragment is now outside the window |
| `accounts.mjs`, `passwords.mjs` | accounts, scrypt password hashes, portfolios, the cosmetic profile and the per-day net-worth samples |
| `data/admins.json`            | the persisted admin allow-list (see the console section). absent or empty means no remote admin |
| `admin.mjs`                   | the game-master console server side: the routes under `/api/market/admin/*`, the player list and a ring buffer of what was done |
| `leaderboard.mjs`             | the ranking: values every stored portfolio at the live quotes on request, keeps one net-worth sample per game day and applies the period filters |
| `events.mjs`                  | the chained market events: the stories, their timed steps and the websocket frames that let every client watch the same sequence |
| `server.mjs`, `store.mjs`     | HTTP + websocket surface and the atomic json store |

The game client is split the same way. `js/catalog.js` keeps the fallback
company list (the browser needs something to draw before the socket answers)
and the game rules (`START_CASH`, `RECAP_CASH`, `BANKRUPT_WAIT_MS`),
`js/news-copy.js` keeps the offline headline copy, `js/history-cache.js` keeps
the chart's history *on the player's machine* (see below), and the rest of `js/`
is one file per behaviour (`chart.js`, `market.js`, `order.js`, `portfolio.js`,
`hud.js`, `research.js`, `nav.js`, `auth.js`, `net.js`, `state.js`, `sound.js`,
`main.js`).
`js/admin.js` (with `css/admin.css`) is the player-side game-master console, and
`js/settings`-style values it can dial are read from `window.__adminParams` by
`state.js` (XP curve, toast duration, notification ceiling).

The progression systems are four more client files plus their styles
(`css/progression.css`): `js/profile.js` (avatar, banner, title, bio, privacy and
the expanded statistics), `js/achievements.js` (24 achievements, each one a
condition checked on a slow beat), `js/leaderboard.js` (the ranking, with a
deterministic offline fallback) and `js/cases.js` (the market cases minigame),
with `js/events.js` painting the chained events the service publishes.

## persistence

Everything is written atomically (temp file + rename) and flushed on
`SIGINT`/`SIGTERM` and on `exit`:

- `data/market.json` — every symbol's price, open, previous close, high, low and
  rolling price history, plus the news list and the live trade tape. The candle
  series are **not** here any more: keeping them out is what makes this file ~70
  KB instead of ~500 KB, so the save that runs every few seconds stays cheap.
- `data/history/<SYM>/d<YYYY-MM-DD>.json` — the 5m bars of one game day (compact
  `[t,o,h,l,c]` tuples). A day is written while it is open and gets its final
  bars when it closes, and then it is never touched again.
- `data/history/<SYM>/daily.json` — one bar per game day: the company's stored
  life, which is what the `1W` view scrolls through.
- `data/players.json` — accounts (name, scrypt hash + salt, timestamps),
  sessions and each player's cash, positions, transactions and statistics.

Restarting the server restores prices and statistics, so the market continues
where it stopped and players keep their progress.

## the rolling history window

The chart is a window that **slides**, and it is measured in whole game days, not
in bars (`HISTORY_WINDOW_DAYS`):

| series   | kept            | filled by                                             |
| -------- | --------------- | ----------------------------------------------------- |
| `intraday` (5m) | 20 game days | the per-day files; whatever is missing is drawn inside the daily candles at boot, so the window is full on the first frame |
| `hourly` (1h)   | 20 game days | derived from the 5m series (`rebuildHourly`), never stored twice |
| `daily` (1d)    | 400 game days | `daily.json`; this is the company's whole stored life  |

The moment a new game day opens, every bar of the days that no longer fit is
dropped **in one piece**, so the first bar of the window moves `1 -> 2 -> 3`
while the newest one keeps being appended. On disk that is literally deleting the
oldest day file. One real minute of play is one game day, so the deepest window
is about twenty real minutes wide.

The player's machine keeps its **own copy** of that window
(`public/bolsa-trading-floor/js/history-cache.js`, IndexedDB): the first time a
company is opened its window is downloaded once, and every later visit paints
from the local copy and asks the server only for the bars newer than its last one
(`?since=<t>`, answered with a `304` when nothing changed). The same store
remembers where the player was looking — how many bars and *which stretch of
time* — so switching companies or timeframes and coming back reopens the very
same window instead of jumping to the live edge, and the local copy rolls itself
day by day exactly like the server's.

## game clock

The market runs on **game time**: `GAME_SPEED = 1440` means one real minute is a
whole game day (2.5 real seconds per game hour). Ticks therefore step the
simulation in game minutes instead of wall clock seconds, every price and candle
timestamp is a game timestamp, and the client prints the tally next to
"(juego)". The clock starts at `GAME_EPOCH` (a monday at 09:00) and is persisted,
so a restart keeps the calendar. The first tick after a restart only anchors the
clock instead of advancing it, and a single tick can never jump more than three
game hours.

News headlines are deliberately rare: about **one per game week**
(`NEWS_CHANCE_PER_STEP`), i.e. roughly one every seven real minutes of play, and
the panel keeps the last thirty.

## the market model

The engine simulates a market instead of flipping a coin around the opening
price. Every game minute a symbol's log return is built from six pieces:

| piece                     | what it is                                                                 |
| ------------------------- | -------------------------------------------------------------------------- |
| market regime             | `alcista` / `bajista` / `lateral` mood lasting 2–22 game days, scaled by the symbol's `beta`. Rallies are short and strong, sell-offs long and gentle |
| sector mood               | a shared drift for the sector, 3–15 game days, chosen independently of the market |
| own trend                 | a company story (`drift`) lasting 1–6 game days, so one ticker can fly while the rest of the list does nothing |
| headline impulse          | news land **over game hours** (half life 240 game minutes) instead of jumping: a fifth is priced in at once, the rest walks in |
| anchor spring             | the price is pulled back to a rolling 5 game day average, which is what turns a run-up into a pullback |
| valuation band            | a soft wall ±49% around the long run level, so ninety game days of trading cannot turn a $230 stock into a $12 one |

Volatility clusters (it returns to 1 on its own and jumps after big moves), is
higher right after the open and before the close, and each symbol takes one
random draw per game minute — turned into a gaussian with Acklam's inverse normal
CDF — so the per step draw budget stays at ten prices plus one news roll.

On top of the headlines there is a rarer **company surprise** (an earnings
blowout, a takeover rumour): about one per symbol every 22 game days, ±8–38%,
announced as its own headline. That is what produces the occasional +20% day,
and the anchor spring is what makes the price give it back slowly.

A session rolls every game day: yesterday's close becomes the reference the
daily change is measured against and the high/low start again from the opening
gap. The market mood is exposed as `regime` in the snapshot.

### each company plays its own game

No two symbols share a parameter set. `MARKET_SYMBOLS` gives every company its
own growth (`alpha`), how well it keeps a trend (`momentum`), the odds a trend
goes up, its trend length and size, a slow cycle (three weeks for the banks, six
weeks for the food maker, three months for the software house, none for
telecoms), how often it surprises the market and how big that surprise is, and
how strongly it copies a sector headline. `companyProfile(sym)` turns that into
readable tags (`crecimiento`, `en declive`, `cíclica`, `volátil`,
`impredecible`, `defensiva`, `estable`) and the snapshot ships the whole list as
`profiles`, so the client can show *why* two tickers behave so differently.
Having a per symbol profile is also why the model can budget exactly two random
draws per company per game minute (one price draw, one cycle-nearest news roll).

Measured on the live service, each company's stored story spans ~420 game days
and none of the ten repeats another (total return, max/min range, best day and
worst drawdown all differ): total returns from `-27%` to `+150%`, ranges 3.2x–7x,
best days `+21.7%` … `+70.8%` and drawdowns to `-79%`. Some of that is by design
(`CSCB` is a biotech lottery with a shock every ten game days); the calm ones
(`BHVN`, `ORBF`, `HRBL`) stay under a 4x range.

Measured over 120 game days (10 symbols, 1200 symbol-days): daily moves of
±4.4% on average, six days beyond ±20%, a top day of +31%, five game day runs
between +27% and +129%, and prices kept inside a 1.6x–2.6x band.

### two prices: the live tape and the settlement reference

The server sends two numbers per symbol and they mean different things:

- `live` — the **tape**, the walk the model is walking right now. It moves on
every tick.
- `price` — the **settlement price**, fixed once every `SETTLE_DAYS` (2) game
days and then held. It is a *reference*, not the quote an order uses.

The client trades and marks at the **tape**: `applyMarketQuotes` copies `live`
into `m.price`, keeps the settlement in `m.settle`, and takes the day's change
(`liveChange`/`livePct`, measured against the previous close) as the alert
number. That single decision is what makes the whole interface move: the market
list, the ticker, the order panel, the open P/L, the wallet total and the
liquidations all read `m.price`, so they breathe with the tape instead of
standing still for two real minutes until the next settlement. The settlement
survives as the dashed `Ajuste $…` line on the chart and as the `ajuste $…` chip
in the asset summary, where the countdown to the next one is still printed.

An earlier version traded at the settlement price on purpose (so an order could
never slide away while the player typed a quantity). That made every list look
frozen between settlements and left a freshly bought position showing `+0.00%`,
which is exactly the bug this replaced.

### one path per company, one wobble on top

Each symbol keeps a **fundamental path** (`fund`) that the model walks, and the
intraday wobble (`swing`) is applied *on top* of it: `price = fund * exp(swing)`.
The wobble is what makes five minute bars tall and two sided — without it a bar
only carries a slice of a very slow drift and the tape looks dead — but because
it is a separate, clamped state (±5%, half life 45 game minutes) it can never
accumulate into a runaway day. Adding the step to the price every minute instead
of applying it on top was a real bug: after twenty game days one day spanned
70–130% instead of the usual 5–15%. The regression test walks twenty days and
asserts both the invariant (`price == fund * exp(swing)`) and the day span.

Measured over 90 clean game days: daily move of 3.9% on average (p90 8.8%, top
31.9%), a 5m body of 0.77% on average, and prices ending inside a 0.4x–1.8x band.

## who renders what

The server only **connects the numbers**: it simulates the market, persists the
rolling history and pushes a quote snapshot over the websocket. It never renders
a candle chart. The player's machine owns the rendering:

- `js/history-cache.js` installs each company's window in IndexedDB the first
time it is opened and then asks the server only for the gap (`?since=`, `ETag`),
so returning to a company costs ~3 KB instead of ~350 KB. The install asks for
the whole window (`limit` = the window size, and `CANDLE_MAX_LIMIT` is exactly
the deepest window the server keeps, 20 game days of 5m bars = 5760), so the
local copy and the server window are the same size — and because the window is
drawn in full at boot, that first request already returns twenty game days.
- `js/chart.js` builds the 15m and 1h series **on the client** from the 5m bars
(it never requests them), so switching timeframe is free, and it draws with a
single coalesced repaint per frame (`scheduleDraw`).
- `js/market.js` throttles list and panel refreshes to one every 400 ms and only
touches the DOM when a number actually changed.

- `js/main.js` paints the **mood of the market** next to the clock, from the
`regime` the server rides every tick: `alcista` (green), `bajista` (red) or
`lateral` (grey), plus how much real time the mood has left and how strong it
is. It is the same regime the model is drifting on, so the badge can never
disagree with the tape.

Measured on the running stack: the ten quotes the client holds match the server
exactly (delta 0¢), switching 5m → 15m → 1h issues **no** request, zooming to the
floor leaves the candles thin and packed (median body 9–10 px on a 12–14 px slot)
instead of fat, and one fresh install pulls the whole 5m window (5655 bars,
20 game days, 356 KB) in a single request that is then cached in IndexedDB while
later visits cost ~3 KB.

## endpoints

| method + path                     | auth   | purpose                                        |
| --------------------------------- | ------ | ---------------------------------------------- |
| `GET /owngames/catalog.json`      | none   | the catalog lyra's `owngames` source reads     |
| `GET /owngames/bolsa-trading-floor/` | none | the game itself                                |
| `GET /api/market/state`           | none   | snapshot: quotes, news, tape, tick interval    |
| `GET /api/market/history?symbol=` | none   | raw rolling price sequence                     |
| `GET /api/market/candles?symbol=&tf=&limit=&since=` | none | OHLC candles it renders (`tf` = `5m`, `15m`, `1h`, `1W`). `since` is the player's cursor: only the bars newer than it are built, and an `ETag`/`If-None-Match` round trip answers `304` when there is nothing new |
| `GET /api/market/leaderboard?metric=&period=&limit=` | optional | the ranking (metrics `net`, `roi`, `winrate`, `best`, `streak`; periods `all`, `today`, `week`, `month`). a token only adds the `me` entry |
| `POST /api/market/accounts`       | none   | create account → `{ token, account }`          |
| `POST /api/market/sessions`       | none   | log in → `{ token, account }`                  |
| `DELETE /api/market/sessions`     | bearer | log out                                        |
| `GET /api/market/me`              | bearer | the player's profile + portfolio               |
| `PUT /api/market/me`              | bearer | persist portfolio (and broadcast a trade)      |
| `GET /api/market/me/profile`      | bearer | the saved avatar, banner, title, bio and privacy |
| `PUT /api/market/me/profile`      | bearer | persist those (sanitized and clamped)          |
| `WS /ws/market`                   | none\* | `snapshot`, `tick`, `trade`, `news`, `admin-broadcast`, `kicked` and `pong` frames |
| `GET /api/market/admin/status`    | admin  | uptime, players, tick, regime, halted symbols  |
| `GET /api/market/admin/players`   | admin  | every account with its live balance           |
| `GET /api/market/admin/logs?since=` | admin | what the console did, newest first           |
| `POST /api/market/admin/shock`    | admin  | move a symbol (or `ALL`) by `{ pct, gradual }` |
| `POST /api/market/admin/news`     | admin  | publish a headline `{ sym, pct, title }`       |
| `POST /api/market/admin/earnings` | admin  | force an earnings surprise `{ sym, pct }`      |
| `POST /api/market/admin/regime`   | admin  | force the market mood `{ kind, strength, days }` |
| `POST /api/market/admin/halt`     | admin  | freeze/resume a symbol `{ sym, halt }`         |
| `POST /api/market/admin/pause`    | admin  | freeze/resume the clock `{ paused }`           |
| `POST /api/market/admin/speed`    | admin  | set the clock multiplier `{ speed }`           |
| `POST /api/market/admin/rally` `flash-crash` | admin | instant or gradual move of a symbol/`ALL` |
| `POST /api/market/admin/settle` `reset-prices` | admin | force a settlement / reset quotes |
| `POST /api/market/admin/broadcast`| admin  | toast + notification on every client `{ title, msg, kind }` |
| `POST /api/market/admin/params`   | admin  | retune the engine `{ section, params }` (tick + speed are honoured at runtime) |
| `POST /api/market/admin/player`   | admin  | `{ id, action: grant\|reset\|kick, amount? }`   |

\* pass `?token=` (or send `{"type":"auth","token":...}`) to identify the
socket; ticks are public so spectators see the same prices in real time. The
`/api/market/admin/*` routes require `Authorization: Bearer <token>` for an
account whose name is on `MARKET_ADMIN_NAMES`; anything else answers `403` (and
an anonymous request answers `401`).

## candles

Candle generation lives here, not in the browser: every simulation step is
folded into the stored resolutions (`engine.addSample`) and
`GET /api/market/candles` aggregates them into the requested timeframe. Each
tick broadcast and the connection snapshot also carry the still-open candle per
symbol, so the chart extends in real time instead of inventing bars. Building
candles from a single price per bar would make `open === close`, which is why the
chart used to draw only flat green candles.

| view  | bar length (game time) | bars kept (server) | built from |
| ----- | ---------------------- | ------------------ | ---------- |
| `5m`  | 5 game minutes         | 5760 (20 game days) | intraday — the rolling window |
| `15m` | 15 game minutes        | 1920 (20 game days) | intraday, aggregated in game time |
| `1h`  | 1 game hour            | 480 (20 game days)  | hourly — derived from the 5m bars |
| `1W`  | 1 game day             | 400                 | daily — the company's whole run |

The client asks for the deepest window the server keeps and holds on to every
bar it is handed, so the chart can be dragged, wheel-scrolled (shift) or walked
with the scrubber all the way back: `5m`/`15m` walk the last twenty game days,
`1h` the same twenty days in hourly bars and `1W` the company's whole stored
story (~400 game days), which is where a peak and the slow slide after it are
visible. `1W` still opens as a single game week of seven wide bars; zooming out
from there spreads the whole run across one view.

The stored windows start life empty, so `backfillHistory` draws the missing past
when the market is created or restored. It works from the daily series, which is
each company's own story (growth, cycle, trend length, surprise rhythm) and is
always generated in full:

- the **daily** series is rebuilt with the company's rules and scaled so it joins
the live price exactly;
- the **5m window** is then drawn *inside* those daily candles — every missing
game day is bridged from its open to its close, bounded by its low and high — so
nothing waits for the clock to fill up and the 5m view can never tell a different
story about a day than the `1W` view does. Bars the player already has (the day
files and the live tape) always win; only the unpainted stretches are invented.
  The seed is the symbol plus the bar time, so a restart paints the same past
  instead of reshuffling it, and a day that was written to disk is frozen.
- the **hourly** view is derived from that 5m window last, so `1h` arrives full as
  well.

That is why a brand new install opens with twenty game days of 5m detail instead
of growing its window while you watch. The price is disk: the first boot writes
one day file per company and game day (about 2.9 MB for the whole catalog).

On the client the panel is split in three: candles on top, a close price line
with an area fill underneath (so the trend reads as a line chart) and the time
axis at the bottom (`5m`/`15m` → `hh:mm`, `1h` → `dd/mm hh:00`, `1W` → `dd/mm`).
The price scale is computed from the visible candles only, and an entry line from
an old position is clamped to the pane edge instead of stretching the scale and
squashing every candle. Until the server has enough real candles for a timeframe
they are prefixed with filler bars that copy the real bars' range.

The game only ever talks to its own origin (`/api/market/...`, `/ws/market`), so
nothing is fetched from a third-party host and no network filter can block the
data. lyra proxies those paths in dev (`server/dev.mjs`) and prod
(`server/prod.mjs`, plus the Caddyfile written by `setup.sh`).

## the admin console (god mode)

The game ships a game-master console (`js/admin.js`) that opens with
**Ctrl+Shift+A**, with `?admin=1` / `#admin`, or from the shield button that
appears in the rail only when the signed-in account is an admin. It has six tabs:
proxies for the engine (pump/dump/crash/rally, regime, halt, pause, speed), the
engine parameters, the player list (grant cash, reset, kick), a live market table
with per-symbol shocks and a log of everything that was done.

It runs in two modes and picks one by itself:

- **remote** — the service has the `/api/market/admin/*` routes and the account
  is on the allow-list. Every event changes the real market for everyone.
- **local** — no server admin (or `?admin=1`). The same buttons mutate this
  client's own copy of `MARKET`, its clock and its mood, which makes the console
  a dev-tool that needs no setup at all. Nothing is sent anywhere.

The allow-list comes from two places, both optional:

- **`<dataDir>/admins.json`** — the persisted list, either `["nombre", ...]` or
  `{"names": ["nombre", ...]}`. This is the one to use for a grant you want to
  keep: it needs no environment variable, so it survives every restart however
  the service is launched.
- **`MARKET_ADMIN_NAMES`** — comma separated names, for a deploy-time list.

```bash
# the durable way
echo '["tu_nombre"]' > services/market/data/admins.json

# or the environment one
MARKET_ADMIN_NAMES=tu_nombre bun services/market/server.mjs
```

Both lists are re-applied on every boot, so a name that leaves them loses the
flag even if `players.json` still says `admin: true`; the corrected flags are
written back on boot so the file never keeps a stale one. `admin` is never
returned to a client that is not on the list, and a corrupt `admins.json` grants
nothing instead of taking the service down.

The console polls for status every two seconds, but the poll only repaints the
header, the badge and the footer: the **Eventos** and **Parámetros** tabs are
never rebuilt while it runs, so the symbol, the amount and the text you picked
survive the next poll as well as a trip to another tab and back.

## player progression

Four systems turn the simulator into something with a reason to come back, and
all of them work with no server at all (the game falls back to a local ranking
and to client-side event chains) while using the real thing when it is there.

- **Profile** — avatar (emoji + colour), banner, bio (120 chars), privacy and
  eight unlockable titles. It is stored in the save and synced to
  `/api/market/me/profile`, so the ranking can show who is who and the profile
  survives a reinstall. Alongside it the panel shows the expanded statistics:
  streak, best day, max drawdown, average time in a position and a net-worth
  sparkline built from the samples `trackNetProgress` takes every 15s.
- **Ranking** — `GET /api/market/leaderboard` values every stored portfolio at
  the live quotes (cash plus each position at its current price), so it is never
  stale. Five metrics and four periods, rank-movement arrows (the client
  remembers last run's ranks) and the gap to the player immediately above. A
  `private` profile still plays but does not appear for others. Offline it
  generates a deterministic 240-bot table instead, so the panel is never empty.
- **Chained events** — the service owns the stories: a rumour, a confirmation and
  then a regulator. Each step nudges the engine (`adminNudge`, so a sector-wide
  story prints one headline and still moves every company) and goes out as an
  `event-chain` / `event-step` frame; every client paints the same banner and
  countdown. Trading calls `heat()` so a busy market gets the next story sooner.
  With no feed the client runs the same chains itself.
- **Cases** — three boxes bought with in-game cash only. The cost is charged up
  front, the reward (cash, shares, XP, a timed XP booster, a cosmetic or the
  jackpot) is applied after the spin, and everything lands in `state.caseHistory`
  so it saves with the rest of the game.
- **Sound** — `js/sound.js` synthesises every cue with the Web Audio API (no
  audio file is ever downloaded): a purchase is a rising two-note figure, a loss
  a falling one, the case roulette is a run of dry `tick`s scheduled on the audio
  clock so they stretch out as the reel slows, a win arpeggio grows longer and
  brighter with the reward's rarity, every notification rings a soft two-tone
  `notify`, and a big market move opens with the `alert` cue (three low thumps
  and a bright bell). There is a switch in Ajustes, the context is only created
  on the first user gesture, and the module can render itself into an
  `OfflineAudioContext` so the tests can measure the actual signal.
- **Headlines tray and the centre alert** — the news panel keeps only the newest
  `NEWS_LIMIT` (15) headlines: each new one drops the oldest, and the panel has a
  **Limpiar noticias** button. When something actually moves the market — a
  chained event starting, or a headline past `BIG_NEWS_PCT` (8%) — a card takes
  over the centre of the screen with the symbol, the direction and the move.
  Tapping the card opens that investment's chart and order form so the player can
  act; the ✕ only dismisses it. The alert is built client-side by `js/nav.js`
  (`showMarketAlert`), so it works with or without a live feed.

## tests

```bash
bun test scripts/market.test.mjs   # the service
bun test scripts/game.test.mjs     # the money rules of the client
```

The service suite covers password hashing, account validation, portfolio
sanitizing, the market engine, atomic file persistence, the HTTP surface,
websocket ticks/trades and a full restart round-trip. It also pins the admin
console: every route is locked behind an allow-listed token (`401` anonymous,
`403` for a normal player), the writes land on the engine (instant crash, forced
regime, halt, settlement), a new tick timer is adopted at runtime, a portfolio
can be granted cash or have its sessions dropped, a broadcast reaches an open
socket, and the flag survives a restart only while the name stays on the list. A separate
suite boots the service against a data dir containing `admins.json` and checks
that it grants the flag with no environment variable, accepts both shapes, grants
nothing when the file is corrupt and takes the flag away when the name is removed.

The progression suite pins the ranking (contiguous ranks, one winner per metric,
period filters that exclude inactive accounts, the 90-sample cap, a private
profile hidden from others but visible to its owner), the profile sanitizing and
its survival across a restart, and the chained events (a black swan pushing every
impulse down, the `event-chain` frame reaching an open socket, and the admin route
that summons one by hand).

The game suite loads `js/catalog.js`, `js/state.js`, `js/order.js` and
`js/portfolio.js` — the exact files the browser runs — into a sandbox with a
minimal DOM, and pins the numbers that decide whether a player's money is lost or
kept: the margin a buy freezes (with and without leverage), the weighted average
of a second entry, the proceeds of a partial sale, the round trip that has to
return the cash untouched, the loss that eats a whole margin and liquidates the
position, take profit / stop loss / trailing stop, the bankruptcy and
recapitalisation flow, the realised statistics and the sanitising of a hostile
saved game. It also covers the progression rules: the win streak that only a loss
resets, an XP booster that multiplies every award while it lasts, the net-worth
curve and its drawdown, the sanitizing of the new save fields, the synthesised
sound catalogue (every cue builds nodes against a fake audio context, no
frequency drops below hearing, no exponential ramp asks for zero — which would
throw in a browser — a profit climbs in pitch, a loss falls, and a rarer case
reward lasts longer), the rolling trays (the news cap holds as headlines arrive
and `clearNews` empties them; notifications respect the ceiling the console can
dial) and the achievement
sweep (which unlocks exactly once and comes back from storage).
