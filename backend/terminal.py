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

log = logging.getLogger("messorterminal.terminal")

SSH_HOST = os.environ.get("WEBTERMINAL_SSH_HOST", "127.0.0.1")
SSH_PORT = int(os.environ.get("WEBTERMINAL_SSH_PORT", "22"))   # p. ej. 20776 si tu sshd no escucha en 22
# El acceso a la terminal es SIEMPRE con la contraseña del sistema del usuario.
# (La barrera externa sigue siendo el cert mTLS + el login web de Cloudflare.)
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

# "Equipación B": detectamos automáticamente si el panel activo está corriendo un
# cliente de acceso remoto (has hecho `ssh` a otra máquina). El comando en primer
# plano del panel (#{pane_current_command}) lo dice sin depender de prompts/títulos.
REMOTE_CMDS = {"ssh", "mosh", "mosh-client", "sshpass", "autossh", "et", "telnet"}
REMOTE_POLL_SECS = 1.5


def _host_from_title(title: str):
    """Saca el hostname del título de un panel: 'user@host: ~' -> host, o el propio
    título si ya es un hostname pelado (p. ej. 'vps-17a4c3ba'). None si no encaja."""
    title = (title or "").strip()
    if not title:
        return None
    m = re.search(r"@([A-Za-z0-9][A-Za-z0-9._-]*)", title)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{1,63}", title):
        return title
    return None


def _slug(s: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", (s or "").lower()).strip("_")


def _user_prefix(web_email: str | None) -> str:
    """Prefijo común de TODAS las sesiones de un usuario web (su email)."""
    slug = _slug(web_email)
    return f"{TMUX_PREFIX}-{slug}" if slug else TMUX_PREFIX


# Etiqueta visible para la sesión por defecto (la del nombre = prefijo, sin sufijo).
DEFAULT_LABEL = "principal"


def _session_name(web_email: str | None, label: str | None = None) -> str:
    """Nombre real de la sesión tmux. Sin label (o 'principal') => sesión por
    defecto del usuario; con label => '<prefijo>-<label saneado>'. Un usuario solo
    puede nombrar sesiones dentro de SU prefijo (no puede tocar las de otros)."""
    prefix = _user_prefix(web_email)
    lab = _slug(label)
    if not lab or lab == DEFAULT_LABEL:
        return prefix
    return f"{prefix}-{lab}"


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

    def __init__(self, username: str, password: str, websocket,
                 web_email: str | None = None, session_label: str | None = None):
        self.username = username
        self.password = password
        self.websocket = websocket
        self.web_email = web_email
        self.prefix = _user_prefix(web_email)
        self.session = _session_name(web_email, session_label)
        self.client = None
        self.chan = None
        self._closed = False

    async def connect(self) -> None:
        """Open SSH + interactive shell (blocking paramiko runs in a worker thread)."""
        await asyncio.to_thread(self._connect_blocking)

    def _connect_blocking(self) -> None:
        # Siempre por contraseña del sistema. Si falta, error claro (no se intenta
        # conexión). Tras varios fallos, main.py bloquea esa identidad un rato.
        if not self.password:
            raise ValueError("falta la contraseña del sistema")
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(hostname=SSH_HOST, port=SSH_PORT, username=self.username,
                       password=self.password, look_for_keys=False, allow_agent=False,
                       timeout=10)
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
        tasks = {t_out, t_in}
        if TMUX_ENABLED:
            tasks.add(asyncio.create_task(self._remote_watch()))
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self.close()

    # ---- "Equipación B": vigila qué sesiones están en un server remoto ----
    async def _remote_watch(self) -> None:
        """Sondea tmux cada ~1,5 s y avisa al cliente cuando algo cambia, con UNA
        sola consulta a tmux por tick (list-sessions trae el comando de cada panel):
        - {type:"remote"}        -> estado de la sesión ACTIVA (tinte del terminal).
        - {type:"tmux-sessions"} -> lista con flag remote por sesión (tinte de pestañas).
        El primer envío es inmediato (al conectar) para no dejar estado viejo."""
        last_active = None
        last_sig = None
        try:
            while not self._closed:
                sessions = await asyncio.to_thread(self._list_sessions)
                active = next((s for s in sessions if s.get("current")), None)
                astate = (bool(active and active.get("remote")),
                          active.get("host") if active else None)
                if astate != last_active:
                    last_active = astate
                    try:
                        await self.websocket.send_text(json.dumps(
                            {"type": "remote", "on": astate[0], "host": astate[1]}))
                    except Exception:
                        break
                sig = [(s["label"], s["current"], s["remote"], s["host"]) for s in sessions]
                if sig != last_sig:
                    last_sig = sig
                    try:
                        await self.websocket.send_text(json.dumps(
                            {"type": "tmux-sessions", "sessions": sessions}))
                    except Exception:
                        break
                await asyncio.sleep(REMOTE_POLL_SECS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.info("remote-watch ended for %s: %s", self.username, exc)

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
                    if await self._maybe_control(text):
                        continue
                    await asyncio.to_thread(self.chan.send, text.encode())
                elif raw is not None:
                    await asyncio.to_thread(self.chan.send, raw)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.info("ws->ssh ended for %s: %s", self.username, exc)

    async def _maybe_control(self, text: str) -> bool:
        """Consume mensajes JSON de control (resize, gestión de sesiones tmux).
        Devuelve True si el mensaje era de control (y no debe ir al PTY)."""
        try:
            obj = json.loads(text)
        except (ValueError, TypeError):
            return False
        if not isinstance(obj, dict):
            return False
        t = obj.get("type")
        if t == "resize":
            try:
                self.chan.resize_pty(width=int(obj["cols"]), height=int(obj["rows"]))
            except (KeyError, ValueError, TypeError):
                pass
            return True
        if t == "tmux-list":
            await self._send_session_list()
            return True
        if t == "tmux-kill":
            await asyncio.to_thread(self._kill_session, obj.get("label"))
            await self._send_session_list()
            return True
        return False

    # ---- gestión de sesiones tmux DEL USUARIO (vía exec sobre su propio SSH) ----
    def _tmux(self, *args: str) -> str:
        """Ejecuta `tmux <args>` como el usuario SSH y devuelve su stdout."""
        cmd = "tmux " + " ".join(shlex.quote(a) for a in args)
        _in, out, _err = self.client.exec_command(cmd, timeout=5)
        return out.read().decode("utf-8", "replace")

    def _list_sessions(self) -> list:
        """Lista SOLO las sesiones de este usuario (por prefijo), cada una con su
        estado remoto (¿el panel activo corre ssh/mosh/…?) en UNA sola consulta a
        tmux. El separador '|' es seguro: los nombres van slugados y el comando no
        lo contiene; el título (que sí podría) va el último y no se re-parte."""
        try:
            raw = self._tmux("list-sessions", "-F",
                             "#{session_name}|#{pane_current_command}|#{pane_title}")
        except Exception:
            return []
        out = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            parts = line.split("|", 2)
            name = parts[0].strip()
            cmd = parts[1].strip().lower() if len(parts) > 1 else ""
            title = parts[2] if len(parts) > 2 else ""
            if name == self.prefix:
                label = DEFAULT_LABEL
            elif name.startswith(self.prefix + "-"):
                label = name[len(self.prefix) + 1:]
            else:
                continue  # sesión de OTRO usuario: no se lista ni se toca
            remote = cmd in REMOTE_CMDS
            out.append({
                "label": label,
                "current": name == self.session,
                "remote": remote,
                "host": _host_from_title(title) if remote else None,
            })
        return out

    def _kill_session(self, label) -> None:
        """Mata una sesión del usuario. Valida que esté dentro de su prefijo."""
        name = _session_name(self.web_email, label if isinstance(label, str) else None)
        if name != self.prefix and not name.startswith(self.prefix + "-"):
            return  # seguridad: nunca fuera del prefijo del usuario
        try:
            self._tmux("kill-session", "-t", name)
        except Exception:
            pass

    async def _send_session_list(self) -> None:
        sessions = await asyncio.to_thread(self._list_sessions)
        try:
            await self.websocket.send_text(json.dumps({"type": "tmux-sessions", "sessions": sessions}))
        except Exception:
            pass

    def open_sftp(self):
        """Abre un canal SFTP nuevo sobre la MISMA conexión SSH (mismos permisos
        que la terminal). El llamante debe cerrarlo. paramiko SFTPClient no es
        thread-safe, por eso se usa uno por operación en vez de compartirlo."""
        return self.client.open_sftp()

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
