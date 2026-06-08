/* WebTerminal frontend. Token + SSH password live ONLY in memory. */
(function () {
  "use strict";

  let jwt = null;           // web session token (memory only)
  let sshUser = null;       // SSH system user (memory only)
  let sshPassword = null;   // SSH system password (memory only)

  let term = null, fitAddon = null, searchAddon = null, ws = null;
  let reconnectAttempts = 0;
  let autoOpenClaude = false;   // si true, ejecuta `claude` al conectar
  const RECONNECT_DELAYS = [1000, 3000, 8000];

  const $ = (id) => document.getElementById(id);
  const SCREENS = ["login-screen", "forgot-screen", "reset-screen", "ssh-screen", "account-screen", "terminal-screen"];
  function show(id) {
    SCREENS.forEach((s) => { $(s).style.display = (s === id) ? (s === "terminal-screen" ? "flex" : "flex") : "none"; });
  }

  // Service worker -> permite instalar como app (PWA) en el móvil
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
  }

  // ---------- "Recordar en este equipo" ----------
  // Persiste credenciales en localStorage SOLO si el usuario marca el tick.
  // La protección real frente al exterior es el certificado cliente mTLS de
  // Cloudflare: sin él no se llega a esta página. base64(UTF-8) es solo
  // ofuscación leve, NO cifrado. "Salir" borra lo guardado (olvidar equipo).
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
    body.append("email", email);
    body.append("password", password);
    const res = await fetch("/login", { method: "POST", body });
    if (!res.ok) return { ok: false, status: res.status };
    jwt = (await res.json()).token;
    return { ok: true };
  }

  // ---------- boot: reset link? / auto-login? ----------
  window.addEventListener("DOMContentLoaded", async () => {
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    if (token) { resetToken = token; show("reset-screen"); return; }

    const creds = loadCreds();
    if (creds && creds.email && creds.password) {
      // Pre-rellenar y reactivar los ticks
      $("login-email").value = creds.email;
      $("login-password").value = creds.password;
      $("login-remember").checked = true;
      if (creds.ssh_user) $("ssh-user").value = creds.ssh_user;
      if (creds.ssh_password) $("ssh-password").value = creds.ssh_password;
      $("ssh-remember").checked = !!(creds.ssh_user || creds.ssh_password);
      show("login-screen");
      let r; try { r = await doLogin(creds.email, creds.password); } catch (_) { r = { ok: false }; }
      if (r.ok) {
        if (creds.ssh_user && creds.ssh_password) {
          startSsh(creds.ssh_user, creds.ssh_password);   // directo a la terminal
        } else {
          show("ssh-screen"); $("ssh-password").focus();
        }
      } else {
        $("login-error").textContent = r.status === 401
          ? "Las credenciales guardadas ya no son válidas. Vuelve a entrar."
          : "No se pudo iniciar sesión automáticamente.";
      }
      return;
    }
    show("login-screen");
  });

  // ---------- LOGIN ----------
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("login-error"); err.textContent = "";
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    try {
      const r = await doLogin(email, password);
      if (!r.ok) { err.textContent = r.status === 401 ? "Email o contraseña incorrectos." : "Error (" + r.status + ")."; return; }
      if ($("login-remember").checked) saveCreds({ email, password });
      else clearCreds(["email", "password"]);
      show("ssh-screen");
      $("ssh-password").focus();
    } catch (_) { err.textContent = "No se pudo contactar con el servidor."; }
  });

  $("link-forgot").addEventListener("click", (e) => { e.preventDefault(); $("forgot-info").textContent=""; show("forgot-screen"); });

  // ---------- FORGOT ----------
  $("forgot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const info = $("forgot-info"); info.textContent = "Enviando…";
    const body = new FormData();
    body.append("email", $("forgot-email").value.trim());
    try {
      await fetch("/forgot", { method: "POST", body });
      info.textContent = "Si el email existe, te hemos enviado un enlace. Revisa tu correo.";
    } catch (_) { info.textContent = "Error al enviar. Inténtalo de nuevo."; }
  });
  $("link-back-login").addEventListener("click", (e) => { e.preventDefault(); show("login-screen"); });

  // ---------- RESET ----------
  let resetToken = null;
  $("reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("reset-error"), info = $("reset-info"); err.textContent=""; info.textContent="";
    const p1 = $("reset-password").value, p2 = $("reset-password2").value;
    if (p1 !== p2) { err.textContent = "Las contraseñas no coinciden."; return; }
    if (p1.length < 8) { err.textContent = "Mínimo 8 caracteres."; return; }
    const body = new FormData();
    body.append("token", resetToken);
    body.append("password", p1);
    try {
      const res = await fetch("/reset", { method: "POST", body });
      if (!res.ok) { const d = await res.json().catch(()=>({})); err.textContent = d.detail || "Enlace inválido o caducado."; return; }
      info.textContent = "Contraseña actualizada. Ya puedes entrar.";
      history.replaceState({}, "", "/");
      setTimeout(() => show("login-screen"), 1500);
    } catch (_) { err.textContent = "Error al guardar."; }
  });

  // ---------- SSH CONNECT ----------
  async function startSsh(user, password, openClaude) {
    sshUser = user;
    sshPassword = password;
    autoOpenClaude = !!openClaude;
    show("terminal-screen");
    // Esperar a que la fuente esté cargada ANTES de medir celdas (si no, la selección se descuadra)
    try { await document.fonts.load('14px "JetBrains Mono"'); await document.fonts.ready; } catch (_) {}
    initTerminal();
    connectWS();
  }

  function sshConnectFromForm(openClaude) {
    const user = $("ssh-user").value.trim();
    const password = $("ssh-password").value;
    $("ssh-error").textContent = "";
    if ($("ssh-remember").checked) saveCreds({ ssh_user: user, ssh_password: password });
    else clearCreds(["ssh_user", "ssh_password"]);
    startSsh(user, password, openClaude);
  }

  // Enter o "Abrir terminal" -> solo conecta. "Abrir + Claude" -> conecta y lanza claude.
  $("ssh-form").addEventListener("submit", (e) => { e.preventDefault(); sshConnectFromForm(false); });
  $("ssh-open-claude").addEventListener("click", (e) => { e.preventDefault(); sshConnectFromForm(true); });
  $("link-logout").addEventListener("click", (e) => { e.preventDefault(); logout(); });

  function logout() {
    jwt = sshUser = sshPassword = null;
    clearCreds();  // "Salir" = olvidar este equipo
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    $("login-password").value = ""; $("ssh-password").value = "";
    $("login-remember").checked = false; $("ssh-remember").checked = false;
    show("login-screen");
  }

  // ---------- ACCOUNT ----------
  $("link-account").addEventListener("click", async (e) => {
    e.preventDefault();
    $("account-error").textContent=""; $("account-info").textContent="";
    $("account-newemail").value=""; $("account-newpassword").value=""; $("account-current-pw").value="";
    try {
      const res = await fetch("/account", { headers: { Authorization: "Bearer " + jwt } });
      if (res.ok) { const d = await res.json(); $("account-current").textContent = "Conectado como: " + d.email; }
    } catch (_) {}
    show("account-screen");
  });
  $("link-account-back").addEventListener("click", (e) => { e.preventDefault(); show("ssh-screen"); });

  $("account-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("account-error"), info = $("account-info"); err.textContent=""; info.textContent="";
    const body = new FormData();
    body.append("current_password", $("account-current-pw").value);
    body.append("new_email", $("account-newemail").value.trim());
    body.append("new_password", $("account-newpassword").value);
    try {
      const res = await fetch("/account", { method: "POST", headers: { Authorization: "Bearer " + jwt }, body });
      const d = await res.json().catch(()=>({}));
      if (!res.ok) { err.textContent = d.detail || "No se pudo guardar."; return; }
      jwt = d.token;  // refresh (email may have changed)
      // Si hay credenciales recordadas, actualizarlas para no romper el auto-login
      if (loadCreds()) {
        const upd = { email: d.email };
        if ($("account-newpassword").value) upd.password = $("account-newpassword").value;
        saveCreds(upd);
      }
      info.textContent = "Cambios guardados.";
      $("account-current").textContent = "Conectado como: " + d.email;
    } catch (_) { err.textContent = "Error al guardar."; }
  });

  // ---------- TERMINAL ----------
  function setStatus(state, label) {
    $("status-dot").className = "dot " + (state === "connected" ? "dot-green" : state === "reconnecting" ? "dot-yellow" : "dot-red");
    $("status-text").textContent = label;
  }

  // ---------- SUBIDA DE IMÁGENES ----------
  let toastTimer = null;
  function showToast(msg, isErr) {
    const t = $("toast"); if (!t) return;
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " toast-err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, 3500);
  }

  async function uploadFile(file) {
    if (!file || !jwt) return;
    let name = file.name;
    if (!name) {  // Blob pegado del portapapeles (sin nombre)
      const ext = ((file.type || "").split("/")[1] || "bin").replace("jpeg", "jpg");
      name = "pegado-" + Date.now() + "." + ext;
    }
    showToast("Subiendo " + name + "…");
    const fd = new FormData();
    fd.append("file", file, name);
    try {
      const res = await fetch("/upload", { method: "POST", headers: { Authorization: "Bearer " + jwt }, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(d.detail || ("Error al subir (" + res.status + ")"), true); return; }
      // Inyectar la ruta en la terminal (como si se tecleara) para que Claude la abra.
      // Entrecomillamos si tiene espacios para que sea válida también en el shell.
      const p = d.path;
      const arg = /\s/.test(p) ? "'" + p.replace(/'/g, "'\\''") + "'" : p;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(arg + " ");
      showToast("Archivo listo ➜ " + d.name);
      if (term) term.focus();
    } catch (_) { showToast("Error de red al subir el archivo", true); }
  }

  // ---------- DICTADO POR VOZ (Web Speech API, gratis) ----------
  let recognition = null, listening = false;
  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = $("mic");
    if (!micBtn) return;
    if (!SR) { micBtn.disabled = true; micBtn.title = "Tu navegador no soporta dictado por voz"; return; }
    if (recognition) return;  // ya inicializado
    recognition = new SR();
    recognition.lang = "es-ES";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) {
          const txt = (ev.results[i][0].transcript || "").trim();
          if (txt && ws && ws.readyState === WebSocket.OPEN) ws.send(txt + " ");
        }
      }
    };
    recognition.onerror = (e) => {
      showToast("Voz: " + (e.error === "not-allowed" ? "permiso de micrófono denegado" : (e.error || "error")), true);
      stopVoice();
    };
    // Chrome corta tras silencio; si seguimos en modo escucha, reanuda.
    recognition.onend = () => { if (listening) { try { recognition.start(); } catch (_) {} } };
    micBtn.addEventListener("click", () => (listening ? stopVoice() : startVoice()));
  }
  function startVoice() {
    if (!recognition) return;
    try { recognition.start(); listening = true; $("mic").classList.add("mic-on"); showToast("🎤 Escuchando… (toca el micro para parar)"); }
    catch (_) {}
  }
  function stopVoice() {
    listening = false;
    try { recognition.stop(); } catch (_) {}
    const m = $("mic"); if (m) m.classList.remove("mic-on");
  }

  function initTerminal() {
    if (term) return;
    term = new Terminal({
      theme: { background:"#282a36", foreground:"#f8f8f2", cursor:"#f8f8f2", selectionBackground:"#44475a",
        black:"#21222c", red:"#ff5555", green:"#50fa7b", yellow:"#f1fa8c", blue:"#6272a4",
        magenta:"#ff79c6", cyan:"#8be9fd", white:"#f8f8f2" },
      fontFamily: "'JetBrains Mono', monospace", fontSize: 14, lineHeight: 1.0,
      scrollSensitivity: 3,
      cursorBlink: true, cursorStyle: "block", scrollback: 10000, allowProposedApi: true,
    });
    fitAddon = new FitAddon.FitAddon();
    searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    term.loadAddon(searchAddon);
    term.open($("terminal-container"));
    // DOM renderer (default) — scroll y selección fiables. (CanvasAddon daba problemas de scroll.)
    fitAddon.fit();
    requestAnimationFrame(() => { try { fitAddon.fit(); } catch (_) {} });
    term.onData((d) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(d); });
    window.addEventListener("resize", doFit);

    const copySel = () => {
      const sel = term.getSelection();
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); return true; }
      return false;
    };
    // Pega desde el portapapeles: si hay IMAGEN la sube; si no, pega texto.
    // Lee el portapapeles activamente (clipboard.read) porque xterm captura
    // Ctrl+V y lo manda como \x16 al PTY antes de que el navegador dispare 'paste'.
    const pasteFromClipboard = async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.read) {
          const items = await navigator.clipboard.read();
          for (const it of items) {
            const imgType = (it.types || []).find((t) => t.startsWith("image/"));
            if (imgType) { const blob = await it.getType(imgType); await uploadFile(blob); return; }
          }
        }
      } catch (_) { /* sin permiso de imagen -> probamos texto */ }
      try {
        const txt = await navigator.clipboard.readText();
        if (txt && ws && ws.readyState === WebSocket.OPEN) ws.send(txt);
      } catch (_) {}
    };

    // Copiar automáticamente al seleccionar con el ratón
    term.onSelectionChange(() => { copySel(); });

    // Clic derecho: copia si hay selección, si no pega (texto o imagen)
    $("terminal-container").addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (copySel()) term.clearSelection(); else pasteFromClipboard();
    });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // Copiar: Ctrl+Shift+C o Ctrl+Insert
      if ((ev.ctrlKey && ev.shiftKey && ev.code === "KeyC") || (ev.ctrlKey && ev.code === "Insert")) {
        if (copySel()) return false;
        return true; // sin selección -> deja pasar (Ctrl+C = interrumpir)
      }
      // Pegar: Ctrl+V, Ctrl+Shift+V o Shift+Insert (imagen o texto)
      if ((ev.ctrlKey && ev.code === "KeyV") || (ev.shiftKey && ev.code === "Insert")) {
        pasteFromClipboard(); return false;
      }
      // Buscar: Ctrl+Shift+F
      if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyF") {
        const q = window.prompt("Buscar:"); if (q) searchAddon.findNext(q); return false;
      }
      return true;
    });
    $("font-dec").addEventListener("click", () => changeFont(-1));
    $("font-inc").addEventListener("click", () => changeFont(1));

    // --- Pegar imagen (Ctrl+V con imagen en el portapapeles) ---
    // A nivel de DOCUMENTO en fase de captura: así interceptamos el pegado antes
    // de que llegue al textarea de xterm / a la TUI de Claude (que respondería
    // "If you're SSH'd, try scp"). Solo actuamos con la terminal conectada.
    document.addEventListener("paste", (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          const blob = it.getAsFile();
          if (blob) uploadFile(blob);
          return;
        }
      }
    }, true);

    // --- Arrastrar y soltar CUALQUIER archivo sobre la terminal ---
    const tc = $("terminal-container");
    tc.addEventListener("dragover", (e) => { e.preventDefault(); tc.classList.add("drag-over"); });
    tc.addEventListener("dragleave", () => tc.classList.remove("drag-over"));
    tc.addEventListener("drop", (e) => {
      e.preventDefault(); tc.classList.remove("drag-over");
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      for (const f of files) uploadFile(f);
    });

    // --- Botón 📎 + input de archivo (cualquier tipo, varios a la vez) ---
    $("img-upload").addEventListener("click", () => $("img-file").click());
    $("img-file").addEventListener("change", (e) => {
      const files = e.target.files || [];
      for (const f of files) uploadFile(f);
      e.target.value = "";
    });

    setupVoice();
  }

  function doFit() { if (!fitAddon) return; fitAddon.fit(); sendResize(); }
  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
  function changeFont(delta) {
    let s = term.options.fontSize + delta; if (s < 10) s = 10; if (s > 22) s = 22;
    term.options.fontSize = s; $("font-size").textContent = String(s); fitAddon.fit(); sendResize();
  }

  function connectWS() {
    setStatus(reconnectAttempts ? "reconnecting" : "disconnected", reconnectAttempts ? "reconectando…" : "conectando…");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(jwt)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      reconnectAttempts = 0;
      setStatus("connected", "conectado");
      ws.send(JSON.stringify({ ssh_user: sshUser, password: sshPassword }));
      doFit(); term.focus();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
      else term.write(ev.data);
      // Tras recibir el primer prompt del shell, lanza claude si se pidió.
      if (autoOpenClaude) {
        autoOpenClaude = false;
        setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send("claude\r"); }, 700);
      }
    };
    ws.onclose = () => { setStatus("disconnected", "desconectado"); scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= RECONNECT_DELAYS.length) {
      setStatus("disconnected", "sin conexión — recarga la página");
      term.write("\r\n\x1b[31m[webterminal] conexión perdida. Recarga la página para reintentar.\x1b[0m\r\n");
      return;
    }
    const delay = RECONNECT_DELAYS[reconnectAttempts++];
    setStatus("reconnecting", `reconectando en ${delay / 1000}s…`);
    setTimeout(connectWS, delay);
  }
})();
