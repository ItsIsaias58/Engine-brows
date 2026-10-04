// dividends: companies that pay real cash to shareholders on a schedule. this
// is BNT's planet income (sched_planets.php paying credits every tick to the
// owner) translated to the market: owning a slice of a company pays you, so
// "buy and hold" becomes a strategy with its own tempo instead of just a
// slower way to trade momentum.
//
// the payout is a fraction of each company's daily drift (alpha): a compounding
// software company pays more than a fading cyclical, which keeps the money
// attached to the same character the price walk already has. the schedule is
// per company so pay days are spread across the week instead of one lump day.
import { MARKET_SYMBOLS } from './companies.mjs';

export const DIVIDEND_TAX = 0.10; // the house keeps 10%, like a real clearing

const schedule = new Map(
  MARKET_SYMBOLS.map((symbol, index) => {
    const alpha = symbol.alpha || 0;
    const yieldRate = Math.max(0.0002, alpha * 0.55);
    return [
      symbol.sym,
      {
        everyDays: 3 + (index % 4), // 3, 4, 5, 6 game days, staggered
        yieldRate, // fraction of the CURRENT price paid per share
        offset: index % (3 + (index % 4)),
      },
    ];
  }),
);

export function dividendInfo(sym) {
  return schedule.get(sym) || null;
}

// what the panel shows: next pay day per symbol
export function dividendTable(gameDay) {
  return MARKET_SYMBOLS.map((symbol) => {
    const config = schedule.get(symbol.sym);
    const every = config.everyDays;
    const phase = ((gameDay - config.offset) % every + every) % every;
    const inDays = every - phase;
    return {
      sym: symbol.sym,
      everyDays: every,
      inDays,
      yieldRate: config.yieldRate,
      pays: symbol.alpha > 0.0002,
    };
  });
}

// called once per game day by the tick loop, for every account on the server.
// `quotes` maps sym -> { live }. returns the log entries for the player feed.
export function processDividends(portfolio, quotes, gameDay) {
  const log = [];
  const positions = portfolio.positions || {};
  for (const [sym, position] of Object.entries(positions)) {
    const config = schedule.get(sym);
    const quote = quotes.get(sym);
    if (!config || !quote || !Number.isFinite(quote.live)) continue;
    const phase = ((gameDay - config.offset) % config.everyDays + config.everyDays) % config.everyDays;
    if (phase !== 0) continue;
    const shares = Number(position.shares) || 0;
    if (shares <= 0) continue;
    const gross = shares * quote.live * config.yieldRate;
    if (gross <= 0) continue;
    const net = gross * (1 - DIVIDEND_TAX);
    portfolio.cash = (Number(portfolio.cash) || 0) + net;
    log.push({ kind: 'dividend', sym, shares, net, day: gameDay });
  }
  return log;
}
