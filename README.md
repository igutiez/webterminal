# WebTerminal

Terminal SSH web profesional para esta máquina. Hace SSH a `localhost:20776`
con las credenciales del usuario del sistema y expone una terminal **xterm.js**.

```
Chrome (cert .p12)  →  Cloudflare edge (Access mTLS + TLS)
                    →  túnel "vista_web"  →  FastAPI 127.0.0.1:8765
                    →  paramiko  →  SSH localhost:20776
```

> **Edge = Cloudflare Tunnel.** Este servidor no expone 80/443 y `vistawib.com`
> ya va por el túnel `cloudflared` (`vista_web`). Por eso **no** usamos nginx ni
> Let's Encrypt: el TLS lo pone Cloudflare y el **mTLS de cliente** se aplica con
> **Cloudflare Access**, no con `ssl_verify_client`.

## Capas de seguridad

1. **Certificado de cliente `.p12`** — exigido por Cloudflare Access (mTLS).
2. **Login web** — usuario + contraseña (bcrypt) → JWT de 8 h (solo en memoria).
3. **Contraseña de sistema** — la del usuario SSH, pedida al abrir la terminal.

---

## 1. Instalar el certificado `.p12` en Chrome

1. Copia el `.p12` a tu equipo, p. ej.:
   `scp -P 20776 ubuntu@SERVIDOR:/opt/webterminal/certs/clients/user1.p12 .`
   (necesitarás `sudo cat`/`sudo cp` porque pertenece a `www-data`).
2. En Chrome abre `chrome://settings/certificates`.
3. Pestaña **"Tus certificados"** → **Importar** → elige el `.p12`.
4. Contraseña del `.p12`: la definida en `WEBTERMINAL_P12_PASS` al ejecutar `setup.sh`.
5. Reinicia Chrome. Al entrar en `https://terminal.vistawib.com` el navegador te
   pedirá qué certificado presentar.

> El mTLS solo se aplica de verdad cuando hayas configurado **Cloudflare Access**
> (ver sección 7). La CA a subir es `certs/ca/ca.crt`.

## 2. Añadir un nuevo usuario web

Los usuarios web deben ser **usuarios reales del sistema** que puedan hacer SSH
por contraseña (paramiko inicia sesión con ese mismo nombre).

```bash
# 1) genera el hash bcrypt de la nueva contraseña web
sudo /opt/webterminal/venv/bin/python - <<'PY'
import bcrypt, getpass
pw = getpass.getpass("Nueva contraseña web: ")
print(bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode())
PY

# 2) edita auth.py y añade la línea en el diccionario USERS:
sudo nano /opt/webterminal/backend/auth.py
#    USERS = {
#        "ubuntu": "$2b$...",
#        "nuevousuario": "$2b$...EL_HASH...",
#    }

# 3) (opcional) genera un nuevo .p12 para esa persona — ver setup.sh, paso 8

# 4) reinicia el servicio
sudo systemctl restart webterminal
```

> `root` en este host es `PermitRootLogin without-password`: **no** puede usarse
> como usuario web porque no acepta SSH por contraseña. Usa `ubuntu` u otro
> usuario de sistema con contraseña.

## 3. Revocar un certificado de cliente

No hay CRL implementada. Opciones:

- **Recomendado (Cloudflare Access):** quita/edita la política mTLS en el panel
  Zero Trust, o sube una CA nueva y reemite solo los `.p12` válidos.
- **Local:** borra `certs/clients/<user>.{key,crt,csr,p12}`. Esto impide reemitir
  ese cert, pero un `.p12` ya entregado seguiría siendo válido hasta cambiar la CA.
- **Revocación real:** regenerar la CA (y por tanto todos los `.p12`) o implementar
  OCSP/CRL.

## 4. Renovar certificados TLS

No aplica: el certificado TLS público lo gestiona **Cloudflare** automáticamente.
No hay Let's Encrypt que renovar en este servidor.

## 5. Gestión del servicio

```bash
sudo systemctl start    webterminal
sudo systemctl stop     webterminal
sudo systemctl restart  webterminal
sudo systemctl status   webterminal
journalctl -u webterminal -f          # logs en vivo
```

El túnel:

```bash
sudo systemctl status cloudflared
sudo grep -n terminal /etc/cloudflared/config.yml
```

## 6. Actualizar contraseñas

```bash
# generar el hash y pegarlo en USERS dentro de auth.py
sudo /opt/webterminal/venv/bin/python - <<'PY'
import bcrypt, getpass
print(bcrypt.hashpw(getpass.getpass("Nueva contraseña: ").encode(), bcrypt.gensalt()).decode())
PY
sudo systemctl restart webterminal
```

## 7. Activar el mTLS en Cloudflare Access (paso manual)

1. Panel **Cloudflare Zero Trust** → **Access** → **Applications** → *Add an
   application* → **Self-hosted**, dominio `terminal.vistawib.com`.
2. **Settings → Mutual TLS** (a nivel de cuenta): sube `certs/ca/ca.crt` como CA.
3. En la política de la aplicación, exige **"Valid certificate"** (Common Name =
   `user1`/`user2` si quieres restringir por persona).
4. Guarda. A partir de ahí, sin `.p12` válido Cloudflare ni siquiera deja llegar
   al login web.

## Estructura

```
/opt/webterminal/
├── backend/{main,auth,terminal}.py  requirements.txt
├── frontend/{index.html,app.js,style.css}
├── certs/ca/{ca.key,ca.crt}         certs/clients/*.p12
├── cloudflared/ingress-snippet.yml  (referencia)
├── webterminal.service              setup.sh   README.md
└── credentials.txt                  (root:600 — credenciales web generadas)
```

> `nginx/` queda vacío en este modo (Cloudflare hace de edge). Se conserva por si
> algún día se migra a exposición directa con nginx + Let's Encrypt + mTLS.
