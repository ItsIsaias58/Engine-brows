#!/usr/bin/env bash
# update-libcurl.sh — reemplaza el core libcurl embebido en @mercuryworkshop/libcurl-transport
# por el build de produccion de libcurl.js (update/libcurl.js), con el wasm EMBEBIDO.
#
# Uso:  ./scripts/update-libcurl.sh [ruta/a/libcurl.js]
#
# Notas:
#   - Ejecutar DESPUES de `bun install` (que restaura el paquete stock de npm)
#   - El wasm se toma del paquete oficial npm libcurl.js (misma version que el core)
#   - Tras el swap:  bun run build  &&  systemctl --user restart lyra.service
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$ROOT/update/libcurl.js}"
DIST="$ROOT/node_modules/@mercuryworkshop/libcurl-transport/dist"
BUNDLE="$DIST/index.mjs"

[[ -f "$SRC" ]] || { echo "ERROR: no existe $SRC"; exit 1; }
[[ -f "$BUNDLE" ]] || { echo "ERROR: falta $BUNDLE (ejecuta bun install)"; exit 1; }

# shim esbuild estandar que genera el bundler del paquete (lineas iniciales)
read -r -d '' SHIM <<'EOF' || true
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
EOF

echo "==> extrayendo wrapper parcheado (desde la ULTIMA marca // src/main.ts)"
WRAP_LINE="$(grep -n '^// src/main.ts$' "$BUNDLE" | tail -1 | cut -d: -f1)"
[[ -n "$WRAP_LINE" ]] || { echo "ERROR: no encuentro el boundary // src/main.ts"; exit 1; }
sed -n "${WRAP_LINE},\$p" "$BUNDLE" > /tmp/ul-wrap.mjs
grep -q "LibcurlClient" /tmp/ul-wrap.mjs || { echo "ERROR: el wrapper extraido no contiene LibcurlClient"; exit 1; }
echo "    wrapper: $(wc -l < /tmp/ul-wrap.mjs) lineas desde la linea $WRAP_LINE"

echo "==> descargando wasm oficial de libcurl.js (version del core nuevo)"
CORE_VER="$(grep -oa 'lib="[0-9.]*"' "$SRC" | head -1 | grep -oa '[0-9.]*')"
CORE_VER="${CORE_VER:-0.7.4}"
TMPD="$(mktemp -d)"
curl -sL "https://registry.npmjs.org/libcurl.js/-/libcurl.js-${CORE_VER}.tgz" -o "$TMPD/pkg.tgz"
tar xzf "$TMPD/pkg.tgz" -C "$TMPD"
WASM="$TMPD/package/libcurl.wasm"
[[ -f "$WASM" ]] || { echo "ERROR: el tgz no trae libcurl.wasm"; exit 1; }
echo "    wasm: $(du -h "$WASM" | cut -f1) (v$CORE_VER)"

echo "==> embebiendo wasm como data-URI en el core"
node -e '
const [, srcPath, wasmPath, outPath] = process.argv; // con node -e no hay argv[1] extra
const fs = require("fs");
const b64 = fs.readFileSync(wasmPath).toString("base64");
const dataUri = "data:application/octet-stream;base64," + b64;
let core = fs.readFileSync(srcPath, "utf8");
const target = "pe(ue=\"emscripten_compiled.wasm\")";
if (!core.includes(target)) { console.error("ERROR: punto de inyeccion no encontrado (cambio de build?)"); process.exit(1); }
core = core.replace(target, "pe(ue=" + JSON.stringify(dataUri) + ")");
fs.writeFileSync(outPath, core);
console.log("core con wasm embebido: " + (core.length/1024/1024).toFixed(2) + " MB");
' "$SRC" "$WASM" /tmp/ul-core.mjs

echo "==> ensamblando bundle (shim + core + wrapper)"
printf '%s\n\n' "$SHIM" > /tmp/ul-new.mjs
cat /tmp/ul-core.mjs >> /tmp/ul-new.mjs
printf '\n' >> /tmp/ul-new.mjs
cat /tmp/ul-wrap.mjs >> /tmp/ul-new.mjs

N_EXPORTS="$(grep -oc 'export const libcurl=' /tmp/ul-new.mjs || true)"
[[ "$N_EXPORTS" == "1" ]] || { echo "ERROR: se esperaba 1 export del core, hay $N_EXPORTS"; exit 1; }

echo "==> generando CJS y verificando sintaxis"
bun build /tmp/ul-new.mjs --format=cjs --outfile=/tmp/ul-new.js 2>&1 | grep -v "^$" | head -2 || true
node --check /tmp/ul-new.mjs && node --check /tmp/ul-new.js && echo "    sintaxis OK"

echo "==> instalando"
cp /tmp/ul-new.mjs "$DIST/index.mjs"
cp /tmp/ul-new.js "$DIST/index.js"
cp "$WASM" "$DIST/emscripten_compiled.wasm"
cp "$WASM" "$DIST/libcurl.wasm"

echo "==> sanity"
grep -c "Symbol.iterator" "$DIST/index.mjs" | xargs echo "    parches header-guard:"
grep -oc 'running libcurl.js v' "$DIST/index.mjs" | xargs echo "    log de version:"
grep -oa 'lib="[0-9.]*"' "$DIST/index.mjs" | head -1 | xargs echo "    version core:"
grep -oc "data:application/octet-stream;base64" "$DIST/index.mjs" | xargs echo "    wasm embebido:"

echo "==> LISTO. Ahora: bun run build && systemctl --user restart lyra.service"
rm -rf "$TMPD"
