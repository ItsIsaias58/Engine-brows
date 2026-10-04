// opencase, la casa de cajas estilo CS:GO. el jugador paga el costo de una
// caja con su cash (el mismo del banco y del casino), el server rueda la skin
// (rareza -> item -> desgaste -> StatTrak), la guarda en el inventario y el
// jugador la vende cuando quiera. nada de esto se decide en el cliente: el
// cliente sólo anima lo que el server le dice que salió.

// el libro de trueques se sanea en trades.mjs (import circular seguro: ambos
// módulos sólo se llaman en tiempo de ejecución, nunca al evaluarse)
import { sanitizeTrades } from './trades.mjs';
//
// el valor esperado de una caja ronda 0.85-0.90x su costo: abrir es un sink de
// dinero con adrenaline, vender la skin es la única forma de recuperarla, y el
// dinero siempre vive en el mismo portfolio que la bolsa y el banco.

export const SKINS_INVENTORY_CAP = 200;
export const STATTRAK_CHANCE = 0.10; // 10% de las skins vienen StatTrak
export const STATTRAK_MULT = 1.5;

// desgastes estilo CS:GO con su multiplicador de valor
const WEARS = [
  { id: 'FN', name: 'Factory New', w: 30, mult: 1.35 },
  { id: 'MW', name: 'Minimal Wear', w: 30, mult: 1.15 },
  { id: 'FT', name: 'Field-Tested', w: 25, mult: 1.0 },
  { id: 'WW', name: 'Well-Worn', w: 10, mult: 0.85 },
  { id: 'BS', name: 'Battle-Scarred', w: 5, mult: 0.7 },
];

const RARITIES = {
  milspec:    { name: 'Militar',     color: '#4b69ff', w: 60 },
  restricted: { name: 'Restringido', color: '#8847ff', w: 25 },
  classified: { name: 'Clasificado', color: '#d32ce6', w: 10 },
  covert:     { name: 'Encubierto',  color: '#eb4b4b', w: 4 },
  gold:       { name: '★ Excepcional', color: '#ffd700', w: 1 },
};
export { RARITIES };

export const WEAR_NAMES = WEARS.reduce((acc, w) => { acc[w.id] = w.name; return acc; }, {});

// el catálogo: cada caja con su pool de items por rareza y el rango de valor
// (en múltiplos del costo de la caja) ANTES de desgaste y StatTrak. los rangos
// están calibrados para que el EV total ronde 0.85-0.90 del costo.
export const CASES = {
  barrio: {
    id: 'barrio',
    name: 'Caja del Barrio',
    cost: 2_000,
    color: '#5b8cff',
    pools: {
      milspec:    { mult: [0.12, 0.38], items: ['M249 | Warbird', 'FAMAS | Survivor Z', 'MAG-7 | Sonar', 'Sawed-Off | Lunar Wyrm', 'AWP | Acheron'] },
      restricted: { mult: [0.40, 0.85], items: ["CZ75-Auto | Tigris", 'Tec-9 | Avalanche', 'Desert Eagle | Naga', 'MP7 | Ocean Foam'] },
      classified: { mult: [1.1, 2.0],   items: ['SCAR-20 | Bloodsport', 'AK-47 | Nouveau Rouge', "P250 | Apep's Curse"] },
      covert:     { mult: [2.8, 4.8],   items: ["AWP | Man-o'-war", 'AK-47 | Neon Revolution'] },
      gold:       { mult: [9.0, 16.0],  items: ['★ M9 Bayonet | Blue Steel', '★ Flip Knife | Urban Masked', '★ Karambit | Freehand'] },
    },
  },
  comp: {
    id: 'comp',
    name: 'Caja Competitiva',
    cost: 15_000,
    color: '#29e0a8',
    pools: {
      milspec:    { mult: [0.12, 0.38], items: ['PP-Bizon | Jungle Slipstream', 'Galil AR | Tuxedo', 'CZ75-Auto | Vendetta', 'P250 | Black & Tan', 'MP5-SD | Gold Leaf'] },
      restricted: { mult: [0.40, 0.85], items: ['PP-Bizon | Fuel Rod', 'USP-S | Flashback', 'Dual Berettas | Hydro Strike', 'Glock-18 | Block-18'] },
      classified: { mult: [1.1, 2.0],   items: ['UMP-45 | Fade', 'Tec-9 | Fuel Injector', 'SG 553 | Cyrex'] },
      covert:     { mult: [2.8, 4.8],   items: ['AK-47 | Nightwish', 'M4A4 | Temukau'] },
      gold:       { mult: [9.0, 16.0],  items: ['★ Survival Knife | Tiger Tooth', '★ Stiletto Knife | Night Stripe', '★ Kukri Knife | Night Stripe'] },
    },
  },
  cartera: {
    id: 'cartera',
    name: 'Caja del Coleccionista',
    cost: 60_000,
    color: '#f2b84b',
    pools: {
      milspec:    { mult: [0.12, 0.38], items: ['Galil AR | Destroyer', 'AWP | Black Nile', 'P250 | Small Game', 'Dual Berettas | Elite 1.6', 'P2000 | Turf'] },
      restricted: { mult: [0.40, 0.85], items: ['P250 | Nevermore', 'FAMAS | ZX Spectron', 'UMP-45 | Plastique', 'Dual Berettas | Sweet Little Angels'] },
      classified: { mult: [1.1, 2.0],   items: ['SCAR-20 | Cyrex', 'P2000 | Imperial Dragon', 'Sawed-Off | Kiss♥Love'] },
      covert:     { mult: [2.8, 4.8],   items: ['USP-S | Printstream', "M4A1-S | Chantico's Fire"] },
      gold:       { mult: [9.0, 16.0],  items: ['★ Stiletto Knife | Blue Steel', '★ Bowie Knife | Boreal Forest', '★ Stiletto Knife'] },
    },
  },
};

export function defaultSkins() {
  return { inventory: [], stats: { opened: 0, spent: 0, earned: 0 }, seq: 0, trades: { sent: [], received: [], seq: 0 } };
}

// catálogo público (sin datos de usuario): la página de opencase lo usa para
// pintar las cajas y para que el MODO INVITADO ruede con exactamente los
// mismos pesos que el server. una sola fuente de verdad.
export function skinsCatalog() {
  return {
    cases: CASES,
    rarities: RARITIES,
    wears: WEARS,
    stattrak: { chance: STATTRAK_CHANCE, mult: STATTRAK_MULT },
    cap: SKINS_INVENTORY_CAP,
  };
}

function round(v) { return Math.round(v); }

function pickWeighted(list, keyOf) {
  const total = list.reduce((s, x) => s + keyOf(x), 0);
  let r = Math.random() * total;
  for (const x of list) { r -= keyOf(x); if (r <= 0) return x; }
  return list[list.length - 1];
}

// rueda una skin completa: rareza -> item -> desgaste -> StatTrak -> valor
function rollItem(caseDef) {
  const entries = Object.entries(caseDef.pools);
  const [rarityId, pool] = pickWeighted(entries, ([rid]) => RARITIES[rid].w);
  const rarity = RARITIES[rarityId];
  const item = pool.items[Math.floor(Math.random() * pool.items.length)];
  const wear = pickWeighted(WEARS, (w) => w.w);
  const stattrak = Math.random() < STATTRAK_CHANCE;
  const [lo, hi] = pool.mult;
  let value = caseDef.cost * (lo + Math.random() * (hi - lo));
  value *= wear.mult;
  if (stattrak) value *= STATTRAK_MULT;
  return {
    rarity: rarityId, rarityName: rarity.name, color: rarity.color,
    item, wear: wear.id, wearName: wear.name, stattrak,
    value: round(Math.max(50, value)),
  };
}

// acciones del libro de skins. opera directamente sobre el portfolio (cash) y
// devuelve { ok, ... } como casino.mjs para que el server la trate igual.
export function skinsAction(portfolio, action, body = {}) {
  if (portfolio.bankrupt === true) {
    return { ok: false, error: 'estás en bancarrota: ni el mercado negro da crédito' };
  }
  if (!portfolio.skins || typeof portfolio.skins !== 'object') portfolio.skins = defaultSkins();
  const book = portfolio.skins;
  if (!book.stats || typeof book.stats !== 'object') book.stats = { opened: 0, spent: 0, earned: 0 };
  if (!Array.isArray(book.inventory)) book.inventory = [];

  const cash = () => Number(portfolio.cash) || 0;

  // ---- abrir una caja -----------------------------------------------------
  if (action === 'open') {
    const caseDef = CASES[String(body.caseId || '')];
    if (!caseDef) return { ok: false, error: 'caja desconocida' };
    if (book.inventory.length >= SKINS_INVENTORY_CAP) {
      return { ok: false, error: `inventario lleno (${SKINS_INVENTORY_CAP}) — vende algo primero` };
    }
    const cost = caseDef.cost;
    if (cash() < cost) return { ok: false, error: 'cash insuficiente para esta caja' };
    portfolio.cash = round(cash() - cost);
    const item = rollItem(caseDef);
    book.seq = (Number(book.seq) || 0) + 1;
    const entry = { id: `sk-${book.seq}`, caseId: caseDef.id, at: Date.now(), ...item };
    // guardar es el default: la skin entra al inventario YA. el cliente puede
    // venderla desde el resultado sin pasos extra; 'sell' por id la retira.
    book.inventory.push(entry);
    book.stats.opened += 1;
    book.stats.spent += cost;
    return { ok: true, item: entry, cash: portfolio.cash };
  }

  // ---- guardar explicito: la skin ya estaba guardada desde el open --------
  if (action === 'keep') {
    const entry = book.inventory.find((x) => x.id === String(body.itemId || ''));
    if (!entry) return { ok: false, error: 'esa skin ya no está en tu inventario' };
    return { ok: true, item: entry, cash: portfolio.cash };
  }

  // ---- vender una skin del inventario -------------------------------------
  if (action === 'sell') {
    const idx = book.inventory.findIndex((x) => x.id === String(body.itemId || ''));
    if (idx < 0) return { ok: false, error: 'esa skin no está en tu inventario' };
    const [item] = book.inventory.splice(idx, 1);
    portfolio.cash = round(cash() + item.value);
    book.stats.earned += item.value;
    return { ok: true, sold: item, cash: portfolio.cash };
  }

  // ---- vender todo (con confirmación del cliente) --------------------------
  if (action === 'sellAll') {
    if (!book.inventory.length) return { ok: false, error: 'el inventario ya está vacío' };
    let total = 0;
    for (const item of book.inventory) total += item.value;
    const count = book.inventory.length;
    book.inventory = [];
    portfolio.cash = round(cash() + total);
    book.stats.earned += total;
    return { ok: true, count, total, cash: portfolio.cash };
  }

  return { ok: false, error: 'acción desconocida' };
}

// mensaje en vivo que acompaña a toda mutación del libro de skins. se emite
// por el websocket para que la bolsa y el resto de pestañas lo vean al toque.
export function skinsUpdateEvent(kind, extra = {}) {
  return { type: 'skins-update', kind, ...extra };
}

// para el GET del server: el libro + el catálogo
export function skinsSnapshot(portfolio) {
  const book = (portfolio.skins && typeof portfolio.skins === 'object') ? portfolio.skins : defaultSkins();
  const trades = (book.trades && typeof book.trades === 'object') ? book.trades : { sent: [], received: [] };
  return {
    catalog: Object.values(CASES).map((c) => ({ id: c.id, name: c.name, cost: c.cost, color: c.color })),
    inventory: Array.isArray(book.inventory) ? book.inventory : [],
    trades: {
      sent: Array.isArray(trades.sent) ? trades.sent : [],
      received: Array.isArray(trades.received) ? trades.received : [],
    },
    stats: book.stats && typeof book.stats === 'object'
      ? {
          opened: Number(book.stats.opened) || 0,
          spent: Number(book.stats.spent) || 0,
          earned: Number(book.stats.earned) || 0,
        }
      : { opened: 0, spent: 0, earned: 0 },
    cap: SKINS_INVENTORY_CAP,
  };
}

// el libro que viaja en PUT /me: validamos forma, no valores (el dinero no
// vive aquí, vive en cash; los items son cosméticos + valor de reventa)
export function sanitizeSkins(input) {
  const base = defaultSkins();
  if (!input || typeof input !== 'object') return base;
  const out = base;
  out.seq = Math.max(0, Math.round(Number(input.seq) || 0));
  // el libro de trueques viaja junto al de skins: se sanea en trades.mjs, que
  // re-valida cada skin contra el catálogo igual que el inventario
  if (input.trades && typeof input.trades === 'object') {
    out.trades = sanitizeTrades(input.trades);
  }
  if (input.stats && typeof input.stats === 'object') {
    out.stats = {
      opened: Math.max(0, Math.round(Number(input.stats.opened) || 0)),
      spent: Math.min(1e15, Math.max(0, Number(input.stats.spent) || 0)),
      earned: Math.min(1e15, Math.max(0, Number(input.stats.earned) || 0)),
    };
  }
  if (Array.isArray(input.inventory)) {
    for (const raw of input.inventory.slice(0, SKINS_INVENTORY_CAP)) {
      if (!raw || typeof raw !== 'object') continue;
      const caseDef = CASES[String(raw.caseId || '')];
      if (!caseDef) continue;
      const pool = caseDef.pools[String(raw.rarity || '')];
      if (!pool) continue;
      const items = pool.items;
      out.inventory.push({
        id: String(raw.id || '').slice(0, 24) || `sk-${++out.seq}`,
        caseId: caseDef.id,
        rarity: String(raw.rarity),
        rarityName: RARITIES[String(raw.rarity)].name,
        color: RARITIES[String(raw.rarity)].color,
        item: items.includes(String(raw.item)) ? String(raw.item) : items[0],
        wear: WEARS.some((w) => w.id === raw.wear) ? String(raw.wear) : 'FT',
        wearName: (WEARS.find((w) => w.id === raw.wear) || WEARS[2]).name,
        stattrak: raw.stattrak === true,
        value: Math.min(1e12, Math.max(1, Math.round(Number(raw.value) || 0))),
        at: Math.max(0, Math.round(Number(raw.at) || Date.now())),
      });
    }
  }
  return out;
}
