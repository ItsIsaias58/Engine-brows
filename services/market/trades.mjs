// el mercado de trueque: skins cambian de dueño sin pasar por dinero. el
// diseño es el del banco (transferCash): ambos libros se escriben en una sola
// llamada atómica del server, la oferta vive en el portfolio de AMBOS
// (ofertante y receptor) y cualquier save desincronizado no puede mintear
// skins ni duplicarlas — el id de skin viaja, no un objeto copiado.
//
// flujo: ofertar (dáselo a X) → X abre "Tradeos" y ve la oferta entrante →
// aceptar (intercambio atómico) o rechazar. el ofertante puede cancelar
// mientras siga pendiente. cada paso notifica a la otra parte por el canal de
// finanzas (el mismo que usan transferencias y dividendos).
//
// nada de esto se decide en el cliente: el server valida propiedad, existencia
// y contraparte, y mueve los items entre inventarios él mismo.

export const TRADES_CAP = 40; // historial por lado (enviadas + recibidas)
export const TRADE_SIDES_CAP = 12; // skins por lado de una oferta
export const TRADE_EXPIRE_MS = 3 * 24 * 60 * 60 * 1000; // 3 días de vida

export function defaultTrades() {
  return { sent: [], received: [], seq: 0 };
}

// el catálogo viaja desde skins.mjs: una oferta sólo puede pedir items que
// existen en las cajas (el accept repite la validación contra los inventarios
// reales, así que esto es una primera cerca barata)
let catalogItems = null;
export function setTradeCatalog(catalog) {
  try {
    const set = new Set();
    for (const c of Object.values(catalog?.cases || {})) {
      for (const pool of Object.values(c.pools || {})) {
        for (const name of pool.items || []) set.add(name);
      }
    }
    catalogItems = set;
  } catch {
    catalogItems = null;
  }
}

function entryBase(id, at) {
  return {
    id,
    at,
    expiresAt: at + TRADE_EXPIRE_MS,
    status: 'pending', // pending | accepted | declined | cancelled | expired
  };
}

// ---- proponer una oferta --------------------------------------------------
// from/to son cuentas completas del store. give: ids de skins del ofertante,
// want: items nombrados del catálogo que el ofertante desea recibir.
export function proposeTrade({ from, to, toName: _toName, give = [], want = [], note = '' }) {
  if (!from || !to) return { ok: false, error: 'contraparte desconocida' };
  if (from === to) return { ok: false, error: 'no puedes tradear contigo mismo' };

  ensureBooks(from, to);
  const fromBook = from.portfolio.skins;
  const toBook = to.portfolio.skins;

  const giveIds = [...new Set((Array.isArray(give) ? give : []).map((x) => String(x || '').slice(0, 24)))].slice(0, TRADE_SIDES_CAP);
  const wantNames = [...new Set((Array.isArray(want) ? want : []).map((x) => String(x || '').slice(0, 64)))].slice(0, TRADE_SIDES_CAP);
  if (!giveIds.length && !wantNames.length) return { ok: false, error: 'una oferta vacía no es una oferta' };

  // cada id debe existir Y ser del ofertante; los items van como objetos reales
  const giveItems = [];
  for (const id of giveIds) {
    const idx = fromBook.inventory.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, error: 'una de las skins ya no está en tu inventario' };
    giveItems.push(fromBook.inventory[idx]);
  }
  // lo pedido debe ser del catálogo (nada de pedir "AWP | Imposible")
  for (const name of wantNames) {
    if (catalogItems && !catalogItems.has(name)) {
      return { ok: false, error: `"${name}" no existe en las cajas` };
    }
  }

  // no duplicar ofertas pendientes idénticas contra la misma persona
  const already = toBook.trades.received.some(
    (t) => t.status === 'pending' && t.fromKey === accountKeyOf(from) && sameWant(t.want, wantNames),
  );
  if (already) return { ok: false, error: 'ya tienes una oferta igual pendiente con ese jugador' };

  fromBook.seq = (Number(fromBook.seq) || 0) + 1;
  const id = `tr-${Date.now().toString(36)}-${fromBook.seq}`;
  const at = Date.now();

  const outEntry = {
    ...entryBase(id, at),
    dir: 'sent',
    toKey: accountKeyOf(to),
    toName: to.name,
    give: giveItems,
    want: wantNames,
    note: String(note || '').slice(0, 120),
  };
  const inEntry = {
    ...entryBase(id, at),
    dir: 'received',
    fromKey: accountKeyOf(from),
    fromName: from.name,
    give: giveItems,
    want: wantNames,
    note: outEntry.note,
  };

  fromBook.trades = recordTrade(fromBook.trades, 'sent', outEntry);
  toBook.trades = recordTrade(toBook.trades, 'received', inEntry);
  return { ok: true, id, to: to.name };
}

// ---- aceptar: el intercambio atómico --------------------------------------
// los objetos de skin viajaron en la oferta, pero la verdad está en los
// inventarios: se re-valida que cada id siga en el ofertante y que el receptor
// tenga cada item pedido. si algo falta, la oferta queda rechazada.
export function acceptTrade({ from, to, tradeId }) {
  if (!from || !to) return { ok: false, error: 'contraparte desconocida' };
  ensureBooks(from, to);
  const fromBook = from.portfolio.skins;
  const toBook = to.portfolio.skins;

  const offer = toBook.trades.received.find((t) => t.id === String(tradeId || ''));
  if (!offer || offer.dir !== 'received') return { ok: false, error: 'esa oferta no existe' };
  if (offer.status !== 'pending') return { ok: false, error: 'esa oferta ya no está pendiente' };
  if (offer.expiresAt <= Date.now()) {
    offer.status = 'expired';
    const mirrored = fromBook.trades.sent.find((t) => t.id === offer.id);
    if (mirrored) mirrored.status = 'expired';
    return { ok: false, error: 'la oferta expiró' };
  }

  // re-validar el lado del ofertante (que no haya vendido las skins entretanto)
  const movers = [];
  for (const given of offer.give || []) {
    const idx = fromBook.inventory.findIndex((x) => x.id === given.id);
    if (idx < 0) {
      offer.status = 'declined';
      const mirrored = fromBook.trades.sent.find((t) => t.id === offer.id);
      if (mirrored) mirrored.status = 'declined';
      return { ok: false, error: 'el ofertante ya no tiene una de las skins' };
    }
    movers.push(fromBook.inventory[idx]);
  }
  // y el lado del receptor: cada item pedido tiene que estar AHÍ
  const giveBack = [];
  for (const wantName of offer.want || []) {
    const idx = toBook.inventory.findIndex((x) => x.item === wantName);
    if (idx < 0) {
      offer.status = 'declined';
      const mirrored = fromBook.trades.sent.find((t) => t.id === offer.id);
      if (mirrored) mirrored.status = 'declined';
      return { ok: false, error: `no tienes "${wantName}" para completar el intercambio` };
    }
    giveBack.push(toBook.inventory[idx]);
  }

  // intercambio: de ofertante → receptor (give) y de receptor → ofertante (want)
  for (const given of movers) {
    const idx = fromBook.inventory.findIndex((x) => x.id === given.id);
    if (idx >= 0) fromBook.inventory.splice(idx, 1);
    toBook.inventory.push(given);
  }
  for (const wanted of giveBack) {
    const idx = toBook.inventory.findIndex((x) => x.id === wanted.id);
    if (idx >= 0) toBook.inventory.splice(idx, 1);
    fromBook.inventory.push(wanted);
  }

  offer.status = 'accepted';
  const mirrored = fromBook.trades.sent.find((t) => t.id === offer.id);
  if (mirrored) mirrored.status = 'accepted';
  return { ok: true, received: movers, sent: giveBack, with: from.name };
}

// ---- rechazar / cancelar ---------------------------------------------------
export function resolveTrade({ portfolio, side, tradeId, status }) {
  const book = portfolio.skins;
  if (!book) return { ok: false, error: 'inventario no disponible' };
  const list = side === 'received' ? book.trades.received : book.trades.sent;
  const other = side === 'received' ? book.trades.sent : book.trades.received;
  const offer = list.find((t) => t.id === String(tradeId || ''));
  if (!offer) return { ok: false, error: 'esa oferta no existe' };
  if (offer.status !== 'pending') return { ok: false, error: 'esa oferta ya no está pendiente' };
  offer.status = status;
  // el espejo del otro lado cambia de estado aunque la contraparte esté offline:
  // vive en SU portfolio y el próximo save suyo lo lleva
  const mirrored = other.find((t) => t.id === offer.id);
  if (mirrored) mirrored.status = status;
  return { ok: true, offer };
}

// ---- helpers ---------------------------------------------------------------

function accountKeyOf(account) {
  return String(account?.name ?? '').trim().toLowerCase();
}

function sameWant(a = [], b = []) {
  if (a.length !== b.length) return false;
  const setA = [...a].sort().join('\n');
  const setB = [...b].sort().join('\n');
  return setA === setB;
}

function recordTrade(trades, side, entry) {
  const book = trades && typeof trades === 'object' ? trades : defaultTrades();
  const list = side === 'sent' ? 'sent' : 'received';
  if (!Array.isArray(book[list])) book[list] = [];
  book[list].unshift(entry);
  if (book[list].length > TRADES_CAP) book[list].length = TRADES_CAP;
  return book;
}

// ---- saneo (lo que viaja en PUT /me) ---------------------------------------
// las ofertas son punteros a skins reales; un save manipulado no puede mintear
// items: cada skin de "give" se re-valida contra el catálogo y los valores se
// recalculan de los rangos de la caja, no se aceptan del cliente.
import { CASES, RARITIES, WEAR_NAMES, defaultSkins, clampLegitValue } from './skins.mjs';

// garantizar el libro de skins/tradeos de una cuenta (jugadores que nunca
// abrieron cajas tienen portfolio.skins vacío — pueden tradear igual)
function ensureBooks(...accounts) {
  for (const a of accounts) {
    if (!a || !a.portfolio) continue;
    if (!a.portfolio.skins || typeof a.portfolio.skins !== 'object') a.portfolio.skins = defaultSkins();
    const book = a.portfolio.skins;
    if (!book.trades || typeof book.trades !== 'object') book.trades = { sent: [], received: [], seq: 0 };
    if (!Array.isArray(book.trades.sent)) book.trades.sent = [];
    if (!Array.isArray(book.trades.received)) book.trades.received = [];
    if (!Array.isArray(book.inventory)) book.inventory = [];
  }
}

export function sanitizeTrades(input) {
  const base = defaultTrades();
  if (!input || typeof input !== 'object') return base;
  const out = base;
  out.seq = Math.max(0, Math.round(Number(input.seq) || 0));
  for (const side of ['sent', 'received']) {
    if (!Array.isArray(input[side])) continue;
    for (const raw of input[side].slice(0, TRADES_CAP)) {
      if (!raw || typeof raw !== 'object') continue;
      const give = [];
      for (const g of (Array.isArray(raw.give) ? raw.give : []).slice(0, TRADE_SIDES_CAP)) {
        if (!g || typeof g !== 'object') continue;
        const caseDef = CASES[String(g.caseId || '')];
        if (!caseDef) continue;
        const pool = caseDef.pools[String(g.rarity || '')];
        if (!pool || !pool.items.includes(String(g.item))) continue;
        const rarity = RARITIES[String(g.rarity)] || RARITIES.milspec;
        const wear = WEAR_NAMES[g.wear] ? String(g.wear) : 'FT';
        const stattrak = g.stattrak === true;
        give.push({
          id: String(g.id || '').slice(0, 24) || `sk-x`,
          caseId: caseDef.id,
          rarity: String(g.rarity),
          rarityName: rarity.name,
          color: rarity.color,
          item: String(g.item),
          wear,
          wearName: WEAR_NAMES[wear] || 'Field-Tested',
          stattrak,
          // el value no se acepta del cliente: se recorta al rango de la caja
          value: clampLegitValue(g.value, caseDef.id, String(g.rarity), wear, stattrak),
          at: Math.max(0, Math.round(Number(g.at) || Date.now())),
        });
      }
      const want = (Array.isArray(raw.want) ? raw.want : [])
        .map((x) => String(x || '').slice(0, 64))
        .filter((x) => !catalogItems || catalogItems.has(x))
        .slice(0, TRADE_SIDES_CAP);
      const status = ['pending', 'accepted', 'declined', 'cancelled', 'expired'].includes(raw.status) ? raw.status : 'pending';
      out[side].push({
        id: String(raw.id || '').slice(0, 40) || `tr-x`,
        at: Math.max(0, Math.round(Number(raw.at) || Date.now())),
        expiresAt: Math.max(0, Math.round(Number(raw.expiresAt) || Date.now() + TRADE_EXPIRE_MS)),
        status,
        dir: side,
        ...(side === 'sent'
          ? { toKey: String(raw.toKey || '').slice(0, 40), toName: String(raw.toName || '').slice(0, 32) }
          : { fromKey: String(raw.fromKey || '').slice(0, 40), fromName: String(raw.fromName || '').slice(0, 32) }),
        give,
        want,
        note: String(raw.note || '').slice(0, 120),
      });
    }
  }
  return out;
}
