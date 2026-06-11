"""SQLite user store for WebTerminal.

Holds web-login accounts (email + bcrypt password) and password-reset tokens.
The SSH identity is NOT stored here: the system user + password are entered at
terminal-open time. Web login is only the application gate.
"""
import hashlib
import json
import os
import sqlite3
import time

import bcrypt

DB_PATH = os.environ.get("WEBTERMINAL_DB", "/opt/webterminal/webterminal.db")


def _conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    with _conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                email          TEXT PRIMARY KEY,
                password_hash  TEXT NOT NULL,
                created_at     INTEGER NOT NULL,
                reset_hash     TEXT,
                reset_expires  INTEGER
            )
            """
        )
        # Migración: preferencia de tema (look&feel) por usuario. SQLite no admite
        # "ADD COLUMN IF NOT EXISTS", así que comprobamos primero la lista de columnas.
        cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
        if "theme" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN theme TEXT")
        # Alias humanos para hosts remotos: JSON {hostname: "nombre amigable"}.
        if "host_aliases" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN host_aliases TEXT")
        # Alias humanos para sesiones/pestañas: JSON {etiqueta_tmux: "nombre"}.
        if "session_aliases" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN session_aliases TEXT")


def get_theme(email: str):
    """Devuelve el id de tema guardado del usuario, o None si no ha elegido."""
    u = get_user(email)
    return (u or {}).get("theme") or None


def set_theme(email: str, theme: str) -> bool:
    email = (email or "").strip().lower()
    with _conn() as c:
        cur = c.execute("UPDATE users SET theme = ? WHERE email = ?", (theme, email))
        return cur.rowcount == 1


def get_aliases(email: str) -> dict:
    """Mapa {hostname: nombre amigable} del usuario (vacío si no tiene)."""
    raw = (get_user(email) or {}).get("host_aliases")
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except (ValueError, TypeError):
        return {}


def set_alias(email: str, host: str, name: str) -> bool:
    """Pone (o borra, si name vacío) el alias de un host. Devuelve True si se guardó."""
    email = (email or "").strip().lower()
    host = (host or "").strip()
    name = (name or "").strip()
    if not host:
        return False
    with _conn() as c:
        row = c.execute("SELECT host_aliases FROM users WHERE email = ?", (email,)).fetchone()
        if row is None:
            return False
        try:
            d = json.loads(row["host_aliases"]) if row["host_aliases"] else {}
            if not isinstance(d, dict):
                d = {}
        except (ValueError, TypeError):
            d = {}
        if name:
            if len(d) >= 200 and host not in d:
                return False   # tope defensivo
            d[host] = name
        else:
            d.pop(host, None)
        c.execute("UPDATE users SET host_aliases = ? WHERE email = ?", (json.dumps(d), email))
        return True


def get_session_aliases(email: str) -> dict:
    """Mapa {etiqueta_tmux: nombre amigable} de las pestañas/sesiones del usuario."""
    raw = (get_user(email) or {}).get("session_aliases")
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except (ValueError, TypeError):
        return {}


def set_session_alias(email: str, label: str, name: str) -> bool:
    """Pone (o borra, si name vacío) el alias de una sesión/pestaña."""
    email = (email or "").strip().lower()
    label = (label or "").strip()
    name = (name or "").strip()
    if not label:
        return False
    with _conn() as c:
        row = c.execute("SELECT session_aliases FROM users WHERE email = ?", (email,)).fetchone()
        if row is None:
            return False
        try:
            d = json.loads(row["session_aliases"]) if row["session_aliases"] else {}
            if not isinstance(d, dict):
                d = {}
        except (ValueError, TypeError):
            d = {}
        if name:
            if len(d) >= 200 and label not in d:
                return False
            d[label] = name
        else:
            d.pop(label, None)
        c.execute("UPDATE users SET session_aliases = ? WHERE email = ?", (json.dumps(d), email))
        return True


def _hash_pw(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def get_user(email: str):
    email = (email or "").strip().lower()
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None


def list_emails():
    with _conn() as c:
        return [r["email"] for r in c.execute("SELECT email FROM users ORDER BY email")]


def create_or_update_user(email: str, password: str):
    """Create the user if missing, otherwise reset its password. Used by seeding."""
    email = email.strip().lower()
    with _conn() as c:
        c.execute(
            """
            INSERT INTO users (email, password_hash, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash
            """,
            (email, _hash_pw(password), int(time.time())),
        )


def verify_password(email: str, password: str) -> bool:
    u = get_user(email)
    if not u:
        return False
    try:
        return bcrypt.checkpw(password.encode(), u["password_hash"].encode())
    except ValueError:
        return False


def set_password(email: str, new_password: str) -> bool:
    email = email.strip().lower()
    with _conn() as c:
        cur = c.execute(
            "UPDATE users SET password_hash = ?, reset_hash = NULL, reset_expires = NULL WHERE email = ?",
            (_hash_pw(new_password), email),
        )
        return cur.rowcount == 1


def change_email(old_email: str, new_email: str) -> bool:
    old_email = old_email.strip().lower()
    new_email = new_email.strip().lower()
    with _conn() as c:
        if c.execute("SELECT 1 FROM users WHERE email = ?", (new_email,)).fetchone():
            return False  # already taken
        cur = c.execute("UPDATE users SET email = ? WHERE email = ?", (new_email, old_email))
        return cur.rowcount == 1


# ---- password-reset tokens -------------------------------------------------
def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def store_reset_token(email: str, token: str, ttl_seconds: int) -> bool:
    email = email.strip().lower()
    with _conn() as c:
        cur = c.execute(
            "UPDATE users SET reset_hash = ?, reset_expires = ? WHERE email = ?",
            (_token_hash(token), int(time.time()) + ttl_seconds, email),
        )
        return cur.rowcount == 1


def consume_reset_token(token: str):
    """Return the email for a valid, unexpired token (cleared later by set_password)."""
    th = _token_hash(token)
    now = int(time.time())
    with _conn() as c:
        row = c.execute(
            "SELECT email FROM users WHERE reset_hash = ? AND reset_expires >= ?",
            (th, now),
        ).fetchone()
        return row["email"] if row else None
