#!/usr/bin/env python3
"""
Smoke test for the paste-preview toast feature.

Serves the deployed frontend locally, opens it headlessly with Playwright,
stubs the login endpoint, mocks the WebSocket so the terminal appears connected,
and simulates paste events with small image blobs. Verifies that the
#paste-preview toast appears, can be dismissed/replaced, uploads successfully,
retries on error, and closes with Escape or an outside click.
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


def paste_image(page, name, color, size):
    page.evaluate(
        f"""
        async () => {{
            const canvas = document.createElement('canvas');
            canvas.width = {size}; canvas.height = {size};
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '{color}';
            ctx.fillRect(0, 0, {size}, {size});
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const file = new File([blob], '{name}', {{ type: 'image/png' }});
            const dt = new DataTransfer();
            dt.items.add(file);
            const ev = new ClipboardEvent('paste', {{ bubbles: true, cancelable: true, clipboardData: dt }});
            document.dispatchEvent(ev);
        }}
        """
    )


def main():
    server = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 720})
            page = context.new_page()
            page.add_init_script(ws_mock_script())

            # Stub login so uploadFile receives a JWT.
            page.route(
                "**/login",
                lambda route: route.fulfill(
                    status=200,
                    content_type="application/json",
                    body='{"token":"smoke-token"}',
                ),
            )

            page.goto(BASE_URL, wait_until="networkidle")

            # Log in and connect to a mock terminal session.
            page.locator("#login-email").fill("smoke@example.com")
            page.locator("#login-password").fill("smoke")
            page.locator("#login-form").dispatch_event("submit")
            page.wait_for_selector("#ssh-screen", state="visible", timeout=10000)

            page.locator("#ssh-user").fill("ubuntu")
            page.locator("#ssh-password").fill("")
            page.locator("#ssh-form").dispatch_event("submit")
            page.wait_for_selector("#terminal-screen", state="visible", timeout=15000)
            expect(page.locator("#status-text")).to_contain_text("conectado", timeout=10000)

            preview = page.locator("#paste-preview")
            expect(preview).to_have_attribute("hidden", "")

            # 1. Paste an image -> toast appears with metadata.
            paste_image(page, "smoke.png", "#ff0000", 2)
            expect(preview).not_to_have_attribute("hidden", "", timeout=5000)
            expect(preview).to_have_class(re.compile(r"open"))
            expect(page.locator("#paste-preview-meta")).to_contain_text("smoke.png")

            # 2. Dismiss with Descartar.
            page.locator("#paste-preview-cancel").click()
            expect(preview).to_have_attribute("hidden", "", timeout=5000)

            # 3. Paste a second image and verify the toast updates.
            paste_image(page, "second.png", "#00ff00", 3)
            expect(preview).not_to_have_attribute("hidden", "", timeout=5000)
            expect(page.locator("#paste-preview-meta")).to_contain_text("second.png")

            # 4. Close via the X button.
            page.locator("#paste-preview-close").click()
            expect(preview).to_have_attribute("hidden", "", timeout=5000)

            # 5. Upload success -> toast hides.
            upload_responses = []

            def handle_upload(route):
                if upload_responses:
                    resp = upload_responses.pop(0)
                    route.fulfill(
                        status=resp["status"],
                        content_type="application/json",
                        body=resp["body"],
                    )
                else:
                    route.fulfill(status=500, body="unexpected /upload call")

            page.route("**/upload", handle_upload)

            paste_image(page, "upload.png", "#0000ff", 4)
            expect(preview).not_to_have_attribute("hidden", "", timeout=5000)
            upload_responses.append(
                {
                    "status": 200,
                    "body": '{"path":"/tmp/upload.png","name":"upload.png","root":"/tmp"}',
                }
            )
            page.locator("#paste-preview-upload").click()
            expect(preview).to_have_attribute("hidden", "", timeout=5000)

            # 6. Upload error -> status shows backend message and button becomes Reintentar.
            paste_image(page, "retry.png", "#ff00ff", 5)
            expect(preview).not_to_have_attribute("hidden", "", timeout=5000)
            upload_responses.extend(
                [
                    {
                        "status": 500,
                        "body": '{"detail":"Mock upload failure"}',
                    },
                    {
                        "status": 200,
                        "body": '{"path":"/tmp/retry.png","name":"retry.png","root":"/tmp"}',
                    },
                ]
            )
            page.locator("#paste-preview-upload").click()
            expect(page.locator("#paste-preview-status")).to_contain_text(
                "Mock upload failure", timeout=5000
            )
            expect(page.locator("#paste-preview-upload")).to_have_text("Reintentar")

            # Retry and succeed -> toast hides.
            page.locator("#paste-preview-upload").click()
            expect(preview).to_have_attribute("hidden", "", timeout=5000)

            page.unroute("**/upload", handle_upload)

            # 7. Escape closes the toast.
            paste_image(page, "escape.png", "#ffff00", 2)
            expect(preview).not_to_have_attribute("hidden", "", timeout=5000)
            page.keyboard.press("Escape")
            expect(preview).to_have_attribute("hidden", "", timeout=5000)

            # 8. Click outside the toast closes it.
            paste_image(page, "outside.png", "#00ffff", 2)
            expect(preview).not_to_have_attribute("hidden", "", timeout=5000)
            page.locator("#terminal-container").click()
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
