
function updateHud(){
  const need = xpToNext();
  const lvlEl = document.getElementById('hudLevel');
  if(lvlEl) lvlEl.textContent = state.level;
  const fillEl = document.getElementById('hudXpFill');
  if(fillEl) fillEl.style.width = `${Math.min(100,(state.xp/need)*100)}%`;
  const textEl = document.getElementById('hudXpText');
  if(textEl) textEl.textContent = `${state.xp} / ${need} XP`;
  renderNotifications();
}


function renderNotifications(){
  const badge = document.getElementById('hudBellBadge');
  if(badge){
    if(state.unreadNotifs>0){
      badge.style.display = 'flex';
      badge.textContent = state.unreadNotifs>9 ? '9+' : state.unreadNotifs;
    } else {
      badge.style.display = 'none';
    }
  }
  const list = document.getElementById('hudNotifList');
  if(!list) return;
  if(!state.notifications.length){
    list.innerHTML = '<div class="mini-empty">Sin notificaciones todavía.</div>';
    return;
  }
  // mismo criterio que toast(): el broadcast del admin llega aqui con
  // title/msg sin filtrar y ademas queda en state.notifications, asi que se
  // vuelve a pintar cada vez que se abre el panel.
  list.innerHTML = state.notifications.map(n=>`
    <div class="hud-notif-item hud-notif-${safeClassToken(n.kind, 'info')}">
      <div class="hud-notif-head"><strong>${escapeHtml(n.title)}</strong><span>${escapeHtml(n.time)}</span></div>
      <p>${escapeHtml(n.msg)}</p>
    </div>`).join('');
}
function markNotificationsRead(){
  state.unreadNotifs = 0;
  renderNotifications();
}


function renderWatchlist(){
  const wrap = document.getElementById('watchlistRows');
  if(!wrap) return;
  if(!state.watchlist.length){
    if(wrap.dataset.signature !== 'empty'){
      wrap.dataset.signature = 'empty';
      wrap.innerHTML = '<div class="mini-empty">Toca la ★ junto a un símbolo en Vista del mercado para seguirlo aquí.</div>';
    }
    return;
  }
  // la lista se reconstruye sólo cuando cambian los símbolos seguidos; los
  // precios se reescriben en el sitio para no relanzar la animación de entrada
  const signature = state.watchlist.join('|');
  if(wrap.dataset.signature !== signature){
    wrap.dataset.signature = signature;
    wrap.innerHTML = state.watchlist.map(sym=>{
      const m = bySym(sym);
      if(!m) return '';
      return `
        <div class="mini-row watchlist-row" data-sym="${m.sym}" title="Ver la gráfica de ${m.sym}">
          <span class="sym">${m.sym}</span>
          <span class="mono" data-f="price">${m.price.toFixed(2)}</span>
          <span class="mono ${m.pct>=0?'pos':'neg'}" data-f="pct">${m.pct>=0?'+':''}${m.pct.toFixed(2)}%</span>
          <span>${m.sector}</span>
          <button class="star-btn is-active" data-star="${m.sym}" title="Quitar de favoritos">★</button>
        </div>`;
    }).join('');
    wrap.querySelectorAll('.star-btn').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        e.stopPropagation();
        toggleWatchlist(btn.dataset.star);
      });
    });
  } else {
    state.watchlist.forEach(sym=>{
      const m = bySym(sym);
      const row = wrap.querySelector(`.watchlist-row[data-sym="${sym}"]`);
      if(!m || !row) return;
      const priceEl = row.querySelector('[data-f="price"]');
      const priceText = m.price.toFixed(2);
      if(priceEl && priceEl.textContent !== priceText) priceEl.textContent = priceText;
      const pctEl = row.querySelector('[data-f="pct"]');
      const pctText = `${m.pct>=0?'+':''}${m.pct.toFixed(2)}%`;
      const pctClass = `mono ${m.pct>=0?'pos':'neg'}`;
      if(pctEl){
        if(pctEl.textContent !== pctText) pctEl.textContent = pctText;
        if(pctEl.className !== pctClass) pctEl.className = pctClass;
      }
    });
  }

  if(!wrap.dataset.bound){
    wrap.dataset.bound = '1';
    wrap.addEventListener('click', (e)=>{
      if(e.target.closest('.star-btn')) return;
      const row = e.target.closest('.watchlist-row');
      if(row && row.dataset.sym && typeof selectSymbol === 'function'){
        selectSymbol(row.dataset.sym);
      }
    });
  }
}


function settingsContent(){
  const soundRow = typeof soundToggleRow === 'function' ? soundToggleRow() : '';
  const bank = state.bank || { balance: 0, loan: 0, loanDaysLeft: 0 };
  return `
    ${soundRow ? `<div class="settings-block">${soundRow}</div>` : ''}
    <div class="nav-modal-list">
      <button class="nav-modal-item" id="replayTutorialBtn" style="cursor:pointer;background:none;border:none;width:100%;text-align:left"><span>📖 Ver tutorial de nuevo</span><em>↻</em></button>
      <div class="nav-modal-item"><span>🏦 En el banco</span><em class="mono">${money(bank.balance)}${bank.loan > 0 ? ` · deuda ${money(bank.loan)}` : ''}</em></div>
      <div class="nav-modal-item"><span>📋 Órdenes en espera</span><em>${(state.orders || []).length}</em></div>
      <div class="nav-modal-item"><span>Nivel actual</span><em>${state.level}</em></div>
      <div class="nav-modal-item"><span>XP acumulada</span><em>${state.xp} / ${xpToNext()}</em></div>
      <div class="nav-modal-item"><span>Símbolos en favoritos</span><em>${state.watchlist.length}</em></div>
      <div class="nav-modal-item"><span>Notificaciones guardadas</span><em>${state.notifications.length}</em></div>
      <div class="nav-modal-item"><span>Boosters activos</span><em>${state.xpBoost ? `XP ×${state.xpBoost.mult}` : '—'}</em></div>
    </div>
  `;
}


function switchView(view){
  currentView = view;
  document.querySelectorAll('.hud-tab').forEach(b=> b.classList.toggle('is-active', b.dataset.view===view));
  // las vistas se buscan una a una: si alguna falta en el markup, cambiar de
  // pestaña no debe reventar el resto de la interfaz
  const trading = document.getElementById('viewTrading');
  if(trading) trading.style.display = view==='trading' ? '' : 'none';
  const research = document.getElementById('viewResearch');
  if(research) research.classList.toggle('is-visible', view==='research');
  const empire = document.getElementById('viewEmpire');
  if(empire) empire.classList.toggle('is-visible', view==='empire');
  if(view==='research' && typeof renderResearchView==='function') renderResearchView();
  if(view==='empire'){ renderAccountStats(); renderWatchlist(); }
  // the chart was sized while it was hidden, so redraw it when it shows again
  if(view==='trading' && typeof refreshChartLayout==='function') refreshChartLayout();
}

function initHud(){
  document.querySelectorAll('.hud-tab').forEach(btn=>{
    btn.addEventListener('click', ()=> switchView(btn.dataset.view));
  });

  const bellBtn = document.getElementById('hudBellBtn');
  const dropdown = document.getElementById('hudNotifDropdown');
  if(bellBtn && dropdown){
    bellBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const opening = !dropdown.classList.contains('is-open');
      dropdown.classList.toggle('is-open');
      if(opening) markNotificationsRead();
    });
    document.addEventListener('click', (e)=>{
      if(!dropdown.contains(e.target) && e.target!==bellBtn){
        dropdown.classList.remove('is-open');
      }
    });
  }
  const clearNotifs = document.getElementById('hudClearNotifs');
  if(clearNotifs) clearNotifs.addEventListener('click', ()=>{
    state.notifications = [];
    state.unreadNotifs = 0;
    renderNotifications();
  });

  const settingsBtn = document.getElementById('hudSettingsBtn');
  if(settingsBtn) settingsBtn.addEventListener('click', ()=>{
    openNavModal('Ajustes', settingsContent());
    if(typeof bindSoundToggle === 'function') bindSoundToggle(document.getElementById('navModalBody'));
    const replay = document.getElementById('replayTutorialBtn');
    if(replay) replay.addEventListener('click', ()=>{
      closeNavModal();
      if(typeof Onboarding !== 'undefined') Onboarding.replay();
    });
  });

  updateHud();
}
