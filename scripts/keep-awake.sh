#!/usr/bin/env bash
# keep-awake.sh — mantiene la maquina DESPIERTA mientras tiene que estar
# disponible: no suspende por inactividad ni al cerrar la tapa.
#
# Lo lanza lyra-nosleep.service (ver ./nosleep.sh). No lo ejecutes a mano
# salvo para depurar: se queda en primer plano sujetando el lock hasta que lo
# mates (Ctrl+C).
#
# Que tapa cada lock (comprobado a mano en esta maquina, no es teoria):
#   * handle-lid-switch  -> lock de BAJO nivel: logind lo respeta SIEMPRE
#                           (LidSwitchIgnoreInhibited no lo afecta), asi que
#                           cerrar la tapa no suspende. Es el unico de los tres
#                           que cubre algo que GNOME no cubre.
#   * idle               -> que el sistema no entre en reposo.
#   * sleep              -> solo frena suspensiones SIN privilegios (las pide
#                           otro usuario, o un proceso sin sesion activa).
#                           OJO: NO frena la tuya. Con sesion activa polkit te
#                           autoriza (allow_active=yes) y logind aplica esa
#                           autorizacion POR ENCIMA del lock: probado con
#                           'systemctl suspend' -> la maquina durmio igual.
#
# Por eso la suspension automatica por inactividad la apaga GNOME (ver
# nosleep.sh: sleep-inactive-*-type=nothing), que es quien la pide. Y para que
# la tapa no dependa de ningun proceso nuestro, './nosleep.sh --sudo' deja
# HandleLidSwitch=ignore en logind.
#
# El lock vive mientras viva el proceso que lo toma (logind lo suelta solo si
# el proceso muere). Si polkit lo deniega —por ejemplo al arrancar, antes de
# que exista ninguna sesion— se reintenta cada RETRY segundos, asi la maquina
# se protege sola en cuanto haya sesion, sin tener que reiniciar el servicio.
set -u

WHAT="sleep:idle:handle-lid-switch"
WHO="Lyra"
WHY="Servidor Lyra en marcha: no suspender"
RETRY=30

log() { printf 'keep-awake: %s\n' "$*"; }

# logind publica en BlockInhibited la union de los locks "block" activos. La
# unica razon por la que apareceria "sleep" aqui es nuestro propio lock, asi
# que vale como comprobacion de que de verdad esta en pie.
lock_held() {
  gdbus call --system --dest org.freedesktop.login1 \
    --object-path /org/freedesktop/login1 \
    --method org.freedesktop.DBus.Properties.Get \
    org.freedesktop.login1.Manager BlockInhibited 2>/dev/null | grep -q "sleep"
}

holder=""
cleanup() {
  if [[ -n "$holder" ]]; then kill "$holder" 2>/dev/null || true; fi
  exit 0
}
trap cleanup TERM INT

while :; do
  systemd-inhibit --what="$WHAT" --mode=block --who="$WHO" --why="$WHY" \
    sleep infinity &
  holder=$!

  # margen para que logind registre el lock antes de darlo por bueno
  sleep 5

  if ! kill -0 "$holder" 2>/dev/null; then
    wait "$holder" 2>/dev/null || true
    holder=""
    log "no se pudo tomar el lock (¿polkit?); reintento en ${RETRY}s"
    sleep "$RETRY"
    continue
  fi

  if lock_held; then
    log "maquina mantenida despierta ($WHAT)"
    wait "$holder" 2>/dev/null || true
    holder=""
    log "lock perdido; reintento en ${RETRY}s"
  else
    log "lock denegado por logind; reintento en ${RETRY}s"
    kill "$holder" 2>/dev/null || true
    wait "$holder" 2>/dev/null || true
    holder=""
  fi

  sleep "$RETRY"
done
