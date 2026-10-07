# Auditoría de rendimiento — lyra (microcongelados y latencia)

Fecha: 2026-10-04. Síntoma reportado: la UI se congela 1-3 s ("das clic y no
jala"), a veces al cargar, con sospecha de animaciones y de saturación de ancho
de banda.

## Resumen ejecutivo

La causa dominante de los congelados **no es la animación**: es el **cloud sync**
serializando el navegador entero (~67 MB) en el hilo principal **muy seguido**.
El disparador es que el propio juego escribe en `localStorage` cada 2 s
(`saveGame`), y el hook de storage marca "sucio" → export + `JSON.stringify` de
todo el IndexedDB + hashing, en el hilo principal.

Además, el bloque de diagnóstico re-serializaba **cada base de datos** con
`JSON.stringify` otra vez, duplicando el costo solo para un `console.warn`.

## Hallazgos (con evidencia)

### 1. Cloud sync: export/serialización completa repetida — CRÍTICO (corregido)
- `src/features/cloudsync/cloudsync.ts`
  - `markDirty()` (debounce 1.5 s) → `syncData()`; hooks en `localStorage.setItem`,
    `IDBObjectStore.put/add/delete/clear` y el setter de `document.cookie`.
  - `syncData()`: `await window.lyraExportAllData()` (lee TODO el IndexedDB +
    storage + cookies) y luego `JSON.stringify(snapshot)` (~67 MB) → hilo principal.
  - `payloadFingerprint(body)` re-codifica 67 MB con `TextEncoder` + `crypto.subtle`.
  - `checkForChanges()` hacía **otro** export+fingerprint completo cada 60 s.
- Disparador: `services/market/public/bolsa-trading-floor/js/state.js:350`
  `saveGame()` escribe en `localStorage` **cada 2 s** (`main.js:81`).
- Impacto: cada corrida = cuello de botella de ~1-3 s del hilo principal
  (congela shell + todos los iframes same-origin) **y** subida de ~67 MB.

### 2. Diagnóstico que duplicaba el costo — CRÍTICO (corregido)
- `cloudsync.ts` medía `new TextEncoder().encode(body).byteLength` (otra copia de
  67 MB) y `JSON.stringify(db)` por cada base para listar "las más pesadas".

### 3. Shell / diseño: iframes same-origin comparten hilo — estructural
- Lyra carga juegos (incluidos Unity WebGL) en iframes **same-origin** → comparten
  el hilo principal. Un juego pesado congela la UI del navegador. Mitigación real:
  frames cross-origin (OOPIF). No se toca aquí.

### 4. Juego bolsa: temporizadores (bajo impacto, sin cambios)
- `main.js`: `tickMarket` 1.4 s, `tickBankruptcy` 250 ms (sale temprano si no hay
  bancarrota), `tickEarningsCountdowns` 1 s, `checkLocalOrders` 1.5 s,
  `saveGame` 2 s, `update` 1 s. En su mayoría baratos.
- El chart usa `requestAnimationFrame` (ya coalescido) y el refresco de filas ya
  va escalonado (`market.js` `refreshMarketRowsStaggered`).

### 5. Red / ancho de banda
- El upload va con **gzip** (`cloudsync.ts` `Content-Encoding: gzip`), así que el
  peso real en red es menor que 67 MB, pero **cada 2 s** seguía siendo enorme.
- Service worker del juego (`bolsa-trading-floor/sw.js`): sirve estáticos desde
  caché hasta 30 min (`FRESH_MS`), correcto; se subió `CACHE_VERSION` para forzar
  el `net.js` corregido.

## Cambios aplicados

1. **Mínimo entre envíos** `MIN_UPLOAD_INTERVAL = 15000`:
   `markDirty()` ahora programa el envío como
   `max(DIRTY_DEBOUNCE, _nextUploadAt - now)`, y `syncData()` sella
   `_nextUploadAt` **antes** del trabajo caro. Se pasa de un snapshot cada ~2 s a
   como mucho uno cada 15 s (con coalescing de ráfagas).
2. **Diagnóstico barato**: sin `TextEncoder` del body (usa `body.length`) y sin
   `JSON.stringify` por base (usa conteo de registros).
3. **Escaneo de seguridad solo en segundo plano**: `checkForChanges()` retorna
   temprano si la pestaña está visible (`document.hidden`). Los cambios reales los
   marca `markDirty` al instante; el escaneo (lo más caro) ya no bloquea mientras
   el usuario juega.
4. **Export diferido a tiempo ocioso**: `syncData()` espera `whenIdle()`
   (`requestIdleCallback`, con tope de 1 s) antes de leer+serializar el navegador,
   para no coincidir con una interacción.
5. **Autoguardado del juego sin escrituras redundantes**: `saveGame()` en
   `state.js` compara el payload y sólo escribe en `localStorage` si cambió → deja
   de marcar `dirty` al cloud sync cada 2 s cuando nada cambió.
6. **Export/serialización en Web Worker** (`snapshotPayload.worker.ts`): el hilo
   principal sólo recolecta storage+cookies (barato) y el worker lee IndexedDB,
   `JSON.stringify` y calcula el fingerprint (decenas de MB **fuera del hilo
   principal**). Con **fallback automático** al hilo principal si el worker no está
   disponible o falla (nunca se pierde un sync). Bundle verificado: `vite build`
   emite `dist/assets/snapshotPayload.worker-*.js`. Se refactorizó
   `syncSnapshot.ts` (`exportIndexedDBSnapshot` + `exportNonIndexedDBParts`) y
   `cloudsync.ts` (`buildSnapshotPayload`).
7. `net.js` (turno anterior): `marketInFlightOps` consistente en array.

## Verificación
- `bun run typecheck` → exit 0
- `bun run lint` → exit 0
- `bun test --isolate scripts src services` → 457 pass / 0 fail

## Recomendaciones siguientes (no aplicadas)

- **Reducir el snapshot (~67 MB)**: sin ver qué bases lo engordan no se puede
  decidir con seguridad (excluir la equivocada pierde saves). El log (ahora desde
  el worker) da el conteo de registros por base para identificarlas; con esos
  datos se añaden a `LOCAL_ONLY_DATABASES` / `isSyncableDatabase`.
- **OOPIF** para juegos pesados (Unity): aislar en proceso cross-origin (cambio de
  arquitectura, no de un archivo).
- **Medir con DevTools Performance** (grabar 10 s con el juego abierto) para
  cuantificar long tasks antes/después de estos cambios.
