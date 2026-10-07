#!/usr/bin/env bash
# nosleep.sh — deja la laptop despierta para que el servidor siga ahi aunque
# bloquees la sesion o cierres la tapa.
#
#   ./nosleep.sh            activa (instala + levanta la unidad) y muestra estado
#   ./nosleep.sh --status   solo muestra el estado
#   ./nosleep.sh --undo     vuelve a permitir suspender (deshace todo)
#   sudo ./nosleep.sh --sudo  capa extra del sistema: tapa 'ignore' (opcional)
#
# Que cambia:
#   1) apaga la suspension automatica de GNOME (Ajustes -> Energia). ESTA es
#      la pieza que evita que la sesion se cierre "por el tiempo": dejaba la
#      maquina durmiendo tras 1 h (corriente) / 15 min (bateria) de inactividad
#      y ahora no pide suspender nunca. Es config tuya (dconf) y persiste.
#   2) instala y levanta la unidad de usuario lyra-nosleep.service, que ejecuta
#      scripts/keep-awake.sh: sujeta el lock "sleep:idle:handle-lid-switch" de
#      logind, asi el sistema no entra en reposo y la tapa no suspende. Vive
#      fuera de la sesion, de modo que aguanta la pantalla bloqueada y (con
#      linger) tambien el cierre de sesion.
#      OJO: el lock "sleep" NO frena una suspension pedida a mano por ti, con
#      sesion activa polkit te autoriza y logind la aplica por encima del lock
#      (probado con 'systemctl suspend').
#
# NO necesita sudo: tomar esos locks es cosa del propio usuario (polkit lo
# permite en sesion activa e inactiva) y la configuracion de GNOME es tuya.
#
# Capa opcional del sistema (sudo): 'sudo ./nosleep.sh --sudo' escribe un
# drop-in de logind con HandleLidSwitch=ignore, asi cerrar la tapa no suspende
# NUNCA. Con el lock de arriba casi no aporta, pero cubre el hueco entre el
# arranque y tu primer inicio de sesion (donde no hay sesion que pueda tomar
# el lock) y deja el comportamiento fijo en el sistema en vez de depender de
# un proceso nuestro. Se quita con 'sudo ./nosleep.sh --undo'.
#
# Coste: sin suspension la laptop no ahorra bateria; con la tapa cerrada se
# queda encendida. Si la tienes desenchufada, vigila la bateria.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/lyra-nosleep.service"
UNIT_NAME="lyra-nosleep.service"
KEEPER="$ROOT/scripts/keep-awake.sh"
LOG_FILE="$ROOT/logs/keep-awake.log"
POWER=org.gnome.settings-daemon.plugins.power
USER_NAME="${USER:-$(id -un)}"
LOGIND_DIR="${LOGIND_DIR:-/etc/systemd/logind.conf.d}"
LOGIND_FILE="$LOGIND_DIR/99-lyra-nosleep.conf"

say() { printf '==> %s\n' "$*"; }
ok()  { printf '    \033[32m%s\033[0m\n' "$*"; }
bad() { printf '    \033[33m%s\033[0m\n' "$*"; }

# gsettings necesita el bus de la sesion grafica; si este script corre desde
# otro sitio (cron, ssh) hay que apuntarlo a mano.
ensure_bus() {
  if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "/run/user/$(id -u)/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  fi
}

gs() { gsettings "$@" 2>/dev/null; }

# ------------------------------------------------------------------ escritorio
disable_gnome_suspend() {
  ensure_bus
  if ! command -v gsettings >/dev/null 2>&1; then
    bad "sin gsettings (no es GNOME?): no toco el escritorio"
    return 0
  fi
  gs set "$POWER" sleep-inactive-ac-type 'nothing'
  gs set "$POWER" sleep-inactive-battery-type 'nothing'
  gs set "$POWER" lid-close-ac-action 'nothing'
  gs set "$POWER" lid-close-battery-action 'nothing'
  if [[ "$(gs get "$POWER" sleep-inactive-ac-type)" == "'nothing'" ]]; then
    ok "GNOME: suspension automatica apagada (Ajustes -> Energia)"
  else
    bad "GNOME: no pude escribir la configuracion de energia"
  fi
}

restore_gnome_suspend() {
  ensure_bus
  command -v gsettings >/dev/null 2>&1 || return 0
  # valores de fabrica de Ubuntu: suspender tras 1h (corriente) / 15m (bateria)
  gs set "$POWER" sleep-inactive-ac-type 'suspend'
  gs set "$POWER" sleep-inactive-ac-timeout 3600
  gs set "$POWER" sleep-inactive-battery-type 'suspend'
  gs set "$POWER" sleep-inactive-battery-timeout 900
  gs set "$POWER" lid-close-ac-action 'suspend'
  gs set "$POWER" lid-close-battery-action 'suspend'
  ok "GNOME: suspension automatica restaurada"
}

# ------------------------------------------------------------------ unidad
install_unit() {
  mkdir -p "$UNIT_DIR" "$ROOT/logs"
  if [[ ! -x "$KEEPER" ]]; then
    bad "falta $KEEPER (¿repo incompleto?)"
    exit 1
  fi
  # el here-doc va sin comillas para sustituir ROOT: la unidad necesita rutas
  # absolutas (systemd --user no arranca desde el directorio del repo)
  cat >"$UNIT" <<EOF
[Unit]
Description=Lyra: mantiene la laptop despierta para que el servidor siga disponible

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=/usr/bin/env bash $KEEPER
Restart=always
RestartSec=10
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME" >/dev/null 2>&1 || {
    bad "no pude levantar $UNIT_NAME"
    systemctl --user status "$UNIT_NAME" --no-pager 2>&1 | tail -5
    exit 1
  }
  ok "unidad $UNIT_NAME instalada y activa"

  # sin linger, systemd apaga los servicios del usuario al cerrar sesion. Ya
  # venia activo en esta maquina, pero si no lo estuviera el fix quedaria a
  # medias (justo el caso "cierro sesion y se cae").
  if [[ "$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null)" == "yes" ]]; then
    ok "linger ya activo (la unidad sobrevive al cierre de sesion)"
  elif loginctl enable-linger "$USER_NAME" 2>/dev/null; then
    ok "linger activado (la unidad sobrevive al cierre de sesion)"
  else
    bad "no pude activar linger: ejecuta 'sudo loginctl enable-linger $USER_NAME'"
  fi
}

remove_unit() {
  systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  ok "unidad $UNIT_NAME retirada"
}

# ------------------------------------------------------------- sistema (sudo)
# Capa de arriba, la unica que no depende de nosotros: logind no suspende por
# la tapa ni con la sesion cerrada, pq no hay que tomar ningun lock.
install_logind_dropin() {
  mkdir -p "$LOGIND_DIR"
  cat >"$LOGIND_FILE" <<'EOF'
# Instalado por nosleep.sh (Engine-brows): cerrar la tapa no suspende.
# Para revertir: 'sudo ./nosleep.sh --undo' (aplica al reiniciar) o borra este
# archivo y ejecuta 'sudo systemctl restart systemd-logind'.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
EOF
  ok "logind: tapa en 'ignore' ($LOGIND_FILE)"

  # logind no documenta un reload, asi que si no cuela se avisa de que aplica
  # al reiniciar; nunca se reinicia logind a la brava desde aqui.
  if systemctl reload systemd-logind >/dev/null 2>&1; then
    ok "logind: configuracion releida en caliente"
  else
    bad "logind: se aplicara al reiniciar (o con 'sudo systemctl restart systemd-logind')"
  fi

  if systemd-analyze cat-config systemd/logind.conf 2>/dev/null | grep -q '^HandleLidSwitch=ignore'; then
    ok "logind: HandleLidSwitch=ignore confirmado en la config efectiva"
  else
    bad "logind: no veo HandleLidSwitch=ignore en la config efectiva"
  fi
}

remove_logind_dropin() {
  [[ -e "$LOGIND_FILE" ]] || return 0
  rm -f "$LOGIND_FILE"
  ok "logind: $LOGIND_FILE retirado (aplica al reiniciar)"
  systemctl reload systemd-logind >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------ estado
show_status() {
  echo ""
  echo "  =========================================================="
  echo "   SERVIDOR A PRUEBA DE BLOQUEO DE SESION"
  echo "  =========================================================="

  ensure_bus
  if systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    printf '     %-22s \033[32mactiva\033[0m (pid %s)\n' "unidad:" "$(systemctl --user show "$UNIT_NAME" -p MainPID --value 2>/dev/null)"
  else
    printf '     %-22s \033[33minactiva\033[0m\n' "unidad:"
  fi

  # la prueba que importa: lo que logind dice que tiene bloqueado
  blocked="$(gdbus call --system --dest org.freedesktop.login1 \
    --object-path /org/freedesktop/login1 \
    --method org.freedesktop.DBus.Properties.Get \
    org.freedesktop.login1.Manager BlockInhibited 2>/dev/null || true)"
  tapa_ok=0
  [[ "$blocked" == *handle-lid-switch* ]] && tapa_ok=1
  if [[ "$blocked" == *sleep* && $tapa_ok -eq 1 ]]; then
    printf '     %-22s \033[32m%s\033[0m\n' "logind bloquea:" "$blocked"
  else
    printf '     %-22s \033[33m%s\033[0m\n' "logind bloquea:" "${blocked:-<sin respuesta>}"
  fi
  if [[ $tapa_ok -eq 1 ]]; then
    printf '     %-22s \033[32msi\033[0m (lock de tapa activo)\n' "tapa:"
  else
    printf '     %-22s \033[33mno\033[0m\n' "tapa:"
  fi

  if command -v gsettings >/dev/null 2>&1; then
    auto="$(gs get "$POWER" sleep-inactive-ac-type)"
    if [[ "$auto" == "'nothing'" ]]; then
      printf '     %-22s \033[32mapagada\033[0m (no suspende "por el tiempo")\n' "susp. automatica:"
    else
      printf '     %-22s \033[33m%s -> suspenderia por inactividad\033[0m\n' "susp. automatica:" "$auto"
    fi
    printf '     %-22s tapa=%s\n' "GNOME:" "$(gs get "$POWER" lid-close-ac-action)"
  fi

  if [[ -e "$LOGIND_FILE" ]]; then
    printf '     %-22s \033[32mtapa=ignore\033[0m (%s)\n' "logind (sistema):" "$LOGIND_FILE"
  else
    printf '     %-22s opcional (sudo %s --sudo)\n' "logind (sistema):" "$0"
  fi

  printf '     %-22s %s\n' "linger:" "$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null || echo '?')"

  if curl -fsS -o /dev/null -m 5 http://127.0.0.1:4444/health 2>/dev/null; then
    printf '     %-22s \033[32mresponde\033[0m\n' "servidor local:"
  else
    printf '     %-22s \033[33mno responde\033[0m (¿stack apagado? ./serve.sh)\n' "servidor local:"
  fi
  echo "  =========================================================="
  echo "     deshacer:  ./nosleep.sh --undo"
  echo "     logs:      journalctl --user -u $UNIT_NAME -f"
  echo ""
}

# ------------------------------------------------------------------ main
MODE="${1:-}"
case "$MODE" in
  --status)
    show_status
    ;;
  --undo)
    say "Volviendo a permitir la suspension..."
    remove_unit
    restore_gnome_suspend
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      remove_logind_dropin
    elif [[ -e "$LOGIND_FILE" ]]; then
      bad "queda la capa del sistema: sudo rm $LOGIND_FILE && sudo systemctl restart systemd-logind"
    fi
    show_status
    ;;
  --sudo)
    # esta rama solo toca /etc y logind: la parte de usuario (unidad + GNOME)
    # pertenece a tu usuario, no a root, y ya la deja hecha ./nosleep.sh
    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
      printf 'esta capa toca /etc y logind, necesita privilegios:\n\n    sudo %s --sudo\n\n' "$0" >&2
      exit 1
    fi
    say "Configurando logind para que cerrar la tapa no suspenda..."
    install_logind_dropin
    echo ""
    echo "  Listo: la tapa ya no suspende, haya o no sesion abierta."
    echo "  Estado completo (como tu usuario, sin sudo): ./nosleep.sh --status"
    echo ""
    ;;
  ""|--enable)
    say "Dejando la laptop despierta mientras el servidor tenga que estar ahi..."
    install_unit
    disable_gnome_suspend
    show_status
    ;;
  -h|--help)
    sed -n '2,/^[^#]/p' "$0" | sed '$d'
    ;;
  *)
    printf 'opcion desconocida: %s (usa --status, --undo, --sudo o nada)\n' "$MODE" >&2
    exit 1
    ;;
esac
