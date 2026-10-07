// Pantalla de carga del arranque.
//
// El objetivo es que el trabajo pesado (tipografias, cache de estaticos,
// conexion con el mercado y primer tramo de velas) pase del lado del cliente
// ANTES de mostrar el juego, en vez de ir pidiendo cosas al servidor mientras
// el jugador ya esta mirando la grafica. El servidor solo se queda con la
// conexion: los estaticos los sirve la cache local a partir de la segunda
// visita (ver sw.js).
//
// El progreso NO es inventado: sale de `performance.getEntriesByType('resource')`,
// que es lo que el navegador ya transfirio de verdad. Cada fila muestra los
// bytes reales de ese archivo y su tiempo real, y distingue lo que vino de la
// caché del navegador de lo que salio a la red. La barra es la fraccion de
// archivos que ya llegaron.
//
// Todo es tolerante a fallos: si la red o el mercado no responden, el juego
// arranca igual y la nota lo dice. La pantalla nunca deja al jugador atrapado.
(() => {
  const started = Date.now();
  const MIN_SHOWN_MS = 550;       // evita el parpadeo en visitas rapidas
  const TICK_MS = 120;            // cada cuanto se revisa lo que llego
  const HARD_LIMIT_MS = 15000;    // tope: mejor jugar que mirar una barra quieta

  const overlay = document.getElementById('bootOverlay');
  const stepEl = document.getElementById('bootStep');
  const fillEl = document.getElementById('bootFill');
  const trackEl = document.getElementById('bootTrack');
  const pctEl = document.getElementById('bootPct');
  const countEl = document.getElementById('bootCount');
  const listEl = document.getElementById('bootAssets');
  const noteEl = document.getElementById('bootNote');
  const retryEl = document.getElementById('bootRetry');
  if(!overlay) return;

  const warnings = [];
  let progress = 0;
  let ticker = 0;
  let rafId = 0;
  let finished = false;

  // ------------------------------------------------------------- inventario
  // Los scripts que el navegador carga DESPUES de este archivo, en el mismo
  // orden que index.html. Van escritos aqui (y no leidos del DOM) porque cuando
  // boot.js corre el parser todavia no ha visto esas etiquetas; el test de
  // scripts/game.test.mjs compara esta lista con index.html para que no se
  // desincronicen sin que nos enteremos.
  const SCRIPT_FILES = [
    'js/util.js',
    'js/boot.js',
    'js/sound.js',
    'js/catalog.js',
    'js/news-copy.js',
    'js/history-cache.js',
    'js/state.js',
    'js/net.js',
    'js/market.js',
    'js/chart.js',
    'js/order.js',
    'js/portfolio.js',
    'js/hud.js',
    'js/research.js',
    'js/nav.js',
    'js/auth.js',
    'js/profile.js',
    'js/achievements.js',
    'js/leaderboard.js',
    'js/cases.js',
    'js/events.js',
    'js/price-alerts.js',
    'js/orderbook.js',
    'js/bank.js',
    'js/casino.js',
    'js/polls.js',
    'js/heatmap.js',
    'js/onboarding.js',
    'js/main.js',
    '/owngames/shared/chat.js',
  ];

  function labelFor(url){
    if(url.origin !== location.origin) return 'Fuentes web';
    return url.pathname.split('/').filter(Boolean).pop() || url.pathname;
  }

  // Las hojas de estilo si se pueden leer del DOM: cuando boot.js corre ya
  // estan todas en <head>, incluida la de Google Fonts.
  const entries = [];
  for(const link of document.querySelectorAll('link[rel="stylesheet"]')){
    let url;
    try { url = new URL(link.href, location.href); } catch { continue; }
    if(!url.href) continue;
    entries.push({ url: url.href, label: labelFor(url), external: url.origin !== location.origin });
  }
  for(const file of SCRIPT_FILES){
    const url = new URL(file, location.href);
    entries.push({ url: url.href, label: labelFor(url), external: false });
  }
  const total = entries.length;
  const slotOf = new Map(entries.map((entry, i) => [entry.url, i]));

  // ------------------------------------------------------------- medicion
  // Del resource timing sacamos bytes y milisegundos reales. `decodedBodySize`
  // es el tamano ya descomprimido y sobrevive a la cache (ahi `transferSize` es
  // 0), asi que sirve para las dos cosas y nos deja marcar que vino del disco.
  function sweep(){
    if(typeof performance === 'undefined' || !performance.getEntriesByType) return false;
    let changed = false;
    for(const res of performance.getEntriesByType('resource')){
      const slot = slotOf.get(res.name);
      if(slot === undefined) continue;
      const entry = entries[slot];
      const decoded = res.decodedBodySize || 0;
      const transferred = res.transferSize || 0;
      const bytes = Math.max(decoded, transferred, entry.done ? entry.done.bytes : 0);
      const cached = transferred === 0 && decoded > 0;
      const ms = Math.round(res.duration || 0);
      // un mismo archivo puede tener varias entradas (p.ej. una peticion previa
      // de comprobacion): nos quedamos con la que mas bytes trajo
      const prev = entry.done;
      if(prev && prev.bytes >= bytes && prev.cached === cached) continue;
      entry.done = { bytes, ms, cached };
      changed = true;
    }
    return changed;
  }

  function human(bytes){
    if(!bytes) return '';
    if(bytes < 1024) return bytes + ' B';
    if(bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function buildRows(){
    if(!listEl) return;
    listEl.textContent = '';
    for(const entry of entries){
      const row = document.createElement('div');
      row.className = 'boot-asset is-pending';
      const mark = document.createElement('span');
      mark.className = 'ba-mark';
      const name = document.createElement('span');
      name.className = 'ba-name';
      name.textContent = entry.label;
      const meta = document.createElement('span');
      meta.className = 'ba-meta';
      row.append(mark, name, meta);
      listEl.appendChild(row);
      entry.row = row;
      entry.mark = mark;
      entry.meta = meta;
      entry.painted = '';
    }
  }

  // la fila "descargando" es la primera que aun no ha llegado: los <script> se
  // piden en orden, asi que es la que el navegador esta pidiendo ahora
  function activeIndex(){
    for(let i = 0; i < entries.length; i++){
      if(!entries[i].done) return i;
    }
    return -1;
  }

  function paintRow(entry, state){
    if(!entry.row) return;
    const meta = entry.done
      ? (entry.external ? 'externo' : human(entry.done.bytes) + (entry.done.cached ? ' · caché' : ' · ' + entry.done.ms + ' ms'))
      : (state === 'loading' ? 'descargando…' : '');
    const key = state + '|' + meta;
    if(entry.painted === key) return;
    entry.painted = key;
    entry.mark.textContent = state === 'done' ? '✓' : (state === 'loading' ? '↓' : '·');
    entry.meta.textContent = meta;
    entry.row.className = 'boot-asset is-' + state;
  }

  function paintSummary(){
    let done = 0;
    let bytes = 0;
    let cached = 0;
    for(const entry of entries){
      if(!entry.done) continue;
      done++;
      bytes += entry.done.bytes;
      if(entry.done.cached) cached++;
    }
    const pct = total ? Math.round((done / total) * 100) : 100;
    progress = Math.max(progress, pct);
    if(fillEl) fillEl.style.width = progress + '%';
    if(trackEl){
      // ya hay medidas reales: la barra deja de ser indeterminada
      trackEl.classList.remove('is-idle');
      trackEl.setAttribute('aria-valuenow', String(progress));
    }
    if(pctEl) pctEl.textContent = progress + '%';
    if(countEl){
      const size = human(bytes);
      countEl.textContent = (done === total)
        ? total + ' archivos' + (size ? ' · ' + size : '') + (cached ? ' · ' + cached + ' en caché' : '')
        : done + '/' + total + (size ? ' · ' + size : '');
    }
    return { done, bytes, cached, pct };
  }

  function render(){
    sweep();
    const { done, pct } = paintSummary();
    const active = activeIndex();
    for(let i = 0; i < entries.length; i++){
      paintRow(entries[i], entries[i].done ? 'done' : (i === active ? 'loading' : 'pending'));
    }
    if(active >= 0 && active !== render.lastActive && entries[active].row && listEl){
      render.lastActive = active;
      // que la fila que se esta bajando quede a la vista sin mover la pagina
      try { entries[active].row.scrollIntoView({ block: 'nearest' }); } catch { /* opcional */ }
    }
    return { done, pct };
  }

  function scheduleRender(){
    if(rafId || finished) return;
    rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  }

  function note(text){
    if(!noteEl) return;
    warnings.push(text);
    noteEl.textContent = warnings.join(' · ');
  }

  function setPhase(text){
    if(!stepEl || stepEl.textContent === text) return;
    stepEl.textContent = text;
  }

  // espera a que se cumpla una condicion, con tope de tiempo. devuelve si se
  // cumplio, para poder marcar el paso como completado o como aviso.
  function waitFor(predicate, timeoutMs){
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        let ok = false;
        try { ok = Boolean(predicate()); } catch { ok = false; }
        if(ok) return resolve(true);
        if(Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 60);
      };
      tick();
    });
  }

  function withTimeout(promise, timeoutMs){
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if(!done){ done = true; resolve(value); } };
      try {
        promise.then(() => finish(true)).catch(() => finish(false));
      } catch { return finish(false); }
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  // servicio de cache local: la primera visita lo instala, las siguientes ya
  // sirven los archivos desde el navegador
  async function installCache(){
    if(!('serviceWorker' in navigator)) return false;
    if(location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
      return false;   // los service workers exigen contexto seguro
    }
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      // si ya hay uno controlando, los estaticos salen de cache de inmediato
      return Boolean(reg);
    } catch {
      return false;
    }
  }

  // el observador avisa en cuanto llega un archivo, sin esperar al tick
  let observer = null;
  if(typeof PerformanceObserver === 'function'){
    try {
      observer = new PerformanceObserver(() => scheduleRender());
      observer.observe({ type: 'resource', buffered: true });
    } catch { observer = null; }
  }

  const steps = [
    {
      label: 'Preparando la interfaz…',
      run: () => (document.readyState === 'loading'
        ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(true), { once:true }))
        : Promise.resolve(true)),
    },
    {
      label: 'Cargando tipografías…',
      run: () => withTimeout(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(), 3000),
    },
    {
      label: 'Guardando archivos para la próxima visita…',
      run: installCache,
    },
    {
      label: 'Conectando con el mercado…',
      run: async () => {
        const ok = await waitFor(
          () => typeof MarketNet !== 'undefined' && (MarketNet.socketReady || MarketNet.live),
          6000,
        );
        if(!ok) note('Sin conexión con el mercado: sigues jugando en local.');
        return ok;
      },
    },
    {
      label: 'Preparando la gráfica…',
      run: async () => {
        const ok = await waitFor(
          () => typeof candles !== 'undefined' && candles.length > 0,
          5000,
        );
        if(!ok) note('La gráfica terminará de cargar en un momento.');
        return ok;
      },
    },
  ];

  async function run(){
    buildRows();
    render();
    ticker = setInterval(() => { render(); }, TICK_MS);

    // el primer paso (el DOM) es un prerrequisito real: sin el no hay nada que
    // medir ni que pintar.
    setPhase(steps[0].label);
    try { await steps[0].run(); } catch { /* el boot no se cae por esto */ }

    // el resto son independientes entre si (tipografias, cache local, socket y
    // primer tramo de velas). en serie, cada uno esperaba al anterior y el mas
    // lento sumaba su espera: con tipografias o red lentas el overlay se
    // quedaba de mas. se lanzan a la vez y el overlay se retira cuando TODOS
    // terminan — la misma condicion de antes, sin la suma de esperas.
    setPhase('Preparando el juego…');
    await Promise.all(steps.slice(1).map(async (step) => {
      let ok = false;
      try { ok = await step.run(); } catch { ok = false; }
      if(!ok) note(step.label.replace('…','') + ' con avisos.');
    }));
    setPhase('Listo');
    finish();
  }

  function finish(){
    if(finished) return;
    finished = true;
    if(ticker){ clearInterval(ticker); ticker = 0; }
    if(observer){ try { observer.disconnect(); } catch { /* opcional */ } observer = null; }
    if(rafId){ cancelAnimationFrame(rafId); rafId = 0; }
    render();
    setPhase('Listo');
    const wait = Math.max(0, MIN_SHOWN_MS - (Date.now() - started));
    setTimeout(() => {
      overlay.classList.add('is-done');
      // se quita del DOM para que no capture clics ni quede en el arbol de accesibilidad
      setTimeout(() => overlay.remove(), 400);
    }, wait);
  }

  if(retryEl){
    retryEl.addEventListener('click', () => {
      retryEl.hidden = true;
      if(noteEl) noteEl.textContent = '';
      // un reintento de verdad: vuelve a pedir todo, saltandose la cache
      location.reload();
    });
  }

  // si algo se cuelga mas de la cuenta, se entra igual: mejor jugar que mirar
  // una barra quieta
  setTimeout(() => {
    if(!overlay.classList.contains('is-done')){
      note('Carga lenta: entrando igual.');
      if(retryEl) retryEl.hidden = false;
      finish();
    }
  }, HARD_LIMIT_MS);

  window.Boot = {
    progress: () => progress,
    warnings: () => warnings.slice(),
    skip: finish,
    // inventario + medicion real, tal cual lo vio el navegador. sirve para
    // verificarlo desde una prueba automatizada
    assets: () => entries.map((entry) => ({
      file: entry.label,
      url: entry.url,
      done: Boolean(entry.done),
      bytes: entry.done ? entry.done.bytes : 0,
      cached: Boolean(entry.done && entry.done.cached),
      ms: entry.done ? entry.done.ms : 0,
      external: entry.external,
    })),
    counts: () => {
      let done = 0;
      let bytes = 0;
      let cached = 0;
      for(const entry of entries){
        if(!entry.done) continue;
        done++;
        bytes += entry.done.bytes;
        if(entry.done.cached) cached++;
      }
      return { done, total, bytes, cached, pending: activeIndex() };
    },
  };

  run();
})();
