"""SSHTerminal: bridge a FastAPI WebSocket to a paramiko interactive SSH shell.

This server runs sshd on port 20776 (not 22), so we connect to localhost:20776.
paramiko authenticates with the *system* username+password of the logged-in user;
the process owner (www-data) is irrelevant to SSH authentication.
"""
import asyncio
import json
import logging
import os
import re
import shlex

import paramiko

log = logging.getLogger("webterminal.terminal")

SSH_HOST = "127.0.0.1"
SSH_PORT = 20776          # this host's sshd listens on 20776, not 22
TERM_TYPE = "xterm-256color"
DEFAULT_COLS = 220
DEFAULT_ROWS = 50
RECV_CHUNK = 1024

# --- Sesión persistente con tmux ---
# Si está activado (por defecto), en vez de un shell suelto arrancamos dentro de
# tmux con `new-session -A -s <sesión>`: crea la sesión si no existe y se "engancha"
# a ella si ya existía. Así, si se cae el wifi o se bloquea el móvil, la sesión sigue
# viva en el servidor y al reconectar continúas justo donde lo dejaste.
# Si tmux no estuviera instalado, cae a un shell de login normal (sin persistencia).
#
# La sesión se nombra POR USUARIO WEB (su email): cada persona tiene SU propia
# sesión, así no comparten pantalla. (Ojo: todos corren como el mismo usuario del
# sistema, p.ej. `ubuntu`, así que esto separa sesiones, NO es aislamiento de SO.)
TMUX_ENABLED = os.environ.get("WEBTERMINAL_TMUX", "1").lower() not in ("0", "false", "no", "")
TMUX_PREFIX = os.environ.get("WEBTERMINAL_TMUX_SESSION", "web")


def _session_name(web_email: str | None) -> str:
    """Nombre de sesión tmux seguro y único por usuario web (email)."""
    slug = re.sub(r"[^A-Za-z0-9]+", "_", (web_email or "").lower()).strip("_")
    return f"{TMUX_PREFIX}-{slug}" if slug else TMUX_PREFIX


def _startup_command(session: str) -> str | None:
    """Comando a ejecutar tras abrir el canal. None => shell interactivo normal."""
    if not TMUX_ENABLED:
        return None
    sess = shlex.quote(session)
    # `exec` reemplaza el shell para que, al salir de tmux/del shell, el canal SSH
    # se cierre limpiamente. Si no hay tmux, abre un shell de login normal.
    return (
        f"command -v tmux >/dev/null 2>&1 && "
        f"exec tmux new-session -A -s {sess} || exec ${{SHELL:-/bin/bash}} -l"
    )


class SSHTerminal:
    """One WebSocket <-> one SSH shell. Call ``connect()`` then ``run()``."""

    def __init__(self, username: str, password: str, websocket, web_email: str | None = None):
        self.username = username
        self.password = password
        self.websocket = websocket
        self.session = _session_name(web_email)
        self.client = None
        self.chan = None
        self._closed = False

    async def connect(self) -> None:
        """Open SSH + interactive shell (blocking paramiko runs in a worker thread)."""
        await asyncio.to_thread(self._connect_blocking)

    def _connect_blocking(self) -> None:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            SSH_HOST,
            port=SSH_PORT,
            username=self.username,
            password=self.password,
            look_for_keys=False,
            allow_agent=False,
            timeout=10,
        )
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(30)  # mantiene vivo el túnel ante NAT/idle

        start_cmd = _startup_command(self.session)
        if start_cmd:
            # Canal con pty que ejecuta directamente tmux (sin shell envolvente
            # visible). Si tmux falta, el propio comando abre un shell de login.
            chan = transport.open_session()
            chan.get_pty(term=TERM_TYPE, width=DEFAULT_COLS, height=DEFAULT_ROWS)
            chan.exec_command(start_cmd)
            log.info("SSH+tmux shell opened for %s@%s:%s (session=%s)",
                     self.username, SSH_HOST, SSH_PORT, self.session)
        else:
            chan = client.invoke_shell(term=TERM_TYPE, width=DEFAULT_COLS, height=DEFAULT_ROWS)
            log.info("SSH shell opened for %s@%s:%s", self.username, SSH_HOST, SSH_PORT)
        chan.settimeout(None)
        self.client = client
        self.chan = chan

    async def run(self) -> None:
        """Pump both directions until either side ends; then clean up."""
        t_out = asyncio.create_task(self._ssh_to_ws())
        t_in = asyncio.create_task(self._ws_to_ssh())
        done, pending = await asyncio.wait({t_out, t_in}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self.close()

    async def _ssh_to_ws(self) -> None:
        try:
            while True:
                data = await asyncio.to_thread(self._recv)
                if not data:
                    break
                await self.websocket.send_bytes(data)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - log and end the pump cleanly
            log.info("ssh->ws ended for %s: %s", self.username, exc)

    def _recv(self) -> bytes:
        try:
            return self.chan.recv(RECV_CHUNK)
        except Exception:
            return b""

    async def _ws_to_ssh(self) -> None:
        try:
            while True:
                msg = await self.websocket.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                text = msg.get("text")
                raw = msg.get("bytes")
                if text is not None:
                    if self._maybe_resize(text):
                        continue
                    await asyncio.to_thread(self.chan.send, text.encode())
                elif raw is not None:
                    await asyncio.to_thread(self.chan.send, raw)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.info("ws->ssh ended for %s: %s", self.username, exc)

    def _maybe_resize(self, text: str) -> bool:
        """Handle ``{"type":"resize","cols":N,"rows":N}``; return True if consumed."""
        try:
            obj = json.loads(text)
        except (ValueError, TypeError):
            return False
        if isinstance(obj, dict) and obj.get("type") == "resize":
            try:
                self.chan.resize_pty(width=int(obj["cols"]), height=int(obj["rows"]))
            except (KeyError, ValueError, TypeError):
                pass
            return True
        return False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self.chan is not None:
                self.chan.close()
        except Exception:
            pass
        try:
            if self.client is not None:
                self.client.close()
        except Exception:
            pass
        log.info("SSH terminal closed for %s", self.username)
