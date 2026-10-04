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
