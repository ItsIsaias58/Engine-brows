# lyra :3
a really cool web-proxy

[![join our discord](https://invidget.switchblade.xyz/4GeWaGPh6c)](https://discord.gg/4GeWaGPh6c)

## features
- nice ui
- thousands of games aggregated from multiple sources
- free anime streaming
- cloud syncing
- functional chrome extensions support
- very efficient
- private by design

## self-hosting
```bash
# clone
git clone https://github.com/gayq/lyra

# run setup file
cd lyra
bash setup.sh
```
## local development
```bash
bun i
bun dev
```

## prod stack + public url
```bash
./serve.sh                 # arranca todo y abre un tunel de Cloudflare
./serve.sh --no-tunnel     # solo local
```

`serve.sh` levanta el servidor, el servicio de mercado (owngames) y, por
defecto, un **tunel con URL aleatoria** para entrar desde otro dispositivo. El
tunel se cierra junto con el stack y la URL del juego (con su ruta
`/owngames/bolsa-trading-floor/`) queda en `logs/public-url.txt`.

Hay dos proveedores, elegibles con `LYRA_TUNNEL_PROVIDER`:

| valor | que usa | URL |
|---|---|---|
| `auto` (defecto) | cloudflared y, si tu DNS bloquea su dominio, ssh | la que funcione |
| `cloudflare` | cloudflared quick tunnel | `https://<algo>.trycloudflare.com` |
| `localhost.run` | `ssh -R 80`, sin instalar nada | `https://<algo>.lhr.life` |

`auto` existe por un caso real: con perfiles de **NextDNS** que bloquean
`*.trycloudflare.com`, el tunel de Cloudflare conecta perfectamente (conexion
saliente, edge, HTTPS) pero **tu navegador no resuelve el dominio**, asi que
parece que no existiera. En ese caso `serve.sh` lo detecta y baja a
`localhost.run`.

Si `cloudflared` no esta instalado se descarga a `vendor/cloudflared/` la
primera vez (nada global). Apagalo con `--no-tunnel` o `LYRA_TUNNEL=0`; para
otros parametros de cloudflared usa `CLOUDFLARED_OPTS`.

Arrancar `serve.sh` de nuevo es seguro: detiene el stack y el tunel anteriores
antes de empezar, asi que nunca se acumulan instancias ni URLs duplicadas. La
URL tarda unos segundos y sale en pantalla con su ruta lista para abrir.

### el tunel se reabre solo

Un quick tunnel no dura para siempre: el ssh de `localhost.run` y `cloudflared`
cortan por su cuenta a los minutos. Si eso pasaba, el tunel moria en silencio y
`logs/public-url.txt` seguia anunciando un host muerto (un **503** en el otro
dispositivo, sin pista de por que). Ahora `serve.sh` deja un supervisor
vigilando al hijo del tunel: si el proceso muere, o si el host responde mal tres
veces seguidas, lo reabre y **reescribe `public-url.txt` con la URL nueva**
(anunciandola en pantalla). El ultimo PID del tunel queda en `logs/tunnel.pid`,
que es lo que usa el cierre para apagarlo al instante.

El chequeo de salud solo cuenta si **esta** maquina resuelve el host del tunel:
con un DNS que filtra el dominio el chequeo da falso negativo, y no queremos
rotar la URL sin motivo. Si la reapertura falla, reintenta cada 30 s y el stack
sigue servido en local mientras tanto.

## bolsa: el precio no tiene suelo (y el panel de la vida)

El motor no recorta el precio. La caminata es geometrica (`fund * exp(ret)`), asi
que por si sola nunca llega a cero y no necesita tope: `MIN_PRICE` (ahora `1e-6`)
es solo la red de seguridad de un estado corrupto.

Antes valia **0.2** y se aplicaba con `Math.max()` en cada paso: al llegar al
suelo, cualquier retorno negativo daba menos de 0.2, el `Math.max` lo devolvia a
exactamente 0.2 y la serie quedaba clavada para siempre — una linea recta en la
grafica. Paso de verdad: en los datos reales **NORVX acumulo 258 barras en 0.20**
tras caer de $179.42 y **VLRA 103** tras caer de $424.07.

Habia un **segundo muro en el guardado**: `history.mjs` redondeaba a dos
decimales al escribir y al releer, asi que un precio de 0.00486 volvia como 0 y la
empresa se hundia en memoria pero resucitaba a cero al recargar. Ahora hay **un
solo redondeo de precios** para todo el servicio (`roundPrice` en `tuning.mjs`):
dos decimales para lo normal y mas decimales segun el precio baja.

El mismo criterio esta en el cliente: `safePrice()` sustituye a los
`Math.max(0.2, ...)` de la cinta, los eventos, la consola y las series generadas,
y el eje rotula con decimales adaptativos (`$0.0087`, no `$0.00`).

**El panel de abajo ya no repite las velas.** Antes dibujaba el cierre de las
velas que estaban justo encima (lo mismo dos veces). Ahora pinta la serie
**diaria** — un punto por dia de juego, la vida entera de la empresa, la misma
ventana que la vista 1W, guardada en el mismo store local y pedida una sola vez
por empresa — y marca encima la franja que las velas estan mostrando. El zoom de
arriba no lo mueve: es el mapa, no el detalle. Se rotula solo (`VIDA · N dias ·
$min → $max`) y sin la serie diaria cae al tramo visible.

## bolsa: pantalla de carga y cache del cliente

El juego de `owngames/bolsa-trading-floor/` descarga y guarda su parte grafica en
el navegador, para que el servidor solo sostenga la conexion (el WebSocket y los
datos del mercado).

**Progreso real, no decorativo.** Mientras carga, cada fila de la pantalla es un
archivo de verdad con los bytes y el tiempo que el navegador tardo en traerlo,
sacados de `performance.getEntriesByType('resource')`. Los que vinieron del disco
del jugador se marcan como `caché`. Antes de que `js/boot.js` entre en escena
(con red lenta tambien tarda) no hay nada que medir, asi que la barra es
indeterminada a proposito en vez de inventar un porcentaje.

| visita | estaticos que le pide al servidor |
|---|---|
| 1ª (sin cache, instala el service worker) | ~32 (todo) |
| 2ª (el SW ya controla) | ~29 (los guarda) |
| 3ª en adelante | **0** |
| Ctrl+Shift+R (recarga dura) | todos otra vez |

`sw.js` guarda los estaticos y los sirve del disco durante 30 minutos
(`FRESH_MS`). Pasado ese rato los sirve igual y los refresca por detras. Para ver
un cambio al instante sin esperar: **Ctrl+Shift+R** (una recarga dura manda
`cache:'reload'` y salta la cache) o subir `CACHE_VERSION` en `sw.js`.

El service worker **nunca** cachea `/api/` ni `/ws/`: los precios, la cinta y el
perfil siempre van a la red.

## credits
- [selenite](https://selenite.cc/) - game source
- [edurocks](https://www.edurocks.org/) - game source
- [gn-math](https://github.com/gn-math/gn-math.github.io/) - game source
- [wasm.rip](https://wasm.rip/) - game source
- [velara](https://velara.cc/) - game source
- [truffled](https://truffled.lol/) - game source
- [mercury workshop](https://github.com/mercuryworkshop/) - scramjet, epoxy, and libcurl
- [sapphire](https://github.com/x8rr/sapphire) - rivet's base

## license
this project is licensed under [GNU AGPLv3](./LICENSE)