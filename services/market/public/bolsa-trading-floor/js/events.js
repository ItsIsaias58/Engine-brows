// eventos encadenados: una noticia no llega sola, llega en una secuencia con
// consecuencias. cada cadena es una lista de pasos temporizados; el servidor las
// dispara (así todos los jugadores ven la misma historia) y este archivo las
// pinta, además de poder generarlas por su cuenta cuando no hay feed en vivo.
//
// la regla que hace que importe: el que compra al primer rumor gana, el que
// compra en la confirmación suele perder.
const EVENT_MIN_MS = 3 * 60 * 1000;
const EVENT_MAX_MS = 15 * 60 * 1000;
const EVENT_BANNER_REFRESH_MS = 1000;

const EVENT_CHAINS = [
  {
    id: 'pump_dump',
    weight: 10,
    label: 'Pump & Dump',
    build(){
      const pool = MARKET.filter(m => m.price < 150);
      const m = pool[Math.floor(Math.random() * pool.length)] || MARKET[0];
      return {
        sym: m.sym, name: m.name, tone: 'up',
        steps: [
          { t: 0,   pct: 6,   tone: 'up',   title: `📣 Rumor: fondos institucionales interesados en ${m.name}` },
          { t: 180, pct: 8,   tone: 'up',   title: `📈 ${m.name} firma un acuerdo millonario` },
          { t: 420, pct: -25, tone: 'down', title: `⚠️ El regulador investiga a ${m.name}` },
          { t: 600, pct: -5,  tone: 'down', title: `📉 Pánico vendedor en ${m.name}` },
        ],
      };
    },
  },
  {
    id: 'sector_fire',
    weight: 8,
    label: 'Sector en llamas',
    build(){
      const sectors = [...new Set(MARKET.map(m => m.sector))];
      const sector = sectors[Math.floor(Math.random() * sectors.length)];
      const syms = MARKET.filter(m => m.sector === sector).map(m => m.sym);
      return {
        sym: syms[0], name: `Sector ${sector}`, sector, tone: 'up', allSyms: syms,
        steps: [
          { t: 0,   pct: 6,   tone: 'up',   title: `🔥 El sector ${sector} se enciende: varias empresas suben juntas` },
          { t: 120, pct: 4,   tone: 'up',   title: `📊 Los analistas recomiendan el sector ${sector}` },
          { t: 480, pct: -30, tone: 'down', title: `💥 Estalla la burbuja del sector ${sector}` },
        ],
      };
    },
  },
  {
    id: 'earnings',
    weight: 6,
    label: 'Resultados',
    build(){
      const m = MARKET[Math.floor(Math.random() * MARKET.length)];
      const beat = Math.random() < 0.6;
      return {
        sym: m.sym, name: m.name, tone: beat ? 'up' : 'down',
        steps: [
          { t: 0,  pct: 0, tone: 'gold', title: `🗓️ ${m.name} reporta resultados en un minuto` },
          { t: 60, pct: beat ? 15 : -18, tone: beat ? 'up' : 'down',
            title: beat ? `💰 Beat: ${m.name} supera lo esperado` : `💔 Miss: ${m.name} decepciona al mercado` },
        ],
      };
    },
  },
  {
    id: 'whale',
    weight: 5,
    label: 'Ballena',
    build(){
      const m = MARKET[Math.floor(Math.random() * MARKET.length)];
      return {
        sym: m.sym, name: m.name, tone: 'up',
        steps: [
          { t: 0,   pct: 12, tone: 'up',   title: `🐋 Una ballena compra una posición enorme en ${m.name}` },
          { t: 240, pct: -8, tone: 'down', title: `🐋 La ballena liquida su posición en ${m.name}` },
        ],
      };
    },
  },
  {
    id: 'black_swan',
    weight: 2,
    label: 'Cisne negro',
    build(){
      return {
        sym: 'ALL', name: 'Mercado global', tone: 'down',
        allSyms: MARKET.map(m => m.sym),
        steps: [
          { t: 0,   pct: -15, tone: 'down', title: '🌍 Crisis geopolítica: el mercado se desploma' },
          { t: 600, pct: 8,   tone: 'up',   title: '🕊️ Rebote parcial tras la crisis' },
        ],
      };
    },
  },
];

const Events = {
  active: [],
  nextAt: 0,
  paused: false,
  remoteMode: false,   // true once the server has shown it runs the chains itself

  init(){
    this.scheduleNext();
    setInterval(() => this.tick(), 1000);
  },

  scheduleNext(){
    this.nextAt = Date.now() + EVENT_MIN_MS + Math.random() * (EVENT_MAX_MS - EVENT_MIN_MS);
  },

  // a trade makes the world feel alive: the next event comes sooner
  heat(){
    this.nextAt = Math.min(this.nextAt, Date.now() + 30000);
  },

  tick(){
    if(this.paused) return;
    // with a live feed the server owns the chains; generating a second set here
    // would fight the prices it sends on every tick
    if(typeof MarketNet !== 'undefined' && MarketNet.live) return;
    if(Date.now() < this.nextAt) return;
    this.fire();
    this.scheduleNext();
  },

  pickWeighted(){
    const total = EVENT_CHAINS.reduce((sum, c) => sum + c.weight, 0);
    let roll = Math.random() * total;
    for(const chain of EVENT_CHAINS){
      roll -= chain.weight;
      if(roll <= 0) return chain;
    }
    return EVENT_CHAINS[0];
  },

  // `instance` lets the server drive the same story: prices are already applied
  // there, so only the banner, the headline and the notifications are painted
  fire(chainId, serverInstance){
    const chain = chainId ? EVENT_CHAINS.find(c => c.id === chainId) : this.pickWeighted();
    if(!chain) return null;
    const instance = serverInstance || chain.build();
    const startedAt = Date.now();
    const duration = (instance.steps[instance.steps.length - 1].t || 0) * 1000;
    const ev = {
      id: `${chain.id}-${startedAt}`,
      chainId: chain.id,
      label: chain.label || instance.name,
      ...instance,
      startedAt,
      endsAt: startedAt + duration,
      timers: [],
    };
    this.remoteMode = this.remoteMode || Boolean(serverInstance);

    if(!serverInstance){
      instance.steps.forEach((step, index) => {
        const timer = setTimeout(() => {
          this.applyStep(ev, step);
          if(index === instance.steps.length - 1) this.finish(ev);
        }, step.t * 1000);
        ev.timers.push(timer);
      });
    } else {
      // the server sends an `event-step` per headline; the timers only retire
      // the banner
      ev.timers.push(setTimeout(() => this.finish(ev), Math.max(1000, duration)));
    }

    this.active.push(ev);
    this.bannerShow(ev);
    return ev;
  },

  // painted only for server history: `event-headline` carries each step
  headline(step){
    const time = new Date(typeof currentGameTime === 'function' ? currentGameTime() : Date.now())
      .toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' });
    if(typeof applyMarketNews === 'function'){
      applyMarketNews({ sym: step.sym || 'ALL', title: step.title, pct: step.pct || 0, time });
    }
  },

  applyStep(ev, step){
    const targets = step.allSyms || ev.allSyms || [ev.sym];
    targets.forEach(sym => {
      const m = typeof bySym === 'function' ? bySym(sym) : null;
      if(!m) return;
      const factor = 1 + (step.pct || 0) / 100;
      const before = typeof m.livePrice === 'number' ? m.livePrice : m.price;
      m.livePrice = safePrice(before * factor, before);
      m.liveChange = m.livePrice - m.prevClose;
      m.livePct = (m.liveChange / (m.prevClose || 1)) * 100;
      // sin conexión la cinta *es* el precio operable, igual que con el servidor
      m.price = m.livePrice;
      m.change = m.liveChange;
      m.pct = m.livePct;
      m.high = Math.max(m.high, m.livePrice);
      m.low = Math.min(m.low, m.livePrice);
    });

    this.headline({ ...step, sym: ev.sym });
    if(step.tone !== 'gold'){
      toast(step.tone === 'up' ? '📈 Evento' : '📉 Evento', step.title, step.tone || 'gold');
    }
    if(typeof refreshTickUi === 'function') refreshTickUi(true);
    if(typeof scheduleDraw === 'function') scheduleDraw();
  },

  finish(ev){
    this.active = this.active.filter(item => item !== ev);
    ev.timers.forEach(t => clearTimeout(t));
    this.updateBanner();
  },

  bannerShow(ev){
    // the alert rings once per story, not once per step; a hard dump hits
    // harder (alarm), any other story gets the market announcement
    if (typeof Sound !== 'undefined') {
      const crash = ev.tone === 'down' && Math.abs(Number(ev.pct) || 0) >= 15;
      Sound.play(crash ? 'alarm' : (ev.tone === 'down' ? 'loss' : 'event'));
    }
    const banner = document.getElementById('eventBanner');
    if(!banner) return;
    banner.classList.add('is-visible');
    banner.classList.toggle('is-down', ev.tone === 'down');
    banner.innerHTML = `
      <span class="event-banner-pulse"></span>
      <span class="event-banner-label">Evento en curso</span>
      <strong>${ev.label}</strong>
      <span class="event-banner-sym mono">${ev.name || ev.sym}</span>
      <span class="event-banner-steps mono" id="eventBannerSteps"></span>`;
    this.updateBanner();
    // aviso central: el primer paso es el titular que abre la historia, así que
    // es el que da el símbolo, la dirección y el movimiento
    if(typeof showMarketAlert === 'function'){
      const first = (ev.steps && ev.steps[0]) || {};
      showMarketAlert({
        sym: ev.sym,
        name: ev.name,
        pct: first.pct || 0,
        tone: first.tone && first.tone !== 'gold' ? first.tone : ev.tone,
        kicker: ev.label || 'Evento de mercado',
        title: first.title || '',
      });
    }
  },

  updateBanner(){
    const banner = document.getElementById('eventBanner');
    const stepsEl = document.getElementById('eventBannerSteps');
    if(!banner || !stepsEl) return;
    if(!this.active.length){
      banner.classList.remove('is-visible');
      return;
    }
    const ev = this.active[this.active.length - 1];
    const remain = Math.max(0, Math.ceil((ev.endsAt - Date.now()) / 1000));
    stepsEl.textContent = remain > 0 ? `${remain}s` : '…';
    setTimeout(() => this.updateBanner(), EVENT_BANNER_REFRESH_MS);
  },

  // the asset summary shows whether this symbol is part of a running story
  activeFor(sym){
    return this.active.filter(ev => ev.sym === sym || (ev.allSyms || []).includes(sym));
  },
};
