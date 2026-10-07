// realtime market service for lyra's "owngames" game source. it owns the price
// walk (every tick is broadcast over a websocket so every player sees the same
// market in real time) and persists both the market and player portfolios to
// json files so restarting the server keeps prices and statistics.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeJoin } from '../../server/staticPath.mjs';
import {
  CANDLE_MAX_LIMIT,
  DEFAULT_TIMEFRAME,
  GAME_DAY_MS,
  backfillHistory,
  candlesFor,
  historyFor,
  liveCandles,
  marketSnapshot,
  restoreMarketState,
  serializeMarketSlim,
  timeframeFor,
  createMarketState,
  tickMarketState,
} from './engine.mjs';
import { createHistoryStore } from './history.mjs';
import {
  accrueBankDay,
  bankAction,
  defaultBank,
  transferCash,
  TRANSFER_FEE_RATE,
  TRANSFER_FEE_THRESHOLD,
} from './bank.mjs';
import {
  cancelOrder,
  fillBuy,
  fillSell,
  ORDER_TTL_DAYS,
  placeOrder,
  processOrders,
} from './orders.mjs';
import { DIVIDEND_TAX, dividendTable, processDividends } from './dividends.mjs';
import { casinoAction, publicHand, sanitizeCasino, CASINO_MIN_BET, CASINO_MAX_BET } from './casino.mjs';
import { caseCatalog, openCase } from './cases.mjs';
import { replayOps, runRiskPass } from './ledger.mjs';
import { skinsAction, skinsSnapshot, skinsCatalog, sanitizeSkins, skinsUpdateEvent } from './skins.mjs';
import { proposeTrade, acceptTrade, resolveTrade, setTradeCatalog } from './trades.mjs';

// el libro de tradeos existe en cualquier cuenta que toque el sistema (jugador
// nuevo sin cajas abiertas incluido) — lo usa la ruta de decline/cancel
function ensureTradesBook(acc) {
  if (!acc?.portfolio) return;
  if (!acc.portfolio.skins || typeof acc.portfolio.skins !== 'object') acc.portfolio.skins = { inventory: [], stats: { opened: 0, spent: 0, earned: 0 }, seq: 0, trades: { sent: [], received: [], seq: 0 } };
  if (!acc.portfolio.skins.trades || typeof acc.portfolio.skins.trades !== 'object') acc.portfolio.skins.trades = { sent: [], received: [], seq: 0 };
  if (!Array.isArray(acc.portfolio.skins.trades.sent)) acc.portfolio.skins.trades.sent = [];
  if (!Array.isArray(acc.portfolio.skins.trades.received)) acc.portfolio.skins.trades.received = [];
}
import { shopBuy, shopEquipRing, sanitizeShop, profileAvatarAllowed, SHOP_ITEMS, defaultShop } from './shop.mjs';
import {
  BANK_RATE_DAILY,
  LOAN_PENALTY,
  LOAN_RATE_DAILY,
  LOAN_TERM_DAYS,
} from './bank.mjs';
import { createAdminConsole } from './admin.mjs';
import { createLeaderboard } from './leaderboard.mjs';
import { createEventEngine } from './events.mjs';
import {
  activePoll,
  adminClosePoll,
  adminPollsList,
  castVote,
  openPoll,
  resolveDuePolls,
} from './polls.mjs';
import {
  accountKey,
  authenticate,
  createAccountStore,
  defaultPortfolio,
  loginAccount,
  logoutAccount,
  publicAccount,
  registerAccount,
  restoreAccountStore,
  sanitizePortfolio,
  sanitizeProfile,
} from './accounts.mjs';
import { resolveSsoAccount, sessionTokenFromRequest, verifySessionToken } from './sso.mjs';
import { createJsonStore } from './store.mjs';
import { createMusicBridge } from './music.mjs';
import {
  GLOBAL_CHANNEL,
  acceptFriend,
  activeBan,
  allMessages,
  applyBan,
  auditLog,
  channelMembers,
  channelsFor,
  chatKey,
  createChatStore,
  createGroup,
  deleteMessage,
  ensureGlobalChannel,
  liftBan,
  messagesFor,
  openDm,
  postMessage,
  relationsFor,
  removeFriend,
  requestFriend,
  restoreChatStore,
} from './chat.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4006;
const DEFAULT_TICK_MS = 1000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TICK_MS = 60_000;
const TAPE_LIMIT = 40;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 40;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export const OWN_GAMES = [
  {
    id: 'csgo-opencase',
    name: 'CS:GO — OpenCase',
    author: 'lyra',
    description: 'Cajas estilo CS:GO con la misma cartera que la bolsa: abre, colecciona y vende skins',
    gameUrl: '/owngames/csgo-opencase/',
    coverUrl: '/owngames/csgo-opencase/cover.svg',
    featured: false,
  },
  {
    id: 'bolsa-trading-floor',
    name: 'Bolsa — Trading Floor',
    author: 'lyra',
    description: 'Simulador de bolsa multijugador en tiempo real',
    gameUrl: '/owngames/bolsa-trading-floor/',
    coverUrl: '/owngames/bolsa-trading-floor/cover.svg',
    featured: true,
  },
];

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    },
  });
}

function bearerToken(req) {
  const header = req.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

// el WebSocket del juego es same-origin, asi que el navegador manda la cookie
// sola y sin que nadie la pueda leer desde el JS de la pagina. antes el token
// iba en la query del handshake y prod.mjs escribe requestUrl.search en el
// access log, con lo que la sesion acababa en disco.
const MARKET_COOKIE = 'lyra_market_token';
function cookieToken(req) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== MARKET_COOKIE) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

// cabecera > cookie > query. el query se mantiene por compatibilidad con
// clientes viejos y con las sondas de consola, pero el juego ya no lo usa.
// exportado para poder testearlo: el upgrade siempre pasa (los invitados ven el
// mercado), asi que sin un test unitario no hay forma de comprobar que el token
// llego bien desde el handshake.
export function socketToken(req, url) {
  return bearerToken(req) || cookieToken(req) || url.searchParams.get('token') || '';
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error('payload too large');
  }
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

function clampTickMs(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TICK_MS;
  return Math.min(MAX_TICK_MS, Math.max(200, parsed));
}


export function createMarketServer(options = {}) {
  const port = options.port ?? Number.parseInt(process.env.MARKET_PORT || String(DEFAULT_PORT), 10);
  const hostname = options.hostname ?? process.env.MARKET_HOST ?? '127.0.0.1';
  // mutable on purpose: the admin console can re-time the market at runtime
  let tickMs = clampTickMs(options.tickMs ?? process.env.MARKET_TICK_MS);
  const dataDir = options.dataDir ?? process.env.MARKET_DATA_DIR ?? path.join(HERE, 'data');

  // puente de búsqueda de música (youtube innertube + spotify client credentials)
  const music = createMusicBridge({
    spotifyClientId: options.spotifyClientId,
    spotifyClientSecret: options.spotifyClientSecret,
  });

  // SSO con cloudsync: el mercado acepta el mismo JWT que firma cloudsync como
  // segunda vía de sesión. el secreto es el de cloudsync; sin él el SSO queda
  // apagado y solo funciona el registro propio de siempre (aditivo, no rompe
  // nada ni debilita una sesión existente).
  const ssoSecret = options.ssoSecret ?? process.env.JWT_SECRET ?? '';

  // who may open the remote console. two sources, so a grant does not depend on
  // remembering an environment variable on every restart:
  //   · MARKET_ADMIN_NAMES  — comma separated names (deploy time)
  //   · <dataDir>/admins.json — the persisted list (["name", ...] or {names: [...]})
  // with both empty there is no remote admin at all (the game's console still
  // works in its local mode), which is the safe default.
  const adminNames = new Set(
    String(options.adminNames ?? process.env.MARKET_ADMIN_NAMES ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const adminFile = options.adminFile ?? path.join(dataDir, 'admins.json');
  try {
    if (fs.existsSync(adminFile)) {
      const parsed = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
      const names = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.names) ? parsed.names : [];
      for (const name of names) {
        if (typeof name === 'string' && name.trim()) adminNames.add(name.trim().toLowerCase());
      }
    }
  } catch {
    // a corrupt list must not take the service down: it just grants nothing
  }
  const publicDir = options.publicDir ?? path.join(HERE, 'public');

  const marketStore = createJsonStore(path.join(dataDir, 'market.json'), {
    fallback: () => createMarketState(),
    delay: 3000,
  });
  const accountStoreFile = createJsonStore(path.join(dataDir, 'players.json'), {
    fallback: () => createAccountStore(),
    delay: 2500,
  });
  const chatStoreFile = createJsonStore(path.join(dataDir, 'chat.json'), {
    fallback: () => createChatStore(),
    delay: 2500,
  });

  const market = restoreMarketState(marketStore.load());
  market.intervalMs = tickMs;
  if (!Array.isArray(market.tape)) market.tape = [];

  // the candle series are not part of market.json: they live in the rolling
  // history files, one folder per company and one file per game day. the server
  // reads the stored window and then draws whatever is missing (a fresh install,
  // or the days the window has not filled yet) inside the daily candles, so the
  // 5m/15m/1h windows are complete on the very first frame instead of filling up
  // as the clock runs. the hourly view is derived from the 5m bars, so it is
  // rebuilt once the window is whole.
  const history = createHistoryStore(dataDir, {
    delay: Number(process.env.MARKET_HISTORY_DELAY_MS) || undefined,
  });
  for (const symbol of market.symbols) {
    const stored = history.loadSymbol(symbol.sym, market.gameTime);
    if (stored.intraday.length) symbol.candles.intraday = stored.intraday;
    if (stored.daily.length) symbol.candles.daily = stored.daily;
  }
  backfillHistory(market);

  const accounts = restoreAccountStore(accountStoreFile.load());
  const chat = restoreChatStore(chatStoreFile.load());
  ensureGlobalChannel(chat);
  // the allow-list is the source of truth: whoever is on it is an admin, and
  // everyone else is cleared even if the stored flag said otherwise. the change
  // is written back so the file does not keep a stale flag around
  let adminFlagsChanged = false;
  for (const account of Object.values(accounts.accounts)) {
    const isAdmin = adminNames.has(accountKey(account.name));
    if (account.admin !== isAdmin) adminFlagsChanged = true;
    account.admin = isAdmin;
  }

  const clients = new Set();
  const authAttempts = new Map();
  let tickTimer = null;
  let stopped = false;

  function persistMarket() {
    // the hot save keeps prices and model state only; the candle series go to the
    // rolling history files, which are written far less often (see history.mjs)
    marketStore.set(serializeMarketSlim(market));
    history.save(market);
  }

  function persistAccounts() {
    accountStoreFile.set(accounts);
  }

  function persistChat() {
    chatStoreFile.set(chat);
  }

  // the re-applied allow-list is flushed right away, so a grant (or a
  // revocation) is visible in players.json without waiting for a login
  if (adminFlagsChanged) persistAccounts();

  // los sockets que sólo consumen parte del feed declaran en el handshake qué
  // frames ignoran (`?skip=tick,snapshot`): así el mercado no gasta serializar ni
  // enviarles esos frames. Es aditivo: sin el parámetro el socket recibe TODO,
  // igual que antes (clientes viejos y sondas de consola incluidos).
  function wantsFrame(socket, type) {
    return !socket.data?.skipFrames?.has(type);
  }

  function broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const socket of clients) {
      if (!wantsFrame(socket, payload.type)) continue;
      try {
        socket.send(text);
      } catch {
        clients.delete(socket);
      }
    }
  }

  // envía un payload YA serializado a todos los sockets de UNA cuenta. El cash,
  // el inventario y el feed de finanzas son de cada quien: esto nunca se hace en
  // broadcast. Devuelve cuántos sockets recibieron.
  function sendToAccountSockets(displayName, text) {
    if (!displayName) return 0;
    let sent = 0;
    for (const socket of clients) {
      try {
        if (!socket.data?.authorized) continue;
        if (socket.data?.accountName !== displayName) continue;
        socket.send(text);
        sent += 1;
      } catch {
        clients.delete(socket);
      }
    }
    return sent;
  }

  // server-authoritative money: every admin override of a portfolio (grant,
  // reset) bumps this epoch and pushes the new truth over the websocket. the
  // client adopts it AND the epoch, so the stale snapshot it holds in memory
  // can never overwrite the admin's change on the next debounced save — the
  // exact "reseteé y el dinero volvió" bug.
  let portfolioEpoch = 0;

  // TODA mutación server-side de dinero (interés, dividendos, casino, skins,
  // tradeos, banco, órdenes) tiene que bump-ear el epoch: si no, el autosave
  // del cliente (700ms después) llega con cash viejo y PISA el movimiento —
  // la carrera "te depositaron X y el dinero volvió a lo que era". El cliente
  // responde al epoch mayor resincronizando en vez de guardar.
  function bumpPortfolioEpoch(account) {
    if (!account) return;
    portfolioEpoch += 1;
    account.portfolioEpoch = portfolioEpoch;
  }

  function pushPortfolioOverride(account) {
    bumpPortfolioEpoch(account);
    persistAccounts();
    const displayName = account.name;
    const text = JSON.stringify({
      type: 'portfolio-override',
      epoch: portfolioEpoch,
      portfolio: account.portfolio,
      title: 'Cuenta actualizada',
      msg: 'El administrador ajustó tu cuenta. Sincronizado con el servidor.',
    });
    sendToAccountSockets(displayName, text);
  }

  // cuenta por token de mercado, o si no la hay por el JWT de cloudsync de la
  // cookie `token`. devuelve { account, created }.
  // una cuenta con ban de cuenta activo no resuelve sesión: la sanción corta el
  // acceso a TODOS los owngames, no sólo al chat. Los admins quedan exentos
  // para poder levantar la sanción.
  function withBanCheck(resolved) {
    if (resolved.account && !adminNames.has(accountKey(resolved.account.name))) {
      if (activeBan(chat, resolved.account.name, 'account')) return { account: null, created: false };
    }
    return resolved;
  }

  function resolveRequestAccount(req, marketToken) {
    const byToken = authenticate(accounts, marketToken);
    if (byToken) return withBanCheck({ account: byToken, created: false });
    if (!ssoSecret) return { account: null, created: false };
    const claims = verifySessionToken(sessionTokenFromRequest(req), ssoSecret);
    if (!claims) return { account: null, created: false };
    const resolved = resolveSsoAccount(accounts, claims.username);
    return withBanCheck(resolved ?? { account: null, created: false });
  }

  function authenticatedAccount(req) {
    const { account, created } = resolveRequestAccount(req, bearerToken(req));
    if (account && created) persistAccounts();
    return account;
  }

  function rateLimited(req, server) {
    const ip = server?.requestIP?.(req)?.address || 'unknown';
    const now = Date.now();
    let state = authAttempts.get(ip);
    if (!state || now - state.start > AUTH_WINDOW_MS) {
      state = { start: now, count: 0 };
      authAttempts.set(ip, state);
    }
    state.count += 1;
    return state.count > AUTH_MAX_ATTEMPTS;
  }

  // the quote map the resting orders and the dividends read: sym -> { live }
  function quoteMap() {
    const quotes = new Map();
    for (const quote of marketSnapshot(market).quotes) quotes.set(quote.sym, quote);
    return quotes;
  }

  // once per game day, per account: savings interest, loan accrual/collection
  // and the dividend payments. everything that makes money move while the
  // player is away lives here, on the server's clock, not the client's.
  function runDailyFinance(gameDay, quotes) {
    const notices = new Map();
    for (const account of Object.values(accounts.accounts)) {
      const portfolio = account.portfolio;
      if (!portfolio) continue;
      const hasBank = portfolio.bank && (portfolio.bank.balance > 0 || portfolio.bank.loan > 0);
      const hasPositions = portfolio.positions && Object.keys(portfolio.positions).length > 0;
      if (!hasBank && !hasPositions) continue;

      const entries = [];
      try {
        if (hasBank) entries.push(...accrueBankDay(portfolio, quotes, gameDay));
        if (hasPositions) entries.push(...processDividends(portfolio, quotes, gameDay));
      } catch {
        continue;
      }
      if (!entries.length) continue;
      bumpPortfolioEpoch(account);
      portfolio.updatedAt = Date.now();
      notices.set(accountKey(account.name), entries);
    }
    if (notices.size) persistAccounts();
    return notices;
  }

  // resting limit/stop orders, checked every tick against the live tape
  function runOrderPass(gameDay, quotes) {
    const notices = new Map();
    for (const account of Object.values(accounts.accounts)) {
      const portfolio = account.portfolio;
      if (!portfolio || !portfolio.orders?.length) continue;
      let outcomes;
      try {
        outcomes = processOrders(portfolio, quotes, gameDay);
      } catch {
        continue;
      }
      if (!outcomes.length) continue;
      const entries = [];
      for (const outcome of outcomes) {
        const { order } = outcome;
        if (outcome.type === 'expired') {
          entries.push({ kind: 'order-expired', sym: order.sym, side: order.side, shares: order.shares, price: order.price });
          continue;
        }
        const result = order.side === 'buy'
          ? fillBuy(portfolio, order, outcome.price)
          : fillSell(portfolio, order, outcome.price);
        if (result?.refunded) {
          entries.push({ kind: 'order-expired', sym: order.sym, side: order.side, shares: order.shares, price: outcome.price });
          continue;
        }
        portfolio.stats.totalTrades = (portfolio.stats?.totalTrades || 0) + 1;
        if (Number.isFinite(result.pnl)) {
          if (result.pnl >= 0) portfolio.stats.wins = (portfolio.stats.wins || 0) + 1;
          else portfolio.stats.losses = (portfolio.stats.losses || 0) + 1;
        }
        entries.push({
          kind: 'order-filled',
          sym: order.sym, side: order.side, orderKind: order.kind,
          shares: result.shares ?? order.shares,
          price: outcome.price,
          leverage: order.leverage || 1,
          pnl: Number.isFinite(result.pnl) ? result.pnl : undefined,
        });
      }
      if (!entries.length) continue;
      bumpPortfolioEpoch(account);
      portfolio.updatedAt = Date.now();
      notices.set(accountKey(account.name), entries);
    }
    if (notices.size) persistAccounts();
    return notices;
  }

  // pushes the per-account finance feed over the websocket. keyed by the
  // account's DISPLAY NAME (what the client compares against MarketNet.
  // accountName) — the lowercase storage key would never match it.
  function notifyAccountFinance(displayName, entries) {
    if (!displayName || !Array.isArray(entries) || !entries.length) return;
    const text = JSON.stringify({ type: 'finance', finance: { notices: [[displayName, entries]] } });
    sendToAccountSockets(displayName, text);
  }

  function notifyFinance(notices) {
    if (!notices?.size) return;
    for (const [key, entries] of notices) {
      const account = accounts.accounts[key];
      if (account) notifyAccountFinance(account.name, entries);
    }
  }

  // el libro de skins/cash de UNA cuenta cambió: push dirigido (como
  // portfolio-override, filtrado por socket) para que la bolsa y opencase lo
  // vean al toque sin recargar. NUNCA broadcast: el cash es de cada quien.
  function pushSkinsUpdate(displayName, kind, extra = {}) {
    if (!displayName) return;
    const text = JSON.stringify(skinsUpdateEvent(kind, extra));
    sendToAccountSockets(displayName, text);
  }

  // ------------------------------------------------ chat (comunidad owngames)
  function displayNameFor(key) {
    const acc = accounts.accounts[chatKey(key)];
    return acc ? acc.name : String(key);
  }

  // vista pública de un canal para UN espectador: en un DM el título es el
  // nombre del otro; los grupos muestran su lista de miembros.
  function publicChannel(ch, viewerName) {
    const viewerKey = chatKey(viewerName);
    const members = ch.kind === 'global' ? [] : ch.members.map(displayNameFor);
    let title = ch.title;
    if (ch.kind === 'dm') {
      const other = ch.members.find((k) => k !== viewerKey);
      title = other ? displayNameFor(other) : '';
    }
    return { id: ch.id, kind: ch.kind, title, members, createdAt: ch.createdAt };
  }

  function isChannelMember(ch, name) {
    return ch.kind === 'global' || ch.members.includes(chatKey(name));
  }

  function isOnline(key) {
    for (const socket of clients) {
      if (socket.data?.authorized && chatKey(socket.data.accountName || '') === key) return true;
    }
    return false;
  }

  function friendsView(name) {
    const rel = relationsFor(chat, name);
    return {
      friends: rel.friends.map((k) => ({ name: displayNameFor(k), online: isOnline(k) })),
      requests: rel.requests.map(displayNameFor),
    };
  }

  // reparte un mensaje SÓLO a los sockets de los miembros del canal: el global
  // va a todos los autenticados, un DM/grupo sólo a sus miembros (la privacidad
  // no se delega al cliente).
  function pushChatMessage(channelId, message) {
    const members = channelMembers(chat, channelId);
    if (!members) return;
    const text = JSON.stringify({ type: 'chat', channel: channelId, message });
    const targets = members === 'global' ? null : new Set(members);
    for (const socket of clients) {
      try {
        if (!socket.data?.authorized) continue;
        if (targets && !targets.has(chatKey(socket.data.accountName || ''))) continue;
        socket.send(text);
      } catch {
        clients.delete(socket);
      }
    }
  }

  // avisa a los miembros que apareció un canal nuevo (un DM o un grupo)
  function pushChatChannel(ch) {
    const targets = ch.kind === 'global' ? null : new Set(ch.members);
    for (const socket of clients) {
      try {
        if (!socket.data?.authorized) continue;
        const key = chatKey(socket.data.accountName || '');
        if (targets && !targets.has(key)) continue;
        socket.send(JSON.stringify({ type: 'chat-channel', channel: publicChannel(ch, socket.data.accountName) }));
      } catch {
        clients.delete(socket);
      }
    }
  }

  // el latido de riesgo: take profit / stop loss / trailing, liquidaciones,
  // bancarrota y recapitalización. En el cliente esto vivía en checkTpSl,
  // checkLiquidations, checkBankruptcy y tickBankruptcy; con sesión lo decide
  // el servidor y el navegador sólo pinta lo que le llega.
  function runRiskSweep(gameDay, quotes) {
    const notices = new Map();
    const now = Date.now();
    for (const account of Object.values(accounts.accounts)) {
      const portfolio = account.portfolio;
      // una cuenta sin posiciones, sin efectivo y sin estar en bancarrota no
      // puede cambiar: el chequeo es el que cuesta, no se paga en cada tick
      const idle = portfolio.bankrupt !== true
        && !Object.keys(portfolio.positions || {}).length
        && Number(portfolio.cash) > 0;
      if (idle) continue;
      let entries;
      try {
        entries = runRiskPass(portfolio, quotes, { now, gameDay });
      } catch {
        continue;
      }
      if (!entries.length) continue;
      bumpPortfolioEpoch(account);
      portfolio.updatedAt = now;
      notices.set(accountKey(account.name), entries);
    }
    if (notices.size) persistAccounts();
    return notices;
  }

  function startTicking() {
    if (tickTimer || stopped) return;
    // si el reloj está congelado, el intervalo vuela: al reanudar startTicking()
    // lo vuelve a crear y el mercado sigue del segundo donde se quedó
    if (market.paused) return;
    let lastFinanceDay = Math.floor(market.gameTime / GAME_DAY_MS);
    // sondo: un sondeo automático cada tanto (el admin puede abrir custom)
    let nextPollAt = Date.now() + 90 * 1000;
    tickTimer = setInterval(() => {
      const news = tickMarketState(market);
      persistMarket();
      // los sondeos vencidos se cierran aquí: su voto colectivo empuja el precio
      const pollOut = resolveDuePolls(market);
      for (const closedPoll of pollOut.closed) {
        broadcast({ type: 'poll-closed', poll: closedPoll });
        if (closedPoll.result?.move > 0) {
          broadcast({ type: 'market-pulse', sym: closedPoll.sym, pct: closedPoll.result.majority === 'down' ? -closedPoll.result.move : closedPoll.result.move, source: 'poll' });
        }
        adminConsole.log('poll', `sondeo #${closedPoll.id} cerrado: ${closedPoll.result?.outcome} · ${closedPoll.up}↑/${closedPoll.down}↓ · movimiento ${closedPoll.result?.move}%`);
      }
      if (Date.now() >= nextPollAt && !activePoll()) {
        const auto = openPoll(market, {});
        if (auto) {
          broadcast({ type: 'poll-open', poll: auto });
          adminConsole.log('poll', `sondeo automático #${auto.id} abierto: ${auto.question}`);
        }
        nextPollAt = Date.now() + (6 + Math.random() * 9) * 60 * 1000;
      }
      const snapshot = marketSnapshot(market);
      const quotes = quoteMap();
      const gameDay = Math.floor(market.gameTime / GAME_DAY_MS);
      // once per game day: interest, dividends, expiring loans
      if (gameDay !== lastFinanceDay) {
        lastFinanceDay = gameDay;
        notifyFinance(runDailyFinance(gameDay, quotes));
      }
      // every tick: resting limit/stop orders
      notifyFinance(runOrderPass(gameDay, quotes));
      // every tick too: the exits, the liquidations and the bankruptcy clock
      notifyFinance(runRiskSweep(gameDay, quotes));
      broadcast({
        type: 'tick',
        sequence: market.sequence,
        intervalMs: market.intervalMs,
        gameTime: snapshot.gameTime,
        speed: snapshot.speed,
        quotes: snapshot.quotes,
        // the mood of the whole market travels with every tick: it changes a few
        // times an hour of play, and the client shows it next to the clock
        regime: snapshot.regime,
        candles: liveCandles(market),
        news,
      });
    }, tickMs);
    tickTimer.unref?.();
  }

  function stopTicking() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  // restarts the market timer at a new cadence, which is what the console's
  // "tickMs" parameter ends up doing
  function setTickMs(value) {
    const next = clampTickMs(value);
    if (next === tickMs) return tickMs;
    tickMs = next;
    market.intervalMs = next;
    if (tickTimer) {
      stopTicking();
      startTicking();
    }
    persistMarket();
    return tickMs;
  }

  // drops every live session of one account, so its sockets have to log back in
  function kickPlayer(account) {
    let kicked = 0;
    const key = accountKey(account.name);
    for (const [token, session] of Object.entries(accounts.sessions)) {
      if (session.key !== key) continue;
      delete accounts.sessions[token];
      kicked += 1;
    }
    if (kicked) {
      persistAccounts();
      sendToAccountSockets(account.name, JSON.stringify({ type: 'kicked', reason: 'El administrador cerró tu sesión' }));
    }
    return kicked;
  }

  // the ranking reads the stored portfolios against the live quotes on demand,
  // and the chained events are the market's own storyteller
  const leaderboard = createLeaderboard({ market, accounts });
  const events = createEventEngine({
    market,
    broadcast,
    random: options.random,
  });

  const adminConsole = createAdminConsole({
    market,
    accounts,
    events,
    broadcast,
    persistMarket,
    persistAccounts,
    startedAt: Date.now(),
    resetPortfolio: () => defaultPortfolio(),
    kickPlayer,
    onPortfolioOverride: (account) => pushPortfolioOverride(account),
    onTickMs: setTickMs,
    adminPolls: {
      list: () => adminPollsList(),
      open: (body, account) => {
        const opened = openPoll(market, {
          question: body.question,
          sym: body.sym,
          durationMs: body.durationMs,
          custom: true,
        });
        if (!opened) return { status: 400, body: { error: 'no se pudo abrir el sondeo' } };
        broadcast({ type: 'poll-open', poll: opened });
        adminConsole.log('poll', `sondeo custom #${opened.id} abierto por ${account.name}: ${opened.question}`);
        return { ok: true, poll: opened };
      },
      close: (body, account) => {
        const result = adminClosePoll(body.id);
        if (result.error) return { status: 400, body: result };
        adminConsole.log('poll', `sondeo #${result.id} cerrado a mano por ${account.name}`);
        return result;
      },
    },
    serverInfo: () => ({
      port,
      tickMs,
      candles: market.symbols.reduce(
        (total, symbol) => total + (symbol.candles?.intraday?.length || 0),
        0,
      ),
      dataDir,
    }),
  });

  function serveCatalog() {
    return json(OWN_GAMES, 200, { 'Cache-Control': 'no-store' });
  }

  function ownGamesIndex() {
    const rows = OWN_GAMES.map(
      (game) =>
        `<li><a href="${game.gameUrl}"><strong>${game.name}</strong></a><span>${game.description ?? ''}</span></li>`,
    ).join('');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>owngames</title><style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef5;margin:0;padding:48px}a{color:#29e0a8;text-decoration:none}ul{list-style:none;padding:0;display:grid;gap:12px;max-width:560px}li{background:#131a22;border:1px solid #223040;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:4px}span{color:#8aa0b4;font-size:13px}</style></head><body><h1>owngames</h1><ul>${rows}</ul></body></html>`;
  }

  async function serveStatic(pathname, req) {
    const rel = pathname.slice('/owngames/'.length);
    const target = rel.endsWith('/') ? `${rel}index.html` : rel;
    const filePath = safeJoin(publicDir, target);
    if (!filePath) return new Response('not found', { status: 404 });

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response('not found', { status: 404 });
    }
    const isHtml = target.endsWith('.html');
    const headers = {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-store' : 'no-cache',
    };
    // ETag barato (tamaño + mtime) para los estaticos: sin el, `no-cache` obliga
    // a reenviar el cuerpo ENTERO en cada revalidacion (el service worker y el
    // navegador no podian pedir "¿cambio?" y recibir un 304). con el tag, una
    // visita repetida cuesta un 304 sin cuerpo en vez de los ~570 KB de shell.
    if (!isHtml) {
      try {
        const st = fs.statSync(filePath);
        const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
        headers.ETag = etag;
        if (req && req.headers.get('if-none-match') === etag) {
          return new Response(null, { status: 304, headers });
        }
      } catch {
        // sin stat no hay tag: se sirve el archivo como siempre
      }
    }
    return new Response(file, { headers });
  }

  async function handleApi(req, url, server) {
    const pathname = url.pathname;
    const method = req.method;

    // ---- rutas públicas: se sirven sin sesion -------------------------------
    // llegan hasta el `authenticatedAccount` de mas abajo. dentro hay lecturas
    // de mercado (state, velas, historico, leaderboard, schedule) y tambien
    // las de alta e inicio de sesion (accounts, sessions), que son publicas
    // pero no son lecturas. una ruta nueva que necesite cuenta va por debajo
    // del corte, no aqui.
    if (pathname === '/api/market/state' && method === 'GET') {
      return json(marketSnapshot(market));
    }

    // búsqueda de música para el reproductor (pública, sin auth). `source`
    // decide contra qué se busca: youtube va por innertube (sin credenciales) y
    // spotify por su Web API (con credenciales; si faltan lo dice en vez de
    // devolver una lista vacía sin explicación)
    if (pathname === '/api/market/music/search' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').slice(0, 120);
      const source = url.searchParams.get('source') === 'spotify' ? 'spotify' : 'youtube';
      if (!q.trim()) {
        return json({ source, configured: true, failed: false, results: [] });
      }
      if (source === 'spotify') {
        const { configured, failed, results } = await music.searchSpotify(q);
        return json({ source, configured, failed, results });
      }
      return json({
        source,
        configured: true,
        failed: false,
        results: await music.searchYouTube(q),
      });
    }

    // "up next" de un video: recomendados reales de youtube para la cola
    if (pathname === '/api/market/music/related' && method === 'GET') {
      const id = (url.searchParams.get('v') || '').slice(0, 24);
      const results = await music.relatedYouTube(id);
      return json({ results });
    }

    // the ranking is public to read; a token (when present) only adds "you"
    if (pathname === '/api/market/leaderboard' && method === 'GET') {
      const viewer = authenticatedAccount(req);
      return json({
        ...leaderboard.snapshot({
          metric: url.searchParams.get('metric') || 'net',
          period: url.searchParams.get('period') || 'all',
          limit: url.searchParams.get('limit'),
          viewer,
        }),
      });
    }

    if (pathname === '/api/market/candles' && method === 'GET') {
      const symbol = url.searchParams.get('symbol') || '';
      const tf = url.searchParams.get('tf') || DEFAULT_TIMEFRAME;
      if (!timeframeFor(tf)) {
        return json({ error: 'marco temporal desconocido' }, 400);
      }
      const parsedLimit = Number.parseInt(url.searchParams.get('limit') || '0', 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 0), CANDLE_MAX_LIMIT)
        : 0;
      // the player's machine keeps its own copy of the history, so it asks with
      // `since` (its last stored bar) and receives only what is newer
      const parsedSince = Number.parseInt(url.searchParams.get('since') || '0', 10);
      const since = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0;
      const result = candlesFor(market, symbol, tf, limit, since);
      if (!result) return json({ error: 'símbolo desconocido' }, 404);

      // a delta answer is only valid for the cursor it was built for: the tag
      // pins the symbol, the timeframe, the cursor and the shape of the window so
      // a repeat request can be answered with a 304 instead of a body
      const last = result.candles[result.candles.length - 1];
      const etag = `W/"${symbol}.${tf}.${limit}.${result.since}.${result.windowStart}.${
        last ? `${last.t}-${last.c}-${result.candles.length}` : 0
      }"`;
      const headers = { ETag: etag, 'Cache-Control': 'no-store' };
      if (req.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers });
      }
      return json(result, 200, headers);
    }

    if (pathname === '/api/market/history' && method === 'GET') {
      const symbol = url.searchParams.get('symbol') || '';
      const limit = Number.parseInt(url.searchParams.get('limit') || '0', 10);
      const history = historyFor(market, symbol, Number.isFinite(limit) ? limit : 0);
      if (!history) return json({ error: 'símbolo desconocido' }, 404);
      return json(history);
    }

    if (pathname === '/api/market/accounts' && method === 'POST') {
      if (rateLimited(req, server)) {
        return json({ error: 'demasiados intentos, espera un momento' }, 429);
      }
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const result = registerAccount(accounts, body.name, body.password);
      if (!result.ok) return json({ error: result.error }, 409);
      result.account.admin = adminNames.has(accountKey(result.account.name));
      persistAccounts();
      return json(
        { token: result.token, account: publicAccount(accounts, result.account) },
        201,
      );
    }

    if (pathname === '/api/market/sessions' && method === 'POST') {
      if (rateLimited(req, server)) {
        return json({ error: 'demasiados intentos, espera un momento' }, 429);
      }
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const result = loginAccount(accounts, body.name, body.password);
      if (!result.ok) return json({ error: result.error }, 401);
      const ban = activeBan(chat, result.account.name, 'account');
      if (ban && !adminNames.has(accountKey(result.account.name))) {
        return json({ error: ban.reason ? `cuenta suspendida: ${ban.reason}` : 'cuenta suspendida', until: ban.until || 0 }, 403);
      }
      persistAccounts();
      return json({ token: result.token, account: publicAccount(accounts, result.account) });
    }

    if (pathname === '/api/market/sessions' && method === 'DELETE') {
      logoutAccount(accounts, bearerToken(req));
      persistAccounts();
      return json({ ok: true });
    }

    // the opencase catalog is world data (same for every player), so it ships
    // before the auth gate: the guest mode of csgo-opencase rolls with the
    // exact same weights as the server. también alimenta la validación de los
    // tradeos (sólo items reales del catálogo pueden pedirse en una oferta)
    if (pathname === '/api/market/skins/catalog' && method === 'GET') {
      setTradeCatalog(skinsCatalog());
      return json(skinsCatalog(), 200, { 'Cache-Control': 'no-store' });
    }

    // the case prices are world data too (same for every player): the guest
    // mode of the bolsa paints the panel from its own copy of the table and
    // checks it against this, so the two can't drift apart
    if (pathname === '/api/market/cases' && method === 'GET') {
      return json({ cases: caseCatalog() });
    }

    // the dividend schedule is world data (same for every player), so it ships
    // before the auth gate: guests read it without an account
    if (pathname === '/api/market/schedule' && method === 'GET') {
      return json({
        dividendSchedule: dividendTable(Math.floor(market.gameTime / GAME_DAY_MS)),
        dividendTax: DIVIDEND_TAX,
        rates: { savings: BANK_RATE_DAILY, loan: LOAN_RATE_DAILY, termDays: LOAN_TERM_DAYS, penalty: LOAN_PENALTY },
      });
    }

    // ---- fin de lo público ------------------------------------------------
    const account = authenticatedAccount(req);

    if (!account) return json({ error: 'sesión no válida' }, 401);

    // the admin console only exists for accounts on the allow-list; without one
    // every /admin route answers 403 and the game console falls back to local mode
    if (pathname.startsWith('/api/market/admin/')) {
      if (!adminConsole.isAdmin(account)) return json({ error: 'solo administradores' }, 403);
      // moderación del chat: vive aquí (y no en admin.mjs) para no acoplar la
      // consola del mercado con el store de comunidad
      if (pathname.startsWith('/api/market/admin/chat')) {
        const chatBody = method === 'GET' ? {} : await readJson(req).catch(() => ({}));
        if (pathname === '/api/market/admin/chat/messages' && method === 'GET') {
          const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '300', 10) || 300, 1), 1000);
          return json({
            messages: allMessages(chat, limit),
            channels: Object.values(chat.channels).map((ch) => publicChannel(ch, account.name)),
          });
        }
        if (pathname === '/api/market/admin/chat/ban' && method === 'POST') {
          const scope = chatBody.scope === 'account' ? 'account' : 'chat';
          const r = applyBan(chat, chatBody.name, scope, Number(chatBody.durationMs) || 0, chatBody.reason, account.name);
          if (!r.ok) return json({ error: r.error }, 400);
          persistChat();
          if (scope === 'account') {
            const target = accounts.accounts[accountKey(chatBody.name)];
            if (target) kickPlayer(target);
          }
          return json({ ok: true, entry: r.entry, scope });
        }
        if (pathname === '/api/market/admin/chat/unban' && method === 'POST') {
          const scope = chatBody.scope === 'account' ? 'account' : 'chat';
          const r = liftBan(chat, chatBody.name, scope, account.name);
          if (!r.ok) return json({ error: r.error }, 400);
          persistChat();
          return json({ ok: true, scope });
        }
        if (pathname === '/api/market/admin/chat/delete' && method === 'POST') {
          deleteMessage(chat, Number(chatBody.messageId) || 0);
          persistChat();
          return json({ ok: true });
        }
        if (pathname === '/api/market/admin/chat/audit' && method === 'GET') {
          return json({ audit: auditLog(chat) });
        }
        return json({ error: 'not found' }, 404);
      }
      const adminBody = method === 'GET'
        ? { since: Number.parseInt(url.searchParams.get('since') || '0', 10) }
        : await readJson(req).catch(() => ({}));
      const result = adminConsole.handle(pathname, method, adminBody, account);
      // solo el book de sondeos necesita un status propio: cerrarlo a mano puede
      // fallar (sondeo inexistente, ya cerrado) y eso no es un 200 con error
      if (result && result.status) return json(result.body, result.status);
      return json(result ?? { error: 'not found' });
    }

    // ---- chat: la comunidad de owngames (requiere sesión) -----------------
    // La identidad es la cuenta del market: sólo con sesión se lee y escribe.
    if (pathname === '/api/market/chat/channels' && method === 'GET') {
      return json({ channels: channelsFor(chat, account.name).map((ch) => publicChannel(ch, account.name)) });
    }

    if (pathname === '/api/market/chat/channels' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      if (body.kind === 'dm') {
        const withName = String(body.with || '');
        if (!accounts.accounts[chatKey(withName)]) return json({ error: 'cuenta desconocida' }, 404);
        const ch = openDm(chat, account.name, withName);
        persistChat();
        pushChatChannel(ch);
        return json({ ok: true, channel: publicChannel(ch, account.name) });
      }
      if (body.kind === 'group') {
        const members = (Array.isArray(body.members) ? body.members : []).filter((n) => accounts.accounts[chatKey(n)]);
        const ch = createGroup(chat, account.name, body.title, members);
        persistChat();
        pushChatChannel(ch);
        return json({ ok: true, channel: publicChannel(ch, account.name) });
      }
      return json({ error: 'tipo de canal inválido' }, 400);
    }

    if (pathname === '/api/market/chat/messages' && method === 'GET') {
      const channelId = url.searchParams.get('channel') || GLOBAL_CHANNEL;
      const ch = chat.channels[channelId];
      if (!ch || !isChannelMember(ch, account.name)) return json({ error: 'canal desconocido' }, 404);
      const since = Number.parseInt(url.searchParams.get('since') || '0', 10) || 0;
      return json({ channel: publicChannel(ch, account.name), messages: messagesFor(chat, channelId, since) });
    }

    if (pathname === '/api/market/chat/send' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const channelId = body.channel || GLOBAL_CHANNEL;
      const r = postMessage(chat, channelId, account.name, body.text);
      if (!r.ok) return json({ error: r.error }, r.error === 'canal desconocido' ? 404 : 403);
      persistChat();
      pushChatMessage(channelId, r.message);
      return json({ ok: true, message: r.message });
    }

    if (pathname === '/api/market/chat/friends' && method === 'GET') {
      return json(friendsView(account.name));
    }

    if (pathname === '/api/market/chat/friends' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const name = String(body.name || '');
      if (!accounts.accounts[chatKey(name)]) return json({ error: 'cuenta desconocida' }, 404);
      let r;
      if (body.action === 'request') r = requestFriend(chat, account.name, name);
      else if (body.action === 'accept') r = acceptFriend(chat, account.name, name);
      else if (body.action === 'remove') r = removeFriend(chat, account.name, name);
      else return json({ error: 'acción inválida' }, 400);
      if (!r.ok) return json({ error: r.error }, 400);
      persistChat();
      return json({ ok: true, ...friendsView(account.name) });
    }

    if (pathname === '/api/market/me' && method === 'GET') {
      return json({ account: publicAccount(accounts, account) });
    }

    // ---- sondo: los sondeos del piso -------------------------------------

    if (pathname === '/api/market/polls' && method === 'GET') {
      return json({ active: activePoll(), reward: 25 });
    }

    if (pathname === '/api/market/polls/vote' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const vote = castVote(body.id, body.side, account.name, account.portfolio);
      if (!vote.ok) return json({ error: vote.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      return json({ ok: true, poll: vote.poll, reward: vote.reward, cash: account.portfolio.cash });
    }

    if (pathname === '/api/market/me' && method === 'PUT') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      // server-authoritative money: the epoch is checked BEFORE anything is
      // applied — a save built from a stale in-memory snapshot (pre admin
      // grant/reset) must not touch the account at all. the client answers a
      // 409 by pulling the truth (resync) instead of clobbering the override.
      const clientEpoch = Number(body.epoch);
      if (Number.isFinite(clientEpoch) && account.portfolioEpoch && clientEpoch < account.portfolioEpoch) {
        adminConsole.log('info', `guardado rechazado para ${account.name}: estado desactualizado (epoch ${clientEpoch} < ${account.portfolioEpoch})`);
        return json({ account: publicAccount(accounts, account), epoch: account.portfolioEpoch, overridden: true }, 409);
      }
      // el registro de operaciones va PRIMERO, y es lo único que puede mover el
      // dinero: el cliente manda la intención (símbolo, acciones, apalancamiento)
      // y ledger.mjs la reproduce contra la cinta del servidor. lo que el
      // servidor rechaza no se aplica, así que un PUT con cash/positions/stats
      // editados a mano ya no es una puerta trasera — antes lo era.
      const quotes = quoteMap();
      const replay = replayOps(account.portfolio, body.ops, quotes, Date.now());
      if (replay.overflow) {
        return json({ error: 'demasiadas operaciones en un solo guardado' }, 400);
      }
      const applied = replay.results.filter((r) => r.ok);
      if (applied.length) {
        bumpPortfolioEpoch(account);
        // la cinta de operaciones es pública: lo que alguien compra, lo ve el
        // resto de la sala, igual que antes (el body.event hacía este papel)
        for (const result of applied) {
          const trade = {
            name: account.name,
            sym: result.sym,
            side: result.kind,
            shares: result.shares,
            price: result.price,
            at: Date.now(),
          };
          market.tape.unshift(trade);
          if (market.tape.length > TAPE_LIMIT) market.tape.length = TAPE_LIMIT;
          broadcast({ type: 'trade', trade });
          events.heat();
        }
        persistMarket();
      }
      // el libro de opencase sólo se toca si el save lo trae: un save de la
      // bolsa (o de un cliente sin cajas) sin campo skins NO puede borrar el
      // inventario ni los tradeos — el bug de "guardar inventario no funciona"
      const previousSkins = account.portfolio.skins;
      // el libro del banco tampoco viene del cliente: la mesa se liquida
      // server-side (bankAction / accrueBankDay), así que un save editado a
      // mano no puede acuñar balance. el libro que la cuenta ya tenía manda.
      const previousBank = account.portfolio.bank;
      // el segundo argumento es la cartera viva: cash, posiciones, historial,
      // estadísticas, órdenes y la bandera de bancarrota salen de ahí, no del
      // cuerpo de la petición
      account.portfolio = sanitizePortfolio(body.portfolio ?? body, account.portfolio);
      // el libro de opencase es un objeto con inventario; un array aquí sería
      // la lista de cosméticos de la bolsa y wipearía el inventario
      const incomingSkins = body.skins ?? body.portfolio?.skins;
      if (incomingSkins && typeof incomingSkins === 'object' && !Array.isArray(incomingSkins)) {
        account.portfolio.skins = sanitizeSkins(incomingSkins);
      } else if (previousSkins) {
        account.portfolio.skins = previousSkins;
      }
      // the bank book is server-owned, full stop (see previousBank above):
      // whatever the client sent in body.bank is ignored
      if (previousBank) account.portfolio.bank = previousBank;
      // same story for the casino book: the hand shape is cosmetic, the money
      // lives in portfolio.cash which sanitizePortfolio already clamped
      account.portfolio.casino = sanitizeCasino(body.casino ?? body.portfolio?.casino);
      // el inventario de la tienda viaja con el portfolio, saneado: sólo ids
      // reales del catálogo. el dinero NUNCA viaja aquí — se compra por ruta.
      account.shop = sanitizeShop(account.shop ?? body.shop ?? body.portfolio?.shop);
      account.portfolio.updatedAt = Date.now();
      // one net-worth sample per game day is what the ranking's period filters
      // compare against, so it is taken here, where the portfolio just changed
      leaderboard.recordSample(account);
      persistAccounts();

      // la cinta de operaciones se alimenta del registro reproducido (arriba),
      // no de un campo aparte: así lo que se ve operar a un jugador es
      // exactamente lo que el servidor le aplicó
      return json({
        account: publicAccount(accounts, account),
        // lo que el servidor no aplicó, para que el cliente pueda avisar en vez
        // de dejar un número optimista flotando en la cartera
        rejected: replay.results.filter((r) => !r.ok).map((r) => ({ kind: r.kind, sym: r.sym, error: r.error })),
        applied: applied.map((r) => ({ kind: r.kind, sym: r.sym, shares: r.shares, price: r.price, pnl: r.pnl })),
      });
    }

    // ---- las cajas de mercado del minijuego -------------------------------
    // el coste y la recompensa se sortean aquí (cases.mjs): el navegador ya no
    // decide cuánto vale un premio, sólo lo pinta en la cinta de la ruleta

    if (pathname === '/api/market/cases/open' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const result = openCase(account.portfolio, String(body.id || ''), quoteMap());
      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      return json({ ok: true, reward: result.reward, cost: result.cost, cash: result.cash, account: publicAccount(accounts, account) });
    }

    // ---- la tienda de cosméticos -----------------------------------------

    if (pathname === '/api/market/shop' && method === 'GET') {
      const shop = account.shop || defaultShop();
      return json({ items: SHOP_ITEMS, owned: shop.owned, ring: shop.ring, cash: account.portfolio.cash });
    }

    if (pathname === '/api/market/shop/buy' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      account.shop = account.shop || defaultShop();
      const result = shopBuy(account.portfolio, account.shop, String(body.id || ''));
      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      return json({ ok: true, item: result.item, cash: result.cash, owned: account.shop.owned });
    }

    if (pathname === '/api/market/shop/equip' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      account.shop = account.shop || defaultShop();
      const result = shopEquipRing(account.shop, body.id === null ? null : String(body.id || ''));
      if (!result.ok) return json({ error: result.error }, 400);
      persistAccounts();
      return json({ ok: true, ring: result.ring });
    }

    if (pathname === '/api/market/me/profile' && method === 'GET') {
      return json({ profile: account.profile || sanitizeProfile(null) });
    }

    if (pathname === '/api/market/me/profile' && method === 'PUT') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const profileInput = sanitizeProfile(body.profile ?? body);
      // el avatar premium sólo si la cuenta lo compró (o lo sacó de una caja:
      // state.skins viaja en el portfolio local, y aquí manda la tienda)
      const shopBook = account.shop || defaultShop();
      if (!profileAvatarAllowed(shopBook, profileInput.avatar)) {
        profileInput.avatar = sanitizeProfile(null).avatar;
      }
      account.profile = profileInput;
      persistAccounts();
      return json({ profile: account.profile });
    }

    if (pathname === '/api/market/portfolio' && method === 'POST') {
      // convenience endpoint for the offline/guest path: hand a fresh blank
      // portfolio back so the client can always start somewhere sane
      return json({ portfolio: defaultPortfolio() });
    }

    // ---- opencase: cajas estilo CS:GO, misma economía ---------------------

    // los jugadores conectados para el panel de tradeos de opencase: la lista
    // vive en memoria (no se persiste), el cliente la tira cada 5s y es barata
    if (pathname === '/api/market/players/online' && method === 'GET') {
      const online = [];
      for (const socket of clients) {
        try {
          if (!socket.data?.authorized || !socket.data?.accountName) continue;
          if (!online.some((p) => p.name === socket.data.accountName)) {
            online.push({ name: socket.data.accountName });
          }
        } catch {}
      }
      online.sort((a, b) => a.name.localeCompare(b.name));
      return json({ players: online, at: Date.now() }, 200, { 'Cache-Control': 'no-store' });
    }

    // el mercado de skins visto desde el server: valor total del loot en
    // manos de los jugadores, cuántas copias hay de cada skin y quién la
    // posee (para la pestaña de estadísticas de opencase — sin datos de nadie
    // que no sean los items: es cosmético)
    if (pathname === '/api/market/skins/market-stats' && method === 'GET') {
      const byItem = new Map();
      let totalValue = 0;
      let totalItems = 0;
      for (const acc of Object.values(accounts.accounts)) {
        const inv = acc.portfolio?.skins?.inventory;
        if (!Array.isArray(inv)) continue;
        const seen = new Set();
        for (const it of inv) {
          if (!it || typeof it !== 'object' || !it.item) continue;
          const key = String(it.item);
          let entry = byItem.get(key);
          if (!entry) {
            entry = { item: key, color: it.color || '#4b69ff', rarityName: it.rarityName || '?', value: Math.max(1, Math.round(Number(it.value) || 0)), owners: 0, copies: 0, stattrak: 0 };
            byItem.set(key, entry);
          }
          entry.copies += 1;
          entry.value = Math.max(entry.value, Math.round(Number(it.value) || 0));
          if (it.stattrak === true) entry.stattrak += 1;
          if (!seen.has(key)) { seen.add(key); entry.owners += 1; }
          totalValue += Math.max(0, Math.round(Number(it.value) || 0));
          totalItems += 1;
        }
      }
      const items = [...byItem.values()].sort((a, b) => b.value - a.value);
      return json({ totalValue, totalItems, uniqueItems: items.length, players: Object.keys(accounts.accounts).length, items }, 200, { 'Cache-Control': 'no-store' });
    }

    if (pathname === '/api/market/skins' && method === 'GET') {
      return json({ ...skinsSnapshot(account.portfolio), cash: account.portfolio.cash });
    }

    if (pathname === '/api/market/skins' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const result = skinsAction(account.portfolio, String(body.action || ''), body);
      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      // push en vivo dirigido: la bolsa y las demás pestañas de ESTA cuenta
      // ven el cash y el inventario cambiar sin recargar
      pushSkinsUpdate(account.name, String(body.action || ''), { cash: account.portfolio.cash, item: result.item || result.sold || null });
      return json({ ok: true, ...result });
    }

    // ---- tradeos de skins entre jugadores --------------------------------

    if (pathname === '/api/market/trades' && method === 'GET') {
      const book = (account.portfolio.skins && typeof account.portfolio.skins === 'object' && account.portfolio.skins.trades)
        ? account.portfolio.skins.trades
        : { sent: [], received: [] };
      return json({
        sent: Array.isArray(book.sent) ? book.sent : [],
        received: Array.isArray(book.received) ? book.received : [],
      });
    }

    if (pathname === '/api/market/trades' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const action = String(body.action || '');
      let result = { ok: false, error: 'acción desconocida' };
      let counterpart = null;

      if (action === 'propose') {
        const targetName = accountKey(body.to || '');
        const target = targetName ? Object.values(accounts.accounts).find((a) => accountKey(a.name) === targetName) : null;
        if (!target) return json({ error: 'no existe un jugador con ese nombre' }, 404);
        result = proposeTrade({ from: account, to: target, give: body.give, want: body.want, note: body.note });
        counterpart = target;
      } else if (action === 'accept') {
        // la contraparte real es la que aparece en la oferta recibida
        const offer = (account.portfolio.skins?.trades?.received || []).find((t) => t.id === String(body.tradeId || ''));
        const otherKey = offer ? String(offer.fromKey || '') : '';
        counterpart = otherKey ? Object.values(accounts.accounts).find((a) => accountKey(a.name) === otherKey) : null;
        result = counterpart ? acceptTrade({ from: counterpart, to: account, tradeId: body.tradeId }) : { ok: false, error: 'el ofertante ya no existe' };
      } else if (action === 'decline' || action === 'cancel') {
        const side = action === 'decline' ? 'received' : 'sent';
        const offer = ((side === 'received' ? account.portfolio.skins?.trades?.received : account.portfolio.skins?.trades?.sent) || [])
          .find((t) => t.id === String(body.tradeId || ''));
        const otherKey = offer ? (side === 'received' ? offer.fromKey : offer.toKey) : '';
        counterpart = otherKey ? Object.values(accounts.accounts).find((a) => accountKey(a.name) === otherKey) : null;
        result = resolveTrade({ portfolio: account.portfolio, side, tradeId: body.tradeId, status: action === 'decline' ? 'declined' : 'cancelled' });
        // el espejo en el portfolio de la contraparte (su libro es suyo; el
        // save de esta cuenta no puede escribirlo) — si está offline lo ve al
        // reconectar y si está online le llega el push de skins-update
        if (result.ok && counterpart) {
          const mirrorSide = side === 'received' ? 'sent' : 'received';
          ensureTradesBook(counterpart);
          const mirrored = counterpart.portfolio.skins.trades[mirrorSide].find((t) => t.id === String(body.tradeId || ''));
          if (mirrored && mirrored.status === 'pending') mirrored.status = result.offer.status;
        }
      }

      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      if (counterpart) { bumpPortfolioEpoch(counterpart); counterpart.portfolio.updatedAt = Date.now(); }
      persistAccounts();

      // push en vivo dirigido a ambos lados: sus cash/inventarios cambiaron
      // (accept) o al menos su libro de ofertas (propose/decline/cancel)
      pushSkinsUpdate(account.name, `trade-${action}`, { cash: account.portfolio.cash });
      if (counterpart) {
        notifyAccountFinance(counterpart.name, [{
          kind: 'trade-update',
          action,
          by: account.name,
          id: result.id || body.tradeId || '',
          ...(result.received ? { items: result.received.map((x) => x.item) } : {}),
          ...(result.sent ? { out: result.sent.map((x) => x.item) } : {}),
        }]);
        pushSkinsUpdate(counterpart.name, `trade-${action}`, { cash: counterpart.portfolio.cash });
      }
      return json({ ok: true, ...result });
    }

    // ---- the bank (BNT's IGB) -------------------------------------------

    if (pathname === '/api/market/bank' && method === 'GET') {
      return json({
        bank: account.portfolio.bank || defaultBank(),
        cash: account.portfolio.cash,
        rates: { savings: BANK_RATE_DAILY, loan: LOAN_RATE_DAILY, termDays: LOAN_TERM_DAYS, penalty: LOAN_PENALTY },
        transfer: { feeRate: TRANSFER_FEE_RATE, feeThreshold: TRANSFER_FEE_THRESHOLD },
      });
    }

    if (pathname === '/api/market/bank' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const quotes = quoteMap();
      const result = bankAction(
        account.portfolio,
        String(body.action || ''),
        body.amount,
        // the loan ceiling is "what you are worth", which is the live quote: a
        // position that fell is worth less, and this is the same sum the client
        // shows as patrimonio. without the quotes the desk would size every loan
        // on the price the shares were bought at.
        (sym) => quotes.get(sym)?.price,
      );
      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      return json({ ok: true, bank: result.bank, cash: account.portfolio.cash, note: result.note });
    }

    // P2P money transfer, bank desk style: validated against the live account
    // store (never the client's copy), both books written in one atomic call
    if (pathname === '/api/market/bank/transfer' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const targetName = accountKey(body.to || '');
      const target = targetName ? Object.values(accounts.accounts).find((a) => accountKey(a.name) === targetName) : null;
      if (!target) return json({ error: 'no existe un jugador con ese nombre' }, 404);
      const result = transferCash({
        from: account,
        to: target,
        toName: target.name,
        amount: body.amount,
        note: body.note,
      });
      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      bumpPortfolioEpoch(target);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      // the receiver learns about it right away (the same per-account notice
      // channel the dividends and the resting-order fills use); the net is
      // what lands, the fee is quoted so nobody wonders where money went
      notifyAccountFinance(target.name, [{ kind: 'transfer-in', from: account.name, amount: result.received, note: result.inEntry.note }]);
      return json({ ok: true, amount: result.amount, fee: result.fee, received: result.received, to: target.name, cash: account.portfolio.cash, transfers: account.portfolio.transfers });
    }

    // ---- the casino: every bet settles on the server ---------------------

    if (pathname === '/api/market/casino' && method === 'GET') {
      return json({
        cash: account.portfolio.cash,
        casino: account.portfolio.casino || sanitizeCasino(null),
        hand: account.portfolio.casino?.bj ? publicHand(account.portfolio.casino.bj) : null,
        limits: { min: CASINO_MIN_BET, max: CASINO_MAX_BET },
      });
    }

    if (pathname === '/api/market/casino' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      const result = casinoAction(account.portfolio, String(body.action || ''), body);
      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      return json({ ok: true, ...result });
    }

    // ---- resting limit/stop orders --------------------------------------

    if (pathname === '/api/market/orders' && method === 'GET') {
      return json({
        orders: account.portfolio.orders || [],
        ttlDays: ORDER_TTL_DAYS,
        dividendSchedule: dividendTable(Math.floor(market.gameTime / GAME_DAY_MS)),
        dividendTax: DIVIDEND_TAX,
      });
    }

    if (pathname === '/api/market/orders' && method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json({ error: 'cuerpo de la petición inválido' }, 400);
      }
      body.livePrice = Number(
        marketSnapshot(market).quotes.find((q) => q.sym === String(body.sym || '').toUpperCase())?.live,
      );
      body.day = Math.floor(market.gameTime / GAME_DAY_MS);
      const result = placeOrder(account.portfolio, body);
      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      return json({ ok: true, order: result.order, cash: account.portfolio.cash });
    }

    if (pathname === '/api/market/orders' && method === 'DELETE') {
      const id = url.searchParams.get('id') || '';
      const result = cancelOrder(account.portfolio, id);
      if (!result.ok) return json({ error: result.error }, 400);
      bumpPortfolioEpoch(account);
      account.portfolio.updatedAt = Date.now();
      persistAccounts();
      return json({ ok: true, cash: account.portfolio.cash });
    }

    return json({ error: 'not found' }, 404);
  }

  async function fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === '/health') {
      return new Response('oki', { headers: { 'Cache-Control': 'no-store' } });
    }

    if (pathname === '/ws/market') {
      const token = socketToken(req, url);
      // el socket nace autorizado si trae sesión de mercado O el JWT de
      // cloudsync: así el SSO no depende de que el cliente del juego sepa leer
      // una cookie httpOnly que nunca debió poder leer.
      const { account, created } = resolveRequestAccount(req, token);
      if (account && created) persistAccounts();
      const skipFrames = new Set(
        (url.searchParams.get('skip') || '')
          .split(',')
          .map((type) => type.trim())
          .filter(Boolean),
      );
      const upgraded = server.upgrade(req, {
        data: {
          token,
          authorized: Boolean(account),
          accountName: account ? account.name : null,
          sso: Boolean(account) && !authenticate(accounts, token),
          skipFrames,
        },
      });
      if (upgraded) return undefined;
      return new Response('websocket upgrade failed', { status: 400 });
    }

    if (pathname === '/owngames/catalog.json') return serveCatalog();
    if (pathname === '/owngames' || pathname === '/owngames/') {
      return new Response(ownGamesIndex(), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (pathname.startsWith('/owngames/')) return serveStatic(pathname, req);

    if (pathname.startsWith('/api/market/')) return handleApi(req, url, server);

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        },
      });
    }

    return new Response('not found', { status: 404 });
  }

  const server = Bun.serve({
    port,
    hostname,
    fetch,
    websocket: {
      idleTimeout: 120,
      open(socket) {
        clients.add(socket);
        if (!wantsFrame(socket, 'snapshot')) return;
        socket.send(
          JSON.stringify({
            type: 'snapshot',
            snapshot: marketSnapshot(market),
            candles: liveCandles(market),
            tape: market.tape,
          }),
        );
      },
      message(socket, message) {
        let payload = null;
        try {
          payload = JSON.parse(typeof message === 'string' ? message : String(message));
        } catch {
          return;
        }
        if (!payload || typeof payload !== 'object') return;        if (payload.type === 'auth') {
          // un socket ya autorizado por SSO (cookie en el handshake) no se
          // desautoriza con un frame de auth vacío: el juego manda su token de
          // mercado, no lo tiene, y sin esta guarda el SSO se caería al
          // conectar y reconectar.
          if (socket.data.sso && !String(payload.token || '')) {
            socket.send(JSON.stringify({ type: 'auth', ok: true }));
            return;
          }
          const authenticated = authenticate(accounts, payload.token);
          socket.data.authorized = Boolean(authenticated);
          socket.data.sso = false;
          if (authenticated) {
            const account = accounts.accounts[accountKey(authenticated.name)];
            socket.data.accountName = account ? account.name : null;
          } else {
            socket.data.accountName = null;
          }
          socket.send(JSON.stringify({ type: 'auth', ok: socket.data.authorized }));
          return;
        }
        if (payload.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
        }
      },
      close(socket) {
        clients.delete(socket);
      },
    },
  });

  if (options.autoTick !== false) {
    startTicking();
    if (options.autoEvents !== false) events.start();
  }

  function flush() {
    persistMarket();
    persistAccounts();
    marketStore.flush();
    history.flush();
    accountStoreFile.flush();
    chatStoreFile.flush();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    stopTicking();
    events.stop();
    flush();
    try {
      server.stop(true);
    } catch {}
  }    return {
    server,
    port: server.port,
    market,
    accounts,
    adminConsole,
    leaderboard,
    events,
    clients,
    broadcast,
    persistMarket,
    persistAccounts,
    flush,
    history,
    adminNames,
    startTicking,
    // expuesto para las pruebas: el latido de riesgo también se puede pasar a
    // mano, sin esperar al timer del mercado
    runRiskSweep,
    stop,
    dataDir,
    publicDir,
    tickMs,
  };
}

// argv de línea de comandos: gana sobre env, pierde sobre options de código.
// antes esto no existía y `--data-dir` se ignoraba en silencio — un server de
// prueba arrancado con ese flag escribia en el data real. no más.
function parseArgv(argv) {
  const out = {};
  const take = (flag, key, cast = (v) => v) => {
    const i = argv.indexOf(flag);
    if (i === -1) return;
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      console.error(`falta el valor de ${flag}`);
      process.exit(2);
    }
    out[key] = cast(argv[i + 1]);
  };
  take('--port', 'port', Number.parseInt);
  take('--host', 'hostname');
  take('--data-dir', 'dataDir');
  take('--tick-ms', 'tickMs', Number.parseInt);
  take('--admin-names', 'adminNames');
  if (argv.includes('--help')) {
    console.log('flags: --port N --host H --data-dir PATH --tick-ms N --admin-names a,b');
    process.exit(0);
  }
  return out;
}

if (import.meta.main) {
  const instance = createMarketServer(parseArgv(process.argv.slice(2)));
  console.log(`market service listening on ${instance.port} (data: ${instance.dataDir})`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nsaving market and player statistics...');
    instance.stop();
    console.log('market state saved');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => instance.stop());
}
