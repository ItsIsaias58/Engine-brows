// the money rules of the trading floor game: margin, leverage, realised and
// unrealised result, liquidation and bankruptcy.
//
// the game ships as plain browser scripts, so the very same files the players run
// are loaded into a sandbox with a minimal DOM. the assertions therefore hold for
// the shipped code, not for a copy of it that could drift.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

const JS_DIR = path.join(
  import.meta.dir,
  '..',
  'services',
  'market',
  'public',
  'bolsa-trading-floor',
  'js',
);
// the catalog and the game rules, the state (all the portfolio maths), and the
// two files that actually trade
// util.js va el primero: define escapeHtml / safeClassToken, que usan state.js
// y profile.js. si el harness no lo carga, esas llamadas son un ReferenceError.
const GAME_FILES = ['util.js', 'sound.js', 'catalog.js', 'news-copy.js', 'state.js', 'order.js', 'portfolio.js', 'achievements.js', 'price-alerts.js'];

const SYM = 'SOLMK';

function elementStub() {
  const el = {
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    remove() {},
    querySelector() {
      return elementStub();
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 900, height: 420 };
    },
  };
  el.classList = {
    _set: new Set(),
    add(...names) {
      names.forEach((name) => this._set.add(name));
    },
    remove(...names) {
      names.forEach((name) => this._set.delete(name));
    },
    toggle(name, force) {
      const on = force === undefined ? !this._set.has(name) : Boolean(force);
      if (on) this._set.add(name);
      else this._set.delete(name);
      return on;
    },
    contains(name) {
      return this._set.has(name);
    },
  };
  return el;
}

// loads the game into a sandbox and returns the handles the tests need
function createGame() {
  const elements = new Map();
  const elementFor = (id) => {
    if (!elements.has(id)) elements.set(id, elementStub());
    return elements.get(id);
  };
  const storage = new Map();
  const document = {
    body: elementStub(),
    documentElement: elementStub(),
    getElementById: elementFor,
    querySelector: () => elementStub(),
    querySelectorAll: () => [],
    createElement: () => elementStub(),
    addEventListener() {},
  };
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const noop = () => {};
  const source = GAME_FILES
    .map((name) => fs.readFileSync(path.join(JS_DIR, name), 'utf8'))
    .join('\n;\n');

  // the UI entry points the trade code calls are stubs: the tests care about the
  // numbers, and the DOM side of a sale is exercised by the browser probes
  const factory = new Function(
    'document',
    'localStorage',
    'window',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'updateQuoteBlock',
    'refreshMarketRow',
    'drawChart',
    'selectSymbol',
    'reportTradeEvent',
    'currentGameTime',
    'candles',
    `${source}
    return {
      state, MARKET, START_CASH, RECAP_CASH, BANKRUPT_WAIT_MS,
      bySym, money,
      buyShares, sellShares, parseTpSl, checkTpSl, closeFullPosition, closePositionPct, recalcOrder,
      positionPnl, positionContribution, portfolioValue, netWorth,
      recordClosedTrade, winRatePct, profitFactor,
      xpBoostActive, trackNetProgress, maxDrawdownPct, addXp, xpToNext,
      Achievements, ACHIEVEMENTS,
      checkLiquidations, checkBankruptcy, tickBankruptcy,
      restoreState, saveGame, loadGame,
      Sound, buildSound: build, SOUND_DURATIONS,
      trimNews, clearNews, NEWS_LIMIT, notificationLimit, pushNotification,
      addPriceAlert, removePriceAlert, priceAlertCrossed, checkPriceAlerts,
      sanitizePriceAlerts, priceAlertLimit, PRICE_ALERT_MAX,
      activeSymbol: () => activeSymbol,
      setActiveSymbol: (sym) => { activeSymbol = sym; },
      setLeverage: (value) => { leverage = value; },
      getLeverage: () => leverage,
      setSide: (value) => { side = value; },
    };`,
  );

  const game = factory(
    document,
    localStorage,
    { location: { protocol: 'http:', host: 'localhost' } },
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    () => Date.now(),
    [],
  );
  // fresh account at a known price, so every assertion is exact
  game.state.cash = 10000;
  game.state.positions = {};
  game.state.transactions = [];
  game.state.stats = { wins: 0, losses: 0, totalTrades: 0, bestTrade: 0, grossProfit: 0, grossLoss: 0 };
  game.state.bankrupt = false;
  game.state.bankruptUntil = 0;
  game.state.notifications = [];
  game.state.quests = { firstBuy: false, diversify: false };
  game.setActiveSymbol(SYM);
  game.setSide('buy');
  game.setLeverage(1);
  game.market = game.bySym(SYM);
  game.market.price = 100;
  game.market.livePrice = 100;
  game.elementFor = elementFor;
  return game;
}

// cash plus what the open positions are still worth: the number the player sees
function netWorth(game) {
  return game.state.cash + game.portfolioValue();
}

// netWorth() lives in js/state.js and every reader shares it. it used to be
// declared a second time in achievements.js, and because these are classic
// scripts sharing one global scope the copy loaded last (bank.js) silently won:
// the wealth achievements ended up measuring cash + bank balance - debt + the
// notional of the positions, while their own source said cash + equity.
describe('the shared net worth', () => {
  test('it is cash + bank balance - debt + the positions at the live price', () => {
    const game = createGame();
    game.state.cash = 100000;
    game.state.bank = { balance: 50000, loan: 20000 };
    game.state.positions = { [SYM]: { shares: 1000, avgPrice: 50, margin: 5000 } };
    // 100k + 50k - 20k + 1000 shares at the 100 the harness pins
    expect(game.netWorth()).toBe(230000);
  });

  test('the bank balance counts and the debt subtracts', () => {
    const game = createGame();
    game.state.cash = 10000;
    game.state.positions = {};
    game.state.bank = { balance: 0, loan: 0 };
    expect(game.netWorth()).toBe(10000);
    game.state.bank = { balance: 40000, loan: 0 };
    expect(game.netWorth()).toBe(50000);
    game.state.bank = { balance: 40000, loan: 15000 };
    expect(game.netWorth()).toBe(35000);
  });

  test('the wealth achievements read that same number', () => {
    const game = createGame();
    game.state.positions = {};
    game.state.transactions = [];
    game.state.watchlist = [];
    game.state.caseHistory = [];
    game.state.level = 1;
    game.state.quests = { firstBuy: false, diversify: false };
    game.state.bank = { balance: 0, loan: 0 };

    // just under a million in cash: nothing yet
    game.state.cash = 900000;
    expect(game.Achievements.check()).toBe(0);
    expect(game.Achievements.state.million).toBeUndefined();

    // the same money parked in the bank is worth exactly the same
    game.state.cash = 0;
    game.state.bank = { balance: 1200000, loan: 0 };
    expect(game.Achievements.check()).toBe(1);
    expect(game.Achievements.state.million).toBe(true);

    // and owing it all again takes it away: the debt is part of the sum
    game.Achievements.state = {};
    game.state.bank = { balance: 1200000, loan: 1200000 };
    expect(game.Achievements.check()).toBe(0);
    expect(game.Achievements.state.million).toBeUndefined();
  });
});

// un AudioContext de mentira que sólo apunta lo que el sintetizador le pide.
// sirve para comprobar que cada sonido construye nodos de verdad y que ninguna
// rampa exponencial recibe un cero: en un navegador eso lanzaría una excepción.
function createFakeAudio() {
  const log = { oscillators: [], ramps: [], buffers: [] };
  const param = (initial) => ({
    value: initial,
    setValueAtTime(value) { log.ramps.push(value); this.value = value; },
    exponentialRampToValueAtTime(value) { log.ramps.push(value); this.value = value; },
    linearRampToValueAtTime(value) { log.ramps.push(value); this.value = value; },
  });
  const node = () => ({ connect() {}, disconnect() {} });
  const ctx = {
    sampleRate: 44100,
    currentTime: 0,
    destination: node(),
    createGain() { return { ...node(), gain: param(1) }; },
    createOscillator() {
      const osc = { ...node(), type: 'sine', frequency: param(440), start() {}, stop() {} };
      log.oscillators.push(osc);
      return osc;
    },
    createBiquadFilter() { return { ...node(), type: 'lowpass', frequency: param(350), Q: param(1) }; },
    createBuffer(channels, length, rate) {
      log.buffers.push({ length, rate });
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    },
    createBufferSource() { return { ...node(), buffer: null, start() {}, stop() {} }; },
  };
  return { ctx, log };
}

describe('game money rules > margin and leverage', () => {
  test('a plain buy freezes the whole notional and the round trip returns it', () => {
    const game = createGame();
    expect(game.buyShares(game.market, 10, 1)).toBe(true);

    const pos = game.state.positions[SYM];
    expect(pos.shares).toBe(10);
    expect(pos.avgPrice).toBe(100);
    expect(pos.leverage).toBe(1);
    // 10 shares at $100: the entire $1,000 is margin at 1x
    expect(pos.margin).toBe(1000);
    expect(game.state.cash).toBe(9000);
    expect(netWorth(game)).toBe(10000);

    // selling everything back at the same price gives the cash back untouched
    const result = game.sellShares(game.market, 10);
    expect(result.proceeds).toBe(1000);
    expect(result.pnl).toBe(0);
    expect(game.state.cash).toBe(10000);
    expect(game.state.positions[SYM]).toBeUndefined();
    expect(netWorth(game)).toBe(10000);
  });

  test('leverage only charges the margin, never the notional', () => {
    const game = createGame();
    expect(game.buyShares(game.market, 10, 10)).toBe(true);

    const pos = game.state.positions[SYM];
    // $1,000 of stock at 10x is $100 of margin
    expect(pos.margin).toBeCloseTo(100, 6);
    expect(game.state.cash).toBeCloseTo(9900, 6);
    expect(netWorth(game)).toBeCloseTo(10000, 6);
    // the leverage asked for is the leverage recorded
    expect(pos.leverage).toBe(10);
  });

  test('an order the cash cannot cover is refused and changes nothing', () => {
    const game = createGame();
    game.state.cash = 50;
    expect(game.buyShares(game.market, 10, 1)).toBe(false);
    expect(game.state.cash).toBe(50);
    expect(game.state.positions[SYM]).toBeUndefined();
    expect(game.state.stats.totalTrades).toBe(0);
  });

  test('a second buy blends price, shares and margin', () => {
    const game = createGame();
    game.buyShares(game.market, 10, 1);
    game.market.price = 200;
    expect(game.buyShares(game.market, 10, 1)).toBe(true);

    const pos = game.state.positions[SYM];
    expect(pos.shares).toBe(20);
    expect(pos.avgPrice).toBe(150);
    // 20 shares at an average of $150 → $3,000 of margin at 1x
    expect(pos.margin).toBeCloseTo(3000, 6);
    expect(game.state.cash).toBeCloseTo(7000, 6);
    // the ten shares bought at $100 are now marked at $200, so the account is up
    // exactly $1,000 on top of the stake it started with
    expect(netWorth(game)).toBeCloseTo(10000 + 10 * (200 - 100), 6);
  });

  test('the leverage of the position is the weighted average of the entries', () => {
    const game = createGame();
    game.buyShares(game.market, 10, 1);
    expect(game.state.positions[SYM].margin).toBeCloseTo(1000, 6);

    // ten more shares at 3x: the blended leverage is 2x, so the margin stays at
    // notional / leverage
    expect(game.buyShares(game.market, 10, 3)).toBe(true);
    const pos = game.state.positions[SYM];
    expect(pos.leverage).toBeCloseTo(2, 6);
    expect(pos.margin).toBeCloseTo((100 * pos.shares) / 2, 6);
    expect(game.state.cash).toBeCloseTo(10000 - pos.margin, 6);
  });
});

describe('game money rules > selling', () => {
  test('a partial sale releases margin and result in the same proportion', () => {
    const game = createGame();
    game.buyShares(game.market, 10, 2);
    const marginBefore = game.state.positions[SYM].margin;
    expect(marginBefore).toBeCloseTo(500, 6);

    game.market.price = 110;
    const result = game.sellShares(game.market, 4);

    // 40% of the position: 40% of the margin plus $10 of profit on each share
    expect(result.pnl).toBeCloseTo(40, 6);
    expect(result.proceeds).toBeCloseTo(240, 6);
    expect(game.state.cash).toBeCloseTo(9500 + 240, 6);

    const pos = game.state.positions[SYM];
    expect(pos.shares).toBe(6);
    expect(pos.margin).toBeCloseTo(300, 6);
    // the mark to market of the whole trade is untouched by the sale
    expect(netWorth(game)).toBeCloseTo(10100, 6);
    expect(game.state.stats.totalTrades).toBe(1);
  });

  test('selling shares that are not there is refused', () => {
    const game = createGame();
    game.buyShares(game.market, 5, 1);
    expect(game.sellShares(game.market, 6)).toBe(false);
    expect(game.state.positions[SYM].shares).toBe(5);
    expect(game.state.stats.totalTrades).toBe(0);
  });

  test('an empty or negative sale never reaches the statistics', () => {
    const game = createGame();
    game.buyShares(game.market, 5, 1);
    expect(game.sellShares(game.market, 0)).toBe(false);
    expect(game.sellShares(game.market, -3)).toBe(false);
    expect(game.sellShares(game.market, NaN)).toBe(false);
    expect(game.state.stats.totalTrades).toBe(0);
    expect(game.state.stats.losses).toBe(0);
    expect(game.state.positions[SYM].shares).toBe(5);
  });

  test('a loss deeper than the margin pays nothing back but never goes below zero', () => {
    const game = createGame();
    game.buyShares(game.market, 10, 10);
    game.market.price = 50;
    const result = game.sellShares(game.market, 10);
    expect(result.pnl).toBeCloseTo(-500, 6);
    // margin released is $100 and the loss is $500: the player gets nothing
    expect(result.proceeds).toBe(0);
    expect(game.state.cash).toBeCloseTo(9900, 6);
    expect(game.state.stats.losses).toBe(1);
    expect(game.state.stats.grossLoss).toBeCloseTo(500, 6);
    // “mejor operación” only ever reports a gain, so a pure loser shows zero
    expect(game.state.stats.bestTrade).toBe(0);
  });
});

describe('game money rules > liquidation', () => {
  test('a leveraged position that eats its margin is closed automatically', () => {
    const game = createGame();
    game.buyShares(game.market, 10, 10);
    expect(game.state.positions[SYM].margin).toBeCloseTo(100, 6);

    // 10 shares at 10x: the $100 of margin covers a $10 slide
    game.market.price = 95;
    expect(game.positionContribution(SYM, game.state.positions[SYM])).toBeCloseTo(50, 6);
    expect(game.checkLiquidations()).toBe(0);
    expect(game.state.positions[SYM]).toBeTruthy();

    game.market.price = 90;
    expect(game.positionContribution(SYM, game.state.positions[SYM])).toBeCloseTo(0, 6);
    expect(game.checkLiquidations()).toBe(1);
    expect(game.state.positions[SYM]).toBeUndefined();
    // the margin was already spent when the position was opened
    expect(game.state.cash).toBeCloseTo(9900, 6);
    expect(game.state.stats.losses).toBe(1);
    expect(game.state.stats.totalTrades).toBe(1);
    expect(game.state.transactions[0]).toMatchObject({ sym: SYM, type: 'Venta' });
    expect(game.state.transactions[0].pnl).toBeCloseTo(-100, 6);
  });

  test('a position with margin left is never touched', () => {
    const game = createGame();
    game.buyShares(game.market, 4, 2);
    game.market.price = 99;
    expect(game.checkLiquidations()).toBe(0);
    expect(game.state.positions[SYM].shares).toBe(4);
  });
});

describe('game money rules > take profit and stop loss', () => {
  test('take profit closes at the market price when the level is reached', () => {
    const game = createGame();
    game.buyShares(game.market, 10, 1, { tp: 120, sl: 90 });
    game.market.price = 119;
    game.checkTpSl();
    expect(game.state.positions[SYM]).toBeTruthy();

    game.market.price = 120;
    game.checkTpSl();
    expect(game.state.positions[SYM]).toBeUndefined();
    expect(game.state.cash).toBeCloseTo(10200, 6);
    expect(game.state.stats.wins).toBe(1);
    expect(game.state.stats.grossProfit).toBeCloseTo(200, 6);
  });

  test('stop loss closes the position and reports the loss', () => {
    const game = createGame();
    game.buyShares(game.market, 10, 1, { tp: 120, sl: 90 });
    game.market.price = 90;
    game.checkTpSl();
    expect(game.state.positions[SYM]).toBeUndefined();
    expect(game.state.cash).toBeCloseTo(9900, 6);
    expect(game.state.stats.losses).toBe(1);
    expect(game.state.stats.grossLoss).toBeCloseTo(100, 6);
  });

  test('a trailing stop follows the peak instead of the entry', () => {
    const game = createGame();
    game.buyShares(game.market, 10, 1, { trailPct: 10 });
    game.market.price = 150;
    game.checkTpSl();
    expect(game.state.positions[SYM].shares).toBe(10);

    // 10% off the peak of 150 is 135
    game.market.price = 136;
    game.checkTpSl();
    expect(game.state.positions[SYM].shares).toBe(10);
    game.market.price = 135;
    game.checkTpSl();
    expect(game.state.positions[SYM]).toBeUndefined();
    expect(game.state.cash).toBeCloseTo(10350, 6);
  });

  test('levels are read as an amount or as a percentage', () => {
    const game = createGame();
    expect(game.parseTpSl('120', 100, true)).toBe(120);
    expect(game.parseTpSl('+20%', 100, true)).toBeCloseTo(120, 6);
    // a stop loss is below the entry even if the number is typed positive
    expect(game.parseTpSl('20%', 100, false)).toBeCloseTo(80, 6);
    expect(game.parseTpSl('', 100, true)).toBeNull();
    expect(game.parseTpSl('   ', 100, true)).toBeNull();
    expect(game.parseTpSl('abc', 100, true)).toBeNull();
  });
});

describe('game money rules > bankruptcy and statistics', () => {
  test('the account is wiped at zero and recapitalised after the wait', () => {
    const game = createGame();
    // a leveraged trade that ended up owing money, with no cash left to cover it
    game.buyShares(game.market, 10, 10);
    game.market.price = 89;
    game.state.cash = 0;
    expect(netWorth(game)).toBeLessThan(0);

    game.checkBankruptcy(netWorth(game));
    expect(game.state.bankrupt).toBe(true);
    expect(Object.keys(game.state.positions)).toHaveLength(0);
    expect(game.elementFor('qtyInput').disabled).toBe(true);

    // the wait is over: the stake comes back
    game.state.bankruptUntil = Date.now() - 1;
    game.tickBankruptcy();
    expect(game.state.bankrupt).toBe(false);
    expect(game.state.cash).toBe(game.RECAP_CASH);
    expect(game.state.positions).toEqual({});
    expect(game.elementFor('qtyInput').disabled).toBe(false);
    // and the order form is usable again
    expect(game.elementFor('submitOrder').disabled).toBe(true); // no quantity typed yet
    game.elementFor('qtyInput').value = '1';
    game.recalcOrder();
    expect(game.elementFor('submitOrder').disabled).toBe(false);
  });

  test('bankruptcy only fires once and does not touch a healthy account', () => {
    const game = createGame();
    game.buyShares(game.market, 1, 1);
    game.checkBankruptcy(netWorth(game));
    expect(game.state.bankrupt).toBe(false);
    expect(game.state.positions[SYM].shares).toBe(1);

    game.state.cash = 0;
    game.checkBankruptcy(0);
    game.state.cash = 5000;
    // the flag is already up: a second call must not bank the stake twice
    game.checkBankruptcy(5000);
    expect(game.state.bankrupt).toBe(true);
    expect(game.state.cash).toBe(5000);
  });

  test('the realised statistics add up to win rate and profit factor', () => {
    const game = createGame();
    // one winner of $200 and one loser of $50
    game.buyShares(game.market, 10, 1);
    game.market.price = 120;
    game.sellShares(game.market, 10);
    game.market.price = 100;
    game.buyShares(game.market, 10, 1);
    game.market.price = 95;
    game.sellShares(game.market, 10);

    const stats = game.state.stats;
    expect(stats.totalTrades).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.grossProfit).toBeCloseTo(200, 6);
    expect(stats.grossLoss).toBeCloseTo(50, 6);
    expect(stats.bestTrade).toBeCloseTo(200, 6);
    expect(game.winRatePct()).toBeCloseTo(50, 6);
    expect(game.profitFactor()).toBeCloseTo(4, 6);
    expect(game.state.cash).toBeCloseTo(10000 + 200 - 50, 6);
  });

  test('an untouched account reports no rate instead of a broken one', () => {
    const game = createGame();
    expect(game.winRatePct()).toBeNull();
    expect(game.profitFactor()).toBeNull();
  });
});

describe('game money rules > saved state', () => {
  test('a save round trips through localStorage', () => {
    const game = createGame();
    game.buyShares(game.market, 3, 5);
    game.state.stats.totalTrades = 2;
    game.saveGame();

    game.state.cash = 1;
    game.state.positions = {};
    game.state.stats.totalTrades = 0;
    expect(game.loadGame()).toBe(true);
    expect(game.state.cash).toBeCloseTo(10000 - 60, 6);
    expect(game.state.positions[SYM].shares).toBe(3);
    expect(game.state.stats.totalTrades).toBe(2);
  });

  test('a save keeps the settlement apart from the tape it restores', () => {
    const game = createGame();
    // the tape walked away from the reference: the day change is measured
    // against the previous close, not against the settlement
    game.market.price = 120;
    game.market.livePrice = 120;
    game.market.prevClose = 100;
    game.market.settle = 110;
    game.market.prevSettle = 105;
    game.saveGame();

    game.market.price = 1;
    game.market.settle = 1;
    game.market.change = 0;
    game.market.pct = 0;
    expect(game.loadGame()).toBe(true);
    expect(game.market.price).toBe(120);
    expect(game.market.settle).toBe(110);
    // +20 over a 100 close, and the reference stays where it was
    expect(game.market.change).toBeCloseTo(20, 6);
    expect(game.market.pct).toBeCloseTo(20, 6);
    expect(game.market.settle).not.toBe(game.market.price);
  });

  test('an old or hostile save is sanitised instead of poisoning the account', () => {
    const game = createGame();
    game.restoreState({
      cash: 'mucho',
      level: -3,
      xp: null,
      positions: { BOGUS: { shares: 'x' }, [SYM]: { shares: 3, avgPrice: 100, margin: 30, leverage: 10 } },
      watchlist: [SYM, 'NOPE'],
      stats: { wins: undefined, totalTrades: 7 },
      quests: null,
      bankrupt: 'yes',
    });

    expect(Number.isFinite(game.state.cash)).toBe(true);
    expect(game.state.level).toBe(1);
    expect(game.state.xp).toBe(0);
    // a symbol that is not in the catalog never becomes a position
    expect(Object.keys(game.state.positions)).toEqual([SYM]);
    expect(game.state.positions[SYM].shares).toBe(3);
    expect(game.state.watchlist).toEqual([SYM]);
    expect(game.state.stats.wins).toBe(0);
    expect(game.state.stats.totalTrades).toBe(7);
    expect(game.state.quests).toEqual({ firstBuy: false, diversify: false });
    expect(game.state.bankrupt).toBe(false);
    expect(Number.isNaN(game.winRatePct())).toBe(false);
    expect(game.winRatePct()).toBe(0);
  });
});

describe('game progression > streaks, boosters and the achievements', () => {
  test('the win streak counts closed trades and only a loss resets it', () => {
    const game = createGame();
    [10, 20, 5].forEach((pnl) => game.recordClosedTrade(pnl));
    expect(game.state.stats.currentStreak).toBe(3);
    expect(game.state.stats.bestStreak).toBe(3);

    game.recordClosedTrade(-40);
    expect(game.state.stats.currentStreak).toBe(0);
    // the best run is remembered even after a losing trade
    expect(game.state.stats.bestStreak).toBe(3);

    game.recordClosedTrade(1);
    expect(game.state.stats.currentStreak).toBe(1);
    expect(game.state.stats.bestStreak).toBe(3);
  });

  test('a case booster multiplies every XP award while it lasts', () => {
    const game = createGame();
    game.state.xp = 0;
    game.state.xpBoost = { mult: 2, until: Date.now() + 60000 };
    expect(game.xpBoostActive()).toBeTruthy();
    game.state.xp = 0;
    game.addXp(10);
    expect(game.state.xp).toBe(20);

    // an expired booster is dropped and stops multiplying
    game.state.xpBoost = { mult: 5, until: Date.now() - 1 };
    expect(game.xpBoostActive()).toBe(null);
    game.state.xp = 0;
    game.addXp(10);
    expect(game.state.xp).toBe(10);
  });

  test('the net worth curve and the drawdown read the samples', () => {
    const game = createGame();
    game.state.cash = 10000;
    game.state.positions = {};
    game.state.stats.peakNet = 0;
    game.state.netHistory = [];

    expect(game.trackNetProgress()).toBe(10000);
    game.state.cash = 25000;
    game.trackNetProgress();
    expect(game.state.stats.peakNet).toBe(25000);
    expect(game.state.netHistory.length).toBe(2);

    // the curve is a window, not an archive
    for (let i = 0; i < 120; i += 1) game.trackNetProgress();
    expect(game.state.netHistory.length).toBe(96);

    game.state.cash = 12500;
    expect(game.maxDrawdownPct()).toBeCloseTo(50, 6);
  });

  test('the hostile save is sanitized down to the progression fields', () => {
    const game = createGame();
    game.restoreState({
      cash: 5000,
      stats: { wins: 'many', currentStreak: 'x', bestStreak: null, timesBankrupt: -3, bestDayReturn: 'a lot' },
      caseHistory: 'nope',
      skins: [1, 'neon', null],
      goldenTickets: 'two',
      xpBoost: { mult: 99, until: 'later' },
      netHistory: [{ t: 1, net: 'lots' }, { net: 5 }],
      dayTrack: 'today',
    });

    expect(game.state.stats.currentStreak).toBe(0);
    expect(game.state.stats.bestStreak).toBe(0);
    expect(game.state.stats.timesBankrupt).toBe(0);
    expect(game.state.stats.bestDayReturn).toBe(0);
    expect(game.state.caseHistory).toEqual([]);
    expect(game.state.skins).toEqual(['neon']);
    expect(game.state.goldenTickets).toBe(0);
    // an unusable booster cannot silence the XP curve
    expect(game.state.xpBoost).toBe(null);
    expect(game.state.netHistory).toEqual([{ net: 5 }]);
    expect(game.state.dayTrack).toEqual({ key: -1, open: 0 });
  });

  test('the achievements unlock once, keep a title and survive a reload', () => {
    const game = createGame();
    game.state.transactions = [{ sym: SYM, type: 'Compra', shares: 1 }];
    game.state.watchlist = ['SOLMK', 'TCED', 'NORVX', 'BHVN', 'ORBF'];
    game.state.caseHistory = [];

    const unlocked = game.Achievements.check();
    // exactly what this state earns: the first purchase and five favourites
    expect(unlocked).toBe(2);
    expect(game.Achievements.state.first_trade).toBe(true);
    expect(game.Achievements.state.watchlist_5).toBe(true);
    // "diversificado" needs five *held* sectors, which is not the case here
    expect(game.Achievements.state.diversified).toBeUndefined();

    // a second sweep must not award the same achievement twice
    expect(game.Achievements.check()).toBe(0);

    // the progress bar is honest about the total
    const progress = game.Achievements.progress();
    expect(progress.total).toBe(game.ACHIEVEMENTS.length);
    expect(progress.done).toBe(2);
    expect(progress.pct).toBeGreaterThan(0);

    // and what was saved is what comes back from storage
    game.Achievements.state = {};
    game.Achievements.load();
    expect(game.Achievements.state.first_trade).toBe(true);
    expect(game.Achievements.state.watchlist_5).toBe(true);
  });
});

describe('game sounds > the synthesised catalogue', () => {
  // los sonidos que el juego dispara de verdad, más los internos de la consola
  const NAMES = ['click', 'tick', 'spinStart', 'buy', 'sell', 'profit', 'loss', 'win', 'jackpot', 'levelup', 'achievement', 'event', 'alarm', 'notify', 'alert',
    'error', 'close', 'hover', 'open', 'reconnect', 'transfer',
    'card', 'cashIn', 'pollOpen', 'pollVote', 'pollWin', 'pollLose', 'marketPulse'];

  test('every sound builds audio and never asks for a zero ramp', () => {
    const game = createGame();
    for (const name of NAMES) {
      const { ctx, log } = createFakeAudio();
      const out = ctx.createGain();
      expect(() => game.buildSound(ctx, out, name, { rarity: 'legendario' })).not.toThrow();
      // algo tiene que sonar: osciladores y/o ruido
      expect(log.oscillators.length + log.buffers.length).toBeGreaterThan(0);
      // una rampa exponencial a cero lanza en el navegador; ninguna puede serlo
      expect(log.ramps.every((value) => value > 0)).toBe(true);
      // y ninguna frecuencia por debajo del oído (el clamp de 20 Hz)
      expect(log.oscillators.every((osc) => osc.frequency.value >= 20)).toBe(true);
    }
  });

  test('an unknown sound is silent instead of throwing', () => {
    const game = createGame();
    const { ctx, log } = createFakeAudio();
    game.buildSound(ctx, ctx.createGain(), 'no-existe', {});
    expect(log.oscillators.length + log.buffers.length).toBe(0);
  });

  test('the rarer the case reward, the longer the jingle', () => {
    const game = createGame();
    const of = (rarity) => game.Sound.durationOf('win', { rarity });
    expect(of('común')).toBeLessThan(of('raro'));
    expect(of('raro')).toBeLessThan(of('épico'));
    expect(of('épico')).toBeLessThan(of('legendario'));
  });

  test('a profit climbs in pitch and a loss falls', () => {
    const game = createGame();
    // cada nota crea dos voces (la base y su octava), así que las fundamentales
    // son las de índice par en el orden de creación
    const noteFreqs = (name) => {
      const { ctx, log } = createFakeAudio();
      game.buildSound(ctx, ctx.createGain(), name, {});
      return log.oscillators
        .filter((_, index) => index % 2 === 0)
        .map((osc) => osc.frequency.value);
    };
    const profit = noteFreqs('profit');
    const loss = noteFreqs('loss');
    expect(profit.length).toBeGreaterThan(1);
    expect(profit.every((freq, index) => index === 0 || freq > profit[index - 1])).toBe(true);
    expect(loss.length).toBeGreaterThan(1);
    expect(loss.every((freq, index) => index === 0 || freq < loss[index - 1])).toBe(true);
  });
});

describe('game price alerts > crossing, not just being past it', () => {
  test('an alert fires when the tape crosses it, not when it is already past', () => {
    const game = createGame();
    game.market.price = 100;
    game.market.livePrice = 100;
    game.state.priceAlerts = [];

    // the target sits *below* the current price: an 'up' alert must not fire yet
    const up = game.addPriceAlert(SYM, 'up', 90);
    expect(up).not.toBe(null);
    expect(game.checkPriceAlerts()).toBe(0);

    // the tape dips under the target, then climbs back through it: that crossing
    // is what fires — sitting above it at creation never did
    game.market.price = 85;
    expect(game.checkPriceAlerts()).toBe(0);
    game.market.price = 95;
    expect(game.checkPriceAlerts()).toBe(1);
    // fired once, then it is gone
    expect(game.state.priceAlerts.length).toBe(0);
    expect(game.checkPriceAlerts()).toBe(0);
  });

  test('a downward alert mirrors the upward one', () => {
    const game = createGame();
    game.market.price = 100;
    game.state.priceAlerts = [];
    expect(game.addPriceAlert(SYM, 'down', 110)).not.toBe(null);
    expect(game.checkPriceAlerts()).toBe(0);
    // still under the target: no crossing yet
    game.market.price = 105;
    expect(game.checkPriceAlerts()).toBe(0);
    // climbs past it…
    game.market.price = 115;
    expect(game.checkPriceAlerts()).toBe(0);
    // …and falls back through it
    game.market.price = 109.99;
    expect(game.checkPriceAlerts()).toBe(1);
  });

  test('the raw predicate is an edge, both ways', () => {
    const game = createGame();
    expect(game.priceAlertCrossed({ dir: 'up', target: 100, last: 99 }, 100)).toBe(true);
    expect(game.priceAlertCrossed({ dir: 'up', target: 100, last: 101 }, 102)).toBe(false);
    expect(game.priceAlertCrossed({ dir: 'down', target: 100, last: 101 }, 100)).toBe(true);
    expect(game.priceAlertCrossed({ dir: 'down', target: 100, last: 99 }, 98)).toBe(false);
  });

  test('a hostile saved list is sanitised and capped', () => {
    const game = createGame();
    const raw = [
      null,
      { sym: 'NOPE', dir: 'up', target: 10 },
      { sym: SYM, dir: 'sideways', target: 'x' },
      { sym: SYM, dir: 'up', target: -5 },
      { sym: SYM, dir: 'down', target: 120, last: 'y' },
    ];
    const clean = game.sanitizePriceAlerts(raw);
    expect(clean.length).toBe(1);
    expect(clean[0].sym).toBe(SYM);
    expect(clean[0].dir).toBe('down');
    expect(clean[0].target).toBe(120);
    // a missing/invalid `last` falls back to the target so it cannot fire on load
    expect(clean[0].last).toBe(120);

    const many = [];
    for (let i = 0; i < game.PRICE_ALERT_MAX + 6; i += 1) {
      many.push({ sym: SYM, dir: 'up', target: 100 + i, last: 100 });
    }
    expect(game.sanitizePriceAlerts(many).length).toBe(game.priceAlertLimit());
  });

  test('removing an alert by id works and is reported', () => {
    const game = createGame();
    game.state.priceAlerts = [];
    const alert = game.addPriceAlert(SYM, 'up', 200);
    expect(game.state.priceAlerts.length).toBe(1);
    expect(game.removePriceAlert('no-existe')).toBe(false);
    expect(game.removePriceAlert(alert.id)).toBe(true);
    expect(game.state.priceAlerts.length).toBe(0);
  });
});

describe('game news and notices > rolling trays', () => {
  test('the news tray keeps only the newest headlines', () => {
    const game = createGame();
    game.state.news = [];
    for (let i = 0; i < game.NEWS_LIMIT + 8; i += 1) {
      game.state.news.unshift({ sym: SYM, title: `titular ${i}`, pct: i, time: '00:00' });
      game.trimNews();
    }
    // the cap holds no matter how many arrive, and the newest are the survivors
    expect(game.state.news.length).toBe(game.NEWS_LIMIT);
    expect(game.state.news[0].title).toBe(`titular ${game.NEWS_LIMIT + 7}`);
    game.clearNews();
    expect(game.state.news).toEqual([]);
  });

  test('notifications respect the ceiling the console can dial', () => {
    const game = createGame();
    game.state.notifications = [];
    game.state.unreadNotifs = 0;
    for (let i = 0; i < game.notificationLimit() + 5; i += 1) {
      game.pushNotification('t', `mensaje ${i}`, 'info');
    }
    expect(game.state.notifications.length).toBe(game.notificationLimit());
  });
});

describe('game responsive shell', () => {
  const ROOT = path.join(import.meta.dir, '..', 'services', 'market', 'public', 'bolsa-trading-floor');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('the html loads the responsive sheet, the boot screen and its script', () => {
    const html = read('index.html');
    expect(html).toContain('css/responsive.css');
    expect(html).toContain('css/boot.css');
    expect(html).toContain('js/boot.js');
    // la hoja responsive tiene que ir despues de las demas para poder reajustar
    expect(html.indexOf('css/responsive.css')).toBeGreaterThan(html.indexOf('css/progression.css'));
    // y la pantalla de carga antes que el motor del juego
    expect(html.indexOf('js/boot.js')).toBeLessThan(html.indexOf('js/net.js'));
  });

  test('the responsive sheet keeps the overflow guard that fixed the small-screen bug', () => {
    const css = read('css/responsive.css');
    // sin min-width:0 un hijo de grid no baja de su ancho min-content y la
    // columna del grafico desbordaba la pagina a lo ancho
    expect(css).toMatch(/\.workspace\s*>\s*\.col\s*\{[^}]*min-width\s*:\s*0/);
    // y la barra superior tiene que poder envolver en vez de encimarse
    expect(css).toMatch(/\.hud\s*\{[^}]*flex-wrap\s*:\s*wrap/);
  });

  test('the service worker caches the shell but never the live market data', () => {
    const sw = read('sw.js');
    // datos vivos: siempre a la red
    expect(sw).toContain("'/api/'");
    expect(sw).toContain("'/ws/'");
    // y el shell si se guarda
    expect(sw).toContain("./index.html");
    expect(sw).toContain("./styles.css");
    // el documento se pide a la red primero, para no servir un index viejo
    expect(sw).toContain("req.mode === 'navigate'");
  });

  test('the boot screen exposes a progress api and a way out', () => {
    const boot = read('js/boot.js');
    expect(boot).toContain('window.Boot');
    // nunca deja al jugador atrapado: hay limite duro y boton de reintento
    expect(boot).toContain('HARD_LIMIT_MS');
    expect(boot).toContain('bootRetry');
    // y el progreso no es de mentira: se mide con el resource timing real
    expect(boot).toContain("getEntriesByType('resource')");
    expect(boot).toContain('PerformanceObserver');
    expect(boot).toContain('assets: ()');
  });

  test('the boot asset manifest matches the scripts index.html actually loads', () => {
    const html = read('index.html');
    const boot = read('js/boot.js');

    // la lista de boot.js tiene que ser exactamente la de index.html, en el
    // mismo orden: si alguien agrega un script y no lo anota, la pantalla de
    // carga mentiria sobre lo que falta
    const fromHtml = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const manifest = boot.slice(boot.indexOf('const SCRIPT_FILES'), boot.indexOf('];', boot.indexOf('const SCRIPT_FILES')));
    const fromBoot = [...manifest.matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
    expect(fromBoot).toEqual(fromHtml);

    // y la lista tiene que dibujarse en el html, si no el progreso no se ve
    expect(html).toContain('id="bootAssets"');
    expect(html).toContain('id="bootCount"');

    // la hoja de estilos tambien entra: las del <head> se leen del DOM, y la
    // pantalla las lista por nombre
    expect(boot).toContain("link[rel=\"stylesheet\"]");
  });

  // los <script> del juego son clasicos y comparten un solo ambito global: el
  // orden de carga ES parte del contrato. dos archivos declarando el mismo
  // nombre significa que el segundo pisa al primero y que el primero nunca se
  // ejecuta: asi fue como netWorth() media dos cosas distintas segun donde se
  // mirase. este test no ejecuta nada, solo lee los 30 archivos, asi que cubre
  // tambien los que el harness no carga por necesitar el DOM.
  test('no two scripts declare the same global', () => {
    const html = read('index.html');
    const files = [...html.matchAll(/<script src="js\/([^"]+)"/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(20);

    const owners = new Map();
    const clashes = [];
    for (const file of files) {
      const src = read(`js/${file}`);
      for (const m of src.matchAll(/^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        const name = m[1];
        if (owners.has(name)) clashes.push(`${name}: ${owners.get(name)} y ${file}`);
        else owners.set(name, file);
      }
    }
    expect(clashes).toEqual([]);
  });

  // el harness carga una fraccion de los scripts, y en un orden que no es el de
  // index.html. si una hoja dependiera del orden, el test correria una forma del
  // juego que el navegador nunca ejecuta.
  test('the harness loads the files in the order index.html does', () => {
    const html = read('index.html');
    const real = [...html.matchAll(/<script src="js\/([^"]+)"/g)].map((m) => m[1]);
    const picked = GAME_FILES.map((name) => name.replace(/^js\//, ''));
    const indices = picked.map((name) => real.indexOf(name));

    expect(indices.every((i) => i !== -1)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test('the order book ladder is deterministic, brackets the tape and is wired to the tick UI', () => {
    const book = fs.readFileSync(path.join(JS_DIR, 'orderbook.js'), 'utf8');
    const market = fs.readFileSync(path.join(JS_DIR, 'market.js'), 'utf8');
    const html = read('index.html');
    // deterministic depth: hash-based, never Math.random
    expect(book).toContain('function bookHash');
    expect(book).not.toMatch(/Math\.random/);
    // the top of book brackets the live tape by half a tick on each side
    expect(book).toContain('halfSpread');
    expect(book).toMatch(/price \+ halfSpread/);
    expect(book).toMatch(/price - halfSpread/);
    // it rides the same throttled tick beat as the rest of the UI
    expect(market).toContain('renderOrderBook');
    // and the container exists with a click-to-fill contract
    expect(html).toContain('id="orderBook"');
    expect(book).toContain("limitPriceInput");
  });

  test('the chart re-syncs its buffer on every paint, not only on resize', () => {
    const chart = fs.readFileSync(path.join(JS_DIR, 'chart.js'), 'utf8');
    // el arreglo del bug de velas cortadas: comparar el buffer con el tamano real
    expect(chart).toContain('function syncCanvasSize()');
    expect(chart).toMatch(/canvas\.width\s*!==\s*wantW/);
    // y el zoom mas profundo mantiene el cuerpo delgado
    expect(chart).toMatch(/'5m':\s*\{[^}]*maxBody:10,\s*maxSlot:26/);
  });
});
