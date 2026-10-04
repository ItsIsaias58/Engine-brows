// el libro mayor de la bolsa: la única autoridad sobre el dinero.
//
// ANTES: el navegador calculaba las operaciones a mercado (buyShares/sellShares
// en js/order.js mutaban state.cash y state.positions) y el autoguardado
// persistía lo que el cliente decía. Eso convertía PUT /api/market/me en una
// puerta trasera a la economía entera: con un solo PUT se pasaba de 10.000 a
// 999.999.999 de cash, y el ranking aceptaba best=9e11 sin pestañear.
//
// AHORA: el cliente sigue calculando igual (para que la respuesta sea
// inmediata) pero manda el REGISTRO de operaciones, y este módulo las
// reproduce sobre el estado del servidor. El cliente manda la INTENCIÓN
// (qué símbolo, cuántas acciones, qué apalancamiento); el precio lo pone la
// cinta del servidor, nunca el cliente. Lo que el servidor no reproduce no
// existe: el autoguardado ya no puede mover el cash.
//
// La aritmética de applyBuy/applySell está copiada literalmente de buyShares y
// sellShares del cliente para que las dos rutas (con sesión e invitado) den el
// mismo número. Si se toca una, hay que tocar la otra.
import { MARKET_SYMBOLS } from './companies.mjs';

export const RECAP_CASH = 10000; // lo que llega tras la bancarrota
export const BANKRUPT_WAIT_MS = 60_000; // un minuto real de espera
// tope de operaciones por autoguardado. el cliente vacía la cola mucho antes
// (ver flushLedger en net.js); el límite sólo corta a un cliente manipulado
const MAX_OPS_PER_SAVE = 500;
const MAX_SHARES = 1e12;
const MAX_LEVERAGE = 20; // el mismo techo que impone orders.mjs

const SYMBOLS = new Set(MARKET_SYMBOLS.map((s) => s.sym));

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// el precio de la cinta, no el que manda el cliente
export function livePrice(quotes, sym) {
  const quote = quotes?.get?.(sym);
  const price = quote ? finite(quote.live, NaN) : NaN;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function pushTransaction(portfolio, entry) {
  const list = Array.isArray(portfolio.transactions) ? portfolio.transactions : [];
  list.unshift(entry);
  if (list.length > 200) list.length = 200;
  portfolio.transactions = list;
}

function stamp() {
  return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

// una compra a mercado. espejo exacto de buyShares() en js/order.js, con el
// precio tomado de la cinta del servidor en lugar del m.price del navegador.
function applyBuy(portfolio, op, price) {
  const shares = Math.floor(finite(op.shares));
  if (shares <= 0 || shares > MAX_SHARES) return { ok: false, error: 'cantidad inválida' };
  const lev = clamp(Math.round(finite(op.leverage, 1)), 1, MAX_LEVERAGE);
  const positions = portfolio.positions || (portfolio.positions = {});
  const pos = positions[op.sym] || { shares: 0, avgPrice: 0, leverage: lev, margin: 0 };
  const held = finite(pos.shares);
  const newShares = held + shares;
  const newAvgPrice = (finite(pos.avgPrice) * held + price * shares) / newShares;
  const newLeverage = (finite(pos.leverage, lev) * held + lev * shares) / newShares;
  const newMargin = (newAvgPrice * newShares) / newLeverage;
  const marginDelta = newMargin - finite(pos.margin);

  if (marginDelta > finite(portfolio.cash) + 0.001) {
    return { ok: false, error: 'fondos insuficientes' };
  }
  portfolio.cash = finite(portfolio.cash) - marginDelta;
  // tp/sl/trailing vienen del input del usuario en el panel de orden: no son
  // dinero, son las órdenes de salida que el jugador se coloca a sí mismo
  const tp = op.tp === null || op.tp === undefined ? (pos.tp || null) : finite(op.tp, 0) || null;
  const sl = op.sl === null || op.sl === undefined ? (pos.sl || null) : finite(op.sl, 0) || null;
  const trailPct = op.trailPct === null || op.trailPct === undefined
    ? (pos.trailPct || null)
    : (Number.isFinite(op.trailPct) ? Math.abs(op.trailPct) || null : null);
  positions[op.sym] = {
    shares: newShares,
    avgPrice: newAvgPrice,
    leverage: newLeverage,
    margin: newMargin,
    tp,
    sl,
    trailPct,
    // el pico del trailing arranca en el precio de esta compra, igual que en
    // el cliente (que escribe trailPeak cuando llega la orden con trailPct)
    trailPeak: op.trailPct !== null && op.trailPct !== undefined ? price : (pos.trailPeak || price),
  };
  pushTransaction(portfolio, { sym: op.sym, type: 'Compra', shares, price, time: stamp(), leverage: lev });
  return { ok: true, shares, price, leverage: lev, margin: newMargin };
}

// una venta a mercado. espejo exacto de sellShares() en js/order.js, incluida
// la llamada a recordClosedTrade (mismas reglas de racha y mejor operación).
function applySell(portfolio, op, price) {
  const shares = Math.floor(finite(op.shares));
  if (shares <= 0) return { ok: false, error: 'cantidad inválida' };
  const positions = portfolio.positions || {};
  const pos = positions[op.sym];
  // una venta de cero no es una operación: registrarla inflaría totalTrades
  if (!pos || shares > finite(pos.shares) + 0.0001) {
    return { ok: false, error: 'acciones insuficientes' };
  }
  const held = finite(pos.shares);
  const fracSold = shares / held;
  const marginReleased = finite(pos.margin) * fracSold;
  const pnl = shares * (price - finite(pos.avgPrice));
  const proceeds = Math.max(0, marginReleased + pnl);
  portfolio.cash = finite(portfolio.cash) + proceeds;
  pos.shares = held - shares;
  pos.margin = Math.max(0, finite(pos.margin) - marginReleased);
  if (pos.shares <= 0.0001) delete positions[op.sym];
  recordClosedTrade(portfolio, pnl);
  pushTransaction(portfolio, { sym: op.sym, type: 'Venta', shares, price, time: stamp(), leverage: 1, pnl });
  return { ok: true, shares, price, proceeds, pnl };
}

// js/state.js recordClosedTrade, verbatim
function recordClosedTrade(portfolio, pnl) {
  const stats = portfolio.stats;
  stats.totalTrades += 1;
  if (pnl >= 0) {
    stats.wins += 1;
    stats.grossProfit += pnl;
    // la racha cuenta operaciones cerradas seguidas: una pérdida la reinicia
    stats.currentStreak += 1;
    stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak);
  } else {
    stats.losses += 1;
    stats.grossLoss += Math.abs(pnl);
    stats.currentStreak = 0;
  }
  stats.bestTrade = Math.max(stats.bestTrade, pnl);
}

// qué vale ahora una posición: su margen más el resultado no realizado. Se
// permite que sea negativa a propósito — cuando la pérdida apalancada se come
// el margen entero, la operación debe dinero, y esa es la señal que la cierra.
function positionContribution(portfolio, sym, price) {
  const pos = portfolio.positions?.[sym];
  if (!pos) return 0;
  return finite(pos.margin) + finite(pos.shares) * (price - finite(pos.avgPrice));
}

// el patrimonio total: efectivo + posiciones marcadas a la cinta. js/portfolio.js
// updatePerformancePanel hace exactamente esta suma.
function netWorth(portfolio, quotes) {
  let total = finite(portfolio.cash);
  for (const sym of Object.keys(portfolio.positions || {})) {
    const price = livePrice(quotes, sym);
    if (price === null) continue;
    total += positionContribution(portfolio, sym, price);
  }
  return total;
}

// una operación del registro, validada y aplicada. `at` es el reloj del juego
// en ms, que es lo que el cliente usa para numerar los días.
function applyOp(portfolio, op, quotes, now) {
  if (!op || typeof op !== 'object') return { ok: false, error: 'operación inválida' };
  const sym = String(op.sym || '').trim().toUpperCase();
  if (!SYMBOLS.has(sym)) return { ok: false, error: 'símbolo desconocido' };
  // en bancarrota la bolsa está cerrada: el panel ya bloquea los botones, esto
  // es el mismo cierre mirado desde el servidor
  if (portfolio.bankrupt === true) return { ok: false, error: 'cuenta en bancarrota' };
  const price = livePrice(quotes, sym);
  if (price === null) return { ok: false, error: 'sin precio de mercado' };

  if (op.kind === 'buy') {
    return { ok: true, kind: 'buy', sym, ...applyBuy(portfolio, { ...op, sym }, price), at: now };
  }
  if (op.kind === 'sell') {
    return { ok: true, kind: 'sell', sym, ...applySell(portfolio, { ...op, sym }, price), at: now };
  }
  return { ok: false, error: 'operación desconocida' };
}

// reproduce el registro entero. Lo que el servidor rechaza no se aplica: el
// cliente optimista se corrige al recibir la verdad de vuelta.
export function replayOps(portfolio, ops, quotes, now = Date.now()) {
  const list = Array.isArray(ops) ? ops : [];
  if (list.length > MAX_OPS_PER_SAVE) {
    return { results: [], overflow: true };
  }
  const results = [];
  for (const op of list) results.push(applyOp(portfolio, op, quotes, now));
  return { results, overflow: false };
}

// el take profit / stop loss / trailing del cliente (js/order.js checkTpSl y
// closeFullPosition) pasa a correr aquí, en el latido del servidor. El cliente
// conserva su copia para el modo invitado.
function runExitRules(portfolio, quotes) {
  const notices = [];
  for (const sym of Object.keys(portfolio.positions || {})) {
    const pos = portfolio.positions[sym];
    if (!pos || finite(pos.shares) <= 0) continue;
    const price = livePrice(quotes, sym);
    if (price === null) continue;
    if (finite(pos.trailPct) > 0) {
      const peak = Math.max(finite(pos.trailPeak, price), price);
      pos.trailPeak = peak;
      const trailStop = peak * (1 - pos.trailPct / 100);
      if (price <= trailStop) {
        const shares = pos.shares;
        const result = applySell(portfolio, { sym, shares }, price);
        if (result.ok) notices.push({ kind: 'exit', sym, shares, price, pnl: result.pnl, reason: 'Trailing stop activado' });
        continue;
      }
    }
    if (finite(pos.tp) > 0 && price >= pos.tp) {
      const shares = pos.shares;
      const result = applySell(portfolio, { sym, shares }, price);
      if (result.ok) notices.push({ kind: 'exit', sym, shares, price, pnl: result.pnl, reason: `Take profit alcanzado (${pos.tp.toFixed(2)})` });
      continue;
    }
    if (finite(pos.sl) > 0 && price <= pos.sl) {
      const shares = pos.shares;
      const result = applySell(portfolio, { sym, shares }, price);
      if (result.ok) notices.push({ kind: 'exit', sym, shares, price, pnl: result.pnl, reason: `Stop loss alcanzado (${pos.sl.toFixed(2)})` });
    }
  }
  return notices;
}

// el latido de riesgo: liquidaciones, bancarrota, recapitalización y el
// seguimiento del patrimonio. En el cliente esto vivía repartido entre
// checkLiquidations, checkBankruptcy, tickBankruptcy y trackNetProgress.
export function runRiskPass(portfolio, quotes, { now = Date.now(), gameDay = 0 } = {}) {
  const notices = [];
  const stats = portfolio.stats;

  // 1. recapitalización: seCredita cuando se cumple la espera, y no antes
  if (portfolio.bankrupt === true && now >= finite(portfolio.bankruptUntil)) {
    portfolio.bankrupt = false;
    portfolio.bankruptUntil = 0;
    portfolio.positions = {};
    // el cliente hacía cash = RECAP_CASH (asignación, no suma): en bancarrota el
    // efectivo ya es ~0 porque las posiciones se cerraron, así que es lo mismo
    portfolio.cash = RECAP_CASH;
    pushTransaction(portfolio, { sym: 'RECAP', type: 'Compra', shares: 0, price: RECAP_CASH, time: stamp() });
    notices.push({ kind: 'bankrupt-recap', cash: RECAP_CASH });
  }

  // 2. take profit / stop loss / trailing
  notices.push(...runExitRules(portfolio, quotes));

  // 3. liquidaciones: una posición apalancada que vale cero o menos se cierra
  // sola, y la pérdida se contabiliza como cualquier otra venta
  for (const sym of Object.keys(portfolio.positions || {})) {
    const price = livePrice(quotes, sym);
    if (price === null) continue;
    if (positionContribution(portfolio, sym, price) > 0.01) continue;
    const shares = finite(portfolio.positions[sym].shares);
    const pnl = shares * (price - finite(portfolio.positions[sym].avgPrice));
    delete portfolio.positions[sym];
    recordClosedTrade(portfolio, pnl);
    pushTransaction(portfolio, { sym, type: 'Venta', shares, price, time: stamp(), leverage: 1, pnl });
    notices.push({ kind: 'liquidated', sym, shares, price, pnl });
  }

  // 4. el patrimonio, medido antes de la bancarrota: el pico y el mejor día
  // leen la curva igual que lo hacía trackNetProgress en el cliente
  const nw = netWorth(portfolio, quotes);
  stats.peakNet = Math.max(finite(stats.peakNet), nw);
  if (portfolio.statsDay !== gameDay) {
    portfolio.statsDay = gameDay;
    portfolio.statsOpen = nw;
  } else if (portfolio.statsOpen > 0) {
    const ret = ((nw - portfolio.statsOpen) / portfolio.statsOpen) * 100;
    if (ret > finite(stats.bestDayReturn)) stats.bestDayReturn = ret;
  }

  // 5. bancarrota: el patrimonio a cero o negativo cierra todo y bloquea la
  // cuenta hasta que se acredite la recapitalización
  if (portfolio.bankrupt !== true && nw <= 0.01) {
    portfolio.positions = {};
    portfolio.bankrupt = true;
    portfolio.bankruptUntil = now + BANKRUPT_WAIT_MS;
    stats.timesBankrupt = finite(stats.timesBankrupt) + 1;
    notices.push({ kind: 'bankrupt', until: portfolio.bankruptUntil });
  }

  return notices;
}
