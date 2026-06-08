"""WebTerminal FastAPI app.

Web login is by EMAIL + password (accounts in db.py). SSH identity (system user +
password) is entered when opening the terminal and is independent of the web login.

Routes:
  POST /login            form(email, password) -> {"token": jwt}
  POST /forgot           form(email)           -> {"ok": true}  (always; sends email if exists)
  POST /reset            form(token, password) -> {"ok": true}  or 400
  GET  /account          Bearer token          -> {"email": ...}
  POST /account          Bearer token + form(current_password, new_email?, new_password?)
  GET  /ws?token=jwt     WebSocket; first msg {"ssh_user","password"} opens SSH
  /                      static frontend
"""
import asyncio
import json
import logging
import os
import secrets
import time

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile, WebSocket
from fastapi.staticfiles import StaticFiles

import auth
import db
import email_service
from terminal import SSHTerminal

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("webterminal")

FRONTEND_DIR = os.environ.get("WEBTERMINAL_FRONTEND", "/opt/webterminal/frontend")
PUBLIC_URL = os.environ.get("WEBTERMINAL_URL", "https://terminal.vistawib.com")
MAX_CONNECTIONS = 2
RESET_TTL_MIN = 30
MIN_PW_LEN = 8

# Subida de imágenes para que Claude (en la sesión SSH) pueda verlas.
# El archivo se guarda aquí y la RUTA se inyecta en la terminal. Se auto-limpian
# por antigüedad en cada subida (no podemos saber el instante exacto de "uso").
UPLOAD_DIR = os.environ.get("WEBTERMINAL_UPLOAD_DIR", "/home/ubuntu/imagenes_temp")
UPLOAD_TTL_SEC = int(os.environ.get("WEBTERMINAL_UPLOAD_TTL", str(2 * 3600)))
MAX_UPLOAD_BYTES = 12 * 1024 * 1024
ALLOWED_IMAGE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}

db.init_db()

app = FastAPI(title="WebTerminal")
_active = 0
_lock = asyncio.Lock()


@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # Force browsers to revalidate static assets so updates aren't masked by cache.
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' https://unpkg.com; "
        "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; "
        "font-src https://fonts.gstatic.com; img-src 'self' data:; "
        "connect-src 'self' wss://terminal.vistawib.com"
    )
    return resp


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    return auth.verify_token(authorization[7:])


def _purge_old_uploads() -> None:
    """Borra imágenes subidas con más de UPLOAD_TTL_SEC de antigüedad."""
    try:
        now = time.time()
        with os.scandir(UPLOAD_DIR) as it:
            for entry in it:
                if not entry.name.startswith("img-") or not entry.is_file():
                    continue
                try:
                    if now - entry.stat().st_mtime > UPLOAD_TTL_SEC:
                        os.unlink(entry.path)
                except OSError:
                    pass
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001
        log.info("purge uploads error: %s", exc)


@app.post("/login")
async def login(email: str = Form(...), password: str = Form(...)):
    if not db.verify_password(email, password):
        log.info("login failed email=%s", email)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    log.info("login ok email=%s", email.strip().lower())
    return {"token": auth.create_access_token(email)}


@app.post("/forgot")
async def forgot(email: str = Form(...)):
    email = email.strip().lower()
    user = db.get_user(email)
    if user:
        token = secrets.token_urlsafe(32)
        db.store_reset_token(email, token, RESET_TTL_MIN * 60)
        reset_url = f"{PUBLIC_URL}/?token={token}"
        email_service.send_password_reset(email, reset_url, RESET_TTL_MIN)
        log.info("reset requested email=%s", email)
    else:
        log.info("reset requested for unknown email=%s (ignored)", email)
    # Never reveal whether the address exists.
    return {"ok": True}


@app.post("/reset")
async def reset(token: str = Form(...), password: str = Form(...)):
    if len(password) < MIN_PW_LEN:
        raise HTTPException(status_code=400, detail=f"La contraseña debe tener al menos {MIN_PW_LEN} caracteres")
    email = db.consume_reset_token(token)
    if not email:
        raise HTTPException(status_code=400, detail="Enlace inválido o caducado")
    db.set_password(email, password)
    log.info("password reset done email=%s", email)
    return {"ok": True}


@app.get("/account")
async def account_get(authorization: str | None = Header(default=None)):
    return {"email": _bearer(authorization)}


@app.post("/account")
async def account_update(
    authorization: str | None = Header(default=None),
    current_password: str = Form(...),
    new_email: str = Form(default=""),
    new_password: str = Form(default=""),
):
    email = _bearer(authorization)
    if not db.verify_password(email, current_password):
        raise HTTPException(status_code=401, detail="Contraseña actual incorrecta")

    new_email = new_email.strip().lower()
    if new_password:
        if len(new_password) < MIN_PW_LEN:
            raise HTTPException(status_code=400, detail=f"La nueva contraseña debe tener al menos {MIN_PW_LEN} caracteres")
        db.set_password(email, new_password)
        log.info("password changed email=%s", email)

    if new_email and new_email != email:
        if "@" not in new_email:
            raise HTTPException(status_code=400, detail="Email no válido")
        if not db.change_email(email, new_email):
            raise HTTPException(status_code=409, detail="Ese email ya está en uso")
        log.info("email changed %s -> %s", email, new_email)
        email = new_email

    # Re-issue token (email/sub may have changed)
    return {"ok": True, "token": auth.create_access_token(email), "email": email}


@app.post("/upload-image")
async def upload_image(
    authorization: str | None = Header(default=None),
    file: UploadFile = File(...),
):
    """Recibe una imagen (autenticado), la guarda en UPLOAD_DIR y devuelve su ruta.
    La ruta se inyecta luego en la terminal para que Claude pueda leer la imagen."""
    web_email = _bearer(authorization)
    ext = ALLOWED_IMAGE_EXT.get((file.content_type or "").lower())
    if not ext:
        raise HTTPException(status_code=400, detail="Tipo de imagen no soportado")

    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Imagen demasiado grande (máx 12 MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Imagen vacía")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    _purge_old_uploads()  # limpiar lo viejo en cada subida

    name = f"img-{int(time.time() * 1000)}-{secrets.token_hex(4)}{ext}"
    path = os.path.join(UPLOAD_DIR, name)
    with open(path, "wb") as fh:
        fh.write(data)
    try:
        os.chmod(path, 0o644)  # legible por el usuario SSH (Claude)
    except OSError:
        pass
    log.info("image uploaded web=%s -> %s (%d bytes)", web_email, path, len(data))
    return {"path": path, "name": name}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    global _active
    try:
        web_email = auth.verify_token(websocket.query_params.get("token") or "")
    except HTTPException:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    async with _lock:
        if _active >= MAX_CONNECTIONS:
            log.info("refused email=%s (limit %d)", web_email, MAX_CONNECTIONS)
            await websocket.close(code=1013)
            return
        _active += 1

    term = None
    try:
        first = await websocket.receive_text()
        try:
            data = json.loads(first)
            ssh_user = (data.get("ssh_user") or "").strip()
            ssh_password = data["password"]
        except (ValueError, KeyError, TypeError):
            await websocket.send_text("\r\n[webterminal] mensaje inicial invalido\r\n")
            await websocket.close(code=4400)
            return
        if not ssh_user:
            await websocket.send_text("\r\n[webterminal] falta el usuario SSH\r\n")
            await websocket.close(code=4400)
            return

        term = SSHTerminal(ssh_user, ssh_password, websocket)
        try:
            await term.connect()
        except Exception as exc:  # noqa: BLE001
            log.info("ssh connect failed web=%s ssh_user=%s: %s", web_email, ssh_user, exc)
            try:
                await websocket.send_text(f"\r\n[webterminal] fallo de conexion SSH: {exc}\r\n")
                await websocket.close(code=4500)
            except Exception:
                pass
            return

        log.info("session start web=%s ssh_user=%s active=%d", web_email, ssh_user, _active)
        await term.run()
    except Exception as exc:  # noqa: BLE001
        log.info("ws session error web=%s: %s", web_email, exc)
    finally:
        if term is not None:
            term.close()
        async with _lock:
            _active -= 1
        log.info("session end web=%s active=%d", web_email, _active)


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")
