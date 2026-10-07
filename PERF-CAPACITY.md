# PERF-CAPACITY — Disco, RAM, CPU y cuántos jugadores aguanta esta máquina

Fecha: 2026-10-07. Continuación medida de `PERF-BASELINE.md` (§1–§12). Esta hoja
responde: **cuánto pesa el stack, cuánto consume y cuántas personas pueden
jugar/probar a la vez**.

## 0. Requisitos y hardware de la máquina de medición

Laptop donde corre el stack (usada como servidor):

| Recurso | Valor medido |
|---|---|
| CPU | **Intel Core i5-1235U** (12ª gen), 10 núcleos (2 P + 8 E) / **12 hilos**, hasta 4.4 GHz |
| RAM | **7 639 MB ≈ 7.5 GiB** totales |
| Disco | LVM `/` **231 GB** totales, 186 GB usados, **35 GB libres** |
| SO | Ubuntu 24.04, kernel `7.0.0-34-generic` |

Software (los "requisitos" del stack):

| Pieza | Versión |
|---|---|
| Bun (server de juego + `prod.mjs`) | **1.4.1** |
| Node.js | 24.21.0 |
| Rust / cargo (nuru, mochi, cloudsync, isao) | 1.98.1 |
| PHP | 8.3.6 |

> Método: el stack productivo se levantó con `serve.sh --no-build` y
> `LYRA_TUNNEL=0` (sin exponer URL pública) solo para medir; los procesos se
> leen de `/proc` y `ps`. La carga se genera con `scripts/perf/load-clients.mjs`
> (N sockets WebSocket reales contra `ws://127.0.0.1:4006/ws/market`), el cliente
> con `scripts/perf/client-footprint.mjs` (Chromium de Playwright, PSS real).

## 1. Peso en DISCO

### Working tree completo (con artefactos de compilación)

| Ruta | Tamaño | Qué es |
|---|---:|---|
| `services/*/target` | **11.2 GB** | builds Rust: nuru 3.8 GB, mochi 3.8 GB, cloudsync 2.0 GB, isao 1.6 GB |
| `vendor/` | 912 MB | folio 874 MB + cloudflared 39 MB |
| `node_modules/` | 293 MB | dependencias JS |
| `dist/` | 20 MB | cliente compilado (lo que se sirve) |
| `.git/` | 18 MB | historial (603 ficheros rastreados, ~16 MiB de objetos) |
| `public/` | 5.8 MB | estáticos |
| `services/market/` | 15 MB | server + **`data/` 7.2 MB** (estado persistido) |
| `packages/`, `src/` | 7.8 MB | código |
| **Total** | **≈ 13 GB** | |

### Lo que de verdad hace falta para **ejecutar** (sin artefactos de compilación)

| Componente | Tamaño |
|---|---:|
| `dist/` (cliente compilado) | 20 MB |
| `public/` | 5.8 MB |
| `services/` sin `target/` | 27 MB |
| `node_modules/` | 293 MB |
| binarios Rust release (mochi, nuru, cloudsync) | ~19 MB |
| **Total en ejecución** | **≈ 365 MB** |

Los **11.2 GB de `target/`** son intermedios de compilación: se pueden borrar
(`cargo clean` / `rm -rf services/*/target`) y se reconstruyen con
`cargo build --release`. No hacen falta para servir.

### Crecimiento de datos (estado persistido del mercado)

| Fichero | Tamaño |
|---|---:|
| `services/market/data/market.json` | 96 KB |
| `services/market/data/history/` | 4.0 MB |
| `services/market/data/players.json` | 24 KB |
| `services/market/data/chat.json` | 4 KB |
| `services/market/data/admins.json` | 20 B |
| **Subtotal** | **≈ 4.1 MB** (crece con cuentas y velas) |

## 2. Consumo de RAM (RSS por proceso)

### En reposo (servidor productivo tal como lo arranca `serve.sh`)

| Proceso | RSS |
|---|---:|
| `bash serve.sh` | 4 MB |
| `bun server/prod.mjs` (borde, gzip, estáticos) | 23–26 MB |
| `bun services/market/server.mjs` (motor + WS) | 40–56 MB |
| `nuru` (release, wisp) | 3–8 MB |
| `mochi` (release, proxy) | 3–8 MB |
| **Total stack productivo** | **≈ 75–100 MB** |
| `cloudsync` (release, solo modo dev) | 27 MB |
| **Total con cloudsync/isao** | **≈ 110–130 MB** |

Menos de **1.5 %** de la RAM de la laptop (7.5 GiB). El stack no compite por
memoria con el escritorio.

### Bajo carga (proceso `market`, el que sirve a los jugadores)

El RSS **se mantiene plano**: no crece de forma apreciable con los clientes.

| Clientes WS | RSS del `market` |
|---|---:|
| 1 | ~53 MB |
| 100 | ~56 MB |
| 1 000 | ~55 MB |
| 4 000 | ~55 MB |

Coste marginal ≈ **4 KB por conexión** (buffers de socket). El snapshot de
conexión (~8.2 KB) se serializa una vez y se reutiliza.

## 3. Consumo de CPU

### En reposo

| Proceso | CPU (% de un núcleo) |
|---|---:|
| `market` (motor avanzando 1 tick/s) | **~1.0 %** |
| `prod.mjs`, `nuru`, `mochi` | ~0 % |
| **Total** | **< 1.2 % de un núcleo** |

### Bajo carga real (`scripts/perf/load-clients.mjs`, ventana de 12 s)

| Clientes WS | CPU del `market` (% de 1 núcleo) | % de la máquina (12 hilos) |
|---:|---:|---:|
| 1 | 0.75 % | 0.06 % |
| 25 | 1.17 % | 0.10 % |
| 50 | 0.83 % | 0.07 % |
| 100 | 0.92 % | 0.08 % |
| 200 | 1.17 % | 0.10 % |
| 500 | 2.25 % | 0.19 % |
| 1 000 | 2.50 % | 0.21 % |
| 2 000 | 2.67 % | 0.22 % |
| 4 000 | **5.92 %** | 0.49 % |

**Clave:** el CPU **no** escala linealmente con los jugadores. El coste dominante
es el **tick del motor** (una vez por segundo, igual con 1 o con 4 000 clientes,
~0.35 ms/tick medido en `PERF-BASELINE.md` §1); el broadcast a cada socket añade
un coste mínimo. Coste marginal medido ≈ **0.0016 % de un núcleo por jugador**
(2 000→4 000 clientes). Con un solo núcleo saturado el techo teórico ronda
**~60 000 clientes**, muy por encima de lo que aguanta cualquier red doméstica.

Egress por jugador: **4.94 KB/s constantes** (1 frame `tick`/s, medido).
El servidor **no** gasta CPU en recomprimir por cliente: el `tick` se serializa
una vez y se reparte.

## 4. Huella del CLIENTE (una pestaña del juego en Chromium)

| Pestaña | PSS marginal/pestaña | Heap JS/pestaña |
|---:|---:|---:|
| 1 | 310 MB (incluye arranque de GPU) | 4.9 MB |
| 5 | 166 MB | 6.2 MB |
| 10 | **148 MB** | 5.7 MB |

Una pestaña del juego ≈ **150 MB de RAM real (PSS)** y ~5 MB de heap JS. La RAM
de pestaña la paga **cada jugador en su propio equipo**, no el servidor.

## 5. Cuántos pueden jugar/probar a la vez

Tres lecturas distintas de "simultáneos":

### 5.1 Servir jugadores reales (límite = red de subida)

El único cuello práctico es el **ancho de banda de subida**, porque cada jugador
recibe ~4.94 KB/s de forma continua:

| Subida disponible | Jugadores simultáneos (techo teórico) |
|---|---:|
| 5 Mbps | ~126 |
| 10 Mbps | ~253 |
| 20 Mbps | ~506 |
| 50 Mbps | ~1 265 |
| 100 Mbps | ~2 530 |

La CPU y la RAM **no** son el límite hasta órdenes de magnitud mayores
(~60 000 por CPU, RAM plana a 4 000). Con el túnel Cloudflare por delante, resta
algo de ancho de banda útil y comparte el enlace con el resto de lo que sirve la
máquina.

**Conclusión:** esta laptop sirve **con holgura cientos de jugadores
simultáneos**; el número final lo marca tu subida (~250 con 10 Mbps), no la
máquina.

### 5.2 Probar en la MISMA laptop (pestañas abiertas)

Con ~2.7 GB de RAM libres y ~150 MB por pestaña, caben **~15–18 pestañas** por
memoria; en la práctica el render y el escritorio lo bajan a **~8–10 pestañas
cómodas** a la vez.

### 5.3 Jugadores en red mala (throttled)

Con 1.5 Mbps↓ / 750 Kbps↑ / 150 ms (`PERF-BASELINE.md` §4): el primer load tarda
~3.9 s y el juego va a 0 long tasks; la carga inicial es **~1.05 MB** y a partir
de la segunda vez el service worker + ETag la sirven casi toda de caché
(`PERF-BASELINE.md` §8). Un jugador en red mala **no** castiga al servidor:
consume los mismos 4.94 KB/s.

## 6. Resumen en una línea

> El stack pesa **~365 MB en disco** para ejecutarse (13 GB con los builds Rust),
> usa **~75–100 MB de RAM** (plana bajo carga) y **~1 % de un núcleo en reposo**
> frente a **~6 % con 4 000 jugadores**; el techo real son **~250 jugadores
> simultáneos con una subida de 10 Mbps** (la CPU aguantaría ~60 000), y en esta
> laptop caben **~8–10 pestañas de prueba** a la vez.

## 7. Reproducir estas cifras

```sh
# servidor arriba (sin túnel público)
LYRA_TUNNEL=0 bash serve.sh --no-build

# CPU/RAM del servidor bajo N clientes reales
CLIENTS=1000 SECONDS=12 bun scripts/perf/load-clients.mjs

# huella de una pestaña del cliente (necesita playwright-core + Chromium)
NODE_PATH=/tmp/lyra-baseline/node_modules TABS=1,5,10 \
  bun scripts/perf/client-footprint.mjs

# disco
du -sh .; du -sh services/*/target vendor node_modules dist .git
```

Arnés nuevos: `scripts/perf/load-clients.mjs` y
`scripts/perf/client-footprint.mjs` (ver `scripts/perf/README.md`).

## 8. Limitaciones

- Los clientes de carga son **loopback** (misma máquina): miden CPU/RAM/bytes del
  servidor con fidelidad, pero **no** ejercitan el enlace WAN ni el túnel. El
  techo por subida (§5.1) es un cálculo sobre el egress medido, no una prueba de
  red real.
- La huella del cliente se midió en Chromium de Playwright en modo headless; un
  navegador con GPU real y perfil cargado puede consumir algo más.
- `cloudsync` e `isao` **no** los arranca `serve.sh` (son de modo dev); se midió
  `cloudsync` aparte. `isao` no tiene build release en esta máquina.
