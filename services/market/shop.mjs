// la tienda de cosméticos del piso: el segundo sumidero de dinero (después del
// casino) y el primero que deja algo que ver. avatares, marcos de perfil y
// paletas exclusivas se compran con cash del juego; la compra vive en el server
// (un set por cuenta) y el perfil sólo puede equipar lo que la cuenta posee.
// los skins que caen de las cajas (state.skins) también cuentan como poseídos.

export const SHOP_ITEMS = [
  // avatares premium: el perfil sólo puede usar los que compró
  { id: 'av-dragon', kind: 'avatar', name: 'Dragón dorado', icon: '🐲', price: 25_000 },
  { id: 'av-alien', kind: 'avatar', name: 'Inversor alien', icon: '👾', price: 40_000 },
  { id: 'av-crown', kind: 'avatar', name: 'Corona del piso', icon: '👑', price: 100_000 },
  { id: 'av-rocket3', kind: 'avatar', name: 'Cohete de platino', icon: '🛸', price: 250_000 },
  // marcos de avatar: un anillo alrededor del círculo del perfil
  { id: 'ring-gold', kind: 'ring', name: 'Anillo dorado', color: '#F2B84B', price: 60_000 },
  { id: 'ring-neon', kind: 'ring', name: 'Anillo neón', color: '#29E0A8', price: 90_000 },
  { id: 'ring-fire', kind: 'ring', name: 'Anillo de fuego', color: '#FF5C7A', price: 150_000 },
];

export const SHOP_MAX_OWNED = 40; // techo de sanidad por cuenta

// el inventario: ids de items poseídos + el marco equipado
export function defaultShop() {
  return { owned: [], ring: null };
}

// el perfil guarda una referencia al marco equipado; esto la valida
export function sanitizeShop(input) {
  const base = defaultShop();
  if (!input || typeof input !== 'object') return base;
  const known = new Set(SHOP_ITEMS.map((i) => i.id));
  return {
    owned: Array.isArray(input.owned)
      ? [...new Set(input.owned.filter((id) => typeof id === 'string' && known.has(id)))].slice(0, SHOP_MAX_OWNED)
      : base.owned,
    ring: typeof input.ring === 'string' && known.has(input.ring) ? input.ring : null,
  };
}

function itemById(id) {
  return SHOP_ITEMS.find((i) => i.id === id) || null;
}

// compra: valida precio y duplicado, cobra del portfolio y anota el item.
// muta portfolio.cash y shop.owned; el caller persiste.
export function shopBuy(portfolio, shop, itemId) {
  const item = itemById(itemId);
  if (!item) return { ok: false, error: 'ese artículo no existe' };
  if (shop.owned.includes(item.id)) return { ok: false, error: 'ya tienes este artículo' };
  if (shop.owned.length >= SHOP_MAX_OWNED) return { ok: false, error: 'inventario lleno' };
  const cash = Number(portfolio.cash) || 0;
  if (cash < item.price) return { ok: false, error: `te faltan ${(item.price - cash).toFixed(0)} de efectivo` };
  portfolio.cash = cash - item.price;
  shop.owned.push(item.id);
  return { ok: true, item, cash: portfolio.cash };
}

// equipar el marco: sólo si la cuenta lo posee. avatares y títulos no pasan por
// aquí (viven en el perfil), pero el marco sí viaja con el shop.
export function shopEquipRing(shop, itemId) {
  if (itemId === null) {
    shop.ring = null;
    return { ok: true, ring: null };
  }
  const item = itemById(itemId);
  if (!item || item.kind !== 'ring') return { ok: false, error: 'ese artículo no es un marco' };
  if (!shop.owned.includes(item.id)) return { ok: false, error: 'no tienes ese marco: cómpralo en la tienda' };
  shop.ring = item.id;
  return { ok: true, ring: item.id };
}

// los avatares premium son los únicos cosméticos que viajan dentro del perfil
// (un emoji), así que el server verifica la propiedad al guardarlo: si el
// perfil pide un avatar de tienda que la cuenta no compró, cae al default.
export function profileAvatarAllowed(shop, avatarIcon) {
  const premium = SHOP_ITEMS.find((i) => i.kind === 'avatar' && i.icon === avatarIcon);
  return !premium || shop.owned.includes(premium.id);
}
