// consola de administrador: eventos en vivo, parámetros del motor y estado del
// servicio de mercado.
//
// dos modos:
//   · remoto -> POST/GET a /api/market/admin/*  (afecta a todos los jugadores)
//   · local  -> aplica los mismos eventos sobre MARKET/state/régimen de este
//                cliente. se usa solo cuando el server no expone los endpoints
//                (403/404) o cuando se abre con ?admin=1, y sirve para probar el
//                juego en solitario sin tocar nada del servidor.
//
// la consola nunca rompe la partida: toda acción remota que falle cae a local.
const ADMIN_PARAMS_KEY = 'bolsa-admin-params-v1';

// los parámetros que la consola puede mover. los defaults son el punto de
// partida documentado; lo que se cambia aquí vive en localStorage, se aplica al
// arrancar (window.__adminParams) y en modo remoto se manda al servidor.
const ADMIN_DEFAULT_PARAMS = {
  engine: {
    tickMs: 1400,
    speed: 1440,
    settleDays: 2,
    regimeMinDays: 3,
    regimeMaxDays: 8,
    regimeStrength: 0.6,
  },
  economy: {
    startCash: 10000,
    recapCash: 10000,
    bankruptWaitMs: 60000,
    commission: 0,
    maxLeverage: 20,
  },
  xp: {
    base: 400,
    perLevel: 260,
    rewardBuy: 8,
    rewardSell: 10,
    rewardClose: 15,
    rewardQuest: 50,
  },
  chart: {
    maxCandles: 5760,
    defaultTf: '5m',
    historyDays: 20,
  },
  notifications: {
    max: 40,
    ttlMs: 3000,
  },
};

const ADMIN_PARAM_META = {
  engine: {
    label: 'Motor',
    fields: [
      ['tickMs', 'Tick (ms)'],
      ['speed', 'Velocidad (×)'],
      ['settleDays', 'Ajuste cada (días)'],
      ['regimeMinDays', 'Régimen mín (días)'],
      ['regimeMaxDays', 'Régimen máx (días)'],
      ['regimeStrength', 'Fuerza régimen (0–1)'],
    ],
  },
  economy: {
    label: 'Economía',
    fields: [
      ['startCash', 'Efectivo inicial'],
      ['recapCash', 'Recapitalización'],
      ['bankruptWaitMs', 'Espera bancarrota (ms)'],
      ['commission', 'Comisión (%)'],
      ['maxLeverage', 'Apalancamiento máx'],
    ],
  },
  xp: {
    label: 'XP',
    fields: [
      ['base', 'Base'],
      ['perLevel', 'Por nivel'],
      ['rewardBuy', 'XP compra'],
      ['rewardSell', 'XP venta'],
      ['rewardClose', 'XP cierre'],
      ['rewardQuest', 'XP misión'],
    ],
  },
  chart: {
    label: 'Gráfica',
    fields: [
      ['maxCandles', 'Velas máx'],
      ['historyDays', 'Días de histórico'],
    ],
  },
  notifications: {
    label: 'Avisos',
    fields: [
      ['max', 'Avisos guardados'],
      ['ttlMs', 'Duración toast (ms)'],
    ],
  },
};

const AdminConsole = {
  open: false,
  mode: 'local',
  tab: 'panel',
  detected: false,
  status: null,
  players: [],
  logs: [],
  params: null,
  pollTimer: null,
  paused: false,
  speedBefore: 1440,
  // lo que el jugador lleva escrito en los formularios, para que un cambio de
  // pestaña o un repintado no le borre la selección
  formState: {},

  isAvailable() {
    // el botón del rail sólo aparece si el server marca la cuenta como admin;
    // el atajo de teclado también funciona como herramienta de desarrollo
    return typeof MarketNet !== 'undefined' && MarketNet.signedIn && MarketNet.isAdmin;
  },

  forcedByQuery() {
    try {
      return new URLSearchParams(location.search).get('admin') === '1';
    } catch (e) {
      return false;
    }
  },

  canOpen() {
    return this.isAvailable() || this.forcedByQuery() || location.hash === '#admin';
  },

  toggle() { this.open ? this.close() : this.show(); },

  show() {
    if (!this.canOpen()) {
      toast('Acceso denegado', 'Sólo administradores.', 'down');
      return;
    }
    this.open = true;
    this.loadParams();
    let overlay = document.getElementById('adminOverlay');
    if (!overlay) overlay = this.buildOverlay();
    overlay.classList.add('is-visible');
    this.detectMode().then(() => {
      this.refresh();
      if (!this.pollTimer) this.pollTimer = setInterval(() => this.refresh(), 2000);
    });
  },

  close() {
    this.open = false;
    const overlay = document.getElementById('adminOverlay');
    if (overlay) overlay.classList.remove('is-visible');
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  // ---------------------------------------------------------------- mode probe

  async detectMode() {
    if (this.detected) return this.mode;
    try {
      const headers = MarketNet && MarketNet.token
        ? { Authorization: `Bearer ${MarketNet.token}` } : {};
      const res = await fetch('/api/market/admin/status', { headers });
      this.mode = res.ok ? 'remote' : 'local';
    } catch (e) {
      this.mode = 'local';
    }
    this.detected = true;
    return this.mode;
  },

  // -------------------------------------------------------------------- params

  loadParams() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(ADMIN_PARAMS_KEY) || 'null'); } catch (e) {}
    this.params = this.deepMerge(JSON.parse(JSON.stringify(ADMIN_DEFAULT_PARAMS)), saved || {});
    // las helpers de state.js (xp, toasts, avisos) leen de aquí
    this.applyParamsLocal();
    return this.params;
  },

  saveParams() {
    try { localStorage.setItem(ADMIN_PARAMS_KEY, JSON.stringify(this.params)); } catch (e) {}
  },

  resetParams(section) {
    if (section && this.params[section] !== undefined) {
      this.params[section] = JSON.parse(JSON.stringify(ADMIN_DEFAULT_PARAMS[section]));
    } else {
      this.params = JSON.parse(JSON.stringify(ADMIN_DEFAULT_PARAMS));
    }
    this.saveParams();
    this.applyParamsLocal();
    this.render();
  },

  deepMerge(a, b) {
    if (!b || typeof b !== 'object') return a;
    for (const key of Object.keys(b)) {
      if (b[key] && typeof b[key] === 'object' && !Array.isArray(b[key]) && a[key]) {
        this.deepMerge(a[key], b[key]);
      } else if (b[key] !== undefined) {
        a[key] = b[key];
      }
    }
    return a;
  },

  // los parámetros que el cliente puede respetar por su cuenta. los que sólo
  // conoce el servidor (tick, régimen) viajan por POST /admin/params.
  applyParamsLocal() {
    window.__adminParams = this.params;
    if (typeof updateHud === 'function') updateHud();
  },

  async pushParamsRemote(section) {
    if (this.mode !== 'remote') return;
    try {
      await this.adminRequest('/api/market/admin/params', 'POST', {
        section,
        params: section ? this.params[section] : this.params,
      });
      this.toastEvent('Parámetros enviados', `sección: ${section || 'todas'}`, 'gold');
      this.saveParams();
    } catch (e) {
      this.toastEvent('Error', e.message || 'no se pudo aplicar', 'down');
    }
  },

  // ------------------------------------------------------------------ overlay

  buildOverlay() {
    const el = document.createElement('div');
    el.id = 'adminOverlay';
    el.className = 'admin-overlay';
    el.innerHTML = `
      <div class="admin-panel" role="dialog" aria-modal="true" aria-label="Consola de administrador">
        <header class="admin-head">
          <div class="admin-head-info">
            <h2>◆ Consola de administrador</h2>
            <p class="mono" id="adminStatusLine">conectando…</p>
          </div>
          <div class="admin-head-actions">
            <span class="admin-mode-badge" id="adminModeBadge">modo: —</span>
            <button class="scrub-btn" id="adminRefreshBtn" title="Refrescar" aria-label="Refrescar">↻</button>
            <button class="scrub-btn" id="adminCloseBtn" title="Cerrar (Esc)" aria-label="Cerrar">✕</button>
          </div>
        </header>
        <nav class="admin-tabs" id="adminTabs">
          ${[['panel', 'Panel'], ['events', 'Eventos'], ['params', 'Parámetros'], ['players', 'Jugadores'], ['market', 'Mercado'], ['logs', 'Logs']]
            .map(([id, label]) => `<button class="admin-tab${id === 'panel' ? ' is-active' : ''}" data-tab="${id}">${label}</button>`)
            .join('')}
        </nav>
        <div class="admin-body" id="adminBody"></div>
        <footer class="admin-foot">
          <span class="mono" id="adminFootLeft">—</span>
          <span class="mono" id="adminFootRight">Ctrl+Shift+A · Esc para cerrar</span>
        </footer>
      </div>`;
    document.body.appendChild(el);

    el.querySelector('#adminCloseBtn').addEventListener('click', () => this.close());
    el.querySelector('#adminRefreshBtn').addEventListener('click', () => this.refresh());
    el.querySelectorAll('.admin-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.captureForm();
        this.tab = btn.dataset.tab;
        el.querySelectorAll('.admin-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
        this.render();
      });
    });
    el.addEventListener('click', (event) => { if (event.target === el) this.close(); });
    return el;
  },

  // ----------------------------------------------------------------- data pull

  async refresh() {
    if (!this.open) return;
    await Promise.allSettled([
      this.adminRequest('/api/market/admin/status').then((d) => { if (d) this.status = d; }),
      this.adminRequest('/api/market/admin/players').then((d) => {
        if (d && Array.isArray(d.players)) this.players = d.players;
      }),
      this.adminRequest(`/api/market/admin/logs?since=${this.logs[0] ? this.logs[0].t : 0}`).then((d) => {
        if (d && Array.isArray(d.logs)) this.logs = d.logs.concat(this.logs).slice(0, 400);
      }),
    ]);
    this.renderChrome();
    // a form tab is never repainted by the poll: that is what used to wipe the
    // chosen symbol (and every other field) a second after picking it
    if (!this.isFormTab()) this.render();
  },

  async adminRequest(path, method = 'GET', body = null) {
    if (this.mode === 'local') return this.localFallback(path, method, body);
    const headers = { Accept: 'application/json' };
    if (MarketNet && MarketNet.token) headers.Authorization = `Bearer ${MarketNet.token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const error = new Error(`error ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.json().catch(() => null);
  },

  // respuestas "de mentira" en modo local: leemos lo que el cliente ya tiene
  localFallback(path, method, body) {
    if (path.startsWith('/api/market/admin/status')) {
      return Promise.resolve({
        mode: 'local',
        uptimeMs: performance.now() | 0,
        players: 1,
        tickMs: this.params.engine.tickMs,
        speed: typeof MarketNet !== 'undefined' ? MarketNet.gameSpeed : 1440,
        candles: typeof candles !== 'undefined' ? candles.length : 0,
        cache: typeof HistoryCache !== 'undefined' && HistoryCache.stats ? HistoryCache.stats() : null,
      });
    }
    if (path.startsWith('/api/market/admin/players')) {
      return Promise.resolve({
        players: [{
          id: 'local',
          name: (MarketNet && MarketNet.accountName) || 'invitado',
          admin: true,
          cash: state.cash,
          positions: Object.keys(state.positions).length,
          netWorth: state.cash + portfolioValue(),
          level: state.level,
          xp: state.xp,
          bankrupt: state.bankrupt === true,
          online: true,
          lastSeenAt: Date.now(),
        }],
      });
    }
    if (path.startsWith('/api/market/admin/logs')) {
      return Promise.resolve({ logs: this.logs.slice(0, 400) });
    }
    return Promise.resolve(this.applyLocalAction(path, method, body));
  },

  // ------------------------------------------------------------ local actions

  applyLocalAction(path, method, body) {
    if (method === 'GET') return { ok: true };
    if (path.endsWith('/shock')) return this.localShock(body || {});
    if (path.endsWith('/news')) return this.localNews(body || {});
    if (path.endsWith('/regime')) return this.localRegime(body || {});
    if (path.endsWith('/halt')) return this.localHalt(body || {});
    if (path.endsWith('/speed')) return this.localSpeed(body || {});
    if (path.endsWith('/pause')) return this.localPause(body || {});
    if (path.endsWith('/rally')) return this.localShock({ ...(body || {}), pct: Math.abs(Number(body && body.pct) || 5) });
    if (path.endsWith('/flash-crash')) return this.localShock({ ...(body || {}), pct: -Math.abs(Number(body && body.pct) || 10) });
    if (path.endsWith('/earnings')) return this.localEarnings(body || {});
    if (path.endsWith('/broadcast')) return this.localBroadcast(body || {});
    if (path.endsWith('/params')) return { ok: true, params: this.params };
    if (path.endsWith('/settle')) return this.localSettle();
    if (path.endsWith('/reset-prices')) return this.localResetPrices();
    if (path.endsWith('/kick')) return { ok: true, kicked: 0 };
    if (path.endsWith('/player')) return this.localPlayer(body || {});
    return { ok: false, error: 'acción no implementada en modo local' };
  },

  // mueve el precio de ajuste y la cinta locales, igual que hace el motor
  localShock({ sym, pct, gradual }) {
    const targets = sym === 'ALL' ? MARKET : MARKET.filter((m) => m.sym === sym);
    if (!targets.length) return { ok: false, error: 'símbolo desconocido' };
    const factor = 1 + (Number(pct) || 0) / 100;
    for (const m of targets) {
      if (gradual) {
        const before = typeof m.livePrice === 'number' ? m.livePrice : m.price;
        m.livePrice = safePrice(before * factor, before);
        m.liveChange = m.livePrice - m.prevClose;
        m.livePct = (m.liveChange / (m.prevClose || 1)) * 100;
        // el server inyecta un impulso y sube la volatilidad 1.3x (engine.mjs
        // adminShock). sin esto el salto se deshacia en el siguiente tick y el
        // "gradual" local no movia nada al final
        m.vol = (m.vol || 0.005) * 1.3;
        // el precio operable sigue a la cinta, igual que con el feed en vivo
        m.price = m.livePrice;
        m.change = m.liveChange;
        m.pct = m.livePct;
      } else {
        m.price = safePrice(m.price * factor, m.price);
        m.livePrice = m.price;
        m.settle = m.price;
        m.prevSettle = m.price;
        m.prevClose = m.price;
        m.change = 0;
        m.pct = 0;
        m.liveChange = 0;
        m.livePct = 0;
        m.high = Math.max(m.high || m.price, m.price);
        m.low = Math.min(m.low || m.price, m.price);
      }
    }
    this.log('shock', `${sym} ${pct >= 0 ? '+' : ''}${pct}%${gradual ? ' (gradual)' : ' (instantáneo)'} · ${targets.length} símbolos`);
    if (typeof refreshTickUi === 'function') refreshTickUi(true);
    return { ok: true, targets: targets.length };
  },

  localNews({ sym, pct, title }) {
    const m = sym === 'ALL' || !sym ? MARKET[Math.floor(Math.random() * MARKET.length)] : bySym(sym);
    if (!m) return { ok: false, error: 'símbolo desconocido' };
    if (typeof applyMarketNews === 'function') {
      applyMarketNews({ sym: m.sym, pct: Number(pct) || 3, title: title || undefined, time: '' });
    }
    this.log('news', `${m.sym} · ${title || 'titular generado'} · ${pct >= 0 ? '+' : ''}${pct}%`);
    return { ok: true };
  },

  localEarnings({ sym, pct }) {
    const m = sym === 'ALL' || !sym ? MARKET[Math.floor(Math.random() * MARKET.length)] : bySym(sym);
    if (!m) return { ok: false, error: 'símbolo desconocido' };
    const sign = Number(pct) >= 0 ? 1 : -1;
    const magnitude = Math.abs(Number(pct) || 4);
    return this.localNews({
      sym: m.sym,
      pct: sign * magnitude,
      title: `${m.name} reporta resultados ${sign > 0 ? 'mejores' : 'peores'} de lo esperado`,
    });
  },

  localRegime({ kind, strength, days }) {
    const allowed = kind === 'bajista' || kind === 'lateral' ? kind : 'alcista';
    const level = Number.isFinite(Number(strength)) ? Number(strength) : 0.6;
    const left = Math.round((Number(days) || 5) * 1440);
    MarketNet.setRegime({
      kind: allowed,
      bias: allowed === 'alcista' ? 1 : allowed === 'bajista' ? -1 : level >= 0.5 ? 1 : -1,
      strength: allowed === 'lateral' ? Math.min(level, 0.25) : level,
      left,
    });
    this.log('regime', `régimen ${allowed} · ${days}d · fuerza ${level}`);
    this.toastEvent('Régimen cambiado', `${allowed} · ${days} días de juego`, 'gold');
    return { ok: true };
  },

  localHalt({ sym, halt }) {
    const targets = sym === 'ALL' ? MARKET : MARKET.filter((m) => m.sym === sym);
    for (const m of targets) m.halted = halt !== false;
    this.log('halt', `${sym} ${halt !== false ? 'detenido' : 'reanudado'} · ${targets.length} símbolos`);
    return { ok: true, targets: targets.length };
  },

  localSpeed({ speed }) {
    if (!this.paused) this.speedBefore = MarketNet.gameSpeed;
    MarketNet.setGameSpeed(Number(speed));
    this.log('speed', `×${Number(speed)}`);
    this.toastEvent('Velocidad', `×${Number(speed)}`, 'gold');
    return { ok: true };
  },

  localPause({ paused }) {
    this.paused = paused !== false;
    if (this.paused) {
      this.speedBefore = MarketNet.gameSpeed || 1440;
      MarketNet.setGameSpeed(0);
    } else {
      MarketNet.setGameSpeed(this.speedBefore || 1440);
    }
    this.log('pause', this.paused ? 'reloj congelado' : 'reloj reanudado');
    return { ok: true, paused: this.paused };
  },

  localSettle() {
    const day = Math.floor((typeof currentGameTime === 'function' ? currentGameTime() : Date.now()) / 86400000);
    for (const m of MARKET) {
      m.prevSettle = m.settle;
      m.settle = m.livePrice;
      m.price = m.livePrice;
      m.prevClose = m.livePrice;
      m.settleDay = day;
      m.change = 0;
      m.pct = 0;
    }
    if (typeof settleDirty !== 'undefined') settleDirty = true;
    if (typeof refreshTickUi === 'function') refreshTickUi(true);
    this.log('settle', `ajuste forzado en ${MARKET.length} símbolos`);
    return { ok: true, settled: MARKET.length };
  },

  localResetPrices() {
    for (const m of MARKET) {
      // el precio de partida es el de la primera carga, que no guardamos: usamos
      // el de la empresa actual dividido por su variación acumulada
      const base = m.price / (1 + (m.pct || 0) / 100);
      m.price = base;
      m.livePrice = base;
      m.prevClose = base;
      m.prevSettle = base;
      m.settle = base;
      m.open = base;
      m.high = base;
      m.low = base;
      m.change = 0;
      m.pct = 0;
      m.liveChange = 0;
      m.livePct = 0;
    }
    if (typeof refreshTickUi === 'function') refreshTickUi(true);
    this.log('reset', `precios reiniciados (${MARKET.length} símbolos)`);
    return { ok: true, symbols: MARKET.length };
  },

  localBroadcast({ title, msg, kind }) {
    const safeKind = ['up', 'down', 'gold', 'info'].includes(kind) ? kind : 'gold';
    pushNotification(`📣 ${title}`, msg || '', safeKind);
    toast(title, msg || '', safeKind);
    this.log('broadcast', `${title} · ${msg}`);
    return { ok: true };
  },

  localPlayer({ action, amount }) {
    // el dinero es del servidor: una concesión hecha aquí sólo tocaría la copia
    // local y el siguiente autoguardado la borraría
    if (typeof MarketNet !== 'undefined' && MarketNet.signedIn) {
      this.log('player', 'con sesión el cash lo mueve el servidor: usa la consola remota');
      return { ok: false, error: 'con sesión usa la consola del servidor' };
    }
    if (action === 'grant') {
      const delta = Number.isFinite(Number(amount)) ? Number(amount) : 0;
      state.cash = Math.max(0, state.cash + delta);
      if (typeof updateHud === 'function') updateHud();
      this.log('player', `${MarketNet.accountName || 'invitado'} ${delta >= 0 ? '+' : ''}${delta} de cash`);
      return { ok: true, cash: state.cash };
    }
    if (action === 'reset') {
      state.cash = RECAP_CASH;
      state.positions = {};
      state.transactions = [];
      state.bankrupt = false;
      state.bankruptUntil = 0;
      if (typeof updateHud === 'function') updateHud();
      if (typeof renderPositions === 'function') renderPositions();
      this.log('player', 'partida reiniciada');
      return { ok: true };
    }
    if (action === 'kick') return { ok: true, kicked: 0 };
    return { ok: false, error: 'acción desconocida' };
  },

  log(kind, msg) {
    this.logs.unshift({ t: Date.now(), level: kind, msg });
    if (this.logs.length > 400) this.logs.length = 400;
  },

  toastEvent(title, msg, kind = 'gold') {
    toast(title, msg, kind);
    // feedback audible de la consola: éxito y fracaso suenan distinto
    if (typeof Sound !== 'undefined') {
      const bad = kind === 'down';
      Sound.play(bad ? 'error' : (title === 'Error' || title === 'No se pudo' ? 'error' : 'click'));
    }
    this.log(kind, `${title} · ${msg}`);
  },

  // ----------------------------------------------------------------- rendering

  // the header, the badge and the footer change on their own, without touching
  // the panel, so a poll never disturbs whatever the player is filling in
  renderChrome() {
    const badge = document.getElementById('adminModeBadge');
    if (badge) {
      badge.textContent = `modo: ${this.mode}`;
      badge.className = `admin-mode-badge admin-mode-${this.mode}`;
    }
    const foot = document.getElementById('adminFootLeft');
    if (foot) {
      foot.textContent = `ws:${MarketNet.live ? 'live' : 'offline'} · `
        + `régimen:${MarketNet.regime ? MarketNet.regime.kind : '—'} · `
        + `jugadores:${this.players.length || (this.mode === 'local' ? 1 : 0)}`;
    }
    const line = document.getElementById('adminStatusLine');
    if (line) {
      const s = this.status || {};
      line.textContent = this.mode === 'remote'
        ? `uptime ${Math.round((s.uptimeMs || 0) / 1000)}s · ${s.players || 0} jugadores · ${s.online || 0} en línea · ${s.tickMs || 0}ms/tick`
        : 'servidor local · los eventos se aplican sobre este cliente';
    }
  },

  // the tabs that are made of form fields. their DOM must not be rebuilt while
  // the player is choosing a symbol, so the poll leaves them alone and whatever
  // was typed is carried across a tab switch by hand
  isFormTab() {
    return this.tab === 'events' || this.tab === 'params';
  },

  captureForm() {
    const body = document.getElementById('adminBody');
    if (!body) return;
    body.querySelectorAll('input, select').forEach((el) => {
      const key = el.id || el.dataset.param;
      if (!key) return;
      this.formState[key] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    });
  },

  applyForm() {
    const body = document.getElementById('adminBody');
    if (!body) return;
    body.querySelectorAll('input, select').forEach((el) => {
      const key = el.id || el.dataset.param;
      if (!key) return;
      const saved = this.formState[key];
      if (saved === undefined) return;
      if (el.type === 'checkbox') el.checked = saved === '1';
      else el.value = saved;
    });
  },

  render() {
    const body = document.getElementById('adminBody');
    if (!body) return;
    this.renderChrome();

    switch (this.tab) {
      case 'panel': return this.renderPanel(body);
      case 'events':
        this.renderEvents(body);
        // the picks from the last visit (and from before this repaint) come back
        return this.applyForm();
      case 'params':
        this.renderParams(body);
        return this.applyForm();
      case 'players': return this.renderPlayers(body);
      case 'market': return this.renderMarket(body);
      case 'logs': return this.renderLogs(body);
      default: return undefined;
    }
  },

  renderPanel(body) {
    const netWorth = state.cash + portfolioValue();
    const sorted = [...MARKET].sort((a, b) => b.pct - a.pct);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    body.innerHTML = `
      <div class="admin-quickbar">
        <button class="admin-quick" data-q="pump">▲ Pump aleatorio</button>
        <button class="admin-quick" data-q="dump">▼ Dump aleatorio</button>
        <button class="admin-quick danger" data-q="crash">⚡ Flash crash</button>
        <button class="admin-quick" data-q="rally">↗ Rally global</button>
        <button class="admin-quick" data-q="news">📰 Titular random</button>
        <button class="admin-quick" data-q="regime">🌗 Cambiar régimen</button>
        <button class="admin-quick" data-q="pause">${this.paused ? '▶ Reanudar' : '⏸ Pausar'}</button>
        <button class="admin-quick" data-q="speed">⏩ Velocidad ×${MarketNet.gameSpeed === 1440 ? '5' : '1'}</button>
      </div>

      <div class="admin-grid">
        <div class="admin-card">
          <span class="admin-label">Mi patrimonio (cliente)</span>
          <strong class="mono">${money(netWorth)}</strong>
          <em class="mono">cash ${money(state.cash)} · ${Object.keys(state.positions).length} pos.</em>
        </div>
        <div class="admin-card">
          <span class="admin-label">Mejor del mercado</span>
          <strong class="mono pos">${best ? `${best.sym} ${best.pct >= 0 ? '+' : ''}${best.pct.toFixed(2)}%` : '—'}</strong>
          <em>${best ? best.sector : ''}</em>
        </div>
        <div class="admin-card">
          <span class="admin-label">Peor del mercado</span>
          <strong class="mono neg">${worst ? `${worst.sym} ${worst.pct.toFixed(2)}%` : '—'}</strong>
          <em>${worst ? worst.sector : ''}</em>
        </div>
        <div class="admin-card">
          <span class="admin-label">Régimen</span>
          <strong>${MarketNet.regime ? MarketNet.regime.kind : '—'}</strong>
          <em>fuerza ${Math.round(((MarketNet.regime && MarketNet.regime.strength) || 0) * 100)}%</em>
        </div>
        <div class="admin-card">
          <span class="admin-label">WS</span>
          <strong>${MarketNet.live ? 'live' : 'offline'}</strong>
          <em class="mono">${MarketNet.socketReady ? 'ready' : 'no ready'} · tick ${(this.status && this.status.tickMs) || '—'}ms</em>
        </div>
        <div class="admin-card">
          <span class="admin-label">Velas en memoria</span>
          <strong class="mono">${typeof candles !== 'undefined' ? candles.length : 0}</strong>
          <em class="mono">${Math.round(MarketNet.gameSpeed)}× · ${Object.keys(state.positions).length} posiciones</em>
        </div>
      </div>

      <h3 class="admin-h3">Últimos eventos emitidos</h3>
      <div class="admin-events-mini">
        ${this.logs.length
          ? this.logs.slice(0, 8).map((l) => `
            <div class="admin-event-mini admin-log-${l.level || 'info'}">
              <span class="mono">${new Date(l.t).toLocaleTimeString('es-MX')}</span>
              <span class="admin-log-level">${l.level}</span>
              <span>${l.msg}</span>
            </div>`).join('')
          : '<div class="admin-empty">Sin eventos.</div>'}
      </div>`;
    body.querySelectorAll('.admin-quick').forEach((btn) => {
      btn.addEventListener('click', () => this.quickAction(btn.dataset.q));
    });
  },

  quickAction(kind) {
    const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const randomSym = rand(MARKET).sym;
    switch (kind) {
      case 'pump': return this.sendEvent('/shock', { sym: randomSym, pct: 5, gradual: true });
      case 'dump': return this.sendEvent('/shock', { sym: randomSym, pct: -5, gradual: true });
      case 'crash': return this.sendEvent('/flash-crash', { sym: 'ALL', pct: 10 });
      case 'rally': return this.sendEvent('/rally', { sym: 'ALL', pct: 4, days: 2 });
      case 'news': return this.sendEvent('/news', { sym: randomSym, pct: Math.round((Math.random() * 8 - 4) * 10) / 10 });
      case 'regime': return this.sendEvent('/regime', {
        kind: rand(['alcista', 'bajista', 'lateral']),
        strength: 0.5 + Math.random() * 0.4,
        days: 3 + Math.floor(Math.random() * 5),
      });
      case 'pause': return this.sendEvent('/pause', { paused: !this.paused });
      case 'speed': return this.sendEvent('/speed', { speed: MarketNet.gameSpeed === 1440 ? 5 * 1440 : 1440 });
      default: return undefined;
    }
  },

  sendEvent(suffix, body) {
    return this.adminRequest(`/api/market/admin${suffix}`, 'POST', body)
      .then((result) => {
        if (result && result.error) {
          this.toastEvent('No se pudo', result.error, 'down');
        } else if (typeof Sound !== 'undefined') {
          // el evento salió: confirmación audible para que el admin sepa sin leer
          Sound.play('event');
        }
        this.refresh();
      })
      .catch((error) => this.toastEvent('Error', error.message || 'no se pudo emitir', 'down'));
  },

  renderEvents(body) {
    body.innerHTML = `
      <div class="admin-event-grid">
        <section class="admin-section">
          <h3 class="admin-h3">Titular / noticia</h3>
          <p class="admin-hint">Publica una noticia sobre un símbolo. El movimiento puede ser gradual o instantáneo.</p>
          <label class="admin-field">Símbolo
            <select id="evSym">${MARKET.map((m) => `<option value="${m.sym}">${m.sym} · ${m.name}</option>`).join('')}</select>
          </label>
          <label class="admin-field">Movimiento %
            <input id="evPct" type="number" value="3" step="0.5" min="-50" max="50">
          </label>
          <label class="admin-field">Texto
            <input id="evText" type="text" placeholder="(vacío = generado)">
          </label>
          <button class="nav-modal-btn" data-ev="news">Publicar titular</button>
        </section>

        <section class="admin-section">
          <h3 class="admin-h3">Shock de precio</h3>
          <p class="admin-hint">Mueve un precio al instante o de forma gradual. Útil para pump/dump quirúrgico.</p>
          <label class="admin-field">Símbolo
            <select id="shSym"><option value="ALL">— TODO EL MERCADO —</option>${MARKET.map((m) => `<option value="${m.sym}">${m.sym}</option>`).join('')}</select>
          </label>
          <label class="admin-field">Δ %
            <input id="shPct" type="number" value="5" step="0.5" min="-50" max="50">
          </label>
          <label class="admin-field admin-inline">
            <input id="shGrad" type="checkbox" checked> gradual
          </label>
          <button class="nav-modal-btn" data-ev="shock">Aplicar shock</button>
        </section>

        <section class="admin-section">
          <h3 class="admin-h3">Régimen del mercado</h3>
          <p class="admin-hint">Cambia el humor global y su duración en días de juego.</p>
          <label class="admin-field">Tipo
            <select id="rgKind">
              <option value="alcista">Alcista</option>
              <option value="bajista">Bajista</option>
              <option value="lateral">Lateral</option>
            </select>
          </label>
          <label class="admin-field">Fuerza (0–1)
            <input id="rgStr" type="number" value="0.6" step="0.05" min="0" max="1">
          </label>
          <label class="admin-field">Duración (días juego)
            <input id="rgDays" type="number" value="5" min="1" max="30">
          </label>
          <button class="nav-modal-btn" data-ev="regime">Cambiar régimen</button>
        </section>

        <section class="admin-section">
          <h3 class="admin-h3">Flash crash / Rally</h3>
          <p class="admin-hint">Eventos de alta volatilidad, globales o por símbolo.</p>
          <label class="admin-field">Tipo
            <select id="ccType">
              <option value="flash-crash">Flash crash (caída)</option>
              <option value="rally">Rally (subida)</option>
            </select>
          </label>
          <label class="admin-field">Símbolo
            <select id="ccSym"><option value="ALL">— TODO EL MERCADO —</option>${MARKET.map((m) => `<option value="${m.sym}">${m.sym}</option>`).join('')}</select>
          </label>
          <label class="admin-field">Magnitud %
            <input id="ccPct" type="number" value="8" min="1" max="50">
          </label>
          <button class="nav-modal-btn danger" data-ev="cc">Emitir</button>
        </section>

        <section class="admin-section">
          <h3 class="admin-h3">Resultados</h3>
          <p class="admin-hint">Fuerza un earnings con sorpresa positiva o negativa.</p>
          <label class="admin-field">Símbolo
            <select id="eaSym">${MARKET.map((m) => `<option value="${m.sym}">${m.sym} · ${m.name}</option>`).join('')}</select>
          </label>
          <label class="admin-field">Sorpresa %
            <input id="eaPct" type="number" value="4" step="0.5" min="-30" max="30">
          </label>
          <button class="nav-modal-btn" data-ev="earnings">Publicar resultados</button>
        </section>

        <section class="admin-section">
          <h3 class="admin-h3">Control de sesión</h3>
          <p class="admin-hint">Pausa el reloj, cambia la velocidad o congela un símbolo.</p>
          <div class="admin-actions">
            <button class="nav-modal-btn" data-ev="pause">${this.paused ? '▶ Reanudar' : '⏸ Pausar'}</button>
            <button class="nav-modal-btn" data-ev="speedSlow">×1</button>
            <button class="nav-modal-btn" data-ev="speedFast">×5</button>
            <button class="nav-modal-btn danger" data-ev="haltAll">Halt global</button>
          </div>
        </section>

        <section class="admin-section admin-section-wide">
          <h3 class="admin-h3">Broadcast a todos los jugadores</h3>
          <p class="admin-hint">Aparece como toast + notificación en cada cliente conectado.</p>
          <label class="admin-field">Título
            <input id="bcTitle" type="text" placeholder="Mantenimiento programado">
          </label>
          <label class="admin-field">Mensaje
            <input id="bcMsg" type="text" placeholder="El servidor se reinicia en 5 min">
          </label>
          <label class="admin-field">Tipo
            <select id="bcKind">
              <option value="gold">Informativo (gold)</option>
              <option value="up">Positivo (verde)</option>
              <option value="down">Negativo (rojo)</option>
            </select>
          </label>
          <button class="nav-modal-btn" data-ev="broadcast">Emitir broadcast</button>
        </section>

        <section class="admin-section admin-section-wide">
          <h3 class="admin-h3">🗳️ Sondo: sondeo personalizado</h3>
          <p class="admin-hint">Abre una encuesta para todos los jugadores. El voto colectivo mueve el precio al resolverse (hasta ±4%).</p>
          <label class="admin-field">Pregunta
            <input id="plQ" type="text" placeholder="(vacío = ¿Sube o baja {SYM} al cierre?)">
          </label>
          <label class="admin-field">Símbolo
            <select id="plSym"><option value="">— aleatorio —</option>${MARKET.map((m) => `<option value="${m.sym}">${m.sym} · ${m.name}</option>`).join('')}</select>
          </label>
          <label class="admin-field">Duración (minutos reales, 3–45)
            <input id="plMin" type="number" value="8" min="3" max="45">
          </label>
          <div class="admin-actions">
            <button class="nav-modal-btn" data-ev="pollOpen">Abrir sondeo</button>
            <button class="nav-modal-btn" data-ev="pollList">Ver sondeos</button>
          </div>
          <div id="adminPollList"></div>
        </section>
      </div>`;

    body.querySelectorAll('[data-ev]').forEach((btn) => {
      btn.addEventListener('click', () => this.emitEvent(btn.dataset.ev));
    });
  },

  emitEvent(kind) {
    const g = (id) => document.getElementById(id);
    const val = (id) => (g(id) ? g(id).value : '');
    const num = (id) => parseFloat(g(id) ? g(id).value : '') || 0;
    const bool = (id) => Boolean(g(id) && g(id).checked);

    switch (kind) {
      case 'news':
        return this.sendEvent('/news', {
          sym: val('evSym'),
          pct: num('evPct'),
          title: String(val('evText')).trim() || undefined,
        });
      case 'shock':
        return this.sendEvent('/shock', { sym: val('shSym'), pct: num('shPct'), gradual: bool('shGrad') });
      case 'regime':
        return this.sendEvent('/regime', { kind: val('rgKind'), strength: num('rgStr'), days: num('rgDays') });
      case 'cc':
        return this.sendEvent(`/${val('ccType')}`, { sym: val('ccSym'), pct: num('ccPct'), days: 2 });
      case 'earnings':
        return this.sendEvent('/earnings', { sym: val('eaSym'), pct: num('eaPct') });
      case 'pause':
        return this.sendEvent('/pause', { paused: !this.paused });
      case 'speedSlow':
        return this.sendEvent('/speed', { speed: 1440 });
      case 'speedFast':
        return this.sendEvent('/speed', { speed: 5 * 1440 });
      case 'haltAll':
        return this.sendEvent('/halt', { sym: 'ALL', halt: true });
      case 'broadcast':
        return this.sendEvent('/broadcast', { title: val('bcTitle') || 'Aviso', msg: val('bcMsg'), kind: val('bcKind') });
      case 'pollOpen':
        return this.adminRequest('/api/market/admin/polls', 'POST', {
          question: String(val('plQ')).trim() || undefined,
          sym: val('plSym') || undefined,
          durationMs: Math.round(num('plMin') * 60 * 1000),
        }).then((r) => {
          if (r?.ok) this.toastEvent('Sondo', `sondeo #${r.poll.id} abierto: ${r.poll.question}`, 'gold');
        }).catch((err) => this.toastEvent('Error', err.message || 'no se pudo abrir', 'down'));
      case 'pollList':
        return this.adminRequest('/api/market/admin/polls', 'GET').then((r) => {
          const listEl = document.getElementById('adminPollList');
          if (!listEl) return;
          const polls = (r?.polls || []).slice(0, 8);
          listEl.innerHTML = polls.length
            ? `<div class="admin-events-mini">${polls.map((p) => `
                <div class="admin-event-mini admin-log-poll">
                  <span class="mono">#${p.id}</span>
                  <span class="admin-log-level">${p.status}${p.custom ? '·custom' : ''}</span>
                  <span>${p.question} · ${p.up}↑/${p.down}↓</span>
                  ${p.status === 'open' ? `<button class="scrub-btn" data-pollclose="${p.id}" title="Cerrar ya">⏹</button>` : ''}
                </div>`).join('')}</div>`
            : '<div class="admin-empty">Sin sondeos todavía.</div>';
          listEl.querySelectorAll('[data-pollclose]').forEach((btn) => {
            btn.addEventListener('click', () => {
              this.adminRequest('/api/market/admin/polls/close', 'POST', { id: Number(btn.dataset.pollclose) })
                .then(() => this.toastEvent('Sondo', `sondeo #${btn.dataset.pollclose} cerrando`, 'gold'))
                .catch(() => {});
            });
          });
        }).catch((err) => this.toastEvent('Error', err.message || 'no se pudo listar', 'down'));
      default:
        return undefined;
    }
  },

  renderParams(body) {
    const groups = Object.entries(ADMIN_PARAM_META).map(([key, meta]) => `
      <section class="admin-section">
        <h3 class="admin-h3">${meta.label}</h3>
        <div class="admin-param-grid">
          ${meta.fields.map(([field, label]) => `
            <label class="admin-field">${label}
              <input type="number" step="any" data-param="${key}.${field}" value="${this.params[key][field]}">
            </label>`).join('')}
        </div>
        <div class="admin-actions">
          <button class="nav-modal-btn" data-paramsave="${key}">Aplicar ${meta.label}</button>
          <button class="nav-modal-btn" data-paramreset="${key}">Restaurar</button>
        </div>
      </section>`).join('');

    body.innerHTML = `
      <p class="admin-hint">Los cambios se guardan en este navegador y se aplican al juego. En modo remoto los que el servidor puede honrar (tick y velocidad) se le envían.</p>
      ${groups}
      <section class="admin-section">
        <h3 class="admin-h3">Todo</h3>
        <div class="admin-actions">
          <button class="nav-modal-btn" data-paramsave="all">Aplicar todo</button>
          <button class="nav-modal-btn danger" data-paramreset="all">Restaurar todo</button>
        </div>
      </section>`;

    body.querySelectorAll('[data-param]').forEach((input) => {
      input.addEventListener('change', () => {
        const [group, field] = input.dataset.param.split('.');
        const value = Number(input.value);
        if (Number.isFinite(value)) this.params[group][field] = value;
        this.applyParamsLocal();
      });
    });
    body.querySelectorAll('[data-paramsave]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.paramsave;
        this.saveParams();
        this.applyParamsLocal();
        if (this.mode === 'remote') this.pushParamsRemote(section === 'all' ? undefined : section);
        else this.toastEvent('Parámetros aplicados', section === 'all' ? 'todos' : section, 'gold');
      });
    });
    body.querySelectorAll('[data-paramreset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.paramreset;
        this.resetParams(section === 'all' ? undefined : section);
      });
    });
  },

  renderPlayers(body) {
    body.innerHTML = `
      <p class="admin-hint">${this.mode === 'remote'
        ? 'Cuentas registradas en el servicio. Conceder efectivo o reiniciar actúa sobre su cartera guardada.'
        : 'En modo local sólo existes tú: estas acciones caen sobre tu propia partida.'}</p>
      <table class="admin-table">
        <thead><tr><th>ID</th><th>Nombre</th><th>Cash</th><th>Posiciones</th><th>Nivel</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${this.players.length ? this.players.map((p) => `
            <tr>
              <td class="mono">${String(p.id || '').slice(0, 8)}</td>
              <td>${p.name || ''}${p.admin ? ' <span class="admin-badge">admin</span>' : ''}</td>
              <td class="mono">${money(Number(p.cash) || 0)}</td>
              <td class="mono">${p.positions || 0}</td>
              <td class="mono">${p.level || 1}</td>
              <td>${p.bankrupt ? '<span class="admin-badge danger">bancarrota</span>' : (p.online ? '<span class="admin-badge">en línea</span>' : '—')}</td>
              <td class="admin-row-actions">
                <button class="scrub-btn" data-grant="${p.id}" title="Dar $10,000">$</button>
                <button class="scrub-btn" data-reset="${p.id}" title="Reiniciar">↺</button>
                <button class="scrub-btn" data-kick="${p.id}" title="Expulsar">✕</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="7" class="admin-empty">Sin jugadores.</td></tr>'}
        </tbody>
      </table>`;

    body.querySelectorAll('[data-grant]').forEach((btn) => {
      btn.addEventListener('click', () => this.force('/player', { id: btn.dataset.grant, action: 'grant', amount: 10000 }));
    });
    body.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', () => this.force('/player', { id: btn.dataset.reset, action: 'reset' }));
    });
    body.querySelectorAll('[data-kick]').forEach((btn) => {
      btn.addEventListener('click', () => this.force('/player', { id: btn.dataset.kick, action: 'kick' }));
    });
  },

  renderMarket(body) {
    body.innerHTML = `
      <div class="admin-actions">
        <button class="nav-modal-btn" id="adminSettle">Forzar ajuste ahora</button>
        <button class="nav-modal-btn danger" id="adminResetPrices">Resetear precios</button>
      </div>
      <table class="admin-table">
        <thead><tr><th>Símbolo</th><th>Sector</th><th>Ajuste</th><th>Cinta</th><th>Δ%</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${MARKET.map((m) => `
            <tr>
              <td class="mono">${m.sym}</td>
              <td>${m.sector}</td>
              <td class="mono">${m.price.toFixed(2)}</td>
              <td class="mono">${(typeof m.livePrice === 'number' ? m.livePrice : m.price).toFixed(2)}</td>
              <td class="mono ${m.pct >= 0 ? 'pos' : 'neg'}">${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(2)}%</td>
              <td>${m.halted ? '<span class="admin-badge danger">halt</span>' : '—'}</td>
              <td class="admin-row-actions">
                <button class="scrub-btn" data-shock="${m.sym}" data-pct="5" title="+5%">+5%</button>
                <button class="scrub-btn" data-shock="${m.sym}" data-pct="-5" title="-5%">−5%</button>
                <button class="scrub-btn" data-halt="${m.sym}" data-halt-state="${m.halted ? '0' : '1'}" title="Detener/reanudar">⏸</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    body.querySelector('#adminSettle').addEventListener('click', () => this.force('/settle', {}));
    body.querySelector('#adminResetPrices').addEventListener('click', () => this.force('/reset-prices', {}));
    body.querySelectorAll('[data-shock]').forEach((btn) => {
      btn.addEventListener('click', () => this.sendEvent('/shock', {
        sym: btn.dataset.shock,
        pct: Number(btn.dataset.pct),
        gradual: true,
      }));
    });
    body.querySelectorAll('[data-halt]').forEach((btn) => {
      btn.addEventListener('click', () => this.sendEvent('/halt', {
        sym: btn.dataset.halt,
        halt: btn.dataset.haltState === '1',
      }));
    });
  },

  renderLogs(body) {
    body.innerHTML = `
      <div class="admin-actions">
        <button class="nav-modal-btn" id="adminClearLogs">Limpiar</button>
        <button class="nav-modal-btn" id="adminExportLogs">Exportar JSON</button>
      </div>
      <div class="admin-logs">
        ${this.logs.length ? this.logs.map((l) => `
          <div class="admin-log admin-log-${l.level || 'info'}">
            <span class="mono">${new Date(l.t).toLocaleTimeString('es-MX')}</span>
            <span class="admin-log-level">${l.level}</span>
            <span>${l.msg}</span>
          </div>`).join('') : '<div class="admin-empty">Sin logs.</div>'}
      </div>`;

    body.querySelector('#adminClearLogs').addEventListener('click', () => {
      this.logs = [];
      this.render();
    });
    body.querySelector('#adminExportLogs').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(this.logs, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bolsa-admin-logs-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  },

  async force(path, payload) {
    try {
      const result = await this.adminRequest(`/api/market/admin${path}`, 'POST', payload);
      if (result && result.error) {
        this.toastEvent('Admin', result.error, 'down');
      } else {
        this.toastEvent('Admin', `${path} ok`, 'gold');
      }
      this.refresh();
    } catch (e) {
      this.toastEvent('Admin error', e.message || 'falló', 'down');
    }
  },
};

// atajo de teclado: siempre funciona, sirve también como herramienta de desarrollo
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && AdminConsole.open) {
    AdminConsole.close();
    return;
  }
  if (event.ctrlKey && event.shiftKey && String(event.key).toLowerCase() === 'a') {
    event.preventDefault();
    AdminConsole.toggle();
  }
});

// el botón del rail sólo aparece si la cuenta es admin
function maybeMountAdminButton() {
  const rail = document.querySelector('.rail-nav');
  if (!rail) return;
  const existing = rail.querySelector('.rail-admin');
  if (!AdminConsole.isAvailable()) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const btn = document.createElement('button');
  btn.className = 'rail-btn rail-admin';
  btn.dataset.tip = 'Admin';
  btn.title = 'Consola de administrador (Ctrl+Shift+A)';
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4zm-1.2 12.4-3-3 1.4-1.4 1.6 1.6 4-4L16.2 9z"/></svg>';
  btn.addEventListener('click', () => AdminConsole.show());
  rail.appendChild(btn);
}
