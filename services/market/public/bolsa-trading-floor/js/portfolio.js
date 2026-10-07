
// last total shown in the wallet bar, so the number can flash green or red when
// it moves (the total changes with every tick while you hold positions)
let lastWalletTotal = null;
let walletFlashTimer = null;
let lastWalletFlashAt = 0;
function flashWalletTotal(el, value){
  if(lastWalletTotal === null){
    lastWalletTotal = value;
    return;
  }
  const delta = value - lastWalletTotal;
  lastWalletTotal = value;
  // la cinta mueve el total en cada tick: el destello se limita para que siga
  // siendo una señal de dirección y no un parpadeo constante
  if(Math.abs(delta) < 0.01) return;
  if(Date.now() - lastWalletFlashAt < 900) return;
  lastWalletFlashAt = Date.now();
  el.classList.remove('flash-up','flash-down');
  el.classList.add(delta > 0 ? 'flash-up' : 'flash-down');
  clearTimeout(walletFlashTimer);
  walletFlashTimer = setTimeout(()=> el.classList.remove('flash-up','flash-down'), 700);
}

// the wallet chips in the header: total en tiempo real and dinero disponible.
// this is what the old “Rendimiento” panel used to show.
function updatePerformancePanel(){
  const pv = portfolioValue();
  const nw = state.cash + pv;
  const gain = nw - START_CASH;
  const ret = (gain/START_CASH)*100;
  const setText = (id, txt) => { const el = document.getElementById(id); if(el) el.textContent = txt; };

  setText('walletTotal', money(nw));
  setText('walletCash', money(state.cash));

  const totalEl = document.getElementById('walletTotal');
  if(totalEl) flashWalletTotal(totalEl, nw);

  const changeEl = document.getElementById('walletTotalChange');
  if(changeEl){
    changeEl.textContent =
      `${gain>=0?'+':'-'}${money(Math.abs(gain))} · ${ret>=0?'+':'-'}${Math.abs(ret).toFixed(2)}%`;
    changeEl.className = `mono wallet-sub ${gain>=0?'pos':'neg'}`;
  }

  renderAccountStats();
  checkBankruptcy(nw);
}


function renderAccountStats(){
  const wr = winRatePct();
  const pf = profitFactor();
  const wrTxt = wr===null ? '—' : `${wr.toFixed(0)}%`;
  const pfTxt = pf===null ? '—' : (pf===Infinity ? '∞' : pf.toFixed(2));

  const winRateEl = document.getElementById('acctWinRate');
  if(winRateEl) winRateEl.textContent = wrTxt;
  const bestEl = document.getElementById('acctBestTrade');
  if(bestEl){
    bestEl.textContent = `${state.stats.bestTrade>=0?'+':'-'}${money(Math.abs(state.stats.bestTrade))}`;
    bestEl.className = `mono ${state.stats.bestTrade>=0?'pos':'neg'}`;
  }
  const totalEl = document.getElementById('acctTotalTrades');
  if(totalEl) totalEl.textContent = state.stats.totalTrades;
  const pfEl = document.getElementById('acctProfitFactor');
  if(pfEl) pfEl.textContent = pfTxt;

  
  const nw = state.cash + portfolioValue();
  const openPositions = Object.values(state.positions).filter(p=>p.shares>0).length;
  const setText = (id, txt) => { const el = document.getElementById(id); if(el) el.textContent = txt; };
  setText('empireNetWorth', money(nw));
  setText('empireNetWorthSub', `cash ${money(state.cash)} · ${openPositions} posiciones abiertas`);
  setText('empireRank', rankForLevel(state.level));
  setText('empireRankSub', `nivel ${state.level} · ${state.xp} XP`);
  setText('empireWinRate', wrTxt);
  setText('empireWinRateSub', `${state.stats.totalTrades} operaciones cerradas`);
  const bestTradeEmpire = document.getElementById('empireBestTrade');
  if(bestTradeEmpire){
    bestTradeEmpire.textContent = `${state.stats.bestTrade>=0?'+':'-'}${money(Math.abs(state.stats.bestTrade))}`;
    bestTradeEmpire.className = `empire-value mono ${state.stats.bestTrade>=0?'pos':'neg'}`;
  }
  setText('empireProfitFactor', pfTxt);
  setText('empireTotalTrades', state.stats.totalTrades);
}


// una fila de posición. las celdas que se mueven con la cinta llevan data-f para
// actualizarse en el sitio: reconstruir la tabla en cada tick volvería a lanzar
// la animación de entrada una y otra vez (parpadeo constante).
function positionRowHtml(sym, p){
  const m = bySym(sym);
  // el precio al que se valora es la cinta, el % es el retorno sobre el margen y
  // la segunda línea es el dinero ganado o perdido
  const gp = ((m.price - p.avgPrice)/p.avgPrice)*100*(p.leverage||1);
  const pnl = positionPnl(sym, p);
  const invested = Number.isFinite(p.margin) ? p.margin : (p.avgPrice*p.shares)/(p.leverage||1);
  const levTag = p.leverage>1.001 ? `<span class="lev-tag">x${Math.round(p.leverage)}</span>` : '';
  const tpslTag = (p.tp || p.sl || p.trailPct) ? `<div class="tpsl-tag">${p.tp?`TP ${money(p.tp)} · `:''}${p.sl?`SL ${money(p.sl)} · `:''}${p.trailPct?`Trail ${p.trailPct}%`:''}</div>` : '';
  return `
    <div class="mini-row pos-row" data-sym="${sym}" title="Ver la gráfica de ${sym}">
      <span class="sym">${sym}${levTag}${tpslTag}</span>
      <span class="mono" data-f="price">${m.price.toFixed(2)}</span>
      <span class="gpl-cell">
        <span class="mono ${gp>=0?'pos':'neg'}" data-f="gp">${gp>=0?'+':''}${gp.toFixed(2)}%</span>
        <span class="mono gpl-money ${pnl>=0?'pos':'neg'}" data-f="pnl">${pnl>=0?'+':'-'}${money(Math.abs(pnl))}</span>
      </span>
      <span class="mono">${p.shares}</span>
      <span class="mono">${money(p.avgPrice)}</span>
      <span class="mono">${money(invested)}</span>
      <span class="pos-actions">
        <button class="pos-close-btn" data-sym="${sym}" data-pct="25">25%</button>
        <button class="pos-close-btn" data-sym="${sym}" data-pct="50">50%</button>
        <button class="pos-close-btn pos-close-all" data-sym="${sym}" data-pct="100">Cerrar</button>
      </span>
    </div>`;
}

// escribe una celda sólo si cambió, y sólo si la clase también cambió
function setCellText(row, field, text, className){
  const el = row.querySelector(`[data-f="${field}"]`);
  if(!el) return;
  if(el.textContent !== text) el.textContent = text;
  if(className && el.className !== className) el.className = className;
}

function renderPositions(){
  const wrap = document.getElementById('positionsRows');
  if(!wrap) return;
  const entries = Object.entries(state.positions).filter(([,p])=>p.shares>0);

  if(!entries.length){
    if(wrap.dataset.signature !== 'empty'){
      wrap.dataset.signature = 'empty';
      wrap.innerHTML = '<div class="mini-empty">Aún no tienes posiciones abiertas.</div>';
    }
    renderPositionsFooter(entries);
    return;
  }

  // la tabla se reconstruye sólo cuando cambia *qué* hay en cartera (una compra,
  // una venta parcial, otra entrada); el resto del tiempo se reescriben números
  const signature = entries
    .map(([sym,p])=>`${sym}:${p.shares}:${p.avgPrice}:${p.leverage||1}:${p.margin||0}:${p.tp||0}:${p.sl||0}:${p.trailPct||0}`)
    .join('|');

  if(wrap.dataset.signature !== signature){
    wrap.dataset.signature = signature;
    wrap.innerHTML = entries.map(([sym,p])=> positionRowHtml(sym,p)).join('');
    wrap.querySelectorAll('.pos-close-btn').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        if(state.bankrupt) return;
        closePositionPct(btn.dataset.sym, parseInt(btn.dataset.pct,10));
      });
    });
  } else {
    entries.forEach(([sym,p])=>{
      const m = bySym(sym);
      const row = wrap.querySelector(`.pos-row[data-sym="${sym}"]`);
      if(!m || !row) return;
      const gp = ((m.price - p.avgPrice)/p.avgPrice)*100*(p.leverage||1);
      const pnl = positionPnl(sym, p);
      setCellText(row, 'price', m.price.toFixed(2));
      setCellText(row, 'gp', `${gp>=0?'+':''}${gp.toFixed(2)}%`, `mono ${gp>=0?'pos':'neg'}`);
      setCellText(row, 'pnl', `${pnl>=0?'+':'-'}${money(Math.abs(pnl))}`, `mono gpl-money ${pnl>=0?'pos':'neg'}`);
    });
  }

  // tapping a position opens that investment's chart (the close buttons keep
  // their own job and stop the event)
  if(!wrap.dataset.bound){
    wrap.dataset.bound = '1';
    wrap.addEventListener('click', (e)=>{
      if(e.target.closest('.pos-actions')) return;
      const row = e.target.closest('.pos-row');
      if(row && row.dataset.sym && typeof selectSymbol === 'function'){
        selectSymbol(row.dataset.sym);
      }
    });
  }
  renderPositionsFooter(entries);
  if(typeof renderWatchlist === 'function') renderWatchlist();
}

function renderPositionsFooter(entries){
  const totalPnlEl = document.getElementById('positionsTotalPnl');
  if(!totalPnlEl) return;

  if(!entries.length){
    totalPnlEl.textContent = money(0);
    totalPnlEl.className = 'mono';
    return;
  }
  const totalPnl = entries.reduce((sum,[sym,p])=> sum + positionPnl(sym,p), 0);
  totalPnlEl.textContent = `${totalPnl>=0?'+':'-'}${money(Math.abs(totalPnl))}`;
  totalPnlEl.className = `mono ${totalPnl>=0?'pos':'neg'}`;
}


// a position is closed the moment it falls to zero or below: the loss has eaten
// the whole margin, so the trade is liquidated automatically instead of sitting
// on the book owing money. the loss is recorded like any other sale.
function checkLiquidations(){
  // con sesión las liquidaciones las aplica el latido del servidor sobre SUS
  // posiciones; aquí sólo corre en modo invitado
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn) return 0;
  let closed = 0;
  Object.entries(state.positions).forEach(([sym,p])=>{
    if(positionContribution(sym,p) > 0.01) return;
    closed += 1;
    const m = bySym(sym);
    const shares = p.shares;
    const pnl = positionPnl(sym,p);
    delete state.positions[sym];
    recordClosedTrade(pnl);
    const time = new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    state.transactions.unshift({ sym, type:'Venta', shares, price:m?m.price:0, time, leverage:1, pnl });
    const lev = p.leverage>1.001 ? ` (x${Math.round(p.leverage)})` : '';
    const pnlText = `${pnl>=0?'+':'-'}${money(Math.abs(pnl))}`;
    if(typeof Sound !== 'undefined') Sound.play('alarm');
    toast('Posición cerrada', `${sym}${lev} cayó a negativo y se cerró sola.`, 'down');
    pushNotification('Posición cerrada', `${sym}${lev} cayó a negativo y se cerró: ${pnlText}.`, 'down');
  });
  return closed;
}


// the account is wiped the moment the total hits zero or goes negative: every
// open transaction is closed on the spot and the player waits one real minute
// for a fresh $10,000 stake (RECAP_CASH) to start again.
function showBankruptcyOverlay(){
  document.getElementById('bankruptOverlay').classList.add('is-visible');
  document.getElementById('qtyInput').disabled = true;
  document.getElementById('submitOrder').disabled = true;
  document.querySelectorAll('.side-btn,.step-btn,.pct-btn,.lev-btn').forEach(b=>b.disabled = true);
  if(typeof Sound !== 'undefined') Sound.play('alarm');
  toast('Cuenta a cero','Tus operaciones se cerraron. Espera la recapitalización.','down');
  pushNotification('Cuenta a cero', 'Tu patrimonio cayó a negativo. Se cerraron tus operaciones; espera 1 minuto por $10,000.', 'down');
  renderPositions();
}
function hideBankruptcyOverlay(){
  document.getElementById('bankruptOverlay').classList.remove('is-visible');
  document.getElementById('qtyInput').disabled = false;
  document.querySelectorAll('.side-btn,.step-btn,.pct-btn,.lev-btn').forEach(b=>b.disabled = false);
}
function checkBankruptcy(nw){
  if(state.bankrupt) return;
  // con sesión la bancarrota la marca el servidor (ledger.mjs runRiskPass) y
  // avisa por el websocket: aquí sólo se aplica en modo invitado, donde no hay
  // nadie más que pueda mirar el patrimonio
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn) return;
  if(nw <= 0.01){
    Object.keys(state.positions).forEach(sym=> delete state.positions[sym]);
    state.bankrupt = true;
    // the "manos vacías" and "fénix" achievements both read this counter
    state.stats.timesBankrupt = (state.stats.timesBankrupt || 0) + 1;
    state.bankruptUntil = Date.now() + BANKRUPT_WAIT_MS;
    showBankruptcyOverlay();
  }
}
function tickBankruptcy(){
  if(!state.bankrupt) return;
  const remaining = Math.max(0, state.bankruptUntil - Date.now());
  const s = Math.ceil(remaining/1000);
  const mm = String(Math.floor(s/60)).padStart(2,'0');
  const ss = String(s%60).padStart(2,'0');
  document.getElementById('bankruptTimer').textContent = `${mm}:${ss}`;
  document.getElementById('bankruptBarFill').style.width = `${(remaining/BANKRUPT_WAIT_MS)*100}%`;

  if(remaining>0) return;
  // la recapitalización la acredita el servidor: al llegar aquí sólo se
  // levanta el velo y se repinta con la cartera que él devolvió
  if(typeof MarketNet !== 'undefined' && MarketNet.signedIn){
    hideBankruptcyOverlay();
    updateQuoteBlock();
    updatePerformancePanel();
    renderPositions();
    recalcOrder();
    return;
  }
  state.bankrupt = false;
  state.cash = RECAP_CASH;
  state.positions = {};
  const time = new Date().toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  state.transactions.unshift({ sym:'RECAP', type:'Compra', shares:0, price:RECAP_CASH, time });
  hideBankruptcyOverlay();
  toast('Recapitalización acreditada', `+${money(RECAP_CASH)} en tu cuenta`, 'gold');
  pushNotification('Recapitalización acreditada', `+${money(RECAP_CASH)} en tu cuenta.`, 'gold');
  updateQuoteBlock();
  updatePerformancePanel();
  renderPositions();
  recalcOrder();
}


function initCloseTimer(){
  let total = 6*3600 + 1*60 + 24;
  const el = document.getElementById('closeTimer');
  setInterval(()=>{
    total = Math.max(0,total-1);
    const h = String(Math.floor(total/3600)).padStart(2,'0');
    const m = String(Math.floor((total%3600)/60)).padStart(2,'0');
    const s = String(total%60).padStart(2,'0');
    el.textContent = `${h}:${m}:${s}`;
  },1000);
}
