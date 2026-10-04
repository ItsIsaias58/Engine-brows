// sondo, la casa de encuestas del piso de trading. el servidor abre sondeos
// "¿sube o baja {sym} antes de que cierre el día?" cada cierto tiempo, los
// jugadores votan (cobran una recompensa por participar, una vez por sondeo) y
// al resolverse el voto colectivo empuja levemente el precio: sentimiento de
// mercado con peso real en la cinta. el admin puede abrir sondeos a mano
// (con la pregunta y el símbolo que quiera) desde su consola.
import { adminShock } from './engine.mjs';

export const POLL_REWARD = 25; // por votar, una vez por sondeo
export const POLL_MAX_MOVEMENT = 4; // el sentimiento mueve a lo más ±4%
export const POLL_MIN_DURATION_MS = 3 * 60 * 1000;
export const POLL_MAX_DURATION_MS = 45 * 60 * 1000;

// --------------------------------------------------------------------- estado

// en memoria: los sondeos son efímeros por diseño (una encuesta vieja no
// sirve de nada tras cerrarse), pero el resultado queda en el log del admin
let polls = [];
let nextId = 1;

export function pollsState() {
  return polls;
}

// el ticker de votantes: nombres normalizados que ya votaron este sondeo
function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

export function resetPolls() {
  polls = [];
  nextId = 1;
}

// ----------------------------------------------------------------- apertura

// abre un sondeo. auto: el server elige símbolo y dura un rato; custom: el
// admin manda pregunta, símbolo y duración. devuelve el sondeo público.
export function openPoll(market, { question, sym, durationMs, custom = false } = {}) {
  const symbols = market.symbols || [];
  if (!symbols.length) return null;
  const target = sym
    ? symbols.find((s) => s.sym === sym)
    : symbols[Math.floor(Math.random() * symbols.length)];
  if (!target) return null;

  const dur = Math.max(POLL_MIN_DURATION_MS, Math.min(POLL_MAX_DURATION_MS, Number(durationMs) || 8 * 60 * 1000));
  const poll = {
    id: nextId++,
    question: String(question || `¿Sube o baja ${target.sym} al cierre?`).slice(0, 140),
    sym: target.sym,
    up: 0,
    down: 0,
    voters: [],
    openedAt: Date.now(),
    closesAt: Date.now() + dur,
    custom: custom === true,
    status: 'open',
    result: null,
    // el precio al abrir: al cerrar se compara con el real para saber si la
    // mayoría acertó (eso decide el sonido del cierre, no el movimiento)
    openingPrice: Number(target.price) || Number(target.livePrice) || 0,
  };
  polls = polls.filter((p) => p.status === 'open'); // los cerrados no se acumulan
  polls.push(poll);
  return publicPoll(poll);
}

// el sondeo como lo ve el cliente: sin la lista de votantes
export function publicPoll(poll) {
  if (!poll) return null;
  return {
    id: poll.id,
    question: poll.question,
    sym: poll.sym,
    up: poll.up,
    down: poll.down,
    total: poll.up + poll.down,
    closesAt: poll.closesAt,
    openedAt: poll.openedAt,
    custom: poll.custom,
    status: poll.status,
    result: poll.result,
    reward: POLL_REWARD,
  };
}

export function activePoll() {
  const open = polls.find((p) => p.status === 'open' && p.closesAt > Date.now());
  return open ? publicPoll(open) : null;
}

// ---------------------------------------------------------------------- voto

// vota y paga la recompensa. devuelve { ok, poll, reward } o { ok:false, error }.
// el money-move es responsabilidad del caller: aquí sólo se valida y se cuenta,
// y de vuelta va el reward para que el server lo acredite donde debe.
export function castVote(pollId, side, accountName, portfolio) {
  const poll = polls.find((p) => p.id === Number(pollId) && p.status === 'open');
  if (!poll) return { ok: false, error: 'no hay sondeo activo con ese id' };
  if (poll.closesAt <= Date.now()) return { ok: false, error: 'el sondeo ya cerró' };
  const sideNorm = side === 'up' || side === 'down' ? side : null;
  if (!sideNorm) return { ok: false, error: 'voto inválido: up o down' };
  const voter = normalizeName(accountName);
  if (poll.voters.includes(voter)) return { ok: false, error: 'ya votaste en este sondeo' };

  poll.voters.push(voter);
  if (sideNorm === 'up') poll.up += 1;
  else poll.down += 1;
  // la recompensa cae directo al cash del votante (el server persiste)
  if (portfolio) portfolio.cash = (Number(portfolio.cash) || 0) + POLL_REWARD;
  return { ok: true, poll: publicPoll(poll), reward: POLL_REWARD };
}

// ---------------------------------------------------------------- resolución

// cierra los sondeos vencidos. el voto colectivo mueve el precio vía
// adminShock (gradual, el mismo canal que usan los eventos del admin):
// mayoría alcista -> empujón para arriba, bajista -> para abajo. el tamaño
// escala con la unanimidad (un 50.1% apenas se nota, un 90% se siente).
// devuelve { closed: [sondeos públicos resueltos], shocks: [{ sym, pct }] }
export function resolveDuePolls(market) {
  const now = Date.now();
  const closed = [];
  const shocks = [];
  for (const poll of polls) {
    if (poll.status !== 'open' || poll.closesAt > now) continue;
    poll.status = 'closed';
    const total = poll.up + poll.down;
    if (total === 0) {
      poll.result = { outcome: 'no-votes', majority: null, pct: 0, move: 0 };
      closed.push(publicPoll(poll));
      continue;
    }
    const majority = poll.up === poll.down ? null : poll.up > poll.down ? 'up' : 'down';
    const share = total > 0 ? Math.abs(poll.up - poll.down) / total : 0;
    // el movimiento: unanimidad^2 * tope. un 100% a favor mueve el tope
    // completo, un 60% apenas un susurro. siempre a favor de la mayoría.
    const move = majority ? Number(((share ** 2) * POLL_MAX_MOVEMENT).toFixed(3)) : 0;
    // ¿acertó la mayoría? el precio real del símbolo decide: se compara el
    // cierre contra el precio de apertura del sondeo
    const symbol = (market.symbols || []).find((s) => s.sym === poll.sym);
    const closing = Number(symbol?.price) || Number(symbol?.livePrice) || poll.openingPrice;
    const drift = closing > poll.openingPrice * 1.001 ? 'up' : closing < poll.openingPrice * 0.999 ? 'down' : 'flat';
    poll.result = { outcome: drift, majority, share: Number((share * 100).toFixed(1)), move, openingPrice: poll.openingPrice, closingPrice: closing };
    if (majority && move > 0) {
      const pct = majority === 'up' ? move : -move;
      const applied = adminShock(market, poll.sym, pct, true);
      if (applied) shocks.push({ sym: poll.sym, pct });
    }
    closed.push(publicPoll(poll));
  }
  polls = polls.filter((p) => p.status === 'open' || now - (p.closesAt || 0) < 10 * 60 * 1000);
  return { closed, shocks };
}

// --------------------------------------------------------------- admin

// el admin ve la lista (para su consola) y puede cerrar uno a mano
export function adminPollsList() {
  return { polls: polls.map(publicPoll), active: activePoll(), reward: POLL_REWARD };
}

export function adminClosePoll(pollId) {
  const poll = polls.find((p) => p.id === Number(pollId) && p.status === 'open');
  if (!poll) return { error: 'no hay sondeo abierto con ese id' };
  poll.closesAt = Date.now() - 1; // vence ya; el próximo tick lo resuelve
  return { ok: true, id: poll.id };
}
