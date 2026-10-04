// rolling, on-disk candle history for the trading floor chart.
//
// the chart is a window that slides through the company's life: it keeps a whole
// number of game days and, every time a new game day opens, the oldest one is
// dropped — the first bar of the window moves 1 -> 2 -> 3 instead of the series
// growing (or the view drifting) forever. that window is what this module owns.
//
// it lives on disk one file per company and game day, so the past does not have
// to be rewritten every few seconds: only the game day still open changes.
//
//   data/history/<SYM>/d<YYYY-MM-DD>.json   the 5m bars of one game day; written
//                                           once when the day closes and then
//                                           never touched again
//   data/history/<SYM>/daily.json           one bar per game day: the company's
//                                           stored life, what the 1W view scrolls
//
// pruning is literally deleting the oldest day's file, which is exactly the
// fragment that no longer fits in the window. the hourly series is not stored:
// the server rebuilds it from the 5m bars (see engine.rebuildHourly), so there is
// one source of truth instead of three copies of the same past.
import fs from 'node:fs';
import path from 'node:path';
import {
  CANDLE_RESOLUTIONS,
  GAME_DAY_MS,
  GAME_MINUTE_MS,
  roundPrice,
} from './tuning.mjs';

export const HISTORY_DIR = 'history';
const DAY_FILE = /^d(\d{4}-\d{2}-\d{2})\.json$/;
const DAILY_FILE = 'daily.json';
// how often a pending save is written out. the live game day changes every tick,
// so this is what keeps the disk quiet; the day files themselves are immutable
export const DEFAULT_SAVE_DELAY_MS = 15_000;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// el redondeo de precios compartido: uno solo en todo el servicio, para que un
// precio de centavos no se aplaste a 0 al guardarlo ni al releerlo
function round(value) {
  return roundPrice(value);
}

// the game calendar is a plain multiple of GAME_DAY_MS, so a game day maps to an
// ISO date (its 00:00 UTC boundary) and the files sort chronologically by name
export function dayIndexFor(gameTime) {
  return Math.floor(gameTime / GAME_DAY_MS);
}

export function dayKeyFor(gameTime) {
  return new Date(dayIndexFor(gameTime) * GAME_DAY_MS).toISOString().slice(0, 10);
}

function dayIndexFromKey(key) {
  const parsed = Date.parse(`${key}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / GAME_DAY_MS) : null;
}

function candleFromTuple(item) {
  const values = Array.isArray(item)
    ? item
    : [item && item.t, item && item.o, item && item.h, item && item.l, item && item.c];
  if (!values.every(isFiniteNumber)) return null;
  const [t, o, h, l, c] = values;
  return {
    t: Math.floor(t),
    o: round(o),
    h: round(Math.max(h, o, c)),
    l: round(Math.min(l, o, c)),
    c: round(c),
  };
}

function parseCandles(raw) {
  const candles = [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.candles) ? raw.candles : [];
  for (const item of list) {
    const candle = candleFromTuple(item);
    if (candle) candles.push(candle);
  }
  candles.sort((left, right) => left.t - right.t);
  return candles;
}

function toTuple(candle) {
  return [candle.t, candle.o, candle.h, candle.l, candle.c];
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim().length ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn(`unable to read ${filePath}:`, error && error.message);
    return null;
  }
}

function writeJson(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(value));
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    console.warn(`unable to persist ${filePath}:`, error && error.message);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {}
    return false;
  }
}

/**
 * opens (or creates) the history folder and returns the store the server uses.
 *
 * the store never throws and never touches the market model: the server hands it
 * the series and it decides what is new, what belongs to a closed day and which
 * file is now outside the rolling window.
 */
export function createHistoryStore(dataDir, options = {}) {
  const root = path.join(dataDir, options.dirName ?? HISTORY_DIR);
  const intradayDays = options.intradayDays ?? CANDLE_RESOLUTIONS.intraday.days;
  const dailyDays = options.dailyDays ?? CANDLE_RESOLUTIONS.daily.days;
  const delay = options.delay ?? DEFAULT_SAVE_DELAY_MS;
  const now = options.now ?? (() => Date.now());

  // per symbol bookkeeping: which day files already exist, and the signature of
  // the last write so an unchanged series is never rewritten
  const state = new Map();
  let dirty = false;
  let timer = null;
  let lastSavedAt = 0;
  let writes = 0;
  let pendingMarket = null;

  function symbolDir(sym) {
    return path.join(root, sym);
  }

  function stateFor(sym) {
    let entry = state.get(sym);
    if (!entry) {
      entry = { days: new Set(), daySigs: new Map(), dailySignature: '', firstSeen: true };
      state.set(sym, entry);
    }
    return entry;
  }

  function listDayFiles(sym) {
    const dir = symbolDir(sym);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((name) => {
        const match = DAY_FILE.exec(name);
        if (!match) return null;
        const index = dayIndexFromKey(match[1]);
        return index === null ? null : { key: match[1], index, file: path.join(dir, name) };
      })
      .filter(Boolean)
      .sort((left, right) => left.index - right.index);
  }

  // reads the stored window of one company: the 5m bars of the last N game days
  // and the daily series (one bar per game day) that backs the 1W view
  function loadSymbol(sym, gameTime) {
    const entry = stateFor(sym);
    const files = listDayFiles(sym);
    if (files.length) entry.days = new Set(files.map((file) => file.key));

    const newestDay = isFiniteNumber(gameTime) ? dayIndexFor(gameTime) : files.length ? files[files.length - 1].index : null;
    const oldestDay = isFiniteNumber(newestDay) ? newestDay - intradayDays + 1 : null;

    const intraday = [];
    const kept = [];
    const daySigs = new Map();
    for (const file of files) {
      if (oldestDay !== null && file.index < oldestDay) {
        // outside the rolling window: delete the fragment and forget it
        try {
          fs.rmSync(file.file, { force: true });
        } catch {}
        continue;
      }
      kept.push(file);
      const stored = parseCandles(readJson(file.file));
      const lastStored = stored[stored.length - 1];
      // remember what is already on disk, so a day that was written while it was
      // still open is rewritten once it closes with its final bars
      if (lastStored) daySigs.set(file.key, signature(stored.length, lastStored));
      intraday.push(...stored);
    }
    entry.days = new Set(kept.map((file) => file.key));
    entry.daySigs = daySigs;
    intraday.sort((left, right) => left.t - right.t);

    const daily = parseCandles(readJson(path.join(symbolDir(sym), DAILY_FILE))).slice(-dailyDays);
    const lastDaily = daily[daily.length - 1];
    entry.dailySignature = lastDaily ? signature(daily.length, lastDaily) : '';
    entry.firstSeen = false;

    return {
      intraday: intraday.slice(-CANDLE_RESOLUTIONS.intraday.limit),
      daily,
      days: kept.length,
      newestDay: kept.length ? kept[kept.length - 1].index : null,
    };
  }

  function signature(count, candle) {
    return `${count}:${candle.t}:${candle.c}:${candle.h}:${candle.l}`;
  }

  // writes the 5m bars of a company, one file per game day. a day is written
  // whenever its bars changed (the open one keeps growing, the last one gets its
  // final bars when it closes) and then it is left alone forever.
  function saveIntraday(sym, candles, newestDay) {
    const entry = stateFor(sym);
    if (!entry.daySigs) entry.daySigs = new Map();
    const byDay = new Map();
    for (const candle of candles) {
      const index = dayIndexFor(candle.t);
      let bucket = byDay.get(index);
      if (!bucket) {
        bucket = { index, key: dayKeyFor(candle.t), list: [] };
        byDay.set(index, bucket);
      }
      bucket.list.push(candle);
    }

    let changed = false;
    const ordered = [...byDay.values()].sort((left, right) => left.index - right.index);
    for (const bucket of ordered) {
      const last = bucket.list[bucket.list.length - 1];
      const sig = signature(bucket.list.length, last);
      if (entry.daySigs.get(bucket.key) === sig) continue;

      const file = path.join(symbolDir(sym), `d${bucket.key}.json`);
      if (!writeJson(file, bucket.list.map(toTuple))) continue;
      entry.daySigs.set(bucket.key, sig);
      entry.days.add(bucket.key);
      writes += 1;
      changed = true;
    }

    // the rolling window: any day older than the window is deleted, which is what
    // makes the first bar of the chart move forward one whole day at a time
    if (isFiniteNumber(newestDay)) {
      const oldestAllowed = newestDay - intradayDays + 1;
      for (const key of [...entry.days]) {
        const index = dayIndexFromKey(key);
        if (index === null || index >= oldestAllowed) continue;
        try {
          fs.rmSync(path.join(symbolDir(sym), `d${key}.json`), { force: true });
        } catch {}
        entry.days.delete(key);
        entry.daySigs?.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  function saveDaily(sym, candles) {
    if (!candles.length) return false;
    const entry = stateFor(sym);
    const last = candles[candles.length - 1];
    const sig = signature(candles.length, last);
    if (entry.dailySignature === sig) return false;
    if (!writeJson(path.join(symbolDir(sym), DAILY_FILE), candles.slice(-dailyDays).map(toTuple))) {
      return false;
    }
    entry.dailySignature = sig;
    writes += 1;
    return true;
  }

  function writeMarket(market) {
    if (!market || !Array.isArray(market.symbols)) return false;
    let changed = false;
    for (const symbol of market.symbols) {
      if (!symbol || typeof symbol.sym !== 'string') continue;
      const candles = symbol.candles || {};
      const intraday = Array.isArray(candles.intraday) ? candles.intraday : [];
      if (intraday.length) {
        const newestDay = dayIndexFor(intraday[intraday.length - 1].t);
        if (saveIntraday(symbol.sym, intraday, newestDay)) changed = true;
      }
      if (Array.isArray(candles.daily) && saveDaily(symbol.sym, candles.daily)) changed = true;
    }
    if (changed) lastSavedAt = now();
    return changed;
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty || !pendingMarket) return false;
    dirty = false;
    const market = pendingMarket;
    pendingMarket = null;
    return writeMarket(market);
  }

  // called on every tick: only remembers the market and schedules the write, so
  // the disk is touched at most once every `delay` milliseconds
  function save(market) {
    pendingMarket = market;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
    timer.unref?.();
  }

  function stats() {
    let dayFiles = 0;
    let bytes = 0;
    let oldest = null;
    let newest = null;
    let symbols = 0;
    try {
      for (const sym of fs.readdirSync(root)) {
        const files = listDayFiles(sym);
        if (!files.length && !fs.existsSync(path.join(symbolDir(sym), DAILY_FILE))) continue;
        symbols += 1;
        for (const file of files) {
          dayFiles += 1;
          try {
            bytes += fs.statSync(file.file).size;
          } catch {}
          if (oldest === null || file.index < oldest) oldest = file.index;
          if (newest === null || file.index > newest) newest = file.index;
        }
        const dailyFile = path.join(symbolDir(sym), DAILY_FILE);
        try {
          bytes += fs.statSync(dailyFile).size;
        } catch {}
      }
    } catch {}
    return {
      root,
      symbols,
      dayFiles,
      bytes,
      writes,
      lastSavedAt,
      oldestDay: oldest === null ? null : new Date(oldest * GAME_DAY_MS).toISOString().slice(0, 10),
      newestDay: newest === null ? null : new Date(newest * GAME_DAY_MS).toISOString().slice(0, 10),
      retentionDays: intradayDays,
      dailyDays,
    };
  }

  return {
    root,
    dayMs: GAME_DAY_MS,
    minuteMs: GAME_MINUTE_MS,
    loadSymbol,
    save,
    flush,
    stats,
    get dirty() {
      return dirty;
    },
  };
}
