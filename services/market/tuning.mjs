// the knobs of the simulation: the game clock, the market model tuning and the
// windows the chart can ask for. engine.mjs imports them and re-exports them, so
// nothing else in the project has to change. keeping them together is what makes
// it possible to retune the market (a calmer day, a longer rally, deeper
// history) without touching the model code.

// El suelo del precio. NO es un limite de verdad: la caminata del modelo es
// geometrica (fund * exp(ret)), asi que por si sola nunca llega a cero y nunca
// necesita que la recorten. Este valor es solo la red de seguridad para un
// estado corrupto (un NaN, un guardado viejo con 0).
//
// Antes valia 0.2 y se aplicaba con Math.max() en cada paso: en cuanto una
// empresa llegaba al suelo, cualquier rendimiento negativo daba < 0.2, el
// Math.max lo devolvia a exactamente 0.2 y la serie se congelaba para siempre
// (una linea recta). En los datos reales NORVX acumulo 258 barras clavadas en
// 0.20 tras caer de $179.42, y VLRA 103 tras caer de $424.07.
export const MIN_PRICE = 0.000001;
export const HISTORY_LIMIT = 900;

// El unico redondeo de precios del servicio. Con dos decimales fijos un precio
// pequeno se aplastaba contra la rejilla: 0.0087 se volvia 0.01, por debajo de
// 0.005 se volvia 0 y la vela desaparecia (el filtro `bar.c > 0` la borraba). Eso
// ponia un segundo muro, este en el guardado: la empresa se hundia en memoria y
// al recargar el historial volvia a cero. Los dos decimales se mantienen para los
// precios normales y se van ganando decimales segun el precio baja.
//   12.3456 -> 12.35      0.4567 -> 0.4567      0.007891 -> 0.007891
export function roundPrice(value) {
  const abs = Math.abs(value);
  if (abs >= 1) return Math.round(value * 100) / 100;
  if (abs >= 0.01) return Math.round(value * 10000) / 10000;
  return Math.round(value * 1e6) / 1e6;
}
export const NEWS_LIMIT = 30;

// ---- game clock -----------------------------------------------------------

// how many game milliseconds pass per real millisecond: 1440 means one real
// minute is one game day (24 * 60).
export const GAME_SPEED = 1440;
// the ceiling the admin console can push the clock to before it starts being
// nonsense (a game month per real second)
export const MAX_GAME_SPEED = GAME_SPEED * 1000;
export const GAME_MINUTE_MS = 60 * 1000;
// the simulation advances in one game minute steps inside every real tick
export const GAME_STEP_MS = GAME_MINUTE_MS;
// a real tick can never fast forward more than this much game time (a paused
// server must not teleport the market forward by weeks)
export const MAX_GAME_ADVANCE_MS = 3 * 60 * 60 * 1000;
// where the game calendar starts (a monday, 09:00)
export const GAME_EPOCH = Date.UTC(2026, 0, 5, 9, 0);

export const MINUTES_PER_GAME_DAY = 24 * 60;
export const GAME_DAY_MS = MINUTES_PER_GAME_DAY * GAME_MINUTE_MS;

// ---- settlement price -----------------------------------------------------

// every couple of game days the market *fixes* a settlement reference. it is a
// benchmark, not the quote an order uses: the game trades and marks at the live
// tape (`quoteFor().live`), which is what keeps every list and the open P/L
// moving. the reference is what the chart draws as the `Ajuste` line and what
// the countdown chip runs down.
export const SETTLE_DAYS = 2;

// ---- intraday swing -------------------------------------------------------

// a fast, mean reverting wobble around the daily path. without it a five minute
// bar only carries a slice of a very slow drift and the tape looks dead: the
// price barely fights because the day's movement is spread over 288 bars. the
// swing is what makes individual bars tall in both directions while the clamp is
// what keeps the day (and therefore the chart's scale) from running away.
export const SWING_HALF_LIFE_MIN = 45;
export const SWING_REVERT = Math.log(2) / SWING_HALF_LIFE_MIN;
export const SWING_VOL = 0.0034;
export const SWING_MAX = 0.05;

// ---- market model tuning --------------------------------------------------

// everything below is expressed per *game minute*, so a regime that lasts a few
// game days is 1440 * days minutes wide. a full strength market regime drifts
// about 6e-5 per minute, i.e. roughly +30% over three game days: that is what
// lets a hot run reach +26% or more before it fades.
export const DRIFT_PER_MINUTE = 0.00006;
// noise per game minute, as a fraction of the symbol's vol. the old engine drew
// a uniform shock of +-vol/2, whose standard deviation is vol/3.46, so the day
// to day swings stay in the familiar 5-15% range.
export const NOISE_SCALE = 1 / 3.4641;
// the part of the price that is a rolling average (the "fair value" the market
// drifts away from and back to). five game days is slow enough that a rally can
// build on top of it, fast enough that it eventually catches up.
export const ANCHOR_RATE = 1 / (MINUTES_PER_GAME_DAY * 5);
// how hard the price is pulled back towards its anchor, per unit of log
// deviation. this is the spring that turns a trend into a pullback: a strong
// market regime settles about 25% above the anchor, and when the regime ends the
// price walks back over roughly two game days instead of snapping.
export const REVERSION_PER_MINUTE = 0.0004;
// ...and a much slower level the price belongs to (the company's long run
// value). inside the band below nothing happens, beyond it the pull grows with
// the square of the excess. the band is deliberately wide now: a company can
// run a multi-week trend several times its long-run value (or a tenth of it)
// before the soft spring starts fighting, so the chart shows real x1 -> x10
// journeys instead of flattening against an invisible ceiling. it is still a
// runaway guard, not a wall: beyond the band the quadratic pull grows slowly
// and the baseline itself follows the business over months.
export const VALUATION_BAND = 0.85; // roughly +-134% around the long run level
export const VALUATION_BAND_PULL = 0.0012;
export const BASELINE_RATE = 1 / (MINUTES_PER_GAME_DAY * 240);
// how much of the market regime each sector echoes
export const SECTOR_FOLLOW = 0.45;
// headline impact: a fifth lands at once, the rest is delivered with a half
// life of four game hours (a few real seconds), so the chart climbs into it
export const NEWS_INSTANT_SHARE = 0.2;
export const NEWS_HALF_LIFE_MINUTES = 240;
export const NEWS_DECAY_STEP = 1 - Math.pow(0.5, 1 / NEWS_HALF_LIFE_MINUTES);
// fallback for the per company settings (see companies.mjs): a headline drags the
// rest of the sector by this fraction of its move when the company does not say
// otherwise
export const NEWS_SECTOR_SPILL = 0.3;
// volatility clustering: it returns to 1 on its own and jumps after big moves
export const VOL_MIN = 0.7;
export const VOL_MAX = 2.8;
export const VOL_CLUSTER_KEEP = 0.9995;
export const VOL_CLUSTER_ADD = 0.00063;

// ---- rolling history windows ----------------------------------------------

// the chart is a window that slides through the company's life. every series
// keeps a whole number of *game days* and, the moment a new game day opens, the
// oldest day is dropped in one piece: the first bar of the window moves 1 -> 2
// -> 3 instead of the series growing (or the view drifting) forever.
//
// one real minute of play is one game day, so the deepest window below is about
// twenty real minutes — the "month" the game keeps at full detail. the daily
// series is one bar per game day and is what the 1W view scrolls through, so it
// keeps the company's whole stored life.
export const HISTORY_WINDOW_DAYS = {
  intraday: 20,
  hourly: 20,
  daily: 400,
};

// how much of that window the model *generates* on its own when a window is
// still empty. the daily series is the company's story and is always drawn in
// full; the 5m window is not generated here at all — engine.backfillIntraday
// draws every missing game day inside its daily candle (open to close, bounded
// by the daily high and low) so the window is complete on the first frame; and
// the hourly view is derived from that 5m window (engine.rebuildHourly), so the
// number below is only the fallback for a series that somehow arrived short.
export const HISTORY_BACKFILL_BARS = {
  intraday: 288, // one game day of 5m bars (kept for reference)
  hourly: 48, // two game days of 1h bars, only used if the 5m window is short
  daily: 400,
};

function barsFor(minutes, days) {
  return Math.round((days * MINUTES_PER_GAME_DAY) / minutes);
}

// what the chart can ask for: the length of one bar in *game* minutes and how
// many bars that view can ever hold (the rolling window above).
export const TIMEFRAMES = {
  '5m': { minutes: 5, limit: barsFor(5, HISTORY_WINDOW_DAYS.intraday), label: '5m' },
  '15m': { minutes: 15, limit: barsFor(15, HISTORY_WINDOW_DAYS.intraday), label: '15m' },
  '1h': { minutes: 60, limit: barsFor(60, HISTORY_WINDOW_DAYS.hourly), label: '1h' },
  '1W': { minutes: 24 * 60, limit: HISTORY_WINDOW_DAYS.daily, label: '1W' },
};
export const DEFAULT_TIMEFRAME = '5m';

// candles kept per symbol. three resolutions: the intraday one feeds the 5m/15m
// views, the hourly one feeds 1h and the daily one is the company's whole
// story, which is what the 1W view scrolls through.
export const CANDLE_RESOLUTIONS = {
  intraday: {
    minutes: 5,
    days: HISTORY_WINDOW_DAYS.intraday,
    limit: barsFor(5, HISTORY_WINDOW_DAYS.intraday),
    backfill: HISTORY_BACKFILL_BARS.intraday,
  },
  hourly: {
    minutes: 60,
    days: HISTORY_WINDOW_DAYS.hourly,
    limit: barsFor(60, HISTORY_WINDOW_DAYS.hourly),
    backfill: HISTORY_BACKFILL_BARS.hourly,
  },
  daily: {
    minutes: 24 * 60,
    days: HISTORY_WINDOW_DAYS.daily,
    limit: HISTORY_WINDOW_DAYS.daily,
    backfill: HISTORY_BACKFILL_BARS.daily,
  },
};

// the deepest single response the candle endpoint will build: exactly the
// deepest window the server keeps (twenty game days of 5m bars), so a client can
// install its copy in one request and no request can ask for more than exists
export const CANDLE_MAX_LIMIT = CANDLE_RESOLUTIONS.intraday.limit;
