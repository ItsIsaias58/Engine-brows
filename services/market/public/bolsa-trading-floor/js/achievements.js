// logros persistentes. cada uno es una condición sobre el estado de la partida;
// se revisan en un latido lento (5s) en vez de en cada acción, así que añadir un
// logro nunca obliga a tocar order.js o portfolio.js. el desbloqueo se guarda
// en localStorage y, cuando el logro otorga un título, se lo pasa al perfil.
const ACHIEVEMENTS_KEY = 'bolsa-achievements-v1';
const ACHIEVEMENT_XP = 20;

const ACHIEVEMENTS = [
  { id: 'first_trade',  icon: '🎯', name: 'Primer trade',       desc: 'Haz tu primera compra',
    check: () => state.transactions.some(t => t.type === 'Compra' && t.sym !== 'RECAP') },
  { id: 'first_win',    icon: '💰', name: 'Primera ganancia',   desc: 'Cierra una operación en positivo',
    check: () => state.stats.wins > 0 },
  { id: 'first_loss',   icon: '🩸', name: 'Primera herida',     desc: 'Cierra una operación en negativo',
    check: () => state.stats.losses > 0 },
  { id: 'streak_5',     icon: '🔥', name: 'En racha',           desc: '5 operaciones ganadoras seguidas',
    check: () => (state.stats.bestStreak || 0) >= 5 },
  { id: 'streak_10',    icon: '🌟', name: 'Bola de cristal',    desc: '10 operaciones ganadoras seguidas',
    check: () => (state.stats.bestStreak || 0) >= 10, title: 'bola' },
  { id: 'diversified',  icon: '📊', name: 'Diversificado',      desc: '5 sectores abiertos a la vez',
    check: () => sectorsHeld().size >= 5, title: 'diverso' },
  { id: 'leverage_20',  icon: '🚀', name: 'Sin miedo',          desc: 'Opera con apalancamiento x20',
    check: () => state.transactions.some(t => (t.leverage || 1) >= 20), title: 'sinmiedo' },
  { id: 'million',      icon: '💵', name: 'Primer millón',      desc: 'Patrimonio por encima de $1M',
    check: () => netWorth() > 1_000_000 },
  { id: 'two_million',  icon: '🦈', name: 'Doble millón',       desc: 'Patrimonio por encima de $2M',
    check: () => netWorth() > 2_000_000 },
  { id: 'ten_million',  icon: '🏆', name: 'Millonario',         desc: 'Patrimonio por encima de $10M',
    check: () => netWorth() > 10_000_000, title: 'magnate' },
  { id: 'hundred_m',    icon: '💎', name: 'Diamante',           desc: 'Patrimonio por encima de $100M',
    check: () => netWorth() > 100_000_000, title: 'diamante' },
  { id: 'bankrupt',     icon: '💀', name: 'Manos vacías',       desc: 'Llega a la bancarrota',
    check: () => (state.stats.timesBankrupt || 0) > 0 || state.bankrupt === true },
  { id: 'phoenix',      icon: '🦅', name: 'Fénix',              desc: 'Recupérate a $100K tras quebrar',
    check: () => (state.stats.timesBankrupt || 0) > 0 && netWorth() > 100_000, title: 'fenix' },
  { id: 'case_1',       icon: '🎁', name: 'Apostador',          desc: 'Abre tu primera caja',
    check: () => (state.caseHistory || []).length >= 1 },
  { id: 'case_10',      icon: '🎰', name: 'Jugador',            desc: 'Abre 10 cajas',
    check: () => (state.caseHistory || []).length >= 10 },
  { id: 'golden',       icon: '🎫', name: 'Boleto dorado',      desc: 'Gana un Golden Ticket',
    check: () => (state.goldenTickets || 0) > 0 },
  { id: 'quest_all',    icon: '✅', name: 'Misiones',           desc: 'Completa las misiones de la academia',
    check: () => state.quests.firstBuy && state.quests.diversify },
  { id: 'watchlist_5',  icon: '⭐', name: 'Observador',         desc: 'Sigue 5 empresas',
    check: () => state.watchlist.length >= 5 },
  { id: 'watchlist_10', icon: '✨', name: 'Vigía',              desc: 'Sigue 10 empresas',
    check: () => state.watchlist.length >= 10 },
  { id: 'trades_50',    icon: '📈', name: 'Trader activo',      desc: '50 operaciones cerradas',
    check: () => state.stats.totalTrades >= 50 },
  { id: 'trades_200',   icon: '🐺', name: 'Veterano',           desc: '200 operaciones cerradas',
    check: () => state.stats.totalTrades >= 200 },
  { id: 'perfect_day',  icon: '☀️', name: 'Día perfecto',       desc: 'Sube un 20% en un solo día de juego',
    check: () => (state.stats.bestDayReturn || 0) >= 20 },
  { id: 'level_10',     icon: '🎖️', name: 'Operador de piso',   desc: 'Alcanza el nivel 10',
    check: () => state.level >= 10 },
  { id: 'level_40',     icon: '🦈', name: 'Tiburón del mercado', desc: 'Alcanza el nivel 40',
    check: () => state.level >= 40, title: 'tiburon' },
];

function sectorsHeld(){
  const set = new Set();
  Object.keys(state.positions).forEach(sym => {
    const m = bySym(sym);
    if(m && m.sector && state.positions[sym].shares > 0) set.add(m.sector);
  });
  return set;
}

const Achievements = {
  state: {},

  load(){
    try{
      const raw = localStorage.getItem(ACHIEVEMENTS_KEY);
      if(raw) this.state = JSON.parse(raw) || {};
    }catch(e){ this.state = {}; }
    if(!this.state || typeof this.state !== 'object') this.state = {};
    return this.state;
  },

  save(){
    try{ localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(this.state)); }catch(e){}
  },

  // returns how many were unlocked in this pass, so a caller can react
  check(){
    let unlocked = 0;
    for(const a of ACHIEVEMENTS){
      if(this.state[a.id]) continue;
      let hit = false;
      try{ hit = !!a.check(); }catch(e){ hit = false; }
      if(!hit) continue;
      this.state[a.id] = true;
      this.unlock(a);
      unlocked += 1;
    }
    if(unlocked) this.save();
    return unlocked;
  },

  unlock(a){
    if(typeof Sound !== 'undefined') Sound.play('achievement');
    if(typeof addXp === 'function') addXp(ACHIEVEMENT_XP);
    if(typeof toast === 'function') toast(`${a.icon} Logro desbloqueado`, `${a.name} · +${ACHIEVEMENT_XP} XP`, 'gold');
    // la campanada del logro sustituye a la campanita de la notificación
    if(typeof pushNotification === 'function'){
      if(typeof suppressNextNotify === 'function') suppressNextNotify();
      pushNotification(`${a.icon} ${a.name}`, `${a.desc} · +${ACHIEVEMENT_XP} XP`, 'gold');
    }
    if(a.title && typeof Profile !== 'undefined' && Profile.unlockTitle) Profile.unlockTitle(a.title);
  },

  list(){
    return ACHIEVEMENTS.map(a => ({ ...a, done: !!this.state[a.id] }));
  },

  progress(){
    const done = ACHIEVEMENTS.filter(a => this.state[a.id]).length;
    return { done, total: ACHIEVEMENTS.length, pct: (done / ACHIEVEMENTS.length) * 100 };
  },

  // the next three, ordered by how close they are: the panel shows them first
  nextUp(limit = 3){
    return this.list().filter(a => !a.done).slice(0, limit);
  },
};

function achievementsContent(){
  const list = Achievements.list();
  const p = Achievements.progress();
  return `
    <div class="ach-head">
      <div class="ach-progress">
        <span><strong>${p.done}</strong> / ${p.total} logros desbloqueados</span>
        <div class="ach-bar"><div style="width:${p.pct.toFixed(1)}%"></div></div>
      </div>
    </div>
    <div class="ach-grid">
      ${list.map(a => `
        <div class="ach-card ${a.done ? 'is-done' : 'is-locked'}">
          <div class="ach-icon">${a.done ? a.icon : '🔒'}</div>
          <div class="ach-info">
            <strong>${a.name}</strong>
            <span>${a.desc}</span>
            ${a.title ? `<em class="ach-title">título: ${a.title}</em>` : ''}
          </div>
        </div>`).join('')}
    </div>`;
}
