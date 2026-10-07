// Cache local del juego OpenCase.
//
// Mismo criterio que el service worker de la bolsa: el shell (HTML/JS/CSS) se
// precarga al instalar, para que el cliente lo tenga EN MEMORIA y el servicio
// de mercado deje de servir los mismos archivos en cada visita. Las imagenes
// (varios MB) NO se precargan: se guardan la primera vez que se muestran. Los
// datos vivos (/api y /ws) nunca se cachean.
//
// Al cambiar el juego de forma incompatible basta subir CACHE_VERSION.
const CACHE_VERSION = 'opencase-shell-v1';
const CORE = ['./', './index.html', './style.css'];
const SHELL = ['./util.js', './weapons.js', './effects.js', './app.js'];

// ventana en la que un estatico cacheado se sirve SIN tocar la red
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

// edad del archivo guardado, leida de su propia cabecera Date
function cachedAgeMs(res) {
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

function isStaticAsset(pathname) {
  return /\.(js|mjs|css|woff2?|ttf|png|jpe?g|webp|svg|ico)$/i.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  // datos vivos del mercado: siempre a la red
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  // el documento: red primero, cache de respaldo
  if (req.mode === 'navigate') {
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

  if (isStaticAsset(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      const hardReload = req.cache === 'reload' || req.cache === 'no-cache';
      if (cached && !hardReload && cachedAgeMs(cached) < FRESH_MS) return cached;
      const network = fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
