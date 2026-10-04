// the visible order book (market depth) for the active symbol. rendered as a
// ladder next to the chart: asks stacked above the spread, bids below, with
// sizes drawn as background bars so the thin/thick zones read at a glance.
//
// an honest note about the data: this market is a single clearing tape — one
// price per symbol per tick, set by the engine. there is no multi-player queue
// resting at ten different price levels, so the ladder is *simulated depth*:
// deterministic per symbol+tick+level (hash-based, like the engine's own
// per-minute noise), shaped by each company's real liquidity profile (vol,
// price). the top of the book always brackets the live tape — the best bid and
// the best ask hug `price` at half a tick each — so the ladder never disagrees
// with the price you actually pay. it costs the server nothing: it is computed
// client-side on the same beat as the rest of the tick UI.
const ORDER_BOOK_LEVELS = 8; // per side
let orderBookSignature = '';
let orderBookSymbol = '';

// deterministic 0..1 hash, same family the engine uses for its per-minute noise
function bookHash(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0) / 4294967295;
}

// tick size scales with price so $0.004 stocks and $700 stocks both get a
// readable ladder
function bookTickSize(price) {
  if (price >= 300) return 0.5;
  if (price >= 100) return 0.25;
  if (price >= 20) return 0.1;
  if (price >= 1) return 0.01;
  if (price >= 0.01) return 0.001;
  return 0.0001;
}

// depth in shares grows with the distance from the touch, modulated by a
// stable per-level draw. volatility shapes it: calm mega-caps show thick
// books, jumpy biotechs show thin ones.
function bookLevelSize(sym, side, level, tick, base, tickKey) {
  const growth = 1 + level * 0.55;
  const noise = 0.55 + 0.9 * bookHash(sym, side, level, tickKey);
  return Math.max(1, Math.round(base * growth * noise));
}

// the price label uses the game's own adaptive formatter when it exists
// (roundPrice on the server, priceLabel in chart.js): falls back to enough
// decimals for the tick size
function bookPriceLabel(price, tick) {
  if (typeof priceLabel === 'function') return priceLabel(price);
  const decimals = tick >= 0.5 ? 2 : tick >= 0.01 ? 2 : tick >= 0.001 ? 4 : 6;
  return price.toFixed(decimals);
}

function buildBook(sym, price, vol, tickKey) {
  const tick = bookTickSize(price);
  const halfSpread = tick / 2;
  // liquidity base: richer books where the tape moves less (a $330 calm
  // software company carries more resting size than a $40 mover)
  const base = Math.max(40, Math.round(5200 / (1 + vol * 900)));
  const asks = [];
  const bids = [];
  for (let level = 0; level < ORDER_BOOK_LEVELS; level += 1) {
    asks.push({
      price: price + halfSpread + level * tick,
      shares: bookLevelSize(sym, 'a', level, tick, base, tickKey),
    });
    bids.push({
      price: Math.max(tick / 10, price - halfSpread - level * tick),
      shares: bookLevelSize(sym, 'b', level, tick, base, tickKey),
    });
  }
  return { asks: asks.reverse(), bids, tick };
}

// called from refreshTickUi (the shared 600ms-throttled beat) and directly
// from renderRestingOrders (with force=true) when the player's order list
// changes. repaints only when something the ladder shows actually moved.
function renderOrderBook(force){
  const box = document.getElementById('orderBook');
  if(!box) return;
  const m = bySym(activeSymbol);
  if(!m || !Number.isFinite(m.price) || m.price <= 0){ box.innerHTML = '<div class="ob-empty">Sin cotización.</div>'; return; }

  // one row of depth per game minute would churn every second; the ladder
  // lives on the *tape* tick key, so it re-shuffles exactly when prices do
  const tickKey = Math.floor((typeof currentGameTime === 'function' ? currentGameTime() : Date.now()) / 60000);
  const book = buildBook(m.sym, m.price, m.vol || 0.006, tickKey);
  // la firma incluye las órdenes propias: si el jugador coloca o cancela una,
  // el diamante tiene que aparecer/desaparecer aunque la cinta no se moviera
  const signature = `${m.sym}:${m.price}:${tickKey}:${(state.orders || []).map(o => o.id).join(',')}`;
  if(!force && signature === orderBookSignature && orderBookSymbol === m.sym){ return; }
  orderBookSignature = signature;
  orderBookSymbol = m.sym;

  // resting orders of the player sit on the ladder as gold diamonds, whatever
  // their kind (limit or stop) and side: a buy resting above the tape is a
  // stop, a sell resting below is a stop — the marker follows the order itself
  const resting = (state.orders || []).filter(o => o.sym === m.sym);
  const mark = (price) => resting.find(o => Math.abs(o.price - price) < book.tick / 2);

  const maxShares = Math.max(...book.asks.map(r => r.shares), ...book.bids.map(r => r.shares));
  const row = (r, side) => {
    const width = Math.max(6, Math.round((r.shares / maxShares) * 100));
    const mine = mark(r.price);
    const label = bookPriceLabel(r.price, book.tick);
    return `
      <div class="ob-row ob-${side}" data-price="${r.price}" title="clic para rellenar el precio de tu orden">
        <span class="ob-bar ob-bar-${side}" style="width:${width}%"></span>
        <span class="ob-price mono">${label}</span>
        <span class="ob-size mono">${r.shares}</span>
        ${mine ? '<span class="ob-mine" title="tu orden está aquí">◆</span>' : '<span class="ob-mine"></span>'}
      </div>`;
  };

  const spread = book.tick;
  box.innerHTML = `
    <div class="ob-head"><span>Precio</span><span>Tamaño</span><span></span></div>
    ${book.asks.map(r => row(r, 'ask')).join('')}
    <div class="ob-spread mono">spread ${spread.toFixed(2)}</div>
    ${book.bids.map(r => row(r, 'bid')).join('')}
  `;

  // click a level: pre-fill the order ticket (kind/price/side) but never fires
  // anything by itself
  box.querySelectorAll('.ob-row').forEach(el => {
    el.addEventListener('click', () => {
      const price = parseFloat(el.dataset.price);
      const isAsk = el.classList.contains('ob-ask');
      if(!Number.isFinite(price)) return;
      const kindBtn = document.querySelector(`.kind-btn[data-kind="${isAsk ? 'stop' : 'limit'}"]`);
      if(kindBtn) kindBtn.click();
      if(isAsk) document.querySelector('.side-btn[data-side="buy"]')?.click();
      else document.querySelector('.side-btn[data-side="sell"]')?.click();
      const input = document.getElementById('limitPriceInput');
      if(input){
        input.value = String(price);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if(typeof toast === 'function') toast('Precio tomado del libro', `${m.sym} a ${bookPriceLabel(price, book.tick)} · revisa y confirma`, 'gold');
    });
  });
}
