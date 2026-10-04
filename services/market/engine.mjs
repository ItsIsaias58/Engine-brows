// core market simulation for the trading floor game. the engine is pure: it
// only mutates the market state it is handed and never touches the network or
// the filesystem, which keeps it trivially testable.
//
// the market is a *model*, not a coin flip around the opening price. every
// symbol carries a slow trend, a volatility that clusters, an anchor it drifts
// away from, and an exposure to the mood of its sector and of the whole market.
// headlines do not teleport the price: they land over the next few game hours
// and drag the sector along, so a rally climbs and a sell-off bleeds instead of
// jumping. a session rolls every game day, which is what makes the daily change
// the quote shows mean something.
//
// time is compressed: one real minute of play is one whole game day
// (GAME_SPEED = 1440), so every tick is simulated in game minute steps and the
// candles the chart draws carry game timestamps instead of wall clock ones.
//
// the engine is the entry point, but the pieces it is made of live next to it:
//   companies.mjs  the catalog and each company's own character
//   headlines.mjs  the news and surprise copy
//   tuning.mjs     the game clock, the model knobs and the candle windows
import {
  ANCHOR_RATE,
  BASELINE_RATE,
  CANDLE_RESOLUTIONS,
  DRIFT_PER_MINUTE,
  GAME_DAY_MS,
  GAME_EPOCH,
  GAME_MINUTE_MS,
  GAME_SPEED,
  GAME_STEP_MS,
  HISTORY_LIMIT,
  MAX_GAME_ADVANCE_MS,
  MAX_GAME_SPEED,
  MINUTES_PER_GAME_DAY,
  MIN_PRICE,
  NEWS_DECAY_STEP,
  NEWS_INSTANT_SHARE,
  NEWS_LIMIT,
  NEWS_SECTOR_SPILL,
  NOISE_SCALE,
  REVERSION_PER_MINUTE,
  roundPrice,
  SECTOR_FOLLOW,
  SETTLE_DAYS,
  SWING_MAX,
  SWING_REVERT,
  SWING_VOL,
  TIMEFRAMES,
  VALUATION_BAND,
  VALUATION_BAND_PULL,
  VOL_CLUSTER_ADD,
  VOL_CLUSTER_KEEP,
  VOL_MAX,
  VOL_MIN,
} from './tuning.mjs';
import {
  DEFAULT_PROFILE,
  MARKET_SYMBOLS,
  marketProfiles,
  profileFor,
} from './companies.mjs';
import {
  NEWS_CHANCE_PER_STEP,
  newsArea,
  newsHeadline,
  surpriseHeadline,
} from './headlines.mjs';

// keep engine.mjs the single entry point the server and the tests import from:
// everything that moved out is re-exported from here
export * from './tuning.mjs';
export * from './companies.mjs';
export * from './headlines.mjs';

// el mismo redondeo de precios que usa el guardado (ver tuning.mjs): uno solo
// para que lo que se ve en la grafica y lo que se guarda en disco coincidan
function round(value) {
  return roundPrice(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Guarda de corrupcion, no un limite: solo rescata un valor que no es un numero
// finito o que ya es <= 0 (un guardado viejo, una division rota). Un precio bajo
// legitimo pasa intacto.
function safePrice(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bucketFor(gameTime, minutes) {
  const size = minutes * GAME_MINUTE_MS;
  return Math.floor(gameTime / size) * size;
}

function emptySeries() {
  return { intraday: [], hourly: [], daily: [] };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// a tiny deterministic 0..1 generator for the slow moving parts of the model
// (regimes, sector moods, session gaps). it is seeded from the market sequence
// and the clock, so a replay is reproducible, and — unlike the injected
// `random` — it never consumes a draw. that keeps the per step budget at ten
// prices plus one news roll, which the tests pin down.
function hash01(seed) {
  let x = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// Acklam's inverse normal CDF: one uniform in, one gaussian out, so a symbol's
// single draw per game minute is enough for a realistic return distribution
const INV_NORM_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const INV_NORM_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const INV_NORM_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const INV_NORM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const INV_NORM_LOW = 0.02425;

function inverseNormal(p) {
  const u = clamp(p, 1e-9, 1 - 1e-9);
  if (u < INV_NORM_LOW) {
    const q = Math.sqrt(-2 * Math.log(u));
    return (((((INV_NORM_C[0] * q + INV_NORM_C[1]) * q + INV_NORM_C[2]) * q + INV_NORM_C[3]) * q + INV_NORM_C[4]) * q + INV_NORM_C[5]) /
      ((((INV_NORM_D[0] * q + INV_NORM_D[1]) * q + INV_NORM_D[2]) * q + INV_NORM_D[3]) * q + 1);
  }
  if (u < 1 - INV_NORM_LOW) {
    const q = u - 0.5;
    const r = q * q;
    return (((((INV_NORM_A[0] * r + INV_NORM_A[1]) * r + INV_NORM_A[2]) * r + INV_NORM_A[3]) * r + INV_NORM_A[4]) * r + INV_NORM_A[5]) * q /
      (((((INV_NORM_B[0] * r + INV_NORM_B[1]) * r + INV_NORM_B[2]) * r + INV_NORM_B[3]) * r + INV_NORM_B[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - u));
  return -(((((INV_NORM_C[0] * q + INV_NORM_C[1]) * q + INV_NORM_C[2]) * q + INV_NORM_C[3]) * q + INV_NORM_C[4]) * q + INV_NORM_C[5]) /
    ((((INV_NORM_D[0] * q + INV_NORM_D[1]) * q + INV_NORM_D[2]) * q + INV_NORM_D[3]) * q + 1);
}

// a session runs from 09:00 to 09:00 of the next game day. volatility is higher
// right after the open and right before the close, like a real trading floor.
function intradayShape(gameTime) {
  const hoursIn = ((gameTime % GAME_DAY_MS) / GAME_MINUTE_MS) / 60;
  const open = Math.exp(-Math.pow(hoursIn / 1.3, 2));
  const close = Math.exp(-Math.pow((hoursIn - 24) / 1.1, 2));
  return 0.8 + 0.32 * open + 0.28 * close;
}

// ---- model state ----------------------------------------------------------

function sectorMoods() {
  const sectors = {};
  for (const template of MARKET_SYMBOLS) {
    if (!sectors[template.sector]) {
      sectors[template.sector] = { bias: 0, strength: 0, left: 0, heat: 0 };
    }
  }
  return sectors;
}

function symbolState(template) {
  const profile = profileFor(template.sym);
  return {
    sym: template.sym,
    name: template.name,
    sector: template.sector,
    vol: template.vol,
    beta: template.beta ?? 1,
    // the company's own logic, frozen at creation so a restart keeps playing
    // the same character
    profile,
    // every company's slow wave runs on its own phase, so they never line up
    cyclePhase: hash01(Math.imul(template.sym.charCodeAt(0) + template.sym.length * 31, 0x9e3779b9)) * 1000,
    price: template.price,
    open: template.price,
    prevClose: template.price,
    high: template.price,
    low: template.price,
    // the number the game actually trades at: it is fixed every SETTLE_DAYS game
    // days from the live price, so an order never moves under the player's hand
    settle: template.price,
    prevSettle: template.price,
    settleDay: Math.floor(GAME_EPOCH / GAME_DAY_MS),
    // the fundamental path: the price the model walks. the intraday wobble is
    // applied *on top* of it (price = fund * exp(swing)) instead of being added
    // to the price every minute, which is what keeps an oscillation from
    // accumulating into a runaway day the way an integrated step would
    fund: template.price,
    // the fast mean reverting wobble that makes five minute bars fight
    swing: 0,
    history: [template.price],
    candles: emptySeries(),
    // --- model ---
    // own trend: a log drift per game minute plus the minutes it still has left
    drift: 0,
    trendLeft: 0,
    trendKind: 'lateral',
    // headline impact still waiting to be delivered, as a log return
    impulse: 0,
    // volatility multiplier that clusters around 1
    volNow: 1,
    // rolling fair value the price is pulled back to
    anchor: template.price,
    // the slow long run level the valuation band is measured against
    baseline: template.price,
    rolls: 0,
    shocks: 0,
    lastRet: 0,
  };
}

export function createMarketState() {
  return {
    sequence: 0,
    updatedAt: Date.now(),
    gameTime: GAME_EPOCH,
    lastTickAt: null,
    news: [],
    symbols: MARKET_SYMBOLS.map(symbolState),
    // --- model ---
    // the intraday wobble is on by default; a test that wants to follow one
    // headline through the model can pin it off and measure the drift alone
    swingEnabled: true,
    regime: { kind: 'lateral', bias: 0, strength: 0, left: 0 },
    sectors: sectorMoods(),
    session: { day: Math.floor(GAME_EPOCH / GAME_DAY_MS), openedAt: GAME_EPOCH },
    rolls: 0,
  };
}

// fixes a new settlement price: the live price becomes the number the game
// trades at, and it stays frozen until the next window. the change the quote
// shows is measured against the previous settlement, which is why the list stops
// flickering every second.
function settleQuote(symbol, market) {
  const day = Math.floor(market.gameTime / GAME_DAY_MS);
  if (day - (symbol.settleDay ?? day) < SETTLE_DAYS) return false;
  symbol.prevSettle = symbol.settle > 0 ? symbol.settle : symbol.price;
  symbol.settle = symbol.price;
  symbol.settleDay = day;
  return true;
}

function betaFor(sym) {
  const template = MARKET_SYMBOLS.find((entry) => entry.sym === sym);
  return template ? template.beta ?? 1 : 1;
}

// how many game minutes pass per real minute. GAME_SPEED is the default and a
// market that was never touched by the admin console keeps using it; the console
// can store its own multiplier on the market (see adminSetSpeed).
function gameSpeedFor(market) {
  const speed = market && market.speed;
  if (!isFiniteNumber(speed) || speed <= 0) return GAME_SPEED;
  return Math.min(speed, MAX_GAME_SPEED);
}

// picks a new market regime. rallies are short and strong, sell-offs are long
// and gentle (markets fall slowly), and sideways stretches are the most common.
function pickRegime(market) {
  market.rolls = (market.rolls || 0) + 1;
  const seed = Math.imul(market.rolls, 0x9e3779b9) ^ Math.imul(market.sequence + 1, 0x85ebca6b);
  const kindRoll = hash01(seed);
  const strength = hash01(seed ^ 0x1f2e3d4c);
  const duration = hash01(seed ^ 0x5a6b7c8d);

  if (kindRoll < 0.36) {
    market.regime = {
      kind: 'alcista',
      bias: 1,
      strength: 0.45 + strength * 0.55,
      left: Math.round((2 + duration * 7) * MINUTES_PER_GAME_DAY),
    };
  } else if (kindRoll < 0.62) {
    market.regime = {
      kind: 'bajista',
      bias: -1,
      strength: 0.2 + strength * 0.42,
      left: Math.round((6 + duration * 16) * MINUTES_PER_GAME_DAY),
    };
  } else {
    market.regime = {
      kind: 'lateral',
      bias: hash01(seed ^ 0x77aa11bb) < 0.5 ? -1 : 1,
      strength: strength * 0.22,
      left: Math.round((3 + duration * 11) * MINUTES_PER_GAME_DAY),
    };
  }
}

function pickSectorMood(market, mood) {
  market.rolls = (market.rolls || 0) + 1;
  const seed = Math.imul(market.rolls, 0xc2b2ae35) ^ Math.imul(market.sequence + 1, 0x27d4eb2f);
  const kindRoll = hash01(seed);
  const strength = hash01(seed ^ 0x0badf00d);
  const duration = hash01(seed ^ 0xfeed1234);
  mood.bias = kindRoll < 0.55 ? 1 : -1;
  mood.strength = 0.15 + strength * 0.85;
  mood.left = Math.round((3 + duration * 12) * MINUTES_PER_GAME_DAY);
}

// a symbol's own story (a product cycle, an earnings run): these are what make
// one ticker fly while the rest of the list does nothing
function rollOwnTrend(market, symbol, index) {
  symbol.rolls = (symbol.rolls || 0) + 1;
  const p = symbol.profile || profileFor(symbol.sym);
  const seed = Math.imul(market.sequence + 1, 0x9e3779b9) ^
    Math.imul(index + 1, 0x85ebca6b) ^
    Math.imul(symbol.rolls, 0xc2b2ae35);
  const strength = hash01(seed);
  const duration = hash01(seed ^ 0x11112222);
  const up = hash01(seed ^ 0x33334444) < p.trendUp;
  symbol.drift = (up ? 1 : -1) * (0.3 + strength * 0.7) * DRIFT_PER_MINUTE * p.trendSize;
  symbol.trendKind = up ? 'alcista' : 'bajista';
  symbol.trendLeft = Math.round((0.4 + duration) * p.trendDays * MINUTES_PER_GAME_DAY);
}

function ensureModel(market) {
  if (!market.regime || typeof market.regime !== 'object') {
    market.regime = { kind: 'lateral', bias: 0, strength: 0, left: 0 };
  }
  if (!isFiniteNumber(market.rolls)) market.rolls = 0;
  if (!market.sectors || typeof market.sectors !== 'object') market.sectors = sectorMoods();
  for (const template of MARKET_SYMBOLS) {
    if (!market.sectors[template.sector]) {
      market.sectors[template.sector] = { bias: 0, strength: 0, left: 0, heat: 0 };
    }
  }
  const day = Math.floor(market.gameTime / GAME_DAY_MS);
  if (!market.session || typeof market.session !== 'object' || !isFiniteNumber(market.session.day)) {
    market.session = { day, openedAt: day * GAME_DAY_MS };
  }

  for (const symbol of market.symbols) {
    if (!symbol.profile || typeof symbol.profile !== 'object') {
      symbol.profile = profileFor(symbol.sym);
    }
    if (!isFiniteNumber(symbol.cyclePhase)) symbol.cyclePhase = 0;
    if (!isFiniteNumber(symbol.drift)) symbol.drift = 0;
    if (!isFiniteNumber(symbol.trendLeft)) symbol.trendLeft = 0;
    if (typeof symbol.trendKind !== 'string') symbol.trendKind = 'lateral';
    if (!isFiniteNumber(symbol.impulse)) symbol.impulse = 0;
    if (!isFiniteNumber(symbol.volNow) || symbol.volNow <= 0) symbol.volNow = 1;
    if (!isFiniteNumber(symbol.anchor) || symbol.anchor <= 0) symbol.anchor = symbol.price;
    if (!isFiniteNumber(symbol.baseline) || symbol.baseline <= 0) symbol.baseline = symbol.price;
    if (!isFiniteNumber(symbol.rolls)) symbol.rolls = 0;
    if (!isFiniteNumber(symbol.shocks)) symbol.shocks = 0;
    if (!isFiniteNumber(symbol.beta)) symbol.beta = betaFor(symbol.sym);
    if (!isFiniteNumber(symbol.lastRet)) symbol.lastRet = 0;
    if (!isFiniteNumber(symbol.settle) || symbol.settle <= 0) symbol.settle = symbol.price;
    if (!isFiniteNumber(symbol.prevSettle) || symbol.prevSettle <= 0) symbol.prevSettle = symbol.settle;
    if (!isFiniteNumber(symbol.settleDay)) {
      symbol.settleDay = Math.floor(market.gameTime / GAME_DAY_MS);
    }
    if (!isFiniteNumber(symbol.swing)) symbol.swing = 0;
    // a market saved before the wobble was split out carries no fundamental
    // path: it is recovered by undoing the wobble that was on top of the price
    if (!isFiniteNumber(symbol.fund) || symbol.fund <= 0) {
      symbol.fund = safePrice(symbol.price * Math.exp(-symbol.swing), MIN_PRICE);
    }
    // a market that was saved before the current settlement window gets one now,
    // so what is on screen and what can be traded at never disagree
    settleQuote(symbol, market);
  }

  if (!isFiniteNumber(market.regime.left) || market.regime.left <= 0) pickRegime(market);
  for (const mood of Object.values(market.sectors)) {
    if (!isFiniteNumber(mood.left) || mood.left <= 0) pickSectorMood(market, mood);
  }
}

// the rolling window: it is measured in whole game days, not in bars. when a new
// game day opens, every bar of the days that no longer fit is dropped in one
// piece, so the first bar of the window moves 1 -> 2 -> 3 (the oldest “fragment”
// goes away) instead of the series growing forever.
function evictOutsideWindow(list, resolution, gameTime) {
  const days = resolution.days;
  if (isFiniteNumber(days) && days > 0) {
    const oldestAllowed = Math.floor(gameTime / GAME_DAY_MS) - days + 1;
    const cutoff = oldestAllowed * GAME_DAY_MS;
    let drop = 0;
    while (drop < list.length - 1 && list[drop].t < cutoff) drop += 1;
    if (drop > 0) list.splice(0, drop);
  }
  // safety net: a corrupt saved series can never grow past the hard cap
  if (list.length > resolution.limit) list.splice(0, list.length - resolution.limit);
}

// folds one price sample into the current candle of every stored resolution,
// opening a new candle when the game clock rolls into the next bucket
function addSample(symbol, price, gameTime) {
  const value = round(price);
  for (const [key, resolution] of Object.entries(CANDLE_RESOLUTIONS)) {
    const list = symbol.candles[key];
    if (!Array.isArray(list)) continue;
    const bucket = bucketFor(gameTime, resolution.minutes);
    const last = list[list.length - 1];

    if (last && bucket <= last.t) {
      last.h = round(Math.max(last.h, value));
      last.l = round(Math.min(last.l, value));
      last.c = value;
      continue;
    }

    list.push({ t: bucket, o: value, h: value, l: value, c: value });
    evictOutsideWindow(list, resolution, gameTime);
  }
}

// the hourly series is derived from the 5m one instead of being stored twice:
// the history files keep a single source of truth (the per day 5m bars) and the
// server rebuilds the 1h window from them on boot
const HOUR_MS = 60 * GAME_MINUTE_MS;

export function rebuildHourly(symbol) {
  if (!symbol || !symbol.candles || typeof symbol.candles !== 'object') return 0;
  const intraday = Array.isArray(symbol.candles.intraday) ? symbol.candles.intraday : [];
  const hourly = [];
  for (const candle of intraday) {
    const bucket = Math.floor(candle.t / HOUR_MS) * HOUR_MS;
    const last = hourly[hourly.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, candle.h);
      last.l = Math.min(last.l, candle.l);
      last.c = candle.c;
      continue;
    }
    hourly.push({ t: bucket, o: candle.o, h: candle.h, l: candle.l, c: candle.c });
  }
  symbol.candles.hourly = hourly.slice(-CANDLE_RESOLUTIONS.hourly.limit);
  return symbol.candles.hourly.length;
}

function restoreSeries(raw) {
  const series = emptySeries();
  if (!raw || typeof raw !== 'object') return series;

  for (const [key, resolution] of Object.entries(CANDLE_RESOLUTIONS)) {
    const list = [];
    const items = Array.isArray(raw[key]) ? raw[key] : [];
    for (const item of items) {
      // persisted as compact [t,o,h,l,c] tuples, objects are accepted too
      const parsed = Array.isArray(item)
        ? { t: item[0], o: item[1], h: item[2], l: item[3], c: item[4] }
        : item;
      if (!parsed || typeof parsed !== 'object') continue;
      if (!isFiniteNumber(parsed.t)) continue;
      if (![parsed.o, parsed.h, parsed.l, parsed.c].every(isFiniteNumber)) continue;
      list.push({
        t: Math.floor(parsed.t),
        o: round(parsed.o),
        h: round(Math.max(parsed.h, parsed.o, parsed.c)),
        l: round(Math.min(parsed.l, parsed.o, parsed.c)),
        c: round(parsed.c),
      });
    }
    list.sort((left, right) => left.t - right.t);
    if (list.length > 0) series[key] = list.slice(-resolution.limit);
  }
  return series;
}

// restores a persisted market, keeping any symbol definitions that were added
// since the save was written and dropping symbols that no longer exist.
export function restoreMarketState(saved) {
  const fresh = createMarketState();
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.symbols)) {
    return fresh;
  }

  const savedBySym = new Map();
  for (const entry of saved.symbols) {
    if (entry && typeof entry.sym === 'string') savedBySym.set(entry.sym, entry);
  }

  for (const symbol of fresh.symbols) {
    const entry = savedBySym.get(symbol.sym);
    if (!entry) continue;
    // un precio guardado pequeno es legitimo (una empresa hundida), asi que el
    // unico requisito es que sea un precio de verdad
    if (isFiniteNumber(entry.price) && entry.price > 0) {
      symbol.price = entry.price;
    }
    if (isFiniteNumber(entry.open)) symbol.open = entry.open;
    if (isFiniteNumber(entry.prevClose)) symbol.prevClose = entry.prevClose;
    if (isFiniteNumber(entry.high)) symbol.high = entry.high;
    if (isFiniteNumber(entry.low)) symbol.low = entry.low;
    if (Array.isArray(entry.history)) {
      const history = entry.history.filter(isFiniteNumber).slice(-HISTORY_LIMIT);
      if (history.length > 0) symbol.history = history;
    }
    symbol.candles = restoreSeries(entry.candles);

    // the slow model state: keeping it means a market that was mid trend picks
    // the trend back up after a restart instead of starting from scratch
    if (isFiniteNumber(entry.drift)) symbol.drift = clamp(entry.drift, -0.01, 0.01);
    if (isFiniteNumber(entry.trendLeft)) symbol.trendLeft = clamp(entry.trendLeft, 0, 60 * MINUTES_PER_GAME_DAY);
    if (typeof entry.trendKind === 'string') symbol.trendKind = entry.trendKind.slice(0, 12);
    if (isFiniteNumber(entry.impulse)) symbol.impulse = clamp(entry.impulse, -1, 1);
    if (isFiniteNumber(entry.volNow)) symbol.volNow = clamp(entry.volNow, VOL_MIN, VOL_MAX);
    if (isFiniteNumber(entry.anchor) && entry.anchor > 0) symbol.anchor = entry.anchor;
    if (isFiniteNumber(entry.baseline) && entry.baseline > 0) symbol.baseline = entry.baseline;
    if (isFiniteNumber(entry.rolls)) symbol.rolls = Math.max(0, Math.floor(entry.rolls));
    if (isFiniteNumber(entry.shocks)) symbol.shocks = Math.max(0, Math.floor(entry.shocks));
    if (isFiniteNumber(entry.lastRet)) symbol.lastRet = entry.lastRet;
    // the settlement price the game trades at, and the wobble in progress
    if (isFiniteNumber(entry.settle) && entry.settle > 0) symbol.settle = entry.settle;
    if (isFiniteNumber(entry.prevSettle) && entry.prevSettle > 0) symbol.prevSettle = entry.prevSettle;
    if (isFiniteNumber(entry.settleDay)) symbol.settleDay = Math.floor(entry.settleDay);
    if (isFiniteNumber(entry.swing)) symbol.swing = clamp(entry.swing, -SWING_MAX, SWING_MAX);
    if (isFiniteNumber(entry.fund) && entry.fund > 0) symbol.fund = entry.fund;

    symbol.high = Math.max(symbol.high, symbol.price);
    symbol.low = Math.min(symbol.low, symbol.price);
  }

  fresh.sequence = Number.isInteger(saved.sequence) && saved.sequence >= 0
    ? saved.sequence
    : 0;
  fresh.updatedAt = isFiniteNumber(saved.updatedAt) ? saved.updatedAt : Date.now();
  fresh.gameTime = isFiniteNumber(saved.gameTime) && saved.gameTime > 0
    ? saved.gameTime
    : GAME_EPOCH;
  if (isFiniteNumber(saved.rolls)) fresh.rolls = Math.max(0, Math.floor(saved.rolls));
  if (saved.swingEnabled === false) fresh.swingEnabled = false;

  if (saved.regime && typeof saved.regime === 'object') {
    fresh.regime = {
      kind: typeof saved.regime.kind === 'string' ? saved.regime.kind.slice(0, 12) : 'lateral',
      bias: clamp(isFiniteNumber(saved.regime.bias) ? saved.regime.bias : 0, -1, 1),
      strength: clamp(isFiniteNumber(saved.regime.strength) ? saved.regime.strength : 0, 0, 1.5),
      left: clamp(isFiniteNumber(saved.regime.left) ? saved.regime.left : 0, 0, 120 * MINUTES_PER_GAME_DAY),
    };
  }
  if (saved.sectors && typeof saved.sectors === 'object') {
    for (const [name, mood] of Object.entries(saved.sectors)) {
      if (!mood || typeof mood !== 'object') continue;
      fresh.sectors[name] = {
        bias: clamp(isFiniteNumber(mood.bias) ? mood.bias : 0, -1, 1),
        strength: clamp(isFiniteNumber(mood.strength) ? mood.strength : 0, 0, 1.5),
        left: clamp(isFiniteNumber(mood.left) ? mood.left : 0, 0, 120 * MINUTES_PER_GAME_DAY),
        heat: clamp(isFiniteNumber(mood.heat) ? mood.heat : 0, 0, 10),
      };
    }
  }
  if (saved.session && typeof saved.session === 'object' && isFiniteNumber(saved.session.day)) {
    fresh.session = {
      day: Math.floor(saved.session.day),
      openedAt: isFiniteNumber(saved.session.openedAt)
        ? saved.session.openedAt
        : Math.floor(saved.session.day) * GAME_DAY_MS,
    };
  }

  if (Array.isArray(saved.news)) {
    fresh.news = saved.news
      .filter(
        (item) =>
          item &&
          typeof item.sym === 'string' &&
          typeof item.title === 'string' &&
          isFiniteNumber(item.pct) &&
          isFiniteNumber(item.at),
      )
      .slice(0, NEWS_LIMIT);
  }

  ensureModel(fresh);
  return fresh;
}

// what the server writes on every tick: everything except the candle series.
// those live in the rolling history files (one per company and game day), so the
// hot save stays small instead of rewriting the whole past every few seconds.
// `serializeMarket` below keeps the candle aware format for library users and
// the tests; the server uses this one.
export function serializeMarketSlim(market) {
  return {
    ...market,
    symbols: market.symbols.map((symbol) => {
      const copy = { ...symbol };
      delete copy.candles;
      return copy;
    }),
  };
}

export function serializeMarket(market) {
  return {
    ...market,
    symbols: market.symbols.map((symbol) => ({
      ...symbol,
      candles: {
        intraday: symbol.candles.intraday.map((candle) => [
          candle.t, candle.o, candle.h, candle.l, candle.c,
        ]),
        hourly: symbol.candles.hourly.map((candle) => [
          candle.t, candle.o, candle.h, candle.l, candle.c,
        ]),
        daily: symbol.candles.daily.map((candle) => [
          candle.t, candle.o, candle.h, candle.l, candle.c,
        ]),
      },
    })),
  };
}

// two prices travel together: `live` is the tape (the walk, moved every tick)
// and `price` is the settlement *reference*, fixed once every SETTLE_DAYS game
// days. the client trades and marks at `live` and keeps `price` for the chart's
// `Ajuste` line and the countdown chip.
//
// `change`/`pct` stay measured against the previous settlement (the reference
// move); the day's move against the previous close travels as `liveChange` /
// `livePct`, which is what the lists and the P/L read.
export function quoteFor(symbol, market) {
  const settle = isFiniteNumber(symbol.settle) && symbol.settle > 0 ? symbol.settle : symbol.price;
  const prevSettle = isFiniteNumber(symbol.prevSettle) && symbol.prevSettle > 0 ? symbol.prevSettle : settle;
  const change = settle - prevSettle;
  const day = market ? Math.floor(market.gameTime / GAME_DAY_MS) : (symbol.settleDay ?? 0);
  const settleDay = isFiniteNumber(symbol.settleDay) ? symbol.settleDay : day;
  return {
    sym: symbol.sym,
    name: symbol.name,
    sector: symbol.sector,
    // the settlement reference (only moves every SETTLE_DAYS game days)
    price: round(settle),
    change: round(change),
    pct: prevSettle === 0 ? 0 : round((change / prevSettle) * 100),
    // the live tape: this is the number the game trades and marks at
    live: round(symbol.price),
    liveChange: round(symbol.price - symbol.prevClose),
    livePct: symbol.prevClose === 0 ? 0 : round(((symbol.price - symbol.prevClose) / symbol.prevClose) * 100),
    open: round(symbol.open),
    prevClose: round(symbol.prevClose),
    high: round(symbol.high),
    low: round(symbol.low),
    settleAt: settleDay * GAME_DAY_MS,
    nextSettleAt: (settleDay + SETTLE_DAYS) * GAME_DAY_MS,
  };
}

export function marketQuotes(market) {
  return market.symbols.map((symbol) => quoteFor(symbol, market));
}

export function marketSnapshot(market) {
  return {
    sequence: market.sequence,
    updatedAt: market.updatedAt,
    gameTime: market.gameTime,
    // the clock multiplier travels with every snapshot so a client can keep its
    // own clock in step after the console changes the speed
    speed: gameSpeedFor(market),
    quotes: marketQuotes(market),
    news: market.news,
    intervalMs: market.intervalMs ?? null,
    // how often the settlement price is fixed, so the client can count down to
    // the next one next to the quote
    settleDays: SETTLE_DAYS,
    // the mood of the whole market, so the client can show what is going on
    regime: market.regime ? { ...market.regime } : null,
    // each company's own character, so the game can explain why they behave so
    // differently
    profiles: marketProfiles(),
  };
}

export function historyFor(market, sym, limit) {
  const symbol = market.symbols.find((entry) => entry.sym === sym);
  if (!symbol) return null;
  const sliced = limit > 0 ? symbol.history.slice(-limit) : [];
  return { sym: symbol.sym, intervalMs: market.intervalMs ?? null, prices: sliced };
}

function baseSeriesFor(symbol, timeframe) {
  const minutes = TIMEFRAMES[timeframe].minutes;
  // 1W is drawn from the daily series, so scrolling back walks the company's
  // whole history instead of the last two weeks; 1h uses the hourly series and
  // the short bars use the intraday one
  if (minutes >= MINUTES_PER_GAME_DAY) return symbol.candles.daily;
  return minutes % 60 === 0 ? symbol.candles.hourly : symbol.candles.intraday;
}

export function timeframeFor(name) {
  return TIMEFRAMES[name] ? { key: name, ...TIMEFRAMES[name] } : null;
}

// index of the first aggregated candle strictly newer than `since`
function firstIndexAfter(list, since) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].t <= since) low = mid + 1;
    else high = mid;
  }
  return low;
}

// aggregates the stored candles into the requested timeframe (in game time).
// `since` is the client's cursor: the chart keeps its own copy of the history and
// asks only for what is newer, so the deep window travels over the wire once.
export function candlesFor(market, sym, timeframe, limit, since) {
  const symbol = market.symbols.find((entry) => entry.sym === sym);
  const tf = timeframeFor(timeframe);
  if (!symbol || !tf) return null;

  const base = baseSeriesFor(symbol, timeframe);
  const size = tf.minutes * GAME_MINUTE_MS;
  const aggregated = [];

  for (const candle of base) {
    const bucket = Math.floor(candle.t / size) * size;
    const last = aggregated[aggregated.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, candle.h);
      last.l = Math.min(last.l, candle.l);
      last.c = candle.c;
      continue;
    }
    aggregated.push({ t: bucket, o: candle.o, h: candle.h, l: candle.l, c: candle.c });
  }

  const cap = limit > 0 ? Math.min(limit, tf.limit) : tf.limit;
  const hasSince = isFiniteNumber(since) && since > 0;
  const fresh = hasSince ? aggregated.slice(firstIndexAfter(aggregated, since)) : aggregated;
  return {
    sym: symbol.sym,
    tf: tf.key,
    minutes: tf.minutes,
    intervalMs: size,
    candles: fresh.slice(-cap),
    since: hasSince ? since : 0,
    // the stored window no longer reaches back to the client's cursor: the local
    // copy is stale beyond repair and has to be replaced
    reset: Boolean(hasSince && aggregated.length > 0 && aggregated[0].t > since),
    windowStart: aggregated.length ? aggregated[0].t : 0,
  };
}

// ---- admin hooks ----------------------------------------------------------

// the levers the admin console pulls. each one only touches state the model
// already owns and re-derives what depends on it, so a hand made event can never
// leave the market in a shape the tick loop would reject (a negative price, a
// settlement that is not the price, an anchor pulling against the jump).

// a price shock. `gradual` delivers it like a headline (over the next game hours)
// which is what a pump/dump on the tape looks like; an instant one moves the
// fundamental path *and* re-fixes the settlement, so the number the game trades
// at changes on the spot.
export function adminShock(market, sym, pct, gradual = true) {
  const targets = market.symbols.filter((symbol) => sym === 'ALL' || symbol.sym === sym);
  if (!targets.length) return 0;
  const pctClamped = clamp(Number(pct) || 0, -90, 300);
  const factor = 1 + pctClamped / 100;
  const day = Math.floor(market.gameTime / GAME_DAY_MS);

  for (const symbol of targets) {
    if (gradual) {
      symbol.impulse += Math.log(factor) * 0.8;
      symbol.volNow = clamp(symbol.volNow * 1.3, VOL_MIN, VOL_MAX);
      continue;
    }
    symbol.fund = safePrice(symbol.fund * factor, MIN_PRICE);
    symbol.price = safePrice(symbol.fund * Math.exp(symbol.swing), MIN_PRICE);
    // the fair value and the long run level travel with the jump, otherwise the
    // spring that pulls the price back to its anchor would undo it on the spot
    symbol.anchor = safePrice(symbol.anchor * factor, MIN_PRICE);
    symbol.baseline = safePrice(symbol.baseline * factor, MIN_PRICE);
    symbol.high = Math.max(symbol.high, symbol.price);
    symbol.low = Math.min(symbol.low, symbol.price);
    // an instant shock is meant to be seen: the tradeable quote moves with it
    symbol.prevSettle = symbol.settle > 0 ? symbol.settle : symbol.price;
    symbol.settle = symbol.price;
    symbol.settleDay = day;
  }
  return targets.length;
}

// forces the mood of the whole market. the console sends this and every client
// badge follows within a tick.
export function adminForceRegime(market, kind, strength, days) {
  const allowed = kind === 'bajista' || kind === 'lateral' ? kind : 'alcista';
  const level = clamp(isFiniteNumber(strength) ? strength : 0.6, 0, 1.5);
  market.regime = {
    kind: allowed,
    // the bias the model drifts on: up while bullish, down while bearish, and a
    // weak tilt either way while going sideways
    bias: allowed === 'alcista' ? 1 : allowed === 'bajista' ? -1 : level >= 0.5 ? 1 : -1,
    strength: allowed === 'lateral' ? Math.min(level, 0.25) : level,
    left: Math.round(clamp(isFiniteNumber(days) ? days : 5, 1, 120) * MINUTES_PER_GAME_DAY),
  };
  return market.regime;
}

// freezes or resumes one symbol (or the whole market)
export function adminHalt(market, sym, halt) {
  const targets = market.symbols.filter((symbol) => sym === 'ALL' || symbol.sym === sym);
  for (const symbol of targets) symbol.halted = halt !== false;
  return targets.length;
}

// freezes the clock. the tick keeps running (it anchors `lastTickAt`, so resuming
// continues from here), it just does not advance the market
export function adminPause(market, paused) {
  market.paused = paused === true;
  return market.paused;
}

// the clock multiplier the console can dial between a standstill and the ceiling
export function adminSetSpeed(market, speed) {
  const value = Number(speed);
  market.speed = isFiniteNumber(value) && value > 0 ? Math.min(value, MAX_GAME_SPEED) : GAME_SPEED;
  return market.speed;
}

// brings the next settlement forward: every symbol is re-fixed at its live price
// right now, which is what a player sees as the quote jumping
export function adminSettleNow(market) {
  const day = Math.floor(market.gameTime / GAME_DAY_MS);
  let settled = 0;
  for (const symbol of market.symbols) {
    symbol.prevSettle = symbol.settle > 0 ? symbol.settle : symbol.price;
    symbol.settle = symbol.price;
    symbol.settleDay = day;
    settled += 1;
  }
  return settled;
}

// back to the catalog: prices, anchors, trends, settlements and the tape
// restart from the company's opening value
export function adminResetPrices(market) {
  const day = Math.floor(market.gameTime / GAME_DAY_MS);
  for (const symbol of market.symbols) {
    const template = MARKET_SYMBOLS.find((entry) => entry.sym === symbol.sym);
    const price = template && isFiniteNumber(template.price) ? template.price : symbol.price;
    symbol.price = price;
    symbol.fund = price;
    symbol.open = price;
    symbol.prevClose = price;
    symbol.high = price;
    symbol.low = price;
    symbol.anchor = price;
    symbol.baseline = price;
    symbol.swing = 0;
    symbol.impulse = 0;
    symbol.drift = 0;
    symbol.volNow = 1;
    symbol.trendLeft = 0;
    symbol.halted = false;
    symbol.settle = price;
    symbol.prevSettle = price;
    symbol.settleDay = day;
    // the chart keeps the old path unless the series starts over here
    symbol.candles = emptySeries();
    symbol.history = [price];
  }
  market.news = [];
  market.tape = [];
  return market.symbols.length;
}

// a headline written by hand. the movement is delivered like any other one (so
// the tape climbs into it), and headline-sensitive companies react harder.
// a bare price nudge with no headline attached. chained events need this: a
// sector-wide story prints one title but has to move every company in it.
// returns the symbol it moved, or null when the ticker is unknown.
export function adminNudge(market, sym, pct) {
  const symbol = market.symbols.find((entry) => entry.sym === sym);
  if (!symbol) return null;
  const pctClamped = clamp(Number(pct) || 0, -90, 300);
  const sensitivity = symbol.profile ? symbol.profile.news : 1;
  const move = (pctClamped / 100) * sensitivity;
  symbol.impulse += move * (1 - NEWS_INSTANT_SHARE);
  symbol.volNow = clamp(symbol.volNow * 1.3, VOL_MIN, VOL_MAX);
  return symbol;
}

export function adminPublishNews(market, sym, pct, title) {
  const symbol = adminNudge(market, sym, pct);
  if (!symbol) return null;
  const pctClamped = clamp(Number(pct) || 0, -90, 300);
  const item = {
    sym: symbol.sym,
    title: title || newsHeadline(symbol.name, newsArea(0.5), 250, pctClamped, 0.5),
    pct: round(pctClamped),
    at: market.gameTime,
  };
  market.news.unshift(item);
  if (market.news.length > NEWS_LIMIT) market.news.length = NEWS_LIMIT;
  return item;
}

// ---- deep history ---------------------------------------------------------

// the candle windows start life empty, so a market that has only been running
// for an hour would have a handful of bars to scroll through. this rebuilds the
// missing past with the company's *own* rules — the same growth path, the same
// cycle, its own trend length and its own surprise frequency — and then scales
// the run so it joins the live series exactly. it is deterministic per symbol,
// so a restart paints the same past instead of reshuffling it.
function backfillSeries(symbol, key, list, gameTime) {
  const resolution = CANDLE_RESOLUTIONS[key];
  // only the part of the window the model has to invent: the rest of the past
  // comes from the stored history files (see history.mjs)
  const limit = Math.min(resolution.limit, resolution.backfill ?? resolution.limit);
  if (list.length >= limit) return false;

  const p = symbol.profile || profileFor(symbol.sym);
  const size = resolution.minutes * GAME_MINUTE_MS;
  const missing = limit - list.length;
  // the synthetic run ends right before the oldest real bar (or right now, when
  // the window is still empty) and is scaled to join it
  const anchorTime = list.length ? list[0].t - size : Math.floor(gameTime / size) * size;
  const anchorPrice = list.length ? list[0].o : symbol.price;

  let seed = (Math.imul(symbol.sym.charCodeAt(0) * 7919 + symbol.sym.length * 104729, 0x9e3779b9) ^
    (key === 'daily' ? 0x51ed270b : 0x2545f491)) >>> 0;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  // noise per bar, in log terms: the per minute vol scaled to the bar length
  const sigmaBar = symbol.vol * NOISE_SCALE * Math.sqrt(resolution.minutes);
  const barsPerDay = resolution.minutes >= MINUTES_PER_GAME_DAY
    ? 1
    : MINUTES_PER_GAME_DAY / resolution.minutes;
  const surpriseChance = Math.min(0.35, 1 / (Math.max(4, p.surpriseDays) * barsPerDay));
  const trendBars = Math.max(1, Math.round(p.trendDays * barsPerDay));

  const barMinutes = resolution.minutes;
  // every per minute term has to be integrated over the length of one bar
  const alphaPerBar = p.alpha * (barMinutes / MINUTES_PER_GAME_DAY);
  const keepPerBar = Math.pow(p.momentum, barMinutes);
  const clampUnit = (value) => Math.min(1 - 1e-9, Math.max(1e-9, value));

  let drift = 0;
  let trendLeft = 0;
  let price = 1;
  let baseline = 1;
  const bars = [];
  const startTime = anchorTime - (missing - 1) * size;

  for (let i = 0; i < missing; i += 1) {
    const barTime = startTime + i * size;
    const dayFloat = barTime / GAME_DAY_MS;

    // the slow wave of this company, sampled at the date of the bar
    const cyclePerBar = p.cycleDays > 0 && p.cycleAmp > 0
      ? (2 * Math.PI / p.cycleDays) * p.cycleAmp *
        Math.cos(2 * Math.PI * (dayFloat + symbol.cyclePhase) / p.cycleDays) *
        (barMinutes / MINUTES_PER_GAME_DAY)
      : 0;

    if (trendLeft <= 0) {
      const up = next() < p.trendUp;
      drift = (up ? 1 : -1) * (0.35 + next() * 0.65) * DRIFT_PER_MINUTE * p.trendSize * barMinutes;
      trendLeft = Math.max(2, Math.round(trendBars * (0.5 + next())));
    }
    trendLeft -= 1;

    const noise = inverseNormal(clampUnit(next())) * sigmaBar;
    // surprises are as rare and as big as this company's own profile says
    const surprise = next() < surpriseChance
      ? (0.35 + next() * 0.65) * p.surpriseMax * (next() < p.trendUp ? 1 : -1)
      : 0;

    // the same valuation band the live model uses: without it a four hundred
    // bar walk runs away and the scaled result would be a spike to 5000
    const far = Math.log(price / baseline);
    const excess = Math.abs(far) - VALUATION_BAND;
    const bandPull = excess > 0
      ? -(far > 0 ? 1 : -1) * excess * excess * VALUATION_BAND_PULL * barMinutes
      : 0;

    const open = price;
    price *= Math.exp(alphaPerBar + cyclePerBar + drift + noise + surprise + bandPull);
    baseline *= Math.exp(alphaPerBar);
    drift *= keepPerBar;
    const wick = Math.abs(inverseNormal(clampUnit(next()))) * sigmaBar * 0.6;
    bars.push({
      t: barTime,
      o: open,
      c: price,
      h: Math.max(open, price) * (1 + wick),
      l: Math.min(open, price) * (1 - wick * 0.9),
    });
  }

  const scale = anchorPrice / bars[bars.length - 1].c;
  const mapped = bars.map((bar) => ({
    t: bar.t,
    o: round(bar.o * scale),
    c: round(bar.c * scale),
    h: round(bar.h * scale),
    l: round(bar.l * scale),
  })).filter((bar) => bar.c > 0 && bar.h >= bar.l);

  symbol.candles[key] = mapped.concat(list).slice(-limit);
  return true;
}

// ---- the five minute window ----------------------------------------------

const INTRADAY_BAR_MS = CANDLE_RESOLUTIONS.intraday.minutes * GAME_MINUTE_MS;
const INTRADAY_BARS_PER_DAY = MINUTES_PER_GAME_DAY / CANDLE_RESOLUTIONS.intraday.minutes;

// deterministic pseudo random stream for one (symbol, first bar) pair: the same
// seed always paints the same bars, so a day that has already been drawn (and
// saved) is never reshuffled by a restart
function bucketRandom(symbol, bucket, salt) {
  const index = Math.round(bucket / INTRADAY_BAR_MS);
  let state = (Math.imul(symbol.sym.charCodeAt(0) * 7919 + symbol.sym.length * 104729 + (index % 1000003),
    0x9e3779b9) ^ Math.imul(index, 0x85ebca6b) ^ salt) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// a stretch of five minute bars from `from` to `to`, drawn as a mean reverting
// walk around the straight line between them and kept inside [lo, hi]: the
// day's own low and high, so the intraday tape never contradicts the daily
// candle the 1W view draws. the first bar opens at `from` and the last one
// closes at `to`, which is what makes the runs join the real bars seamlessly.
function bridgeRun(symbol, bucket, count, from, to, lo, hi) {
  const next = bucketRandom(symbol, bucket, 0x2545f491);
  const clampUnit = (value) => Math.min(1 - 1e-9, Math.max(1e-9, value));
  const rangeLog = Math.max(1e-6, Math.log(hi / lo));
  // per bar sigma: the symbol's own noise, but never so wide that a day of bars
  // pegs the daily high and low instead of trading inside it
  const sigma = Math.max(
    symbol.vol * NOISE_SCALE * Math.sqrt(CANDLE_RESOLUTIONS.intraday.minutes) * 1.6,
    rangeLog * 0.16,
  );
  const keep = 0.95;

  const centres = [];
  const devs = [];
  let dev = 0;
  for (let i = 1; i <= count; i += 1) {
    // straight line in log space between the two anchors
    centres.push(Math.log(from) + (Math.log(to) - Math.log(from)) * (i / count));
    dev = dev * keep + inverseNormal(clampUnit(next())) * sigma;
    devs.push(dev);
  }
  // drain the walk back to the anchor, so the run *ends* at `to` instead of
  // wherever the noise happened to leave it
  const tail = devs[devs.length - 1];
  const bars = [];
  let open = from;
  for (let i = 1; i <= count; i += 1) {
    const level = Math.exp(centres[i - 1] + devs[i - 1] - tail * (i / count));
    const close = Math.min(hi, Math.max(lo, i === count ? to : level));
    const wick = Math.abs(inverseNormal(clampUnit(next()))) * sigma * 0.5;
    bars.push({
      t: bucket + (i - 1) * INTRADAY_BAR_MS,
      o: round(open),
      c: round(close),
      h: round(Math.min(hi, Math.max(open, close) * (1 + wick))),
      l: round(Math.max(lo, Math.min(open, close) * (1 - wick))),
    });
    open = close;
  }
  return bars;
}

// the 5m/15m views are drawn inside the daily candles: every game day of the
// window is bridged from its open to its close, bounded by its low and high.
// the bars the player already has (the stored tape and the live ones) always
// win: only the unpainted stretches are invented. this is why the window is
// complete the moment the server boots instead of filling up as the clock runs.
function backfillIntraday(symbol, gameTime) {
  const key = 'intraday';
  const limit = CANDLE_RESOLUTIONS.intraday.limit;
  const daily = Array.isArray(symbol.candles.daily) ? symbol.candles.daily : [];
  if (!daily.length) return false;

  const list = Array.isArray(symbol.candles[key]) ? symbol.candles[key] : [];
  const painted = new Map();
  for (const candle of list) painted.set(candle.t, candle);

  const lastBucket = Math.floor(gameTime / INTRADAY_BAR_MS) * INTRADAY_BAR_MS;
  const startBucket = lastBucket - (limit - 1) * INTRADAY_BAR_MS;
  // the window is measured in whole game days (the same rule the live eviction
  // uses), so the first bar of the chart moves forward a whole day at a time
  const windowDays = CANDLE_RESOLUTIONS.intraday.days || 1;
  const oldestDay = Math.floor(gameTime / GAME_DAY_MS) - windowDays + 1;

  const built = [];
  for (const day of daily) {
    const dayStart = Math.floor(day.t / INTRADAY_BAR_MS) * INTRADAY_BAR_MS;
    if (dayStart > lastBucket) break;
    if (Math.floor(dayStart / GAME_DAY_MS) < oldestDay) continue;
    const dayEnd = dayStart + (INTRADAY_BARS_PER_DAY - 1) * INTRADAY_BAR_MS;
    if (dayEnd < startBucket) continue;

    const last = Math.min(dayEnd, lastBucket);
    const buckets = [];
    for (let t = dayStart; t <= last; t += INTRADAY_BAR_MS) buckets.push(t);

    let index = 0;
    let open = day.o;
    while (index < buckets.length) {
      const bucket = buckets[index];
      const real = painted.get(bucket);
      if (real) {
        built.push(real);
        open = real.c;
        index += 1;
        continue;
      }
      // an unpainted stretch ends where the tape resumes, or at the day's close
      // (which, on the day still open, is where the live price sits right now)
      let end = index;
      while (end < buckets.length && !painted.has(buckets[end])) end += 1;
      const resumed = end < buckets.length ? painted.get(buckets[end]) : null;
      const to = resumed ? resumed.o : day.c;
      built.push(...bridgeRun(symbol, bucket, end - index, open, to, day.l, day.h));
      open = to;
      index = end;
    }
  }

  if (!built.length) return false;
  built.sort((left, right) => left.t - right.t);
  const next = built.slice(-limit);
  // the series always takes the rebuilt window (the values of an open day are
  // refreshed); the return value only reports whether the window changed shape
  const head = list[0];
  const tail = list[list.length - 1];
  const same = Boolean(head && tail) && list.length === next.length
    && head.t === next[0].t && tail.t === next[next.length - 1].t;
  symbol.candles[key] = next;
  return !same;
}

// fills the deep windows of every symbol; call it once after the market is
// created or restored. the daily series is the company's story, the 5m window
// is drawn inside it and the hourly view is derived from the 5m one, so all
// three are complete from the first frame.
export function backfillHistory(market) {
  let changed = false;
  for (const symbol of market.symbols) {
    if (!symbol.candles || typeof symbol.candles !== 'object') continue;
    if (!Array.isArray(symbol.candles.daily)) symbol.candles.daily = [];
    if (backfillSeries(symbol, 'daily', symbol.candles.daily, market.gameTime)) changed = true;
    if (!Array.isArray(symbol.candles.intraday)) symbol.candles.intraday = [];
    if (backfillIntraday(symbol, market.gameTime)) changed = true;
    if (!Array.isArray(symbol.candles.hourly)) symbol.candles.hourly = [];
    rebuildHourly(symbol);
  }
  return changed;
}

// one headline goes on the board: the newest one is kept for the news panel and
// the item is returned so the server can broadcast it right away
function pushHeadline(market, events, item) {
  market.news.unshift(item);
  if (market.news.length > NEWS_LIMIT) market.news.length = NEWS_LIMIT;
  events.push(item);
}

// the still-open intraday candle of every symbol, broadcast with each tick so
// clients extend the chart in real time instead of inventing bars
export function liveCandles(market) {
  const live = [];
  for (const symbol of market.symbols) {
    const list = symbol.candles.intraday;
    const candle = list[list.length - 1];
    if (candle) live.push({ sym: symbol.sym, ...candle });
  }
  return live;
}

// closes the previous game day and opens a new one: yesterday's close becomes
// the reference the daily change is measured against, and the session high and
// low start again from the opening gap
function rollSession(market, day) {
  const seed = Math.imul(day ^ 0x2f6e2b1, 0x9e3779b9);
  market.session = { day, openedAt: day * GAME_DAY_MS };
  market.symbols.forEach((symbol, index) => {
    const gap = (hash01(seed ^ Math.imul(index + 1, 0x85ebca6b)) - 0.5) * 0.012;
    symbol.prevClose = symbol.price;
    // the wobble is zeroed at the open, so the gap is applied to the fundamental
    // path and the first print of the day is exactly that path
    symbol.swing = 0;
    symbol.fund = safePrice(symbol.fund * (1 + gap), MIN_PRICE);
    symbol.price = symbol.fund;
    symbol.open = symbol.price;
    symbol.high = symbol.price;
    symbol.low = symbol.price;
    // the settlement window is checked here, once per game day
    settleQuote(symbol, market);
  });
}

// advances the market to `realNow`, simulating the elapsed real time as game
// minutes. `random` is injectable so tests can pin the sequence of events.
export function tickMarketState(market, random = Math.random, realNow = Date.now()) {
  const events = [];
  const previous = isFiniteNumber(market.lastTickAt) ? market.lastTickAt : realNow;
  const elapsedReal = Math.max(0, realNow - previous);
  market.lastTickAt = realNow;

  // a paused market (the admin console) does not advance: the clock is anchored
  // to now, so resuming continues from here instead of jumping forward
  if (market.paused) return events;

  const gameSpeed = gameSpeedFor(market);
  let remaining = Math.min(elapsedReal * gameSpeed, MAX_GAME_ADVANCE_MS);
  const steps = Math.max(1, Math.ceil(remaining / GAME_STEP_MS));

  ensureModel(market);

  for (let step = 0; step < steps; step += 1) {
    const advance = Math.min(GAME_STEP_MS, Math.max(0, remaining));
    if (advance > 0) {
      market.gameTime += advance;
      remaining -= advance;
    }

    // a new game day: the session rolls and the quotes get a fresh reference
    const day = Math.floor(market.gameTime / GAME_DAY_MS);
    if (advance > 0 && day !== market.session.day) rollSession(market, day);

    // slow clocks: how long the market mood, each sector and each symbol's own
    // story still have to run
    market.regime.left -= 1;
    if (market.regime.left <= 0) pickRegime(market);
    const sectorList = Object.values(market.sectors);      for (const mood of sectorList) {
      mood.left -= 1;
      if (mood.left <= 0) pickSectorMood(market, mood);
      mood.heat *= 0.998;
    }

    const shape = intradayShape(market.gameTime);

    const dayFloat = market.gameTime / GAME_DAY_MS;

    market.symbols.forEach((symbol, index) => {
      // a halted symbol (the admin console) is frozen: no price, no candle and
      // no news until it is resumed
      if (symbol.halted) return;
      // exactly one draw per symbol per game minute: the injected random drives
      // the innovation and everything else is derived from the model state
      const g = inverseNormal(random());
      const p = symbol.profile || DEFAULT_PROFILE;

      const mood = market.sectors[symbol.sector];
      const regimeDrift = market.regime.bias * market.regime.strength * DRIFT_PER_MINUTE * symbol.beta;
      const sectorDrift = mood ? mood.bias * mood.strength * DRIFT_PER_MINUTE * SECTOR_FOLLOW : 0;
      // the company's own growth path...
      const alphaDrift = p.alpha / MINUTES_PER_GAME_DAY;
      // ...and its slow wave (raw material prices, interest rates, seasons): the
      // drift is the derivative of a sine, so the price itself rides a wave of
      // +-cycleAmp around its growth path
      const cycleDrift = p.cycleDays > 0 && p.cycleAmp > 0
        ? (2 * Math.PI / p.cycleDays) * p.cycleAmp *
          Math.cos(2 * Math.PI * (dayFloat + symbol.cyclePhase) / p.cycleDays) / MINUTES_PER_GAME_DAY
        : 0;
      // the fair value pull keeps a symbol from wandering off forever (it pulls
      // the fundamental path, not the wobble)
      const reversion = -Math.log(symbol.fund / symbol.anchor) * REVERSION_PER_MINUTE;
      // the valuation band: soft walls that only bite far away from the long run
      // level, which is what keeps ninety game days of trading from turning a
      // $230 stock into a $12 one
      const far = Math.log(symbol.fund / symbol.baseline);
      const excess = Math.abs(far) - VALUATION_BAND;
      const bandPull = excess > 0
        ? -(far > 0 ? 1 : -1) * excess * excess * VALUATION_BAND_PULL
        : 0;
      // the headline that is landing right now
      const delivered = symbol.impulse * NEWS_DECAY_STEP;
      const noise = g * symbol.vol * NOISE_SCALE * symbol.volNow * shape;
      // the intraday swing: a fast wobble that reverts to zero, so the tape
      // genuinely fights up and down inside the day (tall bars in both colours).
      // it is bounded and applied on top of the fundamental path, so it cannot
      // drift the price away. its noise is hashed per game minute (a tick is 24
      // game minutes, so a per tick draw would move it in one direction for the
      // whole tick), which costs no extra draw from the shared stream.
      if (market.swingEnabled !== false) {
        const minute = Math.floor(market.gameTime / GAME_MINUTE_MS);
        const swingNoise = inverseNormal(hash01(
          Math.imul(index + 1, 0x9e3779b9) ^
          Math.imul(minute + 1, 0x85ebca6b) ^
          0x5bf03635,
        ));
        symbol.swing = clamp(
          symbol.swing * (1 - SWING_REVERT) + swingNoise * SWING_VOL,
          -SWING_MAX,
          SWING_MAX,
        );
      }

      const ret = regimeDrift + sectorDrift + symbol.drift + alphaDrift + cycleDrift +
        reversion + bandPull + delivered + noise;
      // sin suelo duro: la caminata es geometrica, asi que una empresa que cae
      // sigue cayendo barra tras barra en vez de quedarse clavada en una recta
      symbol.fund = safePrice(symbol.fund * Math.exp(ret), MIN_PRICE);
      symbol.price = safePrice(symbol.fund * Math.exp(symbol.swing), MIN_PRICE);
      symbol.lastRet = ret;

      // the model keeps moving: trends fade, headlines keep landing, volatility
      // clusters around its own average and the anchor follows the price slowly
      symbol.drift *= p.momentum;
      symbol.impulse -= delivered;
      symbol.trendLeft -= 1;
      if (symbol.trendLeft <= 0) rollOwnTrend(market, symbol, index);
      symbol.volNow = clamp(
        symbol.volNow * VOL_CLUSTER_KEEP + Math.abs(g) * VOL_CLUSTER_ADD,
        VOL_MIN,
        VOL_MAX,
      );
      symbol.anchor += (symbol.fund - symbol.anchor) * ANCHOR_RATE;
      // the long run level compounds at the company's own growth rate, so the
      // valuation band travels with the business instead of pinning it forever
      symbol.baseline *= Math.exp(alphaDrift);
      symbol.baseline += (symbol.fund - symbol.baseline) * BASELINE_RATE;

      // a rare surprise the market did not see coming (an earnings blowout, a
      // takeover rumour). it is the only thing in the model that can move one
      // symbol 20-30% inside a single game day, and it is announced like any
      // other headline. driven by a hash, so it costs no extra draw.
      symbol.shocks += 1;
      const shockSeed = Math.imul(symbol.shocks, 0x9e3779b9) ^
        Math.imul(index + 1, 0x85ebca6b) ^
        Math.imul(market.sequence + 1, 0xc2b2ae35);
      const surpriseChance = 1 / (Math.max(4, p.surpriseDays) * MINUTES_PER_GAME_DAY);
      if (hash01(shockSeed) < surpriseChance) {
        const size = hash01(shockSeed ^ 0x51ed270b);
        const up = hash01(shockSeed ^ 0x3c6ef372) < p.trendUp;
        // the company's own ceiling: a biotech can jump 38%, a food company 16%
        const impact = p.surpriseMax * (0.35 + size * 0.65) * (up ? 1 : -1);
        symbol.impulse += impact;
        symbol.volNow = clamp(symbol.volNow * 1.6, VOL_MIN, VOL_MAX);
        pushHeadline(market, events, {
          sym: symbol.sym,
          title: surpriseHeadline(symbol.name, up, hash01(shockSeed ^ 0x1b873593)),
          pct: round(impact * 100),
          at: market.gameTime,
          shock: true,
        });
      }

      symbol.high = Math.max(symbol.high, symbol.price);
      symbol.low = Math.min(symbol.low, symbol.price);
      addSample(symbol, symbol.price, market.gameTime);
    });

    if (random() < NEWS_CHANCE_PER_STEP) {
      const symbol = market.symbols[Math.floor(random() * market.symbols.length)];
      if (symbol) {
        const area = newsArea(random());
        const pct = round((random() * 6 + 3) * (random() < 0.42 ? -1 : 1));
        const amount = Math.round(random() * 350 + 150);
        // the headline as printed is the estimate; how hard it actually hits
        // depends on how headline-sensitive the company is
        const move = (pct / 100) * (symbol.profile ? symbol.profile.news : 1);

        // a fifth of the move lands now, the rest is delivered over the next few
        // game hours so the chart climbs into the headline instead of jumping
        symbol.impulse += move * (1 - NEWS_INSTANT_SHARE);
        symbol.fund = safePrice(symbol.fund * (1 + move * NEWS_INSTANT_SHARE), MIN_PRICE);
        symbol.price = safePrice(symbol.fund * Math.exp(symbol.swing), MIN_PRICE);
        symbol.volNow = clamp(symbol.volNow * 1.45, VOL_MIN, VOL_MAX);
        symbol.high = Math.max(symbol.high, symbol.price);
        symbol.low = Math.min(symbol.low, symbol.price);
        addSample(symbol, symbol.price, market.gameTime);

        // the rest of the sector catches a part of the move, how much depends on
        // how contagious the symbol is
        const spill = (symbol.profile ? symbol.profile.spill : NEWS_SECTOR_SPILL) * move;
        for (const peer of market.symbols) {
          if (peer === symbol || peer.sector !== symbol.sector) continue;
          peer.impulse += spill;
          peer.volNow = clamp(peer.volNow * 1.15, VOL_MIN, VOL_MAX);
        }
        const peers = Object.values(market.sectors).find((mood) =>
          market.symbols.some((s) => s.sector === symbol.sector && market.sectors[s.sector] === mood));
        if (peers) peers.heat = clamp(peers.heat + Math.abs(pct) / 10, 0, 3);

        // the template is picked from a hash so the headline never costs a draw
        pushHeadline(market, events, {
          sym: symbol.sym,
          title: newsHeadline(symbol.name, area, amount, pct,
            hash01(market.sequence * 7919 + symbol.sym.length)),
          pct,
          at: market.gameTime,
        });
      }
    }
  }

  // one price per real tick keeps the persisted history small (it covers many
  // game days, since a tick is already 24 game minutes)
  for (const symbol of market.symbols) {
    symbol.history.push(round(symbol.price));
    if (symbol.history.length > HISTORY_LIMIT) symbol.history.shift();
  }

  market.sequence += 1;
  market.updatedAt = realNow;
  return events;
}
