// las cajas de mercado del minijuego, con la ruleta en el servidor.
//
// La versión anterior vivía entera en js/cases.js: el coste se cobraba en el
// navegador y la recompensa se sorteaba con Math.random() en la pestaña. Eso
// era, literalmente, un mint de dinero: abrir la caja del tiburón por devtools
// con la recompensa ya elegida, y encima una caja que reparte ACCIONES que se
// cuelan en la cartera sin pagar la operación.
//
// Ahora el coste y la recompensa se resuelven aquí y el navegador sólo pinta la
// animación con el resultado que llega. La tabla de pesos es la misma del
// cliente (que la conserva para el modo invitado y para los iconos), así que
// las probabilidades no cambian: lo que cambia es quién las tira.
import { livePrice } from './ledger.mjs';

export const CASES = {
  barrio: {
    name: 'Caja de Barrio',
    cost: 500,
    pools: [
      { w: 55, kind: 'xp', rarity: 'común', amount: [30, 90] },
      { w: 30, kind: 'cash', rarity: 'común', amount: [200, 800] },
      { w: 12, kind: 'shares', rarity: 'poco común', shares: [1, 3], syms: 'low' },
      { w: 3, kind: 'boost', rarity: 'raro', amount: [1.5, 2], hours: 1 },
    ],
  },
  suelo: {
    name: 'Caja de Suelo',
    cost: 5000,
    pools: [
      { w: 45, kind: 'cash', rarity: 'común', amount: [1000, 5000] },
      { w: 28, kind: 'shares', rarity: 'poco común', shares: [1, 5], syms: 'mid' },
      { w: 15, kind: 'xp', rarity: 'poco común', amount: [100, 300] },
      { w: 8, kind: 'boost', rarity: 'raro', amount: [2, 3], hours: 1 },
      { w: 3, kind: 'shares', rarity: 'épico', shares: [1, 2], syms: 'high' },
      { w: 1, kind: 'golden', rarity: 'legendario', amount: 1 },
    ],
  },
  tiburon: {
    name: 'Caja de Tiburón',
    cost: 50000,
    pools: [
      { w: 40, kind: 'cash', rarity: 'común', amount: [20000, 80000] },
      { w: 25, kind: 'shares', rarity: 'poco común', shares: [5, 20], syms: 'mid' },
      { w: 15, kind: 'boost', rarity: 'raro', amount: [3, 5], hours: 2 },
      { w: 12, kind: 'shares', rarity: 'épico', shares: [3, 8], syms: 'high' },
      { w: 5, kind: 'skin', rarity: 'épico', id: 'neon' },
      { w: 2.5, kind: 'golden', rarity: 'legendario', amount: 1 },
      { w: 0.5, kind: 'jackpot', rarity: 'legendario' },
    ],
  },
};

// el coste es público: el panel pinta el precio antes de girar
export function caseCatalog() {
  return Object.entries(CASES).map(([id, config]) => ({ id, name: config.name, cost: config.cost }));
}

// los ids de skin que la ruleta puede premiar: la whitelist con la que
// accounts.mjs sanea la lista de la bolsa, para que un save editado no se
// cuele un cosmético inventado
export function caseSkinIds() {
  const ids = new Set();
  for (const config of Object.values(CASES)) {
    for (const entry of config.pools) if (entry.kind === 'skin') ids.add(entry.id);
  }
  return ids;
}

function pickFromPool(pool) {
  const total = pool.reduce((sum, entry) => sum + entry.w, 0);
  let roll = Math.random() * total;
  for (const entry of pool) {
    roll -= entry.w;
    if (roll <= 0) return entry;
  }
  return pool[pool.length - 1];
}

// los tres tramos de precio que usa la ruleta (js/cases.js symbolsForTier)
function symbolsForTier(quotes, tier) {
  const list = [];
  for (const [sym] of quotes) {
    const price = livePrice(quotes, sym);
    if (price === null) continue;
    if (tier === 'low' && price >= 100) continue;
    if (tier === 'mid' && (price < 100 || price >= 200)) continue;
    if (tier === 'high' && price < 200) continue;
    list.push(sym);
  }
  return list;
}

function between(a, b) {
  return a + Math.random() * (b - a);
}

// la recompensa de una caja, sin cobrar ni aplicar nada: sólo el sorteo
function rollCase(caseId, quotes) {
  const config = CASES[caseId];
  if (!config) return null;
  const pick = pickFromPool(config.pools);
  switch (pick.kind) {
    case 'cash':
      return { kind: 'cash', rarity: pick.rarity, amount: between(pick.amount[0], pick.amount[1]) };
    case 'xp':
      return { kind: 'xp', rarity: pick.rarity, amount: between(pick.amount[0], pick.amount[1]) };
    case 'shares': {
      const pool = symbolsForTier(quotes, pick.syms);
      if (!pool.length) return null;
      const shares = Math.max(1, Math.floor(between(pick.shares[0], pick.shares[1] + 1)));
      return { kind: 'shares', rarity: pick.rarity, sym: pool[Math.floor(Math.random() * pool.length)], shares };
    }
    case 'boost':
      return { kind: 'boost', rarity: pick.rarity, mult: between(pick.amount[0], pick.amount[1]), hours: pick.hours };
    case 'golden':
      return { kind: 'golden', rarity: pick.rarity, amount: pick.amount };
    case 'skin':
      return { kind: 'skin', rarity: pick.rarity, id: pick.id };
    case 'jackpot':
      return { kind: 'jackpot', rarity: pick.rarity, amount: 100000 + Math.random() * 400000 };
    default:
      return { kind: 'cash', rarity: 'común', amount: between(100, 500) };
  }
}

// cobrar y entregar. Las acciones que salen de una caja entran a leverage 1 y
// con su margen pagado, igual que las compraba el jugador: el premio no crea
// apalancamiento gratis.
export function openCase(portfolio, caseId, quotes) {
  const config = CASES[caseId];
  if (!config) return { ok: false, error: 'caja desconocida' };
  if (portfolio.bankrupt === true) return { ok: false, error: 'cuenta en bancarrota' };
  const cost = config.cost;
  if (!(Number(portfolio.cash) >= cost)) return { ok: false, error: 'no tienes ese efectivo' };
  const reward = rollCase(caseId, quotes);
  if (!reward) return { ok: false, error: 'sin símbolos en la cinta' };

  // el coste se cobra antes de girar: una caja es un sumidero de dinero aunque
  // el premio valga menos que el precio
  portfolio.cash = Number(portfolio.cash) - cost;
  if (reward.kind === 'cash' || reward.kind === 'jackpot') {
    portfolio.cash += reward.amount;
  } else if (reward.kind === 'skin') {
    // los cosméticos de la bolsa viven en su propia lista: el libro de
    // opencase (portfolio.skins) es un objeto con inventario y trueques, y
    // empujar un id ahí lo convertiría en un array roto
    const owned = Array.isArray(portfolio.caseSkins) ? portfolio.caseSkins : [];
    if (!owned.includes(reward.id) && owned.length < 40) owned.push(reward.id);
    portfolio.caseSkins = owned;
  } else if (reward.kind === 'shares') {
    const price = livePrice(quotes, reward.sym);
    const positions = portfolio.positions || (portfolio.positions = {});
    const pos = positions[reward.sym] || { shares: 0, avgPrice: 0, leverage: 1, margin: 0 };
    const held = Number(pos.shares) || 0;
    const shares = held + reward.shares;
    positions[reward.sym] = {
      shares,
      avgPrice: ((Number(pos.avgPrice) || 0) * held + price * reward.shares) / shares,
      leverage: 1,
      margin: (Number(pos.margin) || 0) + price * reward.shares,
      tp: pos.tp || null,
      sl: pos.sl || null,
      trailPct: pos.trailPct || null,
      trailPeak: pos.trailPeak || price,
    };
  }
  return { ok: true, cost, reward, cash: portfolio.cash };
}
