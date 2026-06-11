#!/usr/bin/env bash
# =============================================================================
#  >_ WebTerminal — instalador guiado
#
#  Te hace las preguntas necesarias, instala lo que falte y deja el servicio
#  funcionando. Es seguro re-ejecutarlo: detecta lo ya instalado y solo
#  cambia lo que pidas.
#
#  Uso:        sudo ./install.sh
#  Desatendido: exporta variables WT_* antes de ejecutar (ver --help).
# =============================================================================
set -euo pipefail

BASE=/opt/webterminal
ENV_FILE="$BASE/.env"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DST=/etc/systemd/system/webterminal.service

C_TITLE='\033[1;36m'; C_OK='\033[1;32m'; C_WARN='\033[1;33m'; C_ERR='\033[1;31m'; C_DIM='\033[2m'; C_OFF='\033[0m'
step()  { printf '\n%b==> %s%b\n' "$C_TITLE" "$*" "$C_OFF"; }
ok()    { printf '%b    ✓ %s%b\n' "$C_OK" "$*" "$C_OFF"; }
warn()  { printf '%b    ! %s%b\n' "$C_WARN" "$*" "$C_OFF"; }
die()   { printf '%b    ✗ %s%b\n' "$C_ERR" "$*" "$C_OFF" >&2; exit 1; }
note()  { printf '%b      %s%b\n' "$C_DIM" "$*" "$C_OFF"; }

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
WebTerminal — instalador guiado.

  sudo ./install.sh              instalación interactiva (recomendado)
  sudo ./install.sh --help       esta ayuda

Modo desatendido: exporta antes de ejecutar (las que falten se preguntan):
  WT_MODE=caddy|cloudflared|local   cómo se expone la app
  WT_DOMAIN=terminal.ejemplo.com    dominio (modos caddy/cloudflared)
  WT_BIND=127.0.0.1                 IP de escucha (modo local)
  WT_APP_PORT=8765                  puerto interno de la app
  WT_SSH_PORT=22                    puerto del sshd de esta máquina
  WT_ADMIN_EMAIL=tu@correo.com      primer usuario web
  WT_ADMIN_PASSWORD=...             su contraseña (mín. 8)
EOF
  exit 0
fi

# ── helpers de preguntas ──────────────────────────────────────────────────────
ask() {            # ask VAR "Pregunta" "default"
  local var="$1" q="$2" def="${3:-}" cur="${!1:-}" ans
  [[ -n "$cur" ]] && return 0
  if [[ -n "$def" ]]; then read -rp "$(printf '  %s [%s]: ' "$q" "$def")" ans; ans="${ans:-$def}";
  else while [[ -z "${ans:-}" ]]; do read -rp "$(printf '  %s: ' "$q")" ans; done; fi
  printf -v "$var" '%s' "$ans"
}
ask_secret() {     # ask_secret VAR "Pregunta"  (oculta + confirmación)
  local var="$1" q="$2" a b
  [[ -n "${!1:-}" ]] && return 0
  while :; do
    read -rsp "$(printf '  %s: ' "$q")" a; echo
    read -rsp "  Repítela: " b; echo
    [[ "$a" == "$b" && ${#a} -ge 8 ]] && break
    [[ "$a" != "$b" ]] && warn "No coinciden, otra vez." || warn "Mínimo 8 caracteres."
  done
  printf -v "$var" '%s' "$a"
}
env_get() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

# ── 0. comprobaciones ─────────────────────────────────────────────────────────
printf '\n%b  >_ WebTerminal%b — instalador guiado\n' "$C_TITLE" "$C_OFF"
note "Terminal SSH web con sesiones tmux persistentes, explorador de archivos y más."
[[ $EUID -eq 0 ]] || die "Ejecútame como root:  sudo ./install.sh"
command -v apt-get >/dev/null || die "Este instalador necesita un sistema basado en apt (Debian/Ubuntu)."
[[ -f "$REPO_DIR/backend/main.py" ]] || die "Ejecútame desde la carpeta del repositorio clonado."

# ── 1. preguntas ──────────────────────────────────────────────────────────────
step "Cómo se va a acceder a la app"
echo "  1) Con dominio + HTTPS automático (Caddy + Let's Encrypt)   ← recomendado"
echo "  2) Con Cloudflare Tunnel (sin abrir puertos; requiere cuenta Cloudflare)"
echo "  3) Solo red local / Tailscale (sin TLS público; el más simple)"
MODE="${WT_MODE:-}"
while [[ "$MODE" != "caddy" && "$MODE" != "cloudflared" && "$MODE" != "local" ]]; do
  read -rp "  Elige [1/2/3]: " n
  case "$n" in 1) MODE=caddy;; 2) MODE=cloudflared;; 3) MODE=local;; esac
done
ok "modo: $MODE"

DOMAIN="${WT_DOMAIN:-}"; BIND="${WT_BIND:-}"; PUBLIC_URL=""
if [[ "$MODE" == "caddy" || "$MODE" == "cloudflared" ]]; then
  ask DOMAIN "Dominio para la app (p. ej. terminal.ejemplo.com)"
  PUBLIC_URL="https://$DOMAIN"
else
  if command -v tailscale >/dev/null 2>&1 && tailscale ip -4 >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
    note "Detectado Tailscale con IP $TS_IP"
    ask BIND "IP de escucha (127.0.0.1 = solo esta máquina; $TS_IP = tu tailnet)" "$TS_IP"
  else
    ask BIND "IP de escucha (127.0.0.1 = solo esta máquina; 0.0.0.0 = toda la LAN)" "127.0.0.1"
  fi
fi

APP_PORT="${WT_APP_PORT:-$(env_get WEBTERMINAL_APP_PORT)}"; ask APP_PORT "Puerto interno de la app" "8765"
[[ "$MODE" == "local" ]] && PUBLIC_URL="http://$BIND:$APP_PORT"

step "SSH de esta máquina (a qué se conecta la terminal)"
DETECTED_SSH="$( (sshd -T 2>/dev/null || true) | awk '/^port /{print $2; exit}')"
[[ -z "$DETECTED_SSH" ]] && DETECTED_SSH="$(grep -iE '^ *Port +[0-9]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2; exit}')"
SSH_PORT="${WT_SSH_PORT:-}"; ask SSH_PORT "Puerto del sshd local" "${DETECTED_SSH:-22}"
note "Cada usuario abre la terminal con SU usuario y contraseña del sistema."
note "Asegúrate de que sshd permite PasswordAuthentication para esos usuarios."

step "Primer usuario del login web"
note "Es la puerta de entrada a la app (independiente del usuario SSH)."
ADMIN_EMAIL="${WT_ADMIN_EMAIL:-}"; ask ADMIN_EMAIL "Email del usuario web"
ADMIN_PASSWORD="${WT_ADMIN_PASSWORD:-}"; ask_secret ADMIN_PASSWORD "Contraseña (mín. 8)"

# ── 2. paquetes ───────────────────────────────────────────────────────────────
step "Paquetes del sistema"
NEED=()
for p in python3-venv python3-pip openssl tmux rsync curl; do
  dpkg -s "$p" >/dev/null 2>&1 || command -v "${p%%-*}" >/dev/null 2>&1 || NEED+=("$p")
done
if ((${#NEED[@]})); then apt-get update -qq; apt-get install -y -qq "${NEED[@]}"; ok "instalados: ${NEED[*]}"; else ok "nada que instalar"; fi

# ── 3. archivos + venv ────────────────────────────────────────────────────────
step "Aplicación en $BASE"
mkdir -p "$BASE"/{backend,frontend,uploads}
rsync -a --delete "$REPO_DIR/backend/" "$BASE/backend/" --exclude secret_key.txt --exclude __pycache__
rsync -a --delete "$REPO_DIR/frontend/" "$BASE/frontend/"
if [[ ! -x "$BASE/venv/bin/python" ]]; then python3 -m venv "$BASE/venv"; ok "virtualenv creado"; fi
"$BASE/venv/bin/pip" install -q -r "$BASE/backend/requirements.txt"
ok "dependencias Python al día"

# ── 4. configuración (.env) ───────────────────────────────────────────────────
step "Configuración ($ENV_FILE)"
SECRET="$(env_get WEBTERMINAL_SECRET_KEY)"
[[ -z "$SECRET" ]] && SECRET="$(openssl rand -hex 32)" && note "SECRET_KEY nueva generada"
cat > "$ENV_FILE" <<EOF
# Generado por install.sh el $(date -Iseconds). Editar y reiniciar: systemctl restart webterminal
WEBTERMINAL_URL=$PUBLIC_URL
WEBTERMINAL_SECRET_KEY=$SECRET
WEBTERMINAL_SSH_HOST=127.0.0.1
WEBTERMINAL_SSH_PORT=$SSH_PORT
WEBTERMINAL_FRONTEND=$BASE/frontend
WEBTERMINAL_DB=$BASE/webterminal.db
WEBTERMINAL_UPLOAD_DIR=$BASE/uploads
WEBTERMINAL_APP_PORT=$APP_PORT
EOF
chmod 600 "$ENV_FILE"
ok ".env escrito (permisos 600)"

# ── 5. servicio systemd ───────────────────────────────────────────────────────
step "Servicio systemd"
LISTEN_HOST="127.0.0.1"; [[ "$MODE" == "local" ]] && LISTEN_HOST="$BIND"
sed -e "s|--host 127.0.0.1|--host $LISTEN_HOST|" -e "s|--port 8765|--port $APP_PORT|" \
    "$REPO_DIR/webterminal.service" > "$SERVICE_DST"
chown -R www-data:www-data "$BASE"
systemctl daemon-reload
systemctl enable --now webterminal >/dev/null 2>&1
sleep 2
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/" || true)"
[[ "$CODE" == "200" ]] && ok "servicio arriba (HTTP $CODE en 127.0.0.1:$APP_PORT)" \
  || { warn "el servicio responde HTTP '$CODE'"; note "mira: journalctl -u webterminal -n 30"; }

# ── 6. usuario web ────────────────────────────────────────────────────────────
step "Usuario web"
( cd "$BASE/backend" && WEBTERMINAL_DB="$BASE/webterminal.db" \
  "$BASE/venv/bin/python" manage.py create-user "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" )
chown www-data:www-data "$BASE/webterminal.db" 2>/dev/null || true
ok "usuario '$ADMIN_EMAIL' creado"

# ── 7. exposición ─────────────────────────────────────────────────────────────
case "$MODE" in
caddy)
  step "Caddy + Let's Encrypt"
  echo "  Para emitir el certificado, el DNS de $DOMAIN debe apuntar YA a esta máquina."
  read -rp "  ¿Apunta ya? [s/N]: " dns
  [[ "${dns,,}" == s* ]] || warn "Sigo igualmente; Caddy reintentará el certificado cuando el DNS esté."
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy
    ok "Caddy instalado"
  fi
  MARK="# webterminal:$DOMAIN"
  if ! grep -q "$MARK" /etc/caddy/Caddyfile 2>/dev/null; then
    cat >> /etc/caddy/Caddyfile <<EOF

$MARK
$DOMAIN {
    reverse_proxy 127.0.0.1:$APP_PORT
}
EOF
    systemctl reload caddy || systemctl restart caddy
    ok "sitio $DOMAIN añadido al Caddyfile"
  else
    ok "el Caddyfile ya tenía el sitio (no toco nada)"
  fi
  ;;
cloudflared)
  step "Cloudflare Tunnel"
  if ! command -v cloudflared >/dev/null 2>&1; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq && apt-get install -y -qq cloudflared
    ok "cloudflared instalado"
  fi
  if [[ -f /etc/cloudflared/config.yml ]]; then
    warn "Ya existe /etc/cloudflared/config.yml (un túnel en uso). No lo toco."
    echo "  Añade tú esta regla de ingress ANTES del 404 final y recarga cloudflared:"
    printf '%b' "$C_DIM"
    cat <<EOF
      - hostname: $DOMAIN
        service: http://127.0.0.1:$APP_PORT
EOF
    printf '%b' "$C_OFF"
    echo "  Y crea el DNS:  cloudflared tunnel route dns <tu-tunel> $DOMAIN"
  else
    if [[ ! -f /root/.cloudflared/cert.pem && ! -f /home/${SUDO_USER:-root}/.cloudflared/cert.pem ]]; then
      echo "  Hace falta autorizar cloudflared con tu cuenta (se abre un enlace de Cloudflare):"
      cloudflared tunnel login
    fi
    TUNNEL_NAME=webterminal
    cloudflared tunnel create "$TUNNEL_NAME" >/dev/null 2>&1 || true
    TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v t="$TUNNEL_NAME" '$2==t{print $1}')"
    [[ -n "$TUNNEL_ID" ]] || die "No pude crear/encontrar el túnel '$TUNNEL_NAME'."
    mkdir -p /etc/cloudflared
    CRED="$(ls /root/.cloudflared/"$TUNNEL_ID".json /home/${SUDO_USER:-root}/.cloudflared/"$TUNNEL_ID".json 2>/dev/null | head -1)"
    cat > /etc/cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CRED
ingress:
  - hostname: $DOMAIN
    service: http://127.0.0.1:$APP_PORT
  - service: http_status:404
EOF
    cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" || warn "Crea el DNS a mano en el panel de Cloudflare."
    cloudflared service install >/dev/null 2>&1 || true
    systemctl enable --now cloudflared >/dev/null 2>&1 || systemctl restart cloudflared
    ok "túnel '$TUNNEL_NAME' sirviendo $DOMAIN"
  fi
  ;;
local)
  step "Acceso local"
  ok "la app escucha en $BIND:$APP_PORT (sin TLS: úsala solo en redes de confianza)"
  ;;
esac

# ── 8. resumen ────────────────────────────────────────────────────────────────
printf '\n%b  ✔ WebTerminal instalado%b\n\n' "$C_OK" "$C_OFF"
echo    "    URL:          $PUBLIC_URL"
echo    "    Usuario web:  $ADMIN_EMAIL"
echo    "    Terminal SSH: 127.0.0.1:$SSH_PORT (usuario y contraseña del sistema)"
echo    ""
echo    "    Gestión:      systemctl status webterminal · journalctl -u webterminal -f"
echo    "    Más usuarios: cd $BASE/backend && sudo WEBTERMINAL_DB=$BASE/webterminal.db $BASE/venv/bin/python manage.py create-user otro@email.com"
echo    "    Actualizar:   git pull && sudo ./deploy.sh   (desde el repositorio)"
echo    ""
