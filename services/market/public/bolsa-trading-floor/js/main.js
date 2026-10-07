
function init(){
  if(loadGame()){
    const tog = document.getElementById('sideToggle');
    if(tog) tog.dataset.side = side;
    document.querySelectorAll('.side-btn').forEach(b=> b.classList.toggle('is-active', b.dataset.side===side));
    if(currentView!=='trading') switchView(currentView);
  }
  buildTicker();
  buildSectorChips();
  buildMarketRows();
  if(typeof renderMarketIndex === 'function') renderMarketIndex();
  if(typeof Heatmap !== 'undefined'){
    const heatBtn = document.getElementById('heatmapOpenBtn');
    if(heatBtn) heatBtn.addEventListener('click', () => openHeatmap());
  }
  updateQuoteBlock();
  initChart();
  initCollapse();
  initOrderPanel();
  initRailNav();
  initCloseTimer();
  initHud();
  buildEarningsSchedule();
  renderResearchView();
  updatePerformancePanel();
  renderPositions();
  renderWatchlist();
  recalcOrder();
  checkQuests();

  // the progression systems: the profile and the achievements come back from
  // localStorage before anything paints, so the avatar and the counters are
  // right on the first frame
  // the sound preference is read before anything can play: the audio context
  // itself is only created on the first click (browser autoplay policy)
  if(typeof Sound !== 'undefined') Sound.load();
  if(typeof Profile !== 'undefined'){ Profile.load(); refreshAvatarVisuals(); }
  if(typeof Achievements !== 'undefined') Achievements.load();
  if(typeof Events !== 'undefined') Events.init();
  if(typeof initCases === 'function') initCases();
  if(typeof initPriceAlerts === 'function') initPriceAlerts();
  // sondo: el banner de sondeos y su cuenta regresiva viven en js/polls.js
  if(typeof Polls !== 'undefined') Polls.init();
  // el tutorial sólo aparece para quien no lo ha cerrado antes
  if(typeof Onboarding !== 'undefined') Onboarding.maybeShow();
  // banco y órdenes en espera: el libro local se pinta desde el primer frame;
  // con sesión Bank.refresh() trae la verdad del server al primer login
  if(typeof renderRestingOrders === 'function') renderRestingOrders();
  if(typeof Bank !== 'undefined' && Bank.refresh) Bank.refresh();

  marketUiReady = true;
  refreshTickUi();
  startLiveClock();
  initAuth();
  renderTape();

  setInterval(tickMarket, 1400);
  // progress is measured on a slow beat: one net-worth sample every 15s (the
  // sparkline and the drawdown read it) and the achievement sweep every 5s
  setInterval(trackNetProgress, 15000);
  setInterval(() => { if(typeof Achievements !== 'undefined') Achievements.check(); }, 5000);
  setInterval(() => { if(typeof Profile !== 'undefined') Profile.checkUnlocks(); }, 15000);
  setInterval(tickBankruptcy, 250);
  setInterval(tickEarningsCountdowns, 1000);
  // the game's own day beat: guest-side bank interest, the local loan clock and
  // the local resting-order fills ride on it. with a session the server does
  // the accrual, but the local day tick still drives the dividend schedule chip
  let lastFinanceDay = Math.floor(currentGameTime() / 86400000);
  setInterval(() => {
    const day = Math.floor(currentGameTime() / 86400000);
    if(day === lastFinanceDay) return;
    lastFinanceDay = day;
    if(typeof Bank !== 'undefined' && Bank.localDayTick) Bank.localDayTick();
  }, 1000);
  // órdenes limit/stop en modo invitado: el server las lleva cuando hay sesión
  setInterval(() => { if(typeof checkLocalOrders === 'function') checkLocalOrders(); }, 1500);
  // headlines are rare on purpose: the offline fallback only fires one every
  // few game days, matching the server (about one per game week)
  setInterval(publishNews, 5 * 60 * 1000);
  setInterval(saveGame, 2000);
  window.addEventListener('beforeunload', () => {
    saveGame();
    if(typeof MarketNet !== 'undefined') MarketNet.savePortfolioNow();
  });
}

function startLiveClock(){
  const dateEl = document.getElementById('tickerDate');
  const statusEl = document.querySelector('.ticker-status');
  const moodEl = document.getElementById('tickerMood');
  const moodLabel = document.getElementById('tickerMoodLabel');
  // the market's mood, next to the clock: the server rolls a regime every few
  // game days (alcista / bajista / lateral) and this is the same one the model
  // is drifting on, so the badge never disagrees with the tape
  const moodText = { alcista: 'alcista', bajista: 'bajista', lateral: 'lateral' };
  const updateMood = () => {
    if(!moodEl || !moodLabel) return;
    const regime = typeof MarketNet !== 'undefined' ? MarketNet.regime : null;
    const kind = regime && typeof regime.kind === 'string' ? regime.kind : '';
    if(!kind){
      moodLabel.textContent = '--';
      moodEl.className = 'ticker-mood';
      moodEl.title = 'Humor del mercado: sin datos';
      return;
    }
    // `left` is game minutes; the clock runs at 1440x, so that is real minutes
    const leftGame = typeof regime.left === 'number' && Number.isFinite(regime.left) ? regime.left : null;
    const leftReal = leftGame === null ? null : Math.max(0, Math.round(leftGame / 1440));
    const strength = typeof regime.strength === 'number' && Number.isFinite(regime.strength)
      ? Math.round(regime.strength * 100)
      : null;
    moodLabel.textContent = leftReal === null
      ? (moodText[kind] || kind)
      : `${moodText[kind] || kind} · ${leftReal} min`;
    moodEl.className = 'ticker-mood' + (kind === 'alcista' ? ' is-up' : kind === 'bajista' ? ' is-down' : ' is-flat');
    moodEl.title = `Humor del mercado: ${moodText[kind] || kind}`
      + (leftReal === null ? '' : ` · quedan ~${leftReal} min (tiempo real)`)
      + (strength === null ? '' : ` · fuerza ${strength}%`);
  };
  const update = () => {
    updateMood();
    if(dateEl){
      // the market runs on game time: one real minute is one game day
      const now = new Date(typeof MarketNet !== 'undefined' ? MarketNet.gameTime : Date.now());
      dateEl.textContent = now.toLocaleDateString('es-MX',{day:'2-digit',month:'short',year:'numeric'})
        + ' · ' + now.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})
        + ' (juego)';
    }
    if(statusEl){
      const live = typeof MarketNet !== 'undefined' && MarketNet.live;
      statusEl.innerHTML = `<i class="dot"></i>${live?'Mercado en vivo':'Sin conexión al mercado'}`;
      statusEl.classList.toggle('is-offline', !live);
    }
  };
  update();
  setInterval(update, 1000);
}

document.addEventListener('DOMContentLoaded', init);
