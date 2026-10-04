
// los títulos que mueven el precio de verdad se ganan el aviso central; por
// debajo de este umbral basta con la notificación normal
const BIG_NEWS_PCT = 8;

// positions and the wallet are marked at the live tape, so they change on every
// tick: this flag just asks the UI beat to repaint them (it is set from
// applyMarketQuotes / walkMarketPrices, never read outside refreshTickUi)
let settleDirty = true;

function buildTicker(){
  const track = document.getElementById('tickerTrack');
  const build = () => MARKET.map(m => `
    <button class="tick" data-sym="${m.sym}" title="Ver la gráfica de ${m.sym}">
      <b>${m.sym}</b>
      <span class="mono ${m.pct>=0?'pos':'neg'}">${m.price.toFixed(2)}</span>
      <span class="mono ${m.pct>=0?'pos':'neg'}">${m.pct>=0?'▲':'▼'} ${Math.abs(m.pct).toFixed(2)}%</span>
    </button>`).join('');
  track.innerHTML = build() + build();

  // the tape is rebuilt on every render, so listen on the track itself: tapping
  // a price takes you straight to that investment's chart
  if(!track.dataset.bound){
    track.dataset.bound = '1';
    track.addEventListener('click', (e)=>{
      const item = e.target.closest('.tick');
      if(item && item.dataset.sym) selectSymbol(item.dataset.sym);
    });
  }
}

// shared entry point: select an investment and show its chart, wherever the
// click came from (ticker tape, market list, positions, watchlist, movers)
function selectSymbol(sym, options = {}){
  const m = bySym(sym);
  if(!m) return false;

  if(options.jump !== false && typeof currentView === 'string' && currentView !== 'trading' && typeof switchView === 'function'){
    switchView('trading');
  }

  // remember where the player was looking in the company they are leaving, so
  // coming back reopens the same window instead of the live edge
  if(typeof saveChartView === 'function') saveChartView();

  activeSymbol = sym;
  document.querySelectorAll('.market-row').forEach(r=>{
    r.classList.toggle('is-active', r.dataset.sym===sym);
  });
  updateQuoteBlock();

  // this company's history was most likely installed on this machine the first
  // time it was opened: paint that copy right away, with the window that was left
  const cached = typeof HistoryCache !== 'undefined' ? HistoryCache.peek(sym, currentTF) : null;
  if(cached && cached.length && typeof paintHistorySeries === 'function'){
    paintHistorySeries(cached, HistoryCache.peekView(sym, currentTF));
  } else {
    const cfg = TIMEFRAMES[currentTF];
    tickCount = 0;
    generateCandles(cfg.count, cfg.volMult);
    visibleCount = cfg.visible;
    // a brand new investment starts at the live edge
    if(typeof resetChartView === 'function') resetChartView();
    animateChartIn();
  }
  seedChartFromServer();
  if(typeof refreshChartLayout === 'function') refreshChartLayout();
  return true;
}
// the ticker is rebuilt twice over (it wraps around), so a tick touches forty
// nodes: every write is guarded, and a value that did not change costs nothing
function refreshTicker(){
  document.querySelectorAll('.tick').forEach(el=>{
    const m = bySym(el.dataset.sym);
    if(!m) return;
    const spans = el.querySelectorAll('.mono');
    const cls = `mono ${m.pct>=0?'pos':'neg'}`;
    const priceText = m.price.toFixed(2);
    if(spans[0].textContent !== priceText) spans[0].textContent = priceText;
    if(spans[0].className !== cls) spans[0].className = cls;
    const pctText = `${m.pct>=0?'▲':'▼'} ${Math.abs(m.pct).toFixed(2)}%`;
    if(spans[1].textContent !== pctText) spans[1].textContent = pctText;
    if(spans[1].className !== cls) spans[1].className = cls;
  });
}


function buildSectorChips(){
  const wrap = document.getElementById('sectorChipRow');
  if(!wrap) return;
  const sectors = ['ALL', ...Array.from(new Set(MARKET.map(m=>m.sector)))];
  wrap.innerHTML = sectors.map(s=>`
    <button class="sector-chip ${sectorFilter===s?'is-active':''}" data-sector="${s}">${s==='ALL'?'Todos':s}</button>
  `).join('') + `<button class="sector-chip sector-chip-star ${watchlistOnly?'is-active':''}" id="chipWatchOnly">★ Favoritas</button>`;

  wrap.querySelectorAll('.sector-chip[data-sector]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      sectorFilter = btn.dataset.sector;
      buildSectorChips();
      buildMarketRows();
    });
  });
  const watchBtn = document.getElementById('chipWatchOnly');
  if(watchBtn) watchBtn.addEventListener('click', ()=>{
    watchlistOnly = !watchlistOnly;
    buildSectorChips();
    buildMarketRows();
  });

  // the row is a single scrollable line, so keep the selected sector in view
  // even when it sits past the right edge of the column
  const active = wrap.querySelector('.sector-chip.is-active');
  if(active && wrap.scrollWidth > wrap.clientWidth + 1){
    const target = active.offsetLeft - (wrap.clientWidth - active.offsetWidth)/2;
    wrap.scrollLeft = Math.max(0, Math.min(wrap.scrollWidth - wrap.clientWidth, target));
  }

  // a mouse wheel scrolls the row sideways, otherwise the last sectors would be
  // unreachable without a trackpad
  if(!wrap.dataset.wheelBound){
    wrap.dataset.wheelBound = '1';
    wrap.addEventListener('wheel', (e)=>{
      if(wrap.scrollWidth <= wrap.clientWidth + 1) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if(!delta) return;
      e.preventDefault();
      wrap.scrollLeft += delta;
    }, { passive:false });
  }
}


function buildMarketRows(){
  const rows = document.getElementById('marketRows');
  const list = MARKET.filter(m=>{
    if(watchlistOnly && !isWatched(m.sym)) return false;
    if(sectorFilter!=='ALL' && m.sector!==sectorFilter) return false;
    return true;
  });

  if(!list.length){
    rows.innerHTML = '<div class="mini-empty">Nada que mostrar con este filtro.</div>';
    return;
  }

  rows.innerHTML = list.map(m => `
    <div class="market-row ${m.sym===activeSymbol?'is-active':''}" data-sym="${m.sym}">
      <button class="star-btn ${isWatched(m.sym)?'is-active':''}" data-star="${m.sym}" title="Añadir a favoritos">★</button>
      <span class="sym">${m.pct>=0?'▲':'▼'} ${m.sym}</span>
      <span class="mono" data-f="price">${m.price.toFixed(2)}</span>
      <span class="mono ${m.change>=0?'pos':'neg'}" data-f="change">${m.change>=0?'+':''}${m.change.toFixed(2)}</span>
      <span class="mono ${m.pct>=0?'pos':'neg'}" data-f="pct">${m.pct>=0?'+':''}${m.pct.toFixed(2)}%</span>
    </div>`).join('');

  rows.querySelectorAll('.star-btn').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      toggleWatchlist(btn.dataset.star);
    });
  });

  rows.querySelectorAll('.market-row').forEach(row=>{
    row.addEventListener('click', ()=> selectSymbol(row.dataset.sym, { jump:false }));
    // un soplido por fila al pasar el cursor: textura, no melodía — por eso
    // lleva límite de ritmo para no ametrallar al mover el mouse
    if(typeof Sound !== 'undefined' && Sound.play){
      row.addEventListener('mouseenter', () => {
        const now = Date.now();
        if(now - lastHoverAt < 70) return;
        lastHoverAt = now;
        Sound.play('hover');
      });
    }
  });
}
let lastHoverAt = 0;
function refreshMarketRow(sym){
  const row = document.querySelector(`.market-row[data-sym="${sym}"]`);
  if(!row) return;
  const m = bySym(sym);

  const priceEl = row.querySelector('[data-f="price"]');
  const priceText = m.price.toFixed(2);
  if(priceEl.textContent !== priceText){
    priceEl.textContent = priceText;
    // the flash forces a reflow, so it is only paid when the row really moved
    // and never more than twice a second (ten rows flashing every tick was the
    // single most expensive thing on this screen)
    const now = Date.now();
    if(now - (row.flashAt || 0) > 600){
      row.flashAt = now;
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
    }
  }

  const chEl = row.querySelector('[data-f="change"]');
  const chText = `${m.change>=0?'+':''}${m.change.toFixed(2)}`;
  const chClass = `mono ${m.change>=0?'pos':'neg'}`;
  if(chEl.textContent !== chText) chEl.textContent = chText;
  if(chEl.className !== chClass) chEl.className = chClass;

  const pctEl = row.querySelector('[data-f="pct"]');
  const pctText = `${m.pct>=0?'+':''}${m.pct.toFixed(2)}%`;
  const pctClass = `mono ${m.pct>=0?'pos':'neg'}`;
  if(pctEl.textContent !== pctText) pctEl.textContent = pctText;
  if(pctEl.className !== pctClass) pctEl.className = pctClass;

  // la flecha de tendencia vive dentro del símbolo: gira con el día
  const symEl = row.querySelector('.sym');
  if(symEl){
    const arrow = m.pct>=0 ? '▲' : '▼';
    const symText = `${arrow} ${m.sym}`;
    if(symEl.textContent !== symText) symEl.textContent = symText;
  }
}


// how long until the quote is fixed again, in real time (the game clock runs
// 1440x, so a game day is a real minute)
function settleCountdownText(m){
  if(!m || !Number.isFinite(m.nextSettleAt)) return '';
  const clock = typeof currentGameTime === 'function' ? currentGameTime() : Date.now();
  const remainingReal = Math.max(0, (m.nextSettleAt - clock) / 1440);
  const totalSeconds = Math.round(remainingReal / 1000);
  const mm = String(Math.floor(totalSeconds/60)).padStart(2,'0');
  const ss = String(totalSeconds%60).padStart(2,'0');
  return `ajuste ${mm}:${ss}`;
}

function updateQuoteBlock(){
  const m = bySym(activeSymbol);
  // the big number is the *settlement* price: the one an order executes at. it
  // only moves every couple of game days, so it never slips away while the
  // player is typing. the live tape travels right next to it.
  document.getElementById('quotePrice').textContent = m.price.toFixed(2);
  const changeEl = document.getElementById('quoteChange');
  changeEl.classList.toggle('pos', m.pct>=0);
  changeEl.classList.toggle('neg', m.pct<0);
  changeEl.querySelector('svg path').setAttribute('d', m.pct>=0 ? 'M12 5v14 M5 12l7-7 7 7' : 'M12 19V5 M5 12l7 7 7-7');
  changeEl.querySelectorAll('.mono')[0].textContent = `${m.change>=0?'+':''}${m.change.toFixed(2)}`;
  changeEl.querySelectorAll('.mono')[1].textContent = `(${m.pct>=0?'+':''}${m.pct.toFixed(2)}%)`;

  const chip = document.getElementById('settleChip');
  if(chip){
    const text = settleCountdownText(m);
    if(chip.textContent !== text) chip.textContent = text;
  }
  const liveEl = document.getElementById('quoteLive');
  if(liveEl){
    // el número grande ya es la cinta en vivo; aquí va el *ajuste*, la
    // referencia que sólo se mueve cada dos días de juego
    const settle = Number.isFinite(m.settle) ? m.settle : m.price;
    const text = `ajuste ${settle.toFixed(2)}`;
    if(liveEl.textContent !== text){
      liveEl.textContent = text;
      liveEl.className = 'mono settle-live';
    }
  }
  document.querySelector('.quote-symbol').innerHTML = `${m.sym} <span>·</span> ${m.name} <span>·</span> ${m.sector}`;
  document.getElementById('chartTitle').textContent = m.name;
  document.getElementById('priceField').textContent = money(m.price);
  document.getElementById('submitLabel').textContent =
    `${side==='buy'?'Comprar':'Vender'} ${m.sym}${side==='buy' && leverage>1 ? ' ·x'+leverage : ''}`;

  document.getElementById('statOpen').textContent = m.open.toFixed(2);
  document.getElementById('statPrevClose').textContent = m.prevClose.toFixed(2);
  document.getElementById('statHigh').textContent = m.high.toFixed(2);
  document.getElementById('statLow').textContent = m.low.toFixed(2);

  const pos = state.positions[m.sym];
  document.getElementById('statSharesOwned').textContent = pos ? pos.shares : 0;
  document.getElementById('statAvgPrice').textContent = pos ? money(pos.avgPrice) : '—';

  updateCompanyProfile();
  recalcOrder();
}

// every company has its own logic (growth, volatility, cycle, how often it
// surprises), so the asset summary says which one you are looking at instead of
// leaving two symbols looking like the same maths under a different name
let profileShownFor = null;
const VOL_WORDS = [[0.009, 'alta'], [0.005, 'media'], [-Infinity, 'baja']];
function updateCompanyProfile(){
  const tagsEl = document.getElementById('profileTags');
  const noteEl = document.getElementById('profileNote');
  if(!tagsEl || !noteEl) return;
  // cheap guard: the summary redraws on every tick
  if(profileShownFor === activeSymbol && tagsEl.childElementCount) return;

  const profiles = typeof marketCompanyProfiles === 'object' && marketCompanyProfiles
    ? marketCompanyProfiles : null;
  const p = profiles ? profiles[activeSymbol] : null;
  profileShownFor = activeSymbol;
  if(!p){
    tagsEl.innerHTML = '';
    noteEl.textContent = '';
    noteEl.removeAttribute('title');
    return;
  }

  tagsEl.innerHTML = (p.tags || [])
    .map((tag)=>`<span class="profile-tag">${tag}</span>`)
    .join('');

  const growth = Number(p.growth) || 0;
  const facts = [];
  if(growth > 0) facts.push(`crecimiento +${growth.toFixed(2)}%/día`);
  else if(growth < 0) facts.push(`en declive ${growth.toFixed(2)}%/día`);
  else facts.push('sin deriva de largo plazo');
  facts.push(`volatilidad ${(VOL_WORDS.find(([min])=> p.volatility >= min) || [0,'baja'])[1]}`);
  if(p.cycle) facts.push(`ciclo ${p.cycle.days}d ±${p.cycle.amplitude}%`);
  if(p.surpriseDays) facts.push(`sorpresas ~cada ${p.surpriseDays}d (±${p.surpriseMax}%)`);
  noteEl.textContent = facts.join(' · ');
  noteEl.title = `${p.name} · ${p.sector} · beta ${p.beta} · sensibilidad a noticias ${p.newsSensitivity}`;
}


// NEWS_AREAS (copy de los titulares) vive en js/news-copy.js
function publishNews(){
  if(typeof MarketNet !== 'undefined' && MarketNet.live) return;
  const m = MARKET[Math.floor(Math.random()*MARKET.length)];
  const pct = Math.round((Math.random()*6 + 3)*10)/10; 
  const monto = Math.round(Math.random()*350 + 150); 
  const area = NEWS_AREAS[Math.floor(Math.random()*NEWS_AREAS.length)];
  // the panel labels server headlines with game time, so the offline fallback
  // must use the game clock too instead of the wall clock
  const clock = typeof currentGameTime === 'function' ? currentGameTime() : Date.now();
  const time = new Date(clock).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'});

  state.news.unshift({ sym:m.sym, title:`${m.name} invirtió más de $${monto}M en ${area}`, pct, time });
  trimNews();

  // la noticia mueve el *tape*, no el ajuste: el precio al que se opera sigue
  // fijo hasta el próximo ajuste (igual que en el modelo del servidor), y así
  // change/pct se siguen midiendo contra prevSettle en vez de contra prevClose
  const live = typeof m.livePrice === 'number' ? m.livePrice : m.price;
  m.livePrice = safePrice(live * (1 + pct/100), live);
  m.liveChange = m.livePrice - m.prevClose;
  m.livePct = (m.liveChange/m.prevClose)*100;
  m.high = Math.max(m.high, m.livePrice);
  m.low = Math.min(m.low, m.livePrice);

  refreshTicker();
  refreshMarketRow(m.sym);
  updateQuoteBlock();
  updatePerformancePanel();
  if(Object.keys(state.positions).length) renderPositions();
  toast(m.sym, `${m.name} · alza estimada +${pct.toFixed(1)}%`, 'up');
  pushNotification(`📰 ${m.name}`, `Invirtió más de $${monto}M en ${area} · alza estimada +${pct.toFixed(1)}%`, 'up');
}


let marketUiReady = false;

function normalizeNewsItem(item){
  if(!item || typeof item !== 'object') return null;
  return {
    sym: item.sym,
    title: item.title,
    pct: item.pct,
    time: item.time || new Date(item.at || Date.now()).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}),
    // gameTime del server: es lo que la gráfica usa para clavar el marcador
    // sobre la vela que estaba viva cuando la noticia cayó
    at: Number.isFinite(item.at) ? item.at : (typeof currentGameTime === 'function' ? currentGameTime() : Date.now()),
  };
}

// marcadores de eventos para la gráfica: cada noticia de este símbolo deja una
// banderita sobre la vela donde cayó. el buffer vive aquí y la gráfica lo lee.
function chartEventMarkers(sym){
  if(!state.news || !state.news.length) return [];
  return state.news
    .filter(n => n.sym === sym && Number.isFinite(n.at))
    .slice(0, 12)
    .map(n => ({ t: n.at, pct: n.pct || 0, title: n.title || '' }));
}

// only used when the realtime feed is unavailable, so the simulator keeps
// moving instead of freezing while the market service restarts. it follows the
// same rule as the server: the tape walks every tick, the price you trade at is
// only fixed every two game days.
function walkMarketPrices(){
  const clock = typeof currentGameTime === 'function' ? currentGameTime() : Date.now();
  const day = Math.floor(clock / 86400000);
  MARKET.forEach(m=>{
    const live = typeof m.livePrice === 'number' ? m.livePrice : m.price;
    const shock = (Math.random()-0.5) * m.vol * live;
    const reversion = (m.prevClose - live) * 0.015;
    m.livePrice = safePrice(live + shock + reversion, live);
    m.high = Math.max(m.high, m.livePrice);
    m.low = Math.min(m.low, m.livePrice);
    m.liveChange = m.livePrice - m.prevClose;
    m.livePct = (m.liveChange/m.prevClose)*100;
    // sin conexión el precio que se opera es la propia cinta, igual que con el
    // servidor: el ajuste sólo queda como referencia y se mueve cada dos días
    m.price = m.livePrice;
    m.change = m.liveChange;
    m.pct = m.livePct;
    settleDirty = true;

    const settleDay = Number.isFinite(m.settleDay) ? m.settleDay : day;
    if(day - settleDay >= 2){
      m.prevSettle = Number.isFinite(m.settle) ? m.settle : m.price;
      m.settle = m.livePrice;
      m.settleDay = day;
      m.settleAt = day*86400000;
      m.nextSettleAt = (day+2)*86400000;
    }
  });
}

// the feed ticks faster than the eye (and faster than the DOM needs): the list,
// the ticker and the panels are refreshed at most every TICK_UI_MIN_MS, while
// the candle array itself keeps folding every tick so nothing is lost
let lastTickUiAt = 0;
const TICK_UI_MIN_MS = 400;

function refreshTickUi(force){
  if(!marketUiReady) return;
  const now = Date.now();
  if(!force && now - lastTickUiAt < TICK_UI_MIN_MS) return;
  lastTickUiAt = now;
  MARKET.forEach(m=>refreshMarketRow(m.sym));
  refreshTicker();
  // el índice compuesto del campo visual viaja en el mismo latido
  if(typeof renderMarketIndex === 'function') renderMarketIndex();
  if(typeof candles !== 'undefined' && candles.length){
    // with a live feed the server owns the candle series and each tick carries
    // its own OHLC value (applyLiveCandles); only the offline fallback builds
    // candles from the local price walk
    const feedLive = typeof MarketNet !== 'undefined' && MarketNet.live;
    if(!feedLive) pushLiveCandle();
    // coalesced: many ticks inside one frame cost a single repaint
    if(typeof scheduleDraw === 'function') scheduleDraw(); else drawChart();
  }
  // a position can liquidate on its own when the tape crosses its margin, and
  // every quote move marks the book again, so the redraw flag comes from there
  if(checkLiquidations()) settleDirty = true;
  if(typeof checkTpSl === 'function') checkTpSl();
  // las alertas de precio se comprueban contra la cinta en este mismo latido y
  // el panel reescribe el precio "ahora" de cada una
  if(typeof checkPriceAlerts === 'function') checkPriceAlerts();
  if(typeof renderPriceAlerts === 'function') renderPriceAlerts();
  // el libro de órdenes (profundidad de mercado) se repinta en el mismo latido
  // throttleado; él solo decide si algo cambió (símbolo o precio de cinta)
  if(typeof renderOrderBook === 'function') renderOrderBook();

  const active = bySym(activeSymbol);
  if(!active) return;
  const priceEl = document.getElementById('quotePrice');
  if(priceEl){
    const priceText = active.price.toFixed(2);
    if(priceEl.textContent !== priceText){
      priceEl.textContent = priceText;
      priceEl.classList.remove('pulse-up','pulse-down');
      void priceEl.offsetWidth;
      priceEl.classList.add(active.change>=0 ? 'pulse-up':'pulse-down');
    }
  }
  updateQuoteBlock();
  if(settleDirty){
    settleDirty = false;
    // the book is marked at the live tape, so this runs on every UI beat
    updatePerformancePanel();
    if(Object.keys(state.positions).length) renderPositions();
  }
}
// one step of the offline fallback, the only path that walks prices on the
// player's machine: with the realtime feed up the server owns the tape and this
// returns immediately
function tickMarket(){
  if(state.bankrupt) return;
  if(typeof MarketNet !== 'undefined' && MarketNet.live) return;
  walkMarketPrices();
  refreshTickUi();
}

// server tick: every connected player receives the same quotes
// every tick carries *numbers* and nothing else; the client owns the rendering.
// `price` is the settlement (what orders use) and `live` is the tape behind it.
function applyMarketQuotes(quotes){
  if(!Array.isArray(quotes)) return;
  let moved = false;
  quotes.forEach(q=>{
    const m = bySym(q.sym);
    if(!m) return;
    // el servidor manda dos precios: `price` es el *ajuste* (que sólo cambia
    // cada dos días de juego) y `live` es la cinta. lo que se opera y con lo que
    // se valora la cartera es la cinta, así que ése es el que vive en m.price;
    // el ajuste se guarda aparte para la línea discontinua de la gráfica y el
    // chip de cuenta atrás.
    const next = typeof q.live === 'number' && Number.isFinite(q.live) ? q.live : q.price;
    if(m.price !== next) moved = true;
    m.price = next;
    m.settle = q.price;
    m.change = typeof q.liveChange === 'number' ? q.liveChange : q.change;
    m.pct = typeof q.livePct === 'number' ? q.livePct : q.pct;
    if(typeof q.live === 'number') m.livePrice = q.live;
    m.open = q.open; m.prevClose = q.prevClose;
    m.high = q.high; m.low = q.low;
    m.settleAt = q.settleAt;
    m.nextSettleAt = q.nextSettleAt;
  });
  // posiciones y cartera se valoran a la cinta: se mueven en cada tick, así que
  // el panel se repinta con el mismo throttle que el resto de la UI
  if(moved) settleDirty = true;
  refreshTickUi();
}

function applyMarketNews(item){
  const news = normalizeNewsItem(item);
  if(!news || !news.sym) return;
  const m = bySym(news.sym);
  if(!m) return;
  // the snapshot already carries the recent headlines and a tick carries the new
  // ones; if the same headline arrives twice (snapshot + tick in the same frame)
  // it must not be pushed twice or toasted twice
  const newest = state.news[0];
  if(newest && newest.sym === news.sym && newest.title === news.title
    && Math.abs((newest.pct||0) - (news.pct||0)) < 0.001){
    return;
  }
  state.news.unshift(news);
  trimNews();
  const up = news.pct >= 0;
  toast(news.sym, `${m.name} · ${up?'alza':'caída'} estimada ${up?'+':''}${news.pct.toFixed(1)}%`, up?'up':'down');
  pushNotification(`📰 ${m.name}`, `${news.title} · ${up?'+':''}${news.pct.toFixed(1)}%`, up?'up':'down');
  // un movimiento grande merece el aviso central, no sólo una notificación
  if(Math.abs(news.pct || 0) >= BIG_NEWS_PCT && typeof showMarketAlert === 'function'){
    showMarketAlert({
      sym: m.sym,
      pct: news.pct,
      tone: up ? 'up' : 'down',
      kicker: 'Titular de mercado',
      title: news.title,
    });
  }
}

function renderTape(){
  const wrap = document.getElementById('tapeItems');
  if(!wrap) return;
  const items = typeof MarketNet !== 'undefined' ? MarketNet.tape.slice(0,12) : [];
  if(!items.length){
    wrap.innerHTML = '<span class="tape-empty">esperando operaciones...</span>';
    return;
  }
  wrap.innerHTML = items.map(t=>`
    <span class="tape-item ${t.side}"><b>${t.name}</b> ${t.side==='sell'?'vendió':'compró'} ${t.shares} ${t.sym} @ ${money(t.price)}</span>`).join('');
}

function applyMarketTape(trade){
  if(!trade) return;
  renderTape();
}
