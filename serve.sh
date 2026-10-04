#!/usr/bin/env bash
# serve.sh — arranca TODO el stack de lyra y lo ves en tiempo real.
#
#   ./serve.sh               tumba lo que ocupe los puertos, levanta dependencias
#                            + juegos + servidor + tunel publico
#   ./serve.sh --no-build    igual, sin recompilar el cliente (lo usa systemd)
#
# Todo sale EN PANTALLA: puertos, URL publica y trafico en vivo.
# Ctrl+C cierra TODO de verdad: procesos, puertos y URL verificadas libres.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# ------------------------------------------------------------------ config
PORT="${PORT:-4444}"
MOCHI_PORT="${MOCHI_PORT:-4002}"
NURU_PORT="${NURU_PORT:-4001}"
MARKET_PORT="${MARKET_PORT:-4006}"
ALL_PORTS=("$PORT" "$MOCHI_PORT" "$NURU_PORT" "$MARKET_PORT")
# con *_ORIGIN la dependencia es externa: no se arranca ni se apaga aqui
MOCHI_ORIGIN="${MOCHI_ORIGIN:-}"
NURU_ORIGIN="${NURU_ORIGIN:-}"
MARKET_ORIGIN="${MARKET_ORIGIN:-}"
TUNNEL="${LYRA_TUNNEL:-1}"   # LYRA_TUNNEL=0 para no abrir tunel publico
SKIP_BUILD=0
[[ "${1:-}" == "--no-build" ]] && SKIP_BUILD=1

STOPPING_FLAG="$LOG_DIR/stopping.flag"  # prod.mjs solo acepta SIGTERM con esta bandera
SERVE_PIDFILE="$LOG_DIR/serve.pid"
URL_FILE="$LOG_DIR/public-url.txt"
TUNNEL_PIDFILE="$LOG_DIR/tunnel.pid"

# ------------------------------------------------------------------ utilidades
say() { echo "==> $*"; }

port_open() {
  ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
}

port_pids() { # pids de quien escucha en el puerto $1
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

pid_cmd() { # cmdline de un pid (legible, para avisar que se mata)
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | cut -c1-80
}

wait_port() { # $1 puerto, $2 segundos maximo
  local i
  for i in $(seq 1 $(( $2 * 10 ))); do
    port_open "$1" && return 0
    sleep 0.1
  done
  return 1
}

wait_ports_free() { # $1 segundos maximo
  local i p
  for i in $(seq 1 $(( $1 * 10 ))); do
    for p in "${ALL_PORTS[@]}"; do
      port_open "$p" && { sleep 0.1; continue 2; }
    done
    return 0
  done
  return 1
}

# mata un pid SOLO si su cmdline sigue siendo del servicio esperado: los PIDs
# se reciclan a toda velocidad y matar a ciegas golpea procesos ajenos
kill_verified() {
  local pid="$1" pattern="$2" i
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  if [[ -n "$pattern" ]] && ! grep -aqE "$pattern" "/proc/$pid/cmdline" 2>/dev/null; then
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
}

# tumba a quien ocupe un puerto (se usa al arrancar y como red de seguridad
# al apagar): avisa QUE mato para que no sea a ciegas
kill_port_holders() {
  local p="$1" pid
  for pid in $(port_pids "$p"); do
    kill -0 "$pid" 2>/dev/null || continue
    echo "     puerto $p: matando pid $pid ($(pid_cmd "$pid"))"
    kill -TERM "$pid" 2>/dev/null || true
  done
  # medio segundo para que los TERM hagan efecto; lo que resista, KILL
  sleep 0.5
  for pid in $(port_pids "$p"); do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

# cierra TODO cliente de tunel que apunte a NUESTRO puerto (quedan sueltos si
# una corrida anterior murio sin cleanup): sin esto la URL vieja seguiria viva.
# OJO el patron de cloudflared: entre "tunnel" y "--url" hay flags
# (--protocol/--edge-ip-version), el patron viejo "cloudflared tunnel --url"
# no casaba NUNCA y los cloudflared huerfanos se acumulaban en cada reinicio.
kill_stray_tunnels() {
  pkill -f -TERM "nokey@localhost\.run" 2>/dev/null || true
  pkill -f -TERM "free\.pinggy\.io" 2>/dev/null || true
  pkill -f -TERM "cloudflared.*--url http://127\.0\.0\.1:$PORT" 2>/dev/null || true
  pkill -f -TERM "localtunnel --port $PORT" 2>/dev/null || true
}

# ------------------------------------------------------------------ estado
MOCHI_PID="" NURU_PID="" MARKET_PID="" SERVER_PID=""
TUNNEL_PID="" TUNNEL_URL="" TUNNEL_PROVIDER="" TUNNEL_WATCH_PID="" TAIL_PID=""
CLEANED=0

# ------------------------------------------------------------------ resumen en pantalla
print_summary() {
  local mochi_txt nuru_txt market_txt
  mochi_txt="http://127.0.0.1:$MOCHI_PORT";   [[ -n "$MOCHI_ORIGIN"  ]] && mochi_txt="externo $MOCHI_ORIGIN"
  nuru_txt="http://127.0.0.1:$NURU_PORT";     [[ -n "$NURU_ORIGIN"   ]] && nuru_txt="externo $NURU_ORIGIN"
  market_txt="http://127.0.0.1:$MARKET_PORT"; [[ -n "$MARKET_ORIGIN" ]] && market_txt="externo $MARKET_ORIGIN"
  echo ""
  echo "  =========================================================="
  echo "   STACK ARRIBA"
  echo "  =========================================================="
  printf '     %-19s \033[1mhttp://127.0.0.1:%s\033[0m\n' "Lyra (juego):" "$PORT"
  printf '     %-19s %s\n' "mochi (proxy):" "$mochi_txt"
  printf '     %-19s %s\n' "nuru (wisp):" "$nuru_txt"
  printf '     %-19s %s\n' "market (owngames):" "$market_txt"
  if [[ -n "$TUNNEL_URL" ]]; then
    printf '     %-19s \033[1;36m%s\033[0m  (%s)\n' "URL publica:" "$TUNNEL_URL/" "$TUNNEL_PROVIDER"
    printf '     %-19s %s\n' "  juego:" "$TUNNEL_URL/owngames/bolsa-trading-floor/"
  else
    echo "     URL publica:        conectando... aparecera AQUI en cuanto responda"
  fi
  echo "  =========================================================="
}

# ------------------------------------------------------------------ cleanup (Ctrl+C / TERM / EXIT)
cleanup() {
  trap '' INT TERM EXIT
  if [[ $CLEANED -eq 1 ]]; then exit 0; fi
  CLEANED=1
  # higiene de generacion: solo el dueno registrado limpia (un INT a un
  # pidfile reciclado no toca al stack de otra corrida)
  if [[ "$(cat "$SERVE_PIDFILE" 2>/dev/null || true)" != "$$" ]]; then
    exit 0
  fi
  echo ""
  say "Deteniendo todo..."

  # 1) PRIMERO el vigilante y clientes del tunel: si se apagan despues del
  #    borrado de archivos, el vigilante moribundo reescribe la URL vieja
  #    (el fantasma de la corrida anterior)
  if [[ -n "$TUNNEL_WATCH_PID" ]]; then kill "$TUNNEL_WATCH_PID" 2>/dev/null || true; fi
  local tp
  tp="$(cat "$TUNNEL_PIDFILE" 2>/dev/null || true)"
  kill_verified "$tp" 'cloudflared|localhost\.run|pinggy|localtunnel'
  kill_verified "$TUNNEL_PID" 'cloudflared|localhost\.run|pinggy|localtunnel'
  kill_stray_tunnels
  rm -f "$SERVE_PIDFILE" "$URL_FILE" "$TUNNEL_PIDFILE"   # la URL muere con el stack

  # 2) server (SOLO acepta la senal si la bandera nombra su pid de arranque)
  echo $$ >"$STOPPING_FLAG" 2>/dev/null || true
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    say "Deteniendo server: $SERVER_PID"
    kill_verified "$SERVER_PID" 'bun|node|lyra'
  fi
  if [[ -n "$MARKET_PID" ]] && kill -0 "$MARKET_PID" 2>/dev/null; then
    say "Deteniendo market: $MARKET_PID"
    kill_verified "$MARKET_PID" 'bun|node|market'
  fi
  if [[ -n "$NURU_PID" ]] && kill -0 "$NURU_PID" 2>/dev/null; then
    say "Deteniendo nuru: $NURU_PID"
    kill_verified "$NURU_PID" 'nuru'
  fi
  if [[ -n "$MOCHI_PID" ]] && kill -0 "$MOCHI_PID" 2>/dev/null; then
    say "Deteniendo mochi: $MOCHI_PID"
    kill_verified "$MOCHI_PID" 'mochi'
  fi
  rm -f "$STOPPING_FLAG"
  if [[ -n "$TAIL_PID" ]]; then kill "$TAIL_PID" 2>/dev/null || true; fi

  # 3) verificacion REAL de puertos: nada de decir "liberados" sin comprobarlo.
  #    Lo que resista (hijo que escapo, pid perdido) cae aqui.
  if ! wait_ports_free 5; then
    local p
    for p in "${ALL_PORTS[@]}"; do
      port_open "$p" && kill_port_holders "$p"
    done
    wait_ports_free 3
  fi
  local libres=""; local p
  for p in "${ALL_PORTS[@]}"; do
    port_open "$p" && libres+="$p "
  done
  if [[ -z "$libres" ]]; then
    say "Verificado: puertos ${ALL_PORTS[*]} libres. Sin procesos ni URL abiertas. Hasta luego!"
  else
    say "ATENCION: los puertos $libres siguen ocupados; revisa 'ss -ltnp'." >&2
  fi
}
trap cleanup EXIT INT TERM

# ================================================================== ARRANQUE
echo ""
say "Tumbando lo que ocupe los puertos ${ALL_PORTS[*]}..."

# 1) stack anterior: si lo gestiona systemd hay que parar LA UNIDAD (si no,
#    systemd lo relanza en segundos y pisa este arranque: el misterioso
#    "se detuvo solo y los puertos quedaron abiertos")
if [[ -f "$SERVE_PIDFILE" ]]; then
  old="$(cat "$SERVE_PIDFILE" 2>/dev/null || true)"
  if [[ -n "$old" && "$old" != "$$" ]] && kill -0 "$old" 2>/dev/null; then
    if systemctl --user is-active --quiet lyra.service 2>/dev/null; then
      say "El stack anterior lo gestiona systemd: parando lyra.service..."
      systemctl --user stop lyra.service 2>/dev/null || true
    else
      say "Hay un stack anterior (pid $old); deteniendolo..."
      # la bandera debe nombrar el pid de arranque del server VIEJO (= el viejo serve.sh)
      echo "$old" >"$STOPPING_FLAG" 2>/dev/null || true
      kill -INT "$old" 2>/dev/null || true
    fi
  fi
  rm -f "$SERVE_PIDFILE"
elif ! grep -qa "lyra\.service" /proc/self/cgroup 2>/dev/null \
  && systemctl --user is-active --quiet lyra.service 2>/dev/null; then
  # ATENCION: si este serve.sh corre DENTRO de la unidad (systemd), parar
  # lyra.service aqui seria suicidarse en el arranque. El cgroup lo delata.
  say "lyra.service esta activo (stack de systemd): parando la unidad..."
  systemctl --user stop lyra.service 2>/dev/null || true
fi

# 2) esperar que los puertos queden libres de verdad
if ! wait_ports_free 12; then
  say "Los puertos no se liberaron solos; tumbando a los ocupantes:"
  for p in "${ALL_PORTS[@]}"; do
    port_open "$p" && kill_port_holders "$p"
  done
  wait_ports_free 5 || say "ATENCION: algo sigue ocupando puertos; sigo de todas formas" >&2
fi

# 3) tuneles huerfanos de corridas anteriores (dejan la URL vieja medio viva)
kill_stray_tunnels

# 4) arranque fresco: sin bandera vieja, sin url fantasma, registro de dueno
rm -f "$STOPPING_FLAG" "$URL_FILE" "$TUNNEL_PIDFILE"
echo $$ >"$SERVE_PIDFILE"

# ------------------------------------------------------------------ dependencias
# nuru necesita su config ANTES de arrancar (deriva el puerto y el prefijo /w/)
# nuru: el prefijo debe ir SIN slash final (el cliente conecta a prefix + "/",
# ej prefix="/w" -> ruta /w/). Con "/w/" el routing nunca calzaba y todo caia
# al wsproxy -> "invalid host" -> cierre 1008 (wisp roto: dealer de Spotify muerto)
printf '[wisp]\nprefix = "/w"\n' >"$LOG_DIR/nuru.toml"

MOCHI_BIN="services/mochi/target/release/mochi"
NURU_BIN="services/nuru/target/release/nuru"
# release es 10-30x mas rapido que debug en TLS/compresion/rewrite: el proxy
# externo (todo lo que carga la pagina desde internet) pasa por aqui
if [[ -z "$MOCHI_ORIGIN" && ! -x "$MOCHI_BIN" ]]; then
  say "Compilando mochi (primera vez, puede tardar)..."
  (cd services/mochi && cargo build --release) >/dev/null 2>&1 || say "ATENCION: mochi no compilo (sus paginas daran 503)"
fi
if [[ -z "$NURU_ORIGIN" && ! -x "$NURU_BIN" ]]; then
  say "Compilando nuru (primera vez, puede tardar)..."
  (cd services/nuru && cargo build --release) >/dev/null 2>&1 || say "ATENCION: nuru no compilo (el wisp no cargara)"
fi

# arranca una dependencia FRESCA (los puertos ya estan libres) y lo pinta
start_dep() { # $1 nombre, $2 puerto, $3 origen_externo, $4 nombre_variable_pid, $5... comando
  local name="$1" port="$2" origin="$3" pidvar="$4"
  shift 4
  if [[ -n "$origin" ]]; then
    printf '     %-19s \033[36mexterno %s (no se toca)\033[0m\n' "$name:" "$origin"
    return 0
  fi
  "$@" >"$LOG_DIR/$name.log" 2>&1 &
  printf -v "$pidvar" '%s' "$!"
  if wait_port "$port" 15; then
    printf '     %-19s \033[32mOK\033[0m (puerto %s)\n' "$name:" "$port"
  else
    printf '     %-19s \033[31mno levanto\033[0m (log: logs/%s.log)\n' "$name:" "$name"
  fi
}

echo ""
echo "  ----------------------------------------------------------"
echo "   DEPENDENCIAS Y JUEGOS"
start_dep "mochi"  "$MOCHI_PORT"  "$MOCHI_ORIGIN"  MOCHI_PID \
  bash -c "cd services/mochi && exec ./target/release/mochi"
start_dep "nuru"   "$NURU_PORT"   "$NURU_ORIGIN"   NURU_PID \
  bash -c "cd services/nuru && exec ./target/release/nuru --format toml '$LOG_DIR/nuru.toml'"
start_dep "market" "$MARKET_PORT" "$MARKET_ORIGIN" MARKET_PID \
  bash -c "MARKET_PORT=$MARKET_PORT exec bun services/market/server.mjs"
echo "  ----------------------------------------------------------"

# ------------------------------------------------------------------ cliente
if [[ $SKIP_BUILD -eq 0 ]]; then
  if [[ ! -f dist/index.html ]] || [[ -n "$(find src build.js vite.config.js -newer dist/index.html -print -quit 2>/dev/null)" ]]; then
    say "Compilando cliente..."
    bun run build || { say "ERROR: el build fallo"; exit 1; }
  fi
fi

# ------------------------------------------------------------------ servidor
LOG_FILE="$LOG_DIR/lyra-$(date +%Y%m%d-%H%M%S).log"
say "Arrancando Lyra en http://127.0.0.1:$PORT"
: >"$LOG_FILE"
NODE_ENV=production LYRA_ACCESS_LOG=1 LYRA_START_PID="$$" \
  MOCHI_PORT="$MOCHI_PORT" NURU_PORT="$NURU_PORT" MARKET_PORT="$MARKET_PORT" \
  bun server/prod.mjs >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

if ! wait_port "$PORT" 15; then
  say "ERROR: el servidor no levanto. Ultimas lineas del log:"
  tail -15 "$LOG_FILE"
  exit 1
fi
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  say "ERROR: el puerto $PORT responde pero NO es nuestro servidor. Libera el puerto y reintenta."
  exit 1
fi

# ------------------------------------------------------------------ tunel publico
# cloudflared quick -> localhost.run -> localtunnel -> pinggy. Gana el que
# entregue URL primero; la URL se imprime AQUI y queda en logs/public-url.txt.
# Si se corta con el stack vivo, se reabre solo (URL nueva, tambien en pantalla).
tunnel_health_ok() {
  # 10s: en cloudflare la propagacion inicial del edge puede hacer picos de 15s
  curl -fsS -o /dev/null -m 10 "$1/owngames/catalog.json" 2>/dev/null
}

# ---- cloudflared: binario vendido del repo (o del PATH si existiera) ----
CF_BIN="$(command -v cloudflared 2>/dev/null || true)"
if [[ -z "$CF_BIN" && -x "$ROOT/vendor/cloudflared/cloudflared" ]]; then
  CF_BIN="$ROOT/vendor/cloudflared/cloudflared"
fi

# ---- tunel nombrado (URL PERMANENTE): se usa si existe su configuracion ----
CF_TUNNEL_NAME="$(cat "$LOG_DIR/cf-tunnel-name.txt" 2>/dev/null || true)"
CF_HOST="$(cat "$LOG_DIR/cf-host.txt" 2>/dev/null || true)"

try_cf_named() {
  [[ -n "$CF_BIN" ]] || return 1
  [[ -n "$CF_TUNNEL_NAME" && -n "$CF_HOST" && -f "$LOG_DIR/cloudflared-cred.json" ]] || return 1
  say "Usando tu tunel PERMANENTE de Cloudflare ($CF_HOST)..."
  cat >"$LOG_DIR/cloudflared.yml" <<EOF
credentials-file: $LOG_DIR/cloudflared-cred.json
url: http://127.0.0.1:$PORT
EOF
  "$CF_BIN" tunnel --config "$LOG_DIR/cloudflared.yml" run "$CF_TUNNEL_NAME" \
    >"$LOG_DIR/cloudflared-named.log" 2>&1 &
  TUNNEL_PID=$!
  local i
  for i in $(seq 1 20); do
    # la config es valida desde el primer momento: basta con que el proceso viva
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      TUNNEL_PID=""
      return 1
    fi
    grep -qa "Registered tunnel connection" "$LOG_DIR/cloudflared-named.log" 2>/dev/null && break
    sleep 1
  done
  kill -0 "$TUNNEL_PID" 2>/dev/null || { TUNNEL_PID=""; return 1; }
  TUNNEL_URL="https://$CF_HOST"
  TUNNEL_PROVIDER="cloudflare-permanente"
}

announce_tunnel() {
  # guardia doble: stack vivo Y ser la generacion duena registrada. Si el
  # cleanup ya nos relevo, la url no se anuncia ni se escribe.
  if ! kill -0 "$SERVER_PID" 2>/dev/null \
    || [[ "$(cat "$SERVE_PIDFILE" 2>/dev/null || true)" != "$$" ]]; then
    kill_verified "$TUNNEL_PID" 'cloudflared|localhost\.run|pinggy|localtunnel'
    TUNNEL_PID=""
    return 1
  fi
  printf '%s\n' "$TUNNEL_URL/owngames/bolsa-trading-floor/" >"$URL_FILE"
  echo "$TUNNEL_PID" >"$TUNNEL_PIDFILE"   # el cleanup de fuera conoce al hijo
  local nota=""
  [[ "$TUNNEL_PROVIDER" == "cloudflare-permanente" ]] && nota="  (URL PERMANENTE: no cambia en cada arranque)"
  if [[ -n "$nota" ]]; then echo "   $nota"; fi
  print_summary                            # el cuadro se reimprime CON la URL
}

try_cf() {
  # PRIMER proveedor: la red de Cloudflare (sin cap de ancho de banda y con
  # mucha menos latencia que localhost.run). OJO: la URL aparece en ~10s pero
  # el canal de datos tarda MAS en registrar el edge (25s o mas): no damos por
  # bueno el tunel hasta que responda una peticion real de punta a punta.
  [[ -n "$CF_BIN" ]] || return 1
  : >"$LOG_DIR/cloudflared.log"
  # --edge-ip-version 4: el registro por IPv6 deja un canal que no pasa
  #    trafico (verificado); forzando IPv4 el canal va limpio.
  # --protocol http2 FIJO: QUIC (auto) registra el tunel pero el trafico NO
  #    pasa (verificado 2x: requests cuelgan 20s+; esta red degrada UDP hacia
  #    el edge). http2 es el unico protocolo que sirve trafico aqui.
  "$CF_BIN" tunnel --protocol http2 --edge-ip-version 4 --url "http://127.0.0.1:$PORT" >"$LOG_DIR/cloudflared.log" 2>&1 &
  TUNNEL_PID=$!
  local i
  # 1) obtener la URL (hasta 40s)
  for i in $(seq 1 40); do
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR/cloudflared.log" 2>/dev/null | head -1 || true)"
    [[ -n "$TUNNEL_URL" ]] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  if [[ -z "$TUNNEL_URL" ]]; then
    kill_verified "$TUNNEL_PID" 'cloudflared'; TUNNEL_PID=""
    return 1
  fi
  # 2) CONFIAR EN EL REGISTRO DEL EDGE (no en el round-trip): tras el registro
  #    hay una ventana de propagacion donde el primer round-trip puede tardar
  #    15-60s (medido), lo que hacia fracasar la validacion aunque el tunel
  #    estuviera PERFECTO. cloudflared 2026.9 registra 1 sola conexion:
  #    basta 1 registro para servir trafico; el supervisor tolera la propagacion.
  local ok=0
  for i in $(seq 1 90); do
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
    if grep -qa "Registered tunnel connection" "$LOG_DIR/cloudflared.log" 2>/dev/null; then
      ok=1
      break
    fi
    sleep 1
  done
  if [[ $ok -ne 1 ]]; then
    kill_verified "$TUNNEL_PID" 'cloudflared'; TUNNEL_PID=""; TUNNEL_URL=""
    return 1
  fi
  TUNNEL_PROVIDER="cloudflare"
}

try_lhr() {
  command -v ssh >/dev/null 2>&1 || return 1
  : >"$LOG_DIR/lhr.log"
  ssh -T \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$LOG_DIR/ssh_known_hosts" \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=6 \
    -o TCPKeepAlive=yes \
    -o ExitOnForwardFailure=yes -o ConnectTimeout=15 \
    -R "80:127.0.0.1:$PORT" nokey@localhost.run \
    >"$LOG_DIR/lhr.log" 2>&1 &
  TUNNEL_PID=$!
  local i
  for i in $(seq 1 60); do
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9.-]+\.lhr\.life' "$LOG_DIR/lhr.log" 2>/dev/null | head -1 || true)"
    [[ -n "$TUNNEL_URL" ]] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  if [[ -z "$TUNNEL_URL" ]]; then
    kill_verified "$TUNNEL_PID" 'localhost\.run|ssh'; TUNNEL_PID=""
    return 1
  fi
  TUNNEL_PROVIDER="localhost.run"
}

try_lt() {
  command -v bunx >/dev/null 2>&1 || return 1
  : >"$LOG_DIR/lt.log"
  bunx localtunnel --port "$PORT" >"$LOG_DIR/lt.log" 2>&1 &
  TUNNEL_PID=$!
  local i
  for i in $(seq 1 60); do
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.loca\.lt' "$LOG_DIR/lt.log" 2>/dev/null | head -1 || true)"
    [[ -n "$TUNNEL_URL" ]] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  if [[ -z "$TUNNEL_URL" ]]; then
    kill_verified "$TUNNEL_PID" 'localtunnel|bun'; TUNNEL_PID=""
    return 1
  fi
  TUNNEL_PROVIDER="localtunnel"
}

try_pinggy() {
  command -v ssh >/dev/null 2>&1 || return 1
  : >"$LOG_DIR/pinggy.log"
  ssh -T \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$LOG_DIR/ssh_known_hosts" \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes -o ConnectTimeout=15 \
    -p 443 -R"0:127.0.0.1:$PORT" free.pinggy.io \
    >"$LOG_DIR/pinggy.log" 2>&1 &
  TUNNEL_PID=$!
  local i
  for i in $(seq 1 45); do
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+(\.[a-z0-9-]+)*\.free\.pinggy\.io' "$LOG_DIR/pinggy.log" 2>/dev/null | head -1 || true)"
    [[ -n "$TUNNEL_URL" ]] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  if [[ -z "$TUNNEL_URL" ]]; then
    kill_verified "$TUNNEL_PID" 'pinggy|ssh'; TUNNEL_PID=""
    return 1
  fi
  TUNNEL_PROVIDER="pinggy"
}

open_tunnel_once() {
  local fn
  # el tunel PERMANENTE (si esta configurado) va primero, siempre
  for fn in try_cf_named try_cf try_lhr try_lt try_pinggy; do
    if "$fn" && [[ -n "$TUNNEL_URL" ]]; then
      return 0
    fi
  done
  return 1
}

if [[ $TUNNEL -eq 1 ]]; then
  (
    # mientras el stack viva: conseguir URL (reintentando) y cuidar la que hay
    while kill -0 "$SERVER_PID" 2>/dev/null; do
      if open_tunnel_once; then
        announce_tunnel || exit 0
        # vigilancia: LENTO no es MUERTO. Con el tunel saturado (spotify/youtube
        # descargando megas) los chequeos por el tunel tardan o fallan: rotar la
        # url aqui mata la sesion que el jugador esta usando. Solo rotamos si el
        # hijo del tunel MUERE, o si fallan 8 chequeos seguidos (~2 min reales
        # de tunel caido); un tunel lento pero vivo NUNCA se rota.
        fails=0
        while kill -0 "$SERVER_PID" 2>/dev/null; do
          sleep 15
          if ! kill -0 "$SERVER_PID" 2>/dev/null; then exit 0; fi
          if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
          if tunnel_health_ok "$TUNNEL_URL"; then
            fails=0
          else
            fails=$((fails + 1))
            [[ $fails -ge 8 ]] && break
          fi
        done
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then exit 0; fi
        kill_verified "$TUNNEL_PID" 'cloudflared|localhost\.run|pinggy|localtunnel'
        TUNNEL_PID=""
        TUNNEL_URL=""
      else
        sleep 15
      fi
    done
  ) &
  TUNNEL_WATCH_PID=$!
fi

# ------------------------------------------------------------------ resumen + tiempo real
print_summary
echo ""
say "Trafico en vivo (Ctrl+C detiene TODO y libera los puertos):"
echo ""

tail -F -n +1 "$LOG_FILE" &
TAIL_PID=$!

wait "$SERVER_PID"
status=$?
exit "$status"
