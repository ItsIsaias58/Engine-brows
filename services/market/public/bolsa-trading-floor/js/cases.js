// cajas de mercado: un minijuego de recompensas aleatorias que le da uso al
// cash. no hay loot boxes de pago: todo se compra con dinero del juego y nada
// sale del navegador. el coste se cobra antes de girar, la recompensa se aplica
// al terminar la animación y todo queda en state (y por tanto en el guardado).
const CASES = {
  barrio: {
    name: 'Caja de Barrio', cost: 500, color: '#8A94A6',
    pools: [
      { w: 55, kind: 'xp',     rarity: 'común',      amount: [30, 90] },
      { w: 30, kind: 'cash',   rarity: 'común',      amount: [200, 800] },
      { w: 12, kind: 'shares', rarity: 'poco común', shares: [1, 3], syms: 'low' },
      { w: 3,  kind: 'boost',  rarity: 'raro',       amount: [1.5, 2], hours: 1 },
    ],
  },
  suelo: {
    name: 'Caja de Suelo', cost: 5000, color: '#5B8CFF',
    pools: [
      { w: 45, kind: 'cash',   rarity: 'común',      amount: [1000, 5000] },
      { w: 28, kind: 'shares', rarity: 'poco común', shares: [1, 5], syms: 'mid' },
      { w: 15, kind: 'xp',     rarity: 'poco común', amount: [100, 300] },
      { w: 8,  kind: 'boost',  rarity: 'raro',       amount: [2, 3], hours: 1 },
      { w: 3,  kind: 'shares', rarity: 'épico',      shares: [1, 2], syms: 'high' },
      { w: 1,  kind: 'golden', rarity: 'legendario', amount: 1 },
    ],
  },
  tiburon: {
    name: 'Caja de Tiburón', cost: 50000, color: '#F2B84B',
    pools: [
      { w: 40,  kind: 'cash',   rarity: 'común',      amount: [20000, 80000] },
      { w: 25,  kind: 'shares', rarity: 'poco común', shares: [5, 20], syms: 'mid' },
      { w: 15,  kind: 'boost',  rarity: 'raro',       amount: [3, 5], hours: 2 },
      { w: 12,  kind: 'shares', rarity: 'épico',      shares: [3, 8], syms: 'high' },
      { w: 5,   kind: 'skin',   rarity: 'épico',      id: 'neon' },
      { w: 2.5, kind: 'golden', rarity: 'legendario', amount: 1 },
      { w: 0.5, kind: 'jackpot', rarity: 'legendario' },
    ],
  },
};

function pickFromPool(pool){
  const total = pool.reduce((sum, entry) => sum + entry.w, 0);
  let roll = Math.random() * total;
  for(const entry of pool){
    roll -= entry.w;
    if(roll <= 0) return entry;
  }
  return pool[pool.length - 1];
}

function symbolsForTier(tier){
  const list = MARKET.filter(m => {
    if(tier === 'low') return m.price < 100;
    if(tier === 'mid') return m.price >= 100 && m.price < 200;
    if(tier === 'high') return m.price >= 200;
    return true;
  });
  return list.length ? list : MARKET;
}

function resolveCaseReward(caseId){
  const config = CASES[caseId];
  if(!config) return null;
  const pick = pickFromPool(config.pools);
  const rnd = (a, b) => a + Math.random() * (b - a);

  switch(pick.kind){
    case 'cash':
      return { kind:'cash', rarity:pick.rarity, amount: rnd(pick.amount[0], pick.amount[1]) };
    case 'xp':
      return { kind:'xp', rarity:pick.rarity, amount: rnd(pick.amount[0], pick.amount[1]) };
    case 'shares': {
      const pool = symbolsForTier(pick.syms);
      const m = pool[Math.floor(Math.random() * pool.length)];
      const shares = Math.floor(rnd(pick.shares[0], pick.shares[1] + 1));
      return { kind:'shares', rarity:pick.rarity, sym:m.sym, shares:Math.max(1, shares) };
    }
    case 'boost':
      return { kind:'boost', rarity:pick.rarity, mult:rnd(pick.amount[0], pick.amount[1]), hours:pick.hours };
    case 'golden':
      return { kind:'golden', rarity:pick.rarity, amount:pick.amount };
    case 'skin':
      return { kind:'skin', rarity:pick.rarity, id:pick.id };
    case 'jackpot':
      return { kind:'jackpot', rarity:pick.rarity, amount: 100000 + Math.random() * 400000 };
    default:
      return { kind:'cash', rarity:'común', amount: rnd(100, 500) };
  }
}

const CASE_VISUALS = {
  cash:    { icon:'💵', label:'Cash' },
  xp:      { icon:'⭐', label:'XP' },
  shares:  { icon:'📈', label:'Acciones' },
  boost:   { icon:'⚡', label:'Booster' },
  golden:  { icon:'🎫', label:'Golden' },
  skin:    { icon:'🎨', label:'Skin' },
  jackpot: { icon:'💎', label:'JACKPOT' },
};

const RARITY_COLOR = {
  'común': '#8A94A6',
  'poco común': '#29E0A8',
  'raro': '#5B8CFF',
  'épico': '#B54BFF',
  'legendario': '#F2B84B',
};

const CaseGame = {
  open: false,
  spinning: false,

  show(){
    // the click that opens the panel is also the gesture the browser needs
    // before any audio can start
    if(typeof Sound !== 'undefined') Sound.ensure();
    let overlay = document.getElementById('caseOverlay');
    if(!overlay) overlay = this.build();
    overlay.classList.add('is-visible');
    this.open = true;
    this.render();
  },

  hide(){
    const overlay = document.getElementById('caseOverlay');
    if(overlay) overlay.classList.remove('is-visible');
    this.open = false;
    this.spinning = false;
  },

  build(){
    const el = document.createElement('div');
    el.id = 'caseOverlay';
    el.className = 'case-overlay';
    el.innerHTML = `
      <div class="case-panel" role="dialog" aria-modal="true" aria-label="Cajas de mercado">
        <header class="case-head">
          <h2>🎁 Cajas de mercado</h2>
          <button class="scrub-btn" id="caseClose" aria-label="Cerrar">✕</button>
        </header>
        <div class="case-body" id="caseBody"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#caseClose').addEventListener('click', () => this.hide());
    el.addEventListener('click', (e) => { if(e.target === el) this.hide(); });
    return el;
  },

  render(){
    const body = document.getElementById('caseBody');
    if(!body) return;
    const boost = typeof xpBoostActive === 'function' ? xpBoostActive() : null;
    body.innerHTML = `
      <p class="case-intro">
        Paga con tu cash del juego para abrir una caja. Recompensas aleatorias: dinero, acciones,
        XP, boosters y cosméticos. El coste se cobra siempre, ganes lo que ganes.
        ${boost ? `<br><strong class="pos">⚡ Booster activo: XP ×${boost.mult.toFixed(1)}</strong>` : ''}
      </p>
      <div class="case-grid">
        ${Object.entries(CASES).map(([id, c]) => `
          <div class="case-card" style="--case-color:${c.color}">
            <div class="case-visual">📦</div>
            <h3>${c.name}</h3>
            <p class="case-cost mono">${money(c.cost)}</p>
            <button class="case-open-btn" data-case="${id}" ${state.cash < c.cost || state.bankrupt ? 'disabled' : ''}>
              ${state.bankrupt ? 'Cuenta en bancarrota' : state.cash < c.cost ? 'Sin cash suficiente' : 'Abrir'}
            </button>
          </div>`).join('')}
      </div>
      ${this.historyHtml()}`;
    body.querySelectorAll('[data-case]').forEach(btn => {
      btn.addEventListener('click', () => this.spin(btn.dataset.case));
    });
  },

  historyHtml(){
    const history = (state.caseHistory || []).slice(0, 10);
    if(!history.length) return '';
    return `
      <div class="case-history">
        <h4>Aperturas recientes</h4>
        <div class="case-history-list">
          ${history.map(h => `
            <div class="case-history-row">
              <span class="mono">${new Date(h.t).toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' })}</span>
              <span>${h.label}</span>
              <em>${h.rarity || ''}</em>
            </div>`).join('')}
        </div>
      </div>`;
  },

  async spin(caseId){
    if(this.spinning) return;
    const config = CASES[caseId];
    if(!config || state.bankrupt || state.cash < config.cost) return;
    // se bloquea antes de cualquier await: dos clics seguidos no pueden abrir
    // dos cajas cobrando una
    this.spinning = true;

    // con sesión el coste y el sorteo los hace el servidor (cases.mjs): el
    // navegador ya no puede decidir cuánto vale un premio, sólo lo pinta. en
    // invitado —donde no hay a quién preguntarle— la ruleta es la de aquí
    let reward = null;
    const remote = typeof MarketNet !== 'undefined' && MarketNet.signedIn;
    if(remote){
      try{
        const data = await MarketNet.request('/api/market/cases/open', { method:'POST', body: JSON.stringify({ id: caseId }) });
        reward = data && data.reward;
        if(data && data.account) applyServerPortfolio(data.account.portfolio);
      }catch(e){
        this.spinning = false;
        toast('No se abrió la caja', (e && e.message) || 'el servidor no respondió', 'down');
        if(typeof Sound !== 'undefined') Sound.play('error');
        return;
      }
    } else {
      // the cost is taken up front: a case is a cash sink even when the reward is
      // smaller than the price
      state.cash -= config.cost;
      reward = resolveCaseReward(caseId);
    }
    if(!reward){ this.spinning = false; return; }

    // the roulette: ticks scheduled on the audio clock so they land exactly and
    // stretch out as the strip slows down
    if(typeof Sound !== 'undefined') Sound.spin(4200, 34);

    const WINNER_INDEX = 32;
    const strip = [];
    for(let i = 0; i < 40; i += 1){
      const visual = CASE_VISUALS[pickFromPool(config.pools).kind] || CASE_VISUALS.cash;
      strip.push(visual);
    }
    strip[WINNER_INDEX] = CASE_VISUALS[reward.kind] || CASE_VISUALS.cash;

    const body = document.getElementById('caseBody');
    body.innerHTML = `
      <div class="case-spin-wrap">
        <div class="case-spin-marker"></div>
        <div class="case-spin-track" id="caseStrip">
          ${strip.map(v => `
            <div class="case-spin-item">
              <span class="case-spin-icon">${v.icon}</span>
              <span class="case-spin-label">${v.label}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="case-spin-result" id="caseResult"></div>`;
    const track = body.querySelector('#caseStrip');
    this.spinning = true;

    requestAnimationFrame(() => {
      const itemW = 90;
      const center = (track.parentElement.clientWidth || 600) / 2;
      const target = -(WINNER_INDEX * itemW + itemW / 2) + center;
      track.style.transition = 'transform 4.2s cubic-bezier(.17,.67,.16,1)';
      track.style.transform = `translateX(${target}px)`;
    });

    setTimeout(() => {
      this.spinning = false;
      this.applyReward(reward, caseId, remote);
    }, 4300);
  },

  // `remote` = el premio ya está aplicado en el servidor: aquí sólo se pinta.
  // el XP, los boosters y los golden tickets siguen siendo estado del cliente
  applyReward(reward, caseId, remote = false){
    // the fanfare scales with the rarity, and the jackpot gets its own
    if(typeof Sound !== 'undefined'){
      if(reward.kind === 'jackpot') Sound.play('jackpot');
      else Sound.play('win', { rarity: reward.rarity });
    }
    const result = document.getElementById('caseResult');
    let label = '', detail = '';

    switch(reward.kind){
      case 'cash':
        if(!remote) state.cash += reward.amount;
        label = `💵 +${money(reward.amount)}`;
        detail = 'Dinero acreditado a tu cuenta';
        break;
      case 'xp':
        addXp(Math.round(reward.amount));
        label = `⭐ +${Math.round(reward.amount)} XP`;
        detail = 'Experiencia ganada';
        break;
      case 'shares': {
        const m = bySym(reward.sym);
        if(m){
          if(!remote){
            const pos = state.positions[m.sym] || { shares:0, avgPrice:0, leverage:1, margin:0 };
            const newShares = pos.shares + reward.shares;
            state.positions[m.sym] = {
              shares: newShares,
              avgPrice: ((pos.avgPrice * pos.shares) + (m.price * reward.shares)) / newShares,
              leverage: 1,
              margin: (pos.margin || 0) + m.price * reward.shares,
              tp: pos.tp || null,
              sl: pos.sl || null,
              trailPct: pos.trailPct || null,
              trailPeak: pos.trailPeak || m.price,
            };
          }
          label = `📈 ${reward.shares} × ${m.sym}`;
          detail = `${m.name} añadidas a tu cartera`;
        } else {
          label = '📈 Acciones';
          detail = 'La empresa ya no existe';
        }
        break;
      }
      case 'boost':
        state.xpBoost = { mult: reward.mult, until: Date.now() + reward.hours * 3600000 };
        label = `⚡ XP ×${reward.mult.toFixed(1)} durante ${reward.hours}h`;
        detail = 'Booster activo';
        break;
      case 'golden':
        state.goldenTickets = (state.goldenTickets || 0) + reward.amount;
        label = `🎫 Golden Ticket ×${reward.amount}`;
        detail = 'Vale por una acción gratuita';
        break;
      case 'skin':
        // en remoto el servidor ya lo metió en caseSkins y applyServerPortfolio
        // lo dejó en state.skins; aquí sólo se anuncia
        if(!remote){
          state.skins = Array.isArray(state.skins) ? state.skins : [];
          if(!state.skins.includes(reward.id)) state.skins.push(reward.id);
        }
        label = `🎨 Skin "${reward.id}"`;
        detail = 'Desbloqueada en tu perfil';
        break;
      case 'jackpot':
        if(!remote) state.cash += reward.amount;
        label = `💎 JACKPOT +${money(reward.amount)}`;
        detail = '¡Enhorabuena!';
        this.confetti();
        break;
      default:
        label = '❔ Vacío';
        detail = 'Esta vez no salió nada';
    }

    state.caseHistory = state.caseHistory || [];
    state.caseHistory.unshift({ t: Date.now(), label, rarity: reward.rarity, case: caseId });
    if(state.caseHistory.length > 30) state.caseHistory.length = 30;

    if(result){
      result.innerHTML = `
        <div class="case-result-card" style="--rarity:${RARITY_COLOR[reward.rarity] || RARITY_COLOR['común']}">
          <span class="case-result-rarity">${reward.rarity}</span>
          <strong>${label}</strong>
          <span>${detail}</span>
        </div>
        <div class="case-result-actions">
          <button class="nav-modal-btn" id="caseAgain">Abrir otra</button>
          <button class="nav-modal-btn" id="caseDone">Listo</button>
        </div>`;
      const again = document.getElementById('caseAgain');
      if(again) again.addEventListener('click', () => this.render());
      const done = document.getElementById('caseDone');
      if(done) done.addEventListener('click', () => this.hide());
    }

    toast('🎁 Caja abierta', label, reward.rarity === 'legendario' ? 'gold' : 'up');
    pushNotification('🎁 Caja abierta', `${label} · ${detail}`, reward.rarity === 'legendario' ? 'gold' : 'up');
    if(typeof addXp === 'function') addXp(4);

    saveGame();
    updatePerformancePanel();
    renderPositions();
    renderTransactions();
    if(typeof updateHud === 'function') updateHud();
    if(typeof Achievements !== 'undefined') Achievements.check();
  },

  confetti(){
    for(let i = 0; i < 60; i += 1){
      const el = document.createElement('div');
      el.className = 'case-confetti';
      el.style.left = `${Math.random() * 100}%`;
      el.style.background = ['#29E0A8','#5B8CFF','#F2B84B','#FF5C7A','#B54BFF'][i % 5];
      el.style.animationDelay = `${(Math.random() * 0.4).toFixed(2)}s`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    }
  },
};

// the header gift button opens the cases; the rail's "Progreso" button has its
// own tab that does the same, so no second rail button is needed
function initCases(){
  const btn = document.getElementById('hudCasesBtn');
  if(btn) btn.addEventListener('click', () => CaseGame.show());
  // el precio de una caja es dato del mundo: se pide al servidor para que el
  // panel de invitado y el sorteo server-side no puedan separarse (lo mismo
  // que hace opencase con /api/market/skins/catalog). si no hay red, la tabla
  // local sigue en pie: sólo cambia el precio que se muestra
  fetch('/api/market/cases')
    .then(r => r.ok ? r.json() : null)
    .then(payload => {
      for(const entry of (payload && payload.cases) || []){
        const config = CASES[entry.id];
        if(config) config.cost = entry.cost;
      }
    })
    .catch(() => {});
}
