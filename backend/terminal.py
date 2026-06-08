"""SSHTerminal: bridge a FastAPI WebSocket to a paramiko interactive SSH shell.

This server runs sshd on port 20776 (not 22), so we connect to localhost:20776.
paramiko authenticates with the *system* username+password of the logged-in user;
the process owner (www-data) is irrelevant to SSH authentication.
"""
import asyncio
import json
import logging

import paramiko

log = logging.getLogger("webterminal.terminal")

SSH_HOST = "127.0.0.1"
SSH_PORT = 20776          # this host's sshd listens on 20776, not 22
TERM_TYPE = "xterm-256color"
DEFAULT_COLS = 220
DEFAULT_ROWS = 50
RECV_CHUNK = 1024


class SSHTerminal:
    """One WebSocket <-> one SSH shell. Call ``connect()`` then ``run()``."""

    def __init__(self, username: str, password: str, websocket):
        self.username = username
        self.password = password
        self.websocket = websocket
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
        chan = client.invoke_shell(term=TERM_TYPE, width=DEFAULT_COLS, height=DEFAULT_ROWS)
        chan.settimeout(None)
        self.client = client
        self.chan = chan
        log.info("SSH shell opened for %s@%s:%s", self.username, SSH_HOST, SSH_PORT)

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
