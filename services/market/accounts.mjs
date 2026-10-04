// account + portfolio store for the trading floor game. accounts live in a
// single JSON document (persisted by store.mjs) with scrypt password hashes and
// opaque bearer session tokens.
import { randomBytes, randomUUID } from 'node:crypto';
import { sanitizeBank, sanitizeTransfers } from './bank.mjs';
import { caseSkinIds } from './cases.mjs';
import { sanitizeCasino } from './casino.mjs';
import { sanitizeSkins } from './skins.mjs';
import {
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from './passwords.mjs';

export const START_CASH = 10000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_NAME_LENGTH = 3;
export const MAX_NAME_LENGTH = 24;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_TRANSACTIONS = 200;
const MAX_WATCHLIST = 50;
// los ids de cosmético que la ruleta de cajas puede premiar: la whitelist con
// la que se sanea la lista de la bolsa, taken de la tabla que la genera
const CASE_SKIN_IDS = caseSkinIds();
// one sample per game day: 90 covers a full "season" of the leaderboard windows
const NET_HISTORY_LIMIT = 90;

export function defaultStats() {
  return {
    wins: 0,
    losses: 0,
    totalTrades: 0,
    bestTrade: 0,
    grossProfit: 0,
    grossLoss: 0,
  };
}

export function defaultPortfolio() {
  return {
    cash: START_CASH,
    positions: {},
    transactions: [],
    stats: defaultStats(),
    level: 1,
    xp: 0,
    watchlist: [],
    quests: { firstBuy: false, diversify: false },
    bankrupt: false,
    bankruptUntil: 0,
    // el servidor lleva su propio reloj de patrimonio para el pico y el mejor
    // día (ledger.mjs runRiskPass); el cliente ya no los calcula para el ranking
    statsDay: -1,
    statsOpen: 0,
    // cosméticos del minijuego de cajas, lista propia y distinta del libro de
    // opencase (portfolio.skins, que es un objeto con inventario y trueques)
    caseSkins: [],
    bank: sanitizeBank(null),
    orders: [],
    transfers: [],
    updatedAt: Date.now(),
  };
}

// the cosmetic half of an account: avatar, banner, title, bio and privacy. it is
// kept next to the portfolio so the leaderboard can show who is who, and it is
// clamped here because it arrives straight from the client.
export function defaultProfile() {
  return { avatar: '🎯', avatarColor: 0, banner: 0, title: 'novato', bio: '', privacy: 'public', unlockedTitles: ['novato'] };
}

export function sanitizeProfile(input) {
  const base = defaultProfile();
  if (!input || typeof input !== 'object') return base;
  const str = (value, fallback, max) =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : fallback;
  const int = (value, fallback, min, max) => {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    avatar: str(input.avatar, base.avatar, 8),
    avatarColor: int(input.avatarColor, base.avatarColor, 0, 15),
    banner: int(input.banner, base.banner, 0, 15),
    title: str(input.title, base.title, 24),
    bio: typeof input.bio === 'string' ? input.bio.slice(0, 120) : '',
    privacy: ['public', 'friends', 'private'].includes(input.privacy) ? input.privacy : 'public',
    unlockedTitles: Array.isArray(input.unlockedTitles)
      ? [...new Set(input.unlockedTitles.filter((id) => typeof id === 'string' && id.length <= 24))].slice(0, 24)
      : base.unlockedTitles,
  };
}

export function createAccountStore() {
  return { version: 1, accounts: {}, sessions: {} };
}

export function restoreAccountStore(saved) {
  const store = createAccountStore();
  if (!saved || typeof saved !== 'object') return store;

  if (saved.accounts && typeof saved.accounts === 'object') {
    for (const [key, account] of Object.entries(saved.accounts)) {
      if (
        !account ||
        typeof account !== 'object' ||
        typeof account.name !== 'string' ||
        typeof account.hash !== 'string'
      ) {
        continue;
      }
      store.accounts[key] = {
        id: typeof account.id === 'string' ? account.id : key,
        name: account.name,
        hash: account.hash,
        // the admin flag is remembered across restarts; the server re-applies it
        // from MARKET_ADMIN_NAMES on boot so the allow-list stays the source of truth
        admin: account.admin === true,
        profile: sanitizeProfile(account.profile),
        // one net-worth sample per game day, which is what the leaderboard's
        // period filters read (see leaderboard.mjs)
        netHistory: Array.isArray(account.netHistory)
          ? account.netHistory
            .filter((entry) => entry && Number.isFinite(entry.d) && Number.isFinite(entry.net))
            .slice(-NET_HISTORY_LIMIT)
          : [],
        createdAt: Number.isFinite(account.createdAt)
          ? account.createdAt
          : Date.now(),
        lastLoginAt: Number.isFinite(account.lastLoginAt)
          ? account.lastLoginAt
          : 0,
        portfolio: sanitizePortfolio(account.portfolio),
      };
    }
  }

  if (saved.sessions && typeof saved.sessions === 'object') {
    const now = Date.now();
    for (const [token, session] of Object.entries(saved.sessions)) {
      if (
        !session ||
        typeof session !== 'object' ||
        typeof session.key !== 'string' ||
        !store.accounts[session.key]
      ) {
        continue;
      }
      const expiresAt = Number.isFinite(session.expiresAt)
        ? session.expiresAt
        : 0;
      if (expiresAt <= now) continue;
      store.sessions[token] = {
        key: session.key,
        createdAt: Number.isFinite(session.createdAt)
          ? session.createdAt
          : now,
        expiresAt,
      };
    }
  }

  return store;
}

function number(value, fallback, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function nullableNumber(value, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

// the ranking counters, the peak net worth and the bankruptcy tally. el
// servidor los reproduce en ledger.mjs a partir de las operaciones que él
// aplicó, así que un save con best=9e11 no los mueve
function sanitizeStats(input) {
  const stats = input && typeof input === 'object' ? input : {};
  return {
    wins: Math.round(number(stats.wins, 0, 0, 1e9)),
    losses: Math.round(number(stats.losses, 0, 0, 1e9)),
    totalTrades: Math.round(number(stats.totalTrades, 0, 0, 1e9)),
    bestTrade: number(stats.bestTrade, 0, -1e12, 1e12),
    grossProfit: number(stats.grossProfit, 0, 0, 1e12),
    grossLoss: number(stats.grossLoss, 0, 0, 1e12),
    // the leaderboard's racha column and two achievements read these
    currentStreak: Math.round(number(stats.currentStreak, 0, 0, 1e9)),
    bestStreak: Math.round(number(stats.bestStreak, 0, 0, 1e9)),
    timesBankrupt: Math.round(number(stats.timesBankrupt, 0, 0, 1e6)),
    peakNet: number(stats.peakNet, 0, 0, 1e15),
    bestDayReturn: number(stats.bestDayReturn, 0, -1e6, 1e6),
  };
}

function sanitizePositions(input) {
  if (!input || typeof input !== 'object') return {};
  const positions = {};
  for (const [sym, raw] of Object.entries(input)) {
    if (
      typeof sym !== 'string' ||
      sym.length === 0 ||
      sym.length > 16 ||
      !raw ||
      typeof raw !== 'object'
    ) {
      continue;
    }
    const shares = number(raw.shares, 0, 0, 1e12);
    const avgPrice = number(raw.avgPrice, 0, 0, 1e12);
    if (shares <= 0 || avgPrice <= 0) continue;
    positions[sym] = {
      shares,
      avgPrice,
      leverage: number(raw.leverage, 1, 1, 1000),
      margin: number(raw.margin, 0, 0, 1e12),
      tp: nullableNumber(raw.tp, 0, 1e12),
      sl: nullableNumber(raw.sl, 0, 1e12),
      trailPct: nullableNumber(raw.trailPct, 0, 100),
      trailPeak: nullableNumber(raw.trailPeak, 0, 1e12),
    };
  }
  return positions;
}

function sanitizeTransactions(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.sym === 'string' &&
        typeof entry.type === 'string',
    )
    .slice(0, MAX_TRANSACTIONS)
    .map((entry) => ({
      sym: entry.sym.slice(0, 16),
      type: entry.type.slice(0, 24),
      shares: number(entry.shares, 0, 0, 1e12),
      price: number(entry.price, 0, 0, 1e12),
      time: typeof entry.time === 'string' ? entry.time.slice(0, 24) : '',
      leverage: number(entry.leverage, 1, 1, 1000),
      ...(typeof entry.pnl === 'number' && Number.isFinite(entry.pnl)
        ? { pnl: entry.pnl }
        : {}),
    }));
}

// resting orders pass through with the same clamps the placement path uses, so
// a hand-edited save cannot smuggle in a free-margin order
function sanitizeOrders(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((o) => o && typeof o === 'object' && typeof o.id === 'string' && typeof o.sym === 'string')
    .slice(0, 24)
    .map((o) => ({
      id: o.id.slice(0, 32),
      sym: o.sym.slice(0, 16),
      side: o.side === 'sell' ? 'sell' : 'buy',
      kind: o.kind === 'stop' ? 'stop' : 'limit',
      shares: number(o.shares, 0, 0, 1e12),
      price: number(o.price, 0, 0, 1e12),
      leverage: number(o.leverage, 1, 1, 1000),
      margin: number(o.margin, 0, 0, 1e12),
      placedAt: number(o.placedAt, Date.now(), 0, 1e15),
      day: number(o.day, 0, 0, 1e9),
    }));
}

// lo que el AUTOGUARDADO ya no puede mover: cash, positions, stats,
// transactions, orders, bankrupt y el reloj de patrimonio. los escribe el
// servidor — el libro mayor (ledger.mjs) para el dinero y el ranking, orders.mjs
// para las órdenes en espera. antes venían del cliente y por eso un PUT podía
// acuñar cash, posiciones y estadísticas; y una orden forjada con day antiguo y
// margen enorme se "vencía" en el siguiente tick devolviendo ese margen al
// efectivo.

// the client owns the trading rules, but the server owns what gets persisted,
// so every field is validated and clamped before it is stored.
//
// `serverOwned` es la cartera que el servidor ya tenía. Cuando se pasa (la ruta
// normal del autoguardado), el dinheiro deja de venir del cuerpo de la petición:
// el cliente manda el registro de operaciones, ledger.mjs lo reproduce sobre
// `serverOwned` y el resultado es lo que se persiste. Sin `serverOwned` —la
// carga desde disco, restoreAccountStore— el comportamiento es el de siempre,
// para no perder la partida de nadie al migrar.
export function sanitizePortfolio(input, serverOwned) {
  const base = defaultPortfolio();
  if (!input || typeof input !== 'object') {
    return serverOwned ? applyServerOwned(base, serverOwned) : base;
  }

  const portfolio = {
    ...base,
    cash: number(input.cash, base.cash, 0, 1e12),
    level: Math.round(number(input.level, base.level, 1, 1000)),
    xp: Math.round(number(input.xp, base.xp, 0, 1e9)),
    bankrupt: input.bankrupt === true,
    bankruptUntil: number(input.bankruptUntil, 0, 0, 1e15),
    // the bank book and resting orders are stored as the client sends them but
    // clamped here; the authoritative mutations happen server-side (bank.mjs /
    // orders.mjs), this is just what survives a plain portfolio save
    bank: sanitizeBank(input.bank),
    transfers: sanitizeTransfers(input.transfers),
    updatedAt: number(input.updatedAt, Date.now(), 0, 1e15),
    stats: sanitizeStats(input.stats),
    quests: { ...base.quests },
  };

  if (input.quests && typeof input.quests === 'object') {
    portfolio.quests = {
      firstBuy: input.quests.firstBuy === true,
      diversify: input.quests.diversify === true,
    };
  }

  if (Array.isArray(input.watchlist)) {
    portfolio.watchlist = input.watchlist
      .filter((sym) => typeof sym === 'string' && sym.length > 0 && sym.length < 16)
      .slice(0, MAX_WATCHLIST);
  }

  portfolio.positions = sanitizePositions(input.positions);
  portfolio.transactions = sanitizeTransactions(input.transactions);
  portfolio.orders = sanitizeOrders(input.orders);

  // los cosméticos de la bolsa (los ids que suenan como premio de las cajas
  // del minijuego) son una lista propia, distinta del libro de opencase
  if (Array.isArray(input.caseSkins)) {
    portfolio.caseSkins = [...new Set(input.caseSkins.filter((id) => CASE_SKIN_IDS.has(id)))].slice(0, 40);
  }

  // the casino book: the hand shape is cosmetic (the money lives in cash, and
  // the authoritative moves happen in casino.mjs), this just survives a save
  if (input.casino && typeof input.casino === 'object') {
    portfolio.casino = sanitizeCasino(input.casino);
  }

  // the opencase book: cosmetics + resale values; the money itself lives in
  // cash, so a tampered inventory can't mint balance. el libro de trueques
  // viaja dentro (trades) y se re-valida en trades.mjs
  if (input.skins && typeof input.skins === 'object') {
    portfolio.skins = sanitizeSkins(input.skins);
  }

  return serverOwned ? applyServerOwned(portfolio, serverOwned) : portfolio;
}

// el overlay autoritativo: la cartera del servidor manda en los campos que el
// autoguardado ya no puede tocar. los values se vuelven a pasar por sus
// saneadores para no compartir referencias con la cartera viva.
function applyServerOwned(portfolio, serverOwned) {
  portfolio.cash = number(serverOwned.cash, portfolio.cash, 0, 1e12);
  portfolio.positions = sanitizePositions(serverOwned.positions);
  portfolio.stats = sanitizeStats(serverOwned.stats);
  portfolio.transactions = sanitizeTransactions(serverOwned.transactions);
  portfolio.orders = sanitizeOrders(serverOwned.orders);
  portfolio.bankrupt = serverOwned.bankrupt === true;
  portfolio.bankruptUntil = number(serverOwned.bankruptUntil, 0, 0, 1e15);
  portfolio.statsDay = number(serverOwned.statsDay, 0, 0, 1e9);
  portfolio.statsOpen = number(serverOwned.statsOpen, 0, -1e15, 1e15);
  return portfolio;
}

export function accountKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

export function validateCredentials(name, password) {
  const trimmed = String(name ?? '').trim();
  const secret = String(password ?? '');
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
    return {
      error: `el nombre debe tener entre ${MIN_NAME_LENGTH} y ${MAX_NAME_LENGTH} caracteres`,
    };
  }
  if (!NAME_PATTERN.test(trimmed)) {
    return { error: 'el nombre solo puede usar letras, números, ".", "-" y "_"' };
  }
  if (secret.length < MIN_PASSWORD_LENGTH || secret.length > MAX_PASSWORD_LENGTH) {
    return {
      error: `la contraseña debe tener entre ${MIN_PASSWORD_LENGTH} y ${MAX_PASSWORD_LENGTH} caracteres`,
    };
  }
  return { name: trimmed };
}

export function createSession(store, key) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  store.sessions[token] = { key, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  return token;
}

export function registerAccount(store, name, password) {
  const validated = validateCredentials(name, password);
  if (validated.error) return { ok: false, error: validated.error };

  const key = accountKey(validated.name);
  if (store.accounts[key]) {
    return { ok: false, error: 'ese nombre ya está en uso' };
  }

  const account = {
    id: randomUUID(),
    name: validated.name,
    hash: hashPassword(password),
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
    portfolio: defaultPortfolio(),
    profile: defaultProfile(),
    netHistory: [],
  };
  store.accounts[key] = account;

  return { ok: true, token: createSession(store, key), account };
}

export function loginAccount(store, name, password) {
  const key = accountKey(name);
  const account = store.accounts[key];
  if (!account) return { ok: false, error: 'usuario o contraseña incorrectos' };
  if (!verifyPassword(password, account.hash)) {
    return { ok: false, error: 'usuario o contraseña incorrectos' };
  }
  account.lastLoginAt = Date.now();
  return { ok: true, token: createSession(store, key), account };
}

export function authenticate(store, token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const session = store.sessions[token];
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    delete store.sessions[token];
    return null;
  }
  return store.accounts[session.key] ?? null;
}

export function logoutAccount(store, token) {
  if (typeof token !== 'string' || !store.sessions[token]) return false;
  delete store.sessions[token];
  return true;
}

export function publicAccount(store, account) {
  const key = accountKey(account.name);
  const sessions = Object.entries(store.sessions)
    .filter(([, session]) => session.key === key && session.expiresAt > Date.now())
    .map(([, session]) => session);
  return {
    name: account.name,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
    // the client needs to know whether to show the admin console at all
    admin: account.admin === true,
    portfolio: account.portfolio,
    // server-authoritative money: the client tags its saves with this; a save
    // built from a pre-override snapshot is refused (409) instead of clobbering
    // an admin grant/reset
    portfolioEpoch: account.portfolioEpoch || 0,
    // avatar, title and bio: shown on the profile and in the ranking
    profile: account.profile || defaultProfile(),
    sessions: sessions.length,
  };
}
