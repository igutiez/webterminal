#!/usr/bin/env bash
# Actualiza la instalación de /opt/webterminal con el contenido del repo.
#   sudo ./deploy.sh            sincroniza frontend y backend; reinicia si cambió el backend
#   sudo ./deploy.sh --restart  reinicia el servicio siempre
set -euo pipefail
BASE=/opt/webterminal
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $EUID -eq 0 ]] || { echo "Ejecútame con sudo." >&2; exit 1; }
[[ -d "$BASE/backend" ]] || { echo "No hay instalación en $BASE (usa install.sh primero)." >&2; exit 1; }

CHANGED_BACK="$(rsync -ai --delete "$REPO_DIR/backend/" "$BASE/backend/" --exclude secret_key.txt --exclude __pycache__ | grep -c '^[<>ch.]' || true)"
CHANGED_FRONT="$(rsync -ai --delete "$REPO_DIR/frontend/" "$BASE/frontend/" | grep -c '^[<>ch.]' || true)"
chown -R www-data:www-data "$BASE/backend" "$BASE/frontend"
echo "backend: $CHANGED_BACK cambios · frontend: $CHANGED_FRONT cambios"

if [[ "${1:-}" == "--restart" || "$CHANGED_BACK" -gt 0 ]]; then
  "$BASE/venv/bin/pip" install -q -r "$BASE/backend/requirements.txt"
  systemctl restart webterminal
  echo "servicio reiniciado"
fi
PORT="$(grep -E '^WEBTERMINAL_APP_PORT=' "$BASE/.env" 2>/dev/null | cut -d= -f2)"
curl -s -o /dev/null -w "salud: HTTP %{http_code}\n" "http://127.0.0.1:${PORT:-8765}/" || true
