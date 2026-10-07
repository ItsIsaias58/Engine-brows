## instalacion

Requiere [bun](https://bun.sh) 1.4.2 o superior (runtime y gestor de paquetes
del proyecto).

```bash
# 1. clona el repositorio
git clone https://github.com/ItsIsaias58/Engine-brows
cd Engine-brows

# 2. instala las dependencias
bun i

# 3. arranca el stack completo (servidor + juegos + tunel publico)
./serve.sh
```

`./serve.sh` levanta el servidor, el servicio de mercado y un tunel con URL
aleatoria para entrar desde otro dispositivo. Usa `./serve.sh --no-tunnel` para
solo local.

Para desarrollo local:

```bash
bun dev
```

### que el servidor aguante con la sesion bloqueada

Con la pantalla bloqueada o la tapa cerrada, Ubuntu suspende la maquina y el
servidor (y su URL publica) dejan de responder aunque el proceso siga vivo.

```bash
./nosleep.sh            # deja la laptop despierta (activar)
./nosleep.sh --status   # comprobar el estado
./nosleep.sh --undo     # volver a permitir suspender
```

`nosleep.sh` hace dos cosas:

1. apaga la **suspension automatica de GNOME** (Ajustes -> Energia). Esta es la
   pieza que resuelve el caso "la sesion se cierra por el tiempo": la maquina
   se dormia tras 1 h (corriente) / 15 min (bateria) de inactividad, y asi ya
   no lo pide nunca.
2. instala la unidad de usuario `lyra-nosleep.service`, que sujeta el lock
   `sleep:idle:handle-lid-switch` de logind: el sistema no entra en reposo y la
   tapa no suspende. Vive fuera de la sesion, asi que aguanta la pantalla
   bloqueada y, con `Linger=yes`, tambien el cierre de sesion.

No necesita `sudo`.

El lock **no** frena una suspension que pidas tu a mano: con sesion activa
polkit te autoriza (`allow_active=yes`) y logind aplica esa autorizacion por
encima del lock — comprobado con `systemctl suspend`, que durmio la maquina
igual. Lo que impide que se duerma sola por inactividad es el ajuste de GNOME.

`./server.sh` trae lo mismo integrado y activo por defecto (`KEEP_AWAKE=1`):
mientras esa corrida viva apaga la suspension automatica de GNOME y sujeta el
lock de logind, y al salir revierte **solo** lo que cambio (`KEEP_AWAKE=0` lo
desactiva). La diferencia es el alcance: la unidad `lyra-nosleep.service` sigue
en pie con la sesion cerrada, mientras que una corrida manual de `./server.sh`
muere con la terminal que la lanzó.

Si ademas quieres que la tapa quede fijada en el sistema (que no suspenda haya
o no sesion, sin depender de ningun proceso nuestro), hay una capa opcional que
se aplica una sola vez:

```bash
sudo ./nosleep.sh --sudo    # logind: HandleLidSwitch=ignore (se relee al momento)
```

Escribe `/etc/systemd/logind.conf.d/99-lyra-nosleep.conf` y recarga logind sin
cortar la sesion; `sudo ./nosleep.sh --undo` lo retira.

Ojo: sin suspension la laptop no ahorra bateria, asi que si la tienes
desenchufada vigila el nivel. El stack en si (`serve.sh`) ya se lanza bajo
`systemd --user` con `Restart=always`, de modo que si algo lo mata vuelve solo.

### si no tienes bun

bun no viene con el sistema; instalalo primero.

Linux / macOS:

```bash
curl -fsSL https://bun.sh/install | bash
```

Windows (PowerShell):

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Alternativas: `brew install oven-sh/bun/bun` (Homebrew) o
`npm install -g bun` (con Node/npm ya instalados).

Al terminar, abre una terminal nueva (o recarga el `PATH`) y comprueba la
version antes de continuar:

```bash
bun --version   # 1.4.2 o superior
```

## diferencias con lyra base

Comparacion con el proyecto original [`gayq/lyra`](https://github.com/gayq/lyra)
(base `386e3a4`, version `0.1.2`), del que parte este repositorio. Este es el
resumen de en que se separa Engine-brows.

| area | lyra base | Engine-brows |
|---|---|---|
| mercado / owngames | no existe | `services/market/` completo: `bolsa-trading-floor` y `csgo-opencase`, con economia, cuentas, casos, casino, dividendos, historiales |
| reproductor de musica | no existe | `src/features/music/` + `src/components/music/MusicPanel.tsx` (embeds de YouTube/Spotify, cola, panel redimensionable) |
| arranque y tunel | no existe | `serve.sh`, `server.sh`, `url.sh` y `update/` (tunel con supervisor que lo reabre solo) |
| energia | no existe | `nosleep.sh` + `scripts/keep-awake.sh`: el servidor sigue disponible con la sesion bloqueada |
| pruebas | 0 ficheros | 21 ficheros `*.test.*` (+ `knip`) |
| cliente (navegador/core) | — | `openInApp.ts`, `stageOverlay.ts`, `frameFocus.ts`, `hotCache.ts`, `webRequestType.ts`, `accessibility.ts`, `customization.ts`, `internalRoutes.ts` |
| servidor | `dns.mjs` | `edgeCompression.mjs`, `serviceRoutes.mjs`, `staticPath.mjs` |
| scripts | `bench-rivet.mjs` | `fetch-csgo-assets`, `patch-epoxy-reconnect`, `patch-baremux-ws`, `wisp-handshake`, `update-libcurl`, `cf-setup` y utilidades de test |
| tamano de `src/` (ts/tsx) | ~25.000 lineas | ~29.100 lineas |
| version (`package.json`) | `0.1.2` | `0.0.4` |

Ademas, `package.json` suma los scripts `test`, `test:sync-prod`, `sync:prod`,
`dev:market` y `knip`, fija las dependencias a versiones exactas y amplia el
`postinstall` con `patch-epoxy-reconnect.mjs` y `patch-baremux-ws.mjs`.

### ficheros del base que no estan aqui

- servidor y herramientas: `server/dns.mjs`, `scripts/bench-rivet.mjs`
- cliente: `motion.ts` y `motion.css`, `AnimeResumeCard.tsx`, `TabIcon.tsx`,
  `EditableField.tsx`, `captionLayout.ts`, `seekBar.ts`, `rivetDns.ts`,
  `backgroundTask.ts`, `animeProgress.ts`
- sincronizacion: `prepareSnapshot.ts`, `snapshotPayload.ts`,
  `snapshot.worker.ts`, `syncTransfer.ts` y `services/cloudsync/src/transfer.rs`
- catalogo y juegos: `catalogProcessing.ts`, `catalog.worker.ts`,
  `prepareCatalog.ts`
- servicios Rust: `isao` (`catalog.rs`, `catalog_store.rs`, `upstream.rs`) y
  `mochi` (`admission.rs`, `stream/megavid.rs`, `stream/range.rs`,
  `stream/subtitles.rs`)

## credits
- [selenite](https://selenite.cc/) - game source
- [edurocks](https://www.edurocks.org/) - game source
- [gn-math](https://github.com/gn-math/gn-math.github.io/) - game source
- [wasm.rip](https://wasm.rip/) - game source
- [velara](https://velara.cc/) - game source
- [truffled](https://truffled.lol/) - game source
- [mercury workshop](https://github.com/mercuryworkshop/) - scramjet, epoxy, and libcurl
- [sapphire](https://github.com/x8rr/sapphire) - rivet's base
- [gayq/lyra](https://github.com/gayq/lyra) - base del proyecto

## license
this project is licensed under [GNU AGPLv3](./LICENSE)
