
// el catálogo de empresas (MARKET), las reglas de la partida (START_CASH,
// RECAP_CASH, BANKRUPT_WAIT_MS) y la copy de noticias viven en sus archivos:
// js/catalog.js y js/news-copy.js. este archivo solo guarda el estado.
const state = {
  cash: START_CASH,
  
  positions: {},
  transactions: [],   
  bankrupt: false,
  bankruptUntil: 0,

  
  level: 1,
  xp: 0,

  
  watchlist: [],

  
  notifications: [], 
  unreadNotifs: 0,

  
  news: [], 

  
  // `currentStreak`/`bestStreak` are the win/loss run behind the ranking's racha
  // column and the streak achievements; `timesBankrupt`, `peakNet` and
  // `bestDayReturn` feed the rest of the achievements, so they travel with the
  // save and with the server-stored portfolio.
  stats: {
    wins:0, losses:0, totalTrades:0, bestTrade:0, grossProfit:0, grossLoss:0,
    currentStreak:0, bestStreak:0, timesBankrupt:0, peakNet:0, bestDayReturn:0,
  },

  
  quests: { firstBuy:false, diversify:false },

  // progression systems. the cases are a cash sink inside the game (nothing is
  // ever bought with real money), so their history and the cosmetics they hand
  // out live with the save.
  caseHistory: [],
  xpBoost: null,        // { mult, until } while a booster is running
  goldenTickets: 0,     // free-share coupons won from cases
  skins: [],            // cosmetic ids the case roulette can award (bolsa's own list)
  opencase: null,       // the opencase book (inventory + trades), mirrored from the server
  netHistory: [],       // [{ t, net }] the sparkline behind the stats panel
  dayTrack: { key: -1, open: 0 },
  // alertas de precio: [{ id, sym, dir:'up'|'down', target, last }]. el motor
  // vive en js/price-alerts.js; aquí sólo se guardan y se sanean
  priceAlerts: [],

  // el banco del jugador (servicios/market/bank.mjs en el server): ahorro que
  // rinde por día de juego y la deuda viva de un préstamo. la verdad vive en el
  // server cuando hay sesión; en modo invitado js/bank.js la simula igualito
  bank: { balance: 0, loan: 0, loanDaysLeft: 0, loanAtDay: null },

  // órdenes en espera (limit/stop) que ya apartaron su margen: el server las
  // ejecuta tick a tick cuando la cinta cruza su precio
  orders: [],

  // transferencias entre jugadores (vía banco): [{ id, dir:'in'|'out', with,
  // amount, at, note }]. el server escribe ambos libros; aquí sólo viajan con
  // la partida para poder pintar el historial sin pedirlo
  transfers: [],

  // el casino (servicios/market/casino.mjs en el server): la mano de blackjack
  // viva y las estadísticas de juego. el dinero NUNCA vive aquí: cada apuesta
  // la liquida el server; en modo invitado js/casino.js replica las mismas
  // reglas sobre este book y el cash de arriba
  casino: { bj: null, stats: { rounds: 0, wagered: 0, won: 0 } },
};

let activeSymbol = 'SOLMK';
let side = 'buy';
let leverage = 1; 
let currentView = 'trading'; 
let sectorFilter = 'ALL';
let watchlistOnly = false;


// dos decimales para lo normal; por debajo de $1 se abre a cuatro, para que una
// empresa hundida no se lea como "$0.00" en toda la interfaz
const fmt = n => (Math.abs(n) < 1
  ? n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 })
  : n.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }));
const money = n => `$${fmt(n)}`;
const bySym = sym => MARKET.find(m=>m.sym===sym);

// la cinta: m.price ya es el precio en vivo (el que se opera y con el que se
// valora la cartera), así que esto es sólo la red de seguridad para una serie
// que todavía no recibió ninguna cotización.
function livePrice(m){
  if(!m) return 0;
  return typeof m.livePrice === 'number' && Number.isFinite(m.livePrice) ? m.livePrice : m.price;
}

// Guarda de corrupción para el precio de la cinta, no un límite. Antes esto era
// un Math.max(0.2, ...) y era el motivo de que una empresa que se hundía se
// quedara clavada en una línea recta: al llegar al suelo, cualquier movimiento
// negativo lo devolvía a exactamente 0.2 para siempre. Un precio pequeño es
// legítimo (una penny stock), así que sólo se rechaza lo que no es un precio.
function safePrice(value, fallback){
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}


// what the position is still worth: its margin plus the unrealised result. it
// is allowed to go negative on purpose — when a leveraged loss eats the whole
// margin the trade owes money, and that is the signal that closes it.
function positionContribution(sym, p){
  const m = bySym(sym);
  if(!m) return 0;
  const pnl = p.shares * (m.price - p.avgPrice);
  return (p.margin||0) + pnl;
}
function positionPnl(sym, p){
  const m = bySym(sym);
  if(!m) return 0;
  return p.shares * (m.price - p.avgPrice);
}
function portfolioValue(){
  return Object.entries(state.positions).reduce((sum,[sym,p])=> sum + positionContribution(sym,p), 0);
}
// what the player is worth: cash + bank balance - debt + the positions at the
// live price. lives here, next to the rest of the portfolio maths, because the
// achievements, the bank desk, the profile and the ranking all read this one
// number and each of them used to carry its own copy.
function netWorth(){
  let total = state.cash + (state.bank?.balance || 0) - (state.bank?.loan || 0);
  for(const [sym,p] of Object.entries(state.positions)){
    const m = bySym(sym);
    total += p.shares * (m ? m.price : (p.avgPrice || 0));
  }
  return total;
}


// the admin console can dial how long a toast stays on screen; 3s otherwise
function toastTtlMs(){
  const value = window.__adminParams && window.__adminParams.notifications
    ? Number(window.__adminParams.notifications.ttlMs) : 0;
  return Number.isFinite(value) && value > 0 ? value : 3000;
}
function toast(title, msg, kind='up'){
  const stack = document.getElementById('toastStack');
  if(!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast-${safeClassToken(kind, 'up')}`;
  // title y msg son texto libre del servidor (broadcast del admin): sin
  // escapar, un admin —o quien lo engañe pegando html— ejecuta codigo en
  // todas las pestañas abiertas. el token de sesion vive en localStorage del
  // mismo origen, asi que el XSS se lo lleva entero.
  el.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(msg)}</span>`;
  stack.appendChild(el);
  setTimeout(()=> el.remove(), toastTtlMs());
}


// same idea: the console owns the ceiling on stored notifications
function notificationLimit(){
  const value = window.__adminParams && window.__adminParams.notifications
    ? Number(window.__adminParams.notifications.max) : 0;
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 40;
}
function pushNotification(title, msg, kind='info'){
  const time = new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'});
  state.notifications.unshift({ title, msg, kind, time, read:false });
  if(state.notifications.length > notificationLimit()) state.notifications.length = notificationLimit();
  state.unreadNotifs++;
  if(typeof renderNotifications === 'function') renderNotifications();
  if(typeof Sound !== 'undefined') Sound.play('notify');
}

// titulares rodantes: los viejos caen solos al llegar nuevos (NEWS_LIMIT vive en
// js/news-copy.js)
function newsLimit(){
  return Number.isFinite(NEWS_LIMIT) && NEWS_LIMIT > 0 ? NEWS_LIMIT : 15;
}
function trimNews(){
  if(state.news.length > newsLimit()) state.news.length = newsLimit();
  return state.news;
}
function clearNews(){
  state.news = [];
}


function xpToNext(){
  const xp = window.__adminParams && window.__adminParams.xp ? window.__adminParams.xp : null;
  const base = xp && Number.isFinite(Number(xp.base)) ? Number(xp.base) : 400;
  const per = xp && Number.isFinite(Number(xp.perLevel)) ? Number(xp.perLevel) : 260;
  return Math.round(base + (state.level-1)*per);
}
function addXp(amount){
  const boost = xpBoostActive();
  if(boost) amount = Math.round(amount * boost.mult);
  state.xp += amount;
  let leveled = false;
  while(state.xp >= xpToNext()){
    state.xp -= xpToNext();
    state.level++;
    leveled = true;
  }
  if(leveled){
    if(typeof Sound !== 'undefined') Sound.play('levelup');
    toast('¡Subiste de nivel!', `Ahora eres nivel ${state.level}`, 'gold');
    // el jingle de nivel sustituye a la campanita: un sonido, no dos
    if(typeof suppressNextNotify === 'function') suppressNextNotify();
    pushNotification('Subiste de nivel', `Ahora eres nivel ${state.level}.`, 'gold');
  }
  if(typeof updateHud === 'function') updateHud();
}


const RANKS = [
  { min:1,  name:'Novato de Suelo' },
  { min:5,  name:'Operador Junior' },
  { min:10, name:'Trader de Piso' },
  { min:18, name:'Estratega de Cartera' },
  { min:28, name:'Veterano de Suelo' },
  { min:40, name:'Tiburón del Mercado' },
  { min:55, name:'Magnate Bursátil' },
];
function rankForLevel(level){
  let best = RANKS[0];
  for(const r of RANKS){ if(level>=r.min) best = r; }
  return best.name;
}


function isWatched(sym){ return state.watchlist.includes(sym); }
function toggleWatchlist(sym){
  if(!sym || !bySym(sym)) return;
  const i = state.watchlist.indexOf(sym);
  if(i>=0){ state.watchlist.splice(i,1); }
  else{ state.watchlist.push(sym); toast('Añadido a favoritos', `${sym} está ahora en tu lista de seguimiento.`, 'gold'); }
  if(typeof buildMarketRows === 'function') buildMarketRows();
  if(typeof renderWatchlist === 'function') renderWatchlist();
}


function recordClosedTrade(pnl){
  state.stats.totalTrades++;
  if(pnl >= 0){
    state.stats.wins++;
    state.stats.grossProfit += pnl;
    // the racha counts closed trades in a row, so a loss resets it to zero
    state.stats.currentStreak = (state.stats.currentStreak || 0) + 1;
    state.stats.bestStreak = Math.max(state.stats.bestStreak || 0, state.stats.currentStreak);
  }
  else{
    state.stats.losses++;
    state.stats.grossLoss += Math.abs(pnl);
    state.stats.currentStreak = 0;
  }
  state.stats.bestTrade = Math.max(state.stats.bestTrade, pnl);
}

// a case can hand out a timed XP booster; while one is up every award is
// multiplied, and the badge in the HUD shows it
function xpBoostActive(){
  const boost = state.xpBoost;
  if(!boost || !boost.until) return null;
  if(Date.now() >= boost.until){ state.xpBoost = null; return null; }
  return boost;
}

// one sample of the net worth curve: the sparkline in the stats panel, the peak
// (for the drawdown figure) and the best single game day. called on the game's
// own slow beat, never per tick.
function trackNetProgress(){
  const nw = state.cash + portfolioValue();
  // el pico y el mejor día los lleva el servidor cuando hay sesión (ledger.mjs
  // runRiskPass los mide sobre SUS posiciones); en invitado, aquí
  const serverOwned = typeof MarketNet !== 'undefined' && MarketNet.signedIn;
  if(!serverOwned){
    state.stats.peakNet = Math.max(state.stats.peakNet || 0, nw);
    const day = typeof currentGameTime === 'function'
      ? Math.floor(currentGameTime() / 86400000)
      : Math.floor(Date.now() / 86400000);
    if(state.dayTrack.key !== day){
      state.dayTrack = { key: day, open: nw };
    } else if(state.dayTrack.open > 0){
      const ret = ((nw - state.dayTrack.open) / state.dayTrack.open) * 100;
      if(ret > (state.stats.bestDayReturn || 0)) state.stats.bestDayReturn = ret;
    }
  }

  state.netHistory.push({ t: Date.now(), net: nw });
  if(state.netHistory.length > 96) state.netHistory.splice(0, state.netHistory.length - 96);
  return nw;
}

// the deepest fall from the highest net worth ever reached, in percent
function maxDrawdownPct(){
  const peak = state.stats.peakNet || 0;
  if(peak <= 0) return null;
  const now = state.cash + portfolioValue();
  return Math.max(0, ((peak - now) / peak) * 100);
}
function winRatePct(){
  const s = state.stats;
  return s.totalTrades ? (s.wins/s.totalTrades)*100 : null;
}
function profitFactor(){
  const s = state.stats;
  if(s.grossLoss <= 0) return s.grossProfit>0 ? Infinity : null;
  return s.grossProfit/s.grossLoss;
}


function checkQuests(){
  const rows = document.querySelectorAll('.quest-row');
  if(!rows.length) return;

  if(!state.quests.firstBuy && state.transactions.some(t=>t.type==='Compra' && t.sym!=='RECAP')){
    state.quests.firstBuy = true;
    rows[0].classList.add('is-done');
    rows[0].querySelector('.quest-check').innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>';
    addXp(50);
    pushNotification('Misión completada', 'Realiza tu primera compra (+50 XP)', 'gold');
  }
  const distinctSymbols = Object.keys(state.positions).filter(s=>state.positions[s].shares>0).length;
  if(!state.quests.diversify && distinctSymbols>=3){
    state.quests.diversify = true;
    rows[1].classList.add('is-done');
    rows[1].querySelector('.quest-check').innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>';
    addXp(120);
    pushNotification('Misión completada', 'Diversifica en 3 símbolos (+120 XP)', 'gold');
  }
  syncQuestDom();
}

function syncQuestDom(){
  const rows = document.querySelectorAll('.quest-row');
  if(!rows.length) return;
  const mark = (i) => {
    if(!rows[i]) return;
    rows[i].classList.add('is-done');
    rows[i].querySelector('.quest-check').innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>';
  };
  if(state.quests.firstBuy) mark(0);
  if(state.quests.diversify) mark(1);
}

const SAVE_KEY = 'bolsa-trading-floor-save';

function saveGame(){
  try{
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      state,
      market: MARKET.map(m=>({ sym:m.sym, price:m.price, open:m.open, prevClose:m.prevClose, high:m.high, low:m.low,
        livePrice:m.livePrice, settle:m.settle, prevSettle:m.prevSettle, settleDay:m.settleDay, nextSettleAt:m.nextSettleAt })),
      activeSymbol, side, leverage, currentView,
    }));
  }catch(e){}

  // signed in players also persist cash, positions and statistics on the
  // server so restarting the server (or another device) keeps the progress
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn) MarketNet.savePortfolio();
}
// a save is merged over the defaults field by field instead of Object.assign: an
// old or hand edited save must not leave stats.wins or quests.diversify
// undefined, which would make winRatePct() return NaN and the quest rows break
function restoreState(raw){
  if(!raw || typeof raw !== 'object') return;
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  state.cash = num(raw.cash, state.cash);
  state.bankrupt = raw.bankrupt === true;
  state.bankruptUntil = num(raw.bankruptUntil, 0);
  // el banco y las órdenes en espera viajan con la partida; un guardado viejo
  // sin banco deja los ceros por defecto en vez de undefined
  const bank = raw.bank && typeof raw.bank === 'object' ? raw.bank : {};
  state.bank = {
    balance: Math.max(0, num(bank.balance, 0)),
    loan: Math.max(0, num(bank.loan, 0)),
    loanDaysLeft: Math.max(0, Math.round(num(bank.loanDaysLeft, 0))),
    loanAtDay: Number.isFinite(bank.loanAtDay) ? bank.loanAtDay : null,
  };
  state.orders = Array.isArray(raw.orders)
    ? raw.orders.filter(o => o && typeof o === 'object' && bySym(o.sym) && num(o.shares, 0) > 0 && num(o.price, 0) > 0)
    : [];
  state.transfers = Array.isArray(raw.transfers) ? raw.transfers.slice(0, 50) : [];
  state.level = Math.max(1, Math.round(num(raw.level, state.level)));
  state.xp = Math.max(0, num(raw.xp, 0));
  state.positions = raw.positions && typeof raw.positions === 'object' ? raw.positions : {};
  for(const [sym, p] of Object.entries(state.positions)){
    if(!p || typeof p !== 'object' || !bySym(sym)){ delete state.positions[sym]; continue; }
    p.shares = num(p.shares, 0);
    p.avgPrice = num(p.avgPrice, 0);
    p.margin = num(p.margin, 0);
    p.leverage = num(p.leverage, 1);
  }
  state.transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
  state.watchlist = Array.isArray(raw.watchlist) ? raw.watchlist.filter(s => bySym(s)) : [];
  state.notifications = Array.isArray(raw.notifications) ? raw.notifications : [];
  state.unreadNotifs = Math.max(0, Math.round(num(raw.unreadNotifs, 0)));
  state.news = Array.isArray(raw.news) ? raw.news : [];
  state.stats = Object.assign({ wins:0, losses:0, totalTrades:0, bestTrade:0, grossProfit:0, grossLoss:0,
    currentStreak:0, bestStreak:0, timesBankrupt:0, peakNet:0, bestDayReturn:0 }, raw.stats);
  for(const key of ['wins','losses','totalTrades','bestTrade','grossProfit','grossLoss',
    'currentStreak','bestStreak','timesBankrupt','peakNet','bestDayReturn']){
    state.stats[key] = num(state.stats[key], 0);
  }
  // the counters cannot be negative: a hand edited save must not turn the racha
  // into a negative run or the bankruptcy count into nonsense
  for(const key of ['wins','losses','totalTrades','grossProfit','grossLoss',
    'currentStreak','bestStreak','timesBankrupt','peakNet']){
    state.stats[key] = Math.max(0, state.stats[key]);
  }
  state.quests = Object.assign({ firstBuy:false, diversify:false }, raw.quests);
  state.quests.firstBuy = state.quests.firstBuy === true;
  state.quests.diversify = state.quests.diversify === true;

  // progression fields, each one validated so a hand edited save cannot make
  // the cases or the stats panel throw
  state.caseHistory = Array.isArray(raw.caseHistory)
    ? raw.caseHistory.filter(h => h && typeof h === 'object').slice(0, 30) : [];
  state.skins = Array.isArray(raw.skins) ? raw.skins.filter(s => typeof s === 'string').slice(0, 40) : [];
  state.goldenTickets = Math.max(0, Math.round(num(raw.goldenTickets, 0)));
  state.xpBoost = raw.xpBoost && typeof raw.xpBoost === 'object'
    && num(raw.xpBoost.until, 0) > Date.now()
    ? { mult: Math.min(20, Math.max(1, num(raw.xpBoost.mult, 1))), until: num(raw.xpBoost.until, 0) }
    : null;
  state.netHistory = Array.isArray(raw.netHistory)
    ? raw.netHistory.filter(p => p && Number.isFinite(p.net)).slice(-96) : [];
  state.dayTrack = raw.dayTrack && Number.isFinite(raw.dayTrack.key)
    ? { key: raw.dayTrack.key, open: Math.max(0, num(raw.dayTrack.open, 0)) }
    : { key: -1, open: 0 };
  // las alertas de precio se sanean en su propio módulo (símbolo existente,
  // objetivo finito y positivo), así que una entrada corrupta no dispara sola
  state.priceAlerts = typeof sanitizePriceAlerts === 'function'
    ? sanitizePriceAlerts(raw.priceAlerts) : [];
}

function loadGame(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(!raw) return false;
    const d = JSON.parse(raw);
    restoreState(d.state);
    if(Array.isArray(d.market)){
      d.market.forEach(s=>{
        const m = bySym(s.sym);
        if(m && typeof s.price==='number'){
          m.price=s.price; m.open=s.open; m.prevClose=s.prevClose; m.high=s.high; m.low=s.low;
          if(typeof s.livePrice==='number') m.livePrice=s.livePrice; else m.livePrice=s.price;
          m.settle = typeof s.settle==='number' ? s.settle : s.price;
          m.prevSettle = typeof s.prevSettle==='number' ? s.prevSettle : m.settle;
          if(typeof s.settleDay==='number') m.settleDay=s.settleDay;
          if(typeof s.nextSettleAt==='number') m.nextSettleAt=s.nextSettleAt;
          // la cinta es el precio operable y el cambio que muestra el juego es el
          // del día, contra el cierre anterior (no contra el ajuste)
          m.liveChange=m.livePrice-m.prevClose; m.livePct=(m.liveChange/(m.prevClose||1))*100;
          m.change=m.liveChange; m.pct=m.livePct;
        }
      });
    }
    if(typeof d.activeSymbol==='string' && bySym(d.activeSymbol)) activeSymbol = d.activeSymbol;
    if(d.side==='buy'||d.side==='sell') side = d.side;
    if(typeof d.leverage==='number') leverage = d.leverage;
    if(d.currentView==='trading'||d.currentView==='research'||d.currentView==='empire') currentView = d.currentView;
    syncQuestDom();
    return true;
  }catch(e){ return false; }
}
