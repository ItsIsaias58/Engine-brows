
// ---- órdenes limit/stop ---------------------------------------------------
// kind: 'market' (ahora), 'limit' (mejor precio que el actual), 'stop'
// (dispara cuando el precio lo alcanza). el margen se aparta al colocar y
// vuelve si la orden se cancela o expira.
let orderKind = 'market';
let localOrderSeq = 1;

function orderPriceTarget(){
  const m = bySym(activeSymbol);
  const raw = document.getElementById('limitPriceInput')?.value?.trim();
  if(!raw) return null;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function placeRestingOrder(m, n){
  const target = orderPriceTarget();
  if(!target){
    toast('Falta el precio', 'Escribe a qué precio quieres que dispare la orden.', 'down');
    if(typeof Sound !== 'undefined') Sound.play('error');
    return;
  }
  const kind = orderKind;
  const live = m.price;
  // mismas reglas que el server: limit compra abajo, stop compra arriba, etc.
  if(side==='buy' && kind==='limit' && target >= live){
    toast('Precio inválido','Una compra limitada va DEBAJO del precio actual.','down');
    if(typeof Sound !== 'undefined') Sound.play('error'); return;
  }
  if(side==='buy' && kind==='stop' && target <= live){
    toast('Precio inválido','Una compra stop va ENCIMA del precio actual.','down');
    if(typeof Sound !== 'undefined') Sound.play('error'); return;
  }
  if(side==='sell' && kind==='limit' && target <= live){
    toast('Precio inválido','Una venta limitada va ENCIMA del precio actual.','down');
    if(typeof Sound !== 'undefined') Sound.play('error'); return;
  }
  if(side==='sell' && kind==='stop' && target >= live){
    toast('Precio inválido','Una venta stop va DEBAJO del precio actual.','down');
    if(typeof Sound !== 'undefined') Sound.play('error'); return;
  }
  const marginNeeded = (n*target)/leverage;
  if(marginNeeded > state.cash + 0.001){
    toast('Fondos insuficientes',`El margen de la orden es ${money(marginNeeded)} y tienes ${money(state.cash)}.`,'down');
    if(typeof suppressNextNotify === 'function') suppressNextNotify();
    pushNotification('Fondos insuficientes', `No alcanza el margen para ${n} ${m.sym} a ${money(target)}.`, 'down');
    if(typeof Sound !== 'undefined') Sound.play('error');
    return;
  }
  const order = {
    id:`o${Date.now().toString(36)}${(localOrderSeq++).toString(36)}`,
    sym:m.sym, side, kind, shares:n, price:target, leverage,
    margin:marginNeeded, placedAt:Date.now(),
    day:Math.floor(currentGameTime()/86400000),
  };
  // con sesión el server es la verdad: coloca allá y él aparta el margen
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn){
    MarketNet.request('/api/market/orders', {
      method:'POST',
      body:JSON.stringify({ sym:m.sym, side, kind, shares:n, price:target, leverage }),
    }).then(data=>{
      if(data?.ok){
        state.cash = data.cash;
        state.orders = [...(state.orders||[]), data.order];
        renderRestingOrders();
        updatePerformancePanel();
        toast(`Orden ${kind} colocada`, `${side==='buy'?'Compra':'Venta'} de ${n} ${m.sym} a ${money(target)}`, 'gold');
        pushNotification(`📋 Orden ${kind}: ${m.sym}`, `${n} acciones a ${money(target)} · margen apartado ${money(marginNeeded)}`, 'gold');
        if(typeof Sound !== 'undefined') Sound.play('open');
        addXp(3);
      } else {
        toast('No se colocó', data?.error || 'el server rechazó la orden', 'down');
        if(typeof Sound !== 'undefined') Sound.play('error');
      }
    }).catch(()=>toast('Sin conexión','No se pudo colocar la orden en el server.','down'));
    return;
  }
  // invitado: la orden vive localmente
  state.cash -= marginNeeded;
  state.orders = [...(state.orders||[]), order];
  renderRestingOrders();
  updatePerformancePanel();
  toast(`Orden ${kind} colocada`, `${side==='buy'?'Compra':'Venta'} de ${n} ${m.sym} a ${money(target)} · margen apartado`, 'gold');
  pushNotification(`📋 Orden ${kind}: ${m.sym}`, `${n} acciones a ${money(target)} · se ejecuta sola al cruzarse`, 'gold');
  if(typeof Sound !== 'undefined') Sound.play('open');
}

async function cancelRestingOrder(id){
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn){
    try{
      const data = await MarketNet.request(`/api/market/orders?id=${encodeURIComponent(id)}`, { method:'DELETE' });
      if(data?.ok) state.cash = data.cash;
    }catch(e){ toast('Sin conexión','No se pudo cancelar en el server.','down'); if(typeof Sound !== 'undefined') Sound.play('error'); return; }
  } else {
    const order = (state.orders||[]).find(o=>o.id===id);
    if(order) state.cash += order.margin;
  }
  state.orders = (state.orders||[]).filter(o=>o.id!==id);
  renderRestingOrders();
  updatePerformancePanel();
  toast('Orden cancelada','El margen apartado volvió a tu efectivo.','gold');
  if(typeof Sound !== 'undefined') Sound.play('close');
}

// lista de órdenes en espera, bajo el panel de colocación
function renderRestingOrders(){
  // el libro de órdenes marca las órdenes propias con un diamante: al cambiar
  // la lista hay que repintarlo aunque la cinta esté igual
  if(typeof renderOrderBook === 'function') renderOrderBook(true);
  const box = document.getElementById('restingOrders');
  if(!box) return;
  const list = state.orders || [];
  if(!list.length){ box.innerHTML = '<div class="resting-empty">Sin órdenes en espera. Coloca una limit o stop y se ejecuta sola.</div>'; return; }
  box.innerHTML = list.map(o=>{
    const m = bySym(o.sym);
    const dist = m ? ((o.price - m.price)/m.price*100) : 0;
    const far = dist >= 0 ? `+${dist.toFixed(1)}%` : `${dist.toFixed(1)}%`;
    return `
      <div class="resting-row resting-${o.side}" data-id="${o.id}">
        <strong class="mono">${o.sym}</strong>
        <span>${o.side==='buy'?'Compra':'Venta'} ${o.shares}</span>
        <span class="mono">${o.kind==='limit'?'LMT':'STP'} ${money(o.price)}</span>
        <em class="mono">${far}</em>
        <button class="resting-cancel" data-cancel="${o.id}" title="cancelar">✕</button>
      </div>`;
  }).join('');
  box.querySelectorAll('[data-cancel]').forEach(btn=>{
    btn.addEventListener('click', ()=>cancelRestingOrder(btn.dataset.cancel));
  });
}

// el latido local de las órdenes en invitado (con sesión lo hace el server)
function checkLocalOrders(){
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn) return;
  const list = state.orders || [];
  if(!list.length) return;
  const day = Math.floor(currentGameTime()/86400000);
  for(const order of [...list]){
    const m = bySym(order.sym);
    if(!m) continue;
    if(day - order.day >= 14){
      state.cash += order.margin;
      state.orders = state.orders.filter(o=>o.id!==order.id);
      pushNotification(`📋 Orden expirada: ${order.sym}`, '14 días sin cruzarse · margen devuelto', 'gold');
      continue;
    }
    const crossed = order.kind==='limit'
      ? (order.side==='buy' ? m.price <= order.price : m.price >= order.price)
      : (order.side==='buy' ? m.price >= order.price : m.price <= order.price);
    if(!crossed) continue;
    // llena al precio de la orden, nunca peor
    const fill = order.price;
    const fake = { sym:order.sym, price:fill };
    let result = null;
    if(order.side==='buy'){
      if(buyShares(fake, order.shares, order.leverage, {})){
        state.transactions.unshift({ sym:order.sym, type:'Compra', shares:order.shares, price:fill, time:new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}), leverage:order.leverage });
        addXp(8);
      }
    } else {
      result = sellShares(fake, order.shares);
      if(result!==false){
        state.transactions.unshift({ sym:order.sym, type:'Venta', shares:order.shares, price:fill, time:new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'}), leverage:1, pnl:result.pnl });
        const won = result.pnl >= 0;
        pushNotification(`${won?'Ganancia':'Pérdida'}: ${order.sym}`, `${won?'+':'-'}${money(Math.abs(result.pnl))} · orden ${order.kind} ejecutada`, won?'up':'down');
        if(typeof Sound !== 'undefined') Sound.play(won?'profit':'loss');
        recordClosedTrade(result.pnl);
        addXp(10);
      }
    }
    state.orders = state.orders.filter(o=>o.id!==order.id);
    toast(`Orden ${order.kind} ejecutada`, `${order.side==='buy'?'Compra':'Venta'} de ${order.shares} ${order.sym} a ${money(fill)}`, 'gold');
  }
  renderRestingOrders();
  refreshMarketRow(activeSymbol);
}

function initOrderPanel(){
  const toggle = document.getElementById('sideToggle');
  toggle.querySelectorAll('.side-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      side = btn.dataset.side;
      toggle.dataset.side = side;
      toggle.querySelectorAll('.side-btn').forEach(b=>b.classList.remove('is-active'));
      btn.classList.add('is-active');
      document.getElementById('submitOrder').classList.toggle('is-sell', side==='sell');
      document.getElementById('leverageField').classList.toggle('is-disabled', side==='sell');
      document.getElementById('tpSlFields').classList.toggle('is-disabled', side==='sell');
      document.getElementById('trailField').classList.toggle('is-disabled', side==='sell');
      updateQuoteBlock();
    });
  });

  const qty = document.getElementById('qtyInput');
  document.querySelectorAll('.step-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const delta = parseInt(btn.dataset.step,10);
      qty.value = Math.max(0, (parseInt(qty.value,10)||0) + delta);
      recalcOrder();
    });
  });
  qty.addEventListener('input', recalcOrder);

  document.querySelectorAll('.pct-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const pct = parseInt(btn.dataset.pct,10);
      qty.value = calcQtyForPct(pct);
      recalcOrder();
    });
  });

  document.querySelectorAll('.lev-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(side==='sell') return;
      leverage = parseInt(btn.dataset.lev,10);
      document.querySelectorAll('.lev-btn').forEach(b=>b.classList.remove('is-active'));
      btn.classList.add('is-active');
      recalcOrder();
      updateQuoteBlock();
    });
  });

  // tipo de orden: mercado / limit / stop
  document.querySelectorAll('.kind-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      orderKind = btn.dataset.kind;
      document.querySelectorAll('.kind-btn').forEach(b=>b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const priceField = document.getElementById('limitPriceField');
      if(priceField) priceField.style.display = orderKind==='market' ? 'none' : 'flex';
      const hint = document.getElementById('orderKindHint');
      if(hint){
        hint.textContent = orderKind==='market'
          ? 'Se ejecuta ahora al precio de la cinta.'
          : orderKind==='limit'
            ? 'Espera a que el precio llegue al tuyo (mejor precio garantizado).'
            : 'Dispara cuando el precio CRUCE el tuyo (rompe arriba/abajo).';
      }
      recalcOrder();
    });
  });
  const limitInput = document.getElementById('limitPriceInput');
  if(limitInput) limitInput.addEventListener('input', recalcOrder);

  document.getElementById('submitOrder').addEventListener('click', (e)=>{
    if(state.bankrupt) return;
    const btn = e.currentTarget;
    btn.style.transform = 'scale(.96)';
    setTimeout(()=>{ btn.style.transform=''; }, 140);
    executeOrder();
  });
}


function calcQtyForPct(pct){
  const m = bySym(activeSymbol);
  if(side==='buy'){
    const budget = state.cash * (pct/100);
    return Math.max(0, Math.floor((budget*leverage) / m.price));
  }
  const pos = state.positions[m.sym];
  const owned = pos ? pos.shares : 0;
  return Math.max(0, Math.floor(owned * (pct/100)));
}

function recalcOrder(){
  const m = bySym(activeSymbol);
  const n = parseInt(document.getElementById('qtyInput').value,10)||0;
  const notional = n*m.price;
  const marginNeeded = notional/leverage;

  document.getElementById('costLabel').textContent = side==='buy' ? 'Costo estimado' : 'Ingreso estimado';
  document.getElementById('estCost').textContent = money(side==='buy' ? notional : notional);

  const marginRow = document.getElementById('marginRow');
  if(side==='buy' && leverage>1){
    marginRow.style.display = 'flex';
    document.getElementById('estMargin').textContent = money(marginNeeded);
  } else {
    marginRow.style.display = 'none';
  }

  const submit = document.getElementById('submitOrder');
  const pos = state.positions[m.sym];
  // en limit/stop el margen se calcula contra el precio de la orden, no el vivo
  const target = orderKind!=='market' ? orderPriceTarget() : null;
  const refPrice = target || m.price;
  const orderMargin = (n*refPrice)/leverage;
  const canBuy = n>0 && orderMargin <= state.cash + 0.001;
  const canSell = n>0 && (orderKind!=='market' || (pos && n<=pos.shares + 0.0001));
  const badTarget = target !== null && (
    (side==='buy' && ((orderKind==='limit' && target >= m.price) || (orderKind==='stop' && target <= m.price))) ||
    (side==='sell' && ((orderKind==='limit' && target <= m.price) || (orderKind==='stop' && target >= m.price))));
  submit.disabled = state.bankrupt || badTarget || (side==='buy' ? !canBuy : !canSell);
  const label = document.getElementById('submitLabel');
  if(label){
    if(side==='buy') label.textContent = orderKind==='market' ? `Comprar ${m.sym}` : `Colocar ${orderKind==='limit'?'limit':'stop'} ${m.sym}`;
    else label.textContent = orderKind==='market' ? `Vender ${m.sym}` : `Colocar ${orderKind==='limit'?'limit':'stop'} ${m.sym}`;
  }
}


function buyShares(m, n, lev, extra={}){
  const pos = state.positions[m.sym] || { shares:0, avgPrice:0, leverage:lev, margin:0 };
  const newShares = pos.shares + n;
  const newAvgPrice = ((pos.avgPrice*pos.shares) + (m.price*n)) / newShares;
  const newLeverage = ((pos.leverage||lev)*pos.shares + lev*n) / newShares;
  const newMargin = (newAvgPrice*newShares) / newLeverage;
  const marginDelta = newMargin - pos.margin;

  if(marginDelta > state.cash + 0.001){
    toast('Fondos insuficientes','No tienes suficiente efectivo para esta orden.','down');
    if(typeof suppressNextNotify === 'function') suppressNextNotify();
    pushNotification('Fondos insuficientes', `No alcanza el efectivo para comprar ${n} ${m.sym}.`, 'down');
    if(typeof Sound !== 'undefined') Sound.play('error');
    return false;
  }
  state.cash -= marginDelta;
  // el registro de operaciones: con sesión, esta compra no es dinero hasta que
  // el servidor la reproduce contra su propia cinta (ledger.mjs). el precio no
  // viaja — lo pone el servidor, que es lo que impide comprar a 0.0001
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn) queueLedgerOp({ kind:'buy', sym:m.sym, shares:n, leverage:lev, tp:extra.tp, sl:extra.sl, trailPct:extra.trailPct });
  state.positions[m.sym] = {
    shares:newShares, avgPrice:newAvgPrice, leverage:newLeverage, margin:newMargin,
    tp: extra.tp!==undefined ? extra.tp : (pos.tp||null),
    sl: extra.sl!==undefined ? extra.sl : (pos.sl||null),
    trailPct: extra.trailPct!==undefined ? extra.trailPct : (pos.trailPct||null),
    trailPeak: extra.trailPct!==undefined ? m.price : (pos.trailPeak||m.price),
  };
  return true;
}

function sellShares(m, n){
  const pos = state.positions[m.sym];
  // una venta de cero no es una operación: registrarla inflaría totalTrades
  if(!Number.isFinite(n) || n <= 0) return false;
  if(!pos || n>pos.shares+0.0001){
    toast('Acciones insuficientes','No tienes suficientes acciones para vender.','down');
    if(typeof suppressNextNotify === 'function') suppressNextNotify();
    pushNotification('Acciones insuficientes', `No tienes suficientes ${m.sym} para vender.`, 'down');
    if(typeof Sound !== 'undefined') Sound.play('error');
    return false;
  }
  const fracSold = n/pos.shares;
  const marginReleased = (pos.margin||0)*fracSold;
  const pnl = n*(m.price - pos.avgPrice);
  const proceeds = Math.max(0, marginReleased + pnl); 
  state.cash += proceeds;
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn) queueLedgerOp({ kind:'sell', sym:m.sym, shares:n });
  pos.shares -= n;
  pos.margin = Math.max(0, (pos.margin||0) - marginReleased);
  if(pos.shares<=0.0001) delete state.positions[m.sym];
  recordClosedTrade(pnl);
  return { proceeds, pnl };
}


function parseTpSl(raw, entryPrice, isTp){
  if(!raw) return null;
  const s = String(raw).trim();
  if(!s) return null;
  if(s.endsWith('%')){
    const pct = parseFloat(s)/100;
    if(isNaN(pct)) return null;
    return isTp ? entryPrice*(1+Math.abs(pct)) : entryPrice*(1-Math.abs(pct));
  }
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}


function checkTpSl(){
  // con sesión las salidas las ejecuta el latido del servidor (ledger.mjs
  // runRiskPass) y el aviso llega por el websocket: aquí sólo se corre en modo
  // invitado, donde no hay nadie más que mande
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn) return;
  Object.entries(state.positions).forEach(([sym,p])=>{
    const m = bySym(sym);
    if(!m || p.shares<=0) return;

    if(p.trailPct){
      p.trailPeak = Math.max(p.trailPeak||m.price, m.price);
      const trailStop = p.trailPeak * (1 - p.trailPct/100);
      if(m.price <= trailStop){
        closeFullPosition(sym, 'Trailing stop activado');
        return;
      }
    }
    if(p.tp && m.price >= p.tp){
      closeFullPosition(sym, `Take profit alcanzado (${money(p.tp)})`);
      return;
    }
    if(p.sl && m.price <= p.sl){
      closeFullPosition(sym, `Stop loss alcanzado (${money(p.sl)})`);
    }
  });
}
function closeFullPosition(sym, reason){
  const m = bySym(sym);
  const pos = state.positions[sym];
  if(!m || !pos) return;
  const shares = pos.shares;
  const result = sellShares(m, shares);
  if(result===false) return;
  if(typeof Sound !== 'undefined') Sound.play(result.pnl >= 0 ? 'profit' : 'loss');
  const time = new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  state.transactions.unshift({ sym, type:'Venta', shares, price:m.price, time, leverage:1, pnl:result.pnl });
  const won = result.pnl >= 0;
  const pnlText = `${won?'+':'-'}${money(Math.abs(result.pnl))}`;
  toast(`${sym} cerrada`, `${pnlText} · ${reason}`, won ? 'up' : 'down');
  pushNotification(`${won?'Ganancia':'Pérdida'}: ${sym}`, `${pnlText} · ${shares} acciones a ${money(m.price)} · ${reason}`, won?'up':'down');
  addXp(15);
  refreshMarketRow(sym);
  updateQuoteBlock();
  updatePerformancePanel();
  renderPositions();
  renderTransactions();
  checkQuests();
}


function closePositionPct(sym, pct){
  const pos = state.positions[sym];
  const m = bySym(sym);
  if(!pos || !m) return;
  const n = pct>=100 ? pos.shares : Math.max(1, Math.floor(pos.shares*(pct/100)));
  // the shares actually sold: read them before sellShares shrinks the position
  const sold = Math.min(n, pos.shares);
  const result = sellShares(m, sold);
  if(result===false) return;
  if(typeof Sound !== 'undefined') Sound.play(result.pnl >= 0 ? 'profit' : 'loss');
  const time = new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  state.transactions.unshift({ sym, type:'Venta', shares:sold, price:m.price, time, leverage:1, pnl:result.pnl });
  const won = result.pnl >= 0;
  const pnlText = `${won?'+':'-'}${money(Math.abs(result.pnl))}`;
  toast(`Vendiste ${sold} ${sym}`, `${pnlText} · ${money(result.proceeds)} recibidos`, won ? 'up' : 'down');
  pushNotification(`${won?'Ganancia':'Pérdida'}: ${sym}`, `${pnlText} · vendiste ${sold} acciones a ${money(m.price)} (${pct}% de la posición)`, won?'up':'down');
  addXp(6);
  refreshMarketRow(sym);
  updateQuoteBlock();
  updatePerformancePanel();
  renderPositions();
  renderTransactions();
  checkQuests();
}

function executeOrder(){
  const m = bySym(activeSymbol);
  const qtyInput = document.getElementById('qtyInput');
  const n = parseInt(qtyInput.value,10)||0;
  if(n<=0) return;

  const time = new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

  // órdenes en espera (limit/stop): no tocan la cartera ahora, apartan su
  // margen y esperan a que la cinta cruce su precio. el server las ejecuta
  // tick a tick; en modo invitado las lleva el latido local (checkLocalOrders)
  if(orderKind!=='market'){
    placeRestingOrder(m, n);
    return;
  }

  if(side==='buy'){
    const cost = (n*m.price)/leverage;
    const tpRaw = document.getElementById('tpInput').value;
    const slRaw = document.getElementById('slInput').value;
    const trailRaw = document.getElementById('trailInput').value;
    const extra = {
      tp: tpRaw ? parseTpSl(tpRaw, m.price, true) : null,
      sl: slRaw ? parseTpSl(slRaw, m.price, false) : null,
      trailPct: trailRaw ? Math.abs(parseFloat(trailRaw))||null : null,
    };
    if(!buyShares(m, n, leverage, extra)) return;
    if(typeof Sound !== 'undefined') Sound.play('buy');
    state.transactions.unshift({ sym:m.sym, type:'Compra', shares:n, price:m.price, time, leverage });
    toast(`Compraste ${n} ${m.sym}`, `a ${money(m.price)} c/u · margen ${money(cost)}${leverage>1?` (x${leverage})`:''}`, 'up');
    // a purchase is not a win or a loss, so it gets the neutral colour: the
    // green/red bell entries are reserved for realised profit and loss
    pushNotification(`Compra: ${m.sym}`, `${n} acciones a ${money(m.price)} c/u · ${money(cost)} menos en tu dinero disponible${leverage>1?` (x${leverage})`:''}`, 'gold');
    addXp(8);
    document.getElementById('tpInput').value='';
    document.getElementById('slInput').value='';
    document.getElementById('trailInput').value='';
  } else {
    const result = sellShares(m, n);
    if(result===false) return;
    // la venta suena a venta; el color (profit/loss) lo pone el resultado en
    // los avisos, no aquí — un jingle por operación
    if(typeof Sound !== 'undefined') Sound.play('sell');
    state.transactions.unshift({ sym:m.sym, type:'Venta', shares:n, price:m.price, time, leverage:1, pnl:result.pnl });
    const won = result.pnl >= 0;
    const pnlText = `${won?'+':'-'}${money(Math.abs(result.pnl))}`;
    toast(`Vendiste ${n} ${m.sym}`, `${pnlText} · ${money(result.proceeds)} recibidos`, won ? 'up' : 'down');
    pushNotification(`${won?'Ganancia':'Pérdida'}: ${m.sym}`, `${pnlText} · ${n} acciones a ${money(m.price)} c/u`, won?'up':'down');
    addXp(10);
  }

  qtyInput.value = 0;
  refreshMarketRow(m.sym);
  updateQuoteBlock();
  updatePerformancePanel();
  renderPositions();
  renderTransactions();
  checkQuests();
  if(typeof drawChart === 'function') drawChart();
}
