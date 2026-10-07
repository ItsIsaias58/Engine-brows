# PERF-BASELINE — Línea base de rendimiento (FASE 0)

Fecha: 2026-10-06. Entorno de medición: bun 1.4.1, server market en `port: 0`,
`tickMs: 1000`, `autoEvents: false`, `dataDir` temporal. Navegador: **no
disponible** en la máquina de medición (ver Limitaciones).

## 1. Tabla de línea base medida

| Escenario | Métrica | Valor medido |
|---|---|---|
| Red normal · 1 cliente | WS bajado por cliente | **5.4 – 6.2 KB/s** |
| Red normal · 1 cliente | frame `snapshot` (conexión) | **8.2 KB** |
| Red normal · 1 cliente | frame `tick` | **4.93 KB** (min 4.79 / max 5.11) |
| Red normal · 5 clientes | egress servidor (6 s) | 0.178 MiB |
| Red normal · 20 clientes | egress servidor (6 s) | **0.618 MiB ≈ 103 KB/s ≈ 0.83 Mbit/s** |
| Red normal | frames/s por cliente | 1.33 (1 tick/s + snapshot/auth) |
| Motor | coste CPU de 1 tick (`tickMarketState` + `marketSnapshot` + `liveCandles`) | **0.358 ms** |
| Historial 5m (1ª vez por empresa) | cuerpo `candles` ventana completa | **178.5 KiB** (2876 barras) |
| Historial 5m (`?since=`, repetido) | cuerpo `candles` gap | pocas barras (< 1 KiB) |
| REST `/api/market/state` | cuerpo | 7.07 KB |
| REST `/api/market/me` (GET) | cuerpo | 686 B |
| REST `/api/market/skins` | cuerpo (inventario vacío) | 350 B |
| REST `/api/market/leaderboard` | cuerpo | 586 B |
| REST `/api/market/schedule` | cuerpo | 1.16 KB |
| REST `/api/market/skins/catalog` | cuerpo | 2.69 KB |
| Persistencia | `market.json` serializado | **65.1 KB** |
| Estáticos bolsa | JS+CSS+HTML (raw / gzip borde) | **516 KB / 147 KB** |
| Estáticos opencase | JS+CSS+HTML (raw / gzip borde) | **100 KB / 30 KB** |
| Estáticos opencase | `img/` (62 ficheros, `loading="lazy"`) | **6.08 MB** |

Medido con `services/market/engine.mjs` directo y con `createMarketServer`
real (WS abierto de verdad, `scripts/market.test.mjs` como molde de arranque).

## 2. Flujo real motor → store → WS/HTTP → cliente

- **Motor** (`engine.mjs:tickMarketState`) avanza en pasos de 1 minuto de juego.
  El server lo invoca cada `tickMs` (**1000 ms**, `server.mjs:101`).
- **Cada tick** (`server.mjs:657-702`): `tickMarketState` → `persistMarket()`
  (store con debounce 3 s) → `resolveDuePolls` → varios pases de finanzas/riesgo
  → `marketSnapshot()` + `quoteMap()` (que **vuelve a llamar** `marketSnapshot`)
  → `broadcast({type:'tick', quotes, candles: liveCandles, news})` a **todos**
  los sockets.
- **Cliente bolsa** (`net.js:388`) abre `/ws/market`; en cada `tick` llama
  `applyMarketQuotes` + `applyLiveCandles` (`net.js:620-630`). El repintado de
  DOM está limitado a `TICK_UI_MIN_MS = 400` (`market.js:458-490`).
- **`chat.js:542`** abre **otro** WebSocket a `/ws/market` para el chat.
- **opencase `app.js:914`** abre **otro** WebSocket a `/ws/market` y sólo usa
  `skins-update` / `portfolio-override` / `finance`; además hace **poll de
  `/api/market/skins` cada 1 s** (`app.js:1281`).

## 3. Hallazgos de la primera pasada (FASE 1)

### Crítico
**C1 — cloudsync sube la instantánea completa del navegador durante el juego.**
`cloudsync.ts:468-528` envuelve `localStorage.setItem/removeItem/clear`, todos
los `IDBObjectStore.put/add/delete/clear`, `IDBFactory.open` y
`createObjectStore` para llamar `markDirty()`. Además escucha el evento
`storage` de todo el origen (`cloudsync.ts:490-496`). El juego escribe
`localStorage` **cada 2 s** en `saveGame()` (`state.js:354-366`, el payload
incluye los precios del mercado, que cambian cada tick → `payload !==
lastSavedPayload` casi siempre) y usa IndexedDB para el historial de velas
(`history-cache.js`). Cada escritura marca "dirty" → `markDirty` reprograma un
envío con `MIN_UPLOAD_INTERVAL = 15000` (`cloudsync.ts:57,597-610`). Con una
instantánea de ~67 MB (dato previo en `PERF-AUDIT.md`), eso es del orden de
**decenas de MB cada 15 s** = ancho de banda saturado. Es la causa más probable
del síntoma "se satura el ancho de banda".

### Alto
**A1 — el `tick` se difunde a TODOS los sockets con estado completo, sin
filtro ni backpressure.** `broadcast()` (`server.mjs:334-343`) serializa y manda
a todo `clients` sin mirar si el socket es del chat o de opencase, que ignoran
el `tick`. Cada página de juego abre ≥2 sockets (bolsa+chat, opencase+chat) y
todas reciben ~4.93 KB/s de `tick` que en su mayoría no consumen.

**A2 — latencia percibida ≈ 1 s por diseño de cadencia.** tick 1000 ms + beat
de UI 400 ms + `savePortfolio` con debounce 700 ms (`net.js:9`) + resync
throttled 1000-1500 ms (`net.js:940`) + repintado escalonado hasta 700 ms
(`market.js:224-231`). Mover algo y notar ~1 s es coherente con esta suma.

### Medio
**M1 — opencase hace poll de `/api/market/skins` cada 1 s** (`app.js:1281`)
sumado al WS.
**M2 — fuentes de Google render-blocking** en bolsa (`index.html:8`,
`fonts.googleapis.com`) — otro origen, en una red mala es un RTT extra antes de
pintar.
**M3 — 30 `<script>` sin `defer`/`async`** (`index.html:605-634`).
**M4 — 6.08 MB de imágenes en opencase** aunque con `loading="lazy"`; la
ruleta de apertura puede tirar de muchas.

### Bajo
**B1 — `tickMarketState` recalcula `marketSnapshot` dos veces por tick**
(`server.mjs:685` y dentro de `quoteMap`, `server.mjs:437-441`). Coste medido
total del tick: 0.358 ms → irrelevante hoy.

### Ya está bien (no tocar)
- Caché de historial con `?since` + ETag/304 + IndexedDB (`net.js:243-278`).
- Agregación de temporalidades en cliente (15m/1h derivadas del 5m).
- Compresión gzip en el borde para estáticos y APIs (`edgeCompression.mjs`, aplicada en `prod.mjs:1105`).
- Store JSON atómico con debounce (`store.mjs`).
- Optimizaciones previas de cloudsync (Worker, `MIN_UPLOAD_INTERVAL`, escaneo sólo con pestaña oculta).

## 4. Línea base del CLIENTE (Chromium real, headless)

Medido con el Chromium de Playwright (`~/.cache/ms-playwright/chromium-1243`)
+ `playwright-core`, contra una instancia de market local (`port` efímero,
`tickMs:1000`) **sin gzip** (el market sirve en crudo; el gzip lo aplica el borde
`prod.mjs`). Arnés: `/tmp/lyra-baseline/browser.mjs`. Métricas capturadas con
`PerformanceObserver('longtask')`, `requestAnimationFrame` y el dominio CDP
`Network`.

| Escenario | DCL | Boot (overlay) | Long tasks | Clic P50/P95 | Heap |
|---|---|---|---|---|---|
| Normal · 40 clics + 10 s | 0.28–0.47 s | 0.75–0.91 s | 16 (832 ms total, max 54 ms) | **24–28 / 46–50 ms** | 4.7 MB |
| Throttled 1.5 Mbps↓/750 Kbps↑/150 ms · 40 clics + 10 s | **3.9 s** | **4.1 s** | 0 | 24 / 46 ms | 4.7 MB |
| Throttled · 10 s idle | 3.9 s | 4.1 s | 0 | — | 6.8 MB |

Transferencia del primer load (normal, sin gzip): **~1.05 MB**

| Categoría | Bytes |
|---|---|
| Script | 476 KB (30 `<script>` clásicos) |
| Fetch | 373 KB (**`/api/market/candles?…&limit=5760` = 347 KB**) |
| Stylesheet | 118 KB |
| Font (fonts.gstatic.com) | 54 KB |
| Document | 28 KB |
| WebSocket | ~5.4 KB/s (4.9 KB/tick + snapshot) |

Top ficheros: `candles 5760` 347 KB · `admin.js` 50 KB · `chart.js` 43 KB ·
`net.js` 43 KB · `trading-extra.css` 40 KB · `casino.js` 26 KB · `sound.js` 23 KB.

Hallazgo clave: el clic **no** es el cuello de botella (24–50 ms locales incluso
throttled). El coste está en **cargar** (primer load) y en el trabajo del hilo
principal al **ingerir las 2876 velas** (los 16 long tasks del escenario normal
aparecen cuando llega la respuesta de `candles`).

## 5. Hallazgos de los juegos (Trading + OpenCase)

### Alto
- **G1 · La pantalla de carga es una cadena secuencial** (`boot.js`):
  DOMContentLoaded → `document.fonts.ready` (tope 3 s) → `installCache`
  (registro del SW) → esperar el socket (tope 6 s) → esperar velas (tope 5 s),
  con tope global de 15 s. Pasos independientes se ejecutan uno tras otro; el
  overlay bloquea la interacción hasta `finish()`. En throttled: boot 4.1 s.
- **G2 · 30 `<script>` clásicos y 476 KB en crudo**, cargados para todos aunque
  casi todos no hagan nada en el arranque. `admin.js` (50 KB, el mayor) es
  sólo de administradores y se carga para cualquier jugador.
- **G3 · La respuesta de velas (347 KB) se procesa en `paintHistorySeries`
  con tres pasadas + `sort` sobre ~2876 barras** (`chart.js:168-200`); genera
  los long tasks observados. `drawChart` además hace `Math.min.apply(null,
  slice.map(...))` (dos arrays nuevos por pintado, `chart.js:566-567`).
- **G4 · Cambiar de empresa rápido encadena `HistoryCache.merge` (escritura
  IndexedDB) + `fetchCandles` + `paintHistorySeries` por cada cambio**
  (`net.js`/`market.js:224-231`). Con muchos clics se solapan merges y fetches.
  En el shell, cada escritura IDB marca cloudsync "dirty" (ver C1).

### Medio
- **G5 · `refreshMarketRowsStaggered` programa 14 `setTimeout` por beat de
  400 ms** (`market.js:224-231`) + `refreshTicker` (40 nodos) + varios pases.
- **G6 · Fuentes de Google render-blocking** (`index.html:8`) + woff2 externo.
- **G7 · opencase recibe todos los `tick` por su `/ws/market` y los ignora**
  (`app.js:914`), y además hace **poll de `/api/market/skins` cada 1 s**
  (`app.js:1281`). El chat abre un **segundo** WS que también recibe e ignora
  los `tick` (`shared/chat.js:542`).
- **G8 · opencase `img/` = 6.08 MB** (62 ficheros, `loading="lazy"`).

### Ya está bien (no tocar)
- Clics locales 24–50 ms; escrituras DOM guardadas por firma (`orderbook.js`,
  `price-alerts.js`); gráfica coalescida por `requestAnimationFrame`
  (`scheduleDraw`); SW que cachea estáticos (`sw.js`); gzip en el borde
  (`prod.mjs:1105`); historial con `?since`/ETag/304 + IndexedDB; cloudsync con
  Worker y `MIN_UPLOAD_INTERVAL`.

## 6. Pases aplicados (FASE 3) y resultado medido

| Pase | Cambio | Métrica | Antes | Después |
|---|---|---|---|---|
| P1 | `boot.js`: pasos independientes en paralelo (`Promise.all`) | bootMs throttled | 4114–4165 ms | 3919–3920 ms* |
| P2 | `chart.js`: ingesta de velas en 1 pasada + min/max sin arrays | asignaciones/pintado | 2 arrays + `Math.min/max.apply` por frame | 0 arrays temporales |
| P3 | `admin.js` (~50 KB) cargado bajo demanda (atajo/botón/admin) | bytes de arranque | 621 131 B | **570 367 B (−50.8 KB)** |
| P3 | idem | DCL throttled | 3927 ms | **3713 ms (−214 ms)** |
| P3 | idem | boot throttled | 4132 ms | **3920 ms (−212 ms)** |

\* El arranque en paralelo sólo se nota cuando las tipografías (tope 3 s) o el
socket son lentos; en este banco resolvían rápido, así que la mejora medida es
pequeña. Elimina la **suma** de esperas (hasta ~3 s con Google Fonts lento).

Verificación de P3 en Chromium real (`/tmp/lyra-baseline/admin-check.mjs`):
- Invitado: **no** pide `js/admin.js`.
- `Ctrl+Shift+A`: carga `admin.js` y abre la consola (overlay visible).
- Cuenta admin: el botón del rail se monta y no hay errores de página.

**Comprobaciones:** `bun test --isolate scripts src services` → **457 pass / 0 fail**;
`bun run typecheck` → exit 0; `bun run lint` → exit 0; `node --check` en los JS tocados.

Nota honesta: el número de long tasks de la ingesta de velas **oscila entre
ejecuciones** (0 en throttled, 16–18 en normal según cuándo llega la respuesta
del fetch respecto a la ventana de medición). No se atribuye a P2 una mejora de
long tasks: P2 reduce asignaciones y pasadas por código, sin winner medido estable.

## 7. Limitaciones de la FASE 0

- El mercado local de prueba **no aplica gzip**: el primer load real a través de
  `prod.mjs` es menor (los scripts bajan a ~147 KB). Los valores absolutos del
  cliente son un **techo**, no la cifra de producción; las comparaciones
  antes/después sí son válidas porque usan el mismo banco.
- El FPS de Chromium headless (~20) es un artefacto del entorno, no el FPS real.
- Los números de cloudsync (~67 MB) provienen de `PERF-AUDIT.md` (sesión previa);
  aquí no se ejercita porque el shell/cloudsync no forma parte de la página del
  juego.

## 8. Cacheo en el cliente (service workers + ETag)

Objetivo: que los recursos vivan en el cliente y el servidor deje de servirlos
en cada visita. Medido en Chromium real (`/tmp/lyra-baseline/cache-check.mjs`,
`oc-cache.mjs`).

| Cambio | Fichero | Resultado medido |
|---|---|---|
| SW precarga **todo** el shell (30 JS + 6 CSS) y ventana sin red de 7 días | `bolsa-trading-floor/sw.js` | 39 entradas en `bolsa-shell-v11` |
| Service worker nuevo para opencase (shell precargado + imágenes al usarse) | `csgo-opencase/sw.js` + registro en `index.html` | 8 entradas en `opencase-shell-v1` |
| ETag + `If-None-Match` → 304 en estáticos | `market/server.mjs` `serveStatic` | 2.ª petición = **304** (sin cuerpo) |

**Segunda carga (mismo contexto):** bolsa **38/38** recursos JS/CSS servidos por
el service worker, **0 peticiones reales a red**; opencase **7/7**, **0 a red**.
Sin errores de página.

Contrapartida: en la **primera** visita el precache añade una descarga del shell
(se baja dos veces: la de la página y la del propio precache). Es un coste único;
a partir de la segunda visita el servidor no sirve estáticos.

**Comprobaciones:** suite **458 pass / 0 fail**; `typecheck` exit 0; `lint` exit 0;
`node --check` en `server.mjs` y los `sw.js`.

## 9. Diagnóstico del snapshot de cloudsync: de registros a bytes

Pendiente nº1 de la auditoría: **atribuir** el peso de la instantánea (~67 MB) a
una base concreta. El log existente no servía para decidirlo:

- `src/features/cloudsync/cloudsync.ts:193-206` y
  `src/features/cloudsync/snapshotPayload.worker.ts:60-76` ordenaban las bases
  por **número de registros**. Una base con dos blobs pesa más que otra con
  miles de enteros, así que el ranking podía señalar a la base equivocada.
- Se descartó `JSON.stringify(db)` por base (2.ª serialización de decenas de MB).

Cambio (sólo diagnóstico; no altera qué se sincroniza ni cuándo):

- `src/features/cloudsync/syncSnapshot.ts` — `encodedApproxBytes()` recorre el
  valor ya codificado y suma longitudes sin asignar cadenas; y
  `heaviestSyncDatabases()` devuelve el top-5 por **bytes aproximados**. Una sola
  implementación compartida por el hilo principal y el worker.
- Ambos `console.warn` muestran ahora `[nombre, "X.X MB"]` y siguen disparándose
  sólo si la instantánea pasa de 8 MB.

**Comprobaciones:** `bun test --isolate scripts src services` → **460 pass / 0 fail**
(2 tests nuevos en `src/features/cloudsync/syncSnapshot.test.ts` fijan que el
ranking va por bytes y que una base vacía pesa 0); `bun run typecheck` exit 0;
`bun run lint` exit 0.

Pendiente: excluir más bases de `LOCAL_ONLY_DATABASES` una vez el log diga cuál
es la culpable (necesita los números del perfil real; no se adivina porque
excluir la base equivocada pierde saves).

## 10. Feed del WebSocket: `tick` sólo a quien lo consume

El chat y el opencase abren su propio socket a `/ws/market` y **descartan** el
frame `tick` (y el `snapshot` inicial):

- `services/market/public/shared/chat.js:545` — sólo atiende `chat` y `chat-channel`.
- `services/market/public/csgo-opencase/app.js:924` — sólo atiende `skins-update`,
  `portfolio-override` y `finance`.
- Aun así, `services/market/server.mjs` hacía `broadcast(...)` a **todos** los
  sockets de `clients` (`broadcast()` en la sección de timers), así que esos dos
  pagaban ~4.8 KB/s de `tick` más el `snapshot` inicial de ~8.2 KB.

Cambio **aditivo** (sin el parámetro, el socket recibe exactamente lo de antes):

- `server.mjs` — el handshake lee `?skip=tick,snapshot` a un `Set` en
  `socket.data.skipFrames`; `broadcast()` y el `open()` inicial lo consultan vía
  `wantsFrame(socket, type)`. Un socket que ignora `tick` tampoco lo recibe, y el
  servidor no lo serializa para él.
- `chat.js` y `csgo-opencase/app.js` — conectan con `?skip=tick,snapshot`.

**Medido** (`scripts/perf/live-server.mjs`, banco real, `tickMs` 1000, ventana de
6 s):

| Socket | Bytes/s | Frames en 6 s |
|---|---|---|
| sin `skip` (bolsa) | **6188** | 8 (1 snapshot + 6 tick + 1 auth) |
| `?skip=tick,snapshot` (chat/opencase) | **0** | 0 |

El socket completo mantiene sus cifras de línea base (6188 vs 6199 B/s ⇒ dentro
del ruido): el filtro no toca a quien sí consume el `tick`.

**Comprobaciones:** test nuevo en `scripts/market.test.mjs` ("a socket that
declares skip=tick,snapshot only receives what it consumes") que abre los dos
sockets, comprueba que sólo el completo recibe `snapshot`+`tick`, y que el otro
sigue vivo respondiendo un `ping` → `pong`. Suite **461 pass / 0 fail**;
`typecheck` exit 0; `lint` exit 0; `node --check` en `server.mjs`, `chat.js`,
`app.js`.

## 11. El cuerpo del snapshot ya no toca el hilo principal

Síntoma reportado: al mover el ratón o pulsar **Configuración** la animación se
queda congelada **2-3 s** y luego sigue. Si el hilo principal está haciendo el
trabajo del snapshot, no puede pintar: eso es exactamente un long task.

**Tres sitios** seguían serializando el navegador entero (~67 MB) en el hilo
principal, aunque el worker ya existiera:

| Sitio | Qué hacía en el hilo principal |
|---|---|
| `cloudsync.ts` `checkForChanges()` (el escaneo de seguridad, se dispara con la pestaña oculta) | `lyraExportAllData()` + `JSON.stringify` + `TextEncoder` + `crypto.subtle.digest` de todo el navegador |
| `cloudsync.ts` `uploadSnapshot()` | `new Blob([body])` + `CompressionStream("gzip")` sobre 67 MB **en cada subida** |
| `cloudsync.ts` `buildSnapshotPayload()` (worker devolvía `body`) | la recepción por `postMessage` copia el cuerpo de 67 MB al hilo principal |

**Medido con el arnés nuevo** `scripts/perf/cloudsync-main-thread.mjs` (Chromium
real, 67 MB, separando el trabajo del worker del que cae al hilo principal):

| | recibir en hilo principal | Blob+gzip en hilo principal | **peor hueco de frame** |
|---|---|---|---|
| antes (worker devuelve el cuerpo) | 23-27 ms | 482 ms | **235-436 ms** |
| ahora (worker devuelve el gzip transferido) | 0,3-2 ms | 0 ms | **0-0,9 ms** |

Y el coste de las etapas del escaneo, medido por separado con
`scripts/perf/snapshot-phases.mjs` (`bun`, 67 MB): `stringify` 60 ms +
`TextEncoder` 29 ms + `sha256` 73 ms ≈ **162 ms** que ya no corren en el hilo
principal.

Cambio (mismo dato, mismos bytes subidos, mismo fingerprint — sólo cambia dónde
se calculan):

- `snapshotPayload.worker.ts` — el worker **comprime** (mismo criterio que antes:
  sólo si gana a crudo) y devuelve el `ArrayBuffer` **transferido**; con
  `fingerprintOnly` responde sólo el hash, sin cuerpo.
- `cloudsync.ts` — `checkForChanges()` pide sólo el fingerprint del worker;
  `buildSnapshotPayload(fingerprintOnly)` devuelve `{fingerprint, compressed,
  body, rawLength}` y `uploadSnapshot(payload)` sube el gzip ya hecho.
- `syncData()` — el respaldo al hilo principal ahora **sólo** ocurre si el worker
  es inalcanzable. Si lo que falló fue el trabajo (timeout o error puntual), el
  error se propaga y el sync reintenta: rehacer 67 MB en el hilo principal era
  justo el congelamiento.
- El worker se re-crea hasta 3 veces si falla, en vez de condenar el sync al
  hilo principal para siempre.

Contrapartida documentada: si el servidor rechazara el gzip con 415/422, esa
respuesta se devuelve tal cual en vez de reintentar con el crudo — 415 es
imposible para `gzip` (`services/cloudsync/src/sync.rs` acepta `gzip` e
`identity`) y 422 significa payload inválido o demasiado grande, donde el crudo
(más grande) sería rechazado igual.

**Comprobaciones:** suite **461 pass / 0 fail**; `typecheck` exit 0; `lint` exit 0;
ambos arneses ejecutados desde el repo.

## 12. OpenCase: ruleta desincronizada y skin duplicada

Dos bugs de comportamiento en `services/market/public/csgo-opencase/app.js`,
reproducidos en Chromium real con `scripts/opencase-ui-check.mjs` (arnés nuevo;
`NODE_PATH=<dir playwright-core> bun scripts/opencase-ui-check.mjs`, sale 1 si
falla).

**1) La cinta paraba en una tarjeta que no era el premio.**
`startSpin()` asumía `STEP = 156px` (148 de tarjeta + 8 de gap) para centrar la
casilla 42, pero `style.css` cambia `.rl-item` a **120px** en
`@media (max-width: 640px)` — y un juego dentro de un panel/iframe casi nunca
llega a 640px de ancho. Con 128px reales de paso, el destino se pasaba del tope
de scroll y la cinta quedaba varada al final: el marcador apuntaba a un relleno
al azar y la tarjeta de resultado mostraba otro item. Ahora la geometría se
**mide** de las tarjetas ya pintadas (`winnerEl.offsetLeft − cards[0].offsetLeft
+ ancho/2 − anchoDeLaCinta/2`), y el tic de la cinta usa el paso real medido en
vez de la constante (`smoothScrollTo`).

**2) La misma skin entraba dos veces al inventario.** El server concede la skin
en el `open` y **empuja** `skins-update` (server.mjs:1410) → el cliente adopta el
inventario del server a los ~0.7 s, con la skin dentro, mientras la ruleta sigue
girando. Al terminar, `commitReveal()` la añadía otra vez a la lista local: dos
copias visibles y el total a vender duplicado. Ahora `commitReveal()` sólo la
añade si su `id` no está ya presente.

**3) Ventana de doble apertura.** `spinning` sólo se levanta dentro de
`startSpin()` (al responder la red), así que entre el clic y la respuesta cabía
un segundo `POST open`: dos cobros, dos skins y la ruleta reiniciada. Un flag
`opening` síncrono cierra la ventana.

| Escenario | antes | ahora |
|---|---|---|
| estrecho (480px): tarjeta centrada vs premio | **no coinciden** (Tec-9 en la cinta, M249 revelada; `is-winner` en otra) | coinciden |
| escritorio (1280px) | coinciden | coinciden |
| sesión real: inventario del cliente tras revelar | **2** (id repetido) con el server en 1 | 1, sin ids repetidos |

Evidencia de mecanismo en el arnés: `idsDuringSpin` muestra el `sk-1` ya en el
inventario **durante** el giro (el push se adelantó al revelado), y
`inventoryCountAfterReveal` se queda en 1 — que es justo lo que la deduplicación
impide que se convierta en 2.

**4) La tarjeta del premio se SUSTITUÍA al parar (la desincronización que
seguía).** `buildRoulette()` pintaba un relleno al azar en la casilla 42 y
`revealWinnerAt()` la reemplazaba con el premio cuando el scroll terminaba. El
ease-out es quintic (`1 − (1−p)⁵`), así que en la última mitad del tiempo la
cinta está casi parada: el jugador **lee la tarjeta del relleno con calma** y el
intercambio de la skin llega después, como un cambio. El arnés lo captura en
crudo: en `invitado/estrecho` la casilla 42 mostraba a mitad de giro
`★ Karambit | Freehand` mientras el premio era `MAG-7 | Sonar` — literalmente el
"me va a dar un cuchillo y me dio una pistola" del reporte.

Ahora el premio se coloca en la casilla 42 **antes** de girar (como una ruleta de
verdad) y al parar sólo se enciende el glow (`markWinnerCard()`). No adelanta el
resultado: la casilla 42 está a ~6600px del inicio y la cinta arranca en 0, fuera
de la ventana visible; el arnés lo comprueba (`preRevealWinnerHidden`). Además
`realignWinner()` re-centra con la geometría **actual** si algo cambió de tamaño
durante el giro (barra de scroll, panel redimensionado); con la geometría estable
es un no-op de < 1px.

Nuevas comprobaciones del arnés: `preRevealIsThePrize` (la casilla 42 ya es el
premio a mitad de giro) y `preRevealWinnerHidden` (no se ve antes de girar),
medidas en 480px, 1280px, 1920px y 2560px y en sesión real. Con el código
anterior el arnés sale en rojo (`preRevealIsThePrize: false`); con el arreglo, en
verde.

`sw.js` sube a `opencase-shell-v3`: sin eso el precache de 7 días seguiría
sirviendo el `app.js` viejo.

**Comprobaciones:** suite **461 pass / 0 fail**; `typecheck` exit 0; `lint` exit 0;
`node --check` en `app.js` y `sw.js`; arnés en verde (y en rojo con el código
anterior, que es lo que valida el arnés).

No tocado a propósito: el poll de 1 s de opencase
(`csgo-opencase/app.js:1277-1294`). Es la red de seguridad que reconcilia el
monedero y `tradesBook` si el push se pierde; cuesta 1 petición/s de ~350 B,
14× menos que el `tick` que sí se ha quitado. Sin evidencia de que estorbe, no se
toca.
