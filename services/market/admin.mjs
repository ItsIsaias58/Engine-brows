// admin console for the market service: the levers a game master can pull.
//
// server.mjs mounts everything here under /api/market/admin/*, and every route
// requires a bearer token whose account was marked as admin (`MARKET_ADMIN_NAMES`
// in the environment, see the README). The console in the game is a client of
// these routes, but it also works with no server at all — it just applies the
// same events to its own copy of the market (see js/admin.js).
//
// the module never touches the network: it mutates the market state through the
// engine's admin hooks, keeps a ring buffer of what was done and returns plain
// objects the server serializes.
import {
  adminForceRegime,
  adminHalt,
  adminPause,
  adminPublishNews,
  adminResetPrices,
  adminSettleNow,
  adminSetSpeed,
  adminShock,
  marketQuotes,
} from './engine.mjs';

export const ADMIN_LOG_LIMIT = 400;
const MAX_GRANT = 1_000_000;

function clamp(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function createAdminConsole(options = {}) {
  const market = options.market;
  const accounts = options.accounts;
  const broadcast = options.broadcast ?? (() => {});
  const persistMarket = options.persistMarket ?? (() => {});
  const persistAccounts = options.persistAccounts ?? (() => {});
  const startedAt = options.startedAt ?? Date.now();
  const serverInfo = options.serverInfo ?? (() => ({}));
  const kickPlayer = options.kickPlayer ?? (() => false);
  // the server's push hook: admin money moves must reach the affected client
  // immediately, or its stale in-memory state overwrites them on the next save
  const onPortfolioOverride = options.onPortfolioOverride ?? (() => {});
  // the poll routes used to be written by hand in server.mjs, right in front of
  // this handle(): the only three admin routes that did not live with the rest.
  // the server owns the poll book, so it passes the three calls in here.
  const adminPolls = options.adminPolls ?? null;

  const logs = [];

  function log(level, msg) {
    logs.unshift({ t: Date.now(), level: String(level || 'info').slice(0, 24), msg: String(msg || '').slice(0, 300) });
    if (logs.length > ADMIN_LOG_LIMIT) logs.length = ADMIN_LOG_LIMIT;
  }

  log('info', 'consola de administrador lista');

  // the console shows who is around: one row per account, with the live balance
  // of its portfolio, which is what the "grant cash" and "kick" buttons act on
  function players() {
    const list = [];
    const now = Date.now();
    for (const account of Object.values(accounts.accounts || {})) {
      const portfolio = account.portfolio || {};
      const sessions = Object.entries(accounts.sessions || {})
        .filter(([, session]) => session.key === account.id || session.key === account.name?.toLowerCase?.())
        .filter(([, session]) => session.expiresAt > now).length;
      list.push({
        id: account.id,
        name: account.name,
        admin: account.admin === true,
        cash: Number(portfolio.cash) || 0,
        positions: Object.keys(portfolio.positions || {}).length,
        level: portfolio.level ?? 1,
        xp: portfolio.xp ?? 0,
        bankrupt: portfolio.bankrupt === true,
        online: sessions > 0,
        lastSeenAt: account.lastSeenAt ?? account.lastLoginAt ?? account.createdAt ?? 0,
      });
    }
    return list.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  }

  function status() {
    const quotes = marketQuotes(market);
    return {
      ...serverInfo(),
      uptimeMs: Date.now() - startedAt,
      players: players().length,
      online: players().filter((player) => player.online).length,
      sequence: market.sequence,
      gameTime: market.gameTime,
      paused: market.paused === true,
      speed: market.speed ?? null,
      regime: market.regime ? { ...market.regime } : null,
      halted: market.symbols.filter((symbol) => symbol.halted).map((symbol) => symbol.sym),
      best: quotes.reduce((best, quote) => (best && best.pct >= quote.pct ? best : quote), null),
      worst: quotes.reduce((worst, quote) => (worst && worst.pct <= quote.pct ? worst : quote), null),
    };
  }

  // the levers. each returns a small result object so the console can log what
  // actually happened (how many symbols were hit, and so on).
  const actions = {
    shock(body = {}) {
      const sym = String(body.sym || 'ALL').toUpperCase();
      const pct = clamp(Number(body.pct), -90, 300);
      const gradual = body.gradual !== false;
      const targets = adminShock(market, sym, pct, gradual);
      if (!targets) return { error: 'símbolo desconocido' };
      log('shock', `${sym} ${pct >= 0 ? '+' : ''}${pct}%${gradual ? ' (gradual)' : ' (instantáneo)'} · ${targets} símbolos`);
      persistMarket();
      return { ok: true, targets, gradual };
    },

    news(body = {}) {
      const sym = String(body.sym || '').toUpperCase();
      const pct = clamp(Number(body.pct), -90, 300);
      const item = adminPublishNews(market, sym, pct, typeof body.title === 'string' ? body.title.slice(0, 160) : '');
      if (!item) return { error: 'símbolo desconocido' };
      log('news', `${item.sym} · ${item.title} · ${item.pct >= 0 ? '+' : ''}${item.pct}%`);
      persistMarket();
      // the headline goes out on its own message so every client shows it now
      broadcast({ type: 'news', news: [item] });
      return { ok: true, item };
    },

    earnings(body = {}) {
      const sym = String(body.sym || '').toUpperCase();
      const pct = clamp(Number(body.pct), -90, 300);
      const symbol = market.symbols.find((entry) => entry.sym === sym);
      if (!symbol) return { error: 'símbolo desconocido' };
      const item = adminPublishNews(
        market,
        sym,
        pct,
        `${symbol.name} reporta resultados ${pct >= 0 ? 'mejores' : 'peores'} de lo esperado`,
      );
      log('earnings', `${sym} ${pct >= 0 ? '+' : ''}${pct}%`);
      persistMarket();
      broadcast({ type: 'news', news: [item] });
      return { ok: true, item };
    },

    regime(body = {}) {
      const regime = adminForceRegime(market, String(body.kind || 'alcista'), Number(body.strength), Number(body.days));
      log('regime', `${regime.kind} · fuerza ${regime.strength.toFixed(2)} · ${Math.round(regime.left / 1440)} días de juego`);
      persistMarket();
      return { ok: true, regime };
    },

    halt(body = {}) {
      const sym = String(body.sym || 'ALL').toUpperCase();
      const halt = body.halt !== false;
      const targets = adminHalt(market, sym, halt);
      if (!targets) return { error: 'símbolo desconocido' };
      log('halt', `${sym} ${halt ? 'detenido' : 'reanudado'} · ${targets} símbolos`);
      persistMarket();
      return { ok: true, targets, halt };
    },

    pause(body = {}) {
      const paused = adminPause(market, body.paused !== false);
      log('pause', paused ? 'reloj congelado' : 'reloj reanudado');
      persistMarket();
      return { ok: true, paused };
    },

    speed(body = {}) {
      const speed = adminSetSpeed(market, Number(body.speed));
      log('speed', `×${speed}`);
      persistMarket();
      return { ok: true, speed };
    },

    settle() {
      const settled = adminSettleNow(market);
      log('settle', `ajuste forzado en ${settled} símbolos`);
      persistMarket();
      return { ok: true, settled };
    },

    'reset-prices'() {
      const symbols = adminResetPrices(market);
      log('reset', `precios reiniciados (${symbols} símbolos)`);
      persistMarket();
      return { ok: true, symbols };
    },

    rally(body = {}) {
      const sym = String(body.sym || 'ALL').toUpperCase();
      const pct = Math.abs(clamp(Number(body.pct), 0, 300));
      const targets = adminShock(market, sym, pct, true);
      if (!targets) return { error: 'símbolo desconocido' };
      log('rally', `${sym} +${pct}% durante ${clamp(Number(body.days), 1, 60)} días de juego`);
      persistMarket();
      return { ok: true, targets };
    },

    'flash-crash'(body = {}) {
      const sym = String(body.sym || 'ALL').toUpperCase();
      const pct = Math.abs(clamp(Number(body.pct), 1, 90));
      const targets = adminShock(market, sym, -pct, false);
      if (!targets) return { error: 'símbolo desconocido' };
      log('crash', `${sym} -${pct}% instantáneo · ${targets} símbolos`);
      persistMarket();
      return { ok: true, targets };
    },

    params(body = {}) {
      // only the levers the engine can honour at runtime are applied; the rest is
      // kept by the console in its own storage
      const applied = {};
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const engine = params.engine && typeof params.engine === 'object' ? params.engine : null;
      if (engine) {
        if (Number.isFinite(Number(engine.tickMs))) applied.tickMs = clamp(Number(engine.tickMs), 200, 60_000);
        if (Number.isFinite(Number(engine.speed))) applied.speed = adminSetSpeed(market, Number(engine.speed));
      }
      log('params', `sección ${body.section || 'todas'} · ${JSON.stringify(applied)}`);
      persistMarket();
      return { ok: true, applied };
    },

    // fires one of the chained market events by hand: the console doubles as a
    // way to summon a story and watch how everyone reacts
    event(body = {}) {
      const engine = options.events;
      if (!engine || typeof engine.fire !== 'function') return { error: 'el motor de eventos no está activo' };
      const instance = engine.fire(typeof body.chainId === 'string' ? body.chainId : undefined);
      if (!instance) return { error: 'cadena desconocida' };
      log('event', `${instance.chainId} · ${instance.label} · ${instance.sym}`);
      return { ok: true, chainId: instance.chainId, label: instance.label, sym: instance.sym };
    },

    broadcast(body = {}) {
      const title = String(body.title || 'Aviso').slice(0, 80);
      const msg = String(body.msg || '').slice(0, 240);
      const kind = ['up', 'down', 'gold', 'info'].includes(body.kind) ? body.kind : 'gold';
      log('broadcast', `${title} · ${msg}`);
      broadcast({ type: 'admin-broadcast', title, msg, kind });
      return { ok: true };
    },

    player(body = {}) {
      const id = String(body.id || '');
      const account = Object.values(accounts.accounts || {}).find(
        (entry) => entry.id === id || entry.name === id,
      );
      if (!account) return { error: 'jugador desconocido' };
      const action = String(body.action || '');
      if (action === 'grant') {
        const amount = clamp(Number(body.amount), -MAX_GRANT, MAX_GRANT);
        const portfolio = account.portfolio || {};
        portfolio.cash = Math.max(0, (Number(portfolio.cash) || 0) + amount);
        portfolio.updatedAt = Date.now();
        persistAccounts();
        onPortfolioOverride(account);
        log('player', `${account.name} ${amount >= 0 ? '+' : ''}${amount} de cash`);
        return { ok: true, cash: portfolio.cash };
      }
      if (action === 'reset') {
        account.portfolio = options.resetPortfolio ? options.resetPortfolio() : account.portfolio;
        persistAccounts();
        onPortfolioOverride(account);
        log('player', `${account.name} reiniciado`);
        return { ok: true };
      }
      if (action === 'kick') {
        const kicked = kickPlayer(account);
        log('player', `${account.name} expulsado (${kicked} sesiones)`);
        return { ok: true, kicked };
      }
      return { error: 'acción desconocida' };
    },
  };

  /**
   * runs one admin route. returns null when the path is not an admin route at
   * all, so the caller can keep looking; otherwise the object to serialize.
   */
  function handle(pathname, method, body, account) {
    if (!pathname.startsWith('/api/market/admin/')) return null;
    const route = pathname.slice('/api/market/admin/'.length).replace(/\/+$/, '');

    if (adminPolls && route.startsWith('polls')) {
      if (route === 'polls' && method === 'GET') return adminPolls.list();
      if (route === 'polls' && method === 'POST') return adminPolls.open(body || {}, account);
      if (route === 'polls/close' && method === 'POST') return adminPolls.close(body || {}, account);
      return { error: 'not found' };
    }

    if (method === 'GET') {
      if (route === 'status') return status();
      if (route === 'players') return { players: players() };
      if (route === 'logs') {
        const since = Number(body?.since) || 0;
        return { logs: since > 0 ? logs.filter((entry) => entry.t > since) : logs };
      }
      return { error: 'not found' };
    }

    if (method === 'POST') {
      if (route === 'params') {
        const result = actions.params(body || {});
        // a new tick length restarts the timer, which the server owns
        if (result.applied && Number.isFinite(result.applied.tickMs) && options.onTickMs) {
          options.onTickMs(result.applied.tickMs);
        }
        return result;
      }
      const action = actions[route];
      if (!action) return { error: 'not found' };
      return action(body || {});
    }

    return { error: 'not found' };
  }

  return {
    handle,
    status,
    players,
    actions,
    logs: () => logs,
    log,
    isAdmin: (account) => Boolean(account && account.admin === true),
  };
}
