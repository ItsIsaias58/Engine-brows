// Cache local del juego.
//
// El objetivo es que el servidor deje de servir los mismos JS/CSS en cada
// visita: la primera vez se guardan aqui y a partir de ahi salen del disco del
// jugador. Los datos del mercado (/api y /ws) NUNCA se cachean, siguen yendo
// siempre a la red.
//
// Al cambiar el juego de forma incompatible basta subir CACHE_VERSION.
const CACHE_VERSION = 'bolsa-shell-v11';
const CORE = ['./', './index.html', './styles.css'];
// Todo el shell del juego. Se precarga en la instalacion para que el cliente
// tenga EN MEMORIA los recursos desde la primera visita: a partir de ahi el
// servicio de mercado deja de servir los mismos ~570 KB en cada carga.
const SHELL = [
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
  'js/admin.js',
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
  'css/trading-extra.css',
  'css/auth.css',
  'css/admin.css',
  'css/progression.css',
  'css/responsive.css',
  'css/boot.css',
];

// Ventana en la que un estatico cacheado se sirve SIN preguntar al servidor.
//
// Antes cada visita revalidaba los 30 archivos por detras (stale-while-
// revalidate), asi que el servidor seguia sirviendo los mismos ~380 KB una y
// otra vez: justo lo que la cache venia a evitar. Ahora, mientras el archivo
// tenga menos de este rato, sale del disco y ni se toca la red. Pasado el rato
// se sirve igual de rapido y se refresca por detras.
//
// Para ver un cambio al instante sin esperar: Ctrl+Shift+R (una recarga dura
// manda cache:'reload' y salta la cache) o subir CACHE_VERSION.
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

// edad del archivo guardado, leida de su propia cabecera Date (el servidor no
// manda ETag, pero si una Date nueva en cada 200).
function cachedAgeMs(res){
  const date = res && res.headers ? res.headers.get('date') : null;
  const at = date ? Date.parse(date) : NaN;
  return Number.isFinite(at) ? Math.max(0, Date.now() - at) : Infinity;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // uno por uno: si un archivo falla no se cae toda la instalacion
    await Promise.all(CORE.concat(SHELL).map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch { /* opcional */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isStaticAsset(pathname){
  return /\.(js|mjs|css|woff2?|ttf|png|jpe?g|webp|svg|ico)$/i.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if(url.origin !== self.location.origin) return;
  // datos vivos del mercado: siempre a la red
  if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  // el documento: red primero (para no quedarse con un index viejo), cache de respaldo
  if(req.mode === 'navigate'){
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, fresh.clone()).catch(() => {});
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match(req))
          || (await cache.match('./index.html'))
          || (await cache.match('./'))
          || Response.error();
      }
    })());
    return;
  }

  // estaticos: se responde con lo cacheado al instante y, solo si ya toca, se
  // refresca por detras
  if(isStaticAsset(url.pathname)){
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);

      // recarga dura (Ctrl+Shift+R): se ignora la cache a proposito
      const hardReload = req.cache === 'reload' || req.cache === 'no-cache';

      // todavia fresco: del disco y sin molestar al servidor
      if(cached && !hardReload && cachedAgeMs(cached) < FRESH_MS) return cached;

      const network = fetch(req).then((res) => {
        if(res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
