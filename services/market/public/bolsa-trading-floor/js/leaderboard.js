// ranking. el servidor expone /api/market/leaderboard (posición real de cada
// cuenta, calculada con las carteras guardadas y los precios vivos). si el
// endpoint no responde —invitado, servidor viejo, sin red— se genera un ranking
// local *determinista* (mismo nombre -> mismo patrimonio) para que el modo
// offline no quede vacío. nunca se inventa el puesto de quien juega: el suyo
// siempre sale de su propio estado.
const LEADERBOARD_CACHE_MS = 60_000;
const LEADERBOARD_RANKS_KEY = 'bolsa-lb-ranks-v1';

const LEADERBOARD_METRICS = [
  ['net', '💰 Dinero'],
  ['roi', '📈 ROI'],
  ['winrate', '🎯 Winrate'],
  ['best', '🏆 Mejor trade'],
  ['streak', '🔥 Racha'],
];

const LEADERBOARD_PERIODS = [
  ['all', 'Histórico'],
  ['month', 'Este mes'],
  ['week', 'Esta semana'],
  ['today', 'Hoy'],
];

let leaderboardCache = { at: 0, data: null, key: '' };

const Leaderboard = {
  metric: 'net',
  period: 'all',

  metricKey(){
    return this.metric === 'net' ? 'net'
      : this.metric === 'roi' ? 'roi'
      : this.metric === 'winrate' ? 'winrate'
      : this.metric === 'best' ? 'best' : 'streak';
  },

  cacheKey(){
    return `${this.metric}|${this.period}`;
  },

  async fetch(force = false){
    const key = this.cacheKey();
    if(!force && leaderboardCache.data && leaderboardCache.key === key
      && Date.now() - leaderboardCache.at < LEADERBOARD_CACHE_MS){
      return leaderboardCache.data;
    }
    let data = null;
    if(typeof MarketNet !== 'undefined' && MarketNet.request){
      try{
        data = await MarketNet.request(
          `/api/market/leaderboard?metric=${this.metric}&period=${this.period}&limit=100`,
        );
      }catch(e){ data = null; }
    }
    if(!data || !Array.isArray(data.entries) || !data.entries.length) data = this.generateLocal();
    this.rememberRanks(data.entries);
    leaderboardCache = { at: Date.now(), data, key };
    return data;
  },

  // keeps last run's rank per player so the table can show ▲/▼
  rememberRanks(entries){
    let previous = {};
    try{ previous = JSON.parse(localStorage.getItem(LEADERBOARD_RANKS_KEY) || '{}') || {}; }catch(e){ previous = {}; }
    entries.forEach(e => {
      const before = previous[e.id];
      e.delta = Number.isFinite(before) && before !== e.rank ? before - e.rank : 0;
    });
    const next = {};
    entries.slice(0, 100).forEach(e => { next[e.id] = e.rank; });
    try{ localStorage.setItem(LEADERBOARD_RANKS_KEY, JSON.stringify(next)); }catch(e){}
    return entries;
  },

  // ------------------------------------------------------------------ offline
  // deterministic bots: the same name always produces the same numbers, so the
  // table does not reshuffle every time it is opened
  generateLocal(){
    const hash = (name) => {
      let h = 2166136261;
      for(let i = 0; i < name.length; i += 1){
        h ^= name.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    const first = ['Carlos','Lucía','Mateo','Sofía','Diego','Valentina','Andrés','Camila','Javier','Isabella',
      'Ricardo','Renata','Santiago','Daniela','Emilio','Mariana','Alejandro','Fernanda','Sebastián','Ximena'];
    const last = ['García','Martínez','López','Rodríguez','Pérez','Sánchez','Ramírez','Torres','Flores','Rivera',
      'Gómez','Díaz','Cruz','Morales','Ortiz','Hernández'];

    const entries = [];
    for(let i = 0; i < 240; i += 1){
      const name = `${first[i % first.length]}${last[(i * 7) % last.length]}${i > 40 ? i : ''}`;
      const r = hash(name);
      const tier = (r % 1000) / 1000;
      const net = tier < 0.6 ? 10_000 + (r % 90_000)
        : tier < 0.9 ? 100_000 + (r % 900_000)
        : tier < 0.99 ? 1_000_000 + (r % 9_000_000)
        : 10_000_000 + (r % 600_000_000);
      entries.push({
        id: `bot-${i}`,
        name,
        bot: true,
        net,
        roi: ((net - START_CASH) / START_CASH) * 100,
        winrate: 40 + (r % 40),
        best: net * (0.05 + (r % 30) / 100),
        streak: r % 15,
        level: 1 + Math.round((r % 60)),
        avatar: null,
        title: null,
      });
    }

    const me = this.meEntry();
    entries.push(me);
    const key = this.metricKey();
    entries.sort((a, b) => (b[key] || 0) - (a[key] || 0));
    entries.forEach((e, i) => { e.rank = i + 1; });
    me.you = true;
    return {
      metric: this.metric,
      period: this.period,
      updatedAt: Date.now(),
      total: entries.length,
      offline: true,
      entries,
      me,
    };
  },

  meEntry(){
    const net = netWorth();
    const wr = winRatePct();
    return {
      id: (typeof MarketNet !== 'undefined' && MarketNet.signedIn) ? (MarketNet.accountName || 'tú') : 'tú',
      name: (typeof MarketNet !== 'undefined' && MarketNet.accountName) || 'tú',
      you: true,
      net,
      roi: ((net - START_CASH) / START_CASH) * 100,
      winrate: wr === null ? 0 : wr,
      best: state.stats.bestTrade || 0,
      streak: state.stats.bestStreak || 0,
      level: state.level,
      avatar: typeof profile !== 'undefined' ? profile.avatar : null,
      title: typeof profile !== 'undefined' ? Profile.titleName(profile.title) : null,
    };
  },

  format(e){
    switch(this.metric){
      case 'roi': return `${e.roi >= 0 ? '+' : ''}${(e.roi || 0).toFixed(1)}%`;
      case 'winrate': return `${Math.round(e.winrate || 0)}%`;
      case 'best': return money(e.best || 0);
      case 'streak': return `${e.streak || 0} 🔥`;
      default: return money(e.net || 0);
    }
  },

  bind(body){
    if(!body) return;
    body.querySelectorAll('[data-lb-metric]').forEach(btn => {
      btn.addEventListener('click', async () => {
        this.metric = btn.dataset.lbMetric;
        await this.repaint(body);
      });
    });
    body.querySelectorAll('[data-lb-period]').forEach(btn => {
      btn.addEventListener('click', async () => {
        this.period = btn.dataset.lbPeriod;
        await this.repaint(body);
      });
    });
  },

  async repaint(body){
    const target = body || document.getElementById('navModalBody');
    if(!target) return;
    target.innerHTML = '<div class="mini-empty">Cargando ranking…</div>';
    await this.fetch(true);
    target.innerHTML = leaderboardContent();
    this.bind(target);
  },
};

function leaderboardContent(){
  const d = leaderboardCache.data;
  if(!d || !d.entries) return '<div class="mini-empty">Cargando ranking…</div>';
  const me = d.me || Leaderboard.meEntry();
  const rows = d.entries.slice(0, 100);
  const key = Leaderboard.metricKey();
  const medal = (r) => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : String(r);
  const arrow = (delta) => delta > 0 ? `<span class="lb-delta pos">▲${delta}</span>`
    : delta < 0 ? `<span class="lb-delta neg">▼${Math.abs(delta)}</span>` : '';
  const ahead = rows.find(e => e.rank === me.rank - 1);

  return `
    <div class="lb-tabs">
      ${LEADERBOARD_METRICS.map(([id, label]) =>
        `<button class="lb-tab${Leaderboard.metric === id ? ' is-active' : ''}" data-lb-metric="${id}">${label}</button>`).join('')}
    </div>
    <div class="lb-tabs lb-tabs-period">
      ${LEADERBOARD_PERIODS.map(([id, label]) =>
        `<button class="lb-tab${Leaderboard.period === id ? ' is-active' : ''}" data-lb-period="${id}">${label}</button>`).join('')}
    </div>

    <div class="lb-you">
      <div class="lb-you-rank">#${me.rank || '—'}</div>
      <div class="lb-you-info">
        <strong>${me.name}</strong>
        <span class="lb-you-sub">${Leaderboard.format(me)} · de ${d.total} jugadores${d.offline ? ' · ranking local' : ''}</span>
      </div>
      <div class="lb-you-gap">
        <span class="lb-you-gap-label">${ahead ? `A un puesto de ${ahead.name}` : 'Vas primero'}</span>
        <strong class="mono">${ahead ? money(Math.max(0, (ahead[key] || 0) - (me[key] || 0))) : '—'}</strong>
      </div>
    </div>

    <div class="lb-table">
      <div class="lb-head"><span>#</span><span>Jugador</span><span>${Leaderboard.metric === 'net' ? 'Patrimonio' : Leaderboard.metric === 'roi' ? 'ROI' : Leaderboard.metric === 'winrate' ? 'Winrate' : Leaderboard.metric === 'best' ? 'Mejor' : 'Racha'}</span></div>
      ${rows.map(e => `
        <div class="lb-row ${e.you ? 'is-you' : ''}" data-lb-id="${e.id}" title="${e.name}">
          <span class="lb-rank">${medal(e.rank)} ${arrow(e.delta || 0)}</span>
          <span class="lb-name">${e.avatar ? `<i class="lb-av">${e.avatar}</i>` : ''}${e.name}${e.you ? ' <em>(tú)</em>' : ''}${e.title ? `<small>${e.title}</small>` : ''}</span>
          <span class="lb-val mono">${Leaderboard.format(e)}</span>
        </div>`).join('')}
    </div>
    <p class="lb-foot">${d.offline ? 'Ranking local generado en tu navegador' : 'Ranking del servidor'} ·
      ${LEADERBOARD_PERIODS.find(p => p[0] === d.period)?.[1] || 'Histórico'} ·
      actualizado ${new Date(d.updatedAt || Date.now()).toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' })}</p>`;
}
