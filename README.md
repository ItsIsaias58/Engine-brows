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
