# Prompt para Claude — montar acceso mTLS (Cloudflare Access + .p12)

> Pégale TODO lo de abajo (desde "Eres Claude Code…") a Claude (Opus) ejecutándose
> con acceso por terminal al servidor donde está el webterminal. Claude tendrá la
> **API global de Cloudflare** de la cuenta (se la dará el usuario).

---

Eres Claude Code con acceso por terminal al servidor de mi amigo. Tiene desplegado un
webterminal (FastAPI/uvicorn detrás de un **Cloudflare Tunnel**) y quiere protegerlo con
**Cloudflare Access + mTLS (certificado de cliente .p12)**, exactamente igual que en
terminal.messor.app: sin el certificado en el navegador, Cloudflare devuelve **403** y no
se llega ni al servidor; con el `.p12` importado (+ el login web de la propia app), se entra.

Su dominio es **terminal.albertovh71.com**.

Tendrás la **API global de Cloudflare** de la cuenta, así que automatiza la parte de
Cloudflare por API (no hace falta el panel). Objetivo final: dejar el mTLS montado de punta
a punta y entregarle el `.p12` + su contraseña.

## Paso 0 — Pídele estos datos antes de tocar nada
1. **Email de la cuenta de Cloudflare** y la **Global API Key** (la usarás en cabeceras
   `X-Auth-Email` / `X-Auth-Key`). Es una credencial MUY potente: guárdala solo en variables
   de entorno de la sesión, no la escribas en archivos ni en logs, y avisa de rotarla al final.
2. ¿En qué **puerto local** escucha el webterminal? (en messor es `127.0.0.1:8765`).
3. ¿Ya tiene un **Cloudflare Tunnel** (`cloudflared`) corriendo? Nombre del túnel y ruta de
   su `config.yml` (típico `/etc/cloudflared/config.yml`).
4. ¿Qué **email(s)** podrán entrar (para la política de Access)?
5. Nombre de usuario para el certificado de cliente (p.ej. `alberto`).

Comprueba también que están instalados `openssl`, `curl` y `jq`.

## Paso 1 — CA propia + certificado de cliente + .p12 (en el servidor)

```bash
BASE=/opt/webterminal/certs            # ajusta si el webterminal está en otra ruta
sudo mkdir -p "$BASE/ca" "$BASE/clients"

# --- CA propia (firma los certificados de cliente) ---
sudo openssl genrsa -out "$BASE/ca/ca.key" 4096
sudo openssl req -new -x509 -days 3650 -key "$BASE/ca/ca.key" -out "$BASE/ca/ca.crt" \
  -subj "/C=ES/O=albertovh71/CN=terminal-albertovh71-CA"

# --- Certificado de cliente (cambia "alberto" por el nombre del Paso 0) ---
U=alberto
P12_PASS=$(openssl rand -base64 18)
sudo openssl genrsa -out "$BASE/clients/$U.key" 2048
sudo openssl req -new -key "$BASE/clients/$U.key" -out "$BASE/clients/$U.csr" \
  -subj "/C=ES/O=albertovh71/CN=$U"
sudo openssl x509 -req -days 3650 -in "$BASE/clients/$U.csr" \
  -CA "$BASE/ca/ca.crt" -CAkey "$BASE/ca/ca.key" -CAcreateserial \
  -out "$BASE/clients/$U.crt"
# El .p12 es lo que se importa en el navegador (cert + clave + CA):
sudo openssl pkcs12 -export -in "$BASE/clients/$U.crt" -inkey "$BASE/clients/$U.key" \
  -certfile "$BASE/ca/ca.crt" -out "$BASE/clients/$U.p12" -passout pass:"$P12_PASS"

sudo chmod 600 "$BASE/ca/ca.key"
echo ">> Entrega a tu amigo: $BASE/clients/$U.p12"
echo ">> Contraseña del .p12: $P12_PASS"
```
Apunta y enséñale la ruta del `$U.p12` y su **contraseña**.

## Paso 2 — Túnel: exponer el servicio en terminal.albertovh71.com
En el `config.yml` de cloudflared, añade la regla de ingress apuntando al puerto local
del webterminal, ANTES de la regla `- service: http_status:404`:

```yaml
ingress:
  - hostname: terminal.albertovh71.com
    service: http://localhost:8765      # ajusta al puerto real del Paso 0
  - service: http_status:404
```
Crea la ruta DNS (CNAME proxied al túnel) y reinicia:
```bash
cloudflared tunnel route dns <NOMBRE_DEL_TUNEL> terminal.albertovh71.com
sudo systemctl restart cloudflared
```
Verifica que el origen responde en local: `curl -I http://localhost:8765/` → debe dar `200`.

## Paso 3 — Cloudflare Access + mTLS por API
Exporta credenciales y define un helper. NO imprimas la clave.

```bash
export CF_EMAIL="cuenta@ejemplo.com"     # email de la cuenta Cloudflare
export CF_KEY="GLOBAL_API_KEY_AQUI"      # Global API Key
api() { curl -sS -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_KEY" \
             -H "Content-Type: application/json" "$@"; }

# Account ID (si hay varias cuentas, elige la correcta por nombre)
ACC=$(api https://api.cloudflare.com/client/v4/accounts | jq -r '.result[0].id')
echo "account_id=$ACC"
```

**1) Subir la CA como certificado mTLS de Access y asociar el hostname:**
```bash
CA_PEM=$(jq -Rs . < /opt/webterminal/certs/ca/ca.crt)   # PEM -> string JSON
api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/access/certificates" \
  --data @- <<JSON
{ "name": "terminal-albertovh71-CA",
  "certificate": $CA_PEM,
  "associated_hostnames": ["terminal.albertovh71.com"] }
JSON
```

**2) Crear la aplicación de Access (self-hosted):**
```bash
APP=$(api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps" \
  --data '{"name":"Terminal albertovh71","domain":"terminal.albertovh71.com",
           "type":"self_hosted","session_duration":"24h"}' | jq -r '.result.id')
echo "app_id=$APP"
```

**3) Política: exige certificado válido (require) Y email permitido (include):**
```bash
api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps/$APP/policies" \
  --data '{"name":"mTLS + email","decision":"allow",
    "include":[{"email":{"email":"amigo@ejemplo.com"}}],
    "require":[{"certificate":{}}]}'
```
> Lógica de Access: `include` = OR (basta uno), `require` = AND (obligatorio). Así se exige
> **a la vez** tener un certificado válido y estar en la lista de emails. Para varios
> usuarios añade más objetos `{"email":{"email":"..."}}` al `include`.

Revisa que cada llamada devuelva `"success": true`.

## Paso 4 — Importar el .p12 en el navegador del amigo
- Chrome/Edge: `chrome://settings/certificates` → *Tus certificados* → **Importar** →
  elige `$U.p12` → pon la contraseña del Paso 1.
- macOS/Safari: doble clic en el `.p12` → importar al Llavero.
- iPhone/iPad: instala el `.p12` como Perfil (Ajustes → Perfil descargado) y actívalo.

## Paso 5 — Verificar
```bash
# Sin certificado debe dar 403 (lo bloquea Cloudflare Access):
curl -sS -o /dev/null -w "%{http_code}\n" https://terminal.albertovh71.com/
```
Debe salir **403**. Tras importar el `.p12`, al abrir `https://terminal.albertovh71.com` el
navegador pedirá elegir el certificado y entrará (luego, el login web de la propia app).

## Notas finales
- **Seguridad**: la Global API Key da control total de la cuenta. Úsala solo en esta sesión,
  no la dejes en archivos ni en el historial, y dile al usuario que la **rote** después si
  quiere (o que en el futuro use un API Token con permisos mínimos: *Access: Apps and Policies*
  + *Access: Certificates* + *DNS*).
- **No subir a git**: `ca.key` y los `.p12` son secretos. Añade al `.gitignore`:
  `*.p12`, `*.key`, `*.csr`, `certs/`.
- **Más usuarios**: repite solo el bloque "certificado de cliente" del Paso 1 con otro `$U`;
  la misma CA ya está asociada en Cloudflare, no hay que volver a tocar Access.
- El **login web** de la app (email+contraseña) es una capa aparte; el mTLS es la barrera de
  Cloudflare por delante de todo.
