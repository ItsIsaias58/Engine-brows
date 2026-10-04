#!/usr/bin/env bash
# cf-setup.sh — configuracion UNA VEZ del tunel nombrado de Cloudflare.
#
#   ./scripts/cf-setup.sh lyra.tudominio.dpdns.org
#
# Requisitos previos (solo navegador, una vez):
#   1) Cuenta gratis en cloudflare.com
#   2) Dominio gratis en domain.digitalplat.org (ej: tunel.dpdns.org)
#   3) En Cloudflare: "Add a domain" con ese dominio (plan Free) -> Cloudflare
#      te da 2 nameservers -> ponlos en el panel de DigitalPlat
#   4) Espera a que Cloudflare muestre el dominio como "Active"
# Despues corre este script y listo: URL PERMANENTE, rapida y sin limite.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${1:-}"
if [[ -z "$HOST" || "$HOST" != *.* ]]; then
  echo "uso: $0 <hostname>   (ej: lyra.tunel.dpdns.org)"
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "==> Falta cloudflared. Instalalo con:"
  echo "    curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
  echo "    sudo dpkg -i cloudflared.deb"
  exit 1
fi

CERT="$HOME/.cloudflared/cert.pem"
if [[ ! -f "$CERT" ]]; then
  echo "==> Abriendo el login de Cloudflare en tu navegador (autoriza el certificado)..."
  cloudflared tunnel login
fi
if [[ ! -f "$CERT" ]]; then
  echo "==> El login no se completo; reintenta."
  exit 1
fi

TUNNEL_NAME="lyra"
echo "==> Creando el tunel '$TUNNEL_NAME' (si ya existe, se reutiliza)..."
if ! cloudflared tunnel list 2>/dev/null | grep -qw "$TUNNEL_NAME"; then
  cloudflared tunnel create "$TUNNEL_NAME" || { echo "==> No se pudo crear el tunel"; exit 1; }
fi

CRED_FILE="$(ls "$HOME/.cloudflared/$TUNNEL_NAME"*.json 2>/dev/null | head -1 || true)"
if [[ -z "$CRED_FILE" ]]; then
  echo "==> No encuentro las credenciales del tunel; borra $CERT y reintenta."
  exit 1
fi

echo "==> Conectando el DNS: $HOST -> tunel $TUNNEL_NAME (CNAME automatico)..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOST" || {
  echo "==> OJO: no se pudo crear el registro DNS (¿el dominio esta 'Active' en Cloudflare?"
  echo "    ¿El hostname es de ese dominio?). Puedes crearlo a mano: CNAME $HOST -> $TUNNEL_NAME.<cuenta>.cfargotunnel.com"
}

mkdir -p logs
cp "$CRED_FILE" logs/cloudflared-cred.json
echo "$TUNNEL_NAME" > logs/cf-tunnel-name.txt
echo "$HOST" > logs/cf-host.txt

echo ""
echo "  =========================================================="
echo "   CONFIGURADO. Tu URL permanente sera:"
echo "     https://$HOST/"
echo "     https://$HOST/owngames/bolsa-trading-floor/"
echo ""
echo "   Ahora reinicia el stack para usarla:"
echo "     systemctl --user restart lyra   (o ./serve.sh)"
echo ""
echo "   serve.sh la detectara solo y dejara de usar localhost.run."
echo "  =========================================================="
