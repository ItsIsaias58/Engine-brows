
// bar length is in GAME minutes: the market clock runs at 1440x, so one real
// minute is a whole game day. the 1W view is a single game week drawn with
// seven daily bars, which is why it is the shortest chart — but it is also the
// one that can be scrolled back through the company's whole stored history, so
// its zoom floor is a week instead of the intraday minimum.
// `maxBody` es lo mas ancha que puede ser el cuerpo de una vela: eso es lo que
// mantiene las velas delgadas por mucho zoom que se haga. `maxSlot` es lo mas
// separadas que pueden estar (cuerpo + aire) y define hasta donde se puede
// acercar: subirlo deja acercarse mas sin engordar las velas, que es lo que
// estabamos queriendo. `minVisible` es el suelo duro para pantallas chicas.
const TIMEFRAMES = {
  '5m':  { agg:5,    count:120, visible:120, minVisible:28, maxBody:10, maxSlot:26, volMult:1,   label:'5m'  },
  '15m': { agg:15,   count:96,  visible:48,  minVisible:22, maxBody:10, maxSlot:26, volMult:1.5, label:'15m' },
  '1h':  { agg:60,   count:84,  visible:84,  minVisible:16, maxBody:10, maxSlot:26, volMult:2.5, label:'1h'  },
  // 1W is the wide one on purpose: seven daily bars, drawn fat, and it can be
  // zoomed out to the company's whole stored life
  '1W':  { agg:1440, count:7,   visible:7,   minVisible:7,  maxBody:44, maxSlot:0,  volMult:8,   label:'1W'  },
};

// the zoom floor is measured in pixels, not in bars: thin candles everywhere
function zoomFloor(){
  const cfg = TIMEFRAMES[currentTF];
  const hard = Math.max(2, cfg && cfg.minVisible ? cfg.minVisible : ZOOM_MIN);
  const maxSlot = cfg ? cfg.maxSlot : 0;
  if(!maxSlot) return hard;
  const width = (canvas && canvas.clientWidth) || 900;
  return Math.max(hard, Math.ceil(width / maxSlot));
}

// 15m and 1h are built here, on the player's machine, from the 5m series it
// already has. the server only ever sends 5m bars (and the daily life of the
// company for 1W), so switching timeframe costs no request and cannot reset the
// chart.
function aggregateCandles(base, minutes){
  const size = minutes * 60000;
  const out = [];
  for(const candle of base){
    const bucket = Math.floor(candle.t / size) * size;
    const last = out[out.length-1];
    if(last && last.t === bucket){
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      continue;
    }
    out.push({ t:bucket, open:candle.open, close:candle.close, high:candle.high, low:candle.low });
  }
  return out;
}

// the series that actually travels over the wire for a view
function baseTimeframeFor(tf){
  return tf === '15m' || tf === '1h' ? '5m' : tf;
}
function aggregateFor(tf, base){
  const minutes = tf === '15m' ? 15 : tf === '1h' ? 60 : 0;
  return minutes ? aggregateCandles(base, minutes) : base;
}
let currentTF = '5m';
let candleAgg = 5;
let tickCount = 0;

// game time in ms; the server streams it and it keeps advancing between ticks
function currentGameTime(){
  if(typeof MarketNet !== 'undefined' && typeof MarketNet.gameTime === 'number'){
    return MarketNet.gameTime;
  }
  return Date.now();
}


let candles = [];
// timeframe length in ms, so live server candles land in the same bucket the
// chart is drawing
function timeframeMs(){
  const cfg = TIMEFRAMES[currentTF];
  return (cfg ? cfg.agg : 1) * 60000;
}

// fallback series, only used until the server has enough real candles (and to
// keep the chart alive while the market feed is unreachable)
// a synthetic series carries made up timestamps, so it must never become the
// anchor of the remembered window (see saveChartView)
let syntheticCandles = true;
function generateCandles(count = 180, volMult = 1){
  syntheticCandles = true;
  const m = bySym(activeSymbol);
  let price = m.price * 0.985;
  const tfMs = timeframeMs();
  const now = currentGameTime();
  candles = [];
  for(let i=0;i<count;i++){
    const drift = (Math.random()-0.48) * (m.price*m.vol*0.6*volMult);
    const open = price;
    const close = safePrice(open + drift, open);
    const high = Math.max(open,close) + Math.random()*(m.price*0.0022*volMult);
    const low  = safePrice(Math.min(open,close) - Math.random()*(m.price*0.0022*volMult), Math.min(open,close));
    candles.push({ t: now - (count-1-i)*tfMs, open, close, high, low });
    price = close;
  }
  candles[candles.length-1].close = m.price;
}

// real OHLC candles aggregated by the market service. a candle built from a
// single price per bar (the old behaviour) had open === close, so every bar was
// green and flat: these carry a genuine open/high/low/close per timeframe.
// a young server has only a handful of real candles: fill the space before
// them so the chart does not collapse into a few giant bars. the real candles
// always stay at the right edge, where the live ones are appended.
// the filler is drawn from a seeded generator instead of Math.random, so the
// same missing past is filled with the same bars every time the chart is
// repainted (switching companies used to reshuffle it)
function fillerRandom(seed){
  let state = (seed >>> 0) || 1;
  return ()=>{
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function prependFillerHistory(built, target){
  const missing = target - built.length;
  const m = bySym(activeSymbol);
  const first = built[0];
  if(missing <= 0 || !m || !first) return built;
  const rand = fillerRandom(first.t ^ (m.sym.charCodeAt(0) * 2654435761));

  // the filler copies the *real* bars' size, otherwise a wild synthetic range
  // (worse on 1h/1D) squashes the real candles into flat slivers
  let rangeSum = 0;
  for(const candle of built){
    rangeSum += (candle.high - candle.low) / Math.max(0.01, candle.close);
  }
  const avgRange = rangeSum / built.length;
  const step = Math.max(m.price * 0.0002, first.close * avgRange);
  const tfMs = timeframeMs();
  const anchor = first.open;
  const filler = [];
  let price = first.open;
  for(let i=missing;i>0;i--){
    // mean reversion keeps the synthetic past in a believable band around the
    // first real candle instead of drifting away
    const close = safePrice(price - (rand()-0.48)*step - (price-anchor)*0.05, price);
    const open = safePrice(close + (rand()-0.5)*step*0.5, close);
    filler.push({
      t: first.t - i*tfMs,
      open, close,
      high: Math.max(open,close) + rand()*step*0.4,
      low: safePrice(Math.min(open,close) - rand()*step*0.4, Math.min(open,close)),
    });
    price = open;
  }
  return filler.concat(built);
}

// the series currently on screen, so a delta merge knows it is painting the
// same window the player is already looking at
let paintedKey = null;
function currentSeriesKey(){
  return `${activeSymbol}|${currentTF}`;
}

// paints a candle series. `view` is where the player was looking
// ({ visibleCount, panOffset }) or null for the timeframe's default window.
// painting the series that is already on screen keeps the live window, so a
// delta merge never yanks a panned chart back to the present.
function paintHistorySeries(list, view){
  if(!Array.isArray(list) || !list.length) return false;
  const built = list
    .filter(c=> c && typeof c.close==='number' && typeof c.t==='number')
    .sort((a,b)=> a.t - b.t)
    .map(c=>({
      t:c.t,
      open: typeof c.open==='number' ? c.open : c.close,
      close:c.close,
      high:Math.max(c.high, c.open, c.close),
      low:Math.min(c.low, c.open, c.close),
    }));
  if(!built.length) return false;

  const m = bySym(activeSymbol);
  if(m){
    const live = livePrice(m);
    const last = built[built.length-1];
    last.close = live;
    last.high = Math.max(last.high, live);
    last.low = Math.min(last.low, live);
  }

  const key = currentSeriesKey();
  // a synthetic (locally generated) series has made up timestamps: it can never
  // anchor the window. only a real series may carry the position over.
  const hadRealSeries = !syntheticCandles;
  const sameSeries = paintedKey === key && hadRealSeries;
  // the time the player is looking at right now, before the series is replaced:
  // the copy keeps growing at the tail (live bars and delta merges), and the
  // window has to stay on the same stretch of time instead of sliding with it
  const previousStart = hadRealSeries && candles.length ? currentVisibleStart() : 0;
  const previousFrom = hadRealSeries && candles[previousStart] ? candles[previousStart].t : null;
  syntheticCandles = false;

  const cfg = TIMEFRAMES[currentTF];
  const target = Math.max(2, cfg ? cfg.visible : 120);
  candles = built.length < target ? prependFillerHistory(built, target) : built;
  tickCount = 0;

  if(sameSeries){
    // the same series grew: hold on to the stretch that was on screen. a chart
    // that was following the live candle keeps following it (the local copy may
    // sit a few bars behind the live edge between merges)
    visibleCount = Math.min(candles.length, Math.max(zoomFloor(), visibleCount));
    if(chartIsLive()){
      panOffset = 0;
    } else if(typeof previousFrom === 'number'){
      clampPan(candles.length - visibleCount - indexAtOrAfter(candles, previousFrom));
    } else {
      clampPan(panOffset);
    }
  } else if(applySavedView(view)){
    // coming back to this company/timeframe: reopen the window that was left
  } else {
    panOffset = 0;
    visibleCount = Math.min(candles.length, Math.max(zoomFloor(), cfg ? cfg.visible : visibleCount));
  }
  paintedKey = key;
  animateChartIn();
  return true;
}

// kept for a server answer with no local cache behind it
function applyServerCandles(list){
  return paintHistorySeries(list, null);
}

// the player's position in the chart is remembered per company and timeframe, so
// leaving and coming back reopens the same window instead of the live edge. it is
// anchored on the *time* of the first visible bar, not on the distance to the
// newest one: the series keeps growing while the player is away, and anchoring on
// the distance would slide the window forward with it.
function indexAtOrAfter(list, t){
  if(!list.length) return 0;
  let low = 0, high = list.length - 1, result = list.length - 1;
  while(low <= high){
    const mid = (low + high) >> 1;
    if(list[mid].t >= t){ result = mid; high = mid - 1; }
    else low = mid + 1;
  }
  return result;
}

function saveChartView(){
  if(typeof HistoryCache === 'undefined' || !activeSymbol) return;
  const start = currentVisibleStart();
  const first = candles[start];
  HistoryCache.setView(activeSymbol, currentTF, {
    visibleCount,
    panOffset,
    // a chart that was following the live candle wants to keep following it, not
    // to freeze on the bar that happened to be on the left edge
    live: chartIsLive(),
    // only a real series has a meaningful time anchor
    from: !syntheticCandles && first ? first.t : null,
  });
}
function applySavedView(view){
  if(!view || !view.visibleCount) return false;
  visibleCount = Math.max(zoomFloor(), Math.min(candles.length || view.visibleCount, Math.round(view.visibleCount)));
  if(view.live){
    // the player was watching the present: come back to it
    panOffset = 0;
    return true;
  }
  if(typeof view.from === 'number' && candles.length){
    // the same stretch of the chart, wherever it sits now
    clampPan(candles.length - visibleCount - indexAtOrAfter(candles, view.from));
  } else {
    clampPan(view.panOffset || 0);
  }
  return true;
}
// live candle of the active symbol, straight from the tick broadcast, folded
// into the timeframe bucket the chart is showing
function applyLiveCandles(list){
  if(!Array.isArray(list) || !candles.length) return;
  const m = bySym(activeSymbol);
  if(!m) return;
  const tfMs = timeframeMs();
  const last = candles[candles.length-1];

  for(const entry of list){
    if(!entry || entry.sym !== activeSymbol) continue;
    const live = livePrice(m);
    if(typeof last.t !== 'number'){
      // generated fallback series: just follow the price
      last.high = Math.max(last.high, live);
      last.low = Math.min(last.low, live);
      last.close = live;
      break;
    }
    const bucket = Math.floor(entry.t / tfMs) * tfMs;
    if(bucket < last.t) break;
    if(bucket === last.t){
      last.high = Math.max(last.high, entry.h, live);
      last.low = Math.min(last.low, entry.l, live);
      last.close = live;
      break;
    }
    candles.push({
      t: bucket,
      open: last.close,
      close: live,
      high: Math.max(entry.h, last.close, live),
      low: Math.min(entry.l, last.close, live),
    });
    if(candles.length > MAX_CANDLES) candles.shift();
    // a bar was appended: shifting by one keeps a panned window on the same
    // candles instead of dragging it forward with the live edge
    if(!chartIsLive()) panOffset += 1;
    tickCount = 0;
    // the active symbol is handled: leave the loop instead of the function, so
    // any other entry in the same payload is still walked over
    break;
  }
}

// offline fallback: builds candles from the local price walk
function pushLiveCandle(){
  const m = bySym(activeSymbol);
  const price = livePrice(m);
  if(tickCount % candleAgg === 0){
    const last = candles[candles.length-1];
    const bucket = Math.floor(currentGameTime() / timeframeMs()) * timeframeMs();
    candles.push({ t:bucket, open:last.close, close:price, high:Math.max(last.close,price), low:Math.min(last.close,price) });
    if(candles.length > MAX_CANDLES) candles.shift();
    if(!chartIsLive()) panOffset += 1;
  } else {
    const cur = candles[candles.length-1];
    cur.high = Math.max(cur.high, price);
    cur.low = Math.min(cur.low, price);
    cur.close = price;
  }
  tickCount++;
}


function switchTimeframe(tf){
  const cfg = TIMEFRAMES[tf];
  if(!cfg || tf===currentTF){
    if(cfg) highlightTimeframeButton(tf);
    return;
  }
  // remember where the player was looking in the timeframe they are leaving
  saveChartView();
  currentTF = tf;
  candleAgg = cfg.agg;
  tickCount = 0;
  highlightTimeframeButton(tf);

  // the 5m series of this company is most likely already on this machine: 15m and
  // 1h are aggregated here from it (no request, no wait) and 5m/1W paint straight
  // from their own stored window. either way the window that was left is reopened.
  const baseTf = baseTimeframeFor(tf);
  const cached = typeof HistoryCache !== 'undefined' ? HistoryCache.peek(activeSymbol, baseTf) : null;
  if(cached && cached.length){
    paintHistorySeries(aggregateFor(tf, cached), HistoryCache.peekView(activeSymbol, tf));
  } else {
    generateCandles(cfg.count, cfg.volMult);
    visibleCount = cfg.visible;
    panOffset = 0;
    paintedKey = currentSeriesKey();
    animateChartIn();
  }
  seedChartFromServer();
}
function highlightTimeframeButton(tf){
  document.querySelectorAll('.tool-btn[data-tf]').forEach(b=>{
    b.classList.toggle('is-active', b.dataset.tf===tf);
  });
}


// costura de verificacion: deja ver la serie diaria y la escala que de verdad se
// pinto, para poder comprobarlo desde una prueba automatizada (igual que la
// pantalla de carga expone window.Boot). Solo lee; no cambia nada del juego.
window.ChartDebug = {
  life: () => dailySeriesFor(activeSymbol).map((point) => point.close),
  lifeTf: () => dailySeriesKey,
  closes: () => candles.map((candle) => ({ t: candle.t, c: candle.close })),
  visibleCount: () => visibleCount,
  panOffset: () => panOffset,
  scale: () => chartScale,
  timeframe: () => currentTF,
  symbol: () => activeSymbol,
};

const canvas = document.getElementById('chartCanvas');
const ctx = canvas.getContext('2d');
let visibleCount = 160;
// how many bars are hidden to the right of the window: 0 keeps the chart pinned
// to the newest candle, anything else means the player panned back in time
let panOffset = 0;
let drawProgress = 0;

// El canvas vive con width/height:100% en CSS, asi que su tamano visual lo pone
// el layout y aqui solo ajustamos el buffer de pixeles (x devicePixelRatio).
//
// Se comprueba en CADA pintado, no solo en el evento resize: el devicePixelRatio
// cambia al mover la ventana a otra pantalla o al hacer zoom en el navegador, y
// algunos de esos cambios no disparan un resize. Cuando el buffer se quedaba
// desfasado del tamano real, la grafica se pintaba a medias (velas cortadas o
// aplastadas) hasta que algo forzaba un repintado. Ahora se corrige solo.
function syncCanvasSize(){
  if(!canvas) return false;
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.round(canvas.clientWidth);
  const cssH = Math.round(canvas.clientHeight);
  if(!cssW || !cssH) return false;
  const wantW = Math.max(1, Math.round(cssW * dpr));
  const wantH = Math.max(1, Math.round(cssH * dpr));
  if(canvas.width !== wantW || canvas.height !== wantH){
    // escribir width/height reinicia el contexto: hay que rehacer el transform
    canvas.width = wantW;
    canvas.height = wantH;
    ctx.setTransform(dpr,0,0,dpr,0,0);
  } else if(canvas.dataset.dpr !== String(dpr)){
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  canvas.dataset.dpr = String(dpr);
  return true;
}

function resizeCanvas(){
  syncCanvasSize();
}

// the chart holds the whole rolling window the player's copy keeps (twenty game
// days of 5m bars) so scrolling back keeps working; the local history store does
// the actual sliding, day by day
const MAX_CANDLES = 5760;

function currentVisibleStart(){
  return Math.max(0, candles.length - visibleCount - panOffset);
}

// widest pan allowed: fully scrolled back to the oldest stored candle
function maxPan(){
  return Math.max(0, candles.length - visibleCount);
}
function clampPan(bars){
  panOffset = Math.max(0, Math.min(maxPan(), Math.round(bars)));
  return panOffset;
}
// the chart follows the live candle unless the player panned away
function chartIsLive(){
  return panOffset <= 0;
}
// back to the newest candle (double click, the “En vivo” button, a new symbol)
function goLive(){
  panOffset = 0;
  animateChartIn();
}
function resetChartView(){
  panOffset = 0;
}
// pane slots: same divisor the drawing code uses for the bar width
function slotCount(){
  return Math.max(1, Math.min(visibleCount, candles.length || 1));
}
function slotWidth(){
  return canvas.clientWidth / slotCount();
}

// layout: candles on top, a close-price line under them and the time axis at
// the very bottom, so every timeframe reads differently at a glance
function computeLayout(H){
  const axisH = 18;
  const gap = 10;
  const lineH = Math.max(36, Math.round(H * 0.22));
  const candleH = Math.max(60, H - axisH - gap - lineH);
  return { candleH, gap, lineH, axisH };
}

// Una empresa hundida cotiza en 0.0087: con dos decimales fijos el eje entero se
// vuelve una columna de $0.00 y el precio deja de leerse. Los decimales se
// adaptan al tamano del numero.
function priceLabel(v){
  const abs = Math.abs(v);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return '$' + v.toFixed(digits);
}

function formatCandleTime(t, tf){
  if(typeof t !== 'number') return '';
  const date = new Date(t);
  if(tf === '1W'){
    return `${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}`;
  }
  const hh = String(date.getHours()).padStart(2,'0');
  const mm = String(date.getMinutes()).padStart(2,'0');
  if(tf === '1h'){
    const dd = String(date.getDate()).padStart(2,'0');
    const mo = String(date.getMonth()+1).padStart(2,'0');
    return `${dd}/${mo} ${hh}:00`;
  }
  return `${hh}:${mm}`;
}

// game day of a bar, used to stamp the date whenever the axis crosses midnight
function gameDayKey(t){
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayStamp(t){
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
}

// scale of the last painted candle pane, reused by the crosshair so the value
// it shows matches the pixels
let chartScale = null;

function priceAtY(y){
  if(!chartScale) return null;
  const { min, max, padY, paneH } = chartScale;
  const range = (max - min) || 1;
  const usable = Math.max(1, paneH - padY*2);
  return min + (1 - (y - padY) / usable) * range;
}

// paints are coalesced into one animation frame: a tick, a zoom and a resize
// that land together cost a single repaint instead of three. the same handle is
// used by the grow-in animation, so calling animateChartIn() while a frame is
// still queued (a company switch, a timeframe change) can never start a second
// rAF chain that would advance the animation twice as fast.
let chartRafId = 0;
function scheduleDraw(){
  if(chartRafId) return;
  if(typeof requestAnimationFrame !== 'function'){ drawChart(); return; }
  chartRafId = requestAnimationFrame(()=>{ chartRafId = 0; drawChart(); });
}

function drawChart(){
  // si el buffer no coincide con el tamano real, se reajusta antes de pintar
  if(!syncCanvasSize()) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if(!W || !H) return;
  ctx.clearRect(0,0,W,H);

  const start = currentVisibleStart();
  const slice = candles.slice(start, start+visibleCount);
  if(!slice.length) return;

  const layout = computeLayout(H);
  const padY = 20;
  const paneH = layout.candleH;
  const usable = Math.max(1, paneH - padY*2);

  // the entry line of an old position must never stretch the scale: it is
  // clamped to the pane edge instead of squashing the candles flat
  const position = state.positions[activeSymbol];
  const entry = position && position.shares > 0 ? position.avgPrice : null;

  let min = Math.min.apply(null, slice.map(c=>c.low));
  let max = Math.max.apply(null, slice.map(c=>c.high));
  if(!(max > min)){
    const mid = max || 1;
    min = mid * 0.995;
    max = mid * 1.005;
  }
  const padding = (max - min) * 0.08;
  min -= padding;
  max += padding;
  // un precio no puede ser negativo y el eje tampoco: con una empresa hundida
  // (0.0005) el aire de abajo se comia el cero y el eje rotulaba negativos
  if(min < 0) min = 0;
  const range = (max - min) || 1;
  const yFor = v => padY + (1 - (v-min)/range) * usable;
  chartScale = { min, max, padY, paneH };

  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left';

  // price grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  for(let i=0;i<=4;i++){
    const v = min + (range/4)*i;
    const y = yFor(v);
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    ctx.fillText(priceLabel(v), W-58, y-4);
  }

  const visibleN = Math.max(1, Math.floor(slice.length * drawProgress));
  const cw = W / Math.max(1, Math.min(visibleCount, slice.length));
  // the gap between candles is capped in pixels instead of capping the body:
  // when a slot grows with the zoom the extra room goes into the body, so the
  // bars stay together at every zoom level (a fixed body cap left them floating
  // in huge gaps on 5m/15m/1h). the ceiling keeps one lonely candle from
  // swallowing the pane.
  // thin and packed: the body never goes past `maxBody` and the air around it is
  // never more than a few pixels, so zooming in shows fewer, slimmer candles
  // instead of making them fatter
  const cfgBars = TIMEFRAMES[currentTF] || {};
  const gapPx = Math.max(1, Math.min(cw*0.26, 4.5));
  const ceiling = cfgBars.maxBody || Math.max(12, W*0.14);
  const bodyW = Math.max(2, Math.min(cw - gapPx, ceiling));
  const wickW = Math.max(1, Math.min(6, bodyW*0.12));

  for(let i=0;i<visibleN;i++){
    const c = slice[i];
    const x = i*cw + cw/2;
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? '#29E0A8' : '#FF5C7A';
    ctx.fillStyle = up ? '#29E0A8' : '#FF5C7A';
    ctx.lineWidth = wickW;
    ctx.beginPath(); ctx.moveTo(x, yFor(c.high)); ctx.lineTo(x, yFor(c.low)); ctx.stroke();
    ctx.lineWidth = 1;
    const yO = yFor(c.open), yC = yFor(c.close);
    const top = Math.min(yO,yC);
    const h = Math.max(1.5, Math.abs(yC-yO));
    ctx.fillRect(x-bodyW/2, top, bodyW, h);
  }

  // marcadores de eventos: banderitas sobre las velas donde cayó una noticia
  // de este símbolo (verde alza, roja caída). se dibujan aparte para no
  // competir con el color de las velas.
  if(typeof chartEventMarkers === 'function'){
    const markers = chartEventMarkers(activeSymbol);
    if(markers.length){
      const tFirst = slice[0].t, tLast = slice[slice.length-1].t;
      ctx.font = '9px "IBM Plex Mono", monospace';
      for(const mark of markers){
        if(mark.t < tFirst || mark.t > tLast) continue;
        // la vela más cercana al momento de la noticia
        let best = 0, bestD = Infinity;
        for(let i=0;i<slice.length;i++){
          const d = Math.abs(slice[i].t - mark.t);
          if(d < bestD){ bestD = d; best = i; }
        }
        if(best >= visibleN) continue;
        const x = best*cw + cw/2;
        const c = slice[best];
        const y = Math.max(10, yFor(c.high) - 12);
        const color = mark.pct >= 0 ? '#29E0A8' : '#FF5C7A';
        // la bandera: asta + triángulo
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y + 12); ctx.lineTo(x, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 7, y + 2.5); ctx.lineTo(x, y + 5); ctx.closePath(); ctx.fill();
      }
      ctx.font = '11px "IBM Plex Mono", monospace';
    }
  }

  const last = slice[Math.min(visibleN-1, slice.length-1)];
  if(last){
    const y = yFor(last.close);
    ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    ctx.setLineDash([]);
  }

  // the settlement price: what an order actually executes at, frozen until the
  // next window while the candles keep climbing and falling around it
  // the settlement price: the reference that only moves every couple of game
  // days. the candles (and the quote the game trades at) are the live tape, so
  // this line shows how far the tape has drifted from the last settlement
  const active = bySym(activeSymbol);
  const settle = active ? (Number.isFinite(active.settle) ? active.settle : active.price) : 0;
  if(settle > 0){
    const y = Math.max(2, Math.min(paneH-2, yFor(settle)));
    ctx.setLineDash([2,3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'right';
    const arrow = settle > max ? ' ↓' : settle < min ? ' ↑' : '';
    ctx.fillText(`Ajuste ${priceLabel(settle)}${arrow}`, W-64, Math.max(12, Math.min(paneH-4, y-5)));
    ctx.textAlign = 'left';
  }

  if(entry!=null){
    const inside = entry >= min && entry <= max;
    const y = Math.max(2, Math.min(paneH-2, yFor(entry)));
    const winning = (last && last.close >= entry);
    ctx.setLineDash([6,4]);
    ctx.strokeStyle = winning ? 'rgba(41,224,168,0.55)' : 'rgba(255,92,122,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.fillStyle = winning ? '#29E0A8' : '#FF5C7A';
    const arrow = inside ? '' : (entry > max ? ' ↑' : ' ↓');
    ctx.fillText(`Entrada ${priceLabel(entry)}${arrow}`, 8, Math.max(14, y-6));
  }

  // órdenes en espera de este símbolo: una línea cada una, punteada larga para
  // las limit (esperan un mejor precio) y corta para las stop (persiguen el
  // precio). fuera de rango se marca con flecha en vez de desaparecer.
  if(typeof state !== 'undefined' && Array.isArray(state.orders)){
    let slot = 0;
    for(const order of state.orders){
      if(order.sym !== activeSymbol) continue;
      const isBuy = order.side === 'buy';
      const y = Math.max(2, Math.min(paneH-2, yFor(order.price)));
      const inside = order.price >= min && order.price <= max;
      ctx.setLineDash(order.kind === 'limit' ? [8,5] : [3,4]);
      ctx.strokeStyle = isBuy ? 'rgba(41,224,168,0.65)' : 'rgba(255,92,122,0.65)';
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.fillStyle = isBuy ? '#29E0A8' : '#FF5C7A';
      const arrow = inside ? '' : (order.price > max ? ' ↑' : ' ↓');
      ctx.fillText(`${order.kind==='limit'?'LMT':'STP'} ${order.side==='buy'?'C':'V'} ${order.shares} ${priceLabel(order.price)}${arrow}`, 8, Math.max(26 + slot*13, Math.min(paneH-4, y + (isBuy ? 13 : -6))));
      slot += 1;
    }
  }

  // ---- la vida de la empresa (panel de abajo) -------------------------------
  // Antes este panel repetia el cierre de las velas que ya estan arriba: lo
  // mismo dos veces. Ahora pinta la serie DIARIA completa — desde que la empresa
  // existe hasta hoy — y marca encima la franja que las velas estan mostrando,
  // asi se ve el proceso largo (como subio y como cayo) y donde estas parado
  // dentro de el. El zoom de arriba no lo mueve: es el mapa, no el detalle.
  const lineTop = paneH + layout.gap;
  const lineH = layout.lineH;
  const lineAxisY = lineTop + lineH;

  const life = dailySeriesFor(activeSymbol);
  const lifeMode = life.length > 1;
  const closes = lifeMode ? life.map(p=>p.close) : slice.map(c=>c.close);
  let lMin = Math.min.apply(null, closes);
  let lMax = Math.max.apply(null, closes);
  if(!(lMax > lMin)){
    const mid = lMax || 1;
    lMin = mid * 0.999;
    lMax = mid * 1.001;
  }
  const lPad = (lMax - lMin) * 0.18;
  lMin -= lPad;
  lMax += lPad;
  if(lMin < 0) lMin = 0;
  const lRange = (lMax - lMin) || 1;
  const lyFor = v => lineTop + (1 - (v-lMin)/lRange) * (lineH - 12) + 6;

  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.beginPath(); ctx.moveTo(0,lineTop-0.5); ctx.lineTo(W,lineTop-0.5); ctx.stroke();

  // con la serie diaria el eje X del panel es la vida entera; sin ella (todavia
  // no llego, o el modo es local) se cae al detalle de las velas
  const xFor = lifeMode
    ? (i => (i / (closes.length - 1)) * W)
    : (i => i*cw + cw/2);
  const lastIdx = Math.max(0, lifeMode ? closes.length - 1 : visibleN - 1);
  const firstIdx = 0;
  const lineUp = closes[lastIdx] >= closes[firstIdx];
  const lastX = xFor(lastIdx);
  const firstX = xFor(firstIdx);

  // la franja que las velas estan mostrando, dentro de toda la vida
  if(lifeMode){
    const from = lifeXFor(life, slice[0].t, W);
    const to = lifeXFor(life, slice[slice.length-1].t, W);
    const bandFrom = Math.max(0, Math.min(from, to));
    const bandTo = Math.min(W, Math.max(from, to));
    if(bandTo > bandFrom){
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(bandFrom, lineTop, Math.max(1, bandTo - bandFrom), lineH);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath();
      ctx.moveTo(bandFrom + 0.5, lineTop); ctx.lineTo(bandFrom + 0.5, lineTop + lineH);
      ctx.moveTo(bandTo - 0.5, lineTop); ctx.lineTo(bandTo - 0.5, lineTop + lineH);
      ctx.stroke();
    }
  }

  const lineTopY = lyFor(closes[lastIdx]);
  const gradient = ctx.createLinearGradient(0, lineTopY, 0, lineAxisY);
  gradient.addColorStop(0, lineUp ? 'rgba(41,224,168,0.28)' : 'rgba(255,92,122,0.28)');
  gradient.addColorStop(1, 'rgba(41,224,168,0)');

  ctx.beginPath();
  for(let i=0;i<=lastIdx;i++){
    const y = lyFor(closes[i]);
    if(i === 0) ctx.moveTo(xFor(i),y); else ctx.lineTo(xFor(i),y);
  }
  ctx.lineTo(lastX, lineAxisY);
  ctx.lineTo(firstX, lineAxisY);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  for(let i=0;i<=lastIdx;i++){
    const y = lyFor(closes[i]);
    if(i === 0) ctx.moveTo(xFor(i),y); else ctx.lineTo(xFor(i),y);
  }
  ctx.strokeStyle = lineUp ? '#29E0A8' : '#FF5C7A';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineWidth = 1;

  if(closes.length){
    ctx.beginPath();
    ctx.arc(lastX, lyFor(closes[lastIdx]), 2.6, 0, Math.PI*2);
    ctx.fillStyle = lineUp ? '#29E0A8' : '#FF5C7A';
    ctx.fill();
  }

  // que dice este panel: la vida entera y su rango de precios
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.36)';
  ctx.textAlign = 'left';
  const lifeLabel = lifeMode
    ? `VIDA · ${closes.length} días · ${priceLabel(lMin)} → ${priceLabel(lMax)}`
    : 'TRAMO VISIBLE';
  ctx.fillText(lifeLabel, 6, lineTop + 11);
  ctx.font = '11px "IBM Plex Mono", monospace';

  // ---- time axis -----------------------------------------------------------
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.textAlign = 'center';
  const labelCount = Math.max(2, Math.min(6, Math.floor(W/110)));
  // a 5m/15m window can run across midnight: without the date the wrapped
  // `hh:mm` labels look like the axis goes backwards. the first label is
  // stamped too when the visible span covers more than one game day.
  const spansDays = gameDayKey(slice[0].t) !== gameDayKey(slice[slice.length-1].t);
  let previousT;
  for(let i=0;i<labelCount;i++){
    const idx = labelCount === 1 ? 0 : Math.round(i*(visibleN-1)/(labelCount-1));
    const c = slice[idx];
    if(!c) continue;
    let text = formatCandleTime(c.t, currentTF);
    if(!text) continue;
    if(currentTF !== '1W' && currentTF !== '1h'){
      const dayChanged = previousT === undefined ? spansDays : gameDayKey(c.t) !== gameDayKey(previousT);
      if(dayChanged) text = `${dayStamp(c.t)} ${text}`;
    }
    previousT = c.t;
    const x = idx*cw + cw/2;
    ctx.fillText(text, Math.max(28, Math.min(W-28, x)), lineAxisY + 13);
  }
  ctx.textAlign = 'left';

  if(drawProgress < 1){
    drawProgress = Math.min(1, drawProgress + 0.08);
    // one chain only: scheduleDraw() ignores the call while a frame is queued
    scheduleDraw();
  }
  updateScrubLabel();
}
function animateChartIn(){
  drawProgress = 0;
  if(typeof requestAnimationFrame !== 'function'){ drawChart(); return; }
  scheduleDraw();
}

canvas.addEventListener('mousemove', (e)=>{
  if(panDrag) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const label = document.getElementById('crosshairLabel');
  const start = currentVisibleStart();
  const slice = candles.slice(start, start+visibleCount);
  if(!slice.length || !chartScale) return;
  if(y > chartScale.paneH){
    label.style.opacity = 0;
    return;
  }
  const value = priceAtY(y);
  if(value == null) return;
  const idx = Math.max(0, Math.min(slice.length-1, Math.floor((x / canvas.clientWidth) * Math.min(visibleCount, slice.length))));
  const time = slice[idx] ? formatCandleTime(slice[idx].t, currentTF) : '';
  label.style.opacity = 1;
  label.style.left = Math.min(x, canvas.clientWidth-60) + 'px';
  label.style.top = y + 'px';
  label.textContent = time ? `${priceLabel(value)} · ${time}` : priceLabel(value);
});
canvas.addEventListener('mouseleave', ()=>{ document.getElementById('crosshairLabel').style.opacity = 0; });


const ZOOM_MIN = 12;
// zooming keeps the middle of the visible window in place, so the chart grows or
// shrinks towards both sides instead of sliding towards the newest candle. when
// the chart is following the live candle it stays live: zooming must never push
// the current price off the screen.
function setVisibleCount(n, anchorRatio = 0.5){
  const previous = visibleCount;
  const wasLive = chartIsLive();
  // the zoom floor never goes past the data: a seven-bar 1W view stays at seven
  visibleCount = Math.min(candles.length, Math.max(zoomFloor(), Math.round(n)));
  if(!wasLive) panOffset += (previous - visibleCount) * (1 - anchorRatio);
  clampPan(panOffset);
  animateChartIn();
}
function panBy(bars){
  clampPan(panOffset + bars);
  animateChartIn();
}
document.getElementById('zoomIn').addEventListener('click', ()=>{
  setVisibleCount(visibleCount - Math.max(6, Math.round(visibleCount*0.18)));
});
document.getElementById('zoomOut').addEventListener('click', ()=>{
  setVisibleCount(visibleCount + Math.max(6, Math.round(visibleCount*0.18)));
});
const liveBtn = document.getElementById('scrubLive');
if(liveBtn) liveBtn.addEventListener('click', goLive);


// unspent wheel delta carried over between events, so a trackpad (many tiny
// deltas) adds up to the same gentle step as a single mouse notch instead of
// every little event rounding up to a whole bar and racing through history
const WHEEL_NOTCH = 100;
let wheelZoom = 0;
canvas.addEventListener('wheel', (e)=>{
  e.preventDefault();
  // shift (or a trackpad sideways swipe) scrolls through time, plain wheel zooms
  if(e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)){
    const step = Math.max(3, Math.round(visibleCount*0.12));
    panBy((e.deltaY || e.deltaX) > 0 ? -step : step);
    return;
  }
  // soft zoom: a single mouse notch (100 deltaY) changes the window by about
  // 6%, and the leftover delta of each event is kept for the next one, so the
  // approach is gradual with a trackpad too. a gesture never jumps more than
  // three notches at once.
  wheelZoom = Math.max(-3*WHEEL_NOTCH, Math.min(3*WHEEL_NOTCH, wheelZoom - e.deltaY));
  const raw = wheelZoom / WHEEL_NOTCH;
  const notches = Math.trunc(raw + (raw < 0 ? -1e-9 : 1e-9));
  if(notches === 0) return;
  wheelZoom -= notches * WHEEL_NOTCH;
  setVisibleCount(visibleCount / Math.pow(1.06, notches));
}, { passive:false });

// drag the chart sideways to walk through the stored candles. the drag shares
// the pane with the crosshair, so the crosshair stays quiet while panning.
let panDrag = null;
function endPanDrag(){
  if(!panDrag) return;
  panDrag = null;
  canvas.parentElement.classList.remove('is-panning');
}
canvas.addEventListener('pointerdown', (e)=>{
  if(e.pointerType === 'mouse' && e.button !== 0) return;
  panDrag = { id:e.pointerId, x:e.clientX, start:panOffset };
  if(canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e)=>{
  if(!panDrag || e.pointerId !== panDrag.id) return;
  const dx = e.clientX - panDrag.x;
  if(!maxPan() && Math.abs(dx) < 4) return;
  canvas.parentElement.classList.add('is-panning');
  document.getElementById('crosshairLabel').style.opacity = 0;
  panBy(panDrag.start + dx / Math.max(1, slotWidth()));
});
canvas.addEventListener('pointerup', endPanDrag);
canvas.addEventListener('pointercancel', endPanDrag);
canvas.addEventListener('pointerleave', endPanDrag);
canvas.addEventListener('dblclick', goLive);

// the scrubber is a real scrollbar: drag it (or tap anywhere on the track) to
// move the visible window through the stored history
const scrubTrack = document.getElementById('scrubTrack');
let scrubDrag = null;
function panFromPointer(e){
  const rect = scrubTrack.getBoundingClientRect();
  if(!rect.width || !candles.length) return;
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left)/rect.width));
  const start = ratio*candles.length - visibleCount/2;
  clampPan(candles.length - visibleCount - start);
  animateChartIn();
}
if(scrubTrack){
  scrubTrack.addEventListener('pointerdown', (e)=>{
    scrubDrag = e.pointerId;
    if(scrubTrack.setPointerCapture) scrubTrack.setPointerCapture(e.pointerId);
    panFromPointer(e);
  });
  scrubTrack.addEventListener('pointermove', (e)=>{
    if(scrubDrag === e.pointerId) panFromPointer(e);
  });
  const stopScrub = ()=> { scrubDrag = null; };
  scrubTrack.addEventListener('pointerup', stopScrub);
  scrubTrack.addEventListener('pointercancel', stopScrub);
}

function updateScrubLabel(){
  const start = currentVisibleStart();
  const end = Math.min(candles.length, start+visibleCount);
  document.getElementById('scrubCount').textContent =
    `Velas ${start+1}–${end} de ${candles.length}${chartIsLive() ? '' : ' · historial'}`;
  const pctStart = (start/candles.length)*100;
  const pctW = (visibleCount/candles.length)*100;
  document.getElementById('scrubFill').style.left = pctStart+'%';
  document.getElementById('scrubFill').style.width = pctW+'%';
  const btn = document.getElementById('scrubLive');
  if(btn) btn.hidden = chartIsLive();
  canvas.parentElement.classList.toggle('is-panning', Boolean(panDrag));
}
window.addEventListener('resize', ()=>{ resizeCanvas(); drawChart(); });

// the trading view can start hidden (the saved view is restored before the
// chart boots) and the chart panel can be collapsed, which leaves the canvas
// at 0x0: redraw whenever the container gets a real size again.
function refreshChartLayout(){
  const wrap = canvas.parentElement;
  if(!wrap || !wrap.clientWidth || !wrap.clientHeight) return;
  resizeCanvas();
  drawChart();
}

let chartResizeObserver = null;
function observeChartLayout(){
  if(typeof ResizeObserver === 'undefined' || chartResizeObserver) return;
  const wrap = canvas.parentElement;
  if(!wrap) return;
  chartResizeObserver = new ResizeObserver(()=> refreshChartLayout());
  chartResizeObserver.observe(wrap);
}


function initChart(){
  candleAgg = (TIMEFRAMES[currentTF] || TIMEFRAMES['5m']).agg;
  generateCandles(TIMEFRAMES[currentTF].count, TIMEFRAMES[currentTF].volMult);
  visibleCount = TIMEFRAMES[currentTF].visible;
  resizeCanvas();
  animateChartIn();

  document.querySelectorAll('.tool-btn[data-tf]').forEach(btn=>{
    btn.addEventListener('click', ()=> switchTimeframe(btn.dataset.tf));
  });

  observeChartLayout();
  refreshChartLayout();
  seedChartFromServer();
}

function seedChartFromServer(){
  if(typeof MarketNet === 'undefined' || !MarketNet.socketReady) return;
  MarketNet.seedCandles(currentTF);
  // la serie diaria del panel de abajo se instala aparte: una vez por empresa y
  // luego solo cuando cambia el dia de juego
  if(typeof MarketNet.seedDailySeries === 'function') MarketNet.seedDailySeries();
}

// ---- la vida de la empresa (panel de abajo) --------------------------------
// Un punto por dia de juego, desde que la empresa existe. Es una serie aparte de
// las velas: no la mueve el zoom, no la mueve el timeframe y solo cambia cuando
// cambia el dia, que es exactamente lo que se quiere ver ahi abajo (el camino
// largo), mientras las velas de arriba cuentan el detalle del momento.
let dailySeries = [];
let dailySeriesKey = null;

function setDailySeries(symbol, list){
  if(!Array.isArray(list) || !list.length){ dailySeries = []; dailySeriesKey = null; return; }
  const norm = [];
  for(const item of list){
    if(!item) continue;
    const t = Number(item.t);
    const close = Number(typeof item.close === 'number' ? item.close : item.c);
    if(!Number.isFinite(t) || !Number.isFinite(close) || close <= 0) continue;
    norm.push({ t, close });
  }
  if(!norm.length){ dailySeries = []; dailySeriesKey = null; return; }
  norm.sort((a,b)=> a.t - b.t);
  dailySeries = norm;
  dailySeriesKey = symbol;
  scheduleDraw();
}

function dailySeriesFor(symbol){
  if(!dailySeries.length || dailySeriesKey !== symbol) return [];
  const out = dailySeries.map(p=>({ t:p.t, close:p.close }));
  // la punta sigue a la cinta, para que el ultimo dia no se quede atras
  const m = bySym(symbol);
  if(m){
    const live = livePrice(m);
    if(live > 0) out[out.length-1].close = live;
  }
  return out;
}

// posicion horizontal de una marca de tiempo sobre la linea diaria, interpolando
// entre los dos dias que la rodean
function lifeXFor(list, t, width){
  const n = list.length;
  if(n < 2) return 0;
  if(t <= list[0].t) return 0;
  if(t >= list[n-1].t) return width;
  let low = 0;
  let high = n - 1;
  while(high - low > 1){
    const mid = (low + high) >> 1;
    if(list[mid].t <= t) low = mid; else high = mid;
  }
  const span = (list[high].t - list[low].t) || 1;
  const ratio = (t - list[low].t) / span;
  return ((low + ratio) / (n - 1)) * width;
}
