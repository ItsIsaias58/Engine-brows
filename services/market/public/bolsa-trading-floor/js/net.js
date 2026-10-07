// realtime + account client for the trading floor. the server owns the price
// walk and the persisted portfolio, this module keeps the local game state in
// sync with it over a websocket and a small REST surface.

const MARKET_TOKEN_KEY = 'bolsa-market-token';
const MARKET_NAME_KEY = 'bolsa-market-name';
const MARKET_GUEST_KEY = 'bolsa-market-guest';
const MARKET_WS_PATH = '/ws/market';
const MARKET_SAVE_DEBOUNCE_MS = 700;

let marketToken = '';
let marketAccountName = '';
// the account payload the server last confirmed: it carries the admin flag, so
// the console knows whether it may open at all
let marketAccount = null;
let marketGuest = false;
// SSO con cloudsync: hay sesión de mercado sin token local, porque el servidor
// autentica con el JWT de la nube que viaja en la cookie del handshake
let marketSso = false;
let marketSocket = null;
let marketSocketReady = false;
let marketReconnectTimer = null;
let marketReconnectDelay = 1000;
// true entre una caída del socket y la reconexión: gobierna el sonido de
// "conexión restablecida"
let hadSocketDrop = false;
let marketLastTickAt = 0;
let marketTickIntervalMs = 1400;
let marketSaveTimer = null;
// game clock: the server streams its game time and speed, and the client keeps
// it running between ticks (one real minute is one game day)
let marketGameTime = 0;
let marketGameTimeAt = 0;
let marketGameSpeed = 1440;
const marketTape = [];
// ETags of the last candle answers, so asking for the same gap again can be
// answered with a 304 instead of a body (key -> etag)
const marketCandleEtags = new Map();
// how long a candle request may stay unanswered before it is aborted
const CANDLE_FETCH_TIMEOUT_MS = 8000;
// the portfolio the server confirmed last: identical snapshots are not PUT again
let marketLastSavedSignature = '';
// server-authoritative money: epoch stamped by the server on admin grant/reset;
// saves carry it and a stale save gets a 409 -> resync (see resyncFromServer)
let marketPortfolioEpoch = 0;
let marketLastResyncAt = 0;
// each company's own character, straight from the market snapshot: the asset
// summary reads it to explain why two symbols do not behave the same
let marketCompanyProfiles = {};
// the mood of the whole market (kind: alcista / bajista / lateral) and how much
// game time it still has left, straight from the server
let marketRegime = null;
// one game day of market time, used to tell whether a stored window is whole
const WINDOW_DAY_MS = 24 * 60 * 60 * 1000;
// la serie diaria (un punto por dia de juego) es la que pinta la vida entera de
// la empresa en el panel de abajo; el servidor la sirve con este timeframe
const DAILY_TF = '1W';

try {
  marketToken = localStorage.getItem(MARKET_TOKEN_KEY) || '';
  // el socket lo abre el servidor a partir de la cookie, no de la query
  setMarketTokenCookie(marketToken);
  marketAccountName = localStorage.getItem(MARKET_NAME_KEY) || '';
  marketGuest = localStorage.getItem(MARKET_GUEST_KEY) === '1';
} catch (e) {}

// hay sesión si hay token de mercado o si el servidor nos autenticó por la
// sesión de cloudsync (marketSso, resuelta por restoreSession)
function hasSession() {
  return Boolean(marketToken) || marketSso;
}

const MarketNet = {
  get token() { return marketToken; },
  get accountName() { return marketAccountName; },
  get isGuest() { return marketGuest && !hasSession(); },
  get signedIn() { return hasSession(); },
  get account() { return marketAccount; },
  // only an account the server marked as admin may open the remote console; the
  // game console still works in local mode without it (see js/admin.js)
  get isAdmin() { return Boolean(hasSession() && marketAccount && marketAccount.admin === true); },
  get live() {
    return marketSocketReady && Date.now() - marketLastTickAt < marketTickIntervalMs * 3;
  },
  get socketReady() { return marketSocketReady; },
  get regime() { return marketRegime; },
  get tape() { return marketTape; },
  get gameTime() {
    if (!marketGameTime) return Date.now();
    const elapsed = Math.max(0, Date.now() - marketGameTimeAt);
    return marketGameTime + Math.round(elapsed * marketGameSpeed);
  },
  get gameSpeed() { return marketGameSpeed; },

  // local mode: the console can speed up or freeze its own clock. in remote mode
  // the server applies it and every tick carries the new speed back
  setGameSpeed(speed) {
    const value = Number(speed);
    if (Number.isFinite(value) && value > 0) {
      marketGameSpeed = value;
      marketGameTime = this.gameTime;
      marketGameTimeAt = Date.now();
    }
    return marketGameSpeed;
  },

  // local mode only: force the market mood this client paints
  setRegime(regime) {
    if (regime && typeof regime === 'object') {
      marketRegime = { kind: 'lateral', bias: 0, strength: 0.5, left: 0, ...regime };
    }
    return marketRegime;
  },

  setAccount(token, name, account) {
    marketToken = token || '';
    marketAccountName = name || '';
    marketAccount = account || null;
    marketGuest = false;
    marketSso = false;
    // server-authoritative money: the epoch the server stamped on this account
    // (bumped on every admin grant/reset). saves carry it; a stale save is refused.
    marketPortfolioEpoch = (account && account.portfolioEpoch) || 0;
    // another player's portfolio starts from scratch: never inherit the saved
    // signature of the session that was just replaced
    marketLastSavedSignature = '';
    // a socket opened as guest (or as the previous account) is NOT authorized:
    // the server filters every finance push by socket. upgrading in place with
    // an auth frame means a mid-session login starts receiving transfers,
    // dividends and order fills without dropping the live feed
    if (marketSocket && marketSocket.readyState === WebSocket.OPEN && marketToken) {
      try { marketSocket.send(JSON.stringify({ type: 'auth', token: marketToken })); } catch (e) {}
    }
    try {
      if (marketToken) localStorage.setItem(MARKET_TOKEN_KEY, marketToken);
      else localStorage.removeItem(MARKET_TOKEN_KEY);
      setMarketTokenCookie(marketToken);
      if (marketAccountName) localStorage.setItem(MARKET_NAME_KEY, marketAccountName);
      else localStorage.removeItem(MARKET_NAME_KEY);
      localStorage.removeItem(MARKET_GUEST_KEY);
    } catch (e) {}
    notifySessionChange();
  },

  clearAccount() {
    marketToken = '';
    marketAccountName = '';
    marketAccount = null;
    marketSso = false;
    marketLastSavedSignature = '';
    try {
      localStorage.removeItem(MARKET_TOKEN_KEY);
      localStorage.removeItem(MARKET_NAME_KEY);
    } catch (e) {}
    notifySessionChange();
  },

  continueAsGuest() {
    marketGuest = true;
    // elegir invitado a mano descarta el SSO: el usuario pidió no usar cuenta
    marketSso = false;
    try { localStorage.setItem(MARKET_GUEST_KEY, '1'); } catch (e) {}
    notifySessionChange();
  },

  // SSO con cloudsync: si no hay token de mercado pero sí una sesión de la nube
  // (el servidor la ve en la cookie del handshake), este probe la descubre y
  // adopta la cuenta. sin sesión de nube no cambia nada: el login de siempre
  // sigue igual. nunca manda Authorization; la cookie viaja sola.
  async restoreSession() {
    if (marketToken) return true;
    try {
      const payload = await this.request('/api/market/me');
      if (payload && payload.account) {
        marketSso = true;
        marketAccount = payload.account;
        marketAccountName = payload.account.name || '';
        marketPortfolioEpoch = payload.account.portfolioEpoch || 0;
        notifySessionChange();
        return true;
      }
    } catch (e) { /* sin sesión de nube: seguimos como antes */ }
    marketSso = false;
    return false;
  },

  async request(path, options = {}) {
    const headers = Object.assign(
      { Accept: 'application/json' },
      options.body ? { 'Content-Type': 'application/json' } : {},
      options.headers || {},
    );
    if (marketToken) headers.Authorization = `Bearer ${marketToken}`;

    const response = await fetch(path, Object.assign({}, options, { headers }));
    let payload = null;
    try { payload = await response.json(); } catch (e) {}
    if (!response.ok) {
      const message = (payload && payload.error) || `error ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  },

  async register(name, password) {
    const payload = await this.request('/api/market/accounts', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    });
    this.setAccount(payload.token, payload.account && payload.account.name, payload.account);
    return payload;
  },

  async login(name, password) {
    const payload = await this.request('/api/market/sessions', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    });
    this.setAccount(payload.token, payload.account && payload.account.name, payload.account);
    return payload;
  },

  async logout() {
    try {
      await this.request('/api/market/sessions', { method: 'DELETE' });
    } catch (e) {}
    this.clearAccount();
    this.disconnect();
  },

  async fetchState() {
    return this.request('/api/market/state');
  },

  // real OHLC candles aggregated server side (same origin, so nothing for a
  // network filter to block). `since` asks only for the bars newer than the last
  // one the player's machine already stored, and the ETag it sends back lets a
  // repeat request be answered without a body.
  async fetchCandles(symbol, timeframe = '5m', options = {}) {
    const limit = Number.isFinite(options.limit) ? options.limit : 1200;
    const since = Number.isFinite(options.since) && options.since > 0 ? options.since : 0;
    const query = new URLSearchParams({
      symbol,
      tf: timeframe,
      limit: String(limit),
    });
    if (since > 0) query.set('since', String(since));

    const headers = { Accept: 'application/json' };
    if (marketToken) headers.Authorization = `Bearer ${marketToken}`;
    const cacheKey = `${symbol}|${timeframe}|${since}`;
    const known = marketCandleEtags.get(cacheKey);
    if (known) headers['If-None-Match'] = known;

    // a request that never answers must not leave the chart stuck on the
    // generated series forever: after CANDLE_FETCH_TIMEOUT_MS it is aborted and
    // the caller's catch keeps the local copy on screen
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), CANDLE_FETCH_TIMEOUT_MS) : 0;
    try {
      const response = await fetch(`/api/market/candles?${query.toString()}`, {
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const etag = response.headers.get('etag');
      if (etag) marketCandleEtags.set(cacheKey, etag);
      // 304: the copy stored on this machine is already the current one
      if (response.status === 304) return { candles: [], cached: true, etag };
      if (!response.ok) throw new Error(`error ${response.status}`);
      return await response.json();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  },

  async fetchPortfolio() {
    const payload = await this.request('/api/market/me');
    // this is also how a reload remembers the admin flag: the token survives in
    // storage, and the account payload comes back with it
    if (payload && payload.account) {
      marketAccount = payload.account;
      if (payload.account.name) marketAccountName = payload.account.name;
      if (payload.account.portfolioEpoch) marketPortfolioEpoch = payload.account.portfolioEpoch;
    }
    return payload && payload.account ? payload.account.portfolio : null;
  },

  // the server refused a save built from stale state (an admin grant/reset
  // happened while our in-memory copy was old): pull the truth and adopt it.
  // throttle a 1s: es el canal por el que el cash movido en opencase (cajas,
  // ventas, tradeos) aterriza acá en tiempo real — el usuario pidió que la
  // verificación de activos entre ambos juegos corra cada segundo
  async resyncFromServer() {
    if (!hasSession()) return;
    // hay operaciones optimistas sin enviar: primero se liquidan, o el resync
    // las borraría de la cartera y la operación aparecería y desaparecería
    if (marketPendingOps.length || marketInFlightOps.length) {
      if (marketSaveTimer) { clearTimeout(marketSaveTimer); marketSaveTimer = null; }
      await MarketNet.flushPortfolio();
      return;
    }
    const now = Date.now();
    if (now - marketLastResyncAt < 1000) return; // no resync storms
    marketLastResyncAt = now;
    try {
      const payload = await this.request('/api/market/me');
      if (payload && payload.account) {
        marketAccount = payload.account;
        if (payload.account.portfolioEpoch) marketPortfolioEpoch = payload.account.portfolioEpoch;
        applyServerPortfolio(payload.account.portfolio);
        marketLastSavedSignature = '';
        if (typeof saveGame === 'function') saveGame();
      }
    } catch (e) { /* offline: the regular retry cadence will catch up */ }
  },

  savePortfolio() {
    if (!hasSession()) return;
    if (marketSaveTimer) return;
    marketSaveTimer = setTimeout(() => {
      marketSaveTimer = null;
      MarketNet.flushPortfolio();
    }, MARKET_SAVE_DEBOUNCE_MS);
  },

  // el envío de verdad: se lleva el registro pendiente, y con la respuesta
  // adopta la cartera del servidor (el efectivo puede haber cambiado por
  // dividends, intereses, órdenes ejecutadas o la recapitalización)
  flushPortfolio() {
    if (!hasSession()) return Promise.resolve(null);
    const ops = marketDrainOps();
    const portfolio = marketPortfolioSnapshot();
    // the game saves every couple of seconds even when nothing happened, and
    // the prices it holds do not change what the server stores: skip the round
    // trip when there is nothing new to persist
    const signature = `${JSON.stringify(ops)}|${marketPortfolioSignature(portfolio)}`;
    if (!ops.length && signature === marketLastSavedSignature) return Promise.resolve(null);
    marketInFlightOps = ops;
    return this.request('/api/market/me', {
      method: 'PUT',
      body: JSON.stringify({ portfolio, ops, epoch: marketPortfolioEpoch }),
    }).then((payload) => {
      marketInFlightOps = [];
      marketLastSavedSignature = signature;
      if (payload && payload.account) {
        if (payload.account.portfolioEpoch) marketPortfolioEpoch = payload.account.portfolioEpoch;
        applyServerPortfolio(payload.account.portfolio);
      }
      ledgerRejected(payload && payload.rejected);
      return payload;
    }).catch((error) => {
      // el registro vuelve a la cola: si se pierde, la operación no se cobró
      // nunca y el cliente quedaría con una compra que el servidor no conoce
      marketPendingOps = ops.concat(marketPendingOps);
      marketInFlightOps = [];
      if (String(error && error.message).includes('409')) MarketNet.resyncFromServer();
      return null;
    });
  },

  savePortfolioNow() {
    if (marketSaveTimer) {
      clearTimeout(marketSaveTimer);
      marketSaveTimer = null;
    }
    return this.flushPortfolio();
  },

  connect() {
    if (typeof WebSocket === 'undefined') return;
    if (marketSocket && (marketSocket.readyState === WebSocket.OPEN || marketSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (marketReconnectTimer) {
      clearTimeout(marketReconnectTimer);
      marketReconnectTimer = null;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // sin ?token=: la cookie lyra_market_token viaja sola en el handshake y el
    // access log deja de escribir la sesion. el servidor sigue aceptando el
    // query para clientes que no sean navegador.
    setMarketTokenCookie(marketToken);
    let socket;
    try {
      socket = new WebSocket(`${protocol}//${location.host}${MARKET_WS_PATH}`);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    marketSocket = socket;
    notifyConnection('connecting');

    socket.onopen = () => {
      marketSocketReady = true;
      marketReconnectDelay = 1000;
      // a token restored from localStorage must authorize THIS socket too, not
      // only the HTTP calls: the auth frame is what flips server.data.authorized
      if (marketToken) {
        try { socket.send(JSON.stringify({ type: 'auth', token: marketToken })); } catch (e) {}
      }
      notifyConnection('live');
      // al reconectar después de una caída suena el "ya está": el primer onopen
      // de la sesión es carga normal y se queda callado
      if (typeof hadSocketDrop !== 'undefined' && hadSocketDrop && typeof Sound !== 'undefined') {
        Sound.play('reconnect');
        hadSocketDrop = false;
      }
    };
    socket.onmessage = (event) => {
      let payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { return; }
      if (!payload || typeof payload !== 'object') return;
      handleServerMessage(payload);
    };
    socket.onclose = () => {
      marketSocketReady = false;
      // la marca de la caída: si el close llega, el próximo onopen toca el
      // jingle de reconexión en vez de pasar desapercibido
      try { hadSocketDrop = true; } catch (e) {}
      notifyConnection('offline');
      scheduleReconnect();
    };
    socket.onerror = () => {
      try { socket.close(); } catch (e) {}
    };
  },

  disconnect() {
    if (marketReconnectTimer) {
      clearTimeout(marketReconnectTimer);
      marketReconnectTimer = null;
    }
    marketSocketReady = false;
    marketLastTickAt = 0;
    if (marketSocket) {
      try { marketSocket.close(); } catch (e) {}
      marketSocket = null;
    }
    notifyConnection('offline');
  },

  // the history of a company is "installed" on the player's machine once: it is
  // stored locally, the chart paints from that copy, and every later visit asks
  // the server only for the bars newer than the last one it has. only 5m bars (and
  // the daily series behind 1W) travel over the wire: 15m and 1h are aggregated
  // here, so the server never builds a timeframe again.
  seedCandles(timeframe) {
    const symbol = typeof activeSymbol === 'string' ? activeSymbol : null;
    if (!symbol) return;
    const tf = timeframe || (typeof currentTF === 'string' ? currentTF : '5m');
    const baseTf = typeof baseTimeframeFor === 'function' ? baseTimeframeFor(tf) : tf;
    const hasCache = typeof HistoryCache !== 'undefined';

    // 1. paint what this machine already stored, reopening the same window
    const cached = hasCache ? HistoryCache.peek(symbol, baseTf) : null;
    if (cached && cached.length) this.paintSeries(symbol, tf, cached);

    // 2. ask the server for the gap: nothing when the copy is fresh, a couple of
    // bars when it is a few seconds old, the whole window the first time
    // the first install asks for the whole window the cache keeps (twenty game
    // days of 5m bars) so the copy and the chart agree; every later visit only
    // asks for the gap, which is a couple of bars
    const limit = hasCache && HistoryCache.maxFor ? HistoryCache.maxFor(baseTf) : 1200;
    const windowDays = hasCache && HistoryCache.windowDays ? HistoryCache.windowDays(baseTf) : 0;
    // a copy that does not span the whole window (an install made before the
    // server drew the past at boot) is refilled in one go, instead of growing a
    // day at a time while the clock runs
    const heldDays = cached && cached.length
      ? Math.floor(cached[cached.length - 1].t / WINDOW_DAY_MS)
        - Math.floor(cached[0].t / WINDOW_DAY_MS) + 1
      : 0;
    const short = Boolean(cached && cached.length) && windowDays > 0 && heldDays < windowDays;
    const since = cached && cached.length && !short ? cached[cached.length - 1].t : 0;
    this.fetchCandles(symbol, baseTf, { limit, since })
      .then((payload) => {
        if (!payload || !Array.isArray(payload.candles)) return;
        // the player may have switched company or timeframe while this was in
        // flight; drop the stale answer instead of repainting it
        if (symbol !== activeSymbol) return;
        if (tf !== (typeof currentTF === 'string' ? currentTF : tf)) return;
        if (!hasCache) {
          if (payload.candles.length && typeof applyServerCandles === 'function') {
            applyServerCandles(payload.candles);
          }
          return;
        }
        return HistoryCache
          .merge(symbol, baseTf, payload.candles, { reset: payload.reset === true })
          .then((series) => {
            if (!series || !series.length) return;
            if (symbol !== activeSymbol || tf !== currentTF) return;
            this.paintSeries(symbol, tf, series);
          });
      })
      .catch(() => {});
  },

  // La serie DIARIA que alimenta el panel de abajo: la vida entera de la empresa,
  // un punto por dia de juego. Es la misma ventana que la vista 1W, asi que
  // reutiliza el mismo store local (IndexedDB) y se pide una sola vez por
  // empresa; a partir de ahi el panel sale del disco y solo se pide el dia que
  // falta. No toca la grafica de velas: es una segunda serie, independiente.
  seedDailySeries() {
    const symbol = typeof activeSymbol === 'string' ? activeSymbol : null;
    if (!symbol) return;
    const setter = typeof setDailySeries === 'function' ? setDailySeries : null;
    if (!setter) return;
    const hasCache = typeof HistoryCache !== 'undefined';
    const cached = hasCache ? HistoryCache.peek(symbol, DAILY_TF) : null;

    // 1. lo que ya tenga guardado, al instante
    if (cached && cached.length) setter(symbol, cached);

    // 2. la serie diaria solo cambia cuando cambia el dia de juego: mientras el
    // ultimo punto sea de hoy no hay nada que pedir
    const dayNow = Math.floor((typeof currentGameTime === 'function' ? currentGameTime() : Date.now()) / WINDOW_DAY_MS);
    const dayHeld = cached && cached.length ? Math.floor(cached[cached.length - 1].t / WINDOW_DAY_MS) : -1;
    if (cached && cached.length && dayHeld >= dayNow) return;

    const limit = hasCache && HistoryCache.maxFor ? HistoryCache.maxFor(DAILY_TF) : 400;
    const since = cached && cached.length ? cached[cached.length - 1].t : 0;
    this.fetchCandles(symbol, DAILY_TF, { limit, since })
      .then((payload) => {
        if (!payload || !Array.isArray(payload.candles) || !payload.candles.length) return;
        if (symbol !== activeSymbol) return;
        if (!hasCache) {
          setter(symbol, payload.candles);
          return;
        }
        return HistoryCache
          .merge(symbol, DAILY_TF, payload.candles, { reset: payload.reset === true })
          .then((series) => {
            if (!series || !series.length || symbol !== activeSymbol) return;
            setter(symbol, series);
          });
      })
      .catch(() => {});
  },

  // paints the series the chart shows, aggregating on this side when the view is
  // not one the server sends
  paintSeries(symbol, tf, base) {
    if (typeof paintHistorySeries !== 'function') return;
    const series = typeof aggregateFor === 'function' ? aggregateFor(tf, base) : base;
    paintHistorySeries(series, HistoryCache.peekView(symbol, tf));
  },
};

function syncGameClock(gameTime, speed) {
  if (typeof gameTime !== 'number' || !Number.isFinite(gameTime) || gameTime <= 0) return;
  marketGameTime = gameTime;
  marketGameTimeAt = Date.now();
  if (typeof speed === 'number' && speed > 0) marketGameSpeed = speed;
}

function scheduleReconnect() {
  if (marketReconnectTimer) return;
  marketReconnectTimer = setTimeout(() => {
    marketReconnectTimer = null;
    marketReconnectDelay = Math.min(15000, Math.round(marketReconnectDelay * 1.6));
    MarketNet.connect();
  }, marketReconnectDelay);
}

function notifyConnection(status) {
  if (typeof updateSessionChip === 'function') updateSessionChip(status);
}

function notifySessionChange() {
  if (typeof onMarketSessionChange === 'function') onMarketSessionChange();
}

function handleServerMessage(payload) {
  if (payload.type === 'snapshot' && payload.snapshot) {
    marketTickIntervalMs = payload.snapshot.intervalMs || marketTickIntervalMs;
    marketLastTickAt = Date.now();
    marketSocketReady = true;
    syncGameClock(payload.snapshot.gameTime, payload.snapshot.speed);
    if (payload.snapshot.regime) marketRegime = payload.snapshot.regime;
    if (Array.isArray(payload.snapshot.profiles)) {
      const profiles = {};
      payload.snapshot.profiles.forEach((profile) => {
        if (profile && typeof profile.sym === 'string') profiles[profile.sym] = profile;
      });
      marketCompanyProfiles = profiles;
    }
    if (payload.snapshot.news && Array.isArray(payload.snapshot.news)) {
      state.news = payload.snapshot.news
        .map((item) =>
          typeof normalizeNewsItem === 'function' ? normalizeNewsItem(item) : item,
        )
        .filter(Boolean);
      // the service keeps its own (longer) list; the panel only shows the newest
      if (typeof trimNews === 'function') trimNews();
    }
    if (Array.isArray(payload.tape)) {
      marketTape.length = 0;
      payload.tape.forEach((trade) => marketTape.push(trade));
    }
    if (Array.isArray(payload.candles) && typeof applyLiveCandles === 'function') {
      applyLiveCandles(payload.candles);
    }
    if (typeof applyMarketQuotes === 'function') applyMarketQuotes(payload.snapshot.quotes);
    // the chart boots before the socket is up, so seed the real server price
    // sequence as soon as the connection is ready
    if (typeof seedChartFromServer === 'function') seedChartFromServer();
    notifyConnection('live');
    return;
  }

  if (payload.type === 'tick') {
    marketTickIntervalMs = payload.intervalMs || marketTickIntervalMs;
    marketLastTickAt = Date.now();
    syncGameClock(payload.gameTime, payload.speed);
    if (payload.regime) marketRegime = payload.regime;
    if (!marketSocketReady) {
      marketSocketReady = true;
      notifyConnection('live');
    }
    if (Array.isArray(payload.candles) && typeof applyLiveCandles === 'function') {
      applyLiveCandles(payload.candles);
    }
    if (typeof applyMarketQuotes === 'function') applyMarketQuotes(payload.quotes);
    if (Array.isArray(payload.news)) {
      payload.news.forEach((item) => {
        if (typeof applyMarketNews === 'function') applyMarketNews(item);
      });
    }
    return;
  }

  if (payload.type === 'trade' && payload.trade) {
    marketTape.unshift(payload.trade);
    if (marketTape.length > 40) marketTape.length = 40;
    if (typeof applyMarketTape === 'function') applyMarketTape(payload.trade);
    return;
  }

  // a headline the console published: it has to show up on every client at once
  if (payload.type === 'news' && Array.isArray(payload.news)) {
    payload.news.forEach((item) => {
      if (typeof applyMarketNews === 'function') applyMarketNews(item);
    });
    return;
  }

  // a chained market event started on the server: it owns the price steps, this
  // side only paints the banner and the headlines so every player shares the story
  if (payload.type === 'event-chain' && typeof Events !== 'undefined') {
    Events.remoteMode = true;
    Events.fire(payload.chainId, payload.chain);
    return;
  }

  if (payload.type === 'event-step' && typeof Events !== 'undefined') {
    Events.headline(payload.step || payload);
    return;
  }

  // server-authoritative money: an admin grant/reset just landed on the server
  // and it pushes the new truth — adopt it at once and silence the debounced
  // save, or the stale in-memory snapshot would resurrect the old cash (the
  // exact "lo reseteé y el dinero volvió" bug)
  if (payload.type === 'portfolio-override') {
    if (typeof payload.epoch === 'number') marketPortfolioEpoch = payload.epoch;
    applyServerPortfolio(payload.portfolio);
    marketLastSavedSignature = '';
    if (typeof saveGame === 'function') saveGame();
    if (typeof pushNotification === 'function') {
      pushNotification(`🔧 ${payload.title || 'Cuenta actualizada'}`, payload.msg || 'El servidor actualizó tu cuenta.', 'gold');
    }
    if (typeof toast === 'function') toast(payload.title || 'Cuenta actualizada', payload.msg || 'El servidor actualizó tu cuenta.', 'gold');
    return;
  }

  // the admin console talking to the whole room
  if (payload.type === 'poll-open' && payload.poll && typeof Polls !== 'undefined') {
    Polls.onOpen(payload.poll);
    return;
  }

  if (payload.type === 'poll-closed' && payload.poll && typeof Polls !== 'undefined') {
    Polls.onClosed(payload.poll);
    return;
  }

  // puente opencase ↔ bolsa: una caja abierta, una skin vendida o un tradeo
  // cambió el cash de ESTA cuenta en el server. el push llega dirigido; el
  // libro completo viene en el snapshot del payload… pero es más barato y
  // seguro re-tirarlo con el resync ya throttled (1 pull por lote)
  if (payload.type === 'skins-update') {
    if (Number.isFinite(payload.cash)) state.cash = payload.cash;
    if (payload.portfolio && typeof payload.portfolio === 'object') {
      applyServerPortfolio(payload.portfolio);
    }
    if (typeof updateHud === 'function') updateHud();
    // el inventario/cash oficial vuelve con el resync throttleado de abajo
    MarketNet.resyncFromServer();
    return;
  }

  if (payload.type === 'market-pulse' && typeof Polls !== 'undefined') {
    Polls.onMarketPulse(payload);
    return;
  }

  if (payload.type === 'admin-broadcast') {
    if (typeof pushNotification === 'function') {
      pushNotification(`📣 ${payload.title}`, payload.msg || '', payload.kind || 'gold');
    }
    if (typeof toast === 'function') toast(payload.title, payload.msg || '', payload.kind || 'gold');
    return;
  }

  // the console kicked this account: drop the session and ask to sign back in
  if (payload.type === 'finance' && payload.finance) {
    handleFinanceNotice(payload.finance);
    return;
  }
  if (payload.type === 'kicked') {
    MarketNet.clearAccount();
    if (typeof toast === 'function') toast('Sesión cerrada', payload.reason || 'El administrador cerró tu sesión', 'down');
    if (typeof openAuthModal === 'function') openAuthModal('login');
  }
}

// a watchdog marks the feed as stale if ticks stop arriving, which lets the
// game fall back to its own local walk instead of freezing.
setInterval(() => {
  if (!marketSocketReady) return;
  if (Date.now() - marketLastTickAt > marketTickIntervalMs * 4) {
    marketSocketReady = false;
    notifyConnection('stale');
  }
}, 2000);

// el registro de operaciones pendiente de enviar.
//
// Con el dinero en el servidor, el cliente ya no "es" la cartera: calcula igual
// (para que el clic se sienta inmediato) pero además anota QUÉ segiu intending
// hacer, y el servidor lo reproduce contra su propia cinta. Si la operación
// se rechaza, la verdad vuelve en la respuesta y la cartera optimista se
// corrige sola.
//
// No se persisten a propósito: si el registro se perdiera en un cierre de
// pestaña, la operación tampoco se habría cobrado nunca en el servidor, así que
// las dos copias mueren juntas. Para eso está el flush en beforeunload.
let marketPendingOps = [];
let marketInFlightOps = [];
const MARKET_OPS_FLUSH_AT = 40;

// vacía la cola: lo que está en vuelo se devuelve para que un reintento no
// pierda operaciones que el servidor aún no ha visto
function marketDrainOps() {
  const ops = marketInFlightOps.concat(marketPendingOps);
  marketInFlightOps = [];
  marketPendingOps = [];
  return ops;
}

function queueLedgerOp(op) {
  marketPendingOps.push(op);
  // no dejar que la cola crezca sin límite: por encima del umbral se fuerza el
  // guardado en vez de esperar al debounce
  if (marketPendingOps.length >= MARKET_OPS_FLUSH_AT) MarketNet.savePortfolio();
}

function ledgerRejected(rejected) {
  if (!Array.isArray(rejected) || !rejected.length) return;
  const first = rejected[0];
  const verb = first.kind === 'sell' ? 'la venta' : 'la compra';
  if (typeof toast === 'function') toast('Operación rechazada', `El servidor no aplicó ${verb} de ${first.sym}: ${first.error}`, 'down');
  if (typeof pushNotification === 'function') pushNotification('Operación rechazada', `${first.sym}: ${first.error}`, 'down');
  // la cartera se corrige con la verdad del servidor (applyServerPortfolio)
  MarketNet.resyncFromServer();
}

// what decides whether a save is worth a round trip: the same portfolio minus the
// timestamp, which changes on every snapshot and would make every save look new
function marketPortfolioSignature(portfolio) {
  const copy = Object.assign({}, portfolio);
  delete copy.updatedAt;
  return JSON.stringify(copy);
}

function marketPortfolioSnapshot() {
  // sólo lo que el cliente es dueño. cash, posiciones, historial, estadísticas,
  // órdenes en espera y la bandera de bancarrota NO viajan: los reproduce el
  // servidor a partir del registro de operaciones (ledger.mjs), y mandarlos
  // sería mandar la respuesta del examen.
  return {
    level: state.level,
    xp: state.xp,
    watchlist: state.watchlist,
    quests: state.quests,
    // el banco lo liquida el servidor (bank.mjs), pero el libro viaje para que
    // un cliente sin accrual no lo deje a cero
    bank: state.bank,
    transfers: (state.transfers || []).slice(0, 50),
    // el libro de opencase viaja intacto: el dinero nunca vive aquí (el server
    // valida open/sell), pero el inventario y los tradeos se perderían con cada
    // save de la bolsa si no vuelve a enviarse tal cual llegó
    skins: state.opencase || null,
    caseSkins: state.skins || [],
    // el libro del casino (la mano de blackjack viva y las estadísticas de
    // juego); el dinero se liquida server-side en cada apuesta
    casino: state.casino || null,
    updatedAt: Date.now(),
  };
}

function applyServerPortfolio(portfolio) {
  if (!portfolio || typeof portfolio !== 'object') return;
  if (typeof portfolio.cash === 'number') state.cash = portfolio.cash;
  if (portfolio.positions && typeof portfolio.positions === 'object') state.positions = portfolio.positions;
  if (Array.isArray(portfolio.transactions)) state.transactions = portfolio.transactions;
  if (portfolio.stats && typeof portfolio.stats === 'object') state.stats = portfolio.stats;
  if (typeof portfolio.level === 'number') state.level = portfolio.level;
  if (typeof portfolio.xp === 'number') state.xp = portfolio.xp;
  if (Array.isArray(portfolio.watchlist)) state.watchlist = portfolio.watchlist;
  if (portfolio.quests && typeof portfolio.quests === 'object') state.quests = portfolio.quests;
  if (portfolio.casino && typeof portfolio.casino === 'object') state.casino = portfolio.casino;
  // el libro de opencase llega con la verdad del server: cash e inventario de
  // las cajas se comparten entre ambos juegos sin recargar
  if (portfolio.skins && typeof portfolio.skins === 'object') state.opencase = portfolio.skins;
  // los cosméticos de la bolsa son una lista propia: el libro de opencase de
  // arriba es un objeto con inventario, y empujarle un id lo rompe
  if (Array.isArray(portfolio.caseSkins)) state.skins = portfolio.caseSkins;
  state.bankrupt = portfolio.bankrupt === true;
  if (typeof portfolio.bankruptUntil === 'number') state.bankruptUntil = portfolio.bankruptUntil;
  // the authoritative bank book and order list come back from the server: what
  // the daily accrual moved (interest, dividends, a collected loan) lands here
  const bank = portfolio.bank && typeof portfolio.bank === 'object' ? portfolio.bank : null;
  if (bank) state.bank = { balance: bank.balance || 0, loan: bank.loan || 0, loanDaysLeft: bank.loanDaysLeft || 0, loanAtDay: bank.loanAtDay ?? null };
  if (Array.isArray(portfolio.orders)) state.orders = portfolio.orders;
  if (Array.isArray(portfolio.transfers)) state.transfers = portfolio.transfers;

  if (state.bankrupt && state.bankruptUntil > Date.now()) {
    const overlay = document.getElementById('bankruptOverlay');
    if (overlay) overlay.classList.add('is-visible');
  }
  if (typeof syncQuestDom === 'function') syncQuestDom();
  if (typeof updateHud === 'function') updateHud();
  if (typeof updateQuoteBlock === 'function') updateQuoteBlock();
  if (typeof updatePerformancePanel === 'function') updatePerformancePanel();
  if (typeof renderPositions === 'function') renderPositions();
  if (typeof renderWatchlist === 'function') renderWatchlist();
  if (typeof recalcOrder === 'function') recalcOrder();
}

// install the stored history into memory as soon as the game boots, so the first
// company switch already has its window locally (the server only sends the gap)
if (typeof HistoryCache !== 'undefined') {
  HistoryCache.warm().catch(() => {});
}

// the server's daily finance pass and the resting-order fills arrive keyed by
// account name (the same broadcast reaches every socket; only the matching
// account's slice is acted on). the server already applied every delta to the
// stored portfolio before broadcasting, so the client does NOT re-apply them:
// it notifies and then pulls the authoritative book with a throttled resync.
let financeResyncTimer = null;
function handleFinanceNotice(finance) {
  const notices = finance?.notices;
  if (!Array.isArray(notices) || !notices.length) return;
  const myName = typeof MarketNet !== 'undefined' ? (MarketNet.accountName || '') : '';
  let touched = false;
  for (const [name, entries] of notices) {
    if (name !== myName || !Array.isArray(entries)) continue;
    touched = true;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.kind === 'bank-interest') {
        pushNotification('🏦 Interés del banco', `+${money(entry.amount)} acreditado en tu cuenta de ahorro`, 'up');
      } else if (entry.kind === 'dividend') {
        if (typeof suppressNextNotify === 'function') suppressNextNotify();
        pushNotification(`💰 Dividendo: ${entry.sym}`, `+${money(entry.net)} por ${entry.shares} acción(es) (neto tras retención)`, 'up');
        if (typeof Sound !== 'undefined') Sound.play('profit');
      } else if (entry.kind === 'loan-interest') {
        pushNotification('🏦 Tu préstamo creció', `deuda actual ${money(entry.owed)} · vence en ${entry.daysLeft} día(s)`, 'down');
      } else if (entry.kind === 'loan-collected') {
        if (typeof suppressNextNotify === 'function') suppressNextNotify();
        pushNotification('🏦 Cobro del préstamo', `el banco tomó ${money(entry.amount)} de tus activos`, 'down');
        if (typeof Sound !== 'undefined') Sound.play('loss');
      } else if (entry.kind === 'order-filled') {
        const side = entry.side === 'buy' ? 'Compra' : 'Venta';
        const pnl = Number.isFinite(entry.pnl) ? ` · P/L ${entry.pnl >= 0 ? '+' : '-'}${money(Math.abs(entry.pnl))}` : '';
        const losing = entry.pnl != null && entry.pnl < 0;
        if (typeof suppressNextNotify === 'function') suppressNextNotify();
        pushNotification(`📋 ${side} ejecutada: ${entry.sym}`, `${entry.shares} a ${money(entry.price)} (orden ${entry.kind})${pnl}`, losing ? 'down' : 'gold');
        // la venta ejecutada suena a venta (sell); el P/L manda en el color
        if (typeof Sound !== 'undefined') Sound.play(losing ? 'loss' : (entry.side === 'sell' ? 'sell' : 'profit'));
      } else if (entry.kind === 'order-expired') {
        pushNotification(`📋 Orden cancelada: ${entry.sym}`, `expiró sin cruzarse · margen devuelto al efectivo`, 'gold');
      } else if (entry.kind === 'exit') {
        // el take profit / stop loss / trailing lo decide el latido del
        // servidor: el aviso llega con el precio y el P/L ya-liquidados
        const pnlText = `${entry.pnl >= 0 ? '+' : '-'}${money(Math.abs(entry.pnl))}`;
        const won = entry.pnl >= 0;
        if (typeof suppressNextNotify === 'function') suppressNextNotify();
        pushNotification(`${won ? '📈' : '📉'} ${entry.sym} cerrada`, `${entry.shares} a ${money(entry.price)} · ${pnlText} · ${entry.reason}`, won ? 'up' : 'down');
        if (typeof Sound !== 'undefined') Sound.play(won ? 'profit' : 'loss');
      } else if (entry.kind === 'liquidated') {
        const pnlText = `${entry.pnl >= 0 ? '+' : '-'}${money(Math.abs(entry.pnl))}`;
        if (typeof suppressNextNotify === 'function') suppressNextNotify();
        pushNotification(`Posición cerrada`, `${entry.sym} cayó a negativo y se cerró sola: ${pnlText}.`, 'down');
        if (typeof Sound !== 'undefined') Sound.play('alarm');
      } else if (entry.kind === 'bankrupt') {
        // el servidor vio la cuenta a cero: la sanción empieza aquí, no en el
        // navegador, así que no se puede negociar con un PUT
        if (typeof showBankruptcyOverlay === 'function') showBankruptcyOverlay();
      } else if (entry.kind === 'bankrupt-recap') {
        if (typeof hideBankruptcyOverlay === 'function') hideBankruptcyOverlay();
        toast('Recapitalización acreditada', `+${money(entry.cash)} en tu cuenta`, 'gold');
        pushNotification('Recapitalización acreditada', `+${money(entry.cash)} en tu cuenta.`, 'gold');
      } else if (entry.kind === 'transfer-in') {
        const note = entry.note ? ` · “${String(entry.note).replace(/[<>&]/g, '')}”` : '';
        // el profit ya anuncia la entrada; la campanita de pushNotification
        // se suprime para no sonar dos jingles pegados
        if (typeof suppressNextNotify === 'function') suppressNextNotify();
        pushNotification(`💸 Te enviaron dinero`, `${entry.from || 'un jugador'} → +${money(entry.amount)}${note}`, 'up');
        // el toast es lo que se ve aunque el banco (u otro modal) esté abierto:
        // la campana queda detrás del overlay
        toast(`💸 Te enviaron dinero`, `${entry.from || 'un jugador'} → +${money(entry.amount)}${note}`, 'up');
        if (typeof Sound !== 'undefined') Sound.play('profit');
      } else if (entry.kind === 'transfer-out') {
        if (typeof suppressNextNotify === 'function') suppressNextNotify();
        pushNotification(`💸 Transferencia enviada`, `${money(entry.amount)} → ${entry.to || 'un jugador'}`, 'gold');
        if (typeof Sound !== 'undefined') Sound.play('transfer');
      }
    }
  }
  if (!touched) return;
  // one authoritative pull per batch (throttled): cash, bank book, orders and
  // stats come back exactly as the server stored them
  if (financeResyncTimer) return;
  financeResyncTimer = setTimeout(async () => {
    financeResyncTimer = null;
    try {
      const portfolio = await MarketNet.fetchPortfolio();
      if (portfolio) applyServerPortfolio(portfolio);
      if (typeof renderRestingOrders === 'function') renderRestingOrders();
      // el banco abierto no se entera solo: refrescar el modal para que el
      // efectivo y el historial muestren la transferencia que acaba de entrar
      if (typeof refreshBankModalIfOpen === 'function') refreshBankModalIfOpen();
    } catch { /* the next finance batch or save round-trip will resync */ }
  }, 1500);
}
