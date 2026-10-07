#!/usr/bin/env bash
#
#   ./server.sh                 arranca bun dev + servicios + quick tunnel
#
# Variables de entorno:
#   PORT, TURN_PORT, ...        puertos (ver abajo)
#   OPEN_FIREWALL=1             abre/cierra los puertos del TURN en ufw
#   KEEP_AWAKE=1                mientras corra, impide que la maquina suspenda:
#                               apaga la suspension automatica de GNOME (es
#                               quien la pide; un lock de logind no la frena,
#                               porque con sesion activa polkit autoriza al
#                               usuario y logind aplica esa autorizacion por
#                               encima del lock) y sujeta el lock de logind
#                               "sleep:idle:handle-lid-switch" (el de la tapa
#                               es de bajo nivel: se respeta siempre).
#                               KEEP_AWAKE=0 lo desactiva. Al salir se revierte
#                               SOLO lo que hayamos cambiado nosotros.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4444}"
TURN_PORT="${TURN_PORT:-3479}"
TURN_RELAY_MIN_PORT="${TURN_RELAY_MIN_PORT:-49152}"
TURN_RELAY_MAX_PORT="${TURN_RELAY_MAX_PORT:-49200}"
BUN_BIN="${BUN_BIN:-bun}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
SERVER_LOG="${SERVER_LOG:-/tmp/lyra-quick-tunnel-server.log}"
OPEN_FIREWALL="${OPEN_FIREWALL:-1}"
KEEP_AWAKE="${KEEP_AWAKE:-1}"
KEEP_AWAKE_WHAT="sleep:idle:handle-lid-switch"
KEEP_AWAKE_PID=""
POWER_SCHEMA="org.gnome.settings-daemon.plugins.power"
POWER_CHANGED=()

log() {
  printf '[quick-tunnel] %s\n' "$*"
}

fail() {
  printf '[quick-tunnel] %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

run_privileged() {
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

stop_port() {
  local port="$1"
  run_privileged fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  run_privileged fuser -k "${port}/udp" >/dev/null 2>&1 || true
}

close_ports() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose -f "${ROOT}/services/turn/compose.yml" down --remove-orphans >/dev/null 2>&1 || true
  fi
  for port in "$PORT" 4001 4002 4003 4005 4006 "$TURN_PORT"; do
    stop_port "$port"
  done
  for ((port = TURN_RELAY_MIN_PORT; port <= TURN_RELAY_MAX_PORT; port += 1)); do
    stop_port "$port"
  done
}

open_firewall() {
  [ "$OPEN_FIREWALL" = "1" ] || return 0
  command -v ufw >/dev/null 2>&1 || {
    log "ufw is not installed; local ports are available but no firewall rule was added"
    return 0
  }

  run_privileged ufw allow "${TURN_PORT}/tcp" comment "lyra TURN (temporal)" >/dev/null
  run_privileged ufw allow "${TURN_PORT}/udp" comment "lyra TURN (temporal)" >/dev/null
  run_privileged ufw allow "${TURN_RELAY_MIN_PORT}:${TURN_RELAY_MAX_PORT}/udp" comment "lyra TURN relay (temporal)" >/dev/null
  log "opened TURN ports ${TURN_PORT}/tcp, ${TURN_PORT}/udp and ${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}/udp"
}

close_firewall() {
  [ "$OPEN_FIREWALL" = "1" ] || return 0
  command -v ufw >/dev/null 2>&1 || return 0
  run_privileged ufw delete allow "${TURN_PORT}/tcp" >/dev/null 2>&1 || true
  run_privileged ufw delete allow "${TURN_PORT}/udp" >/dev/null 2>&1 || true
  run_privileged ufw delete allow "${TURN_RELAY_MIN_PORT}:${TURN_RELAY_MAX_PORT}/udp" >/dev/null 2>&1 || true
  log "closed TURN ports in ufw"
}

wait_for_port() {
  local port="$1"
  local attempt
  for ((attempt = 1; attempt <= 180; attempt += 1)); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      fail "bun dev exited while waiting for port ${port}; see ${SERVER_LOG}"
    fi
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&-
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for port ${port}; see ${SERVER_LOG}"
}

wait_ports_closed() {
  local port attempt
  for port in "$PORT" 4001 4002 4003 4005 4006 "$TURN_PORT"; do
    for ((attempt = 1; attempt <= 50; attempt += 1)); do
      ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN || break
      sleep 0.1
    done
    if ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
      log "ATENCION: el puerto $port sigue ocupado tras 5s; sigo de todas formas"
    fi
  done
  log "puertos verificados libres; reabriendo firewall"
}

# ------------------------------------------------------------------- energia
# Con la pantalla bloqueada Ubuntu suspende la maquina y el servidor deja de
# responder aunque el proceso siga vivo; y si la sesion se "cierra por el
# tiempo" pasa lo mismo. Se cubren los dos caminos que pide el sistema (ver
# /home/isaias/Descargas/lyra-prod/nosleep.sh para la version como servicio).
gs() { gsettings "$@" 2>/dev/null; }

ensure_bus() {
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "/run/user/$(id -u)/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  fi
}

# Un lock "sleep" NO frena la suspension que pide el propio usuario con sesion
# activa (polkit lo autoriza y logind la aplica por encima del lock: probado
# con systemctl suspend). Por eso lo importante aqui es apagar el ajuste de
# GNOME, que es quien pide dormir la maquina por inactividad.
power_off_auto_suspend() {
  command -v gsettings >/dev/null 2>&1 || {
    log "sin gsettings: no toco la energia del escritorio (el lock de logind igual queda puesto)"
    return 0
  }
  ensure_bus
  local key current
  for key in sleep-inactive-ac-type sleep-inactive-battery-type \
             lid-close-ac-action lid-close-battery-action; do
    current="$(gs get "$POWER_SCHEMA" "$key" || true)"
    # si ya estaba apagada no es cosa nuestra: no la revertimos al salir
    if [ "$current" = "'nothing'" ]; then
      continue
    fi
    if gs set "$POWER_SCHEMA" "$key" 'nothing'; then
      POWER_CHANGED+=("$key:$current")
    else
      log "ATENCION: no pude apagar '$key' en GNOME"
    fi
  done
  if [ "${#POWER_CHANGED[@]}" -gt 0 ]; then
    log "suspension automatica de GNOME apagada (se restaura al salir)"
  else
    log "suspension automatica de GNOME: ya estaba apagada"
  fi
}

power_restore() {
  [ "${#POWER_CHANGED[@]}" -gt 0 ] || return 0
  ensure_bus
  local entry key value
  for entry in "${POWER_CHANGED[@]}"; do
    key="${entry%%:*}"; value="${entry#*:}"
    gs set "$POWER_SCHEMA" "$key" "$value" || true
  done
  log "suspension automatica de GNOME restaurada"
}

# lo que logind tiene bloqueado ahora mismo; "sleep" solo puede venir de un
# lock en modo block (los ídle/delay de NetworkManager y UPower no aparecen)
lock_is_held() {
  if command -v gdbus >/dev/null 2>&1; then
    gdbus call --system --dest org.freedesktop.login1 \
      --object-path /org/freedesktop/login1 \
      --method org.freedesktop.DBus.Properties.Get \
      org.freedesktop.login1.Manager BlockInhibited 2>/dev/null | grep -q sleep
  else
    systemd-inhibit --list 2>/dev/null | grep -q "$KEEP_AWAKE_WHAT"
  fi
}

keep_awake_start() {
  if [ "$KEEP_AWAKE" != "1" ]; then
    log "KEEP_AWAKE=0: no toco la energia (la maquina podra suspenderse)"
    return 0
  fi
  power_off_auto_suspend || true
  if ! command -v systemd-inhibit >/dev/null 2>&1; then
    log "ATENCION: falta systemd-inhibit; no puedo bloquear la tapa"
    return 0
  fi
  systemd-inhibit --what="$KEEP_AWAKE_WHAT" --mode=block --who="Lyra" \
    --why="Servidor Lyra en marcha: no suspender" sleep infinity >/dev/null 2>&1 &
  KEEP_AWAKE_PID=$!
  # margen corto para saber si polkit concedio el lock de verdad
  sleep 2
  if kill -0 "$KEEP_AWAKE_PID" 2>/dev/null && lock_is_held; then
    log "lock de energia activo ($KEEP_AWAKE_WHAT)"
  else
    log "ATENCION: no pude tomar el lock de energia (¿polkit?); la tapa podria suspender"
  fi
}

keep_awake_stop() {
  if [ -n "$KEEP_AWAKE_PID" ] && kill -0 "$KEEP_AWAKE_PID" 2>/dev/null; then
    kill "$KEEP_AWAKE_PID" 2>/dev/null || true
    wait "$KEEP_AWAKE_PID" 2>/dev/null || true
  fi
  KEEP_AWAKE_PID=""
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  keep_awake_stop
  power_restore || true
  close_ports
  close_firewall
  exit "$status"
}

cd "$ROOT"
require_command "$BUN_BIN"
require_command "$CLOUDFLARED_BIN"
require_command fuser
require_command tee

# ------------------------------------------------------------------- systemd
# Si el stack lo gestiona lyra.service, pararlo ANTES de tocar puertos: si no,
# nuestro close_ports (fuser -k) mata su stack, systemd lo relanza en 5 s
# (Restart=always), reclama los puertos y SIGKILLea este bun dev. El cgroup
# delata si ya corremos DENTRO de la unidad; pararla ahi seria suicidarse.
if ! grep -qa "lyra\.service" /proc/self/cgroup 2>/dev/null \
  && command -v systemctl >/dev/null 2>&1 \
  && systemctl --user is-active --quiet lyra.service 2>/dev/null; then
  log "lyra.service esta activo (stack de systemd): parando la unidad antes de tomar los puertos"
  systemctl --user stop lyra.service 2>/dev/null || true
  # con KillMode=control-group systemd desmonta el cgroup un instante despues
  for ((attempt = 1; attempt <= 50; attempt += 1)); do
    systemctl --user is-active --quiet lyra.service 2>/dev/null || break
    sleep 0.1
  done
fi

log "closing application and TURN ports"
close_ports
close_firewall
wait_ports_closed

open_firewall
export PORT TURN_PORT
export DEV_ACCESS_LOGS="${DEV_ACCESS_LOGS:-1}"
trap cleanup EXIT INT TERM HUP
log "starting bun dev; server log: ${SERVER_LOG}"
"$BUN_BIN" dev > >(tee -a "$SERVER_LOG") 2>&1 &
SERVER_PID=$!
wait_for_port "$PORT"
keep_awake_start || true
for service_port in "$TURN_PORT" 4001 4002 4003 4005; do
  log "waiting for Lyra service on 127.0.0.1:${service_port}"
  wait_for_port "$service_port"
done
log "Lyra is ready; starting Cloudflare Quick Tunnel"
"$CLOUDFLARED_BIN" tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" 2>&1 | grep --line-buffered -E "trycloudflare|ERR|FATAL|WRN" | grep --line-buffered -vE "ping_group_range|ICMP proxy|Incoming request ended abruptly|context canceled"
