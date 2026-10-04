
let earningsSchedule = [];
function buildEarningsSchedule(){
  const sessions = ['Pre-market · 8:30 AM', 'After the bell · 5:00 PM'];
  earningsSchedule = MARKET.map(m=>({
    sym: m.sym,
    name: m.name,
    session: sessions[Math.floor(Math.random()*sessions.length)],
    msAway: (Math.random()*4 + 0.3) * 3600 * 1000, 
  })).sort((a,b)=>a.msAway-b.msAway);
}
function formatCountdown(ms){
  if(ms<=0) return 'Ahora';
  const totalMin = Math.floor(ms/60000);
  const h = Math.floor(totalMin/60);
  const m = totalMin%60;
  return h>0 ? `en ${h}h ${m}m` : `en ${m}m`;
}
function renderEarningsCalendar(){
  const wrap = document.getElementById('earningsCalendar');
  if(!wrap) return;
  if(!earningsSchedule.length) buildEarningsSchedule();
  wrap.innerHTML = earningsSchedule.slice(0,10).map(e=>`
    <div class="mini-row research-row">
      <span class="sym">${e.sym}</span>
      <span class="research-name">${e.name}</span>
      <span class="research-session">${e.session}</span>
      <span class="mono research-countdown">${formatCountdown(e.msAway)}</span>
    </div>`).join('');
}
function tickEarningsCountdowns(){
  if(!earningsSchedule.length) return;
  earningsSchedule.forEach(e=>{ e.msAway = Math.max(0, e.msAway - 1000); });
  if(currentView==='research'){
    document.querySelectorAll('#earningsCalendar .research-countdown').forEach((el,i)=>{
      const e = earningsSchedule[i];
      if(e) el.textContent = formatCountdown(e.msAway);
    });
  }
}


function renderTopMovers(){
  const wrap = document.getElementById('topMovers');
  if(!wrap) return;
  const top = [...MARKET].sort((a,b)=>Math.abs(b.pct)-Math.abs(a.pct)).slice(0,8);
  wrap.innerHTML = top.map(m=>`
    <div class="mini-row research-row" data-sym="${m.sym}" title="Ver la gráfica de ${m.sym}">
      <span class="sym">${m.sym}</span>
      <span class="research-name">${m.name}</span>
      <span class="mono ${m.pct>=0?'pos':'neg'}">${m.pct>=0?'▲':'▼'} ${Math.abs(m.pct).toFixed(2)}%</span>
      <span class="mono">${money(m.price)}</span>
    </div>`).join('');

  if(!wrap.dataset.bound){
    wrap.dataset.bound = '1';
    wrap.addEventListener('click', (e)=>{
      const row = e.target.closest('.research-row[data-sym]');
      if(row && row.dataset.sym && typeof selectSymbol === 'function'){
        selectSymbol(row.dataset.sym);
      }
    });
  }
}


function renderSectorPerf(){
  const wrap = document.getElementById('sectorPerf');
  if(!wrap) return;
  const bySector = {};
  MARKET.forEach(m=>{
    (bySector[m.sector] = bySector[m.sector]||[]).push(m.pct);
  });
  const rows = Object.entries(bySector).map(([sector, pcts])=>{
    const avg = pcts.reduce((a,b)=>a+b,0)/pcts.length;
    return { sector, avg, count: pcts.length };
  }).sort((a,b)=>b.avg-a.avg);

  wrap.innerHTML = rows.map(r=>`
    <div class="mini-row research-row research-row-sector">
      <span class="research-name">${r.sector}</span>
      <span class="mono">${r.count} activo${r.count!==1?'s':''}</span>
      <span class="mono ${r.avg>=0?'pos':'neg'}">${r.avg>=0?'+':''}${r.avg.toFixed(2)}%</span>
    </div>`).join('');
}

function renderResearchView(){
  renderEarningsCalendar();
  renderTopMovers();
  renderSectorPerf();
}
