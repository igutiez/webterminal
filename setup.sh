#!/usr/bin/env bash
# =============================================================================
# WebTerminal installer  —  Cloudflare Tunnel + Access edition
#   Server reality this script adapts to:
#     * Ubuntu 25.04 / Python 3.13
#     * sshd on port 20776 (handled in backend/terminal.py)
#     * No nginx, no open 80/443 — traffic arrives via the existing
#       cloudflared tunnel "vista_web"; TLS terminates at Cloudflare's edge.
#       => no Let's Encrypt/certbot, no nginx mTLS. Client-cert mTLS is enforced
#          by Cloudflare Access (you upload certs/ca/ca.crt in the Zero Trust panel).
#   Idempotent: safe to re-run.
# =============================================================================
set -euo pipefail

BASE=/opt/webterminal
DOMAIN=terminal.vistawib.com
TUNNEL=vista_web
APP_PORT=8765
P12_PASS="${WEBTERMINAL_P12_PASS:-CHANGEME}"   # NO hardcodear: export WEBTERMINAL_P12_PASS antes de ejecutar
CF_CONFIG=/etc/cloudflared/config.yml
CF_CERT=/home/ubuntu/.cloudflared/cert.pem
CRED_FILE="$BASE/credentials.txt"
# System users that can authenticate over SSH with a password.
# NOTE: root is "without-password" on this host, so it cannot be used here.
SYS_USERS=("ubuntu")

step(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# --- 1. must be root --------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  echo "Este script debe ejecutarse como root (usa: sudo $0)" >&2
  exit 1
fi

# --- 2. system packages (no nginx/certbot in this edition) ------------------
step "Paquetes del sistema"
NEED=()
command -v openssl >/dev/null 2>&1 || NEED+=(openssl)
dpkg -s python3-venv >/dev/null 2>&1 || NEED+=(python3-venv)
dpkg -s python3-pip  >/dev/null 2>&1 || NEED+=(python3-pip)
if (( ${#NEED[@]} )); then
  apt-get update -y
  apt-get install -y "${NEED[@]}"
else
  echo "ok (nada que instalar)"
fi

# --- 3. directory structure -------------------------------------------------
step "Estructura de directorios"
mkdir -p "$BASE"/{backend,frontend,certs/ca,certs/clients,nginx,cloudflared}
echo "ok"

# --- 4. Let's Encrypt: OMITIDO (TLS lo provee Cloudflare en el edge) --------

# --- 5. virtualenv ----------------------------------------------------------
step "Virtualenv (Python 3.13)"
if [[ ! -x "$BASE/venv/bin/python" ]]; then
  python3 -m venv "$BASE/venv"
  echo "creado"
else
  echo "ok (ya existe)"
fi

# --- 6. python dependencies -------------------------------------------------
step "Dependencias Python"
"$BASE/venv/bin/pip" install --upgrade pip >/dev/null
"$BASE/venv/bin/pip" install -r "$BASE/backend/requirements.txt"

# --- 7. own CA --------------------------------------------------------------
step "CA propia (para mTLS de cliente)"
if [[ ! -f "$BASE/certs/ca/ca.crt" ]]; then
  openssl genrsa -out "$BASE/certs/ca/ca.key" 4096
  openssl req -new -x509 -days 3650 -key "$BASE/certs/ca/ca.key" \
    -out "$BASE/certs/ca/ca.crt" \
    -subj "/C=ES/ST=Vizcaya/L=Balmaseda/O=Vistawib/CN=WebTerminal-CA"
  echo "CA creada"
else
  echo "ok (CA ya existe)"
fi

# --- 8. client certificates + .p12 -----------------------------------------
step "Certificados cliente (.p12)"
for U in user1 user2; do
  if [[ -f "$BASE/certs/clients/$U.p12" ]]; then
    echo "ok ($U.p12 ya existe)"
    continue
  fi
  openssl genrsa -out "$BASE/certs/clients/$U.key" 2048
  openssl req -new -key "$BASE/certs/clients/$U.key" \
    -out "$BASE/certs/clients/$U.csr" -subj "/C=ES/O=Vistawib/CN=$U"
  openssl x509 -req -days 3650 -in "$BASE/certs/clients/$U.csr" \
    -CA "$BASE/certs/ca/ca.crt" -CAkey "$BASE/certs/ca/ca.key" -CAcreateserial \
    -out "$BASE/certs/clients/$U.crt"
  openssl pkcs12 -export -in "$BASE/certs/clients/$U.crt" \
    -inkey "$BASE/certs/clients/$U.key" -certfile "$BASE/certs/ca/ca.crt" \
    -out "$BASE/certs/clients/$U.p12" -passout pass:"$P12_PASS"
  echo "$U.p12 generado"
done

# --- 9 + 10. inject SECRET_KEY + bcrypt web credentials into auth.py --------
step "Inyectar SECRET_KEY y credenciales web en auth.py"
if grep -q 'REPLACE_SECRET_KEY' "$BASE/backend/auth.py"; then
  SECRET=$(openssl rand -hex 32)
  "$BASE/venv/bin/python" - "$SECRET" "$CRED_FILE" "${SYS_USERS[@]}" <<'PY'
import re, secrets, string, sys
import bcrypt

secret, cred_file = sys.argv[1], sys.argv[2]
users = sys.argv[3:]
alphabet = string.ascii_letters + string.digits

entries, creds = [], []
for u in users:
    pw = ''.join(secrets.choice(alphabet) for _ in range(16))
    h = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
    entries.append('    "%s": "%s",' % (u, h))
    creds.append("%s / %s" % (u, pw))

path = "/opt/webterminal/backend/auth.py"
src = open(path).read()
src = src.replace('REPLACE_SECRET_KEY', secret)
block = "USERS = {\n" + "\n".join(entries) + "\n}"
src = re.sub(r'USERS = \{[^}]*\}', block, src, count=1)
open(path, "w").write(src)
open(cred_file, "w").write("\n".join(creds) + "\n")
print("auth.py actualizado para:", ", ".join(users))
PY
else
  echo "ok (auth.py ya tiene SECRET_KEY/credenciales — no se tocan)"
fi

# --- 11/12. cloudflared: ingress rule + DNS route (reemplaza a nginx) -------
step "Cloudflare Tunnel: ingress para $DOMAIN"
if [[ -f "$CF_CONFIG" ]] && grep -q "$DOMAIN" "$CF_CONFIG"; then
  echo "ok (ingress ya presente)"
elif [[ -f "$CF_CONFIG" ]]; then
  cp "$CF_CONFIG" "$CF_CONFIG.bak.$(date +%s)"
  python3 - "$CF_CONFIG" "$DOMAIN" "$APP_PORT" <<'PY'
import sys
path, domain, port = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
out, done = [], False
for l in lines:
    if (not done) and l.strip().startswith("- service:") and "http_status" in l:
        indent = l[:len(l) - len(l.lstrip())]
        out.append(f"{indent}- hostname: {domain}")
        out.append(f"{indent}  service: http://localhost:{port}")
        done = True
    out.append(l)
if not done:  # no catch-all found: append at end of file
    out.append(f"  - hostname: {domain}")
    out.append(f"    service: http://localhost:{port}")
open(path, "w").write("\n".join(out) + "\n")
print("ingress insertado")
PY
else
  echo "AVISO: no existe $CF_CONFIG — ¿cloudflared instalado? Saltando ingress."
fi

step "Cloudflare Tunnel: ruta DNS para $DOMAIN"
if [[ -f "$CF_CERT" ]]; then
  if sudo -u ubuntu env TUNNEL_ORIGIN_CERT="$CF_CERT" \
       cloudflared tunnel route dns "$TUNNEL" "$DOMAIN" >/tmp/cfroute.log 2>&1; then
    echo "ruta DNS creada"
  elif grep -qiE "already (exists|configured)|record with that host" /tmp/cfroute.log; then
    echo "ok (ruta DNS ya existe)"
  else
    echo "AVISO: no se pudo crear la ruta DNS automáticamente:"
    sed 's/^/    /' /tmp/cfroute.log
  fi
else
  echo "AVISO: no existe $CF_CERT — crea la ruta a mano (ver README)."
fi

if systemctl is-enabled cloudflared >/dev/null 2>&1; then
  systemctl restart cloudflared && echo "cloudflared reiniciado"
fi

# --- 13. systemd unit -------------------------------------------------------
step "Servicio systemd"
install -m 0644 "$BASE/webterminal.service" /etc/systemd/system/webterminal.service

# --- 14. permissions --------------------------------------------------------
step "Permisos"
chown -R www-data:www-data "$BASE"
chmod 700 "$BASE/certs/ca"
chmod 600 "$BASE/certs/ca/ca.key" 2>/dev/null || true
if [[ -f "$CRED_FILE" ]]; then
  chown root:root "$CRED_FILE"
  chmod 600 "$CRED_FILE"
fi
echo "ok"

# --- 15. enable + start -----------------------------------------------------
step "Arranque del servicio"
systemctl daemon-reload
systemctl enable webterminal >/dev/null 2>&1 || true
systemctl restart webterminal
sleep 1
systemctl --no-pager --full status webterminal | head -n 10 || true

# --- 17. summary ------------------------------------------------------------
cat <<EOF

=============================================================
            === INSTALACIÓN COMPLETADA ===
=============================================================

URL:  https://$DOMAIN   (vía Cloudflare Tunnel "$TUNNEL")

CERTIFICADOS CLIENTE (.p12) — instalar en Chrome:
  $BASE/certs/clients/user1.p12   (contraseña: $P12_PASS)
  $BASE/certs/clients/user2.p12   (contraseña: $P12_PASS)

CA para Cloudflare Access (subir en Zero Trust > Settings > mTLS):
  $BASE/certs/ca/ca.crt

CREDENCIALES WEB (usuario / contraseña de la app):
EOF
if [[ -f "$CRED_FILE" ]]; then sed 's/^/  /' "$CRED_FILE"; else echo "  (ya generadas en una ejecución previa: $CRED_FILE)"; fi
cat <<EOF

  La segunda contraseña que pide la terminal tras el login es la
  contraseña de SISTEMA del usuario (su login SSH), NO la contraseña web.

PENDIENTE EN EL PANEL DE CLOUDFLARE (lo haces tú):
  Zero Trust > Access > Applications > Add (self-hosted) para $DOMAIN
  y añade una política mTLS subiendo:  $BASE/certs/ca/ca.crt
  Hasta entonces el acceso solo está protegido por login web + credenciales SSH.

LOGS:  journalctl -u webterminal -f
=============================================================
EOF
