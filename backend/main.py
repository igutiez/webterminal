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
import glob
import json
import logging
import math
import os
import posixpath
import re
import secrets
import shutil
import stat as stat_mod
import subprocess
import tempfile
from urllib.parse import quote

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import auth
import db
import email_service
from terminal import SSHTerminal

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("webterminal")

FRONTEND_DIR = os.environ.get("WEBTERMINAL_FRONTEND", "/opt/webterminal/frontend")
PUBLIC_URL = os.environ.get("WEBTERMINAL_URL", "https://terminal.vistawib.com")
MAX_CONNECTIONS = int(os.environ.get("WEBTERMINAL_MAX_CONNECTIONS", "5"))
RESET_TTL_MIN = 30
MIN_PW_LEN = 8

# Subida de archivos (cualquier tipo) para que Claude (en la sesión SSH) pueda
# abrirlos. El archivo se guarda aquí y la RUTA se inyecta en la terminal.
# Limpieza: un cron borra el contenido cada noche a las 00:00 (ver README/setup).
UPLOAD_DIR = os.environ.get("WEBTERMINAL_UPLOAD_DIR", "/home/ubuntu/imagenes_temp")
MAX_UPLOAD_BYTES = int(os.environ.get("WEBTERMINAL_MAX_UPLOAD_MB", "100")) * 1024 * 1024

db.init_db()

app = FastAPI(title="WebTerminal")
_active = 0
_lock = asyncio.Lock()

# Registro de sesiones para el explorador de archivos: fsid -> SSHTerminal vivo.
# El explorador reutiliza la conexión SSH ya autenticada (SFTP), así tiene los
# mismos permisos que la terminal. Solo funciona mientras la terminal está abierta.
_fs_sessions: dict = {}


def _resolve_term(fsid: str, web_email: str):
    term = _fs_sessions.get(fsid or "")
    if term is None or getattr(term, "web_email", None) != web_email:
        raise HTTPException(status_code=403, detail="Sesión de archivos no válida o caducada")
    return term


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


def _safe_filename(name: str) -> str:
    """Nombre de archivo seguro: sin rutas ni caracteres raros, conserva extensión."""
    name = os.path.basename((name or "").strip())
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).lstrip(".")
    return name[:120] or "archivo"


def _unique_path(directory: str, name: str) -> str:
    """Evita pisar archivos: añade -1, -2… antes de la extensión si ya existe."""
    base, ext = os.path.splitext(name)
    candidate = os.path.join(directory, name)
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{base}-{i}{ext}")
        i += 1
    return candidate


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


@app.post("/upload")
async def upload_file(
    authorization: str | None = Header(default=None),
    file: UploadFile = File(...),
):
    """Recibe un archivo de CUALQUIER tipo (autenticado), lo guarda en UPLOAD_DIR
    y devuelve su ruta. La ruta se inyecta en la terminal para que Claude lo abra.
    El contenido se borra entero cada noche a las 00:00 (cron)."""
    web_email = _bearer(authorization)

    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        mb = MAX_UPLOAD_BYTES // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"Archivo demasiado grande (máx {mb} MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Archivo vacío")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = _unique_path(UPLOAD_DIR, _safe_filename(file.filename))
    with open(path, "wb") as fh:
        fh.write(data)
    try:
        os.chmod(path, 0o644)  # legible por el usuario SSH (Claude)
    except OSError:
        pass
    log.info("file uploaded web=%s -> %s (%d bytes)", web_email, path, len(data))
    return {"path": path, "name": os.path.basename(path)}


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
    fsid = None
    try:
        first = await websocket.receive_text()
        try:
            data = json.loads(first)
            ssh_user = (data.get("ssh_user") or "").strip()
            # Contraseña OPCIONAL: si va vacía, el backend entra por clave SSH
            # (la barrera real es el cert mTLS + el login web).
            ssh_password = data.get("password") or ""
            session_label = data.get("session")  # opcional: qué sesión tmux abrir
        except (ValueError, KeyError, TypeError):
            await websocket.send_text("\r\n[webterminal] mensaje inicial invalido\r\n")
            await websocket.close(code=4400)
            return
        if not ssh_user:
            await websocket.send_text("\r\n[webterminal] falta el usuario SSH\r\n")
            await websocket.close(code=4400)
            return

        term = SSHTerminal(ssh_user, ssh_password, websocket,
                           web_email=web_email, session_label=session_label)
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

        # Registrar la sesión para el explorador de archivos y avisar al cliente.
        fsid = secrets.token_urlsafe(16)
        _fs_sessions[fsid] = term
        try:
            await websocket.send_text(json.dumps({"type": "fsid", "fsid": fsid}))
        except Exception:
            pass

        log.info("session start web=%s ssh_user=%s active=%d", web_email, ssh_user, _active)
        await term.run()
    except Exception as exc:  # noqa: BLE001
        log.info("ws session error web=%s: %s", web_email, exc)
    finally:
        if fsid is not None:
            _fs_sessions.pop(fsid, None)
        if term is not None:
            term.close()
        async with _lock:
            _active -= 1
        log.info("session end web=%s active=%d", web_email, _active)


# ============================== GRABACIÓN DE PANTALLA ==============================
# El navegador graba un vídeo (webm) de la pantalla compartida y lo sube aquí.
# Con ffmpeg sacamos fotogramas repartidos en el tiempo y los montamos en una sola
# imagen en rejilla (para que Claude "vea" la secuencia). Se guarda también el webm.

def _ffprobe_duration(path: str) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path],
            capture_output=True, timeout=20,
        )
        d = json.loads(out.stdout or b"{}")
        return float(d.get("format", {}).get("duration") or 0)
    except Exception:
        return 0.0


def _make_montage(webm_bytes: bytes) -> dict:
    tmp = tempfile.mkdtemp(prefix="cast_")
    try:
        inp = os.path.join(tmp, "in.webm")
        with open(inp, "wb") as f:
            f.write(webm_bytes)
        dur = _ffprobe_duration(inp)
        target = max(4, min(16, round(dur))) if dur > 0 else 8   # ~1 fotograma/seg, 4-16
        fps = (target / dur) if dur > 0 else 1.0
        fps = max(0.2, min(4.0, fps))
        fdir = os.path.join(tmp, "f"); os.makedirs(fdir)
        subprocess.run(
            ["ffmpeg", "-y", "-i", inp, "-vf", f"fps={fps:.4f},scale=760:-1:flags=lanczos",
             os.path.join(fdir, "f_%03d.png")],
            capture_output=True, timeout=120,
        )
        frames = sorted(glob.glob(os.path.join(fdir, "f_*.png")))
        if not frames:
            raise RuntimeError("ffmpeg no extrajo fotogramas")
        n = len(frames)
        cols = min(4, n); rows = math.ceil(n / cols)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        out = _unique_path(UPLOAD_DIR, "secuencia.png")
        subprocess.run(
            ["ffmpeg", "-y", "-framerate", "1", "-i", os.path.join(fdir, "f_%03d.png"),
             "-vf", f"tile={cols}x{rows}:padding=6:margin=6:color=0x0d0d1a", "-frames:v", "1", out],
            capture_output=True, timeout=120,
        )
        if not os.path.exists(out):
            raise RuntimeError("ffmpeg no generó el montaje")
        try: os.chmod(out, 0o644)
        except OSError: pass
        webm_out = _unique_path(UPLOAD_DIR, "grabacion.webm")
        shutil.move(inp, webm_out)
        try: os.chmod(webm_out, 0o644)
        except OSError: pass
        return {"path": out, "name": os.path.basename(out), "frames": n, "webm": webm_out}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/screencast")
async def screencast(
    authorization: str | None = Header(default=None),
    file: UploadFile = File(...),
):
    web_email = _bearer(authorization)
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        mb = MAX_UPLOAD_BYTES // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"Vídeo demasiado grande (máx {mb} MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Vídeo vacío")
    try:
        res = await asyncio.to_thread(_make_montage, data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"No se pudo procesar el vídeo: {exc}")
    log.info("screencast web=%s -> %s (%d frames, webm=%s)", web_email, res["path"], res["frames"], res["webm"])
    return {"path": res["path"], "name": res["name"], "frames": res["frames"], "webm": res["webm"]}


# ============================== EXPLORADOR DE ARCHIVOS ==============================
# Todo va por SFTP sobre la sesión SSH viva (mismos permisos que la terminal).
# paramiko SFTPClient no es thread-safe -> un canal por operación, cerrado al acabar.

def _entry(attr, name=None):
    is_dir = stat_mod.S_ISDIR(attr.st_mode)
    is_link = stat_mod.S_ISLNK(attr.st_mode)
    return {
        "name": name if name is not None else attr.filename,
        "dir": is_dir,
        "link": is_link,
        "size": int(getattr(attr, "st_size", 0) or 0),
        "mtime": int(getattr(attr, "st_mtime", 0) or 0),
    }


def _fs_list(term, path):
    sftp = term.open_sftp()
    try:
        path = sftp.normalize(path or ".")  # "." => home del usuario SSH
        entries = sftp.listdir_attr(path)
        items = [_entry(e) for e in entries if not e.filename.startswith(".") or True]
        # Para los enlaces, intentar saber si apuntan a carpeta
        for it, e in zip(items, entries):
            if it["link"]:
                try:
                    it["dir"] = stat_mod.S_ISDIR(sftp.stat(posixpath.join(path, e.filename)).st_mode)
                except Exception:
                    pass
        items.sort(key=lambda x: (not x["dir"], x["name"].lower()))
        parent = posixpath.dirname(path.rstrip("/")) or "/"
        return {"path": path, "parent": parent, "items": items}
    finally:
        sftp.close()


@app.get("/files/list")
async def files_list(fsid: str, path: str = "", authorization: str | None = Header(default=None)):
    web_email = _bearer(authorization)
    term = _resolve_term(fsid, web_email)
    try:
        return await asyncio.to_thread(_fs_list, term, path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="No existe esa carpeta")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Sin permiso para esa carpeta")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"No se pudo listar: {exc}")


@app.get("/files/download")
async def files_download(fsid: str, path: str, token: str = ""):
    # El token va por query para poder descargar en streaming directo en el navegador.
    web_email = auth.verify_token(token)
    term = _resolve_term(fsid, web_email)
    sftp = term.open_sftp()
    try:
        st = sftp.stat(path)
    except Exception:
        sftp.close()
        raise HTTPException(status_code=404, detail="No existe el archivo")
    if stat_mod.S_ISDIR(st.st_mode):
        sftp.close()
        raise HTTPException(status_code=400, detail="Es una carpeta, no un archivo")
    try:
        fh = sftp.open(path, "rb")
        fh.prefetch(st.st_size)
    except Exception as exc:  # noqa: BLE001
        sftp.close()
        raise HTTPException(status_code=400, detail=f"No se pudo abrir: {exc}")

    def gen():
        try:
            while True:
                chunk = fh.read(262144)  # 256 KB
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                fh.close()
            finally:
                sftp.close()

    name = posixpath.basename(path) or "archivo"
    ascii_name = name.encode("ascii", "ignore").decode() or "archivo"
    disp = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"
    return StreamingResponse(gen(), media_type="application/octet-stream",
                             headers={"Content-Disposition": disp, "Content-Length": str(st.st_size)})


def _fs_put(term, fileobj, remote):
    sftp = term.open_sftp()
    try:
        sftp.putfo(fileobj, remote)
    finally:
        sftp.close()


@app.post("/files/upload")
async def files_upload(
    fsid: str = Form(...),
    dir: str = Form(...),
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
):
    web_email = _bearer(authorization)
    term = _resolve_term(fsid, web_email)
    name = _safe_filename(file.filename)
    remote = posixpath.join(dir, name)
    try:
        file.file.seek(0)
        await asyncio.to_thread(_fs_put, term, file.file, remote)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"No se pudo subir: {exc}")
    log.info("sftp upload web=%s -> %s", web_email, remote)
    return {"ok": True, "name": name, "path": remote}


def _fs_mkdir(term, path):
    sftp = term.open_sftp()
    try:
        sftp.mkdir(path)
    finally:
        sftp.close()


@app.post("/files/mkdir")
async def files_mkdir(
    fsid: str = Form(...),
    dir: str = Form(...),
    name: str = Form(...),
    authorization: str | None = Header(default=None),
):
    web_email = _bearer(authorization)
    term = _resolve_term(fsid, web_email)
    clean = _safe_filename(name)
    target = posixpath.join(dir, clean)
    try:
        await asyncio.to_thread(_fs_mkdir, term, target)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"No se pudo crear la carpeta: {exc}")
    return {"ok": True, "path": target}


def _fs_delete(term, path):
    sftp = term.open_sftp()
    try:
        st = sftp.stat(path)
        if stat_mod.S_ISDIR(st.st_mode):
            _rmtree(sftp, path)
        else:
            sftp.remove(path)
    finally:
        sftp.close()


def _rmtree(sftp, path):
    for e in sftp.listdir_attr(path):
        child = posixpath.join(path, e.filename)
        if stat_mod.S_ISDIR(e.st_mode):
            _rmtree(sftp, child)
        else:
            sftp.remove(child)
    sftp.rmdir(path)


@app.post("/files/delete")
async def files_delete(
    fsid: str = Form(...),
    path: str = Form(...),
    authorization: str | None = Header(default=None),
):
    web_email = _bearer(authorization)
    term = _resolve_term(fsid, web_email)
    if path in ("/", "", "."):
        raise HTTPException(status_code=400, detail="Ruta no permitida")
    try:
        await asyncio.to_thread(_fs_delete, term, path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"No se pudo borrar: {exc}")
    log.info("sftp delete web=%s -> %s", web_email, path)
    return {"ok": True}


def _fs_rename(term, src, dst):
    sftp = term.open_sftp()
    try:
        try:
            sftp.posix_rename(src, dst)
        except Exception:
            sftp.rename(src, dst)
    finally:
        sftp.close()


@app.post("/files/rename")
async def files_rename(
    fsid: str = Form(...),
    src: str = Form(...),
    dst: str = Form(...),
    authorization: str | None = Header(default=None),
):
    web_email = _bearer(authorization)
    term = _resolve_term(fsid, web_email)
    try:
        await asyncio.to_thread(_fs_rename, term, src, dst)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"No se pudo renombrar/mover: {exc}")
    return {"ok": True, "path": dst}


@app.get("/manifest.webmanifest", include_in_schema=False)
async def manifest():
    return FileResponse(
        os.path.join(FRONTEND_DIR, "manifest.webmanifest"),
        media_type="application/manifest+json",
    )


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")
