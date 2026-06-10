"""Verificación visual de MessorTerminal: login + pantalla de terminal simulada."""
import http.server, threading, functools, time
from playwright.sync_api import sync_playwright

ROOT = "/opt/webterminal/frontend"
PORT = 8901

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

FAKE_UI = """
// Mostrar la pantalla de terminal con datos simulados (sin SSH real)
document.getElementById('login-screen').style.display = 'none';
const ts = document.getElementById('terminal-screen');
ts.style.display = 'flex';
document.body.classList.add('files-open');
// Estado conectado
document.getElementById('status-dot').className = 'dot dot-green';
document.getElementById('status-text').textContent = 'conectado';
// Pestañas simuladas
const tabs = document.getElementById('tabs');
tabs.innerHTML = `
  <div class="tab tab-active"><span class="tab-ico"><svg class="ic"><use href="#ic-terminal"/></svg></span><span class="tab-name">principal</span></div>
  <div class="tab"><span class="tab-ico"><svg class="ic"><use href="#ic-terminal"/></svg></span><span class="tab-name">novela</span><button class="tab-close"><svg class="ic"><use href="#ic-x"/></svg></button></div>
  <div class="tab"><span class="tab-ico"><svg class="ic"><use href="#ic-file-text"/></svg></span><span class="tab-name">cap_01_v2.md</span><button class="tab-close"><svg class="ic"><use href="#ic-x"/></svg></button></div>
  <div class="tab tab-new"><span class="tab-ico"><svg class="ic"><use href="#ic-plus"/></svg></span></div>`;
// Breadcrumbs y lista de archivos simulada
document.getElementById('files-crumbs').innerHTML =
  '<span class="crumb">/</span><span class="sep">›</span><span class="crumb">home</span><span class="sep">›</span><span class="crumb">ubuntu</span>';
const mk = (name, dir, meta) => `
  <div class="frow ${dir ? 'isdir' : ''}">
    <span class="ico"><svg class="ic"><use href="#${dir ? 'ic-folder' : 'ic-file-text'}"/></svg></span>
    <span class="finfo"><span class="fname">${name}</span><span class="fmeta">${meta}</span></span>
    <span class="fops"><button class="fop"><svg class="ic"><use href="#ic-download"/></svg></button><button class="fop del"><svg class="ic"><use href="#ic-trash-2"/></svg></button></span>
  </div>`;
document.getElementById('files-list').innerHTML =
  mk('el_puente', true, '9 jun 18:50') + mk('webterminal', true, '10 jun 20:41') +
  mk('cadena-app', true, '8 jun 11:02') + mk('deploy.sh', false, '1,2 KB · 10 jun') +
  mk('notas.md', false, '4,7 KB · 9 jun') + mk('captura.png', false, '182 KB · hoy');
document.getElementById('files-status').textContent = '6 elementos · sftp listo';
// Texto simulado en el área del terminal (sin xterm real)
const tc = document.getElementById('terminal-container');
tc.innerHTML = `<pre style="margin:0;font-family:'JetBrains Mono',monospace;font-size:14px;line-height:1.45;color:#f8f8f2;padding:6px 4px;">
<span style="color:#50fa7b;">ubuntu@messor</span>:<span style="color:#58c4ff;">~/el_puente</span>$ ls caps/
cap_01.md  cap_01_v2.md  cap_02.md  cap_02_v2.md  cap_03.md
cap_03_v2.md  cap_04.md  cap_04_v2.md  cap_05.md  cap_05_v2.md
<span style="color:#50fa7b;">ubuntu@messor</span>:<span style="color:#58c4ff;">~/el_puente</span>$ wc -w caps/cap_01_v2.md
1878 caps/cap_01_v2.md
<span style="color:#50fa7b;">ubuntu@messor</span>:<span style="color:#58c4ff;">~/el_puente</span>$ <span style="background:#f8f8f2;color:#16162e;">&nbsp;</span></pre>`;
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 860}, device_scale_factor=2)
    pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
    time.sleep(0.6)
    pg.screenshot(path="/tmp/shot_login.png")
    pg.evaluate(FAKE_UI)
    time.sleep(0.4)
    pg.screenshot(path="/tmp/shot_terminal.png")
    # Diálogo de IA
    pg.evaluate("document.getElementById('ai-config').hidden = false;")
    time.sleep(0.2)
    pg.screenshot(path="/tmp/shot_dialog.png")
    b.close()
srv.shutdown()
print("ok")
