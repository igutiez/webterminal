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

## 0. Primer arranque — secretos y entorno

Los secretos **no** están en el repositorio. Antes de arrancar por primera vez en
un servidor nuevo hay que definir la clave de firma de los JWT; **si falta, la app
no arranca** (`RuntimeError: Falta la SECRET_KEY`).

```bash
# Opción A (la del despliegue actual): archivo local, ignorado por git
sudo -u www-data sh -c 'openssl rand -hex 32 > /opt/webterminal/backend/secret_key.txt'
sudo chmod 600 /opt/webterminal/backend/secret_key.txt
sudo systemctl restart webterminal

# Opción B: variables de entorno mediante un .env cargado por systemd
cp .env.example .env && nano .env            # rellena WEBTERMINAL_SECRET_KEY
# luego añade al unit (sudo systemctl edit webterminal):
#   [Service]
#   EnvironmentFile=-/opt/webterminal/.env
```

Todas las variables están documentadas en **[`.env.example`](.env.example)**. La
única imprescindible es `WEBTERMINAL_SECRET_KEY` (o, en su defecto, el archivo
`backend/secret_key.txt`). `WEBTERMINAL_P12_PASS` solo la usa `setup.sh` al generar
los `.p12`. Tanto `.env` como `secret_key.txt` están en `.gitignore`.

> Al rotar `WEBTERMINAL_SECRET_KEY` se invalidan los JWT en circulación: todos los
> usuarios tendrán que volver a iniciar sesión una vez.

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

Los usuarios viven en SQLite (`webterminal.db`, módulo `backend/db.py`). El login
web es por **email**; el SSH usa el usuario+contraseña del sistema (independiente).

```bash
# 1) alta/actualización del usuario web (email + contraseña)
sudo /opt/webterminal/venv/bin/python - <<'PY'
import sys; sys.path.insert(0, "/opt/webterminal/backend")
import db, getpass
email = input("Email del nuevo usuario: ").strip().lower()
db.create_or_update_user(email, getpass.getpass("Contraseña web: "))
print("Usuario creado/actualizado:", email)
PY

# 2) (opcional) genera un nuevo .p12 para esa persona — ver setup.sh, paso 8
```

> No hace falta reiniciar: la BBDD se lee en cada petición. La contraseña se
> guarda con hash bcrypt.

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

Cada usuario puede cambiarla desde **"Mi cuenta"** en la web, o por el flujo de
**recuperación por email**. Para forzarla a mano:

```bash
sudo /opt/webterminal/venv/bin/python - <<'PY'
import sys; sys.path.insert(0, "/opt/webterminal/backend")
import db, getpass
email = input("Email: ").strip().lower()
db.set_password(email, getpass.getpass("Nueva contraseña: "))
print("Contraseña actualizada para", email)
PY
```

## 7. Activar el mTLS en Cloudflare Access (paso manual)

1. Panel **Cloudflare Zero Trust** → **Access** → **Applications** → *Add an
   application* → **Self-hosted**, dominio `terminal.vistawib.com`.
2. **Settings → Mutual TLS** (a nivel de cuenta): sube `certs/ca/ca.crt` como CA.
3. En la política de la aplicación, exige **"Valid certificate"** (Common Name =
   `user1`/`user2` si quieres restringir por persona).
4. Guarda. A partir de ahí, sin `.p12` válido Cloudflare ni siquiera deja llegar
   al login web.

## 8. Funciones de la terminal

### Subir archivos (cualquier tipo)
Pensado para pasarle archivos a Claude (u otra herramienta) sin teclear rutas.
Tres formas, todas equivalentes:

- **Botón 📎** de la barra superior (selector de archivos, admite varios).
- **Arrastrar y soltar** sobre la terminal.
- **Pegar** con `Ctrl+V` (imágenes del portapapeles).

El archivo se sube a `WEBTERMINAL_UPLOAD_DIR` (por defecto
`/home/ubuntu/imagenes_temp/`, legible por el usuario SSH) conservando su nombre,
y **su ruta se inserta automáticamente en la terminal** (entrecomillada si tiene
espacios). Acepta cualquier tipo (pdf, zip, docx, pptx, md, imágenes, vídeo…),
hasta `WEBTERMINAL_MAX_UPLOAD_MB` MB (100 por defecto). Endpoint:
`POST /upload` (requiere el JWT de sesión).

> **Limpieza:** el temporal se **vacía cada noche a las 00:00** mediante el cron
> `/etc/cron.d/webterminal-temp-cleanup`. Los archivos duran el día y desaparecen
> solos; no se acumulan.

### Dictado por voz 🎤
Botón 🎤 de la barra: usa la **Web Speech API** del navegador (Chrome, `es-ES`,
gratis) para transcribir lo que dices e inyectarlo en la terminal. Tócalo para
empezar/parar; la primera vez pide permiso de micrófono.

> El reconocimiento de Chrome procesa el audio en servidores de Google. Es
> opt-in (solo al pulsar 🎤). Para STT 100 % local habría que montar Whisper.

### Acceso directo a Claude
La pantalla de conexión SSH tiene **dos botones**:
- **Abrir terminal** — abre la shell y nada más.
- **Abrir + Claude** — abre la shell y lanza `claude` automáticamente.

### Móvil / PWA
La interfaz es **responsive** y se puede **instalar como app**. En el móvil
(Chrome/Safari) abre `https://terminal.vistawib.com` → *Añadir a pantalla de
inicio*. Útil para mandar fotos/archivos o dictar por voz desde el teléfono.
Aporta `manifest.webmanifest`, `sw.js` (service worker) e iconos.

## Estructura

```
/opt/webterminal/
├── backend/{main,auth,terminal,db,email_service}.py  requirements.txt
│                                    secret_key.txt  (gitignored — SECRET_KEY)
├── frontend/{index.html,app.js,style.css}
│            manifest.webmanifest  sw.js  icon-192.png  icon-512.png
├── certs/ca/{ca.key,ca.crt}         certs/clients/*.p12   (gitignored)
├── cloudflared/ingress-snippet.yml  (referencia)
├── webterminal.service  setup.sh  README.md  .env.example
├── webterminal.db                   (SQLite usuarios — gitignored)
└── credentials.txt                  (root:600 — credenciales web generadas)
```

> `nginx/` queda vacío en este modo (Cloudflare hace de edge). Se conserva por si
> algún día se migra a exposición directa con nginx + Let's Encrypt + mTLS.
