#!/usr/bin/env bash
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

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  close_ports
  close_firewall
  exit "$status"
}

cd "$ROOT"
require_command "$BUN_BIN"
require_command "$CLOUDFLARED_BIN"
require_command fuser
require_command tee

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
for service_port in "$TURN_PORT" 4001 4002 4003 4005; do
  log "waiting for Lyra service on 127.0.0.1:${service_port}"
  wait_for_port "$service_port"
done
log "Lyra is ready; starting Cloudflare Quick Tunnel"
"$CLOUDFLARED_BIN" tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" 2>&1 | grep --line-buffered -E "trycloudflare|ERR|FATAL|WRN" | grep --line-buffered -vE "ping_group_range|ICMP proxy|Incoming request ended abruptly|context canceled"
