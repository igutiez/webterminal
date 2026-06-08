"""JWT issuing/verification for WebTerminal.

Passwords and accounts live in db.py (SQLite). The web login username is an email.
The JWT subject is the user's email; it only gates the application, not SSH.
"""
import datetime
import os

from jose import JWTError, jwt

import db


def _load_secret_key() -> str:
    """La clave NUNCA va en el repo. Se lee de la variable de entorno
    WEBTERMINAL_SECRET_KEY o, si no, del archivo (gitignored) backend/secret_key.txt.
    Generarla con:  openssl rand -hex 32  > backend/secret_key.txt"""
    key = os.environ.get("WEBTERMINAL_SECRET_KEY")
    if not key:
        path = os.path.join(os.path.dirname(__file__), "secret_key.txt")
        try:
            with open(path, encoding="utf-8") as fh:
                key = fh.read().strip()
        except FileNotFoundError:
            key = ""
    if not key:
        raise RuntimeError(
            "Falta la SECRET_KEY: define WEBTERMINAL_SECRET_KEY o crea backend/secret_key.txt"
        )
    return key


SECRET_KEY = _load_secret_key()
ALGORITHM = "HS256"
TOKEN_TTL_HOURS = 8


def create_access_token(email: str) -> str:
    now = datetime.datetime.now(datetime.timezone.utc)
    payload = {
        "sub": email.strip().lower(),
        "iat": now,
        "exp": now + datetime.timedelta(hours=TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(token: str) -> str:
    """Return the email in the token or raise HTTPException(401). Must still exist."""
    from fastapi import HTTPException

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    email = payload.get("sub")
    if not email or not db.get_user(email):
        raise HTTPException(status_code=401, detail="Invalid token subject")
    return email
