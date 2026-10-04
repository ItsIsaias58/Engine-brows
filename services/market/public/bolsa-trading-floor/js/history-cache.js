// the chart's history lives on the player's machine, not on the server.
//
// this is the client half of the rolling history. the first time a company is
// opened its candle window is downloaded once and stored here (IndexedDB), and
// from then on the chart paints straight from the local copy and asks the server
// only for the bars newer than its last one (`since`). switching companies,
// switching timeframes or reloading the page therefore does not depend on the
// server recomputing and resending the whole past.
//
// the same store remembers where the player was looking (how many bars are
// visible and how far back the window sits), so going back to a company reopens
// the very same window instead of jumping to the live edge.
//
// everything degrades silently: if IndexedDB is unavailable the copy lives in
// memory for the session, and the chart simply asks the server for the window
// again. nothing here ever throws at the game.

const HISTORY_DB_NAME = 'bolsa-history';
const HISTORY_DB_VERSION = 1;
const HISTORY_SERIES_STORE = 'series';
const HISTORY_VIEW_KEY = 'bolsa-chart-view';
// how many bars the local copy keeps per company and timeframe. these are the
// same rolling windows the server keeps: twenty game days of detail, and the
// company's whole stored life on the weekly view. when a new game day opens the
// oldest one is dropped in one piece, so the first bar of the chart moves
// forward instead of the copy growing forever.
const GAME_DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX_CANDLES = 5760;
const HISTORY_WINDOWS = {
  '5m': { days: 20, max: 5760 },
  '15m': { days: 20, max: 1920 },
  '1h': { days: 20, max: 480 },
  '1W': { days: 400, max: 400 },
};
const HISTORY_DEFAULT_WINDOW = { days: 20, max: HISTORY_MAX_CANDLES };
const HISTORY_VIEW_SAVE_MS = 400;

// key -> { candles, updatedAt }; hydrated from IndexedDB at boot so a company
// switch can paint the stored window synchronously, without a flash of filler
const historySeries = new Map();
// key -> { visibleCount, panOffset }: where the player was looking
const historyViews = new Map();
let historyDbPromise = null;
let historyViewSaveTimer = null;

function historyKey(sym, tf) {
  return `${sym}|${tf}`;
}

// a stored candle is [t, open, close, high, low]; the chart works with objects
function historyCandleFromTuple(tuple) {
  if (!Array.isArray(tuple) || tuple.length < 5) return null;
  const [t, open, close, high, low] = tuple;
  if (![t, open, close, high, low].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  return { t, open, close, high, low };
}

function historyCandleFromWire(candle) {
  if (!candle || typeof candle !== 'object') return null;
  const { t, o, h, l, c } = candle;
  if (![t, o, h, l, c].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  return {
    t: Math.floor(t),
    open: o,
    close: c,
    high: Math.max(h, o, c),
    low: Math.min(l, o, c),
  };
}

function historyTuple(candle) {
  return [candle.t, candle.open, candle.close, candle.high, candle.low];
}

// the local copy slides exactly like the server's: whole game days, oldest first
function rollHistorySeries(candles, tf) {
  if (!candles.length) return candles;
  const window = HISTORY_WINDOWS[tf] || HISTORY_DEFAULT_WINDOW;
  const newest = candles[candles.length - 1];
  let rolled = candles;
  if (window.days > 0) {
    const cutoff = (Math.floor(newest.t / GAME_DAY_MS) - window.days + 1) * GAME_DAY_MS;
    if (candles[0].t < cutoff) rolled = candles.filter((candle) => candle.t >= cutoff);
  }
  const max = window.max || HISTORY_MAX_CANDLES;
  return rolled.length > max ? rolled.slice(-max) : rolled;
}

// one bar per timestamp, newest wins, then the rolling window is applied
function mergeHistorySeries(existing, fresh, tf, reset) {
  const byTime = new Map();
  if (!reset) {
    for (const candle of existing) byTime.set(candle.t, candle);
  }
  for (const candle of fresh) byTime.set(candle.t, candle);
  return rollHistorySeries([...byTime.values()].sort((left, right) => left.t - right.t), tf);
}

function openHistoryDb() {
  if (historyDbPromise) return historyDbPromise;
  historyDbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    } catch (e) {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_SERIES_STORE)) {
        db.createObjectStore(HISTORY_SERIES_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return historyDbPromise;
}

function historyDbRequest(mode, run) {
  return openHistoryDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let transaction;
      try {
        transaction = db.transaction(HISTORY_SERIES_STORE, mode);
      } catch (e) {
        resolve(null);
        return;
      }
      const store = transaction.objectStore(HISTORY_SERIES_STORE);
      let result = null;
      try {
        const request = run(store);
        if (request) request.onsuccess = () => { result = request.result; };
      } catch (e) {
        resolve(null);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    });
  });
}

function loadStoredViewpoints() {
  try {
    const raw = localStorage.getItem(HISTORY_VIEW_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [key, view] of Object.entries(parsed)) {
      if (view && typeof view === 'object') historyViews.set(key, view);
    }
  } catch (e) {}
}

function persistHistoryViews() {
  if (historyViewSaveTimer) return;
  historyViewSaveTimer = setTimeout(() => {
    historyViewSaveTimer = null;
    try {
      const payload = {};
      historyViews.forEach((view, key) => { payload[key] = view; });
      localStorage.setItem(HISTORY_VIEW_KEY, JSON.stringify(payload));
    } catch (e) {}
  }, HISTORY_VIEW_SAVE_MS);
}

loadStoredViewpoints();

const HistoryCache = {
  maxCandles: HISTORY_MAX_CANDLES,
  windowDays: (tf) => (HISTORY_WINDOWS[tf] || HISTORY_DEFAULT_WINDOW).days,
  // how many bars this timeframe's window holds: the install asks for exactly
  // that many, so the local copy and the server window are the same size
  maxFor: (tf) => (HISTORY_WINDOWS[tf] || HISTORY_DEFAULT_WINDOW).max,
  roll: (candles, tf) => rollHistorySeries(candles, tf),
  key: historyKey,

  // synchronous lookups: the chart paints from these on a company switch
  peek(sym, tf) {
    const entry = historySeries.get(historyKey(sym, tf));
    return entry && entry.candles && entry.candles.length ? entry.candles : null;
  },
  peekView(sym, tf) {
    return historyViews.get(historyKey(sym, tf)) || null;
  },

  // where the player was looking, so coming back to a company reopens the window
  // instead of jumping to the newest candle. `from` is the timestamp of the first
  // visible bar: the series keeps growing, so the window is anchored on that time
  // rather than on the distance to the newest candle.
  setView(sym, tf, view) {
    if (!sym || !tf || !view) return;
    const visibleCount = Math.max(2, Math.round(Number(view.visibleCount) || 0));
    const panOffset = Math.max(0, Math.round(Number(view.panOffset) || 0));
    if (!visibleCount) return;
    const entry = { visibleCount, panOffset, at: Date.now() };
    // the player was watching the live candle: come back to the present
    if (view.live === true) entry.live = true;
    const from = Number(view.from);
    if (Number.isFinite(from) && from > 0) entry.from = from;
    historyViews.set(historyKey(sym, tf), entry);
    persistHistoryViews();
  },

  // reads the stored window of a company from IndexedDB into memory
  async get(sym, tf) {
    const key = historyKey(sym, tf);
    const cached = historySeries.get(key);
    if (cached) return cached.candles;
    const record = await historyDbRequest('readonly', (store) => store.get(key));
    if (!record || !Array.isArray(record.candles)) return null;
    const candles = record.candles.map(historyCandleFromTuple).filter(Boolean);
    if (!candles.length) return null;
    historySeries.set(key, { candles, updatedAt: record.updatedAt || 0 });
    return candles;
  },

  // stores a series (used by merge); never rejects
  async put(sym, tf, series) {
    const key = historyKey(sym, tf);
    const candles = rollHistorySeries(series, tf);
    const entry = { key, sym, tf, candles, updatedAt: Date.now() };
    historySeries.set(key, { candles, updatedAt: entry.updatedAt });
    await historyDbRequest('readwrite', (store) => store.put({
      key,
      sym,
      tf,
      candles: candles.map(historyTuple),
      updatedAt: entry.updatedAt,
    }));
    return candles;
  },

  // folds the bars the server sent into the local copy and returns the merged
  // series: `reset` replaces the copy (the stored window no longer reaches back
  // to the player's cursor), otherwise the fresh bars are appended
  async merge(sym, tf, fresh, options = {}) {
    const key = historyKey(sym, tf);
    let existing = this.peek(sym, tf);
    if (!existing) existing = (await this.get(sym, tf)) || [];
    const incoming = (Array.isArray(fresh) ? fresh : []).map(historyCandleFromWire).filter(Boolean);
    if (!incoming.length && existing.length) return existing;
    const merged = mergeHistorySeries(existing, incoming, tf, options.reset === true);
    return this.put(sym, tf, merged);
  },

  // loads every stored company/timeframe into memory. called once at boot so the
  // first company switch already has its window installed locally.
  async warm(limit = 40) {
    const records = await historyDbRequest('readonly', (store) => store.getAll());
    if (!Array.isArray(records)) return 0;
    let loaded = 0;
    for (const record of records.slice(0, limit)) {
      if (!record || typeof record.key !== 'string' || !Array.isArray(record.candles)) continue;
      if (historySeries.has(record.key)) continue;
      const candles = record.candles.map(historyCandleFromTuple).filter(Boolean);
      if (!candles.length) continue;
      historySeries.set(record.key, { candles, updatedAt: record.updatedAt || 0 });
      loaded += 1;
    }
    return loaded;
  },

  stats() {
    let candles = 0;
    historySeries.forEach((entry) => { candles += entry.candles.length; });
    return {
      series: historySeries.size,
      candles,
      views: historyViews.size,
      indexedDb: typeof indexedDB !== 'undefined',
    };
  },
};
