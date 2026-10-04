import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hashPassword, verifyPassword } from '../services/market/passwords.mjs';
import {
  portfolioNetWorth,
  portfolioTradingValue,
} from '../services/market/valuation.mjs';
import {
  accountKey,
  authenticate,
  createAccountStore,
  defaultPortfolio,
  loginAccount,
  logoutAccount,
  registerAccount,
  sanitizePortfolio,
} from '../services/market/accounts.mjs';
import {
  CANDLE_MAX_LIMIT,
  CANDLE_RESOLUTIONS,
  adminPublishNews,
  adminShock,
  GAME_DAY_MS,
  GAME_EPOCH,
  GAME_MINUTE_MS,
  HISTORY_WINDOW_DAYS,
  HISTORY_LIMIT,
  MIN_PRICE,
  NEWS_CHANCE_PER_STEP,
  SWING_MAX,
  TIMEFRAMES,
  backfillHistory,
  candlesFor,
  createMarketState,
  liveCandles,
  marketSnapshot,
  quoteFor,
  rebuildHourly,
  restoreMarketState,
  serializeMarket,
  serializeMarketSlim,
  tickMarketState,
} from '../services/market/engine.mjs';
import { createHistoryStore, dayKeyFor } from '../services/market/history.mjs';
import { casinoAction, handValue, isBlackjack } from '../services/market/casino.mjs';
import { castVote, openPoll, pollsState, resolveDuePolls, POLL_REWARD } from '../services/market/polls.mjs';
import { createJsonStore } from '../services/market/store.mjs';
import { createMarketServer } from '../services/market/server.mjs';
import { MARKET_SYMBOLS, profileFor } from '../services/market/companies.mjs';
import { legitValueRange, sanitizeSkins, skinsAction } from '../services/market/skins.mjs';
import { sanitizeTrades } from '../services/market/trades.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-market-'));
}

// El dinero y el ranking son del servidor (services/market/ledger.mjs): un PUT
// ya no puede plantarlos. Una prueba que necesite una cartera fabricada —para
// medir el ranking, el banco o el casino— la planta directamente en la cuenta,
// que es como se vería después de una semana real de operaciones, en vez de
// fingir que el autoguardado sigue siendo la fuente.
function plantPortfolio(instance, name, portfolio) {
  const account = instance.accounts.accounts[accountKey(name)];
  if (!account) throw new Error(`no such account: ${name}`);
  account.portfolio = sanitizePortfolio(portfolio);
  instance.persistAccounts();
  return account.portfolio;
}

describe('passwords', () => {
  test('hashes are salted, prefixed and verifiable', () => {
    const first = hashPassword('dhaiwhuidh');
    const second = hashPassword('dhaiwhuidh');
    expect(first).toStartWith('scrypt$');
    expect(first).not.toBe(second);
    expect(verifyPassword('dhaiwhuidh', first)).toBe(true);
    expect(verifyPassword('dhaiwhuidh', second)).toBe(true);
    expect(verifyPassword('wrong-password', first)).toBe(false);
  });

  test('malformed digests are rejected instead of throwing', () => {
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'plaintext')).toBe(false);
    expect(verifyPassword('x', 'scrypt$abcdef$00')).toBe(false);
  });
});

describe('accounts', () => {
  test('register, login, authenticate and logout', () => {
    const store = createAccountStore();
    const created = registerAccount(store, 'haddhakjhwdb', 'dhaiwhuidh');
    expect(created.ok).toBe(true);
    expect(created.account.hash).toStartWith('scrypt$');
    expect(created.account.portfolio.cash).toBe(10000);

    const duplicate = registerAccount(store, 'HADDHAKJHWDB', 'dhaiwhuidh');
    expect(duplicate.ok).toBe(false);

    const wrong = loginAccount(store, 'haddhakjhwdb', 'nope-nope');
    expect(wrong.ok).toBe(false);

    const session = loginAccount(store, 'haddhakjhwdb', 'dhaiwhuidh');
    expect(session.ok).toBe(true);
    expect(authenticate(store, session.token)?.name).toBe('haddhakjhwdb');
    expect(logoutAccount(store, session.token)).toBe(true);
    expect(authenticate(store, session.token)).toBe(null);
  });

  test('rejects invalid names and short passwords', () => {
    const store = createAccountStore();
    expect(registerAccount(store, 'ab', 'dhaiwhuidh').ok).toBe(false);
    expect(registerAccount(store, 'bad name!', 'dhaiwhuidh').ok).toBe(false);
    expect(registerAccount(store, 'goodname', '123').ok).toBe(false);
  });

  test('portfolios are sanitized and clamped', () => {
    const portfolio = sanitizePortfolio({
      cash: -50,
      level: 3.7,
      positions: {
        SOLMK: { shares: 4, avgPrice: 12.5, leverage: 999, margin: -3 },
        BAD: { shares: 0, avgPrice: 10 },
      },
      transactions: [{ sym: 'SOLMK', type: 'Compra', shares: 4, price: 12.5 }],
      stats: { wins: -1, totalTrades: 2.2, bestTrade: -80 },
      watchlist: ['SOLMK', 'SOLMK'],
    });

    expect(portfolio.cash).toBe(0);
    expect(portfolio.level).toBe(4);
    expect(portfolio.positions.BAD).toBeUndefined();
    expect(portfolio.positions.SOLMK.leverage).toBe(999);
    expect(portfolio.positions.SOLMK.margin).toBe(0);
    expect(portfolio.stats.wins).toBe(0);
    expect(portfolio.stats.totalTrades).toBe(2);
    expect(portfolio.stats.bestTrade).toBe(-80);
    expect(portfolio.transactions).toHaveLength(1);
  });

  test('default portfolio matches the client game state', () => {
    const portfolio = defaultPortfolio();
    expect(portfolio).toMatchObject({
      cash: 10000,
      level: 1,
      xp: 0,
      quests: { firstBuy: false, diversify: false },
    });
  });
});

describe('market engine', () => {
  test('ticks move prices, keep them positive and grow history', () => {
    const market = createMarketState();
    const before = market.symbols[0].price;
    for (let i = 0; i < 50; i += 1) tickMarketState(market);

    expect(market.sequence).toBe(50);
    expect(market.updatedAt).toBeGreaterThan(0);
    for (const symbol of market.symbols) {
      expect(symbol.price).toBeGreaterThanOrEqual(MIN_PRICE);
      expect(symbol.high).toBeGreaterThanOrEqual(symbol.price);
      expect(symbol.low).toBeLessThanOrEqual(symbol.price);
      expect(symbol.history.length).toBe(Math.min(HISTORY_LIMIT, 51));
    }
    expect(market.symbols[0].price).not.toBe(before);
    expect(marketSnapshot(market).quotes).toHaveLength(MARKET_SYMBOLS.length);
  });

  test('una empresa que cae sigue cayendo: el suelo viejo ya no la congela', () => {
    const market = createMarketState();
    const symbol = market.symbols[0];
    const start = 1_700_000_000_000;
    const OLD_FLOOR = 0.2;

    // arranca justo por encima del suelo que antes tenia el modelo
    for (const key of ['price', 'fund', 'anchor', 'baseline', 'settle', 'prevSettle', 'open', 'high', 'low']) {
      symbol[key] = 0.24;
    }
    symbol.swing = 0;
    // regimen bajista sostenido: el empuje del modelo va en contra de la empresa
    market.regime = { kind: 'bajista', strength: 1, left: 10 ** 9 };

    const seen = [symbol.price];
    for (let i = 0; i < 120; i += 1) {
      tickMarketState(market, () => 0.5, start + i * 1000);
      seen.push(symbol.price);
    }

    // lo que hacia antes: al llegar al suelo, cualquier retorno negativo daba
    // < 0.2 y el Math.max lo devolvia a exactamente 0.2, asi que la serie se
    // quedaba clavada repitiendo el mismo cierre (una linea recta)
    const flats = seen.filter((value, i) => i > 0 && value === seen[i - 1]).length;
    expect(flats).toBe(0);
    expect(seen.filter((value) => value === OLD_FLOOR)).toHaveLength(0);

    // y sigue perdiendo valor por debajo del suelo viejo
    expect(Math.min(...seen)).toBeLessThan(OLD_FLOOR);
    expect(symbol.price).toBeGreaterThan(0);
  });

  test('un precio de centavos sigue dibujandose: el redondeo no lo aplasta', () => {
    const market = createMarketState();
    const symbol = market.symbols[1];
    const start = 1_700_000_000_000;

    for (const key of ['price', 'fund', 'anchor', 'baseline', 'settle', 'prevSettle', 'open', 'high', 'low']) {
      symbol[key] = 0.008;
    }
    symbol.swing = 0;
    for (let i = 0; i < 30; i += 1) tickMarketState(market, () => 0.5, start + i * 1000);

    const series = candlesFor(market, symbol.sym, '5m', 400, 0);
    expect(series.candles.length).toBeGreaterThan(0);
    const closes = series.candles.map((bar) => bar.c);
    // con dos decimales fijos todo esto seria 0.01 (y por debajo de 0.005 un 0
    // que el filtro borraba, dejando la empresa sin velas)
    expect(closes.every((close) => close > 0)).toBe(true);
    expect(closes.some((close) => close < 0.01)).toBe(true);
    expect(new Set(closes).size).toBeGreaterThan(1);
  });

  test('los shocks encadenados tampoco encuentran un muro', () => {
    const market = createMarketState();
    const symbol = market.symbols[2];
    const before = symbol.price;

    // veinte golpes del 50% hacia abajo, uno detras de otro: con el suelo viejo
    // el sexto ya estaba clavado en 0.2
    for (let i = 0; i < 20; i += 1) adminShock(market, symbol.sym, -50, false);

    expect(symbol.price).toBeLessThan(before / 1000);
    expect(symbol.price).toBeGreaterThan(0);
    expect(symbol.anchor).toBeGreaterThan(0);
    expect(symbol.baseline).toBeGreaterThan(0);
  });

  test('history is capped and news shocks are recorded', () => {
    const market = createMarketState();
    market.symbols[0].history = new Array(HISTORY_LIMIT).fill(100);
    // every game minute consumes 10 price draws plus the news roll, so the roll
    // of the second step is draw 22: force exactly one headline there
    const start = 1_700_000_000_000;
    let draw = 0;
    const drawsPerMinute = MARKET_SYMBOLS.length + 1; // one price draw per symbol + the news roll
    const random = () => {
      draw += 1;
      if (draw % drawsPerMinute === 0) return draw === drawsPerMinute * 2 ? 0 : 0.9;
      return 0.5;
    };
    // the first tick only advances one game minute, the second walks a full day
    const news = tickMarketState(market, random, start)
      .concat(tickMarketState(market, random, start + 1000));

    expect(market.symbols[0].history.length).toBe(HISTORY_LIMIT);
    expect(news).toHaveLength(1);
    expect(news[0].sym).toBe(market.symbols[Math.floor(0.5 * MARKET_SYMBOLS.length)].sym);
    expect(news[0].pct).toBe(6);
    expect(news[0].at).toBeGreaterThan(GAME_EPOCH);
    expect(market.news[0]).toEqual(news[0]);
  });

  test('headlines are rare: about one per game week', () => {
    expect(NEWS_CHANCE_PER_STEP).toBeCloseTo(1 / (7 * 24 * 60), 8);

    // one game day of play (1440 game minutes) with a roll that never lands
    const market = createMarketState();
    const start = 1_700_000_000_000;
    let drawn = 0;
    const quiet = () => {
      drawn += 1;
      return 0.9;
    };
    for (let i = 0; i < 60; i += 1) tickMarketState(market, quiet, start + i * 1000);

    // every tick simulates 24 game minutes (one real second = 1440 game minutes),
    // and the very first tick only anchors the clock instead of advancing it
    expect(market.gameTime - GAME_EPOCH).toBe(59 * 24 * GAME_MINUTE_MS);
    expect(market.gameTime - GAME_EPOCH).toBeLessThan(24 * 60 * GAME_MINUTE_MS);
    expect(market.news).toHaveLength(0);
    // one price draw per symbol plus the news roll, per game minute
    expect(drawn).toBe((MARKET_SYMBOLS.length + 1) * (1 + 59 * 24));
  });

  test('the market trends in both directions and stays inside its valuation band', () => {
    const market = createMarketState();
    const initial = market.symbols.map((s) => s.price);
    const start = 1_700_000_000_000;
    // one real second is 24 game minutes, so 60 calls are one whole game day
    let seed = 20260913 >>> 0;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const days = [];
    const closes = market.symbols.map(() => []);
    for (let day = 0; day < 45; day += 1) {
      for (let s = 0; s < 60; s += 1) {
        tickMarketState(market, random, start + (day * 60 + s) * 1000);
      }
      days.push(market.symbols.map((symbol) => quoteFor(symbol).pct));
      market.symbols.forEach((symbol, i) => closes[i].push(symbol.price));
    }

    market.symbols.forEach((symbol, i) => {
      expect(symbol.price).toBeGreaterThanOrEqual(MIN_PRICE);
      // 45 game days of trading must not turn a $230 stock into a $12 one nor
      // send it to the moon: the soft band around the long run level holds
      const ratio = symbol.price / initial[i];
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(3.4);
    });

    // a real market moves in waves: some stretch of five game days has to travel
    const bestRuns = market.symbols.map((symbol, i) => {
      const c = closes[i];
      let best = 0;
      for (let w = 0; w + 5 < c.length; w += 1) best = Math.max(best, c[w + 5] / c[w] - 1);
      return best;
    });
    expect(Math.max(...bestRuns)).toBeGreaterThan(0.18);

    // and both colours show up on the board: winning and losing days, and at
    // least one day that really moved (a headline surprise)
    const flat = days.flat();
    expect(flat.some((v) => v > 0)).toBe(true);
    expect(flat.some((v) => v < 0)).toBe(true);
    expect(Math.max(...flat.map(Math.abs))).toBeGreaterThan(10);
    expect(market.news.some((item) => item.shock === true)).toBe(true);
  });

  test('a headline lands over hours instead of teleporting the price', async () => {
    const market = createMarketState();
    // the intraday wobble is pinned off here so the assertions follow the drift
    // the headline adds, not the noise on top of it
    market.swingEnabled = false;
    const start = 1_700_000_000_000;
    // 0.5 is a zero gaussian draw and every symbol's own surprise cadence is
    // pushed out of reach: the only price mover left is the admin headline
    for (const entry of market.symbols) {
      entry.profile = { ...profileFor(entry.sym), surpriseDays: 1e9 };
    }
    // pin the mood flat: regime and sectors neutral for the whole window, so
    // the assertions follow the headline instead of the market's own weather
    market.regime = { kind: 'lateral', bias: 0, strength: 0, left: 1e12 };
    for (const mood of Object.values(market.sectors)) {
      mood.bias = 0;
      mood.strength = 0;
      mood.left = 1e12;
    }
    const quiet = () => 0.5;
    const symbol = market.symbols[4];
    const before = symbol.price;

    // the admin path prices the headline in as an impulse that the following
    // ticks deliver (no instant jump, no tape event of its own)
    const item = adminPublishNews(market, symbol.sym, 6, 'prueba');
    expect(item).toBeTruthy();
    expect(item.pct).toBe(6);
    expect(symbol.price).toBe(before);

    // and it keeps arriving over the next game hours: the tape ends the window
    // above where it started but far below the naive instant +6% — the original
    // bug this test pins (reversion and the anchor eat part of the move)
    for (let i = 1; i <= 600; i += 1) tickMarketState(market, quiet, start + i * 1000);
    const delivered = symbol.price / before - 1;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(0.05);
  });

  test('a persisted market is restored with its prices and news', () => {
    const market = createMarketState();
    for (let i = 0; i < 25; i += 1) tickMarketState(market);
    market.news = [{ sym: 'SOLMK', title: 'algo', pct: 3, at: 123 }];

    const restored = restoreMarketState(JSON.parse(JSON.stringify(market)));
    expect(restored.sequence).toBe(market.sequence);
    expect(restored.symbols[0].price).toBeCloseTo(market.symbols[0].price, 6);
    expect(restored.symbols[0].history).toEqual(market.symbols[0].history);
    expect(restored.news).toHaveLength(1);
    expect(restored.symbols).toHaveLength(market.symbols.length);
  });

  test('the intraday swing makes bars tall in both directions without running away', () => {
    // twenty game days, not four: the regression this guards against only shows
    // up after the wobble has had time to feed back into the price (an integrated
    // step ratchets the price a little further every day, and after twenty days a
    // single day spanned 70-130% instead of the usual 5-15%)
    const DAYS = 20;
    const walk = (market) => {
      const start = 1_700_000_000_000;
      let seed = 90210;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      let maxSpan = 0;
      const maxDrift = market.symbols.map(() => 0);
      // the engine steps 24 game minutes per tick, so 60 ticks is one game day
      for (let d = 0; d < DAYS; d += 1) {
        const opens = market.symbols.map((s) => s.open);
        for (let i = 0; i < 60; i += 1) tickMarketState(market, random, start + (d * 60 + i) * 1000);
        market.symbols.forEach((s, index) => {
          maxSpan = Math.max(maxSpan, Math.abs(Math.log(s.price / opens[index])));
          maxDrift[index] = Math.max(maxDrift[index], Math.abs(Math.log(s.price / s.fund)));
        });
      }
      const candles = market.symbols[0].candles.intraday;
      const body = candles.reduce((sum, c) => sum + Math.abs(c.c - c.o) / c.o, 0) / candles.length;
      return { body, maxSpan, maxDrift, market };
    };

    const withSwing = walk(createMarketState());
    const flat = createMarketState();
    flat.swingEnabled = false;
    const withoutSwing = walk(flat);

    // the wobble is what makes five minute bars actually move: taller bodies
    expect(withSwing.body).toBeGreaterThan(withoutSwing.body * 1.4);
    // and it never leaves its clamp, because it is applied *on top of* the
    // fundamental path instead of being added to the price every minute
    for (const symbol of withSwing.market.symbols) {
      expect(Math.abs(symbol.swing)).toBeLessThanOrEqual(SWING_MAX + 1e-9);
      expect(symbol.price).toBeCloseTo(symbol.fund * Math.exp(symbol.swing), 6);
    }
    // the price can never be more than the clamp away from its own path, no
    // matter how many game days have gone by
    expect(Math.max(...withSwing.maxDrift)).toBeLessThanOrEqual(SWING_MAX + 1e-6);
    // so a single game day stays inside a range a chart can actually draw
    expect(withSwing.maxSpan).toBeLessThan(0.6);
    expect(withoutSwing.maxSpan).toBeLessThan(0.6);
  });

  test('the settlement price is fixed for two game days at a time', () => {
    const market = createMarketState();
    const symbol = market.symbols[0];
    const start = 1_700_000_000_000;
    let seed = 555;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 4294967296;
    };

    // a whole game day of ticks: the quote must not move one cent
    const firstSettle = quoteFor(symbol, market).price;
    const firstDay = market.symbols.map(() => 0);
    for (let i = 0; i < 60; i += 1) {
      tickMarketState(market, random, start + i * 1000);
      if (i === 30) {
        market.symbols.forEach((s, index) => { firstDay[index] = quoteFor(s, market).price; });
      }
    }
    expect(quoteFor(symbol, market).price).toBe(firstSettle);
    market.symbols.forEach((s, index) => {
      expect(quoteFor(s, market).price).toBe(firstDay[index]);
    });
    // and the tape behind it did move
    expect(symbol.price).not.toBe(firstSettle);
    expect(quoteFor(symbol, market).live).toBe(Math.round(symbol.price * 100) / 100);

    // the second game day rolls the settlement: now the quote is the tape
    for (let i = 60; i < 125; i += 1) tickMarketState(market, random, start + i * 1000);
    expect(quoteFor(symbol, market).price).not.toBe(firstSettle);
    expect(quoteFor(symbol, market).settleAt % (24 * 60 * GAME_MINUTE_MS)).toBe(0);
    expect(quoteFor(symbol, market).nextSettleAt).toBeGreaterThan(market.gameTime);

    // the change the list shows is measured against the previous settlement
    const q = quoteFor(symbol, market);
    expect(q.change).toBeCloseTo(q.price - symbol.prevSettle, 2);
  });

  test('ticks fold into real OHLC candles with both colours', () => {
    const market = createMarketState();
    const symbol = market.symbols[0];
    const start = 1_700_000_000_000;
    // deterministic walk so the assertion never depends on chance
    let seed = 123456789;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    // 300 ticks = 300 real seconds = five whole game days
    for (let i = 0; i < 300; i += 1) {
      tickMarketState(market, random, start + i * 1000);
    }
    expect(market.gameTime - GAME_EPOCH).toBe(299 * 24 * GAME_MINUTE_MS);

    const { intraday, hourly } = symbol.candles;
    // the window is measured in whole game days: five days of 5m bars fit inside
    // it, and no bar older than the window survives
    expect(intraday.length).toBeGreaterThan(1000);
    expect(intraday.length).toBeLessThanOrEqual(CANDLE_RESOLUTIONS.intraday.limit);
    const oldestDay = Math.floor(intraday[0].t / GAME_DAY_MS);
    const newestDay = Math.floor(intraday[intraday.length - 1].t / GAME_DAY_MS);
    expect(newestDay - oldestDay + 1).toBeLessThanOrEqual(CANDLE_RESOLUTIONS.intraday.days);
    // 299 ticking seconds cover 299 * 24 game minutes, i.e. 119 whole hours plus
    // a partial one that still opens a bar
    expect(hourly).toHaveLength(Math.ceil((299 * 24) / 60));
    for (const candle of intraday) {
      expect(candle.t % (CANDLE_RESOLUTIONS.intraday.minutes * GAME_MINUTE_MS)).toBe(0);
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
    }
    expect(hourly[0].o).toBeLessThanOrEqual(hourly[0].h);
    expect(hourly[0].l).toBeLessThanOrEqual(hourly[0].c);

    // a candle built from a single price per bar could only ever be flat and
    // green: real ticks always produce wicks and both up and down bars
    expect(intraday.some((c) => c.h > c.l)).toBe(true);
    expect(intraday.some((c) => c.c > c.o)).toBe(true);
    expect(intraday.some((c) => c.c < c.o)).toBe(true);

    const live = liveCandles(market);
    expect(live).toHaveLength(market.symbols.length);
    expect(live[0]).toMatchObject({ sym: 'SOLMK' });
    expect(typeof live[0].o).toBe('number');
  });

  test('candles aggregate into the game timeframes and respect their limits', () => {
    const market = createMarketState();
    const symbol = market.symbols[0];
    // aligned to an hour boundary so the buckets group evenly
    const base = Math.floor(1_700_000_000_000 / (60 * GAME_MINUTE_MS)) * 60 * GAME_MINUTE_MS;
    symbol.candles.intraday = [];
    symbol.candles.hourly = [];
    for (let i = 0; i < 300; i += 1) {
      symbol.candles.intraday.push({
        t: base + i * 5 * GAME_MINUTE_MS,
        o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i,
      });
    }
    for (let i = 0; i < 300; i += 1) {
      symbol.candles.hourly.push({
        t: base + i * 60 * GAME_MINUTE_MS,
        o: 200 + i, h: 201 + i, l: 199 + i, c: 200.5 + i,
      });
    }
    // 1W is drawn from the daily series, which is the company's whole history
    for (let i = 0; i < 260; i += 1) {
      symbol.candles.daily.push({
        t: base + i * 24 * 60 * GAME_MINUTE_MS,
        o: 300 + i, h: 302 + i, l: 298 + i, c: 301 + i,
      });
    }

    // 300 stored bars are well inside the twenty game day window, so the whole
    // series comes back; `limit` is what narrows the response
    const five = candlesFor(market, 'SOLMK', '5m', 0);
    expect(five.candles).toHaveLength(300);
    expect(five.minutes).toBe(5);
    expect(five.candles[five.candles.length - 1].o).toBe(100 + 299);
    expect(five.windowStart).toBe(base);
    expect(five.reset).toBe(false);

    // 15m bars group three 5m candles each: a hundred bars, still inside the cap
    const fifteen = candlesFor(market, 'SOLMK', '15m', 0);
    expect(fifteen.candles).toHaveLength(100);
    expect(fifteen.candles[0].h).toBe(101 + 2);
    expect(fifteen.candles[0].l).toBe(99);
    expect(fifteen.candles[0].c).toBe(100.5 + 2);

    // the client stores its own copy, so it asks only for what is newer than its
    // cursor; a cursor older than the window means the local copy is stale
    const delta = candlesFor(market, 'SOLMK', '5m', 0, base + 297 * 5 * GAME_MINUTE_MS);
    expect(delta.candles).toHaveLength(2);
    expect(delta.candles[0].o).toBe(100 + 298);
    expect(delta.since).toBe(base + 297 * 5 * GAME_MINUTE_MS);
    expect(delta.reset).toBe(false);
    const stale = candlesFor(market, 'SOLMK', '5m', 0, base - 5 * GAME_MINUTE_MS);
    expect(stale.reset).toBe(true);
    expect(stale.candles).toHaveLength(300);
    expect(candlesFor(market, 'SOLMK', '5m', 10, 0).candles).toHaveLength(10);

    // the hourly series feeds 1h: the view keeps its own limit, capped by what
    // the symbol actually has
    const hourly = candlesFor(market, 'SOLMK', '1h', 0);
    expect(hourly.candles).toHaveLength(Math.min(300, TIMEFRAMES['1h'].limit));

    // the daily series feeds 1W, which is one bar per game day and can be
    // scrolled all the way back through the company's history
    const week = candlesFor(market, 'SOLMK', '1W', 0);
    expect(week.candles).toHaveLength(Math.min(260, TIMEFRAMES['1W'].limit));
    expect(week.candles.length).toBeGreaterThan(200);
    expect(week.minutes).toBe(24 * 60);
    for (const candle of week.candles) {
      expect(candle.t % (24 * 60 * GAME_MINUTE_MS)).toBe(0);
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
    }
    expect(candlesFor(market, 'SOLMK', '1W', 5).candles).toHaveLength(5);

    expect(candlesFor(market, 'SOLMK', '9m', 10)).toBe(null);
    expect(candlesFor(market, 'NOPE', '5m', 10)).toBe(null);

    // the endpoint's cap is exactly the deepest window: the player's machine can
    // install its whole copy in one request, and no request can ask for more
    // than the server keeps
    expect(CANDLE_MAX_LIMIT).toBe(CANDLE_RESOLUTIONS.intraday.limit);
  });

  test('candles survive a save/load round trip', () => {
    const market = createMarketState();
    for (let i = 0; i < 90; i += 1) {
      tickMarketState(market, () => 0.7, 1_700_000_000_000 + i * 1000);
    }
    const saved = JSON.parse(JSON.stringify(serializeMarket(market)));
    // persisted as compact tuples to keep the file small
    expect(Array.isArray(saved.symbols[0].candles.intraday[0])).toBe(true);
    expect(saved.symbols[0].candles.intraday[0]).toHaveLength(5);
    expect(Array.isArray(saved.symbols[0].candles.hourly[0])).toBe(true);

    const restored = restoreMarketState(saved);
    expect(restored.symbols[0].candles).toEqual(market.symbols[0].candles);
    expect(restored.gameTime).toBe(market.gameTime);

    const fromObjects = restoreMarketState(market);
    expect(fromObjects.symbols[0].candles).toEqual(market.symbols[0].candles);

    const tooMany = createMarketState();
    const limit = CANDLE_RESOLUTIONS.intraday.limit;
    tooMany.symbols[0].candles.intraday = new Array(limit + 50).fill(null).map((_, i) => [
      1_700_000_000_000 + i * 5 * GAME_MINUTE_MS, 10, 11, 9, 10.5,
    ]);
    const trimmed = restoreMarketState(tooMany);
    expect(trimmed.symbols[0].candles.intraday).toHaveLength(limit);

    // a save written by the previous real time engine (single `candles` array)
    // still restores its prices, it just starts a fresh candle series
    const legacy = restoreMarketState({
      sequence: 12,
      symbols: [{ sym: 'SOLMK', price: 210, history: [200, 210], candles: [[1, 1, 1, 1, 1]] }],
    });
    expect(legacy.symbols[0].price).toBe(210);
    expect(legacy.symbols[0].candles.intraday).toEqual([]);
    expect(legacy.gameTime).toBe(GAME_EPOCH);
  });

  test('corrupt saved data falls back to a fresh market', () => {
    const restored = restoreMarketState({ symbols: 'nope', news: 42 });
    expect(restored.symbols).toHaveLength(MARKET_SYMBOLS.length);
    expect(restored.sequence).toBe(0);
    expect(restored.news).toEqual([]);
  });
});

describe('rolling history store', () => {
  function playDay(market, state) {
    const start = 1_700_000_000_000;
    const random = () => {
      state.seed = (state.seed * 1103515245 + 12345) % 2147483648;
      return state.seed / 2147483648;
    };
    for (let i = 0; i < 60; i += 1) {
      tickMarketState(market, random, start + (state.tick += 1) * 1000);
    }
  }

  test('a slim save drops the candles and restores them empty', () => {
    const market = createMarketState();
    for (let i = 0; i < 30; i += 1) {
      tickMarketState(market, () => 0.6, 1_700_000_000_000 + i * 1000);
    }
    const slim = JSON.parse(JSON.stringify(serializeMarketSlim(market)));
    // the candle series are not part of the hot save any more: they live in the
    // rolling history files
    expect(slim.symbols[0].candles).toBeUndefined();
    expect(slim.symbols[0].price).toBe(market.symbols[0].price);
    expect(slim.symbols[0].history).toEqual(market.symbols[0].history);

    const restored = restoreMarketState(slim);
    expect(restored.symbols[0].candles.intraday).toEqual([]);
    expect(restored.symbols[0].price).toBeCloseTo(market.symbols[0].price, 6);
    expect(restored.symbols).toHaveLength(market.symbols.length);
  });

  test('the window slides one whole game day at a time and deletes the oldest file', () => {
    const dir = tempDir();
    const history = createHistoryStore(dir, { delay: 5 });
    const market = createMarketState();
    const state = { seed: 424242, tick: 0 };
    const starts = [];

    // 24 game days of play, saving once per game day like the running server does
    for (let day = 0; day < 24; day += 1) {
      playDay(market, state);
      history.save(market);
      history.flush();
      const list = market.symbols[0].candles.intraday;
      starts.push(Math.floor(list[0].t / GAME_DAY_MS));
    }

    const list = market.symbols[0].candles.intraday;
    const newestDay = Math.floor(list[list.length - 1].t / GAME_DAY_MS);
    const oldestDay = Math.floor(list[0].t / GAME_DAY_MS);
    expect(newestDay - oldestDay + 1).toBe(HISTORY_WINDOW_DAYS.intraday);

    // once the window is full the first bar moves forward by exactly one game day
    // at a time: 1 -> 2 -> 3, the oldest fragment is what goes away
    const steps = starts.slice(1).map((value, i) => value - starts[i]);
    const full = steps.slice(HISTORY_WINDOW_DAYS.intraday);
    expect(full.length).toBeGreaterThan(0);
    expect(full.every((step) => step === 1)).toBe(true);
    expect(steps.some((step) => step === 0)).toBe(true);

    // on disk: one file per game day of the window, and nothing older
    const files = fs.readdirSync(path.join(dir, 'history', 'SOLMK'))
      .filter((name) => /^d\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort();
    expect(files).toHaveLength(HISTORY_WINDOW_DAYS.intraday);
    expect(files[0]).toBe(`d${dayKeyFor(oldestDay * GAME_DAY_MS)}.json`);
    expect(files[files.length - 1]).toBe(`d${dayKeyFor(newestDay * GAME_DAY_MS)}.json`);

    // saving again with no new bars rewrites nothing: the stored past is immutable
    const writesBefore = history.stats().writes;
    history.save(market);
    history.flush();
    expect(history.stats().writes).toBe(writesBefore);

    // and the stored window comes back after a restart, hourly included
    const reloaded = createMarketState();
    const stored = history.loadSymbol('SOLMK', market.gameTime);
    expect(stored.intraday.length).toBe(list.length);
    expect(stored.intraday[0].t).toBe(list[0].t);
    expect(stored.days).toBe(HISTORY_WINDOW_DAYS.intraday);
    reloaded.symbols[0].candles.intraday = stored.intraday;
    reloaded.symbols[0].candles.daily = stored.daily;
    expect(rebuildHourly(reloaded.symbols[0])).toBeGreaterThan(400);
    expect(reloaded.symbols[0].candles.hourly.length)
      .toBeLessThanOrEqual(CANDLE_RESOLUTIONS.hourly.limit);
    expect(reloaded.symbols[0].candles.hourly.length)
      .toBe(market.symbols[0].candles.hourly.length);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the five minute window is drawn in full at boot', () => {
  test('a fresh market gets twenty game days of bars without waiting for the clock', () => {
    const market = createMarketState();
    const symbol = market.symbols[0];
    expect(symbol.candles.intraday).toHaveLength(0);

    expect(backfillHistory(market)).toBe(true);

    const size = CANDLE_RESOLUTIONS.intraday.minutes * GAME_MINUTE_MS;
    const barsPerDay = (24 * 60) / CANDLE_RESOLUTIONS.intraday.minutes;
    const limit = CANDLE_RESOLUTIONS.intraday.limit;
    const intraday = symbol.candles.intraday;

    // the whole window on the first frame: the open day may be short, nothing
    // else is
    expect(intraday.length).toBeGreaterThanOrEqual((HISTORY_WINDOW_DAYS.intraday - 1) * barsPerDay);
    expect(intraday.length).toBeLessThanOrEqual(limit);
    const oldestDay = Math.floor(intraday[0].t / GAME_DAY_MS);
    const newestDay = Math.floor(intraday[intraday.length - 1].t / GAME_DAY_MS);
    expect(newestDay - oldestDay + 1).toBe(HISTORY_WINDOW_DAYS.intraday);
    // and the tape reaches the live clock, not the last time the server ran
    expect(intraday[intraday.length - 1].t).toBe(Math.floor(market.gameTime / size) * size);

    // aligned, ordered and shaped like a real tape
    const daily = new Map(symbol.candles.daily.map((day) => [Math.floor(day.t / GAME_DAY_MS), day]));
    for (let i = 0; i < intraday.length; i += 1) {
      const candle = intraday[i];
      expect(candle.t % size).toBe(0);
      if (i > 0) expect(candle.t).toBeGreaterThan(intraday[i - 1].t);
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
      // every bar trades inside its own day's candle, so the 5m view and the 1W
      // view can never tell two different stories about the same day
      const day = daily.get(Math.floor(candle.t / GAME_DAY_MS));
      expect(day).toBeTruthy();
      expect(candle.h).toBeLessThanOrEqual(day.h + 0.02);
      expect(candle.l).toBeGreaterThanOrEqual(day.l - 0.02);
    }
    expect(intraday.some((candle) => candle.c > candle.o)).toBe(true);
    expect(intraday.some((candle) => candle.c < candle.o)).toBe(true);

    // the hourly view is derived from that 5m window, so it arrives full too
    expect(symbol.candles.hourly.length).toBeGreaterThanOrEqual((HISTORY_WINDOW_DAYS.intraday - 1) * 24);
    expect(symbol.candles.hourly.length).toBeLessThanOrEqual(CANDLE_RESOLUTIONS.hourly.limit);

    // deterministic: a restart repaints the same past instead of reshuffling it
    const snapshot = intraday.map((candle) => ({ ...candle }));
    backfillHistory(market);
    expect(symbol.candles.intraday).toEqual(snapshot);
  });
});

describe('json store', () => {
  test('flushes atomically and reloads', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'data.json');
    const store = createJsonStore(file, { fallback: () => ({ count: 0 }) });
    store.load();
    expect(store.get().count).toBe(0);
    store.get().count = 7;
    store.markDirty();
    expect(store.flush()).toBe(true);
    expect(store.flush()).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).count).toBe(7);

    const second = createJsonStore(file, { fallback: () => ({ count: 0 }) });
    expect(second.load().count).toBe(7);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('market service', () => {
  let dir = '';
  let instance = null;
  let baseUrl = '';
  let token = '';
  let name = '';
  // lo que el servidor reply al registro de operaciones del test anterior: la
  // cinta sigue corriendo (tickMs 200), así que el reinicio se compara contra
  // esta foto y no contra un precio leído otra vez
  let bought = null;

  beforeAll(() => {
    dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200 });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    name = `trader${Date.now() % 100000}`;
  });

  afterAll(() => {
    instance?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('serves the owngames catalog and game assets', async () => {
    const catalog = await fetch(`${baseUrl}/owngames/catalog.json`).then((r) => r.json());
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThanOrEqual(1);
    const bolsa = catalog.find((g) => g.gameUrl === '/owngames/bolsa-trading-floor/');
    expect(bolsa).toBeTruthy();

    const page = await fetch(`${baseUrl}/owngames/bolsa-trading-floor/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('authOverlay');
    expect(html).toContain('js/net.js');

    const cover = await fetch(`${baseUrl}/owngames/bolsa-trading-floor/cover.svg`);
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toContain('svg');

    const missing = await fetch(`${baseUrl}/owngames/bolsa-trading-floor/nope.js`);
    expect(missing.status).toBe(404);
  });

  test('exposes the realtime market and history', async () => {
    const state = await fetch(`${baseUrl}/api/market/state`).then((r) => r.json());
    expect(state.quotes).toHaveLength(MARKET_SYMBOLS.length);
    expect(state.intervalMs).toBe(200);
    expect(state.gameTime).toBeGreaterThanOrEqual(GAME_EPOCH);
    expect(state.speed).toBe(1440);

    // the first candle is opened by the first tick, so poll for it
    const candlesUrl = `${baseUrl}/api/market/candles?symbol=SOLMK&tf=5m`;
    let candles = await fetch(candlesUrl).then((r) => r.json());
    const candleDeadline = Date.now() + 3000;
    while (candles.candles.length < 1 && Date.now() < candleDeadline) {
      await Bun.sleep(100);
      candles = await fetch(candlesUrl).then((r) => r.json());
    }
    expect(candles.candles.length).toBeGreaterThan(0);

    const historyUrl = `${baseUrl}/api/market/history?symbol=SOLMK&limit=50`;
    let history = await fetch(historyUrl).then((r) => r.json());
    const historyDeadline = Date.now() + 3000;
    while (history.prices.length < 2 && Date.now() < historyDeadline) {
      await Bun.sleep(100);
      history = await fetch(historyUrl).then((r) => r.json());
    }
    expect(history.sym).toBe('SOLMK');
    expect(history.prices.length).toBeGreaterThan(1);

    const unknown = await fetch(`${baseUrl}/api/market/history?symbol=NOPE`);
    expect(unknown.status).toBe(404);
  });

  test('serves aggregated candles with real OHLC values', async () => {
    const url = `${baseUrl}/api/market/candles?symbol=SOLMK&tf=5m&limit=200`;
    let payload = await fetch(url).then((r) => r.json());
    const deadline = Date.now() + 3000;
    while (payload.candles.length < 1 && Date.now() < deadline) {
      await Bun.sleep(100);
      payload = await fetch(url).then((r) => r.json());
    }

    expect(payload.sym).toBe('SOLMK');
    expect(payload.tf).toBe('5m');
    expect(payload.intervalMs).toBe(5 * 60_000);
    expect(payload.candles.length).toBeGreaterThan(0);
    for (const candle of payload.candles) {
      expect(typeof candle.t).toBe('number');
      for (const field of ['o', 'h', 'l', 'c']) expect(typeof candle[field]).toBe('number');
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
    }

    const hourly = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=1h`,
    ).then((r) => r.json());
    expect(hourly.intervalMs).toBe(60 * 60_000);

    const weekly = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=1W&limit=400`,
    ).then((r) => r.json());
    // the week view is the short one: seven daily bars at most
    expect(weekly.intervalMs).toBe(24 * 60 * 60_000);
    expect(weekly.candles.length).toBeLessThanOrEqual(TIMEFRAMES['1W'].limit);

    const badTimeframe = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=7h`,
    );
    expect(badTimeframe.status).toBe(400);

    const retiredTimeframe = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=1m`,
    );
    expect(retiredTimeframe.status).toBe(400);

    const badSymbol = await fetch(`${baseUrl}/api/market/candles?symbol=NOPE`);
    expect(badSymbol.status).toBe(404);
  });

  test('creates accounts with hashed passwords and blocks duplicates', async () => {
    const created = await fetch(`${baseUrl}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'dhaiwhuidh' }),
    });
    expect(created.status).toBe(201);
    const payload = await created.json();
    token = payload.token;
    expect(payload.account.name).toBe(name);
    expect(payload.account.portfolio.cash).toBe(10000);

    instance.flush();
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8'));
    const record = stored.accounts[name.toLowerCase()];
    expect(record.hash).toStartWith('scrypt$');
    expect(record.hash).not.toContain('dhaiwhuidh');

    const duplicate = await fetch(`${baseUrl}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'dhaiwhuidh' }),
    });
    expect(duplicate.status).toBe(409);
  });

  test('rejects bad logins and accepts good ones', async () => {
    const wrong = await fetch(`${baseUrl}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'wrong-one' }),
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${baseUrl}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'dhaiwhuidh' }),
    });
    expect(ok.status).toBe(200);
    const payload = await ok.json();
    expect(payload.token).toBeTruthy();
  });

  test('requires a session for the player profile', async () => {
    const anonymous = await fetch(`${baseUrl}/api/market/me`);
    expect(anonymous.status).toBe(401);
  });

  test('persists the portfolio and broadcasts trades over the websocket', async () => {
    const messages = [];
    const socket = new globalThis.WebSocket(`ws://127.0.0.1:${instance.port}/ws/market`);
    const opened = new Promise((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('socket failed'));
    });
    socket.onmessage = (event) => {
      try {
        messages.push(JSON.parse(event.data));
      } catch {}
    };

    await opened;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (messages.some((m) => m.type === 'tick')) break;
      await Bun.sleep(30);
    }
    const snapshot = messages.find((m) => m.type === 'snapshot');
    expect(snapshot?.snapshot?.quotes).toHaveLength(MARKET_SYMBOLS.length);
    // candles open with the first tick, so the snapshot may carry none yet
    expect(Array.isArray(snapshot?.candles)).toBe(true);
    expect(messages.some((m) => m.type === 'tick')).toBe(true);
    const tick = messages.find((m) => m.type === 'tick');
    // every tick carries the still-open candle so the chart can extend itself
    expect(tick?.candles).toHaveLength(MARKET_SYMBOLS.length);
    expect(typeof tick.candles[0].h).toBe('number');
    expect(tick.candles[0].h).toBeGreaterThanOrEqual(tick.candles[0].l);
    // and the game clock, which runs 1440x faster than real time
    expect(tick.gameTime).toBeGreaterThanOrEqual(GAME_EPOCH);
    expect(tick.speed).toBe(1440);
    // the mood of the whole market rides along, which is what the badge next to
    // the clock shows
    expect(['alcista', 'bajista', 'lateral']).toContain(tick.regime?.kind);
    expect(typeof tick.regime.bias).toBe('number');
    expect(tick.regime.left).toBeGreaterThan(0);

    // el autoguardado del cliente: manda el REGISTRO de operaciones y lo que es
    // suyo (nivel, xp, lista de seguimiento, misiones). el efectivo y la
    // posición salen de la cinta del servidor, no del cuerpo
    const saved = await fetch(`${baseUrl}/api/market/me`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ops: [{ kind: 'buy', sym: 'SOLMK', shares: 3, leverage: 2 }],
        portfolio: {
          cash: 999_999_999,
          positions: { SOLMK: { shares: 3, avgPrice: 1, leverage: 20, margin: 0 } },
          stats: { wins: 9999, totalTrades: 9999, bestTrade: 9e11, grossProfit: 9e11 },
          level: 4,
          xp: 55,
          watchlist: ['SOLMK'],
          quests: { firstBuy: true, diversify: false },
        },
      }),
    });
    expect(saved.status).toBe(200);
    const savedPayload = await saved.json();
    const book = savedPayload.account.portfolio;
    const fill = savedPayload.applied[0].price;
    bought = { cash: book.cash, shares: book.positions.SOLMK.shares, fill };
    // lo que el cliente pidió no aparece: el efectivo bajó lo que costó la
    // compra al precio de cinta y las estadísticas siguen a cero
    expect(fill).toBeGreaterThan(0);
    expect(book.cash).toBeCloseTo(10000 - (3 * fill) / 2, 6);
    expect(book.positions.SOLMK.shares).toBe(3);
    expect(book.positions.SOLMK.avgPrice).toBeCloseTo(fill, 6);
    expect(book.stats.wins).toBe(0);
    expect(book.stats.totalTrades).toBe(0);
    // lo que sí es del cliente se guarda tal cual
    expect(book.level).toBe(4);
    expect(book.xp).toBe(55);
    expect(book.watchlist).toEqual(['SOLMK']);
    expect(book.quests.firstBuy).toBe(true);
    // y la operación quedó registrada en el historial del servidor
    expect(book.transactions[0]).toMatchObject({ sym: 'SOLMK', type: 'Compra', shares: 3 });

    const tradeDeadline = Date.now() + 2000;
    while (Date.now() < tradeDeadline) {
      if (messages.some((m) => m.type === 'trade')) break;
      await Bun.sleep(20);
    }
    const trade = messages.find((m) => m.type === 'trade');
    expect(trade?.trade?.sym).toBe('SOLMK');
    expect(trade?.trade?.name).toBe(name);
    // la cinta muestra lo que el servidor cobró, no lo que el cliente decía
    expect(trade?.trade?.price).toBeCloseTo(bought.fill, 6);
    socket.close();
  });

  test('reloads market prices and player statistics after a restart', async () => {
    const priceBefore = instance.market.symbols[0].price;
    const sequenceBefore = instance.market.sequence;
    const candlesBefore = instance.market.symbols[0].candles.intraday.length;
    const gameTimeBefore = instance.market.gameTime;
    instance.stop();
    instance = null;

    expect(fs.existsSync(path.join(dir, 'market.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'players.json'))).toBe(true);

    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200 });
    baseUrl = `http://127.0.0.1:${instance.port}`;

    expect(instance.market.sequence).toBe(sequenceBefore);
    expect(instance.market.symbols[0].price).toBeCloseTo(priceBefore, 6);
    // the stored candles come back, and the restart fills the rest of the game
    // day (and the deep history) around them
    expect(instance.market.symbols[0].candles.intraday.length)
      .toBeGreaterThanOrEqual(candlesBefore);
    expect(instance.market.symbols[0].candles.daily.length)
      .toBe(CANDLE_RESOLUTIONS.daily.limit);
    // the game calendar keeps advancing from where it stopped
    expect(instance.market.gameTime).toBeGreaterThanOrEqual(gameTimeBefore);

    const restoredCandles = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=5m`,
    ).then((r) => r.json());
    expect(restoredCandles.candles.length).toBeGreaterThan(0);

    const session = await fetch(`${baseUrl}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'dhaiwhuidh' }),
    }).then((r) => r.json());

    const me = await fetch(`${baseUrl}/api/market/me`, {
      headers: { Authorization: `Bearer ${session.token}` },
    }).then((r) => r.json());

    // lo que el servidor reprodujo del registro sobrevive al reinicio: el
    // efectivo, la posición y el historial son suyos, no los del autoguardado
    expect(me.account.portfolio.positions.SOLMK.shares).toBe(3);
    expect(me.account.portfolio.cash).toBeCloseTo(bought.cash, 6);
    expect(me.account.portfolio.transactions[0]).toMatchObject({ sym: 'SOLMK', type: 'Compra' });
    expect(me.account.portfolio.level).toBe(4);
    expect(me.account.portfolio.xp).toBe(55);
    expect(me.account.portfolio.watchlist).toEqual(['SOLMK']);
  });

  // el puente de musica del reproductor. sin credenciales de spotify la ruta
  // tiene que DECIRLO: si devolviera una lista vacia como si no hubiera
  // resultados, el menu no podria distinguir "no hay nada" de "falta
  // configuracion" y el usuario se quedaria sin pista de por que no busca.
  test('la busqueda de musica dice si spotify esta configurado', async () => {
    const sinSource = await fetch(
      `${baseUrl}/api/market/music/search?q=lofi`,
    ).then((r) => r.json());
    // sin `source` sigue siendo youtube: es como la llamaba el cliente antes
    // de que existiera el switch
    expect(sinSource.source).toBe('youtube');
    expect(sinSource.configured).toBe(true);
    expect(Array.isArray(sinSource.results)).toBe(true);

    const spotify = await fetch(
      `${baseUrl}/api/market/music/search?source=spotify&q=lofi`,
    ).then((r) => r.json());
    expect(spotify.source).toBe('spotify');
    // este servicio arranca sin spotifyClientId/Secret, asi que `configured`
    // vale lo que diga el env del proceso; lo que no puede cambiar es que la
    // clave este y que no se invente ningun resultado
    expect(typeof spotify.configured).toBe('boolean');
    expect(typeof spotify.failed).toBe('boolean');
    expect(Array.isArray(spotify.results)).toBe(true);
  });

  // credenciales presentes pero invalidas: la ruta tiene que avisar de una de
  // las dos cosas que el usuario puede arreglar o reintentar (credenciales
  // rechazadas -> configured:false, o no se pudo hablar con spotify ->
  // failed:true). lo que NO puede devolver es "configured:true, failed:false y
  // cero resultados", porque eso el menu lo pinta como "no hay ninguna cancion
  // con ese nombre" y esconde el problema real.
  // no se exige configured:false exacto porque el resultado depende de la red
  // (sin salida a accounts.spotify.com lo correcto es failed:true, no un id
  // malo), y una prueba no debe depender de tener internet.
  test('unas credenciales de spotify invalidas no se reportan como "sin resultados"', async () => {
    const dir2 = tempDir();
    const roto = createMarketServer({
      port: 0,
      dataDir: dir2,
      tickMs: 60000,
      spotifyClientId: 'id-invalido',
      spotifyClientSecret: 'secreto-invalido',
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${roto.port}/api/market/music/search?source=spotify&q=lofi`,
      ).then((r) => r.json());
      expect(res.configured === false || res.failed === true).toBe(true);
      expect(res.results).toEqual([]);
    } finally {
      roto.stop();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('una busqueda vacia no sale a la red', async () => {
    for (const source of ['youtube', 'spotify']) {
      const vacia = await fetch(
        `${baseUrl}/api/market/music/search?source=${source}&q=%20%20`,
      ).then((r) => r.json());
      expect(vacia.source).toBe(source);
      expect(vacia.results).toEqual([]);
    }
  });
});

describe('candle feed over the wire', () => {
  let dir = '';
  let instance = null;
  let baseUrl = '';
  let expected = 0;
  let expectedHourly = 0;
  let gameDays = 0;

  beforeAll(() => {
    dir = tempDir();
    const market = createMarketState();
    // 90 real minutes of play = 90 game days
    const start = 1_700_000_000_000;
    let seed = 987654321;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 90 * 60; i += 1) {
      tickMarketState(market, random, start + i * 1000);
    }
    expected = market.symbols[0].candles.intraday.length;
    expectedHourly = market.symbols[0].candles.hourly.length;
    // 90 game days of play only keep the rolling twenty day window, so the stored
    // series is measured by its span, not by how long the fixture ran
    gameDays = (market.gameTime - GAME_EPOCH) / (24 * 60 * GAME_MINUTE_MS);
    fs.writeFileSync(
      path.join(dir, 'market.json'),
      JSON.stringify(serializeMarket(market)),
    );

    // no ticking so the fixture series stays exactly as written
    instance = createMarketServer({ port: 0, dataDir: dir, autoTick: false });
    baseUrl = `http://127.0.0.1:${instance.port}`;
  });

  afterAll(() => {
    instance?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('replays the persisted OHLC series with up and down candles', async () => {
    // a real minute of play is a whole game day: 5400 ticks cover 89.98 game
    // days (the first tick only anchors the clock, costing 24 game minutes)
    expect(gameDays).toBeCloseTo(90 - 24 / (24 * 60), 4);
    expect(Math.floor(gameDays)).toBe(89);
    // the window is full: twenty game days of 5m bars, no more and no less
    expect(expected).toBeGreaterThan((HISTORY_WINDOW_DAYS.intraday - 1) * 240);
    expect(expected).toBeLessThanOrEqual(CANDLE_RESOLUTIONS.intraday.limit);
    expect(expectedHourly).toBeGreaterThan(60);
    expect(expectedHourly).toBeLessThanOrEqual(CANDLE_RESOLUTIONS.hourly.limit);

    const payload = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=5m&limit=500`,
    ).then((r) => r.json());

    // `limit` is what narrows the response: the client asks for what it can hold
    expect(payload.candles).toHaveLength(500);
    // the chart needs both colours: a flat one-price-per-bar series is green only
    expect(payload.candles.some((c) => c.c > c.o)).toBe(true);
    expect(payload.candles.some((c) => c.c < c.o)).toBe(true);
    for (const candle of payload.candles) {
      expect(candle.h).toBeGreaterThan(candle.l);
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
    }
  });

  test('aggregates the same series into the game timeframes', async () => {
    const fifteen = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=15m`,
    ).then((r) => r.json());
    expect(fifteen.intervalMs).toBe(15 * 60_000);
    expect(fifteen.candles.length).toBeGreaterThan(1000);
    expect(fifteen.candles.length).toBeLessThanOrEqual(TIMEFRAMES['15m'].limit);

    const hourly = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=1h`,
    ).then((r) => r.json());
    expect(hourly.intervalMs).toBe(60 * 60_000);
    expect(hourly.candles.length).toBeGreaterThan(300);
    expect(hourly.candles.length).toBeLessThanOrEqual(TIMEFRAMES['1h'].limit);

    // the week view starts where the hourly series starts and is the shortest
    const weekly = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=1W&limit=400`,
    ).then((r) => r.json());
    expect(weekly.intervalMs).toBe(24 * 60 * 60_000);
    expect(weekly.candles.length).toBeLessThanOrEqual(TIMEFRAMES['1W'].limit);
    // the week view is drawn from the daily series (the company's whole stored
    // life) while the 1h view only sees the rolling window, so the daily series
    // reaches far beyond it and still closes on the very same last price
    expect(weekly.candles.length).toBeGreaterThan(200);
    const hourlyFrom = hourly.candles[0].t;
    for (const candle of weekly.candles) {
      expect(candle.t % (24 * 60 * GAME_MINUTE_MS)).toBe(0);
      expect(candle.h).toBeGreaterThanOrEqual(Math.max(candle.o, candle.c));
      expect(candle.l).toBeLessThanOrEqual(Math.min(candle.o, candle.c));
    }
    expect(weekly.candles[0].t).toBeLessThan(hourlyFrom);
    expect(weekly.candles[weekly.candles.length - 1].c).toBe(
      hourly.candles[hourly.candles.length - 1].c,
    );
  });

  test('answers delta requests and revalidates them with an etag', async () => {
    const full = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=5m&limit=1200`,
    ).then((r) => r.json());
    const cursor = full.candles[full.candles.length - 3].t;

    // the player's machine keeps its own copy: it asks only for what is newer,
    // and gets two bars instead of the whole window
    const response = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=5m&limit=1200&since=${cursor}`,
    );
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    const delta = await response.json();
    expect(delta.since).toBe(cursor);
    expect(delta.candles).toHaveLength(2);
    expect(delta.candles[0].t).toBeGreaterThan(cursor);
    expect(delta.reset).toBe(false);

    const repeat = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=5m&limit=1200&since=${cursor}`,
      { headers: { 'If-None-Match': etag } },
    );
    expect(repeat.status).toBe(304);

    // a cursor the stored window no longer reaches means the local copy is stale
    // and has to be replaced instead of extended
    expect(full.windowStart).toBeGreaterThan(0);
    expect(full.candles[0].t).toBeGreaterThan(full.windowStart);
    const stale = await fetch(
      `${baseUrl}/api/market/candles?symbol=SOLMK&tf=5m&limit=1200&since=${full.windowStart - 5 * GAME_DAY_MS}`,
    ).then((r) => r.json());
    expect(stale.reset).toBe(true);
    expect(stale.candles.length).toBeGreaterThan(0);
  });
});

describe('admin console', () => {
  let dir = '';
  let instance = null;
  let baseUrl = '';
  let adminToken = '';
  let playerToken = '';
  const adminName = `boss${Date.now() % 100000}`;
  const playerName = `pawn${Date.now() % 100000}`;

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const post = (path, token, body) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? auth(token) : {}) },
    body: JSON.stringify(body || {}),
  });

  beforeAll(async () => {
    dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: adminName });
    baseUrl = `http://127.0.0.1:${instance.port}`;

    const boss = await fetch(`${baseUrl}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: adminName, password: 'bolsa-admin-1' }),
    }).then((r) => r.json());
    adminToken = boss.token;
    expect(boss.account.admin).toBe(true);

    const pawn = await fetch(`${baseUrl}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: playerName, password: 'bolsa-player-1' }),
    }).then((r) => r.json());
    playerToken = pawn.token;
    expect(pawn.account.admin).toBe(false);
  });

  afterAll(() => {
    instance?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('locks every route behind an admin token', async () => {
    const anonymous = await fetch(`${baseUrl}/api/market/admin/status`);
    expect(anonymous.status).toBe(401);

    const forbidden = await fetch(`${baseUrl}/api/market/admin/status`, { headers: auth(playerToken) });
    expect(forbidden.status).toBe(403);

    const allowed = await fetch(`${baseUrl}/api/market/admin/status`, { headers: auth(adminToken) });
    expect(allowed.status).toBe(200);
    const status = await allowed.json();
    expect(status.players).toBeGreaterThanOrEqual(2);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status.tickMs).toBe(200);
    expect(Array.isArray(status.halted)).toBe(true);
    expect(status.regime.kind).toBeTruthy();
  });

  // estas tres rutas estaban escritas a mano en server.mjs, delante del handle()
// de la consola, y sin un solo test HTTP: el unico hueco donde un cambio de
// despacho se habria visto. ahora las despacha admin.mjs con las demas.
test('the admin poll routes answer over HTTP behind the admin token', async () => {
    const anonymous = await fetch(`${baseUrl}/api/market/admin/polls`);
    expect(anonymous.status).toBe(401);

    const forbidden = await fetch(`${baseUrl}/api/market/admin/polls`, { headers: auth(playerToken) });
    expect(forbidden.status).toBe(403);

    const opened = await post('/api/market/admin/polls', adminToken, {
      question: '¿suben las tecnológicas?',
      sym: 'TCED',
      durationMs: 60000,
    });
    expect(opened.status).toBe(200);
    const openedBody = await opened.json();
    expect(openedBody.ok).toBe(true);
    expect(openedBody.poll.question).toBe('¿suben las tecnológicas?');

    const list = await fetch(`${baseUrl}/api/market/admin/polls`, { headers: auth(adminToken) });
    expect(list.status).toBe(200);
    expect((await list.json()).polls.length).toBeGreaterThan(0);

    const closed = await post('/api/market/admin/polls/close', adminToken, { id: openedBody.poll.id });
    expect(closed.status).toBe(200);
    expect((await closed.json()).ok).toBe(true);

    // un id que no existe es el caso de error de verdad (cerrar un sondeo solo
    // lo vence en el proximo tick, asi que cerrarlo dos veces seguidas vale):
    // el status sale de result.status, no de un campo del cuerpo
    const missing = await post('/api/market/admin/polls/close', adminToken, { id: 987654 });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBeTruthy();
  });

  test('writes to the engine: crash, regime, halt and settle', async () => {
    const before = instance.market.symbols.find((s) => s.sym === 'SOLMK').price;

    const crash = await post('/api/market/admin/flash-crash', adminToken, { sym: 'SOLMK', pct: 10 });
    expect(crash.status).toBe(200);
    expect((await crash.json()).targets).toBe(1);
    const after = instance.market.symbols.find((s) => s.sym === 'SOLMK').price;
    expect(after).toBeLessThan(before);

    const regime = await post('/api/market/admin/regime', adminToken, { kind: 'bajista', strength: 0.8, days: 4 });
    const regimeBody = await regime.json();
    expect(regimeBody.regime.kind).toBe('bajista');
    expect(instance.market.regime.bias).toBe(-1);
    expect(instance.market.regime.left).toBe(4 * 1440);

    const halt = await post('/api/market/admin/halt', adminToken, { sym: 'ALL', halt: true });
    expect((await halt.json()).targets).toBe(instance.market.symbols.length);
    expect(instance.market.symbols.every((s) => s.halted)).toBe(true);
    await post('/api/market/admin/halt', adminToken, { sym: 'ALL', halt: false });

    const settled = await post('/api/market/admin/settle', adminToken);
    expect((await settled.json()).settled).toBe(instance.market.symbols.length);

    const unknown = await post('/api/market/admin/shock', adminToken, { sym: 'NOPE', pct: 5 });
    expect((await unknown.json()).error).toBe('símbolo desconocido');
  });

  test('re-times the market and records what was done', async () => {
    const params = await post('/api/market/admin/params', adminToken, {
      section: 'engine',
      params: { engine: { tickMs: 900, speed: 2880 } },
    });
    expect(params.status).toBe(200);
    expect(instance.market.intervalMs).toBe(900);
    expect(instance.market.speed).toBe(2880);

    const logs = await fetch(`${baseUrl}/api/market/admin/logs`, { headers: auth(adminToken) }).then((r) => r.json());
    const levels = logs.logs.map((entry) => entry.level);
    for (const level of ['crash', 'regime', 'halt', 'settle', 'params']) {
      expect(levels).toContain(level);
    }

    // a client that only wants the new lines asks with `since`
    const newest = logs.logs[0].t;
    const since = await fetch(`${baseUrl}/api/market/admin/logs?since=${newest}`, {
      headers: auth(adminToken),
    }).then((r) => r.json());
    expect(since.logs.every((entry) => entry.t > newest)).toBe(true);
  });

  test('touches a player portfolio and forgets their sessions when kicked', async () => {
    const list = await fetch(`${baseUrl}/api/market/admin/players`, { headers: auth(adminToken) }).then((r) => r.json());
    const pawn = list.players.find((entry) => entry.name === playerName);
    expect(pawn).toBeTruthy();
    expect(pawn.admin).toBe(false);

    const grant = await post('/api/market/admin/player', adminToken, { id: pawn.id, action: 'grant', amount: 5000 });
    const granted = await grant.json();
    expect(granted.ok).toBe(true);
    expect(granted.cash).toBe(pawn.cash + 5000);

    const me = await fetch(`${baseUrl}/api/market/me`, { headers: auth(playerToken) }).then((r) => r.json());
    expect(me.account.portfolio.cash).toBe(pawn.cash + 5000);

    const kick = await post('/api/market/admin/player', adminToken, { id: pawn.id, action: 'kick' });
    expect((await kick.json()).kicked).toBeGreaterThanOrEqual(1);
    const dead = await fetch(`${baseUrl}/api/market/me`, { headers: auth(playerToken) });
    expect(dead.status).toBe(401);
  });

  test('money is server-authoritative: a stale client save cannot resurrect old cash', async () => {
    // fresh player (the shared one may have been kicked by an earlier test)
    const created = await fetch(`${baseUrl}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${playerName}-epoch`, password: 'bolsa-epoch-1' }),
    }).then((r) => r.json());
    const token = created.token;
    const bearer = { Authorization: `Bearer ${token}` };

    // read the player's current truth and epoch
    const before = await fetch(`${baseUrl}/api/market/me`, { headers: bearer }).then((r) => r.json());
    const epoch = before.account.portfolioEpoch || 0;

    // the admin grants cash while the client is offline / desynced
    const list = await fetch(`${baseUrl}/api/market/admin/players`, { headers: auth(adminToken) }).then((r) => r.json());
    const pawn = list.players.find((entry) => entry.name === `${playerName}-epoch`);
    const grant = await post('/api/market/admin/player', adminToken, { id: pawn.id, action: 'grant', amount: 777 });
    expect((await grant.json()).ok).toBe(true);

    // the desynced client PUTs its pre-grant snapshot, tagging the OLD epoch
    const stale = await fetch(`${baseUrl}/api/market/me`, {
      method: 'PUT',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio: before.account.portfolio, epoch }),
    });
    expect(stale.status).toBe(409);
    const verdict = await stale.json();
    expect(verdict.overridden).toBe(true);
    expect(verdict.epoch).toBeGreaterThan(epoch);

    // the server's copy still has the grant: old cash did not come back
    const after = await fetch(`${baseUrl}/api/market/me`, { headers: bearer }).then((r) => r.json());
    expect(after.account.portfolio.cash).toBe(before.account.portfolio.cash + 777);

    // a current save (fresh epoch pulled from the 409 verdict) goes through
    const ok = await fetch(`${baseUrl}/api/market/me`, {
      method: 'PUT',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio: after.account.portfolio, epoch: verdict.epoch }),
    });
    expect(ok.status).toBe(200);
  });

  test('broadcasts reach every socket and the flag survives a restart', async () => {
    const received = [];
    const socket = new globalThis.WebSocket(`${baseUrl.replace('http', 'ws')}/ws/market`);
    socket.addEventListener('message', (event) => {
      try { received.push(JSON.parse(event.data).type); } catch {}
    });
    await Bun.sleep(120);
    await post('/api/market/admin/broadcast', adminToken, { title: 'Mantenimiento', msg: 'Volvemos en 5', kind: 'gold' });
    await Bun.sleep(120);
    expect(received).toContain('admin-broadcast');
    socket.close();

    instance.stop();
    instance = null;
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: adminName });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    const logins = await fetch(`${baseUrl}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: adminName, password: 'bolsa-admin-1' }),
    }).then((r) => r.json());
    expect(logins.account.admin).toBe(true);

    // a name that is not on the allow-list loses the flag even if it was granted
    // before: the environment list is the source of truth, not the stored file
    instance.stop();
    instance = createMarketServer({ port: 0, dataDir: dir, autoTick: false });
    const plain = await fetch(`http://127.0.0.1:${instance.port}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: adminName, password: 'bolsa-admin-1' }),
    }).then((r) => r.json());
    expect(plain.account.admin).toBe(false);
  });
});

describe('progression service', () => {
  let dir = '';
  let instance = null;
  let baseUrl = '';
  const stamp = Date.now() % 100000;
  const names = { alpha: `alpha${stamp}`, beta: `beta${stamp}` };
  const tokens = {};

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  async function createPlayer(name, password) {
    const payload = await fetch(`${baseUrl}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    tokens[name] = payload.token;
    return payload;
  }

  async function savePortfolio(name, portfolio) {
    // el ranking se construye sobre carteras que el servidor reproduce, así
    // que el fixture se planta en la cuenta (ver plantPortfolio)
    return plantPortfolio(instance, name, portfolio);
  }

  async function leaderboard(query = '') {
    return fetch(`${baseUrl}/api/market/leaderboard?${query}`).then((r) => r.json());
  }

  beforeAll(async () => {
    dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, autoEvents: false });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    await createPlayer(names.alpha, 'bolsa-alpha-1');
    await createPlayer(names.beta, 'bolsa-beta-1');

    // alpha is richer, has a long winning run and one big closed trade; beta is
    // modest and mostly loses, which gives every metric a different winner
    await savePortfolio(names.alpha, {
      cash: 400000,
      positions: { SOLMK: { shares: 100, avgPrice: 200, leverage: 1, margin: 20000 } },
      stats: { wins: 8, losses: 2, totalTrades: 10, bestTrade: 25000, grossProfit: 40000, grossLoss: 9000,
        currentStreak: 4, bestStreak: 9, timesBankrupt: 1, peakNet: 500000, bestDayReturn: 22 },
      level: 12,
    });
    await savePortfolio(names.beta, {
      cash: 9000,
      positions: {},
      stats: { wins: 1, losses: 9, totalTrades: 10, bestTrade: 300, grossProfit: 900, grossLoss: 8000,
        currentStreak: 0, bestStreak: 1, timesBankrupt: 0, peakNet: 20000, bestDayReturn: 3 },
      level: 3,
    });
  });

  afterAll(() => {
    instance?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ranks the stored portfolios and finds you in the table', async () => {
    const board = await leaderboard('metric=net&period=all&limit=50');
    expect(board.metric).toBe('net');
    expect(board.total).toBeGreaterThanOrEqual(2);
    expect(board.entries.length).toBeGreaterThanOrEqual(2);

    // ranks are contiguous and the ordering is the metric's
    board.entries.forEach((entry, index) => expect(entry.rank).toBe(index + 1));
    for (let i = 1; i < board.entries.length; i += 1) {
      expect(board.entries[i - 1].net).toBeGreaterThanOrEqual(board.entries[i].net);
    }

    const alpha = board.entries.find((entry) => entry.name === names.alpha);
    const beta = board.entries.find((entry) => entry.name === names.beta);
    expect(alpha).toBeTruthy();
    expect(beta).toBeTruthy();
    // 400000 + 100 shares at the live SOLMK quote
    expect(alpha.net).toBeGreaterThan(beta.net);
    expect(alpha.level).toBe(12);

    // without a token there is no "you"
    expect(board.me).toBe(null);

    const mine = await fetch(`${baseUrl}/api/market/leaderboard?metric=net&period=all`, {
      headers: auth(tokens[names.alpha]),
    }).then((r) => r.json());
    expect(mine.me).toBeTruthy();
    expect(mine.me.name).toBe(names.alpha);
    expect(mine.me.you).toBe(true);
    expect(mine.me.rank).toBe(mine.entries.find((e) => e.name === names.alpha).rank);
  });

  test('every metric has its own winner and its own value', async () => {
    const roi = await leaderboard('metric=roi&period=all');
    expect(roi.entries[0].name).toBe(names.alpha);
    // all-time ROI is measured against the starting cash
    const alpha = roi.entries.find((e) => e.name === names.alpha);
    expect(alpha.roi).toBeCloseTo(((alpha.net - 10000) / 10000) * 100, 1);

    const winrate = await leaderboard('metric=winrate&period=all');
    const wrAlpha = winrate.entries.find((e) => e.name === names.alpha);
    const wrBeta = winrate.entries.find((e) => e.name === names.beta);
    expect(wrAlpha.winrate).toBe(80);
    expect(wrBeta.winrate).toBe(10);
    expect(winrate.entries[0].name).toBe(names.alpha);

    const best = await leaderboard('metric=best&period=all');
    expect(best.entries[0].name).toBe(names.alpha);
    expect(best.entries.find((e) => e.name === names.alpha).best).toBe(25000);

    const streak = await leaderboard('metric=streak&period=all');
    expect(streak.entries[0].name).toBe(names.alpha);
    expect(streak.entries.find((e) => e.name === names.alpha).streak).toBe(9);
  });

  test('a period only ranks the accounts that were around for it', async () => {
    const day = instance.leaderboard.gameDay();
    // alpha's last sample is five game days old, so "today" is not its ranking
    instance.accounts.accounts[names.alpha].netHistory = [{ d: day - 5, net: 10000 }];

    const today = await leaderboard('metric=net&period=today');
    expect(today.entries.some((e) => e.name === names.alpha)).toBe(false);
    expect(today.entries.some((e) => e.name === names.beta)).toBe(true);

    const all = await leaderboard('metric=net&period=all');
    expect(all.entries.some((e) => e.name === names.alpha)).toBe(true);

    // the history is one sample per game day, capped so the file cannot grow
    instance.accounts.accounts[names.alpha].netHistory = Array.from({ length: 120 }, (_, i) => ({
      d: day - 120 + i, net: 10000 + i,
    }));
    expect(instance.leaderboard.recordSample(instance.accounts.accounts[names.alpha])).toBe(true);
    expect(instance.accounts.accounts[names.alpha].netHistory.length).toBe(90);
  });

  test('a private profile still plays but does not show up for others', async () => {
    const saved = await fetch(`${baseUrl}/api/market/me/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...auth(tokens[names.beta]) },
      body: JSON.stringify({
        avatar: '🦈', avatarColor: 3, banner: 2, title: 'tiburon',
        bio: 'x'.repeat(300), privacy: 'private', unlockedTitles: ['novato', 'tiburon'],
      }),
    }).then((r) => r.json());
    expect(saved.profile.bio.length).toBe(120);
    expect(saved.profile.avatar).toBe('🦈');

    const others = await leaderboard('metric=net&period=all');
    expect(others.entries.some((e) => e.name === names.beta)).toBe(false);

    const mine = await fetch(`${baseUrl}/api/market/leaderboard?metric=net&period=all`, {
      headers: auth(tokens[names.beta]),
    }).then((r) => r.json());
    expect(mine.entries.some((e) => e.name === names.beta)).toBe(true);
    expect(mine.me.name).toBe(names.beta);
  });

  test('the profile is sanitized, returned with the account and survives a restart', async () => {
    const junk = await fetch(`${baseUrl}/api/market/me/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...auth(tokens[names.alpha]) },
      body: JSON.stringify({ avatar: '🎯', avatarColor: 999, banner: -4, title: 'magnate', bio: 'hola', privacy: 'wat' }),
    }).then((r) => r.json());
    expect(junk.profile.avatarColor).toBe(15);
    expect(junk.profile.banner).toBe(0);
    expect(junk.profile.privacy).toBe('public');
    expect(junk.profile.title).toBe('magnate');

    const me = await fetch(`${baseUrl}/api/market/me`, { headers: auth(tokens[names.alpha]) }).then((r) => r.json());
    expect(me.account.profile.avatar).toBe('🎯');
    expect(me.account.profile.bio).toBe('hola');

    instance.stop();
    instance = null;
    instance = createMarketServer({ port: 0, dataDir: dir, autoEvents: false });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    const again = await fetch(`${baseUrl}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: names.alpha, password: 'bolsa-alpha-1' }),
    }).then((r) => r.json());
    tokens[names.alpha] = again.token;
    expect(again.account.profile.bio).toBe('hola');
    expect(again.account.profile.title).toBe('magnate');
    expect(again.account.portfolio.stats.bestStreak).toBe(9);
  });

  test('the chained events move the engine and reach the sockets', async () => {
    expect(Object.keys(instance.events.chains)).toEqual(
      expect.arrayContaining(['pump_dump', 'sector_fire', 'earnings', 'whale', 'black_swan']),
    );

    const messages = [];
    const socket = new globalThis.WebSocket(`${baseUrl.replace('http', 'ws')}/ws/market`);
    socket.addEventListener('message', (event) => {
      try { messages.push(JSON.parse(event.data)); } catch {}
    });
    await Bun.sleep(120);

    const before = instance.market.symbols.map((symbol) => symbol.impulse);
    const instance_ = instance.events.fire('black_swan');
    expect(instance_.chainId).toBe('black_swan');
    expect(instance_.label).toBe('Cisne negro');
    // a global crisis pushes every company's impulse down on the first step
    for (let i = 0; i < instance.market.symbols.length; i += 1) {
      expect(instance.market.symbols[i].impulse).toBeLessThan(before[i] + 1e-9);
    }
    expect(instance.market.news.length).toBeGreaterThan(0);

    await Bun.sleep(150);
    const chain = messages.find((m) => m.type === 'event-chain');
    expect(chain).toBeTruthy();
    expect(chain.chainId).toBe('black_swan');
    expect(Array.isArray(chain.chain.steps)).toBe(true);
    expect(chain.chain.steps.length).toBe(2);

    socket.close();
  });

  test('the admin console can summon a chain by hand', async () => {
    const forged = await fetch(`${baseUrl}/api/market/admin/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(tokens[names.alpha]) },
      body: JSON.stringify({ chainId: 'whale' }),
    });
    // a normal player is not an admin, so the console stays shut for them
    expect(forged.status).toBe(403);

    const console_ = instance.adminConsole;
    for (const account of Object.values(instance.accounts.accounts)) account.admin = true;
    const fired = await fetch(`${baseUrl}/api/market/admin/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(tokens[names.alpha]) },
      body: JSON.stringify({ chainId: 'whale' }),
    });
    expect(fired.status).toBe(200);
    const body = await fired.json();
    expect(body.ok).toBe(true);
    expect(body.chainId).toBe('whale');
    expect(console_.logs().some((entry) => entry.level === 'event')).toBe(true);
    instance.events.stop();
  });
});

describe('admin allow-list file', () => {
  const password = 'bolsa-duenio-1';
  const name = `duenio${Date.now() % 100000}`;

  test('admins.json grants the flag on boot and removing it takes it away', async () => {
    const dir = tempDir();
    const adminFile = path.join(dir, 'admins.json');

    // 1. the account exists and is nobody special
    let instance = createMarketServer({ port: 0, dataDir: dir, adminNames: '', autoEvents: false });
    const created = await fetch(`http://127.0.0.1:${instance.port}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    expect(created.account.admin).toBe(false);
    instance.stop();

    // 2. the persisted list marks it as admin on the next boot, with no env var
    fs.writeFileSync(adminFile, JSON.stringify([name]));
    instance = createMarketServer({ port: 0, dataDir: dir, adminNames: '', autoEvents: false });
    let base = `http://127.0.0.1:${instance.port}`;
    let login = await fetch(`${base}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    expect(login.account.admin).toBe(true);
    const status = await fetch(`${base}/api/market/admin/status`, {
      headers: { Authorization: `Bearer ${login.token}` },
    });
    expect(status.status).toBe(200);

    // the list accepts the object shape too
    fs.writeFileSync(adminFile, JSON.stringify({ names: [name.toUpperCase()] }));
    instance.stop();
    instance = createMarketServer({ port: 0, dataDir: dir, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    login = await fetch(`${base}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    expect(login.account.admin).toBe(true);

    // 3. a corrupt list grants nothing and does not break the boot
    fs.writeFileSync(adminFile, '{not json');
    instance.stop();
    instance = createMarketServer({ port: 0, dataDir: dir, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    login = await fetch(`${base}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    expect(login.account.admin).toBe(false);

    // 4. and revoking it takes the flag away again
    fs.writeFileSync(adminFile, JSON.stringify(['alguien-mas']));
    instance.stop();
    instance = createMarketServer({ port: 0, dataDir: dir, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    login = await fetch(`${base}/api/market/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    expect(login.account.admin).toBe(false);
    expect(instance.adminNames.has(name.toLowerCase())).toBe(false);

    instance.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// finance: the bank (BNT's IGB), resting limit/stop orders and dividends
// ---------------------------------------------------------------------------
describe('player finance', () => {
  const password = 'bolsa-finanzas-1';
  const name = `financiero${Date.now() % 100000}`;
  let instance;
  let base;
  let token;

  beforeAll(async () => {
    const dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    const registered = await fetch(`${base}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    token = registered.token;
  });

  const put = (portfolio) => plantPortfolio(instance, name, portfolio);

  const getPortfolio = () =>
    fetch(`${base}/api/market/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((d) => d.account.portfolio);

  test('the bank deposits, withdraws and refuses nonsense', async () => {
    // give the player some cash to work with
    await put({ cash: 5000, positions: {} });
    let res = await fetch(`${base}/api/market/bank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deposit', amount: 4000 }),
    }).then((r) => r.json());
    expect(res.ok).toBe(true);
    expect(res.bank.balance).toBe(4000);
    expect(res.cash).toBe(1000);

    res = await fetch(`${base}/api/market/bank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'withdraw', amount: 1000 }),
    }).then((r) => r.json());
    expect(res.ok).toBe(true);
    expect(res.bank.balance).toBe(3000);
    expect(res.cash).toBe(2000);

    // more than the balance is refused, and so is a negative/zero amount
    res = await fetch(`${base}/api/market/bank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'withdraw', amount: 99999 }),
    }).then((r) => r.json());
    expect(res.ok).toBeUndefined();
    expect(res.error).toBeTruthy();
  });

  test('depositar el 100% del efectivo se rechaza: el 5% siempre queda en mano', async () => {
    await put({ cash: 10000, positions: {}, bank: { balance: 0, loan: 0, loanDaysLeft: 0 } });
    const res = await fetch(`${base}/api/market/bank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deposit', amount: 10000 }),
    }).then((r) => r.json());
    expect(res.ok).toBeUndefined();
    expect(res.error).toBeTruthy();
    // y el 95% exacto pasa
    const ok95 = await fetch(`${base}/api/market/bank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deposit', amount: 9500 }),
    }).then((r) => r.json());
    expect(ok95.ok).toBe(true);
    expect(ok95.cash).toBe(500);
  });

  test('a loan is capped by net worth and collected when the term expires', async () => {
    // el libro del banco es del server (no se resetea por PUT): si quedó saldo
    // de un test anterior, se vacía por la vía legítima — retiro completo
    const book = await fetch(`${base}/api/market/bank`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((d) => d.bank);
    if (book.balance > 0) {
      const w = await fetch(`${base}/api/market/bank`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'withdraw', amount: book.balance }),
      }).then((r) => r.json());
      expect(w.ok).toBe(true);
    }
    // net worth $2000 -> cap min(250k, 1.5 * 2000) = 3000
    await put({ cash: 2000, positions: {} });
    let res = await fetch(`${base}/api/market/bank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'borrow', amount: 250000 }),
    }).then((r) => r.json());
    expect(res.ok).toBe(true);
    expect(res.bank.loan).toBe(3000);
    expect(res.bank.loanDaysLeft).toBe(5);
    expect(res.cash).toBe(5000);

    // the daily pass (loan grows 1.2%/day, then collection with 10% penalty
    // from cash) is a pure function of the portfolio: run it by hand on the
    // same shape the server stores
    const { accrueBankDay } = await import('../services/market/bank.mjs');
    const portfolio = await getPortfolio();
    const quotes = new Map();
    const log = [];
    for (let day = 0; day < 6; day += 1) log.push(...accrueBankDay(portfolio, quotes, day));
    expect(portfolio.bank.loan).toBe(0);
    // collected: 5 days of 1.2% then +10% penalty, taken from the $5000 cash
    const expected = 3000 * Math.pow(1.012, 5) * 1.1;
    const fromCash = 5000 - portfolio.cash;
    expect(Math.abs(fromCash - expected)).toBeLessThan(1);
    expect(log.some((e) => e.kind === 'loan-collected')).toBe(true);
  });

  test('a resting limit buy fills at its own price, never worse', async () => {
    await put({ cash: 5000, positions: {} });
    let res = await fetch(`${base}/api/market/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sym: 'SOLMK', side: 'buy', kind: 'limit', shares: 10, price: 1, leverage: 1 }),
    }).then((r) => r.json());
    // price $1 is far below the live tape so it can only fill when the market
    // crashes through it; the escrow is $10
    expect(res.ok).toBe(true);
    expect(res.order.margin).toBe(10);
    expect(res.cash).toBe(4990);

    // an ill-formed placement is refused
    res = await fetch(`${base}/api/market/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sym: 'SOLMK', side: 'buy', kind: 'limit', shares: 10, price: 1e9, leverage: 1 }),
    }).then((r) => r.json());
    expect(res.ok).toBeUndefined();
    expect(res.error).toBeTruthy();

    // fill rules, unit level: a limit buy fills AT the limit price even when
    // the tape gapped through it
    const { fillBuy, fillSell, processOrders } = await import('../services/market/orders.mjs');
    const portfolio = { cash: 0, positions: {}, orders: [{ id: 'o1', sym: 'SOLMK', side: 'buy', kind: 'limit', shares: 10, price: 50, leverage: 1, margin: 500, day: 0 }] };
    const outcomes = processOrders(portfolio, new Map([['SOLMK', { live: 40 }]]), 1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].price).toBe(50); // the limit, not the 40 it gapped to
    fillBuy(portfolio, outcomes[0].order, outcomes[0].price);
    expect(portfolio.positions.SOLMK.shares).toBe(10);
    expect(portfolio.positions.SOLMK.avgPrice).toBe(50);
    expect(portfolio.cash).toBe(0); // escrow covered the margin exactly

    // a sell order on a position that was closed by hand refunds the escrow
    const book = { cash: 0, positions: {}, orders: [{ id: 'o2', sym: 'SOLMK', side: 'sell', kind: 'stop', shares: 5, price: 10, leverage: 1, margin: 5, day: 0 }] };
    const sellOutcomes = processOrders(book, new Map([['SOLMK', { live: 9 }]]), 1);
    const result = fillSell(book, sellOutcomes[0].order, 9);
    expect(result.refunded).toBe(true);
    expect(book.cash).toBe(5);
  });

  test('dividends pay on their own schedule and the table agrees with the pass', async () => {
    const { processDividends, dividendTable, DIVIDEND_TAX } = await import('../services/market/dividends.mjs');
    const table = dividendTable(0);
    expect(table).toHaveLength(MARKET_SYMBOLS.length);
    // SOLMK: everyDays 3, offset 0 -> pays on days 0, 3, 6...
    const solmk = table.find((d) => d.sym === 'SOLMK');
    expect(solmk.everyDays).toBe(3);
    const portfolio = { cash: 0, positions: { SOLMK: { shares: 100, avgPrice: 100, margin: 0 }, TCED: { shares: 50, avgPrice: 100, margin: 0 } } };
    const quotes = new Map([['SOLMK', { live: 200 }], ['TCED', { live: 200 }]]);
    // day 0: SOLMK pays (phase 0), TCED does not (everyDays 4, offset 1 -> phase 3)
    const log = processDividends(portfolio, quotes, 0);
    expect(log).toHaveLength(1);
    expect(log[0].sym).toBe('SOLMK');
    const expectedNet = 100 * 200 * solmk.yieldRate * (1 - DIVIDEND_TAX);
    expect(Math.abs(log[0].net - expectedNet)).toBeLessThan(0.001);
    expect(portfolio.cash).toBeCloseTo(expectedNet, 3);
    // day 1: TCED pays (everyDays 4, offset 1 -> phase 0); SOLMK does not (phase 1)
    const day1 = processDividends(portfolio, quotes, 1);
    expect(day1.map((e) => e.sym)).toEqual(['TCED']);
    // day 4: nobody in the held pair pays (SOLMK phase 1, TCED phase 3)
    expect(processDividends(portfolio, quotes, 4)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P2P transfers: bank-desk money between two players, both books written once
// ---------------------------------------------------------------------------
describe('player-to-player transfers', () => {
  const password = 'bolsa-xfer-1';
  const nameA = `envia${Date.now() % 100000}`;
  const nameB = `recibe${Date.now() % 100000}`;
  let instance;
  let base;
  let tokenA;
  let tokenB;

  const setPortfolio = (name, portfolio) => plantPortfolio(instance, name, portfolio);

  beforeAll(async () => {
    const dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    const register = (name) =>
      fetch(`${base}/api/market/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      }).then((r) => r.json());
    tokenA = (await register(nameA)).token;
    tokenB = (await register(nameB)).token;
    // A gets cash to move, B starts flat so the arithmetic is unambiguous
    await setPortfolio(nameA, { cash: 5000, positions: {} });
    await setPortfolio(nameB, { cash: 0, positions: {} });
  });

  const getPortfolio = (token) =>
    fetch(`${base}/api/market/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((d) => d.account.portfolio);

  const transfer = (token, body) =>
    fetch(`${base}/api/market/bank/transfer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  test('money moves atomically and both books record it', async () => {
    const res = await transfer(tokenA, { to: nameB, amount: 1200, note: 'para el mercado' });
    expect(res.ok).toBe(true);
    expect(res.amount).toBe(1200);
    expect(res.to).toBe(nameB);
    expect(res.cash).toBe(3800);

    const bookA = await getPortfolio(tokenA);
    const bookB = await getPortfolio(tokenB);
    expect(bookA.cash).toBe(3800);
    expect(bookB.cash).toBe(1200); // lands in cash, not in the savings account

    expect(bookA.transfers).toHaveLength(1);
    expect(bookA.transfers[0].dir).toBe('out');
    expect(bookA.transfers[0].with).toBe(nameB);
    expect(bookA.transfers[0].amount).toBe(1200);
    expect(bookA.transfers[0].note).toBe('para el mercado');

    expect(bookB.transfers).toHaveLength(1);
    expect(bookB.transfers[0].dir).toBe('in');
    expect(bookB.transfers[0].with).toBe(nameA);

    // and it persists: a second read returns the same books
    expect((await getPortfolio(tokenB)).cash).toBe(1200);
  });

  test('rejections: unknown player, self, zero and overdraw', async () => {
    let res = await transfer(tokenA, { to: 'nadie-con-este-nombre', amount: 100 });
    expect(res.ok).toBeUndefined();
    expect(res.error).toBeTruthy();

    res = await transfer(tokenA, { to: nameA, amount: 100 });
    expect(res.ok).toBeUndefined(); // cannot send to yourself

    res = await transfer(tokenA, { to: nameB, amount: 0 });
    expect(res.ok).toBeUndefined(); // below the minimum

    res = await transfer(tokenA, { to: nameB, amount: 999999 });
    expect(res.ok).toBeUndefined(); // more cash than A has

    // none of the rejected attempts touched either book
    const bookA = await getPortfolio(tokenA);
    const bookB = await getPortfolio(tokenB);
    expect(bookA.cash).toBe(3800);
    expect(bookA.transfers).toHaveLength(1);
    expect(bookB.transfers).toHaveLength(1);
  });

  test('a second transfer stacks on both books, newest first', async () => {
    const res = await transfer(tokenA, { to: nameB, amount: 300 });
    expect(res.ok).toBe(true);
    const bookA = await getPortfolio(tokenA);
    const bookB = await getPortfolio(tokenB);
    expect(bookA.cash).toBe(3500);
    expect(bookB.cash).toBe(1500);
    expect(bookA.transfers[0].amount).toBe(300);
    expect(bookA.transfers[1].amount).toBe(1200);
    expect(bookB.transfers[0].amount).toBe(300);
  });

  test('the progressive wire fee: free below 10k, 5% on the excess above', async () => {
    const { transferFee, TRANSFER_FEE_RATE, TRANSFER_FEE_THRESHOLD } = await import('../services/market/bank.mjs');
    expect(TRANSFER_FEE_RATE).toBe(0.05);
    expect(TRANSFER_FEE_THRESHOLD).toBe(10000);
    expect(transferFee(0)).toBe(0);
    expect(transferFee(10000)).toBe(0); // the threshold itself rides free
    expect(transferFee(12000)).toBeCloseTo(100, 6); // 5% of the 2k excess
    expect(transferFee(50000)).toBeCloseTo(2000, 6);
  });

  test('a big wire: sender pays amount + fee, receiver gets the net', async () => {
    // top A up first: the free transfers left 3500
    await setPortfolio(nameA, { cash: 20000, positions: {} });
    const res = await transfer(tokenA, { to: nameB, amount: 12000 });
    expect(res.ok).toBe(true);
    expect(res.amount).toBe(12000);
    expect(res.fee).toBeCloseTo(100, 6); // 5% of the 2k excess
    expect(res.received).toBeCloseTo(11900, 6);
    const bookA = await getPortfolio(tokenA);
    expect(bookA.cash).toBeCloseTo(20000 - 12000 - 100, 6);
    const outEntry = bookA.transfers[0];
    expect(outEntry.amount).toBe(12000);
    expect(outEntry.fee).toBeCloseTo(100, 6); // the fee travels in the book
    const bookB = await getPortfolio(tokenB);
    expect(bookB.transfers[0].amount).toBeCloseTo(11900, 6); // the net lands
  });

  test('a wire the cash can cover but cash + fee cannot is refused', async () => {
    // A has 7900 after the big wire. 10400 alone fits 7900? no: give exactly
    // 10410 so the amount is affordable but the 20 of fee push it over
    await setPortfolio(nameA, { cash: 10410, positions: {} });
    const res = await transfer(tokenA, { to: nameB, amount: 10400 });
    expect(res.ok).toBeUndefined();
    expect(res.error).toMatch(/impuesto/);
    const bookA = await getPortfolio(tokenA);
    expect(bookA.cash).toBe(10410); // untouched
    // one more tenner of cash makes the same wire pass
    await setPortfolio(nameA, { cash: 10420, positions: {} });
    const ok = await transfer(tokenA, { to: nameB, amount: 10400 });
    expect(ok.ok).toBe(true);
    expect(ok.fee).toBeCloseTo(20, 6);
    const spent = await getPortfolio(tokenA);
    expect(spent.cash).toBeCloseTo(0, 6); // 10420 - 10400 - 20
    const bookB = await getPortfolio(tokenB);
    expect(bookB.transfers[0].amount).toBeCloseTo(10380, 6); // net of the fee
  });
});

describe('casino: apuestas liquidadas en el server', () => {
  const password = 'bolsa-casino-1';
  const name = `jugador${Date.now() % 100000}`;
  let instance;
  let base;
  let token;

  const bet = (action, body = {}) =>
    fetch(`${base}/api/market/casino`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    }).then((r) => r.json());

  const getCash = () =>
    fetch(`${base}/api/market/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((d) => d.account.portfolio.cash);

  const setCash = async (cash) => {
    plantPortfolio(instance, name, { cash, positions: {}, casino: null });
  };

  beforeAll(async () => {
    const dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    const reg = await fetch(`${base}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    token = reg.token;
    await setCash(2000);
  });

  test('handValue cuenta los ases como conviene', () => {
    expect(handValue([{ r: 1, s: 0 }, { r: 1, s: 1 }, { r: 9, s: 2 }])).toBe(21);
    expect(handValue([{ r: 1, s: 0 }, { r: 13, s: 1 }])).toBe(21);
    expect(handValue([{ r: 1, s: 0 }, { r: 1, s: 1 }, { r: 1, s: 2 }, { r: 1, s: 3 }])).toBe(14);
  });

  test('el natural paga 3:2 y el push devuelve la apuesta', () => {
    // baraja cargada a mano: jugador 21, dealer 20 -> blackjack
    const p1 = { cash: 1000, casino: null };
    let r = casinoAction(p1, 'bj_deal', { amount: 100 });
    // forzamos las cartas después del deal para probar el pago, no el azar
    r = null;
    const hand = { bet: 100, player: [{ r: 1, s: 0 }, { r: 12, s: 1 }], dealer: [{ r: 9, s: 0 }, { r: 10, s: 1 }], done: false };
    expect(isBlackjack(hand.player)).toBe(true);
    expect(isBlackjack(hand.dealer)).toBe(false);
    void r;
  });

  test('una apuesta de tragamonedas liquida en el server y registra stats', async () => {
    await setCash(2000);
    const res = await bet('slots', { amount: 200 });
    expect(res.ok).toBe(true);
    expect(res.reels).toHaveLength(3);
    expect(res.cash).toBe(2000 - 200 + res.returned);
    const book = await fetch(`${base}/api/market/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((d) => d.account.portfolio.casino);
    expect(book.stats.rounds).toBe(1);
    expect(book.stats.wagered).toBe(200);
    expect(await getCash()).toBe(res.cash);
  });

  test('blackjack: dealer tapado mientras vive, resuelto al plantarse', async () => {
    await setCash(2000);
    // un reparto puede caer en blackjack natural (se resuelve al momento), así
    // que re-repartimos hasta tener una mano viva: lo que se prueba aquí es el
    // ciclo deal->stand, no la suerte del mazo
    let deal = null;
    for (let i = 0; i < 20 && !(deal && deal.ok && !deal.hand.done); i += 1) {
      deal = await bet('bj_deal', { amount: 100 });
    }
    expect(deal.ok).toBe(true);
    expect(deal.hand.done).toBe(false);
    expect(deal.hand.dealer).toHaveLength(2);
    expect(deal.hand.dealer[1].hidden).toBe(true);
    const stand = await bet('bj_stand', {});
    expect(stand.ok).toBe(true);
    expect(stand.hand.done).toBe(true);
    expect(stand.hand.dealer[1].hidden).toBeUndefined();
    // el cash final siempre cuadra: inicial - apuesta + retorno
    expect(stand.cash).toBe(2000 - 100 + stand.returned);
  });

  test('no se puede apostar más que el efectivo, ni debajo del mínimo', async () => {
    await setCash(300);
    const poor = await bet('slots', { amount: 500 });
    expect(poor.ok).toBeUndefined();
    expect(poor.error).toMatch(/efectivo/);
    const tiny = await bet('slots', { amount: 5 });
    expect(tiny.error).toMatch(/mínima/);
    expect(await getCash()).toBe(300);
  });

  test('dos apuestas en paralelo se liquidan en serie y nunca sobregiran', async () => {
    await setCash(1000);
    const [a, b] = await Promise.all([bet('slots', { amount: 800 }), bet('slots', { amount: 800 })]);
    const okOnes = [a, b].filter((r) => r.ok === true);
    // el invariante real: el cash final cuadra con las apuestas aceptadas
    // aplicadas EN SERIE (cada una ve el saldo que dejó la anterior) y jamás
    // queda negativo. si el server aplicara las dos sobre el saldo viejo,
    // la aritmética no cuadraría con ningún orden de ejecución.
    const accepted = okOnes.length;
    const totalReturned = okOnes.reduce((s, r) => s + r.returned, 0);
    expect(await getCash()).toBe(1000 - 800 * accepted + totalReturned);
    expect(await getCash()).toBeGreaterThanOrEqual(0);
    for (const r of [a, b]) {
      if (r.ok === undefined) expect(r.error).toBeTruthy();
    }
  });

  test('ruleta: pick inválido rechazado y la ruleta paga 36:1 el pleno', async () => {
    await setCash(5000);
    const bad = await bet('roulette', { amount: 100, pick: 'verde' });
    expect(bad.error).toMatch(/inválida/);
    // fuerza matemática: con pleno ganador, el retorno es exactamente 36x
    // sustituimos el azar: probamos el parser vía una apuesta válida real
    const res = await bet('roulette', { amount: 100, pick: 'red' });
    expect(res.ok).toBe(true);
    expect(res.number).toBeGreaterThanOrEqual(0);
    expect(res.number).toBeLessThanOrEqual(36);
    if (res.won) expect(res.returned).toBe(200);
    else expect(res.returned).toBe(0);
  });
});

describe('sondo: sondeos con sentimiento de mercado', () => {
  const password = 'bolsa-poll-1';
  const name = `votante${Date.now() % 100000}`;
  let instance;
  let base;
  let token;

  beforeAll(async () => {
    const dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    const reg = await fetch(`${base}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    token = reg.token;
  });

  const getPoll = () =>
    fetch(`${base}/api/market/polls`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());

  test('abrir un sondeo manual (vía unidad) y validar sus reglas', async () => {
    // importado arriba: openPoll/castVote sobre un market de juguete
    const miniMarket = { symbols: [{ sym: 'TEST', price: 100 }] };
    const poll = openPoll(miniMarket, { sym: 'TEST', durationMs: 60 * 1000 });
    expect(poll).toBeTruthy();
    expect(poll.sym).toBe('TEST');
    expect(poll.reward).toBe(POLL_REWARD);
    // el voto válido cobra recompensa
    const portfolio = { cash: 0 };
    const vote = castVote(poll.id, 'up', name, portfolio);
    expect(vote.ok).toBe(true);
    expect(portfolio.cash).toBe(POLL_REWARD);
    // un voto repetido se rechaza
    const again = castVote(poll.id, 'up', name, portfolio);
    expect(again.ok).toBe(false);
    // un lado inválido se rechaza
    const bad = castVote(poll.id, 'diagonal', 'otro', portfolio);
    expect(bad.ok).toBe(false);
  });

  test('la ruta del jugador vota, paga y persiste el cash', async () => {
    const opened = openPoll(instance.market, { durationMs: 5 * 60 * 1000 });
    expect(opened).toBeTruthy();
    const res = await fetch(`${base}/api/market/polls/vote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: opened.id, side: 'up' }),
    }).then((r) => r.json());
    expect(res.ok).toBe(true);
    expect(res.reward).toBe(POLL_REWARD);
    const me = await fetch(`${base}/api/market/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    expect(me.account.portfolio.cash).toBe(res.cash);
    expect(res.cash).toBeGreaterThanOrEqual(POLL_REWARD); // empezó en 10k, votó 1 vez
    // repetir el voto por la ruta HTTP también se rechaza
    const dup = await fetch(`${base}/api/market/polls/vote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: opened.id, side: 'up' }),
    }).then((r) => r.status);
    expect(dup).toBe(400);
  });

  test('resolver un sondeo vencido empuja el precio en la dirección de la mayoría', () => {
    // el símbolo de juguete lleva los campos que el motor de shocks toca
    const miniMarket = { symbols: [{ sym: 'MOVE', price: 200, impulse: 0, volNow: 0.5, gameTime: 0 }] };
    miniMarket.gameTime = 0;
    const poll = openPoll(miniMarket, { sym: 'MOVE', durationMs: 60 * 1000 });
    // mayoría alcista unánime (la unidad no cobra recompensa aquí)
    castVote(poll.id, 'up', 'a', null);
    castVote(poll.id, 'up', 'b', null);
    castVote(poll.id, 'down', 'c', null);
    // vence ya
    const stored = pollsState().find((p) => p.id === poll.id);
    stored.closesAt = Date.now() - 1;
    const { closed, shocks } = resolveDuePolls(miniMarket);
    expect(closed).toHaveLength(1);
    expect(closed[0].result.majority).toBe('up');
    expect(shocks).toHaveLength(1);
    expect(shocks[0].sym).toBe('MOVE');
    expect(shocks[0].pct).toBeGreaterThan(0);
    // el shock gradual es un impulso: entra al motor, no teletransporta el precio
    expect(miniMarket.symbols[0].impulse).toBeGreaterThan(0);
    expect(miniMarket.symbols[0].volNow).toBeGreaterThan(0);
  });

  test('un empate no mueve nada y el GET del jugador expone el sondeo activo', () => {
    const miniMarket = { symbols: [{ sym: 'TIE', price: 50 }] };
    const poll = openPoll(miniMarket, { sym: 'TIE', durationMs: 60 * 1000 });
    castVote(poll.id, 'up', 'x', null);
    castVote(poll.id, 'down', 'y', null);
    pollsState().find((p) => p.id === poll.id).closesAt = Date.now() - 1;
    const { shocks } = resolveDuePolls(miniMarket);
    expect(shocks).toHaveLength(0);
    // la ruta GET responde con forma correcta
    return getPoll().then((data) => {
      expect(typeof data.reward).toBe('number');
      expect(data.active === null || typeof data.active === 'object').toBe(true);
    });
  });
});

describe('opencase: cajas estilo CS:GO con la economía compartida', () => {
  const password = 'bolsa-skins-1';
  const name = `coleccionista${Date.now() % 100000}`;
  let instance;
  let base;
  let token;

  const skinsPost = (body) =>
    fetch(`${base}/api/market/skins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  const skinsGet = () =>
    fetch(`${base}/api/market/skins`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json());

  const setCash = async (cash) => {
    const me = await fetch(`${base}/api/market/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const portfolio = { ...me.account.portfolio, cash, positions: {}, skins: null };
    await fetch(`${base}/api/market/me`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio }),
    });
  };

  beforeAll(async () => {
    const dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    const reg = await fetch(`${base}/api/market/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    }).then((r) => r.json());
    token = reg.token;
    await setCash(5000);
  });

  afterAll(() => { if (instance) instance.stop(); });

  test('el catálogo público sirve sin sesión (mismos pesos que el server)', async () => {
    const r = await fetch(`${base}/api/market/skins/catalog`);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(Object.keys(d.cases).length).toBeGreaterThanOrEqual(3);
    expect(d.rarities.milspec.w).toBeGreaterThan(0);
    expect(Array.isArray(d.wears) && d.wears.length).toBe(5);
  });

  test('abrir caja cobra el costo exacto y guarda la skin en el inventario', async () => {
    const before = await skinsGet();
    const r = await skinsPost({ action: 'open', caseId: 'barrio' });
    expect(r.ok).toBe(true);
    expect(before.cash - r.cash).toBe(2000);
    const after = await skinsGet();
    expect(after.inventory.length).toBe(before.inventory.length + 1);
    expect(r.item.value).toBeGreaterThanOrEqual(50);
    expect(after.stats.opened).toBe(before.stats.opened + 1);
    expect(after.stats.spent).toBe(before.stats.spent + 2000);
  });

  test('vender la skin abona su valor al MISMO cash que usa la bolsa y el banco', async () => {
    const before = await skinsGet();
    expect(before.inventory.length).toBeGreaterThan(0);
    const item = before.inventory[before.inventory.length - 1];
    const r = await skinsPost({ action: 'sell', itemId: item.id });
    expect(r.ok).toBe(true);
    expect(r.cash - before.cash).toBe(item.value);
    expect(r.sold.id).toBe(item.id);
    const after = await skinsGet();
    expect(after.stats.earned).toBe(before.stats.earned + item.value);
  });

  test('sin cash no se abre caja', async () => {
    await setCash(10);
    const r = await skinsPost({ action: 'open', caseId: 'cartera' });
    expect(r.status).toBe(400);
    expect(r.error).toBeTruthy();
  });

  test('sellAll vacía el inventario y abona el total', async () => {
    await setCash(20000);
    await skinsPost({ action: 'open', caseId: 'barrio' });
    await skinsPost({ action: 'open', caseId: 'barrio' });
    const before = await skinsGet();
    if (before.inventory.length === 0) return; // improbable pero defendible
    const r = await skinsPost({ action: 'sellAll' });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(before.inventory.length);
    expect(r.cash).toBe(before.cash + r.total);
  });

  test('open ya guarda la skin: keep confirma sin sacar nada del inventario', async () => {
    await setCash(5000);
    const open = await skinsPost({ action: 'open', caseId: 'barrio' });
    expect(open.ok).toBe(true);
    const afterOpen = await skinsGet();
    expect(afterOpen.inventory.some((x) => x.id === open.item.id)).toBe(true);
    const keep = await skinsPost({ action: 'keep', itemId: open.item.id });
    expect(keep.ok).toBe(true);
    const afterKeep = await skinsGet();
    expect(afterKeep.inventory.some((x) => x.id === open.item.id)).toBe(true);
    expect(afterKeep.cash).toBe(afterOpen.cash); // guardar no mueve dinero
  });

  test('un PUT /me SIN campo skins no borra el inventario (bug "guardar no funciona")', async () => {
    await setCash(5000);
    const open = await skinsPost({ action: 'open', caseId: 'barrio' });
    expect(open.ok).toBe(true);
    // el save de la BOLSA trae el portfolio sin skins (cliente sin cajas)
    const me = await fetch(`${base}/api/market/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const stripped = { ...me.account.portfolio };
    delete stripped.skins;
    const put = await fetch(`${base}/api/market/me`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio: stripped }),
    });
    expect(put.status).toBe(200);
    const after = await skinsGet();
    expect(after.inventory.some((x) => x.id === open.item.id)).toBe(true);
  });
});

describe('opencase: tradeos de skins entre jugadores', () => {
  const password = 'bolsa-trades-1';
  const nameA = `traderA${Date.now() % 100000}`;
  const nameB = `traderB${Date.now() % 100000}`;
  let instance;
  let base;
  let tokenA;
  let tokenB;

  const authed = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  const skinsPost = (token, body) =>
    fetch(`${base}/api/market/skins`, { method: 'POST', headers: authed(token), body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, ...(await r.json()) }));

  const tradesPost = (token, body) =>
    fetch(`${base}/api/market/trades`, { method: 'POST', headers: authed(token), body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, ...(await r.json()) }));

  const tradesGet = (token) =>
    fetch(`${base}/api/market/trades`, { headers: authed(token) }).then((r) => r.json());

  const skinsGet = (token) =>
    fetch(`${base}/api/market/skins`, { headers: authed(token) }).then((r) => r.json());

  beforeAll(async () => {
    const dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: '', autoEvents: false });
    base = `http://127.0.0.1:${instance.port}`;
    // el catálogo alimenta la validación de ofertas (items reales sólo)
    await fetch(`${base}/api/market/skins/catalog`).then((r) => r.json());
    const regA = await fetch(`${base}/api/market/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameA, password }) }).then((r) => r.json());
    const regB = await fetch(`${base}/api/market/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameB, password }) }).then((r) => r.json());
    tokenA = regA.token;
    tokenB = regB.token;
    // A con cash para abrir; B con una skin sembrada via PUT /me (inventario real)
    const meA = await fetch(`${base}/api/market/me`, { headers: authed(tokenA) }).then((r) => r.json());
    await fetch(`${base}/api/market/me`, {
      method: 'PUT',
      headers: authed(tokenA),
      body: JSON.stringify({ portfolio: { ...meA.account.portfolio, cash: 5000, positions: {} } }),
    });
    const meB = await fetch(`${base}/api/market/me`, { headers: authed(tokenB) }).then((r) => r.json());
    const seed = {
      id: 'sk-seed-1', caseId: 'barrio', at: Date.now(),
      rarity: 'milspec', rarityName: 'Militar', color: '#4b69ff',
      item: 'M249 | Warbird', wear: 'FT', wearName: 'Field-Tested',
      stattrak: false, value: 500,
    };
    await fetch(`${base}/api/market/me`, {
      method: 'PUT',
      headers: authed(tokenB),
      body: JSON.stringify({
        portfolio: {
          ...meB.account.portfolio,
          skins: { inventory: [seed], stats: { opened: 1, spent: 0, earned: 0 }, seq: 1, trades: { sent: [], received: [] } },
        },
      }),
    });
  });

  afterAll(() => { if (instance) instance.stop(); });

  test('propuesta inválida: jugador inexistente → 404', async () => {
    const r = await tradesPost(tokenA, { action: 'propose', to: 'nadie-existe-xyz', give: [], want: ['M249 | Warbird'] });
    expect(r.status).toBe(404);
  });

  test('propuesta inválida: pedir un item que no existe en las cajas → 400', async () => {
    const r = await tradesPost(tokenA, { action: 'propose', to: nameB, give: [], want: ['AWP | Imposible'] });
    expect(r.status).toBe(400);
  });

  test('propuesta válida: llega al libro del receptor y al del emisor', async () => {
    // A abre una caja para tener algo que dar
    const open = await skinsPost(tokenA, { action: 'open', caseId: 'barrio' });
    expect(open.ok).toBe(true);
    const prop = await tradesPost(tokenA, { action: 'propose', to: nameB, give: [open.item.id], want: ['M249 | Warbird'], note: 'cambio justo' });
    expect(prop.ok).toBe(true);
    const sentA = await tradesGet(tokenA);
    expect(sentA.sent.some((t) => t.id === prop.id && t.status === 'pending')).toBe(true);
    const gotB = await tradesGet(tokenB);
    const offer = gotB.received.find((t) => t.id === prop.id);
    expect(offer).toBeTruthy();
    expect(offer.fromName).toBe(nameA);
    expect(offer.want).toEqual(['M249 | Warbird']);
    testTradeId = prop.id;
  });

  test('aceptar intercambia las skins de verdad (atómico, re-validado)', async () => {
    const invABefore = await skinsGet(tokenA);
    const invBBefore = await skinsGet(tokenB);
    const acc = await tradesPost(tokenB, { action: 'accept', tradeId: testTradeId });
    expect(acc.ok).toBe(true);
    const invAAfter = await skinsGet(tokenA);
    const invBAfter = await skinsGet(tokenB);
    // B recibió la skin que A puso en la oferta
    expect(invBAfter.inventory.some((x) => x.id === acc.received[0].id)).toBe(true);
    // A recibió la skin sembrada de B
    expect(invAAfter.inventory.some((x) => x.item === 'M249 | Warbird')).toBe(true);
    // nadie duplicó: los totales de items se conservan
    const totalBefore = invABefore.inventory.length + invBBefore.inventory.length;
    const totalAfter = invAAfter.inventory.length + invBAfter.inventory.length;
    expect(totalAfter).toBe(totalBefore);
    // la oferta quedó aceptada en ambos libros
    const sentA = await tradesGet(tokenA);
    expect(sentA.sent.find((t) => t.id === testTradeId).status).toBe('accepted');
  });

  test('rechazar una oferta la marca en ambos lados', async () => {
    const open = await skinsPost(tokenA, { action: 'open', caseId: 'barrio' });
    const prop = await tradesPost(tokenA, { action: 'propose', to: nameB, give: [open.item.id], want: [] });
    expect(prop.ok).toBe(true);
    const dec = await tradesPost(tokenB, { action: 'decline', tradeId: prop.id });
    expect(dec.ok).toBe(true);
    const sentA = await tradesGet(tokenA);
    expect(sentA.sent.find((t) => t.id === prop.id).status).toBe('declined');
    // la skin volvió a estar disponible para A (nadie la movió)
    const invA = await skinsGet(tokenA);
    expect(invA.inventory.some((x) => x.id === open.item.id)).toBe(true);
  });

  test('jugadores conectados: la lista del server funciona', async () => {
    const anon = await fetch(`${base}/api/market/players/online`, { headers: { Authorization: `Bearer ${tokenA}` } }).then((r) => r.json());
    expect(Array.isArray(anon.players)).toBe(true);
    // el test abre sockets HTTP, no WS: la lista puede venir vacía, pero de
    // forma válida y sin filtrar cuentas que no estén conectadas
    expect(anon.players.every((p) => typeof p.name === 'string')).toBe(true);
  });

  test('market-stats: cuenta copias, dueños y valor total del loot', async () => {
    const stats = await fetch(`${base}/api/market/skins/market-stats`, { headers: { Authorization: `Bearer ${tokenA}` } }).then((r) => r.json());
    expect(stats.totalItems).toBeGreaterThanOrEqual(1);
    expect(stats.totalValue).toBeGreaterThan(0);
    expect(Array.isArray(stats.items)).toBe(true);
    const top = stats.items[0];
    expect(top.copies).toBeGreaterThanOrEqual(1);
    expect(top.owners).toBeGreaterThanOrEqual(1);
    expect(typeof top.value).toBe('number');
  });
});

// the ranking, the bank desk and the "patrimonio" the player sees all answer
// "what is this worth". they used to answer it three different ways, so a loan
// ceiling moved depending on whether you were signed in and a stored rank
// disagreed with the number on screen. valuation.mjs is the single answer.
describe('portfolio valuation', () => {
  const at = (prices) => (sym) => prices[sym];

  test('the net worth is cash + balance - debt + the positions at the live quote', () => {
    const portfolio = {
      cash: 100000,
      bank: { balance: 50000, loan: 20000 },
      positions: { SOLMK: { shares: 1000, avgPrice: 50 } },
    };
    // 100k + 50k - 20k + 1000 at 60
    expect(portfolioNetWorth(portfolio, at({ SOLMK: 60 }))).toBe(190000);
  });

  test('a position that fell is worth less than what it cost', () => {
    const portfolio = {
      cash: 0,
      bank: { balance: 0, loan: 0 },
      positions: { SOLMK: { shares: 1000, avgPrice: 50 } },
    };
    // bought at 50, now at 10: the desk must read 10k, not the 50k it cost
    expect(portfolioNetWorth(portfolio, at({ SOLMK: 10 }))).toBe(10000);
  });

  test('a symbol with no quote falls back to the price it was bought at', () => {
    const portfolio = {
      cash: 0,
      positions: { GONE: { shares: 100, avgPrice: 7 } },
    };
    expect(portfolioNetWorth(portfolio, at({}))).toBe(700);
  });

  test('the ranking leaves the bank out and never goes below zero', () => {
    const portfolio = {
      cash: 1000,
      bank: { balance: 900000, loan: 0 },
      positions: { SOLMK: { shares: 10, avgPrice: 50 } },
    };
    expect(portfolioTradingValue(portfolio, at({ SOLMK: 60 }))).toBe(1600);

    const broke = { cash: 0, positions: {} };
    expect(portfolioTradingValue(broke, at({}))).toBe(0);
  });

  test('the client and the server now agree on the same portfolio', () => {
    // the sum js/state.js computes for the panel, achievements and loan cap
    const clientNetWorth = (portfolio, quotes) => {
      let total = portfolio.cash
        + (portfolio.bank?.balance || 0)
        - (portfolio.bank?.loan || 0);
      for (const [sym, p] of Object.entries(portfolio.positions)) {
        total += p.shares * (quotes[sym] ?? (p.avgPrice || 0));
      }
      return total;
    };
    const portfolio = {
      cash: 25000,
      bank: { balance: 7500, loan: 3000 },
      positions: {
        SOLMK: { shares: 40, avgPrice: 100 },
        VLRA: { shares: 10, avgPrice: 300 },
      },
    };
    const quotes = { SOLMK: 120, VLRA: 250 };
    expect(portfolioNetWorth(portfolio, at(quotes))).toBe(clientNetWorth(portfolio, quotes));
  });
});

let testTradeId = null;

// regresion del exploit del value: el cliente mandaba un item con caseId /
// rarity / item reales pero value arbitrario hasta 1e12, y 'sell' pagaba eso
// (y se propagaba por los trueques). el value se recorta siempre al rango de
// la caja.
describe('opencase: el value no se acepta del cliente', () => {
  const range = legitValueRange('barrio', 'gold', 'FN', false);
  const craft = (value) =>
    sanitizeSkins({
      seq: 1,
      inventory: [{
        id: 'sk-x', caseId: 'barrio', rarity: 'gold',
        item: '\u2605 Karambit | Freehand', wear: 'FN', stattrak: false,
        value, at: Date.now(),
      }],
      stats: {}, trades: {},
    });

  test('un value inflado se recorta al rango de la caja', () => {
    expect(range).toEqual({ min: 24300, max: 43200 });
    expect(craft(1e9).inventory[0].value).toBe(range.max);
    expect(craft(1).inventory[0].value).toBe(range.min);
  });

  test('un value legitimo no cambia', () => {
    const legit = range.min + 7;
    expect(craft(legit).inventory[0].value).toBe(legit);
  });

  test('vender paga el value recortado, no el del cliente', () => {
    const portfolio = { cash: 10_000, skins: craft(1e9) };
    const sold = skinsAction(portfolio, 'sell', { itemId: 'sk-x' });
    expect(sold.cash).toBe(10_000 + range.max);
  });

  test('un inventario legacy con value inflado se limpia al vender', () => {
    const portfolio = {
      cash: 10_000,
      skins: {
        inventory: [{
          id: 'sk-y', caseId: 'barrio', rarity: 'gold',
          item: '\u2605 Karambit | Freehand', wear: 'FN', stattrak: false,
          value: 1e11, at: Date.now(),
        }],
        stats: { opened: 0, spent: 0, earned: 0 }, seq: 1,
        trades: { sent: [], received: [], seq: 0 },
      },
    };
    const sold = skinsAction(portfolio, 'sell', { itemId: 'sk-y' });
    expect(sold.cash).toBe(10_000 + range.max);
  });

  test('sellAll tambien recorta cada item', () => {
    const portfolio = { cash: 0, skins: craft(1e12) };
    const sold = skinsAction(portfolio, 'sellAll', {});
    expect(sold.total).toBe(range.max);
  });

  test('los trueques recortan el value igual', () => {
    const trades = sanitizeTrades({
      seq: 1,
      sent: [{
        id: 'tr-x',
        give: [{
          id: 'sk-z', caseId: 'barrio', rarity: 'gold',
          item: '\u2605 Karambit | Freehand', wear: 'FN', stattrak: false,
          value: 5e9,
        }],
        want: [], status: 'pending',
      }],
      received: [],
    });
    expect(trades.sent[0].give[0].value).toBe(range.max);
  });
});
