#!/usr/bin/env bash
# Muestra la URL publica vigente del stack, en cualquier momento.
#
#   ./url.sh           imprime la URL y verifica que responde
#   ./url.sh --open    ademas la abre en el navegador
#   ./url.sh --copy    ademas copia la URL del juego al portapapeles (xclip/wl-copy)
#
# La URL la escribe serve.sh en logs/public-url.txt al abrir el tunel. Este
# script NO abre tuneles: solo lee, verifica y muestra. Si el tunel no
# responde, avisa (o el stack esta apagado, o el DNS de esta maquina filtra
# el dominio — en ese caso prueba la URL desde otro dispositivo).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL_FILE="$ROOT/logs/public-url.txt"

GAME_URL="$(head -1 "$URL_FILE" 2>/dev/null || true)"
BASE_URL="${GAME_URL%%/owngames*}"
BASE_URL="${BASE_URL%%/w/*}"

c_ok() { curl -fsS -o /dev/null -m 6 "$1" 2>/dev/null; }

# Verificacion con fallback DoH: algunas redes (esta incluida) filtran el DNS
# de *.trycloudflare.com, pero el tunel funciona igual desde otros dispositivos.
# Resolvemos via dns.google y conectamos directo al edge para no dar falsos
# negativos desde esta maquina.
verify() {
  local url="$1" host ip
  c_ok "$url/health" && return 0
  host="${url#https://}"; host="${host%%/*}"
  ip="$(curl -s -m 6 "https://dns.google/resolve?name=$host&type=A" 2>/dev/null \
        | grep -oE '"data":"[0-9.]+"' | head -1 | grep -oE '[0-9.]+')"
  [[ -n "$ip" ]] && c_ok_with_resolve "$url/health" "$host" "$ip" && return 0
  return 1
}
c_ok_with_resolve() {
  curl -fsS -o /dev/null -m 8 --resolve "$2:443:$3" "$1" 2>/dev/null
}

OPEN=0; COPY=0
for arg in "$@"; do
  case "$arg" in
    --open) OPEN=1 ;;
    --copy) COPY=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
  esac
done

if [[ -z "$GAME_URL" ]]; then
  echo "==> No hay URL publica guardada (logs/public-url.txt vacio)."
  if c_ok "http://127.0.0.1:4444/health"; then
    echo "    El stack esta vivo en local: http://127.0.0.1:4444"
    echo "    Arranca ./serve.sh para abrir el tunel publico."
  else
    echo "    El stack no esta corriendo: arranca ./serve.sh"
  fi
  exit 1
fi

if verify "$BASE_URL"; then
  echo "==> URL publica: VIVA ✓"
  echo "    Juego:  $GAME_URL"
  echo "    Lyra:   $BASE_URL/"
  echo "    Local:  http://127.0.0.1:4444/"
else
  echo "==> URL publica guardada pero SIN respuesta ahora mismo:"
  echo "    $GAME_URL"
  echo "    Puede ser que el stack este apagado, o que el DNS de esta maquina"
  echo "    filtre el dominio: prueba la URL desde otro dispositivo, o revisa"
  echo "    el arranque (./serve.sh) para una URL nueva."
  exit 1
fi

case "$BASE_URL" in
  *loca.lt)
    key="$(curl -s -m 6 https://loca.lt/mytunnelpassword 2>/dev/null || true)"
    [[ -z "$key" ]] && key="$(curl -s -m 6 https://api.ipify.org 2>/dev/null || true)"
    echo "    Clave 1ra visita: ${key:-?}  (la pide solo la primera vez por navegador)"
    ;;
esac

if [[ $COPY -eq 1 ]]; then
  if command -v wl-copy >/dev/null 2>&1; then printf '%s' "$GAME_URL" | wl-copy
  elif command -v xclip >/dev/null 2>&1; then printf '%s' "$GAME_URL" | xclip -selection clipboard
  else echo "    (portapapeles no disponible: instala xclip o wl-copy)"; COPY=0; fi
  [[ $COPY -eq 1 ]] && echo "    URL copiada al portapapeles ✓"
fi
if [[ $OPEN -eq 1 ]]; then
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$GAME_URL" >/dev/null 2>&1 &
  else echo "    (xdg-open no disponible)"; fi
fi
exit 0
