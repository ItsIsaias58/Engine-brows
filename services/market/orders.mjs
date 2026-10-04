// resting orders: limit and stop orders that live on the server and execute the
// moment the tape crosses them, one tick at a time. this is the piece the game
// was missing between "market order right now" and "TP/SL on an open position"
// — the buy-low-wait, sell-high-wait style that BNT players used traderoutes
// for: set it up, go do something else, the world does the work.
//
// an order carries its own margin, taken from the player's cash at placement
// and returned on execution or cancellation. the server owns the fill price,
// so a limit buy that gaps through still fills at the limit price, never worse.
import { roundPrice } from './tuning.mjs';

export const MAX_ORDERS_PER_ACCOUNT = 24;
export const ORDER_TTL_DAYS = 14; // game days, then the order expires back to cash

export function defaultOrders() {
  return [];
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

// validate a placement against the portfolio it is escrowing from. cash moves
// here, not at execution, so a player cannot park ten orders with one wallet.
export function placeOrder(portfolio, raw) {
  const list = Array.isArray(portfolio.orders) ? portfolio.orders : [];
  if (list.length >= MAX_ORDERS_PER_ACCOUNT) {
    return { ok: false, error: 'demasiadas órdenes en espera (máximo 24)' };
  }

  const sym = String(raw.sym || '').trim().toUpperCase().slice(0, 16);
  const side = raw.side === 'sell' ? 'sell' : 'buy';
  const kind = raw.kind === 'stop' ? 'stop' : 'limit';
  const shares = Math.floor(clampNumber(raw.shares, 0, 1e12) || 0);
  const price = clampNumber(raw.price, 0.000001, 1e12);
  const leverage = Math.min(20, Math.max(1, Math.round(clampNumber(raw.leverage, 1, 20) || 1)));
  if (!sym || shares <= 0 || !price) return { ok: false, error: 'orden incompleta' };

  const live = Number(raw.livePrice) || price;
  if (side === 'buy') {
    if (kind === 'limit' && price >= live) return { ok: false, error: 'una compra limitada va DEBAJO del precio actual' };
    if (kind === 'stop' && price <= live) return { ok: false, error: 'una compra stop va ENCIMA del precio actual' };
  } else {
    if (kind === 'limit' && price <= live) return { ok: false, error: 'una venta limitada va ENCIMA del precio actual' };
    if (kind === 'stop' && price >= live) return { ok: false, error: 'una venta stop va DEBAJO del precio actual' };
  }

  const margin = (shares * price) / leverage;
  const cash = Number(portfolio.cash) || 0;
  if (margin > cash + 0.001) return { ok: false, error: `necesitas ${margin.toFixed(2)} de margen y tienes ${cash.toFixed(2)}` };

  portfolio.cash = cash - margin;
  const order = {
    id: `o${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    sym, side, kind, shares, price: roundPrice(price), leverage, margin,
    placedAt: Date.now(),
    day: Math.round(clampNumber(raw.day, 0, 1e9) || 0),
  };
  portfolio.orders = [...list, order];
  return { ok: true, order };
}

export function cancelOrder(portfolio, orderId) {
  const list = Array.isArray(portfolio.orders) ? portfolio.orders : [];
  const index = list.findIndex((o) => o.id === orderId);
  if (index < 0) return { ok: false, error: 'orden no encontrada' };
  const [order] = list.splice(index, 1);
  portfolio.cash = (Number(portfolio.cash) || 0) + (Number(order.margin) || 0);
  portfolio.orders = list;
  return { ok: true, order };
}

// one pass per tick: every order for this portfolio is checked against the
// quote map. returns the fills/expiries so the caller can notify the player.
export function processOrders(portfolio, quotes, day) {
  const list = Array.isArray(portfolio.orders) ? portfolio.orders : [];
  if (!list.length) return [];
  const outcomes = [];
  const keep = [];

  for (const order of list) {
    const quote = quotes.get(order.sym);
    const price = quote ? quote.live : NaN;
    if (!Number.isFinite(price)) {
      keep.push(order);
      continue;
    }

    // expiry: after TTL game days the money goes home instead of resting forever
    if (Number.isFinite(order.day) && day - order.day >= ORDER_TTL_DAYS) {
      portfolio.cash = (Number(portfolio.cash) || 0) + (Number(order.margin) || 0);
      outcomes.push({ type: 'expired', order, price });
      continue;
    }

    const crossed =
      order.kind === 'limit'
        ? order.side === 'buy'
          ? price <= order.price
          : price >= order.price
        : order.side === 'buy'
          ? price >= order.price
          : price <= order.price;
    if (!crossed) {
      keep.push(order);
      continue;
    }

    // the fill never goes through a position object directly: it reports what
    // happened so the caller (which owns the position logic) applies it
    outcomes.push({ type: 'filled', order, price: order.kind === 'limit' ? order.price : price });
  }

  const filled = new Set(outcomes.filter((o) => o.type === 'filled').map((o) => o.order.id));
  portfolio.orders = keep.filter((o) => !filled.has(o.id));
  return outcomes;
}

// a filled order is applied to the positions by the caller with these helpers,
// so the fill rules live in one place: a limit buy fills AT the limit price.
export function fillBuy(portfolio, order, fillPrice) {
  const positions = portfolio.positions || (portfolio.positions = {});
  const position = positions[order.sym] || { shares: 0, avgPrice: 0, leverage: order.leverage, margin: 0 };
  const shares = Number(position.shares) || 0;
  const newShares = shares + order.shares;
  const newAvg = ((Number(position.avgPrice) || 0) * shares + fillPrice * order.shares) / newShares;
  const newLev = ((Number(position.leverage) || order.leverage) * shares + order.leverage * order.shares) / newShares;
  const newMargin = (newAvg * newShares) / newLev;
  const escrowed = Number(order.margin) || 0;
  const delta = newMargin - (Number(position.margin) || 0);
  // escrow covers the margin it can; the difference (a limit buy gapping
  // through to a better price) stays in cash
  positions[order.sym] = {
    shares: newShares, avgPrice: newAvg, leverage: newLev, margin: newMargin,
    tp: position.tp || null, sl: position.sl || null,
    trailPct: position.trailPct || null, trailPeak: position.trailPeak || fillPrice,
  };
  portfolio.cash = (Number(portfolio.cash) || 0) + escrowed - delta;
  return { shares: order.shares, price: fillPrice };
}

export function fillSell(portfolio, order, fillPrice) {
  const positions = portfolio.positions || {};
  const position = positions[order.sym];
  if (!position || (Number(position.shares) || 0) < order.shares) {
    // the position was closed by hand while the order rested: refund the escrow
    // (a short does not exist in this game, so there is nothing to sell)
    portfolio.cash = (Number(portfolio.cash) || 0) + (Number(order.margin) || 0);
    return { refunded: true };
  }
  const shares = Number(position.shares) || 0;
  const frac = order.shares / shares;
  const marginReleased = (Number(position.margin) || 0) * frac;
  const pnl = order.shares * (fillPrice - (Number(position.avgPrice) || 0));
  const proceeds = Math.max(0, marginReleased + pnl);
  portfolio.cash = (Number(portfolio.cash) || 0) + proceeds + (Number(order.margin) || 0);
  if (order.shares >= shares - 0.0001) delete positions[order.sym];
  else {
    position.shares = shares - order.shares;
    position.margin = Math.max(0, (Number(position.margin) || 0) * (1 - frac));
  }
  return { shares: order.shares, price: fillPrice, proceeds, pnl };
}
