/* MessorTerminal — versión móvil. Slim. Token + contraseña SSH solo en memoria.
   Reutiliza los mismos endpoints que la versión de escritorio. */
(function () {
  "use strict";

  let jwt = null, sshUser = null, sshPassword = null;
  let term = null, fitAddon = null, ws = null;
  let reconnectAttempts = 0, autoOpenClaude = false;
  let currentSession = null;     // label tmux activo (null = principal)
  let fsid = null;               // id de sesión SFTP
  let fsPath = "";               // carpeta actual del explorador

  const $ = (id) => document.getElementById(id);
  const icon = (n) => '<svg class="ic"><use href="#ic-' + n + '"/></svg>';
  const SCREENS = ["login-screen", "ssh-screen", "app-screen"];
  function show(id) { SCREENS.forEach((s) => { const el = $(s); if (el) el.hidden = (s !== id); }); }

  // PWA
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
  }

  // ---------- Credenciales (mismas claves que escritorio → login compartido) ----------
  const STORE_KEY = "wt.remember";
  function _enc(s) { return btoa(unescape(encodeURIComponent(s))); }
  function _dec(s) { return decodeURIComponent(escape(atob(s))); }
  function loadCreds() { try { const r = localStorage.getItem(STORE_KEY); return r ? JSON.parse(_dec(r)) : null; } catch (_) { return null; } }
  function saveCreds(obj) { try { const cur = loadCreds() || {}; localStorage.setItem(STORE_KEY, _enc(JSON.stringify({ ...cur, ...obj }))); } catch (_) {} }
  function clearCreds(keys) {
    try {
      if (!keys) { localStorage.removeItem(STORE_KEY); return; }
      const cur = loadCreds(); if (!cur) return;
      keys.forEach((k) => delete cur[k]);
      if (Object.keys(cur).length) localStorage.setItem(STORE_KEY, _enc(JSON.stringify(cur)));
      else localStorage.removeItem(STORE_KEY);
    } catch (_) {}
  }

  async function doLogin(email, password) {
    const body = new FormData();
    body.append("email", email); body.append("password", password);
    const res = await fetch("/login", { method: "POST", body });
    if (!res.ok) return { ok: false, status: res.status };
    jwt = (await res.json()).token;
    return { ok: true };
  }

  // ---------- Toast / estado ----------
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $("toast"); if (!t) return;
    t.textContent = msg; t.className = "toast show" + (isErr ? " toast-err" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = "toast"; }, 3200);
  }
  function setStatus(state) {
    const d = $("status-dot"); if (!d) return;
    d.className = "dot " + (state === "connected" ? "dot-green" : state === "reconnecting" ? "dot-yellow" : "dot-red");
  }

  // ---------- Boot ----------
  window.addEventListener("DOMContentLoaded", async () => {
    // Si llega un token de reset, esto es cosa de escritorio: redirige.
    if (new URLSearchParams(location.search).get("token")) { location.replace("/?token=" + encodeURIComponent(new URLSearchParams(location.search).get("token"))); return; }
    bindForms();
    const creds = loadCreds();
    if (creds && creds.email && creds.password) {
      if (creds.ssh_user) $("ssh-user").value = creds.ssh_user;
      if (creds.ssh_password) $("ssh-password").value = creds.ssh_password;
      $("ssh-remember").checked = !!(creds.ssh_user || creds.ssh_password);
      show("login-screen");
      let r; try { r = await doLogin(creds.email, creds.password); } catch (_) { r = { ok: false }; }
      if (r.ok) show("ssh-screen");
      else { $("login-email").value = creds.email; $("login-password").value = creds.password; $("login-remember").checked = true; $("login-error").textContent = "Vuelve a entrar."; }
      return;
    }
    show("login-screen");
  });

  // El enlace "escritorio" fija la preferencia para que / no vuelva a redirigir aquí.
  function goDesktop(e) { if (e) e.preventDefault(); try { localStorage.setItem("wt_force_desktop", "1"); } catch (_) {} location.href = "/"; }

  function bindForms() {
    $("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("login-error"); err.textContent = "";
      const email = $("login-email").value.trim(), password = $("login-password").value;
      try {
        const r = await doLogin(email, password);
        if (!r.ok) { err.textContent = r.status === 401 ? "Email o contraseña incorrectos." : "Error (" + r.status + ")."; return; }
        if ($("login-remember").checked) saveCreds({ email, password }); else clearCreds(["email", "password"]);
        show("ssh-screen"); $("ssh-user").focus();
      } catch (_) { err.textContent = "No se pudo contactar con el servidor."; }
    });
    $("ssh-form").addEventListener("submit", (e) => { e.preventDefault(); sshConnect(false); });
    $("ssh-claude").addEventListener("click", () => sshConnect(true));
    $("link-logout").addEventListener("click", (e) => { e.preventDefault(); clearCreds(); jwt = sshPassword = null; show("login-screen"); });
    $("link-desktop").addEventListener("click", goDesktop);
    $("link-desktop2").addEventListener("click", goDesktop);
  }

  async function sshConnect(openClaude) {
    const user = $("ssh-user").value.trim(), password = $("ssh-password").value;
    $("ssh-error").textContent = "";
    if (!user || !password) { $("ssh-error").textContent = "Usuario y contraseña."; return; }
    if ($("ssh-remember").checked) saveCreds({ ssh_user: user, ssh_password: password }); else clearCreds(["ssh_user", "ssh_password"]);
    sshUser = user; sshPassword = password; autoOpenClaude = !!openClaude;
    show("app-screen");
    // Espera a que la fuente monoespaciada esté lista ANTES de medir celdas
    // (si no, xterm calcula mal el tamaño y se ve descuadrado en iPhone).
    try { await document.fonts.load('13px "JetBrains Mono"'); await document.fonts.ready; } catch (_) {}
    initTerminal();
    setupKeybar(); setupCompose(); setupVoice(); setupSessions(); setupFiles();
    connectWS();
  }

  // ---------- Terminal (solo render; toda la entrada va por compose/keybar) ----------
  function initTerminal() {
    if (term) { refit(); return; }
    term = new Terminal({
      theme: { background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
        black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#6272a4",
        magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2" },
      fontFamily: "'JetBrains Mono', monospace", fontSize: 13, lineHeight: 1.0,
      cursorBlink: true, cursorStyle: "block", scrollback: 8000, allowProposedApi: true,
      disableStdin: true,                 // la entrada NO pasa por xterm en móvil
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open($("term"));
    // Evita que tocar la terminal abra el teclado del sistema (entrada por compose).
    try { if (term.textarea) { term.textarea.readOnly = true; term.textarea.tabIndex = -1; term.textarea.setAttribute("inputmode", "none"); } } catch (_) {}
    refit();
    requestAnimationFrame(refit);
    window.addEventListener("resize", refit);
    // El teclado virtual cambia el viewport: reajustar para no descuadrar filas/cols.
    if (window.visualViewport) window.visualViewport.addEventListener("resize", refit);
  }
  function refit() {
    if (!fitAddon || !term) return;
    try { fitAddon.fit(); if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })); } catch (_) {}
  }

  // ---------- WebSocket ----------
  function connectWS() {
    setStatus(reconnectAttempts ? "reconnecting" : "disconnected");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(jwt)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      reconnectAttempts = 0; setStatus("connected");
      ws.send(JSON.stringify({ ssh_user: sshUser, password: sshPassword, session: currentSession || undefined }));
      refit();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); }
      else {
        if (ev.data && ev.data[0] === "{") {
          try {
            const m = JSON.parse(ev.data);
            if (m && m.type === "tmux-sessions") { renderSessions(m.sessions || []); return; }
            if (m && m.type === "fsid") { fsid = m.fsid; requestSessions(); return; }
          } catch (_) {}
        }
        term.write(ev.data);
      }
      if (autoOpenClaude) { autoOpenClaude = false; setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send("claude\r"); }, 700); }
    };
    ws.onclose = (ev) => {
      setStatus("disconnected");
      const code = ev ? ev.code : 0;
      if (code === 4401 || code === 4403 || code === 4429 || code === 4400) {
        sshPassword = null; ws = null;
        if (code === 4401) { jwt = null; $("login-error").textContent = "Sesión caducada. Vuelve a entrar."; show("login-screen"); }
        else { $("ssh-error").textContent = (ev && ev.reason) || "No se pudo abrir la terminal."; $("ssh-password").value = ""; show("ssh-screen"); }
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  function scheduleReconnect() {
    const n = reconnectAttempts++;
    let delay = Math.min(30000, 1000 * Math.pow(2, n));
    delay += Math.floor(delay * 0.2 * Math.random());
    setStatus("reconnecting");
    setTimeout(connectWS, delay);
  }
  function reconnectNow() {
    reconnectAttempts = 0;
    if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (_) {} ws = null; }
    connectWS();
  }
  function sendRaw(s) { if (s && ws && ws.readyState === WebSocket.OPEN) ws.send(s); }

  // ---------- Keybar (teclas especiales) ----------
  let ctrlPending = false;
  function setCtrl(on) { ctrlPending = on; const b = $("kb-ctrl"); if (b) b.classList.toggle("kb-active", on); }
  function toCtrl(ch) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    return ch;
  }
  const KEYS = [
    { t: "Esc", seq: "\x1b" }, { t: "Tab", seq: "\t" }, { t: "Ctrl", id: "kb-ctrl" }, { t: "^C", seq: "\x03" },
    { sep: 1 },
    { t: "←", seq: "\x1b[D" }, { t: "↑", seq: "\x1b[A" }, { t: "↓", seq: "\x1b[B" }, { t: "→", seq: "\x1b[C" },
    { t: "Intro", seq: "\r" },
    { sep: 1 },
    { t: "Inicio", seq: "\x1b[H" }, { t: "Fin", seq: "\x1b[F" }, { t: "|", seq: "|" }, { t: "~", seq: "~" }, { t: "/", seq: "/" }, { t: "-", seq: "-" },
  ];
  function setupKeybar() {
    const bar = $("keybar"); if (!bar || bar.dataset.ready) return; bar.dataset.ready = "1";
    KEYS.forEach((k) => {
      if (k.sep) { const s = document.createElement("span"); s.className = "kb-sep"; bar.appendChild(s); return; }
      const b = document.createElement("button"); b.className = "kb"; b.textContent = k.t;
      if (k.id) b.id = k.id; else b.setAttribute("data-seq", k.seq);
      bar.appendChild(b);
    });
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button.kb"); if (!btn) return;
      if (btn.id === "kb-ctrl") { setCtrl(!ctrlPending); return; }
      let seq = btn.getAttribute("data-seq") || "";
      if (ctrlPending && seq.length === 1) { seq = toCtrl(seq); setCtrl(false); }
      sendRaw(seq);
    });
  }

  // ---------- Compose (escribir / dictar → enviar línea) ----------
  function autoGrow() {
    const ta = $("compose-input"); ta.style.height = "auto";
    ta.style.height = Math.min(120, ta.scrollHeight) + "px";
  }
  function sendCompose() {
    const ta = $("compose-input"); const txt = ta.value.trim();
    // Enter cierra el dictado: el mensaje ya se envía, y el resultado "interino"
    // del micro volvería a rellenar la caja si lo dejáramos activo. Para seguir
    // dictando, se vuelve a tocar el micro.
    if (listening) stopVoice();
    if (txt && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(txt);
      // El Intro va aparte y con retardo: si llega pegado, la TUI no lo registra.
      setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send("\r"); }, 130);
    }
    ta.value = ""; baseText = ""; vFinal = "";
    autoGrow();
  }
  function setupCompose() {
    const ta = $("compose-input");
    ta.addEventListener("input", () => {
      autoGrow();
      // Ctrl armado + tecleas un carácter → se manda como control inmediato.
      if (ctrlPending && ta.value.length) {
        const ch = ta.value.slice(-1);
        ta.value = ta.value.slice(0, -1);
        sendRaw(toCtrl(ch)); setCtrl(false); autoGrow();
      }
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCompose(); }
    });
    $("send-btn").addEventListener("click", sendCompose);
  }

  // ---------- Voz (es-ES → rellena la barra de redacción) ----------
  let recog = null, listening = false, baseText = "", vFinal = "";
  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = $("mic-btn");
    if (!SR) { mic.disabled = true; mic.title = "Sin dictado en este navegador"; return; }
    if (!recog) {
      recog = new SR(); recog.lang = "es-ES"; recog.continuous = true; recog.interimResults = true;
      recog.onresult = (ev) => {
        if (!listening) return;   // micro apagado (p.ej. tras Enter): no repintar la caja
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) vFinal += (vFinal && !/\s$/.test(vFinal) ? " " : "") + (r[0].transcript || "").trim();
          else interim += r[0].transcript || "";
        }
        const ta = $("compose-input");
        ta.value = (baseText + vFinal + (interim ? " " + interim : "")).replace(/\s+/g, " ").trimStart();
        autoGrow();
      };
      recog.onerror = (e) => { toast("Voz: " + (e.error === "not-allowed" ? "permiso denegado" : (e.error || "error")), true); stopVoice(); };
      recog.onend = () => { if (listening) { try { recog.start(); } catch (_) {} } };
    }
    mic.addEventListener("click", () => { listening ? stopVoice() : startVoice(); });
  }
  function startVoice() {
    if (!recog) return;
    baseText = $("compose-input").value; if (baseText && !/\s$/.test(baseText)) baseText += " ";
    vFinal = ""; listening = true; $("mic-btn").classList.add("mic-on");
    try { recog.start(); } catch (_) {}
    toast("Escuchando… (toca el micro para parar)");
  }
  function stopVoice() {
    listening = false; $("mic-btn").classList.remove("mic-on");
    try { recog.stop(); } catch (_) {}
  }

  // ---------- Sesiones tmux ----------
  let _sessions = [];
  function _slug(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
  function renderSessions(list) {
    _sessions = Array.isArray(list) ? list : [];
    const cur = _sessions.find((s) => s.current);
    $("session-name").textContent = (cur && cur.label) || currentSession || "principal";
    if (!$("sheet-sessions").hidden) renderSessionsSheet();
  }
  function requestSessions() { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tmux-list" })); }
  function switchSession(label) {
    currentSession = (label === "principal") ? null : label;
    $("session-name").textContent = label;
    if (term) try { term.reset(); } catch (_) {}
    reconnectNow();
    closeSheet("sheet-sessions");
  }
  function newSession() {
    const raw = window.prompt("Nombre de la nueva sesión (p. ej. logs, pruebas):", "");
    if (raw === null) return;
    const label = _slug(raw.trim()); if (!label) return;
    switchSession(label);
  }
  function killSession(label) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tmux-kill", label }));
  }
  function renderSessionsSheet() {
    const box = $("sessions-list"); box.innerHTML = "";
    const list = _sessions.length ? _sessions : [{ label: currentSession || "principal", current: true }];
    list.forEach((s) => {
      const row = document.createElement("div"); row.className = "srow" + (s.current ? " current" : "");
      const name = document.createElement("span"); name.className = "sname"; name.textContent = s.label;
      row.appendChild(name);
      if (s.current) { const k = document.createElement("span"); k.className = "skill"; k.innerHTML = icon("terminal"); row.appendChild(k); }
      else {
        const x = document.createElement("button"); x.className = "tbtn"; x.innerHTML = icon("x"); x.title = "Cerrar sesión";
        x.addEventListener("click", (e) => { e.stopPropagation(); killSession(s.label); });
        row.appendChild(x);
      }
      row.addEventListener("click", () => { if (!s.current) switchSession(s.label); else closeSheet("sheet-sessions"); });
      box.appendChild(row);
    });
  }
  function setupSessions() {
    $("session-pill").addEventListener("click", () => { renderSessionsSheet(); openSheet("sheet-sessions"); requestSessions(); });
    $("sessions-close").addEventListener("click", () => closeSheet("sheet-sessions"));
    $("session-new").addEventListener("click", newSession);
    $("sheet-sessions").addEventListener("click", (e) => { if (e.target.id === "sheet-sessions") closeSheet("sheet-sessions"); });
  }

  // ---------- Archivos (ver + subir) ----------
  const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "svg"]);
  function isImg(name) { const i = (name || "").lastIndexOf("."); return i >= 0 && IMG_EXTS.has(name.slice(i + 1).toLowerCase()); }
  function fileURL(path) { return "/files/download?fsid=" + encodeURIComponent(fsid) + "&path=" + encodeURIComponent(path) + "&token=" + encodeURIComponent(jwt); }
  function fsHeaders() { return { Authorization: "Bearer " + jwt }; }
  function fsStatus(msg) { $("files-status").textContent = msg || ""; }
  function fmtSize(n) { if (n < 1024) return n + " B"; const u = ["KB", "MB", "GB", "TB"]; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1); return n.toFixed(n < 10 ? 1 : 0) + " " + u[i]; }
  function fsJoin(dir, name) { return (dir === "/" ? "" : dir) + "/" + name; }
  // Ajuste de línea del visor (por defecto activado: todo cabe sin scroll horizontal).
  let _wrap = true; try { _wrap = localStorage.getItem("wt_m_wrap") !== "0"; } catch (_) {}
  function applyWrap() { const pre = $("fv-pre"), b = $("fv-wrap"); if (pre) pre.classList.toggle("wrap", _wrap); if (b) b.classList.toggle("on", _wrap); }

  async function fsList(path) {
    if (!fsid) { fsStatus("Conecta la terminal primero."); return; }
    fsStatus("Cargando…");
    try {
      const res = await fetch("/files/list?fsid=" + encodeURIComponent(fsid) + "&path=" + encodeURIComponent(path || ""), { headers: fsHeaders() });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { fsStatus(d.detail || ("Error " + res.status)); return; }
      fsPath = d.path; fsRender(d); fsStatus(d.items.length + " elementos");
    } catch (_) { fsStatus("Error de red al listar"); }
  }
  function fsCrumbs(path) {
    const box = $("files-crumbs"); box.innerHTML = "";
    const root = document.createElement("span"); root.className = "crumb"; root.textContent = "/";
    root.addEventListener("click", () => fsList("/")); box.appendChild(root);
    let acc = "";
    path.split("/").filter(Boolean).forEach((p) => {
      acc += "/" + p;
      const c = document.createElement("span"); c.className = "crumb"; c.textContent = " › " + p;
      const target = acc; c.addEventListener("click", () => fsList(target)); box.appendChild(c);
    });
  }
  function fsRender(d) {
    fsCrumbs(d.path);
    const list = $("files-list"); list.innerHTML = "";
    if (!d.items.length) { list.innerHTML = '<div class="files-empty">Carpeta vacía</div>'; return; }
    d.items.forEach((it) => {
      const full = fsJoin(d.path, it.name);
      const row = document.createElement("div"); row.className = "frow" + (it.dir ? " isdir" : "");
      const ico = document.createElement("span"); ico.className = "ico"; ico.innerHTML = it.dir ? icon("folder") : icon("file-text");
      const info = document.createElement("div"); info.className = "finfo";
      const name = document.createElement("span"); name.className = "fname"; name.textContent = it.name;
      const meta = document.createElement("span"); meta.className = "fmeta"; meta.textContent = it.dir ? "carpeta" : fmtSize(it.size);
      info.appendChild(name); info.appendChild(meta);
      row.appendChild(ico); row.appendChild(info);
      row.addEventListener("click", () => { if (it.dir) fsList(full); else openFile(full, it.name); });
      list.appendChild(row);
    });
  }
  async function openFile(path, name) {
    const fv = $("file-view"), pre = $("fv-pre"), imgWrap = $("fv-img"), imgEl = $("fv-img-el");
    $("fv-name").textContent = name;
    $("fv-download").onclick = () => { const a = document.createElement("a"); a.href = fileURL(path); a.download = ""; document.body.appendChild(a); a.click(); a.remove(); };
    if (isImg(name)) {
      $("fv-wrap").hidden = true;
      pre.hidden = true; imgWrap.hidden = false; imgEl.src = fileURL(path); fv.hidden = false; return;
    }
    $("fv-wrap").hidden = false; applyWrap();
    imgWrap.hidden = true; pre.hidden = false; pre.textContent = "Cargando…"; fv.hidden = false;
    try {
      const res = await fetch("/files/read?fsid=" + encodeURIComponent(fsid) + "&path=" + encodeURIComponent(path), { headers: fsHeaders() });
      const d = await res.json().catch(() => ({}));
      pre.textContent = res.ok ? (d.content != null ? d.content : "") : (d.detail || "No se puede leer este archivo.");
    } catch (_) { pre.textContent = "Error de red al leer."; }
  }
  async function fsUpload(file) {
    if (!file) return;
    fsStatus("Subiendo " + file.name + "…");
    const fd = new FormData(); fd.append("fsid", fsid); fd.append("dir", fsPath); fd.append("file", file, file.name);
    try {
      const res = await fetch("/files/upload", { method: "POST", headers: fsHeaders(), body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { fsStatus(d.detail || "Error al subir"); toast("Error al subir", true); return; }
      toast("Subido ✓"); fsList(fsPath);
    } catch (_) { fsStatus("Error de red al subir"); }
  }
  function setupFiles() {
    $("files-btn").addEventListener("click", () => { openSheet("sheet-files"); fsList(fsPath || ""); });
    $("files-close").addEventListener("click", () => closeSheet("sheet-files"));
    $("fv-back").addEventListener("click", () => { $("file-view").hidden = true; $("fv-img-el").src = ""; });
    $("fv-wrap").addEventListener("click", () => { _wrap = !_wrap; try { localStorage.setItem("wt_m_wrap", _wrap ? "1" : "0"); } catch (_) {} applyWrap(); });
    $("files-up").addEventListener("click", () => $("files-input").click());
    $("files-input").addEventListener("change", (e) => { const f = (e.target.files || [])[0]; if (f) fsUpload(f); e.target.value = ""; });
  }

  // ---------- Hojas ----------
  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; if (id === "sheet-files") { $("file-view").hidden = true; $("fv-img-el").src = ""; } }
})();
