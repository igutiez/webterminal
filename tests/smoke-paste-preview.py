#!/usr/bin/env python3
"""
Smoke test for the paste-preview toast feature.

Serves the deployed frontend locally, opens it headlessly with Playwright,
mocks the WebSocket so the terminal appears connected, and simulates a paste
event with a small image blob. Verifies that the #paste-preview toast becomes
visible and can be dismissed/replaced.
"""

import http.server
import os
import re
import socketserver
import threading
import time
import sys

from playwright.sync_api import sync_playwright, expect

FRONTEND_DIR = "/opt/webterminal/frontend"
PORT = 8902
BASE_URL = f"http://127.0.0.1:{PORT}"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def log_message(self, format, *args_):
        pass


def start_server():
    socketserver.TCPServer.allow_reuse_address = True
    server = socketserver.TCPServer(("127.0.0.1", PORT), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def stop_server(server):
    server.shutdown()
    server.server_close()


def ws_mock_script():
    return """
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        super();
        this.url = url;
        this.readyState = MockWebSocket.CONNECTING;
        this.bufferedAmount = 0;
        this.binaryType = "blob";
        this._sent = [];
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          if (this.onopen) this.onopen({});
        }, 50);
      }
      send(data) { this._sent.push(data); }
      close(code, reason) { this.readyState = MockWebSocket.CLOSED; if (this.onclose) this.onclose({code, reason}); }
    }
    window.WebSocket = MockWebSocket;
    """


def main():
    server = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 720})
            page = context.new_page()
            page.add_init_script(ws_mock_script())

            page.goto(BASE_URL, wait_until="networkidle")

            # Move to the SSH form without performing real login, then submit it
            # so the app enters the terminal screen and creates a mock-connected ws.
            page.evaluate("""
                document.getElementById('login-screen').style.display = 'none';
                document.getElementById('ssh-screen').style.display = 'flex';
                document.getElementById('ssh-user').value = 'ubuntu';
                document.getElementById('ssh-password').value = '';
                document.getElementById('ssh-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            """)

            # Wait for the terminal screen and the preview element to exist.
            page.wait_for_selector("#terminal-screen", state="visible", timeout=15000)
            preview = page.locator("#paste-preview")
            expect(preview).to_have_attribute("hidden", "")

            # Simulate a paste event with a small PNG image blob.
            page.evaluate("""
                async () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 2; canvas.height = 2;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ff0000';
                    ctx.fillRect(0, 0, 2, 2);
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    const file = new File([blob], 'smoke.png', { type: 'image/png' });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
                    document.dispatchEvent(ev);
                }
            """)

            # The toast should become visible.
            expect(preview).not_to_have_attribute("hidden", "", timeout=5000)
            expect(preview).to_have_class(re.compile(r"open"))
            expect(page.locator("#paste-preview-meta")).to_contain_text("smoke.png")

            # Dismiss with Descartar.
            page.locator("#paste-preview-cancel").click()
            expect(preview).to_have_attribute("hidden", "", timeout=5000)

            # Paste a second image and verify the toast updates.
            page.evaluate("""
                async () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 3; canvas.height = 3;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#00ff00';
                    ctx.fillRect(0, 0, 3, 3);
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                    const file = new File([blob], 'second.png', { type: 'image/png' });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
                }
            """)
            expect(preview).not_to_have_attribute("hidden", "", timeout=5000)
            expect(page.locator("#paste-preview-meta")).to_contain_text("second.png")

            # Close via the X button.
            page.locator("#paste-preview-close").click()
            expect(preview).to_have_attribute("hidden", "", timeout=5000)

            browser.close()
        print("smoke paste-preview: OK")
        return 0
    except Exception as e:
        print(f"smoke paste-preview: FAIL: {e}", file=sys.stderr)
        return 1
    finally:
        stop_server(server)


if __name__ == "__main__":
    sys.exit(main())
