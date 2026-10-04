
function initCollapse(){
  document.querySelectorAll('[data-collapse]').forEach(btn=>{
    btn.addEventListener('click', ()=> btn.closest('.panel').classList.toggle('is-collapsed'));
  });
}


// el modal de navegación. opts:
//   wide: true  -> panel ancho (formularios a dos columnas, banco, etc.)
//   focus: sel -> selector dentro del body que recibe el foco al abrir
let navModalLastFocus = null;
function openNavModal(title, bodyHtml, opts = {}){
  const overlay = document.getElementById('navModalOverlay');
  const modal = overlay.querySelector('.nav-modal');
  navModalLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.getElementById('navModalTitle').textContent = title;
  document.getElementById('navModalBody').innerHTML = bodyHtml;
  modal.classList.toggle('is-wide', opts.wide === true);
  // sólo suena si el panel estaba cerrado: los repintados del modal abierto
  // (el banco refresca números así) no deben hacer ruido extra
  const wasHidden = !overlay.classList.contains('is-visible');
  overlay.classList.add('is-visible');
  if(wasHidden && typeof Sound !== 'undefined') Sound.play('open');
  // el foco entra al panel: teclado listo sin clic extra
  const target = opts.focus ? document.getElementById('navModalBody').querySelector(opts.focus) : null;
  if (target) { try { target.focus(); } catch (e) {} }
}
function closeNavModal(){
  document.getElementById('navModalOverlay').classList.remove('is-visible');
  if(typeof Sound !== 'undefined') Sound.play('close');
  if (navModalLastFocus && document.contains(navModalLastFocus)) {
    try { navModalLastFocus.focus(); } catch (e) {}
  }
  navModalLastFocus = null;
}

// ---- segmented control reutilizable ---------------------------------------
// pestañas modernas con indicador deslizante: un solo contenedor, el bloque
// de color se mueve con transform detrás de la pestaña activa.
//   items: [[id, label], ...]   activo: id
function segmentedHtml(items, active){
  const idx = Math.max(0, items.findIndex(([id]) => id === active));
  return `
    <div class="seg" role="tablist" style="--seg-n:${items.length};--seg-i:${idx}">
      <span class="seg-indicator" aria-hidden="true"></span>
      ${items.map(([id, label]) =>
        `<button class="seg-btn${id === active ? ' is-active' : ''}" role="tab" aria-selected="${id === active}" data-seg="${id}">${label}</button>`).join('')}
    </div>`;
}

// pinta los handlers: al cambiar de pestaña, mueve el indicador y repinta el
// panel con el callback. se re-liga tras cada repintado (los paneles se
// regeneran con innerHTML).
function bindSegmented(container, onSelect){
  if (!container) return;
  const seg = container.querySelector('.seg');
  if (!seg) return;
  const move = (btn) => {
    const idx = [...seg.querySelectorAll('.seg-btn')].indexOf(btn);
    if (idx >= 0) seg.style.setProperty('--seg-i', String(idx));
  };
  seg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('is-active')) return;
      move(btn);
      onSelect(btn.dataset.seg, seg);
    });
  });
}

function academiaContent(){
  return `
    <div class="nav-modal-list">
      <div class="nav-modal-item is-done"><span>1. Cómo leer una vela japonesa</span><em>Completado</em></div>
      <div class="nav-modal-item"><span>2. Gestión de riesgo y apalancamiento</span><em>Bloqueado</em></div>
      <div class="nav-modal-item"><span>3. Órdenes de mercado vs. límite</span><em>Bloqueado</em></div>
      <div class="nav-modal-item"><span>4. Diversificación de cartera</span><em>Bloqueado</em></div>
    </div>
    <p class="nav-modal-note">La Academia está en construcción — pronto habrá lecciones interactivas completas.</p>`;
}
function noticiasContent(){
  const items = state.news.length ? state.news.map(n=>{
    const m = bySym(n.sym);
    // la variación que se muestra es la del mercado ahora, no la del titular
    const now = m ? m.pct : 0;
    return `<div class="nav-modal-item">
      <span><strong>${n.sym}</strong> · ${n.time} · ${n.title} (+${n.pct.toFixed(1)}% estimado)</span>
      <em class="${now>=0?'pos':'neg'}">${now>=0?'+':''}${now.toFixed(1)}%</em>
    </div>`;
  }).join('') : '<div class="mini-empty">Aún no hay noticias. Espera unos segundos...</div>';
  return `
    <div class="nav-modal-toolbar">
      <span class="nav-modal-count">${state.news.length} de ${newsLimit()} titulares</span>
      <button class="nav-modal-btn" id="newsClearBtn" ${state.news.length ? '' : 'disabled'}>Limpiar noticias</button>
    </div>
    <div class="nav-modal-list">${items}</div>
    <p class="nav-modal-note">Se guardan los ${newsLimit()} más recientes: al llegar un titular nuevo cae el más viejo.</p>`;
}

// abre el panel de noticias y engancha su botón de limpiar
function renderNewsModal(){
  openNavModal('Noticias del mercado', noticiasContent());
  const body = document.getElementById('navModalBody');
  const btn = body && body.querySelector('#newsClearBtn');
  if(!btn) return;
  btn.addEventListener('click', ()=>{
    clearNews();
    renderNewsModal();
    toast('Noticias', 'Titulares vaciados', 'gold');
  });
}
// ------------------------------------------------------------------ alerta central
// cuando el mercado se mueve fuerte (un evento encadenado, un titular grande)
// aparece un aviso en medio de la pantalla. tocar el aviso entra a esa inversión
// con la gráfica y el formulario listos para comprar; la ✕ sólo lo cierra.
let marketAlertTimer = null;
const MARKET_ALERT_TTL_MS = 14000;

function buildMarketAlert(){
  const el = document.createElement('div');
  el.id = 'marketAlertOverlay';
  el.className = 'market-alert-overlay';
  el.innerHTML = `
    <div class="market-alert" id="marketAlertCard" role="alertdialog" aria-modal="true" aria-live="assertive"></div>
    <button class="market-alert-close" id="marketAlertClose" aria-label="Cerrar aviso" title="Cerrar">✕</button>`;
  document.body.appendChild(el);
  el.addEventListener('click', (event)=>{
    // la ✕ cierra y nada más; cualquier otro clic lleva a operar ese símbolo
    if(event.target.closest('#marketAlertClose')){
      hideMarketAlert();
      return;
    }
    // los controles de compra tienen su propio trabajo: no deben navegar
    if(event.target.closest('.market-alert-buy')) return;
    const sym = el.dataset.sym;
    hideMarketAlert();
    if(sym && typeof selectSymbol === 'function') selectSymbol(sym);
  });
  return el;
}

// compra directa desde el aviso: usa exactamente la misma ruta que el botón del
// panel (poner el lado en compra, elegir el símbolo, escribir la cantidad y
// ejecutar), así el margen, el apalancamiento y el registro son los de siempre.
function buyFromAlert(sym, qty){
  const m = typeof bySym === 'function' ? bySym(sym) : null;
  const n = Math.floor(Number(qty) || 0);
  if(!m || n <= 0) return false;
  if(state.bankrupt){
    toast('Cuenta en bancarrota', 'Espera a la recapitalización para volver a operar.', 'down');
    return false;
  }
  const buySide = document.querySelector('.side-btn[data-side="buy"]');
  if(buySide) buySide.click();
  if(typeof selectSymbol === 'function') selectSymbol(sym);
  const qtyInput = document.getElementById('qtyInput');
  if(qtyInput) qtyInput.value = String(n);
  // el aviso compra a mercado limpio: sin TP/SL heredados de una orden anterior
  ['tpInput', 'slInput', 'trailInput'].forEach((id) => {
    const el = document.getElementById(id);
    if(el) el.value = '';
  });
  if(typeof recalcOrder === 'function') recalcOrder();
  const before = state.positions[sym] ? state.positions[sym].shares : 0;
  // executeOrder ya canta la compra (o los fondos insuficientes), así que aquí
  // no se repite el aviso
  if(typeof executeOrder === 'function') executeOrder();
  const after = state.positions[sym] ? state.positions[sym].shares : 0;
  hideMarketAlert();
  return after > before;
}

function hideMarketAlert(){
  const overlay = document.getElementById('marketAlertOverlay');
  if(overlay) overlay.classList.remove('is-visible');
  clearTimeout(marketAlertTimer);
  marketAlertTimer = null;
}

// `alert` = { sym, navSym?, name?, title?, pct?, tone?, kicker? }
function showMarketAlert(alert){
  if(!alert || !alert.sym) return;
  const overlay = document.getElementById('marketAlertOverlay') || buildMarketAlert();
  const up = alert.tone !== 'down' && !(Number(alert.pct) < 0);
  const pct = Number(alert.pct) || 0;
  const global = alert.sym === 'ALL';
  const m = global ? null : bySym(alert.sym);
  const navSym = alert.navSym || (global ? biggestMoverSym() : alert.sym);
  const pctText = pct === 0 ? '' : `${up ? '+' : ''}${pct.toFixed(1)}%`;
  // cuántas acciones entran con el efectivo disponible (y el apalancamiento que
  // el panel tenga puesto ahora mismo)
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  const maxQty = navSym && m && m.price > 0
    ? Math.max(0, Math.floor((state.cash * lev) / m.price)) : 0;
  const canBuy = Boolean(navSym) && maxQty > 0 && !state.bankrupt;
  const defQty = Math.max(1, Math.min(10, maxQty));
  const maxText = state.bankrupt
    ? 'cuenta en bancarrota'
    : maxQty > 0
      ? `máx ${maxQty} acciones con tu efectivo${lev > 1 ? ` (x${Math.round(lev)})` : ''}`
      : 'sin efectivo disponible';
  const card = overlay.querySelector('#marketAlertCard');
  card.innerHTML = `
    <div class="market-alert-icon">${up ? '📈' : '📉'}</div>
    <span class="market-alert-kicker">${alert.kicker || 'Movimiento fuerte en el mercado'}</span>
    <strong class="market-alert-sym mono">${global ? 'TODO EL MERCADO' : alert.sym}</strong>
    <span class="market-alert-name">${global ? 'Varias empresas en movimiento' : (m ? m.name : (alert.name || ''))}</span>
    <p class="market-alert-title">${alert.title || ''}</p>
    ${pctText ? `<span class="market-alert-pct mono ${up ? 'pos' : 'neg'}">${pctText}</span>` : ''}
    ${navSym ? `
    <div class="market-alert-buy">
      <label class="market-alert-qty">
        <span>Cantidad</span>
        <input type="number" id="marketAlertQty" min="0" step="1" inputmode="numeric"
          value="${canBuy ? defQty : 0}" ${canBuy ? '' : 'disabled'}
          aria-label="Acciones a comprar">
      </label>
      <button class="market-alert-buy-btn" id="marketAlertBuy" ${canBuy ? '' : 'disabled'}>Comprar</button>
      <span class="market-alert-max mono">${maxText}</span>
    </div>` : ''}
    <span class="market-alert-hint">${navSym ? 'Compra aquí mismo, o toca la tarjeta para abrir su gráfica' : 'Toca fuera para cerrar'}</span>`;
  overlay.dataset.sym = navSym || '';
  overlay.classList.add('is-visible');
  overlay.classList.toggle('is-down', !up);
  if(typeof Sound !== 'undefined') Sound.play('alert', { up });

  // el botón se etiqueta con la cantidad viva ("Comprar 12") y se apaga si se
  // pasa de lo que el efectivo permite
  const qtyEl = card.querySelector('#marketAlertQty');
  const buyBtn = card.querySelector('#marketAlertBuy');
  if(qtyEl && buyBtn){
    const syncLabel = () => {
      const q = Math.max(0, parseInt(qtyEl.value, 10) || 0);
      buyBtn.textContent = q > 0 ? `Comprar ${q}` : 'Comprar';
      buyBtn.disabled = !canBuy || q <= 0 || q > maxQty;
    };
    qtyEl.addEventListener('input', syncLabel);
    qtyEl.addEventListener('keydown', (event) => { if(event.key === 'Enter') buyBtn.click(); });
    buyBtn.addEventListener('click', () => buyFromAlert(navSym, parseInt(qtyEl.value, 10) || 0));
    syncLabel();
  }
  clearTimeout(marketAlertTimer);
  // un aviso con botón de compra se queda un poco más: da tiempo a decidir
  marketAlertTimer = setTimeout(hideMarketAlert, canBuy ? MARKET_ALERT_TTL_MS + 6000 : MARKET_ALERT_TTL_MS);
}

function biggestMoverSym(){
  let best = null;
  MARKET.forEach(m => {
    if(!best || Math.abs(m.pct) > Math.abs(best.pct)) best = m;
  });
  return best ? best.sym : null;
}

// the profile now lives in the "Tu progreso" modal, which groups the four
// player sections behind one set of tabs (see js/profile.js, js/leaderboard.js,
// js/achievements.js and js/cases.js).
function perfilContent(){
  return typeof profileContent === 'function' ? profileContent() : '';
}

const PROGRESS_TABS = [
  ['perfil', '👤 Perfil', 'Tu perfil'],
  ['ranking', '🏆 Ranking', 'Ranking global'],
  ['logros', '🏅 Logros', 'Logros'],
  ['cajas', '🎁 Cajas', 'Cajas de mercado'],
];

function progressContent(tab = 'perfil'){
  return `
    ${segmentedHtml(PROGRESS_TABS.map(([id, label]) => [id, label]), tab)}
    <div id="progPanel">${progressPanel(tab)}</div>`;
}

function progressPanel(tab){
  if(tab === 'ranking'){
    return typeof Leaderboard !== 'undefined' && leaderboardCache.data
      ? leaderboardContent() : '<div class="mini-empty">Cargando ranking…</div>';
  }
  if(tab === 'logros') return typeof achievementsContent === 'function' ? achievementsContent() : '';
  return typeof profileContent === 'function' ? profileContent() : '';
}

function bindProgress(body){
  if(!body) return;
  bindSegmented(body, async (tab) => {
    if(tab === 'cajas'){
      closeNavModal();
      if(typeof CaseGame !== 'undefined') CaseGame.show();
      return;
    }
    const titleEl = document.getElementById('navModalTitle');
    const found = PROGRESS_TABS.find(t => t[0] === tab);
    if(titleEl && found) titleEl.textContent = found[2];

    body.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('is-active', b.dataset.seg === tab));
    const panel = document.getElementById('progPanel');
    if(!panel) return;
    if(tab === 'ranking'){
      panel.innerHTML = '<div class="mini-empty">Cargando ranking…</div>';
      await Leaderboard.fetch(true);
    }
    panel.innerHTML = progressPanel(tab);
    if(tab === 'ranking') Leaderboard.bind(panel);
    if(tab === 'perfil') bindProfileEvents(panel);
    if(tab === 'logros') bindAchievementsEvents(panel);
  });
  const panel = document.getElementById('progPanel');
  if(panel){
    if(typeof bindProfileEvents === 'function') bindProfileEvents(panel);
  }
}

function bindAchievementsEvents(panel){
  // nothing to wire yet: the achievement grid is read-only. kept as its own
  // function so the tab has a single place to grow.
  return panel;
}

async function openProgressModal(tab = 'perfil'){
  const found = PROGRESS_TABS.find(t => t[0] === tab);
  openNavModal(found ? found[2] : 'Tu progreso', progressContent(tab));
  bindProgress(document.getElementById('navModalBody'));
  // opening straight on the ranking has to go and get it: the panel is painted
  // before the request is answered, so it is filled in when the answer lands
  if(tab === 'ranking' && typeof Leaderboard !== 'undefined'){
    const panel = document.getElementById('progPanel');
    if(panel) panel.innerHTML = '<div class="mini-empty">Cargando ranking…</div>';
    await Leaderboard.fetch(true);
    const target = document.getElementById('progPanel');
    if(target){
      target.innerHTML = leaderboardContent();
      Leaderboard.bind(target);
    }
  }
}

function initRailNav(){
  const buttons = document.querySelectorAll('.rail-nav .rail-btn');
  const activate = (btn)=>{
    buttons.forEach(b=>b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const tip = btn.dataset.tip;
    if(tip==='Academia') openNavModal('Academia', academiaContent());
    if(tip==='Noticias') renderNewsModal();
    if(tip==='Progreso') openProgressModal('perfil');
    if(tip==='Banco' && typeof openBank === 'function') openBank('banco');
    if(tip==='Casino' && typeof openCasino === 'function') openCasino('menu');
  };
  buttons.forEach(btn=>{
    btn.addEventListener('click', ()=> activate(btn));
  });

  // atajos: A academia · N noticias · B banco · P progreso · Esc cierra
  document.addEventListener('keydown', (e)=>{
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
    if(e.key === 'Escape'){
      const overlay = document.getElementById('navModalOverlay');
      if(overlay && overlay.classList.contains('is-visible')){ closeNavModal(); e.preventDefault(); }
      return;
    }
    if(typing) return;
    const map = { a:'Academia', n:'Noticias', b:'Banco', p:'Progreso', c:'Casino' };
    const tip = map[e.key.toLowerCase()];
    if(!tip) return;
    const btn = [...buttons].find(b=>b.dataset.tip===tip);
    if(btn){ activate(btn); e.preventDefault(); }
  });

  const avatar = document.getElementById('railAvatar');
  if(avatar) avatar.addEventListener('click', ()=> openProgressModal('perfil'));

  document.getElementById('navModalClose').addEventListener('click', closeNavModal);
  document.getElementById('navModalOverlay').addEventListener('click', (e)=>{
    if(e.target.id==='navModalOverlay') closeNavModal();
  });
  document.getElementById('navModalBody').addEventListener('click', (e)=>{
    if(e.target.id==='profileSessionBtn'){
      closeNavModal();
      if(typeof MarketNet !== 'undefined' && MarketNet.signedIn){
        MarketNet.logout().then(()=>{
          toast('Sesión cerrada', 'Puedes volver a entrar o jugar como invitado.', 'gold');
          openAuthModal('login');
        });
      } else {
        openAuthModal('login');
      }
    }
  });
}
