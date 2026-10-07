# Arneses de rendimiento (FASE 0)

Herramientas reproducibles que respaldan las cifras de `PERF-BASELINE.md`.
Levantan un `services/market` real en un puerto efímero con `dataDir` temporal y
un `tickMs` fijo, así que no tocan el stack en marcha ni tus datos.

## Requisitos

- `bun` (los de solo-servidor corren también con `node`).
- Chromium para los arneses de navegador. Por defecto se busca en
  `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`; sobreescribe con
  `LYRA_CHROMIUM=/ruta/al/chrome`.
- `playwright-core` no es dependencia del repo. Los arneses de navegador lo
  necesitan accesible desde el directorio donde los ejecutes:

  ```sh
  npm install playwright-core   # en un directorio de trabajo, p. ej. /tmp/lyra-baseline
  NODE_PATH=/tmp/lyra-baseline/node_modules bun scripts/perf/browser-baseline.mjs
  ```

## Arneses

Solo servidor (sin Chromium, sin dependencias extra):

| Arnés | Qué mide |
| --- | --- |
| `measure-payload.mjs` | bytes por frame `tick`, snapshot, velas, `market.json` |
| `live-server.mjs` | bytes/cliente/s de 1, 5 y 20 sockets + CPU de un tick |
| `snapshot-phases.mjs` | coste en el hilo principal de cada etapa del snapshot (67 MB) |

Navegador (requieren `playwright-core` + Chromium):

| Arnés | Qué mide |
| --- | --- |
| `browser-baseline.mjs` | DCL/boot/bytes por tipo, clics P50/P95, heap |
| `profile-cpu.mjs` | perfil CPU con red estrangulada (1.5 / 0.75 Mbps, 150 ms) |
| `admin-lazy.mjs` | `admin.js` no se pide de invitado; el atajo lo carga |
| `cache-check.mjs` | ETag/304 del server y 2ª carga de bolsa servida por el SW |
| `opencase-cache.mjs` | 2ª carga de csgo-opencase servida por el SW |
| `cloudsync-main-thread.mjs` | jank de recibir el snapshot del worker: cuerpo crudo vs gzip transferido |

Todos imprimen un único JSON por stdout.
