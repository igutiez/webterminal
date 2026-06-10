/* MessorTerminal frontend. Token + SSH password live ONLY in memory. */
(function () {
  "use strict";

  let jwt = null;           // web session token (memory only)
  let sshUser = null;       // SSH system user (memory only)
  let sshPassword = null;   // SSH system password (memory only)

  let term = null, fitAddon = null, searchAddon = null, ws = null;
  let reconnectAttempts = 0;
  let autoOpenClaude = false;   // si true, ejecuta `claude` al conectar
  let currentSession = null;    // label de la sesión tmux activa (null = principal)
  let fsid = null;              // id de sesión para el explorador de archivos (SFTP)

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
        // No entramos directos: paramos en la 2ª pantalla (SSH) con los datos ya
        // rellenos para que el usuario elija "Abrir terminal" o "Abrir + Claude".
        show("ssh-screen");
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
      showToast("Archivo listo → " + d.name);
      if (term) term.focus();
    } catch (_) { showToast("Error de red al subir el archivo", true); }
  }

  // ---------- CAPTURA DE PANTALLA (para que Claude "vea" otra pestaña/ventana) ----------
  // Eliges qué compartir (queda compartiéndose aunque cambies de pestaña).
  //  📷 foto: 1ª pulsación comparte; 2ª captura un fotograma nítido.
  //  🎥 vídeo: graba con MediaRecorder (captura continua real, sin negros ni
  //     repetidos), lo sube y el servidor saca los fotogramas con ffmpeg.
  //  ⏹ deja de compartir. Solo escritorio (iOS no soporta getDisplayMedia).
  let capStream = null, capVideo = null;
  // Asegura que hay una fuente compartida (la pide si no la hay). Devuelve true si
  // hay una fuente lista para usar.
  async function ensureShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast("Tu navegador no permite capturar la pantalla", true); return false;
    }
    if (capStream) return true;
    try {
      capStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (_) { return false; }  // el usuario canceló
    capVideo = document.createElement("video");
    capVideo.srcObject = capStream; capVideo.muted = true;
    try { await capVideo.play(); } catch (_) {}
    $("screencap").classList.add("cap-on");
    const s = $("cap-stop"); if (s) s.style.display = "";
    capStream.getVideoTracks().forEach((t) => t.addEventListener("ended", stopCapture));
    return true;
  }
  function grabFrame() {
    const w = capVideo.videoWidth || 1920, h = capVideo.videoHeight || 1080;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(capVideo, 0, 0, w, h);
    return c;
  }
  // 📷 una sola foto (arma la 1ª vez; captura a partir de la 2ª)
  async function captureScreen() {
    const had = !!capStream;
    if (!(await ensureShare())) return;
    if (!had) {  // recién armado: esta pulsación solo comparte
      showToast("Compartiendo pantalla. Ve a la pestaña del error y vuelve: pulsa la cámara para la foto, el cuadrado para parar.");
      return;
    }
    if (!capVideo.videoWidth) return;
    try {
      const blob = await new Promise((res) => grabFrame().toBlob(res, "image/png"));
      if (blob) await uploadFile(new File([blob], "captura-" + Date.now() + ".png", { type: "image/png" }));
    } catch (_) { showToast("No se pudo capturar el fotograma", true); }
  }
  // 🎥 vídeo: alterna grabar/parar. Al parar, sube el webm y el servidor monta los fotogramas.
  let recorder = null, recChunks = [];
  async function toggleRecord() {
    if (recorder) {  // ya grabando -> parar y procesar
      showToast("Procesando vídeo…");
      try { recorder.stop(); } catch (_) {}
      return;
    }
    if (!(await ensureShare())) return;  // arma si hace falta; el vídeo graba desde ya
    let mime = "video/webm;codecs=vp9";
    if (!(window.MediaRecorder && MediaRecorder.isTypeSupported(mime))) mime = "video/webm";
    try { recorder = new MediaRecorder(capStream, { mimeType: mime }); }
    catch (_) { showToast("Tu navegador no permite grabar vídeo", true); return; }
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(recChunks, { type: "video/webm" });
      recorder = null; recChunks = [];
      $("screenrec").classList.remove("rec-on");
      await uploadScreencast(blob);
    };
    recorder.start();
    $("screenrec").classList.add("rec-on");
    showToast("Grabando. Ve a la pestaña del error, reprodúcelo y vuelve a pulsar el botón de vídeo para parar.");
  }
  async function uploadScreencast(blob) {
    if (!blob || !blob.size || !jwt) { showToast("Grabación vacía", true); return; }
    showToast("Subiendo vídeo y extrayendo fotogramas…");
    const fd = new FormData();
    fd.append("file", blob, "grabacion.webm");
    try {
      const res = await fetch("/screencast", { method: "POST", headers: { Authorization: "Bearer " + jwt }, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(d.detail || ("Error al procesar (" + res.status + ")"), true); return; }
      const p = d.path;
      const arg = /\s/.test(p) ? "'" + p.replace(/'/g, "'\\''") + "'" : p;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(arg + " ");
      showToast("Secuencia lista (" + d.frames + " fotogramas) → " + d.name);
      if (term) term.focus();
    } catch (_) { showToast("Error de red al subir el vídeo", true); }
  }
  function stopCapture() {
    try { if (recorder) recorder.stop(); } catch (_) {}
    recorder = null;
    try { if (capStream) capStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    capStream = null; capVideo = null;
    $("screencap").classList.remove("cap-on");
    const rb = $("screenrec"); if (rb) rb.classList.remove("cap-on", "rec-on");
    const s = $("cap-stop"); if (s) s.style.display = "none";
  }

  // ---------- DICTADO POR VOZ (Web Speech API, gratis) ----------
  // Escritorio: el 🎤 alterna escucha y el texto reconocido se va tecleando.
  // Móvil: el 🎤 abre un overlay grande con el micro animado y la transcripción
  // en vivo; al acabar eliges "Enviar ⏎" (texto + intro), "Solo pegar" (texto
  // sin intro) o "Cancelar". El reconocimiento es del navegador (gratis, sin API).
  let recognition = null, listening = false;
  let overlayOpen = false;        // true mientras el overlay móvil está abierto
  let voiceFinal = "";            // transcripción ya consolidada (overlay)
  let voiceInterim = "";          // último trozo aún provisional (overlay)

  function isMobile() {
    return window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 640;
  }

  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = $("mic");
    if (!micBtn) return;
    if (!SR) { micBtn.disabled = true; micBtn.title = "Tu navegador no soporta dictado por voz"; return; }
    if (recognition) return;  // ya inicializado
    recognition = new SR();
    recognition.lang = "es-ES";
    recognition.continuous = true;
    recognition.interimResults = true;   // necesario para ver el texto en vivo en el móvil
    recognition.onresult = onVoiceResult;
    recognition.onerror = (e) => {
      showToast("Voz: " + (e.error === "not-allowed" ? "permiso de micrófono denegado" : (e.error || "error")), true);
      if (overlayOpen) closeOverlay("cancel"); else stopVoice();
    };
    // Chrome/Safari cortan tras silencio; si seguimos en modo escucha, reanuda.
    recognition.onend = () => { if (listening) { try { recognition.start(); } catch (_) {} } };

    micBtn.addEventListener("click", () => {
      if (isMobile()) { if (!overlayOpen) openOverlay(); }
      else (listening ? stopVoice() : startVoice());
    });

    // Botones del overlay móvil
    const vs = $("voice-send"), vp = $("voice-paste"), vc = $("voice-cancel");
    if (vs) vs.addEventListener("click", () => closeOverlay("send"));
    if (vp) vp.addEventListener("click", () => closeOverlay("paste"));
    if (vc) vc.addEventListener("click", () => closeOverlay("cancel"));
  }

  function onVoiceResult(ev) {
    if (overlayOpen) {
      voiceInterim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) voiceFinal += (voiceFinal && !/\s$/.test(voiceFinal) ? " " : "") + (r[0].transcript || "").trim();
        else voiceInterim += r[0].transcript || "";
      }
      const disp = $("voice-text");
      if (disp) disp.textContent = (voiceFinal + " " + voiceInterim).trim();
      return;
    }
    // Escritorio: teclea cada frase finalizada (con espacio) en la terminal.
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) {
        const txt = (ev.results[i][0].transcript || "").trim();
        if (txt && ws && ws.readyState === WebSocket.OPEN) ws.send(txt + " ");
      }
    }
  }

  // --- escritorio ---
  function startVoice() {
    if (!recognition) return;
    try { recognition.start(); listening = true; $("mic").classList.add("mic-on"); showToast("Escuchando… (toca el micro para parar)"); }
    catch (_) {}
  }
  function stopVoice() {
    listening = false;
    try { recognition.stop(); } catch (_) {}
    const m = $("mic"); if (m) m.classList.remove("mic-on");
  }

  // --- overlay móvil ---
  function openOverlay() {
    if (!recognition) return;
    voiceFinal = ""; voiceInterim = "";
    overlayOpen = true; listening = true;
    const disp = $("voice-text"); if (disp) disp.textContent = "Escuchando…";
    $("voice-overlay").classList.add("show");
    try { recognition.start(); } catch (_) {}
  }
  function closeOverlay(action) {
    overlayOpen = false; listening = false;
    try { recognition.stop(); } catch (_) {}
    $("voice-overlay").classList.remove("show");
    const txt = (voiceFinal + " " + voiceInterim).trim();
    voiceFinal = ""; voiceInterim = "";
    if (action !== "cancel" && txt && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(txt + " ");
      // El Enter debe ir en un envío aparte y con un pequeño retardo: si llega
      // pegado al texto, el shell/TUI (p.ej. Claude) no lo registra como intro.
      if (action === "send") {
        setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send("\r"); }, 150);
      }
    }
    if (term) term.focus();
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
    // Scroll con rueda: lo gestiona tmux. xterm.js convierte cada wheel en un SGR mouse
    // event que tmux recibe; con `set -g mouse on` + `bind -n WheelUpPane` entra en copy-mode
    // si no hay TUI activa, o reenvía al app (Claude, vim, htop) si la hay.
    // NO interceptar aquí: stopPropagation() en captura impide que xterm genere el escape
    // sequence, y `term.scrollLines()` opera sobre el buffer interno de xterm, no sobre
    // el scrollback visible de tmux.
    fitAddon.fit();
    requestAnimationFrame(() => { try { fitAddon.fit(); } catch (_) {} });
    term.onData((d) => {
      // Si el "Ctrl" de la barra está armado, aplica Ctrl a la siguiente tecla.
      if (ctrlPending && d.length === 1) { d = toCtrl(d); setCtrl(false); }
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
    });
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

    // --- Botón 📋 pegar texto del portapapeles (en móvil no hay Ctrl+V) ---
    $("paste").addEventListener("click", () => { pasteFromClipboard(); if (term) term.focus(); });

    // --- Botones 📷 foto / 🎥 vídeo / ⏹ parar ---
    $("screencap").addEventListener("click", captureScreen);
    $("screenrec").addEventListener("click", toggleRecord);
    $("cap-stop").addEventListener("click", () => { stopCapture(); showToast("Has dejado de compartir la pantalla"); });

    if (isMobile()) document.body.classList.add("is-mobile");
    setupKeybar();
    setupFiles();
    setupVoice();
    setupAI();
    _updateTabsUI();   // pinta la barra (sesión actual; se completa al conectar)

    // OSC 52: cuando tmux (o cualquier app) "copia", emite esta secuencia con el
    // texto en base64. La capturamos y la metemos en el portapapeles del navegador,
    // así seleccionar con el ratón dentro de tmux copia solo al soltar.
    try {
      term.parser.registerOscHandler(52, (data) => {
        const i = data.indexOf(";");
        const b64 = i >= 0 ? data.slice(i + 1) : data;
        try {
          const txt = decodeURIComponent(escape(atob(b64)));
          if (txt) navigator.clipboard.writeText(txt).catch(() => {});
        } catch (_) {}
        return true;
      });
    } catch (_) {}
  }

  // ---------- BARRA DE TECLAS ESPECIALES + VENTANAS TMUX ----------
  // Cada botón lleva data-seq con la secuencia cruda a enviar al PTY (flechas,
  // Esc, Tab, prefijos de tmux Ctrl-b=\x02…). "Ctrl" es un modificador pegajoso:
  // se pulsa y la SIGUIENTE tecla (de la barra o del teclado) sale como Ctrl+X.
  let ctrlPending = false;
  function setCtrl(on) {
    ctrlPending = on;
    const b = $("kb-ctrl"); if (b) b.classList.toggle("kb-active", on);
  }
  function sendRaw(s) { if (s && ws && ws.readyState === WebSocket.OPEN) ws.send(s); }
  // Convierte un carácter normal en su código de control (a->\x01 … z->\x1a, etc.)
  function toCtrl(ch) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // @ A-Z [ \ ] ^ _
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    return ch;
  }
  function setupKeybar() {
    const bar = $("keybar"); if (!bar) return;
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button.kb"); if (!btn) return;
      if (btn.id === "kb-ctrl") { setCtrl(!ctrlPending); return; }
      let seq = btn.getAttribute("data-seq") || "";
      if (ctrlPending && seq.length === 1) { seq = toCtrl(seq); setCtrl(false); }
      sendRaw(seq);
      if (term) term.focus();
    });
  }

  // ---------- SESIONES TMUX COMO PESTAÑAS (varias por usuario, solo las tuyas) ----------
  // El backend lista/mata SOLO las sesiones cuyo nombre empieza por tu prefijo de
  // email, así que nunca ves ni tocas las de otra persona. Cada sesión es una
  // PESTAÑA en la barra; cambiar de sesión = reconectar el WS pidiendo esa sesión
  // (tmux new-session -A la crea si no existe). _sessions guarda la lista real.
  let _sessions = [];   // [{label, current}]

  // Mismo saneado que el backend (_slug) para que cliente y servidor coincidan.
  function _slugLabel(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  // Marca optimista de la sesión actual (antes de que llegue la lista del backend).
  function _markCurrent(label) {
    const norm = label || "principal";
    let found = false;
    _sessions.forEach((s) => { s.current = (s.label === norm); if (s.current) found = true; });
    if (!found) _sessions.push({ label: norm, current: true });
  }
  // Recibe la lista del backend y repinta las pestañas.
  function renderSessions(list) {
    _sessions = Array.isArray(list) ? list : [];
    // Conserva la sesión del hueco secundario aunque el backend aún no la liste:
    // la "split" recién creada por T2 tarda un instante en aparecer en la lista,
    // y sin esto su pestaña parpadearía (aparece y desaparece) al reconciliar.
    if (_splitActive()) {
      const ss = _secSessionWanted();
      if (ss && !_sessions.some((s) => s.label === ss)) _sessions.push({ label: ss, current: false });
    }
    _updateTabsUI();
  }
  function requestSessions() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tmux-list" }));
  }
  function switchSession(label) {
    if (_splitActive()) { _routeSessionToFocus(label); return; }   // en split: al hueco enfocado
    currentSession = (label === "principal") ? null : label;
    _markCurrent(label);
    _activeTab = _TAB_TERM;
    _ensureTerminalVisible();
    if (term) try { term.reset(); } catch (_) {}
    reconnectNow();          // al reconectar (fsid) se vuelve a pedir la lista real
    _updateTabsUI();
  }
  function newSession() {
    const raw = window.prompt("Nombre de la nueva sesión (p.ej. logs, pruebas):", "");
    if (raw === null) return;
    const label = _slugLabel(raw.trim());
    if (!label) return;
    switchSession(label);
  }
  function killSession(label) {
    // Si esa sesión está en la 2ª terminal (T2), ciérrala primero: si no, T2 se
    // reconectaría y la recrearía (tmux new-session -A).
    if (T2.sessionLabel() === label) {
      T2.close();
      ["L", "R"].forEach((s) => { if (_slots[s].kind === "sec") _slots[s] = (_viewerTabs.size ? { kind: "viewer" } : { kind: "main" }); });
      if (_slots.L.kind === "main" && _slots.R.kind === "main") _split = false;   // sin 2º contenido: salir de split
      _applyPanes(); _updateTabsUI(); _refitPanes();
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tmux-kill", label }));
    // El backend responde con la lista ya actualizada (renderSessions).
  }
  // Reconexión inmediata e intencionada (cambiar de sesión), sin esperar backoff.
  function reconnectNow() {
    reconnectAttempts = 0;
    if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (_) {} ws = null; }
    connectWS();
  }

  // ---------- VISOR DE ARCHIVOS EN PESTAÑAS ----------
  // Cada vez que el usuario hace doble clic en un archivo de texto del explorador
  // lateral, abrimos una pestaña con su contenido. La pestaña "Terminal" es la
  // raíz y no se cierra; al cerrar la última pestaña de archivo volvemos a ella.
  const _TAB_TERM = "terminal";
  let _activeTab = _TAB_TERM;          // id de la pestaña activa (_TAB_TERM o tab.id)
  let _tabSeq = 0;                      // contador para ids únicos
  const _viewerTabs = new Map();        // id -> { id, name, path, content, dirty }
  let _editing = false;                 // ¿el visor está en modo edición?
  let _editTabId = null;                // id de la pestaña que se está editando
  let _tabsRestored = false;            // ¿ya reabrimos las pestañas de la sesión anterior?
  // Capturamos la lista guardada AHORA, al cargar el script, ANTES de que cualquier
  // _updateTabsUI (con el visor vacío) la sobrescriba con []. Restauramos desde aquí.
  const _savedTabs = (() => {
    try { const a = JSON.parse(localStorage.getItem("wt_open_tabs") || "[]"); return Array.isArray(a) ? a : []; }
    catch (_) { return []; }
  })();

  // Persistir/restaurar las pestañas de archivos abiertos entre RECARGAS de página
  // (las sesiones tmux vuelven solas; los archivos abiertos viven solo en memoria).
  function _persistOpenTabs() {
    if (!_tabsRestored) return;   // no guardes [] antes de restaurar (pisaría la lista)
    try {
      const arr = [];
      _viewerTabs.forEach((t) => { if (t.path) arr.push({ path: t.path, name: t.name }); });   // solo archivos (no previews)
      localStorage.setItem("wt_open_tabs", JSON.stringify(arr));
    } catch (_) {}
  }
  function _restoreOpenTabs() {
    if (_tabsRestored) return;     // solo en la 1ª conexión tras cargar la página
    _tabsRestored = true;
    _savedTabs.forEach((it) => { if (it && it.path) viewerOpenPath(it.path, it.name || it.path.split("/").pop(), 0); });
  }

  // Subconjunto "humano" de extensiones que tratamos como texto. Coincide con
  // el allowlist del backend (que es más exhaustivo y autoritativo): esto es
  // solo para el cursor y el mensaje de error del cliente.
  const _TEXT_EXTS_HINT = new Set([
    "md", "markdown", "txt", "text", "rst", "adoc", "org",
    "html", "htm", "xml", "svg", "rss", "atom", "xsl", "xslt",
    "json", "json5", "jsonc", "ndjson", "jsonl",
    "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
    "log", "csv", "tsv", "diff", "patch",
    "sh", "bash", "zsh", "fish", "ps1", "bat",
    "py", "rb", "rs", "go", "java", "kt", "kts", "scala",
    "c", "h", "cpp", "cc", "hpp", "m", "mm",
    "cs", "php", "pl", "lua", "vim", "sql", "graphql",
    "clj", "ex", "exs", "erl", "hs", "elm", "dart", "r", "swift",
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte", "astro",
    "css", "scss", "sass", "less",
  ]);

  function _isProbablyTextName(name) {
    const base = (name || "").toLowerCase();
    if (!base) return false;
    if (_TEXT_EXTS_HINT.has(base)) return true; // Dockerfile, Makefile, etc.
    const i = base.lastIndexOf(".");
    if (i < 0) return true; // sin extensión y pequeño -> se intentará
    return _TEXT_EXTS_HINT.has(base.slice(i + 1));
  }

  function _escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- Tamaño de fuente del visor (persistente) ----------
  let _viewerFont = 12.5;
  try { const f = parseFloat(localStorage.getItem("wt_viewer_font")); if (f >= 8 && f <= 40) _viewerFont = f; } catch (_) {}
  function _applyViewerFont() {
    const px = _viewerFont + "px";
    const pre = $("viewer-pre"); if (pre) pre.style.fontSize = px;
    // Editor: tamaño de fuente y line-height EN PÍXELES ENTEROS en el textarea y la
    // capa coloreada. Tamaño entero (no 12,5) para que el ancho de carácter no sea
    // fraccionario: si no, textarea y <pre> redondean distinto y el cursor se desvía.
    const epx = Math.round(_viewerFont) + "px";
    const lh = Math.round(Math.round(_viewerFont) * 1.55) + "px";
    ["viewer-edit-area", "viewer-edit-hl"].forEach((id) => {
      const el = $(id); if (el) { el.style.fontSize = epx; el.style.lineHeight = lh; }
    });
    // La vista Markdown es prosa, no monoespaciada: le damos un punto más para que respire.
    const md = $("viewer-md"); if (md) md.style.fontSize = (_viewerFont + 1) + "px";
  }
  function _bumpFont(delta) {
    _viewerFont = Math.min(40, Math.max(8, Math.round((_viewerFont + delta) * 10) / 10));
    try { localStorage.setItem("wt_viewer_font", String(_viewerFont)); } catch (_) {}
    _applyViewerFont();
    fsStatus("Texto a " + _viewerFont + "px", "ok");
  }

  // ---------- Render de Markdown (vista formateada / texto plano) ----------
  let _mdRendered = true;   // por defecto, los .md se ven formateados
  try { if (localStorage.getItem("wt_viewer_md") === "0") _mdRendered = false; } catch (_) {}
  function _isMd(tab) { return !!tab && tab.kind !== "image" && /\.(md|markdown|mdown|mkd)$/i.test(tab.name || ""); }
  const _IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]);
  function _isImageName(name) { const i = (name || "").lastIndexOf("."); return i >= 0 && _IMG_EXTS.has(name.slice(i + 1).toLowerCase()); }
  // URL de bytes crudos del archivo (token por query) — sirve para <img> y descargas.
  function _fileURL(path) { return "/files/download?fsid=" + encodeURIComponent(fsid) + "&path=" + encodeURIComponent(path) + "&token=" + encodeURIComponent(jwt); }
  // Muestra/oculta los botones que solo tienen sentido en archivos de texto.
  function _applyToolbarForTab(tab) {
    const isImg = !!tab && tab.kind === "image";
    const isPrev = !!tab && tab.kind === "preview";
    const hideText = isImg || isPrev;
    ["viewer-ai", "viewer-edit", "viewer-wrap", "viewer-copy", "viewer-font-dec", "viewer-font-inc"].forEach((id) => {
      const b = $(id); if (b) b.style.display = hideText ? "none" : "";
    });
    const dl = $("viewer-download"); if (dl) dl.style.display = isPrev ? "none" : "";   // preview no se descarga
    const runBtn = $("viewer-run"); if (runBtn) runBtn.hidden = !(tab && !hideText && _runnable(tab.name));
    const ext = $("viewer-openext"); if (ext) ext.hidden = !isPrev;                     // abrir en navegador: solo preview
  }
  // ---------- Ejecutar archivos en la terminal (.py, .sh, .js…) ----------
  const _RUN = {
    py: "python3", pyw: "python3", sh: "bash", bash: "bash", zsh: "zsh", js: "node",
    mjs: "node", ts: "ts-node", rb: "ruby", php: "php", pl: "perl", lua: "lua", r: "Rscript",
  };
  function _runnable(name) {
    const i = (name || "").lastIndexOf(".");
    return i >= 0 ? (_RUN[(name).slice(i + 1).toLowerCase()] || null) : null;
  }
  function _shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  const _RUN_SESSION = "run";   // sesión tmux dedicada a ejecutar (shell limpio, NO la de Claude)
  async function _runFile() {
    const tab = _viewerTabs.get(_activeTab);
    if (!tab || tab.kind === "image") return;
    const cmd = _runnable(tab.name);
    if (!cmd) { showToast("No sé cómo ejecutar este tipo de archivo", true); return; }
    // Si hay cambios sin guardar de este archivo, ofrecer guardar antes.
    if (_editing && _editTabId === tab.id) {
      const ta = $("viewer-edit-area");
      if (ta && ta.value !== tab.content && window.confirm("Hay cambios sin guardar. ¿Guardar antes de ejecutar?")) {
        await _saveEdit();
      }
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast("La terminal no está conectada", true); return; }
    const full = cmd + " " + _shQuote(tab.path) + "\r";

    if (window.innerWidth >= 640) {
      // Escritorio: ejecuta en una 2ª terminal LIMPIA (sesión "run") en el hueco de
      // al lado, sin tocar tu sesión activa (que puede tener Claude corriendo).
      _split = true;
      let runSlot;
      if (_slots.L.kind === "sec") { _slots.L.session = _RUN_SESSION; runSlot = "L"; }
      else if (_slots.R.kind === "sec") { _slots.R.session = _RUN_SESSION; runSlot = "R"; }
      else if (_slots.L.kind === "main") { _slots.R = { kind: "sec", session: _RUN_SESSION }; runSlot = "R"; }
      else if (_slots.R.kind === "main") { _slots.L = { kind: "sec", session: _RUN_SESSION }; runSlot = "L"; }
      else { _slots.L = { kind: "main" }; _slots.R = { kind: "sec", session: _RUN_SESSION }; runSlot = "R"; }
      _focusPane = runSlot;
      _applyPanes();          // conecta T2 a la sesión "run"
      T2.send(full);          // se ejecuta cuando el shell esté listo (búfer si hace falta)
      _updateTabsUI(); _refitPanes(); T2.focus();
      // Refresca la lista para que la sesión "run" salga como pestaña (con su ✕).
      setTimeout(requestSessions, 900);
    } else {
      // Móvil (sin sitio para dividir): cambia la terminal principal a la sesión
      // "run" (tu sesión de Claude sigue viva en tmux) y ejecuta allí.
      _setMainSession(_RUN_SESSION);
      _activeTab = _TAB_TERM; _ensureTerminalVisible();
      _sendToPrimaryWhenOpen(full);
      try { term && term.focus(); } catch (_) {}
    }
    showToast("Ejecutando " + tab.name + " en una terminal nueva");
  }
  // Manda un comando a la terminal principal en cuanto la conexión esté abierta
  // (tras un cambio de sesión/reconexión). Reintenta un rato y se rinde.
  function _sendToPrimaryWhenOpen(data, tries) {
    tries = tries || 0;
    if (ws && ws.readyState === WebSocket.OPEN) { setTimeout(() => { try { ws.send(data); } catch (_) {} }, 400); return; }
    if (tries > 40) return;
    setTimeout(() => _sendToPrimaryWhenOpen(data, tries + 1), 150);
  }
  function _escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Directorio base del .md en curso, para resolver rutas de imágenes relativas.
  let _mdBaseDir = "/";
  // Normaliza una ruta (resuelve "." y "..") sobre una base absoluta.
  function _joinPath(base, rel) {
    const parts = (base + "/" + rel).split("/");
    const out = [];
    for (const p of parts) {
      if (!p || p === ".") continue;
      if (p === "..") { out.pop(); continue; }
      out.push(p);
    }
    return "/" + out.join("/");
  }
  // Resuelve la URL de una imagen Markdown a algo servible bajo la CSP (self/data:).
  function _resolveMdImg(url) {
    url = (url || "").trim();
    if (/^\s*javascript:/i.test(url)) return "";
    if (/^data:/i.test(url)) return url;                 // data URI: permitido por CSP
    if (/^https?:\/\//i.test(url)) return url;           // externa: la CSP la bloqueará, pero no rompemos el render
    const path = url.startsWith("/") ? url : _joinPath(_mdBaseDir, url);
    return _fileURL(path);                               // bytes locales (mismo origen) → permitido
  }
  function _attr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
  // Formato en línea sobre texto YA escapado (negrita, cursiva, código, tachado, imágenes, enlaces).
  function _mdInline(t) {
    t = t.replace(/`([^`]+)`/g, (m, c) => "<code>" + c + "</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // Imágenes ANTES que los enlaces (la sintaxis ![alt](url) contiene [alt](url)).
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      const src = _resolveMdImg(url);
      if (!src) return alt;
      return '<img class="md-img" src="' + _attr(src) + '" alt="' + alt.replace(/"/g, "&quot;") + '" loading="lazy">';
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
      if (/^\s*javascript:/i.test(url)) return txt;   // sin esquemas peligrosos
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>";
    });
    return t;
  }
  // Conversor de bloques: cabeceras, listas, citas, hr, fences y párrafos.
  function _renderMarkdown(src, tab) {
    // Directorio del archivo .md para resolver imágenes relativas (![](img.png)).
    const p = tab && tab.path ? tab.path : "/";
    _mdBaseDir = p.slice(0, p.lastIndexOf("/")) || "/";
    const fences = [];
    src = src.replace(/\r\n/g, "\n").replace(/```[ \t]*[\w-]*\n?([\s\S]*?)```/g, (m, c) => {
      fences.push(c.replace(/\n$/, ""));
      return " F" + (fences.length - 1) + " ";
    });
    const out = [];
    let para = [], listType = null, listItems = [];
    const flushPara = () => { if (para.length) { out.push("<p>" + _mdInline(_escapeHtml(para.join(" ").trim())) + "</p>"); para = []; } };
    const flushList = () => { if (listType) { out.push("<" + listType + ">" + listItems.map(li => "<li>" + _mdInline(_escapeHtml(li)) + "</li>").join("") + "</" + listType + ">"); listType = null; listItems = []; } };
    const flushAll = () => { flushPara(); flushList(); };
    for (const line of src.split("\n")) {
      const fm = line.match(/^ F(\d+) $/);
      if (fm) { flushAll(); out.push("<pre class='md-code'><code>" + _escapeHtml(fences[+fm[1]]) + "</code></pre>"); continue; }
      if (/^\s*$/.test(line)) { flushAll(); continue; }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushAll(); out.push("<h" + h[1].length + ">" + _mdInline(_escapeHtml(h[2])) + "</h" + h[1].length + ">"); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue; }
      const bq = line.match(/^\s*>\s?(.*)$/);
      if (bq) { flushPara(); flushList(); out.push("<blockquote>" + _mdInline(_escapeHtml(bq[1])) + "</blockquote>"); continue; }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) { flushPara(); if (listType && listType !== "ul") flushList(); listType = "ul"; listItems.push(ul[1]); continue; }
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) { flushPara(); if (listType && listType !== "ol") flushList(); listType = "ol"; listItems.push(ol[1]); continue; }
      flushList(); para.push(line.trim());
    }
    flushAll();
    return out.join("\n");
  }
  // Decide qué panel del visor se ve (texto plano vs Markdown) según el archivo
  // y la preferencia _mdRendered. El botón MD solo aparece en archivos .md.
  function _applyViewMode(tab) {
    const pre = $("viewer-pre"), md = $("viewer-md"), btn = $("viewer-md-btn"), imgp = $("viewer-img"), ifr = $("viewer-iframe");
    if (_editing) return;   // editando manda el textarea; no tocamos paneles
    _applyToolbarForTab(tab);
    if (tab && tab.kind === "preview") {   // preview: solo el iframe
      if (pre) pre.hidden = true;
      if (md) md.hidden = true;
      if (imgp) imgp.hidden = true;
      if (ifr) ifr.hidden = false;
      if (btn) btn.hidden = true;
      return;
    }
    if (ifr) ifr.hidden = true;
    if (tab && tab.kind === "image") {   // imágenes: solo el panel <img>
      if (pre) pre.hidden = true;
      if (md) md.hidden = true;
      if (imgp) imgp.hidden = false;
      if (btn) btn.hidden = true;
      return;
    }
    if (imgp) imgp.hidden = true;
    const isMd = _isMd(tab);
    if (btn) btn.hidden = !isMd;
    if (isMd && _mdRendered) {
      if (md) { md.innerHTML = _renderMarkdown(tab.content, tab); md.hidden = false; }
      if (pre) pre.hidden = true;
      if (btn) { btn.classList.add("active"); btn.textContent = "TXT"; btn.title = "Ver texto plano"; }
    } else {
      if (md) md.hidden = true;
      if (pre) pre.hidden = false;
      if (btn) { btn.classList.remove("active"); btn.textContent = "MD"; btn.title = "Ver Markdown formateado"; }
    }
  }
  function _toggleMd() {
    const tab = _viewerTabs.get(_activeTab);
    if (!_isMd(tab)) return;
    _mdRendered = !_mdRendered;
    try { localStorage.setItem("wt_viewer_md", _mdRendered ? "1" : "0"); } catch (_) {}
    _applyViewMode(tab);
  }

  // ---------- Buscar en el archivo (Ctrl/Cmd+F) ----------
  // Opera sobre el texto plano del visor; resalta coincidencias en <mark> y
  // navega con Intro / Mayús+Intro. En .md fuerza la vista de texto mientras dura.
  let _findMatches = [], _findIdx = -1, _findActive = false;
  function _resetFind() {
    _findActive = false; _findMatches = []; _findIdx = -1;
    const bar = $("viewer-find"); if (bar) bar.hidden = true;
  }
  function _openFind() {
    const tab = _viewerTabs.get(_activeTab);
    if (!tab || _activeTab === _TAB_TERM || _editing || tab.kind === "image" || tab.kind === "preview") return;
    const pre = $("viewer-pre"), md = $("viewer-md");
    if (md) md.hidden = true;
    if (pre) pre.hidden = false;       // la búsqueda necesita el texto plano
    _findActive = true;
    const bar = $("viewer-find"); if (bar) bar.hidden = false;
    const inp = $("viewer-find-input");
    if (inp) { inp.focus(); inp.select(); _runFind(); }
  }
  function _closeFind() {
    _resetFind();
    const tab = _viewerTabs.get(_activeTab);
    if (tab) _renderViewer(tab);       // quita las marcas y restaura texto/Markdown
    if (term) try { term.focus(); } catch (_) {}
  }
  function _findCount() {
    const c = $("viewer-find-count"); if (!c) return;
    const q = $("viewer-find-input"); if (!q || !q.value) { c.textContent = ""; return; }
    c.textContent = _findMatches.length ? (_findIdx + 1) + " / " + _findMatches.length : "0 resultados";
  }
  function _runFind() {
    const tab = _viewerTabs.get(_activeTab); if (!tab) return;
    const code = $("viewer-code"); if (!code) return;
    const q = ($("viewer-find-input") || {}).value || "";
    if (!q) { code.textContent = tab.content; _findMatches = []; _findIdx = -1; _findCount(); return; }
    const text = tab.content, lc = text.toLowerCase(), ql = q.toLowerCase();
    const pos = []; let i = lc.indexOf(ql);
    while (i !== -1) { pos.push(i); i = lc.indexOf(ql, i + ql.length); }
    _findMatches = pos;
    if (!pos.length) { _findIdx = -1; code.textContent = text; _findCount(); return; }
    if (_findIdx < 0 || _findIdx >= pos.length) _findIdx = 0;
    let html = "", last = 0;
    pos.forEach((p, idx) => {
      html += _escapeHtml(text.slice(last, p));
      html += '<mark class="find-hit' + (idx === _findIdx ? " find-current" : "") + '">' + _escapeHtml(text.slice(p, p + q.length)) + "</mark>";
      last = p + q.length;
    });
    html += _escapeHtml(text.slice(last));
    code.innerHTML = html;
    _findCount();
    const cur = code.querySelector("mark.find-current");
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "center", inline: "nearest" });
  }
  function _findStep(delta) {
    if (!_findMatches.length) return;
    _findIdx = (_findIdx + delta + _findMatches.length) % _findMatches.length;
    _runFind();
  }

  // Resaltado de sintaxis (highlight.js local). Mapa extensión → lenguaje hljs.
  const _LANG = {
    py: "python", pyw: "python", js: "javascript", mjs: "javascript", cjs: "javascript",
    jsx: "javascript", ts: "typescript", tsx: "typescript", json: "json", html: "xml",
    htm: "xml", xml: "xml", svg: "xml", vue: "xml", css: "css", scss: "scss", less: "less",
    sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", md: "markdown",
    markdown: "markdown", sql: "sql", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp",
    hpp: "cpp", java: "java", kt: "kotlin", go: "go", rs: "rust", rb: "ruby", php: "php",
    pl: "perl", lua: "lua", r: "r", swift: "swift", toml: "ini", ini: "ini", cfg: "ini",
    conf: "ini", env: "ini", diff: "diff", patch: "diff", make: "makefile", dockerfile: "dockerfile",
  };
  function _hljsLang(name) {
    const base = (name || "").toLowerCase();
    if (base === "dockerfile") return "dockerfile";
    if (base === "makefile") return "makefile";
    const i = base.lastIndexOf(".");
    return i >= 0 ? _LANG[base.slice(i + 1)] : null;
  }
  function _maybeHighlight(code, tab) {
    if (typeof hljs === "undefined" || !tab.content || tab.content.length > 300000) return;
    const lang = _hljsLang(tab.name);
    if (!lang || !hljs.getLanguage(lang)) return;
    try {
      code.innerHTML = hljs.highlight(tab.content, { language: lang, ignoreIllegals: true }).value;
      code.classList.add("hljs");
    } catch (_) {}
  }

  // ---------- Editor con resaltado en vivo + sangría inteligente (PEP8 en .py) ----------
  // Pinta el contenido del textarea en la capa coloreada de detrás.
  function _syncEditorHL() {
    const ta = $("viewer-edit-area"), pre = $("viewer-edit-hl");
    if (!ta || !pre) return;
    const tab = _viewerTabs.get(_editTabId);
    const lang = tab ? _hljsLang(tab.name) : null;
    let val = ta.value;
    if (val.endsWith("\n")) val += " ";   // evita que la última línea descuadre el alto
    if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang) && val.length < 300000) {
      try { pre.className = "viewer-edit-hl hljs"; pre.innerHTML = hljs.highlight(val, { language: lang, ignoreIllegals: true }).value; return; }
      catch (_) {}
    }
    pre.className = "viewer-edit-hl"; pre.textContent = val;
  }
  function _syncEditorScroll() {
    const ta = $("viewer-edit-area"), hl = $("viewer-edit-hl");
    if (ta && hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; }
  }
  // Unidad de sangría: PEP8 = 4 espacios en Python; 2 en el resto. Nunca tabuladores.
  function _indentUnit(tab) { return (tab && _hljsLang(tab.name) === "python") ? "    " : "  "; }
  function _afterManualEdit() {
    _syncEditorHL(); _syncEditorScroll();
    const tab = _viewerTabs.get(_editTabId);
    if (tab) { const ta = $("viewer-edit-area"); if (ta && ta.value !== tab.content) _saveDraft(tab, ta.value); }
  }
  function _editorKeydown(e) {
    if (e.key === "Tab" || e.key === "Enter") {
      const ta = e.target, tab = _viewerTabs.get(_editTabId), unit = _indentUnit(tab);
      if (e.key === "Tab") {
        e.preventDefault();
        if (ta.selectionStart !== ta.selectionEnd) { _indentLines(ta, unit, e.shiftKey); _afterManualEdit(); }
        else if (e.shiftKey) { _dedentCaret(ta, unit); _afterManualEdit(); }
        else { document.execCommand("insertText", false, unit); }   // insertText conserva deshacer
      } else {   // Enter: copia la sangría de la línea y añade un nivel tras ':' o apertura de bloque
        e.preventDefault();
        const v = ta.value, pos = ta.selectionStart;
        const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
        const before = v.slice(lineStart, pos);
        const indent = (before.match(/^[ \t]*/) || [""])[0];
        const extra = /[:\{\[\(]$/.test(before.replace(/\s+$/, "")) ? unit : "";   // tras ':' o apertura de bloque
        document.execCommand("insertText", false, "\n" + indent + extra);
      }
    }
  }
  // Sangra/desangra todas las líneas de la selección.
  function _indentLines(ta, unit, dedent) {
    const v = ta.value, selEnd = ta.selectionEnd;
    const startLine = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    const region = v.slice(startLine, selEnd), after = v.slice(selEnd);
    const lines = region.split("\n");
    let total = 0, first = 0;
    const out = lines.map((ln, i) => {
      if (dedent) {
        const m = (ln.match(/^[ \t]+/) || [""])[0];
        const rm = Math.min(unit.length, m.length);
        if (i === 0) first = -rm; total -= rm;
        return ln.slice(rm);
      }
      if (i === 0) first = unit.length; total += unit.length;
      return ln === "" ? ln : unit + ln;
    });
    ta.value = v.slice(0, startLine) + out.join("\n") + after;
    ta.selectionStart = Math.max(startLine, ta.selectionStart + first);
    ta.selectionEnd = selEnd + total;
  }
  // Shift+Tab sin selección: quita un nivel al principio de la línea del cursor.
  function _dedentCaret(ta, unit) {
    const v = ta.value, pos = ta.selectionStart;
    const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
    const lead = (v.slice(lineStart).match(/^[ \t]+/) || [""])[0];
    const rm = Math.min(unit.length, lead.length);
    if (!rm) return;
    ta.value = v.slice(0, lineStart) + v.slice(lineStart + rm);
    const np = Math.max(lineStart, pos - rm);
    ta.selectionStart = ta.selectionEnd = np;
  }

  function _renderViewer(tab) {
    if (!tab) return;
    _lastViewerId = tab.id;   // recordamos el último archivo visto (para el split)
    if (tab.kind === "preview") {   // webapp local en iframe
      const f = $("viewer-iframe");
      if (f && f.dataset.port !== String(tab.port)) { f.src = tab.url; f.dataset.port = String(tab.port); }
      $("viewer-name").textContent = tab.name;
      $("viewer-meta").textContent = "127.0.0.1:" + tab.port;
      _applyViewMode(tab);
      return;
    }
    if (tab.kind === "image") {     // archivos de imagen: panel <img>, sin gutter ni texto
      const img = $("viewer-img-el");
      if (img) { img.src = tab.url; img.alt = tab.name; }
      $("viewer-name").textContent = tab.name;
      $("viewer-meta").textContent = (tab.size ? humanSize(tab.size) + " · " : "") + tab.path;
      _applyViewMode(tab);
      return;
    }
    const code = $("viewer-code"); if (!code) return;
    const gut = $("viewer-gutter");
    // Texto crudo, escapado, con \n conservado (white-space: pre).
    code.classList.remove("hljs");
    code.textContent = tab.content;
    _maybeHighlight(code, tab);   // colorea por tipo de archivo si hay lenguaje conocido
    // Numerar líneas: una <span> por línea para que el wrap no rompa la alineación.
    const n = tab.content.length ? tab.content.split("\n").length : 1;
    const lines = new Array(n);
    for (let i = 0; i < n; i++) lines[i] = (i + 1);
    gut.textContent = lines.join("\n");
    $("viewer-name").textContent = tab.name;
    $("viewer-meta").textContent = humanSize(tab.content.length) + " · " + tab.path;
    _applyViewMode(tab);
    _applyViewerFont();
  }

  function humanSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  // ---------- Segunda terminal (autónoma, para el hueco derecho en split) -------
  // NO toca fsid, lista de sesiones ni estado global: solo conecta a una sesión
  // tmux, pinta, teclea y se redimensiona. Conexión perezosa; se cierra al salir.
  const T2 = (function () {
    let t = null, fit = null, ws2 = null, sess = null, recon = 0, rTimer = null, closed = true, pending = "";
    function ensure() {
      if (t) return;
      t = new Terminal({
        theme: { background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
          black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#6272a4",
          magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2" },
        fontFamily: "'JetBrains Mono', monospace", fontSize: 14, lineHeight: 1.0,
        scrollSensitivity: 3, cursorBlink: true, cursorStyle: "block", scrollback: 10000, allowProposedApi: true,
      });
      fit = new FitAddon.FitAddon();
      t.loadAddon(fit);
      t.loadAddon(new WebLinksAddon.WebLinksAddon());
      t.open($("terminal-container-2"));
      t.onData((d) => { if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(d); });
      t.onSelectionChange(() => { const s = t.getSelection(); if (s) navigator.clipboard.writeText(s).catch(() => {}); });
    }
    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws2 = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(jwt)}`);
      ws2.binaryType = "arraybuffer";
      ws2.onopen = () => {
        recon = 0;
        ws2.send(JSON.stringify({ ssh_user: sshUser, password: sshPassword, session: sess || undefined }));
        fitNow(); t.focus();
        // Comando en cola (p.ej. ejecutar un archivo): se manda cuando el shell ya está.
        if (pending) { const p = pending; pending = ""; setTimeout(() => { if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(p); }, 500); }
      };
      ws2.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) { t.write(new Uint8Array(ev.data)); return; }
        if (ev.data && ev.data[0] === "{") { try { const m = JSON.parse(ev.data); if (m && (m.type === "tmux-sessions" || m.type === "fsid")) return; } catch (_) {} }
        t.write(ev.data);
      };
      ws2.onclose = (ev) => {
        if (closed) return;
        const c = ev ? ev.code : 0;
        if (c === 4401 || c === 4403 || c === 4429 || c === 4400) return;   // credenciales: no reintentar
        rTimer = setTimeout(connect, Math.min(15000, 1000 * Math.pow(2, recon++)));
      };
      ws2.onerror = () => { try { ws2.close(); } catch (_) {} };
    }
    function fitNow() {
      if (!fit || !t) return;
      try { fit.fit(); if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows })); } catch (_) {}
    }
    return {
      attach(session) {
        ensure();
        const ns = (session === "principal") ? null : session;
        if (sess === ns && ws2 && !closed) { fitNow(); return; }
        sess = ns; closed = false; clearTimeout(rTimer);
        if (ws2) { try { ws2.onclose = null; ws2.close(); } catch (_) {} ws2 = null; }
        connect();
      },
      sessionLabel() { return sess === null ? "principal" : sess; },
      fit: fitNow,
      focus() { if (t) t.focus(); },
      // Manda datos al PTY de la 2ª terminal; si aún no está abierta, los encola.
      send(data) { if (ws2 && ws2.readyState === WebSocket.OPEN) ws2.send(data); else pending += data; },
      close() { closed = true; clearTimeout(rTimer); pending = ""; if (ws2) { try { ws2.onclose = null; ws2.close(); } catch (_) {} ws2 = null; } sess = null; },
    };
  })();

  // ---------- Vista dividida: dos huecos genéricos (terminal y/o archivo) -------
  // Cada hueco (L/R) muestra UNO de tres "inquilinos": terminal principal (main),
  // segunda terminal (sec) o el visor (viewer). Uno tiene el foco; al pulsar una
  // pestaña, su contenido se carga en el hueco enfocado.
  // _split NO se auto-restaura entre recargas (se activa a mano, con las sesiones
  // ya cargadas) para no abrir un hueco de visor vacío al cargar la página.
  let _split = false, _lastViewerId = null;
  let _slots = { L: { kind: "main" }, R: { kind: "viewer" } };
  let _focusPane = "R";
  function _splitActive() { return _split && window.innerWidth >= 640; }
  // Mantiene el estado de los huecos coherente (sin 'viewer' sin archivos, sin
  // dos motores iguales colisionando).
  function _normalizeSlots() {
    if (_viewerTabs.size === 0) {
      ["L", "R"].forEach((s) => { if (_slots[s].kind === "viewer") _slots[s] = { kind: "main" }; });
    }
    if (_slots.L.kind === _slots.R.kind && _slots.L.kind === "main") {
      _slots.R = { kind: "sec", session: _otherSession() };
    }
    if (_slots.L.kind === _slots.R.kind && _slots.L.kind === "sec") {
      _slots.L = { kind: "main" };
    }
  }
  function _otherSlot(s) { return s === "L" ? "R" : "L"; }
  function _slotEl(desc) {
    if (!desc) return null;
    if (desc.kind === "viewer") return $("viewer");
    if (desc.kind === "sec") return $("terminal-container-2");
    return $("terminal-container");
  }
  function _secSessionWanted() {
    if (_slots.L.kind === "sec") return _slots.L.session;
    if (_slots.R.kind === "sec") return _slots.R.session;
    return null;
  }
  // Garantiza que la sesión del hueco secundario tenga su pestaña. La "split"
  // que se auto-crea al duplicar pantalla con un solo tmux no llega por la lista
  // del backend hasta que T2 la crea (new-session -A); la añadimos optimistamente
  // para que la pestaña salga al instante y pedimos la lista real para reconciliar.
  function _ensureSecSessionTab(label) {
    if (!label) return;
    if (_sessions.some((s) => s.label === label)) return;
    _sessions.push({ label, current: false });
    _updateTabsUI();
    requestSessions();
  }
  function _otherSession() {
    const cur = currentSession || "principal";
    for (const s of _sessions) { if (s.label && s.label !== cur) return s.label; }
    return "split";   // ninguna distinta: el backend crea la sesión con new-session -A
  }
  function _setMainSession(label) {
    if (label === (currentSession || "principal") && term) return;   // ya es esa: no reconectar
    currentSession = (label === "principal") ? null : label;
    _markCurrent(label);
    if (term) try { term.reset(); } catch (_) {}
    reconnectNow();
  }
  function _applyFocusOutline() {
    const focusEl = _splitActive() ? _slotEl(_slots[_focusPane]) : null;
    [$("terminal-container"), $("terminal-container-2"), $("viewer")].forEach((el) => { if (el) el.classList.toggle("pane-focus", el === focusEl); });
  }
  // Reconcilia el DOM (layout + visibilidad + motores) con el estado de los huecos.
  function _applyPanes() {
    const P = $("terminal-container"), S = $("terminal-container-2"), V = $("viewer"), div = $("panes-divider"), panes = $("panes");
    const split = _splitActive();
    if (panes) panes.classList.toggle("split", split);
    if (div) div.hidden = !split;
    const btn = $("split-btn"); if (btn) btn.classList.toggle("active", split);
    if (!split) {                       // pantalla completa: comportamiento clásico
      T2.close(); if (S) S.hidden = true;
      [P, S, V].forEach((el) => el && el.classList.remove("pane-focus"));
      const onTerm = _activeTab === _TAB_TERM || _viewerTabs.size === 0;
      if (P) P.style.display = onTerm ? "" : "none";
      if (V) V.hidden = onTerm;
      return;
    }
    _normalizeSlots();
    const kinds = [_slots.L.kind, _slots.R.kind];
    const usesMain = kinds.includes("main"), usesSec = kinds.includes("sec"), usesViewer = kinds.includes("viewer");
    if (P) P.style.display = usesMain ? "" : "none";   // la principal sigue conectada aunque se oculte (da el fsid)
    if (S) S.hidden = !usesSec;
    if (V) V.hidden = !usesViewer;
    if (usesSec) { const ss = _secSessionWanted(); T2.attach(ss); _ensureSecSessionTab(ss); } else T2.close();
    // Orden DOM = orden visual. CLAVE: los elementos NO usados (ocultos) van al
    // final; si no, uno de ellos queda como :first-child y el `flex: var(--split)`
    // (que apunta a *:first-child) se aplicaría al panel oculto → no redimensiona.
    if (panes) {
      const Lel = _slotEl(_slots.L), Rel = _slotEl(_slots.R);
      const unused = [P, S, V].filter((el) => el && el !== Lel && el !== Rel);
      panes.append(Lel, div, Rel, ...unused);
    }
    _applyFocusOutline();
  }
  function _ensureTerminalVisible() { _applyPanes(); }
  function _ensureViewerVisible() { _applyPanes(); }

  // ---------- Preview de webapp local (iframe → proxy a 127.0.0.1:PUERTO) ----------
  async function _openPreview() {
    let last = "8000";
    try { last = localStorage.getItem("wt_preview_port") || "8000"; } catch (_) {}
    const raw = window.prompt("Puerto local de tu webapp (127.0.0.1:PUERTO):", last);
    if (raw === null) return;
    const port = parseInt(String(raw).trim(), 10);
    if (!(port >= 1 && port <= 65535)) { showToast("Puerto no válido", true); return; }
    try { localStorage.setItem("wt_preview_port", String(port)); } catch (_) {}
    // Autorizar el iframe (deja una cookie de preview).
    try {
      const r = await fetch("/preview/auth", { method: "POST", headers: { Authorization: "Bearer " + jwt } });
      if (!r.ok) { showToast("No autorizado para el preview", true); return; }
    } catch (_) { showToast("Error de red al abrir el preview", true); return; }
    // Reutiliza la pestaña si ya hay un preview de ese puerto.
    for (const t of _viewerTabs.values()) if (t.kind === "preview" && t.port === port) { switchTab(t.id); return; }
    const id = "v" + (++_tabSeq);
    _viewerTabs.set(id, { id, kind: "preview", port, name: "Preview :" + port, url: "/preview/" + port + "/", content: "" });
    if (_splitActive()) { _routeFileToFocus(id); }
    else { _activeTab = id; _ensureViewerVisible(); _renderViewer(_viewerTabs.get(id)); _updateTabsUI(); }
    showToast("Preview del puerto " + port);
  }
  function _openExternal() {
    const t = _viewerTabs.get(_activeTab);
    if (t && t.kind === "preview") window.open(t.url, "_blank", "noopener");
  }

  // ---------- Modal/lightbox de imagen a pantalla completa ----------
  // Lightbox: estado de galería (lista de {url,name} e índice actual; null = imagen suelta).
  let _lbList = null, _lbIdx = 0;
  function _openImgModal(url, alt, list, idx) {
    const m = $("img-modal"), im = $("img-modal-el");
    if (!m || !im) return;
    _lbList = (Array.isArray(list) && list.length > 1) ? list : null;
    _lbIdx = _lbList ? (idx | 0) : 0;
    im.src = url; im.alt = alt || ""; m.classList.remove("zoomed"); m.hidden = false;
    _updateLbNav();
  }
  function _closeImgModal() { const m = $("img-modal"); if (m) { m.hidden = true; const im = $("img-modal-el"); if (im) im.src = ""; } _lbList = null; }
  function _updateLbNav() {
    const has = !!_lbList;
    const prev = $("img-modal-prev"), next = $("img-modal-next"), counter = $("img-modal-counter");
    if (prev) prev.hidden = !has;
    if (next) next.hidden = !has;
    if (counter) { counter.hidden = !has; if (has) counter.textContent = (_lbIdx + 1) + " / " + _lbList.length; }
  }
  function _lbStep(delta) {
    if (!_lbList) return;
    _lbIdx = (_lbIdx + delta + _lbList.length) % _lbList.length;
    const it = _lbList[_lbIdx], im = $("img-modal-el"), m = $("img-modal");
    if (im) { im.src = it.url; im.alt = it.name || ""; }
    if (m) m.classList.remove("zoomed");
    _updateLbNav();
  }
  function _setupImgModal() {
    const m = $("img-modal"), im = $("img-modal-el"), close = $("img-modal-close"), viewerImg = $("viewer-img-el"), md = $("viewer-md");
    if (viewerImg) viewerImg.addEventListener("click", () => { const t = _viewerTabs.get(_activeTab); _openImgModal((t && t.url) || viewerImg.src, t && t.name); });
    // Imágenes embebidas en un Markdown: clic → lightbox con galería del documento.
    if (md) md.addEventListener("click", (e) => {
      const img = e.target && e.target.closest ? e.target.closest("img") : null;
      if (!img || !md.contains(img)) return;
      const all = Array.from(md.querySelectorAll("img"));
      const list = all.map((x) => ({ url: x.src, name: x.alt || "" }));
      const idx = all.indexOf(img);
      _openImgModal(img.src, img.alt, list, idx < 0 ? 0 : idx);
    });
    if (im) im.addEventListener("click", (e) => { e.stopPropagation(); m.classList.toggle("zoomed"); });   // clic en la imagen: zoom 1:1 / ajustar
    if (m) m.addEventListener("click", _closeImgModal);   // clic en el fondo: cerrar
    if (close) close.addEventListener("click", (e) => { e.stopPropagation(); _closeImgModal(); });
    const prev = $("img-modal-prev"), next = $("img-modal-next");
    if (prev) prev.addEventListener("click", (e) => { e.stopPropagation(); _lbStep(-1); });
    if (next) next.addEventListener("click", (e) => { e.stopPropagation(); _lbStep(1); });
    document.addEventListener("keydown", (e) => {
      if (!m || m.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); _closeImgModal(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); _lbStep(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); _lbStep(1); }
    });
  }
  // Abre una imagen del explorador en el lightbox, con galería = imágenes de la carpeta.
  function _openImgFromFolder(d, fullPath) {
    const imgs = d.items.filter((x) => !x.dir && _isImageName(x.name))
      .map((x) => { const fp = fsJoin(d.path, x.name); return { url: _fileURL(fp), name: x.name, path: fp }; });
    let idx = imgs.findIndex((x) => x.path === fullPath);
    if (idx < 0) idx = 0;
    if (imgs.length) _openImgModal(imgs[idx].url, imgs[idx].name, imgs, idx);
  }
  function _refitPanes() { fsRefit(); T2.fit(); }

  // Carga una SESIÓN tmux en el hueco enfocado (elige motor main/sec).
  function _routeSessionToFocus(label) {
    const F = _focusPane, other = _otherSlot(F), ok = _slots[other].kind;
    let kind;
    if (ok === "main") kind = "sec";
    else if (ok === "sec") kind = "main";
    else kind = (_slots[F].kind === "sec") ? "sec" : "main";   // el otro es visor
    if (kind === "main") { _slots[F] = { kind: "main" }; _setMainSession(label); }
    else { _slots[F] = { kind: "sec", session: label }; }
    _activeTab = _TAB_TERM;
    _applyPanes(); _updateTabsUI(); _refitPanes();
    if (kind === "sec") T2.focus(); else { try { term && term.focus(); } catch (_) {} }
  }
  // Carga un ARCHIVO (pestaña de visor) en el hueco enfocado.
  function _routeFileToFocus(id) {
    const F = _focusPane, other = _otherSlot(F);
    if (_slots[other].kind === "viewer") _slots[other] = { kind: "main" };   // no caben dos visores
    _slots[F] = { kind: "viewer" };
    _activeTab = id;
    _renderViewer(_viewerTabs.get(id));
    _applyPanes(); _updateTabsUI(); _refitPanes();
  }
  function _toggleSplit() {
    _split = !_split;
    if (_split) {
      if (_viewerTabs.size > 0) { _slots = { L: { kind: "main" }, R: { kind: "viewer" } }; }
      else { _slots = { L: { kind: "main" }, R: { kind: "sec", session: _otherSession() } }; }
      _focusPane = "R";
      _applyPanes();
      if (_slots.R.kind === "viewer") { const lv = _viewerTabs.get(_lastViewerId) || _viewerTabs.values().next().value; if (lv) { _activeTab = lv.id; _renderViewer(lv); } }
    } else {
      _slots = { L: { kind: "main" }, R: { kind: "viewer" } };
      _applyPanes();
    }
    _refitPanes();
  }
  // Clic en un hueco = enfocarlo (ahí irá la siguiente pestaña que pulses).
  function _setupPaneFocus() {
    const map = [["terminal-container"], ["terminal-container-2"], ["viewer"]];
    map.forEach(([id]) => {
      const el = $(id);
      if (el) el.addEventListener("mousedown", () => {
        if (!_splitActive()) return;
        _focusPane = (_slotEl(_slots.L) === el) ? "L" : "R";
        _applyFocusOutline();
        _updateTabsUI();   // recolorea la pestaña azul del hueco enfocado
      }, true);
    });
  }
  function _setupSplitDrag() {
    const div = $("panes-divider"), panes = $("panes");
    if (!div || !panes) return;
    let dragging = false;
    const onMove = (clientX) => {
      const r = panes.getBoundingClientRect();
      let pct = ((clientX - r.left) / r.width) * 100;
      pct = Math.max(20, Math.min(80, pct));
      const snap = Math.abs(pct - 50) <= 3;   // imán: cerca del centro, ancla al 50/50
      if (snap) pct = 50;
      div.classList.toggle("snapped", snap);
      panes.style.setProperty("--split", pct + "%");
      _refitPanes();
    };
    const start = (e) => {
      dragging = true;
      div.classList.add("dragging"); panes.classList.add("dragging");
      document.body.style.userSelect = "none"; document.body.style.cursor = "col-resize";
      e.preventDefault();
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      div.classList.remove("dragging", "snapped"); panes.classList.remove("dragging");
      document.body.style.userSelect = ""; document.body.style.cursor = "";
      _refitPanes();
    };
    // Doble clic en el divisor = volver al reparto igual (50/50).
    div.addEventListener("dblclick", () => { panes.style.setProperty("--split", "50%"); _refitPanes(); });
    // Ratón
    div.addEventListener("mousedown", start);
    window.addEventListener("mousemove", (e) => { if (dragging) onMove(e.clientX); });
    window.addEventListener("mouseup", end);
    // Táctil (tablet)
    div.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("touchmove", (e) => { if (dragging && e.touches[0]) { onMove(e.touches[0].clientX); e.preventDefault(); } }, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("resize", () => { if (_split) { _applyPanes(); _refitPanes(); } });
  }

  // Devuelve el markup de un icono del sprite local (#icon-sprite en index.html).
  // Mismo aspecto en todos los navegadores/SO (no son emojis del sistema).
  function icon(name) { return '<svg class="ic"><use href="#ic-' + name + '"/></svg>'; }

  // Qué pestaña marcar según el hueco con FOCO (azul fuerte) y el otro hueco
  // visible en split (azul tenue). Devuelve {main, secLabel, fileId}.
  function _slotTabInfo(desc) {
    if (!desc) return {};
    if (desc.kind === "viewer") return { fileId: _lastViewerId };
    if (desc.kind === "sec") return { secLabel: desc.session };
    return { main: true };
  }
  function _updateTabsUI() {
    const bar = $("tabs"); if (!bar) return;
    // Limpia y vuelve a pintar (pocas pestañas, es barato y robusto).
    bar.innerHTML = "";
    // Estado de foco para colorear pestañas.
    let fMain = false, fSec = null, fFile = null, sMain = false, sSec = null, sFile = null;
    if (_splitActive()) {
      const f = _slotTabInfo(_slots[_focusPane]), o = _slotTabInfo(_slots[_otherSlot(_focusPane)]);
      fMain = !!f.main; fSec = f.secLabel || null; fFile = f.fileId || null;
      sMain = !!o.main; sSec = o.secLabel || null; sFile = o.fileId || null;
    } else if (_activeTab === _TAB_TERM) { fMain = true; }
    else { fFile = _activeTab; }
    const sessCls = (s) => (fMain && s.current) || (fSec && s.label === fSec) ? " tab-active"
      : (sMain && s.current) || (sSec && s.label === sSec) ? " tab-shown" : "";
    const fileCls = (id) => fFile === id ? " tab-active" : sFile === id ? " tab-shown" : "";

    // --- una pestaña por SESIÓN tmux (fallback: la actual mientras llega la lista) ---
    const sessions = _sessions.length ? _sessions
      : [{ label: currentSession || "principal", current: true }];
    sessions.forEach((s) => {
      const el = document.createElement("div");
      el.className = "tab" + sessCls(s);
      el.dataset.tab = "term:" + s.label;
      el.title = "Sesión tmux: " + s.label + (s.current ? " (actual)" : "");
      el.innerHTML = '<span class="tab-ico">' + icon("terminal") + '</span><span class="tab-name"></span>';
      el.querySelector(".tab-name").textContent = s.label;
      if (!s.current) {   // solo se puede cerrar una sesión que no sea la actual
        const x = document.createElement("button");
        x.className = "tab-close"; x.innerHTML = icon("x"); x.title = "Cerrar esta sesión";
        x.addEventListener("click", (e) => { e.stopPropagation(); killSession(s.label); });
        el.appendChild(x);
      }
      el.addEventListener("click", (e) => {
        if (e.target.closest(".tab-close")) return;
        if (s.current) switchTab(_TAB_TERM); else switchSession(s.label);
      });
      bar.appendChild(el);
    });

    // --- botón "＋" para crear una sesión tmux nueva (en pestaña) ---
    const plus = document.createElement("div");
    plus.className = "tab tab-new"; plus.title = "Nueva sesión tmux";
    plus.innerHTML = '<span class="tab-ico">' + icon("plus") + '</span>';
    plus.addEventListener("click", newSession);
    bar.appendChild(plus);

    // --- pestañas de VISORES de archivos ---
    _viewerTabs.forEach((t) => {
      const el = document.createElement("div");
      el.className = "tab" + fileCls(t.id);
      el.dataset.tab = t.id;
      el.title = t.path;
      el.innerHTML =
        '<span class="tab-ico">' + icon("file-text") + '</span>' +
        '<span class="tab-name"></span>' +
        '<button class="tab-close" title="Cerrar pestaña">' + icon("x") + '</button>';
      el.querySelector(".tab-name").textContent = t.name;
      el.addEventListener("click", (e) => {
        if (e.target.closest(".tab-close")) return;
        switchTab(t.id);
      });
      el.querySelector(".tab-close").addEventListener("click", (e) => {
        e.stopPropagation();
        closeViewerTab(t.id);
      });
      bar.appendChild(el);
    });
    _persistOpenTabs();   // recuerda los archivos abiertos para reabrirlos tras recargar
  }

  function switchTab(id) {
    if (id !== _TAB_TERM && !_viewerTabs.has(id)) return;
    if (!_tryExitEdit()) return;   // cambios sin guardar → confirmar antes de salir
    if (_findActive) _resetFind();
    // En split, la pestaña pulsada se carga en el hueco enfocado.
    if (_splitActive()) {
      if (id === _TAB_TERM) _routeSessionToFocus(currentSession || "principal");
      else _routeFileToFocus(id);
      return;
    }
    _activeTab = id;
    if (id === _TAB_TERM) {
      _ensureTerminalVisible();
      // Reencajar la terminal: el panel creció a la izquierda/derecha al abrir
      // el sidebar de archivos, pero al volver no cambia. Aún así forzamos un
      // fit por si el contenedor cambió de tamaño al ocultarse el visor.
      fsRefit();
      try { term && term.focus(); } catch (_) {}
    } else {
      _ensureViewerVisible();
      _renderViewer(_viewerTabs.get(id));
    }
    _updateTabsUI();
  }

  function closeViewerTab(id) {
    if (_editing && _editTabId === id && !_tryExitEdit()) return;
    if (_findActive) _resetFind();
    const wasActive = _activeTab === id;
    _viewerTabs.delete(id);
    // En split: si el hueco del visor se queda sin archivos, conviértelo en terminal.
    if (_splitActive() && _viewerTabs.size === 0) {
      if (_slots.L.kind === "viewer") _slots.L = { kind: "main" };
      if (_slots.R.kind === "viewer") _slots.R = { kind: "main" };
      _activeTab = _TAB_TERM;
      _applyPanes(); _updateTabsUI(); _refitPanes();
      return;
    }
    if (_splitActive()) {   // quedan archivos: muestra otro en el hueco del visor
      const next = _viewerTabs.keys().next();
      if (!next.done) { _activeTab = next.value; _renderViewer(_viewerTabs.get(next.value)); }
      _applyPanes(); _updateTabsUI();
      return;
    }
    if (wasActive) {
      // Si quedan otras pestañas de visor, activa la primera; si no, vuelve a Terminal.
      const next = _viewerTabs.keys().next();
      _activeTab = next.done ? _TAB_TERM : next.value;
    }
    if (_activeTab === _TAB_TERM) _ensureTerminalVisible(); else _renderViewer(_viewerTabs.get(_activeTab));
    if (_viewerTabs.size === 0) _ensureTerminalVisible();
    _updateTabsUI();
    if (_activeTab === _TAB_TERM) { fsRefit(); try { term && term.focus(); } catch (_) {} }
  }

  // API pública: abre un archivo de texto en una pestaña nueva (o activa la
  // existente si ya está abierto ese mismo path).
  async function viewerOpenPath(path, name, sizeHint) {
    if (!_tryExitEdit()) return;   // no abrir otro archivo con cambios sin guardar
    if (!fsid) { fsStatus("Abre la terminal primero (el visor usa tu sesión SSH).", "err"); return; }
    // ¿Ya hay una pestaña abierta con este path? Reutilízala.
    for (const t of _viewerTabs.values()) if (t.path === path) { switchTab(t.id); fsStatus("'" + name + "' ya estaba abierto ✓", "ok"); return; }
    // Imágenes: panel <img> directo (no pasa por /files/read, que rechaza binarios).
    if (_isImageName(name)) {
      const id = "v" + (++_tabSeq);
      _viewerTabs.set(id, { id, name, path, kind: "image", url: _fileURL(path), size: sizeHint || 0, content: "" });
      if (_splitActive()) { _routeFileToFocus(id); }
      else { _activeTab = id; _ensureViewerVisible(); _renderViewer(_viewerTabs.get(id)); _updateTabsUI(); }
      fsStatus("Imagen '" + name + "' ✓", "ok");
      return;
    }
    if (!_isProbablyTextName(name)) {
      // Dejamos que el backend sea quien diga la última palabra, pero avisamos
      // al usuario de que igual no es texto.
      fsStatus("Comprobando si '" + name + "' es texto…");
    } else {
      fsStatus("Abriendo '" + name + "'…");
    }
    try {
      const res = await fetch("/files/read?fsid=" + encodeURIComponent(fsid) + "&path=" + encodeURIComponent(path), { headers: fsHeaders() });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { fsStatus(d.detail || ("Error " + res.status), "err"); return; }
      const id = "v" + (++_tabSeq);
      _viewerTabs.set(id, { id, name: d.name || name, path, content: d.content || "", mtime: d.mtime || 0 });
      if (_splitActive()) { _routeFileToFocus(id); }
      else { _activeTab = id; _ensureViewerVisible(); _renderViewer(_viewerTabs.get(id)); _updateTabsUI(); }
      fsStatus("Abierto '" + d.name + "' ✓", "ok");
      // ¿Quedó un borrador sin guardar de una sesión anterior? Ofrecer recuperarlo.
      const tabNew = _viewerTabs.get(id);
      const draft = _getDraft(tabNew);
      if (draft != null && draft !== tabNew.content) {
        if (window.confirm("Tienes cambios sin guardar de antes en “" + tabNew.name + "”. ¿Recuperarlos para seguir editando?")) {
          _enterEdit();
          const ta = $("viewer-edit-area"); if (ta) ta.value = draft;
          _syncEditorHL();
        } else {
          _clearDraft(tabNew);
        }
      }
    } catch (_) { fsStatus("Error de red al abrir '" + name + "'", "err"); }
  }

  // Recarga el contenido de la pestaña activa desde el disco (por si el archivo
  // ha cambiado fuera del visor: edición por SSH, IA en otra sesión, etc.).
  async function _viewerReload() {
    const t = _viewerTabs.get(_activeTab);
    if (!t) return;
    if (t.kind === "preview") {   // recargar el iframe de la webapp
      const f = $("viewer-iframe");
      try { f.contentWindow.location.reload(); } catch (_) { if (f) f.src = t.url; }
      fsStatus("Preview recargado ✓", "ok"); return;
    }
    if (t.kind === "image") {   // recargar imagen = volver a pedir los bytes (cache-bust)
      const img = $("viewer-img-el"); if (img) img.src = _fileURL(t.path) + "&_=" + Date.now();
      fsStatus("Imagen recargada ✓", "ok"); return;
    }
    if (_editing) {
      // No pisamos cambios sin guardar a la brava: que el usuario decida.
      if (!confirm("Hay cambios sin guardar en la edición. ¿Descartarlos y recargar desde el disco?")) return;
      _clearDraft(t);
      _exitEdit();
    }
    if (!fsid) { fsStatus("Abre la terminal primero (el visor usa tu sesión SSH).", "err"); return; }
    const btn = $("viewer-reload");
    if (btn) btn.classList.add("spinning");
    try {
      const res = await fetch("/files/read?fsid=" + encodeURIComponent(fsid) + "&path=" + encodeURIComponent(t.path), { headers: fsHeaders() });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { fsStatus(d.detail || ("Error " + res.status), "err"); return; }
      const fresh = d.content || "";
      t.mtime = d.mtime || 0;   // siempre actualizamos el ancla de conflicto
      if (fresh === t.content) { fsStatus("'" + t.name + "' ya estaba al día ✓", "ok"); return; }
      t.content = fresh;
      _clearDraft(t);           // el disco manda: descartamos cualquier borrador
      _renderViewer(t);
      fsStatus("'" + t.name + "' recargado desde el disco ✓", "ok");
    } catch (_) {
      fsStatus("Error de red al recargar '" + t.name + "'", "err");
    } finally {
      if (btn) btn.classList.remove("spinning");
    }
  }

  function _viewerCopyAll() {
    const t = _viewerTabs.get(_activeTab);
    if (!t) return;
    const text = t.content;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => { const b = $("viewer-copy"); if (b) { const old = b.innerHTML; b.innerHTML = icon("check"); setTimeout(() => { b.innerHTML = old; }, 900); } },
        () => fsStatus("No se pudo copiar al portapapeles", "err")
      );
    } else {
      // Fallback: textarea + execCommand
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); fsStatus("Copiado ✓", "ok"); }
      catch (_) { fsStatus("No se pudo copiar", "err"); }
      ta.remove();
    }
  }

  function _viewerToggleWrap() {
    const pre = $("viewer-pre");
    const btn = $("viewer-wrap");
    if (!pre) return;
    const on = pre.classList.toggle("wrap");
    if (btn) btn.classList.toggle("active", on);
  }

  // ---- EDICIÓN EN LÍNEA del archivo del visor ----
  function _enterEdit() {
    const tab = _viewerTabs.get(_activeTab);
    if (!tab) return;
    if (_findActive) _resetFind();   // editar y buscar no conviven
    _editing = true; _editTabId = tab.id;
    const ta = $("viewer-edit-area"), wrap = $("viewer-edit-wrap");
    if (ta) ta.value = tab.content;
    if (wrap) wrap.hidden = false;
    _applyViewerFont(); _syncEditorHL(); _syncEditorScroll();
    const pre = $("viewer-pre"); if (pre) pre.hidden = true;
    const md = $("viewer-md"); if (md) md.hidden = true;   // se edita siempre el texto crudo
    const sv = $("viewer-save"); if (sv) sv.hidden = false;
    const eb = $("viewer-edit"); if (eb) { eb.classList.add("active"); eb.title = "Cancelar edición"; }
    if (ta) ta.focus();
  }
  function _exitEdit() {
    _editing = false; _editTabId = null;
    const wrap = $("viewer-edit-wrap"); if (wrap) wrap.hidden = true;
    const sv = $("viewer-save"); if (sv) sv.hidden = true;
    const eb = $("viewer-edit"); if (eb) { eb.classList.remove("active"); eb.title = "Editar este archivo"; }
    // Restaura el panel correcto (texto plano o Markdown) según el archivo activo.
    _applyViewMode(_viewerTabs.get(_activeTab));
  }
  // Sale del modo edición; si hay cambios sin guardar, pide confirmación.
  // Devuelve true si se pudo salir (o no se estaba editando).
  function _tryExitEdit() {
    if (!_editing) return true;
    const ta = $("viewer-edit-area");
    const tab = _viewerTabs.get(_editTabId);
    const dirty = tab && ta && ta.value !== tab.content;
    if (dirty && !window.confirm("Tienes cambios sin guardar. ¿Descartarlos?")) return false;
    if (tab) _clearDraft(tab);   // descarte explícito: fuera el borrador
    _exitEdit();
    return true;
  }
  // ---------- Borrador automático (localStorage) ----------
  // Mientras editas, se guarda lo escrito cada ~0,8 s; si cierras la pestaña del
  // navegador o se cae, al reabrir el archivo se ofrece recuperarlo.
  let _draftTimer = null;
  function _draftKey(tab) { return "wt_draft:" + (tab.path || tab.name); }
  function _saveDraft(tab, text) { try { localStorage.setItem(_draftKey(tab), text); } catch (_) {} }
  function _clearDraft(tab) { try { localStorage.removeItem(_draftKey(tab)); } catch (_) {} }
  function _getDraft(tab) { try { return localStorage.getItem(_draftKey(tab)); } catch (_) { return null; } }
  function _onEditInput() {
    if (!_editing) return;
    const tab = _viewerTabs.get(_editTabId); if (!tab) return;
    clearTimeout(_draftTimer);
    _draftTimer = setTimeout(() => {
      const ta = $("viewer-edit-area"); if (!ta) return;
      if (ta.value !== tab.content) _saveDraft(tab, ta.value); else _clearDraft(tab);
    }, 800);
  }

  // Escribe contenido en el archivo (SFTP). Devuelve {ok, mtime} o
  // {ok:false, conflict?, detail}. Si se pasa expectedMtime y el backend ve otro
  // mtime en disco responde 409 → conflict:true (cambio externo).
  async function _writeFile(path, content, expectedMtime) {
    if (!fsid) return { ok: false, detail: "Sin sesión SSH" };
    const fd = new FormData();
    fd.append("fsid", fsid); fd.append("path", path); fd.append("content", content);
    if (expectedMtime != null) fd.append("expected_mtime", String(expectedMtime));
    try {
      const res = await fetch("/files/write", { method: "POST", headers: fsHeaders(), body: fd });
      const d = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, mtime: d.mtime || 0 };
      return { ok: false, conflict: res.status === 409, detail: d.detail || ("Error " + res.status) };
    } catch (_) { return { ok: false, detail: "Error de red" }; }
  }
  async function _saveEdit() {
    const tab = _viewerTabs.get(_editTabId || _activeTab);
    const ta = $("viewer-edit-area");
    if (!tab || !ta) return;
    const content = ta.value;
    const sv = $("viewer-save"); if (sv) sv.disabled = true;
    let r = await _writeFile(tab.path, content, tab.mtime);
    // Cambio externo: el archivo se tocó por fuera desde que lo abriste.
    if (!r.ok && r.conflict) {
      const ok = window.confirm(
        "“" + tab.name + "” ha cambiado fuera del editor desde que lo abriste.\n\n" +
        "Aceptar = sobrescribir con tu versión (se pierde lo de fuera).\n" +
        "Cancelar = no guardar (luego puedes pulsar el botón de recargar para traer la versión del disco)."
      );
      if (!ok) { if (sv) sv.disabled = false; showToast("Guardado cancelado: revisa los cambios externos con el botón de recargar", true); return; }
      r = await _writeFile(tab.path, content, null);   // forzar sobrescritura
    }
    if (sv) sv.disabled = false;
    if (!r.ok) { showToast(r.detail || "No se pudo guardar", true); return; }
    tab.content = content;
    tab.mtime = r.mtime || 0;
    _clearDraft(tab);
    showToast("Guardado ✓ " + tab.name);
    _exitEdit();
    _renderViewer(tab);
  }

  function _setupViewer() {
    const close = $("viewer-close");
    if (close) close.addEventListener("click", () => closeViewerTab(_activeTab));
    const copy = $("viewer-copy");
    if (copy) copy.addEventListener("click", _viewerCopyAll);
    const reload = $("viewer-reload");
    if (reload) reload.addEventListener("click", _viewerReload);
    const runb = $("viewer-run");
    if (runb) runb.addEventListener("click", _runFile);
    const ext = $("viewer-openext");
    if (ext) ext.addEventListener("click", _openExternal);
    const dl = $("viewer-download");
    if (dl) dl.addEventListener("click", () => { const t = _viewerTabs.get(_activeTab); if (t) fsDownload(t.path); });
    const splitBtn = $("split-btn");
    if (splitBtn) splitBtn.addEventListener("click", _toggleSplit);
    const prevBtn = $("preview-btn");
    if (prevBtn) prevBtn.addEventListener("click", _openPreview);
    _setupSplitDrag();
    _setupPaneFocus();
    _setupImgModal();
    const editArea = $("viewer-edit-area");
    if (editArea) {
      editArea.addEventListener("input", () => { _onEditInput(); _syncEditorHL(); _syncEditorScroll(); });
      editArea.addEventListener("scroll", _syncEditorScroll);
      editArea.addEventListener("keydown", _editorKeydown);
    }
    const mdBtn = $("viewer-md-btn");
    if (mdBtn) mdBtn.addEventListener("click", _toggleMd);
    const fdec = $("viewer-font-dec");
    if (fdec) fdec.addEventListener("click", () => _bumpFont(-1));
    const finc = $("viewer-font-inc");
    if (finc) finc.addEventListener("click", () => _bumpFont(1));
    const wrap = $("viewer-wrap");
    if (wrap) wrap.addEventListener("click", _viewerToggleWrap);
    // Ajuste de línea ACTIVADO por defecto: el texto se adapta al ancho de la
    // ventana, sin scroll horizontal. El botón ↩ permite desactivarlo.
    const pre = $("viewer-pre");
    if (pre) pre.classList.add("wrap");
    if (wrap) wrap.classList.add("active");
    // ✏️ editar / cancelar, 💾 guardar.
    const eb = $("viewer-edit");
    if (eb) eb.addEventListener("click", () => { if (_editing) _tryExitEdit(); else _enterEdit(); });
    const sv = $("viewer-save");
    if (sv) sv.addEventListener("click", _saveEdit);
    // Buscar en archivo: input + navegación + cierre.
    const fInput = $("viewer-find-input");
    if (fInput) {
      fInput.addEventListener("input", () => { _findIdx = 0; _runFind(); });
      fInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); _findStep(e.shiftKey ? -1 : 1); }
        else if (e.key === "Escape") { e.preventDefault(); _closeFind(); }
      });
    }
    const fPrev = $("viewer-find-prev"); if (fPrev) fPrev.addEventListener("click", () => _findStep(-1));
    const fNext = $("viewer-find-next"); if (fNext) fNext.addEventListener("click", () => _findStep(1));
    const fX = $("viewer-find-x"); if (fX) fX.addEventListener("click", _closeFind);
    // Atajos: Ctrl/Cmd+S guarda; Ctrl/Cmd+W cierra pestaña; Ctrl/Cmd+F busca.
    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "s" || e.key === "S")) {
        if (_editing) { e.preventDefault(); _saveEdit(); }
        return;
      }
      if (mod && (e.key === "f" || e.key === "F")) {
        // Solo secuestramos Ctrl+F con un archivo abierto y sin editar; si no, que
        // funcione la búsqueda nativa del navegador.
        if (_activeTab !== _TAB_TERM && !_editing) { e.preventDefault(); _openFind(); }
        return;
      }
      if (mod && (e.key === "w" || e.key === "W")) {
        if (_activeTab !== _TAB_TERM) { e.preventDefault(); closeViewerTab(_activeTab); }
      }
    });
  }

  // ---------- ENVIAR SELECCIÓN A UN MODELO (✨) ----------
  // Selecciona texto en el visor (o el editor) y pídele a un modelo que lo cambie:
  //  · a Claude en la sesión tmux activa → se inyecta instrucción + archivo + líneas + texto.
  //  · a Kimi/DeepSeek por API → previsualizas; si aceptas, se guarda en el archivo
  //    y se refresca la vista.
  let _aiCtx = null;       // { tab, info } del diálogo abierto
  let _aiPending = null;    // { info, proposed } de la previsualización
  let _aiCfgData = null;    // config pública (sin claves) cacheada

  function _lineRange(content, start, end) {
    const l1 = content.slice(0, start).split("\n").length;
    const l2 = content.slice(0, end).split("\n").length;
    return [l1, l2];
  }
  // {text, start, end, whole, content} de la selección actual (editor o visor).
  function _selectionInfo() {
    const tab = _viewerTabs.get(_activeTab);
    if (!tab) return null;
    const ta = $("viewer-edit-area");
    if (_editing && ta && !ta.hidden) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      if (s != null && e != null && e > s)
        return { text: ta.value.substring(s, e), start: s, end: e, whole: false, content: ta.value };
      return { text: ta.value, start: 0, end: ta.value.length, whole: true, content: ta.value };
    }
    const code = $("viewer-code");
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && code &&
        code.contains(sel.anchorNode) && code.contains(sel.focusNode)) {
      const r = sel.getRangeAt(0);
      const pre = document.createRange();
      pre.selectNodeContents(code);
      pre.setEnd(r.startContainer, r.startOffset);
      const start = pre.toString().length;
      const text = sel.toString();
      return { text, start, end: start + text.length, whole: false, content: tab.content };
    }
    return { text: tab.content, start: 0, end: tab.content.length, whole: true, content: tab.content };
  }

  function _openAiDialog() {
    const tab = _viewerTabs.get(_activeTab);
    if (!tab) { showToast("Abre un archivo de texto primero", true); return; }
    const info = _selectionInfo();
    _aiCtx = { tab, info };
    const [l1, l2] = _lineRange(info.content, info.start, info.end);
    $("ai-ctx").textContent = (info.whole
      ? "Todo el archivo"
      : `Selección: líneas ${l1}–${l2} · ${info.text.length} caracteres`) + " · " + tab.name;
    const st = $("ai-status"); st.textContent = ""; st.className = "ai-status";
    // Limpiamos el diálogo: la instrucción anterior y cualquier previsualización
    // pendiente de una pasada previa, para no arrastrar texto de otra petición.
    $("ai-preview").hidden = true; _aiPending = null;
    const ta = $("ai-instruction"); if (ta) ta.value = "";
    $("ai-overlay").hidden = false;
    if (ta) ta.focus();
  }

  async function _aiSend() {
    if (!_aiCtx) return;
    const { tab, info } = _aiCtx;
    const target = $("ai-target").value;
    const instruction = ($("ai-instruction").value || "").trim();
    const st = $("ai-status");
    if (!instruction) { st.textContent = "Escribe una instrucción."; st.className = "ai-status err"; return; }
    const [l1, l2] = _lineRange(info.content, info.start, info.end);

    if (target === "claude-tmux") {
      if (!ws || ws.readyState !== WebSocket.OPEN) { st.textContent = "No hay terminal conectada."; st.className = "ai-status err"; return; }
      const loc = info.whole ? `el archivo ${tab.path}` : `el archivo ${tab.path} (líneas ${l1}–${l2})`;
      const msg = `${instruction}\n\nContexto: esto es sobre ${loc}. Texto a tratar:\n\n${info.text}\n`;
      ws.send(msg);
      setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send("\r"); }, 150);
      $("ai-overlay").hidden = true;
      switchTab(_TAB_TERM);
      showToast("Enviado a Claude (tmux) ✓");
      return;
    }
    // API: kimi / deepseek
    st.textContent = "Pensando… (puede tardar unos segundos)"; st.className = "ai-status";
    const send = $("ai-send"); if (send) send.disabled = true;
    try {
      const fd = new FormData();
      fd.append("provider", target);
      fd.append("instruction", instruction);
      fd.append("text", info.text);
      const res = await fetch("/ai/run", { method: "POST", headers: fsHeaders(), body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { st.textContent = d.detail || ("Error " + res.status); st.className = "ai-status err"; return; }
      $("ai-overlay").hidden = true;
      _openAiPreview(info, d.text || "");
    } catch (_) { st.textContent = "Error de red."; st.className = "ai-status err"; }
    finally { if (send) send.disabled = false; }
  }

  function _openAiPreview(info, proposed) {
    _aiPending = { info, proposed };
    $("ai-orig").textContent = info.text;
    $("ai-new").textContent = proposed;
    const st = $("ai-prev-status"); st.textContent = ""; st.className = "ai-status";
    $("ai-preview").hidden = false;
  }

  async function _aiAccept() {
    if (!_aiPending || !_aiCtx) return;
    const { info, proposed } = _aiPending;
    const tab = _aiCtx.tab;
    const newContent = info.content.slice(0, info.start) + proposed + info.content.slice(info.end);
    const st = $("ai-prev-status"); st.textContent = "Guardando…"; st.className = "ai-status";
    const acc = $("ai-accept"); if (acc) acc.disabled = true;
    const r = await _writeFile(tab.path, newContent);
    if (acc) acc.disabled = false;
    if (!r.ok) { st.textContent = r.detail || "No se pudo guardar"; st.className = "ai-status err"; return; }
    tab.content = newContent;
    tab.mtime = r.mtime || 0;
    _clearDraft(tab);
    _aiPending = null;
    $("ai-preview").hidden = true;
    // refrescar la visualización con el cambio ya guardado
    if (_viewerTabs.has(tab.id)) _activeTab = tab.id;
    _exitEdit();
    _ensureViewerVisible();
    _renderViewer(tab);
    _updateTabsUI();
    showToast("Cambios guardados en " + tab.name + " ✓");
  }

  // ---- configuración de proveedores por API (⚙) ----
  async function _openAiConfig() {
    $("ai-config").hidden = false;
    const st = $("ai-cfg-status"); st.textContent = "Cargando…"; st.className = "ai-status";
    try {
      const res = await fetch("/ai/config", { headers: fsHeaders() });
      const d = await res.json();
      _aiCfgData = d.providers || {};
      _fillAiConfig();
      st.textContent = "";
    } catch (_) { st.textContent = "No se pudo cargar la config."; st.className = "ai-status err"; }
  }
  function _fillAiConfig() {
    const p = $("ai-cfg-provider").value;
    const c = (_aiCfgData || {})[p] || {};
    $("ai-cfg-key").value = "";
    $("ai-cfg-haskey").textContent = c.has_key ? "· ya configurada (deja vacío para no cambiarla)" : "· sin configurar";
    $("ai-cfg-base").value = c.base_url || "";
    $("ai-cfg-model").value = c.model || "";
  }
  async function _saveAiConfig() {
    const p = $("ai-cfg-provider").value;
    const st = $("ai-cfg-status"); st.textContent = "Guardando…"; st.className = "ai-status";
    const fd = new FormData();
    fd.append("provider", p);
    fd.append("api_key", $("ai-cfg-key").value);
    fd.append("base_url", $("ai-cfg-base").value);
    fd.append("model", $("ai-cfg-model").value);
    try {
      const res = await fetch("/ai/config", { method: "POST", headers: fsHeaders(), body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { st.textContent = d.detail || "Error al guardar"; st.className = "ai-status err"; return; }
      _aiCfgData = d.providers || {};
      _fillAiConfig();
      st.textContent = "Guardado ✓"; st.className = "ai-status ok";
    } catch (_) { st.textContent = "Error de red."; st.className = "ai-status err"; }
  }

  function setupAI() {
    const cfgBtn = $("ai-config-btn"); if (cfgBtn) cfgBtn.addEventListener("click", _openAiConfig);
    const aiBtn = $("viewer-ai");
    if (aiBtn) {
      // preventDefault en mousedown para no robar la selección de texto del visor
      aiBtn.addEventListener("mousedown", (e) => e.preventDefault());
      aiBtn.addEventListener("click", _openAiDialog);
    }
    const send = $("ai-send"); if (send) send.addEventListener("click", _aiSend);
    const cancel = $("ai-cancel"); if (cancel) cancel.addEventListener("click", () => { $("ai-overlay").hidden = true; });
    const acc = $("ai-accept"); if (acc) acc.addEventListener("click", _aiAccept);
    const rej = $("ai-reject"); if (rej) rej.addEventListener("click", () => { $("ai-preview").hidden = true; _aiPending = null; });
    const px = $("ai-prev-x"); if (px) px.addEventListener("click", () => { $("ai-preview").hidden = true; _aiPending = null; });
    const cx = $("ai-config-x"); if (cx) cx.addEventListener("click", () => { $("ai-config").hidden = true; });
    const prov = $("ai-cfg-provider"); if (prov) prov.addEventListener("change", _fillAiConfig);
    const csave = $("ai-cfg-save"); if (csave) csave.addEventListener("click", _saveAiConfig);
    // Cerrar al pulsar en el fondo oscuro.
    ["ai-overlay", "ai-preview", "ai-config"].forEach((id) => {
      const ov = $(id);
      if (ov) ov.addEventListener("click", (e) => { if (e.target === ov) ov.hidden = true; });
    });
    // Escape cierra cualquier overlay de IA abierto.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      ["ai-overlay", "ai-preview", "ai-config"].forEach((id) => { const o = $(id); if (o && !o.hidden) o.hidden = true; });
    });
  }

  // ---------- EXPLORADOR DE ARCHIVOS (SFTP sobre la sesión SSH) ----------
  let fsPath = "";  // carpeta actual (vacío = home del usuario)
  function fsHeaders() { return { Authorization: "Bearer " + jwt }; }
  function fsStatus(msg, kind) {
    const s = $("files-status"); if (!s) return;
    s.textContent = msg || ""; s.className = "files-status" + (kind ? " " + kind : "");
  }
  function fsFmtSize(n) {
    if (n < 1024) return n + " B";
    const u = ["KB", "MB", "GB", "TB"]; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
  }
  function fsFmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  async function fsList(path) {
    if (!fsid) { fsStatus("Abre la terminal primero (el explorador usa tu sesión SSH).", "err"); return; }
    fsStatus("Cargando…");
    try {
      const url = "/files/list?fsid=" + encodeURIComponent(fsid) + "&path=" + encodeURIComponent(path || "");
      const res = await fetch(url, { headers: fsHeaders() });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { fsStatus(d.detail || ("Error " + res.status), "err"); return; }
      fsPath = d.path;
      fsRender(d);
      fsStatus(d.items.length + " elementos");
    } catch (_) { fsStatus("Error de red al listar", "err"); }
  }
  function fsCrumbs(path) {
    const box = $("files-crumbs"); box.innerHTML = "";
    const parts = path.split("/").filter(Boolean);
    const root = document.createElement("span");
    root.className = "crumb"; root.textContent = "/"; root.title = "Raíz";
    root.addEventListener("click", () => fsList("/"));
    box.appendChild(root);
    let acc = "";
    parts.forEach((p) => {
      acc += "/" + p;
      const sep = document.createElement("span"); sep.className = "sep"; sep.textContent = " ›";
      const c = document.createElement("span"); c.className = "crumb"; c.textContent = " " + p;
      const target = acc;
      c.addEventListener("click", () => fsList(target));
      box.appendChild(sep); box.appendChild(c);
    });
  }
  function fsJoin(dir, name) { return (dir === "/" ? "" : dir) + "/" + name; }
  function fsRender(d) {
    fsCrumbs(d.path);
    const list = $("files-list"); list.innerHTML = "";
    if (!d.items.length) { list.innerHTML = '<div class="files-empty">Carpeta vacía</div>'; return; }
    d.items.forEach((it) => {
      const full = fsJoin(d.path, it.name);
      const row = document.createElement("div");
      row.className = "frow" + (it.dir ? " isdir" : "");
      const ico = document.createElement("span"); ico.className = "ico"; ico.innerHTML = it.dir ? icon("folder") : (it.link ? icon("link") : icon("file-text"));
      const info = document.createElement("div"); info.className = "finfo";
      const name = document.createElement("span"); name.className = "fname"; name.textContent = it.name; name.title = it.name;
      if (it.dir) name.addEventListener("click", () => fsList(full));
      else if (_isImageName(it.name)) { name.style.cursor = "zoom-in"; name.addEventListener("click", () => _openImgFromFolder(d, full)); }
      const meta = document.createElement("span"); meta.className = "fmeta";
      meta.textContent = (it.dir ? "carpeta · " : fsFmtSize(it.size) + " · ") + fsFmtDate(it.mtime);
      info.appendChild(name); info.appendChild(meta);
      const ops = document.createElement("span"); ops.className = "fops";
      if (!it.dir) ops.appendChild(fsOp(icon("download"), "Descargar", () => fsDownload(full)));
      ops.appendChild(fsOp(icon("pencil"), "Renombrar / mover", () => fsRename(full, it.name)));
      ops.appendChild(fsOp(icon("trash-2"), "Borrar", () => fsDelete(full, it.name, it.dir), "del"));
      row.appendChild(ico); row.appendChild(info); row.appendChild(ops);
      // Doble clic: imagen → lightbox; texto → pestaña del visor.
      if (!it.dir) row.addEventListener("dblclick", () => {
        if (_isImageName(it.name)) _openImgFromFolder(d, full);
        else viewerOpenPath(full, it.name, it.size);
      });
      list.appendChild(row);
    });
  }
  function fsOp(label, title, fn, extra) {
    const b = document.createElement("button");
    b.className = "fop" + (extra ? " " + extra : ""); b.innerHTML = label; b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function fsDownload(path) {
    // Token por query para descargar en streaming directo (sin cargar en memoria JS).
    const url = "/files/download?fsid=" + encodeURIComponent(fsid)
      + "&path=" + encodeURIComponent(path) + "&token=" + encodeURIComponent(jwt);
    const a = document.createElement("a"); a.href = url; a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function fsUploadFiles(files) {
    if (!files || !files.length) return;
    for (const f of files) {
      fsStatus("Subiendo " + f.name + "…");
      const fd = new FormData();
      fd.append("fsid", fsid); fd.append("dir", fsPath); fd.append("file", f, f.name);
      try {
        const res = await fetch("/files/upload", { method: "POST", headers: fsHeaders(), body: fd });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { fsStatus(d.detail || ("Error al subir " + f.name), "err"); return; }
      } catch (_) { fsStatus("Error de red al subir " + f.name, "err"); return; }
    }
    fsStatus("Subida completada ✓", "ok");
    fsList(fsPath);
  }
  async function fsMkdir() {
    const name = window.prompt("Nombre de la carpeta nueva:");
    if (!name) return;
    const fd = new FormData(); fd.append("fsid", fsid); fd.append("dir", fsPath); fd.append("name", name);
    const res = await fetch("/files/mkdir", { method: "POST", headers: fsHeaders(), body: fd });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { fsStatus(d.detail || "No se pudo crear", "err"); return; }
    fsList(fsPath);
  }
  async function fsNewFile() {
    const name = window.prompt("Nombre del archivo nuevo (p. ej. notas.txt, script.py):");
    if (!name) return;
    const clean = name.trim(); if (!clean) return;
    const fd = new FormData(); fd.append("fsid", fsid); fd.append("dir", fsPath); fd.append("name", clean);
    const res = await fetch("/files/newfile", { method: "POST", headers: fsHeaders(), body: fd });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { fsStatus(d.detail || "No se pudo crear el archivo", "err"); return; }
    fsStatus("Creado '" + (d.name || clean) + "' ✓", "ok");
    fsList(fsPath);
    viewerOpenPath(d.path, d.name || clean, 0);   // ábrelo para editar al instante
  }
  async function fsRename(path, oldName) {
    const nu = window.prompt("Nuevo nombre o ruta (mover si pones una ruta):", oldName);
    if (nu === null) return;
    const val = nu.trim(); if (!val || val === oldName) return;
    const dst = val.indexOf("/") >= 0 ? (val[0] === "/" ? val : fsJoin(fsPath, val)) : fsJoin(fsPath, val);
    const fd = new FormData(); fd.append("fsid", fsid); fd.append("src", path); fd.append("dst", dst);
    const res = await fetch("/files/rename", { method: "POST", headers: fsHeaders(), body: fd });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { fsStatus(d.detail || "No se pudo renombrar", "err"); return; }
    fsList(fsPath);
  }
  async function fsDelete(path, name, isDir) {
    if (!window.confirm("¿Borrar " + (isDir ? "la carpeta" : "el archivo") + ' "' + name + '"' + (isDir ? " y todo su contenido" : "") + "?")) return;
    const fd = new FormData(); fd.append("fsid", fsid); fd.append("path", path);
    const res = await fetch("/files/delete", { method: "POST", headers: fsHeaders(), body: fd });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { fsStatus(d.detail || "No se pudo borrar", "err"); return; }
    fsList(fsPath);
  }
  function fsIsOpen() { return document.body.classList.contains("files-open"); }
  function fsRefit() { setTimeout(() => { try { doFit(); } catch (_) {} }, 60); }
  function fsOpen() {
    document.body.classList.add("files-open");
    fsRefit();                 // la terminal se encoge: reajustar xterm
    fsList(fsPath || "");
  }
  function fsClose() {
    document.body.classList.remove("files-open");
    fsRefit(); if (term) term.focus();
  }
  function fsToggle() { fsIsOpen() ? fsClose() : fsOpen(); }
  // Lateral de archivos redimensionable (tirador en el borde derecho, persistente).
  function _setupFilesResizer() {
    const side = $("files-side"), grip = $("files-resizer");
    if (!side || !grip) return;
    try { const w = parseInt(localStorage.getItem("wt_files_w"), 10); if (w >= 180 && w <= 700) side.style.setProperty("--files-w", w + "px"); } catch (_) {}
    let dragging = false;
    const onMove = (clientX) => {
      let w = clientX - side.getBoundingClientRect().left;
      w = Math.max(180, Math.min(700, w));
      side.style.setProperty("--files-w", w + "px");
      try { localStorage.setItem("wt_files_w", String(Math.round(w))); } catch (_) {}
      fsRefit();
    };
    const start = (e) => { dragging = true; grip.classList.add("dragging"); document.body.style.userSelect = "none"; document.body.style.cursor = "col-resize"; e.preventDefault(); };
    const end = () => { if (!dragging) return; dragging = false; grip.classList.remove("dragging"); document.body.style.userSelect = ""; document.body.style.cursor = ""; fsRefit(); };
    grip.addEventListener("mousedown", start);
    window.addEventListener("mousemove", (e) => { if (dragging) onMove(e.clientX); });
    window.addEventListener("mouseup", end);
    grip.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("touchmove", (e) => { if (dragging && e.touches[0]) { onMove(e.touches[0].clientX); e.preventDefault(); } }, { passive: false });
    window.addEventListener("touchend", end);
  }
  function setupFiles() {
    const btn = $("files-btn"); if (btn) btn.addEventListener("click", fsToggle);
    const c = $("files-close"); if (c) c.addEventListener("click", fsClose);
    const up = $("files-up"); if (up) up.addEventListener("click", () => {
      const parent = fsPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
      fsList(parent);
    });
    const rf = $("files-refresh"); if (rf) rf.addEventListener("click", () => fsList(fsPath));
    _setupFilesResizer();
    _setupViewer();
    const nf = $("files-newfile"); if (nf) nf.addEventListener("click", fsNewFile);
    const mk = $("files-mkdir"); if (mk) mk.addEventListener("click", fsMkdir);
    const ub = $("files-upload-btn"); if (ub) ub.addEventListener("click", () => $("files-input").click());
    const inp = $("files-input"); if (inp) inp.addEventListener("change", (e) => { fsUploadFiles(e.target.files); e.target.value = ""; });
    // Cerrar con Escape
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && fsIsOpen()) fsClose(); });
    // Arrastrar y soltar archivos en el panel
    const side = $("files-side");
    if (side) {
      side.addEventListener("dragover", (e) => { e.preventDefault(); side.classList.add("dragging"); });
      side.addEventListener("dragleave", (e) => { if (e.target === side) side.classList.remove("dragging"); });
      side.addEventListener("drop", (e) => {
        e.preventDefault(); side.classList.remove("dragging");
        const files = (e.dataTransfer && e.dataTransfer.files) || [];
        if (files.length) fsUploadFiles(files);
      });
    }
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
      ws.send(JSON.stringify({ ssh_user: sshUser, password: sshPassword, session: currentSession || undefined }));
      doFit(); term.focus();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); }
      else {
        // ¿Mensaje de control JSON (sesiones tmux / id de archivos)? Si no, es texto del PTY.
        if (ev.data && ev.data[0] === "{") {
          try {
            const m = JSON.parse(ev.data);
            if (m && m.type === "tmux-sessions") { renderSessions(m.sessions || []); return; }
            if (m && m.type === "fsid") { fsid = m.fsid; requestSessions(); _restoreOpenTabs(); return; }
          } catch (_) {}
        }
        term.write(ev.data);
      }
      // Tras recibir el primer prompt del shell, lanza claude si se pidió.
      if (autoOpenClaude) {
        autoOpenClaude = false;
        setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send("claude\r"); }, 700);
      }
    };
    ws.onclose = (ev) => {
      setStatus("disconnected", "desconectado");
      const code = ev ? ev.code : 0;
      // Cierres por credenciales/seguridad: NO reconectar (reintentar reenviaría
      // la misma contraseña y dispararía el bloqueo). Volver al formulario.
      if (code === 4401 || code === 4403 || code === 4429 || code === 4400) {
        sshPassword = null;
        ws = null;
        if (code === 4401) {              // sesión web caducada -> login
          jwt = null;
          $("login-error").textContent = "Sesión caducada. Vuelve a entrar.";
          show("login-screen");
        } else {                          // credenciales SSH / bloqueo -> formulario SSH
          $("ssh-error").textContent = (ev && ev.reason) || "No se pudo abrir la terminal.";
          $("ssh-password").value = "";
          show("ssh-screen");
          $("ssh-password").focus();
        }
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  // Reconexión infinita con backoff exponencial (tope 30s) + algo de jitter.
  // Con tmux la sesión sigue viva en el servidor, así que reintentar siempre
  // hasta recuperar el wifi/datos es justo lo que queremos en el móvil.
  function scheduleReconnect() {
    const n = reconnectAttempts++;
    let delay = Math.min(30000, 1000 * Math.pow(2, n));   // 1s,2s,4s…30s
    delay += Math.floor(delay * 0.2 * Math.random());      // jitter ±20%
    const secs = Math.round(delay / 1000);
    setStatus("reconnecting", `reconectando en ${secs}s…`);
    setTimeout(connectWS, delay);
  }
})();
