# Paste Image Preview Toast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-intrusive corner toast that previews a pasted image before uploading it in the WebTerminal desktop frontend.

**Architecture:** Intercept the image blob from the existing `paste` and `pasteFromClipboard` handlers, render a local `data:` URL preview in a fixed-position card, and reuse the existing `uploadFile()` function only when the user confirms. All changes are confined to the static desktop frontend (HTML, CSS, JS) with no backend modifications.

**Tech Stack:** Vanilla JavaScript, CSS custom properties, FastAPI backend unchanged.

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/index.html` | Markup for the new `#paste-preview` toast and cache-busting version bumps. |
| `frontend/style.css` | Visual styles, positioning and animation of the toast. |
| `frontend/app.js` | Preview helpers (`_showPastePreview`, `_hidePastePreview`, `_uploadFromPastePreview`) and wiring of the existing paste handlers. |
| `docs/visual_check.py` | Visual regression: render the toast with a sample image and take a screenshot. |

---

### Task 1: Add markup for the paste preview toast

**Files:**
- Modify: `frontend/index.html:308`

Add the toast right after the existing `#toast` div.

- [ ] **Step 1: Insert HTML**

```html
    <div id="toast" class="toast"></div>

    <!-- Previsualización de imagen pegada (toast en esquina) -->
    <div id="paste-preview" class="paste-preview" hidden>
      <div class="paste-preview-header">
        <span class="paste-preview-title">Subir imagen</span>
        <button id="paste-preview-close" class="paste-preview-x" title="Cerrar (Esc)"><svg class="ic"><use href="#ic-x"/></svg></button>
      </div>
      <img id="paste-preview-img" alt="Vista previa" />
      <div id="paste-preview-meta" class="paste-preview-meta"></div>
      <div id="paste-preview-status" class="paste-preview-status" hidden></div>
      <div class="paste-preview-actions">
        <button id="paste-preview-cancel" class="ui-modal-btn" type="button">Descartar</button>
        <button id="paste-preview-upload" class="ui-modal-btn primary" type="button">Subir</button>
      </div>
    </div>
```

- [ ] **Step 2: Verify icon reference**

Confirm `#ic-x` exists in the SVG sprite near the top of `index.html`. It is already used by other modals, so no new icon is needed.

---

### Task 2: Bump cache-busting version parameters

**Files:**
- Modify: `frontend/index.html:33`
- Modify: `frontend/index.html:426`

- [ ] **Step 1: Update stylesheet query string**

```html
  <link rel="stylesheet" href="style.css?v=82" />
```

- [ ] **Step 2: Update script query string**

```html
  <script src="app.js?v=130"></script>
```

---

### Task 3: Add CSS for the paste preview toast

**Files:**
- Modify: `frontend/style.css:310` (right after `.toast.toast-err`)

- [ ] **Step 1: Append styles**

```css
/* ---------- Toast de previsualización de imagen pegada ---------- */
.paste-preview {
  position: fixed; bottom: 16px; right: 16px; z-index: 70;
  width: 280px; max-width: calc(100vw - 32px);
  background: linear-gradient(180deg, rgba(255,255,255,.03), transparent 30%), var(--panel);
  border: 1px solid var(--border); border-radius: var(--r-l);
  box-shadow: var(--shadow-2), inset 0 1px 0 rgba(255,255,255,.05);
  padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
  opacity: 0; transform: translateY(10px); pointer-events: none;
  transition: opacity .2s ease, transform .2s ease;
}
.paste-preview[hidden] { display: none !important; }
.paste-preview.open { opacity: 1; transform: translateY(0); pointer-events: auto; }
.paste-preview-header { display: flex; align-items: center; justify-content: space-between; }
.paste-preview-title { font-weight: 700; font-size: 14px; color: var(--text); font-family: var(--font-ui); }
.paste-preview-x { background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 2px; display: inline-flex; align-items: center; justify-content: center; }
.paste-preview-x:hover { color: var(--text); }
.paste-preview img { width: 100%; max-height: 120px; object-fit: contain; border-radius: var(--r-s); background: var(--bg); }
.paste-preview-meta { font-size: 12px; color: var(--muted); word-break: break-all; }
.paste-preview-status { font-size: 12px; color: var(--red); min-height: 16px; }
.paste-preview-status[hidden] { display: none; }
.paste-preview-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.paste-preview-actions .ui-modal-btn { padding: 6px 12px; font-size: 13px; }
@media (max-width: 640px) {
  .paste-preview { left: 16px; right: 16px; bottom: 16px; width: auto; }
}
```

---

### Task 4: Add JavaScript preview helpers

**Files:**
- Modify: `frontend/app.js:360` (right after the `uploadFile` function)

- [ ] **Step 1: Insert preview helpers and initialization**

```javascript
  // ---------- PREVISUALIZACIÓN DE IMAGEN PEGADA ----------
  let _pastePreviewFile = null;
  let _pastePreviewDataUrl = null;

  function _formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function _hidePastePreview() {
    const pp = $("paste-preview"); if (!pp) return;
    pp.classList.remove("open");
    setTimeout(() => {
      if (!pp.classList.contains("open")) {
        pp.hidden = true;
        const img = $("paste-preview-img"); if (img) img.src = "";
        _pastePreviewDataUrl = null;
        _pastePreviewFile = null;
        const st = $("paste-preview-status"); if (st) { st.textContent = ""; st.hidden = true; }
      }
    }, 200);
  }

  function _setPastePreviewError(msg) {
    const st = $("paste-preview-status"); if (!st) return;
    st.textContent = msg; st.hidden = false;
  }

  async function _showPastePreview(file) {
    if (!file) return;
    const pp = $("paste-preview"); if (!pp) return;
    if (_pastePreviewDataUrl) {
      const img = $("paste-preview-img"); if (img) img.src = "";
      _pastePreviewDataUrl = null;
    }
    _pastePreviewFile = file;
    const img = $("paste-preview-img");
    const meta = $("paste-preview-meta");
    const st = $("paste-preview-status");
    if (st) { st.textContent = ""; st.hidden = true; }
    const ext = ((file.type || "").split("/")[1] || "png").replace("jpeg", "jpg");
    const name = file.name || ("pegado-" + Date.now() + "." + ext);
    if (meta) meta.textContent = name + " · " + _formatBytes(file.size);
    try {
      _pastePreviewDataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error("No se pudo leer la imagen"));
        r.readAsDataURL(file);
      });
      if (img) img.src = _pastePreviewDataUrl;
      if (pp.hidden) {
        pp.hidden = false;
        requestAnimationFrame(() => pp.classList.add("open"));
      }
    } catch (e) {
      showToast("No se pudo previsualizar la imagen", true);
      _pastePreviewFile = null;
    }
  }

  async function _uploadFromPastePreview() {
    if (!_pastePreviewFile) return;
    const btn = $("paste-preview-upload");
    const cancel = $("paste-preview-cancel");
    if (btn) { btn.disabled = true; btn.textContent = "Subiendo…"; }
    if (cancel) cancel.disabled = true;
    const ok = await uploadFile(_pastePreviewFile);
    if (btn) { btn.disabled = false; btn.textContent = "Subir"; }
    if (cancel) cancel.disabled = false;
    if (ok) _hidePastePreview();
    else _setPastePreviewError("Error al subir. Reintenta.");
  }

  function _initPastePreview() {
    const closeBtn = $("paste-preview-close");
    if (closeBtn) closeBtn.addEventListener("click", _hidePastePreview);
    const cancelBtn = $("paste-preview-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", _hidePastePreview);
    const uploadBtn = $("paste-preview-upload");
    if (uploadBtn) uploadBtn.addEventListener("click", _uploadFromPastePreview);
    const pp = $("paste-preview");
    if (pp) {
      document.addEventListener("mousedown", (e) => {
        if (!pp.classList.contains("open")) return;
        if (!pp.contains(e.target)) _hidePastePreview();
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const p = $("paste-preview");
        if (p && !p.hidden && p.classList.contains("open")) {
          e.stopPropagation();
          _hidePastePreview();
        }
      }
    });
  }
  _initPastePreview();
```

---

### Task 5: Wire existing paste handlers to show the preview

**Files:**
- Modify: `frontend/app.js:918`
- Modify: `frontend/app.js:1050`

- [ ] **Step 1: Update `pasteFromClipboard()` image path**

Find this block inside `pasteFromClipboard`:

```javascript
          for (const it of items) {
            const imgType = (it.types || []).find((t) => t.startsWith("image/"));
            if (imgType) { const blob = await it.getType(imgType); await uploadFile(blob); return; }
          }
```

Replace it with:

```javascript
          for (const it of items) {
            const imgType = (it.types || []).find((t) => t.startsWith("image/"));
            if (imgType) { const blob = await it.getType(imgType); _showPastePreview(blob); return; }
          }
```

- [ ] **Step 2: Update the document `paste` listener**

Find this block inside the document `paste` listener:

```javascript
        if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          const blob = it.getAsFile();
          if (blob) uploadFile(blob);
          return;
        }
```

Replace it with:

```javascript
        if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          const blob = it.getAsFile();
          if (blob) _showPastePreview(blob);
          return;
        }
```

---

### Task 6: Add visual regression test for the toast

**Files:**
- Modify: `docs/visual_check.py`

- [ ] **Step 1: Add toast rendering code before browser close**

Insert after the existing "Diálogo de IA" screenshot block:

```python
    # Toast de previsualización de imagen pegada
    sample_img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH5wYREw0Q2aMF0QAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUHAAAAbUlEQVQ4y2NgYGD4z0ABYAxcwwB8qmE4DNUwjIahSjAMpWGoEgynaRiqBMMwGoYqwTCShqFKMAyjYagSDMNoGKoEwzAahirBMIyGoUowDKNhqBIMw2gYqgTDMBqGKsEwjIahSjAMpWGoEgyjaRiqBAAA6DwxzX0Rj68AAAAASUVORK5CYII="
    pg.evaluate(
        "document.getElementById('paste-preview').hidden = false;"
        "document.getElementById('paste-preview').classList.add('open');"
        f"document.getElementById('paste-preview-img').src = '{sample_img}';"
        "document.getElementById('paste-preview-meta').textContent = 'captura.png · 1,2 KB';"
    )
    time.sleep(0.2)
    pg.screenshot(path="/tmp/shot_paste_preview.png")
```

- [ ] **Step 2: Run the visual check**

Run: `python3 docs/visual_check.py`

Expected: command prints `ok` and `/tmp/shot_paste_preview.png` is created.

---

### Task 7: Manual verification

- [ ] **Step 1: Serve the frontend**

Run from the project root:

```bash
cd /home/ubuntu/webterminal/frontend && python3 -m http.server 8901
```

Open `http://127.0.0.1:8901/` in a browser, log in and connect to a session.

- [ ] **Step 2: Paste an image**

Copy any image to the clipboard and press `Ctrl+V` in the terminal.

Expected: the toast appears in the bottom-right corner with a thumbnail, filename and size.

- [ ] **Step 3: Confirm upload**

Click **Subir**.

Expected: toast hides and the file path is injected into the terminal as before.

- [ ] **Step 4: Cancel upload**

Paste another image and click **Descartar** (or press `Escape`, or click outside).

Expected: toast hides and nothing is uploaded.

- [ ] **Step 5: Replace pending preview**

Paste one image, then paste another before acting.

Expected: the toast updates to show the newest image.

---

### Task 8: Commit

- [ ] **Step 1: Stage changes**

```bash
git add frontend/index.html frontend/style.css frontend/app.js docs/visual_check.py
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: toast de previsualización al pegar imagen en escritorio"
```

---

## Self-review

**Spec coverage:**
- Preview toast UI → Tasks 1, 2, 3.
- Intercept paste before upload → Task 5.
- Confirm/discard flow → Task 4.
- Escape/click outside close → Task 4.
- Reuse existing upload → Tasks 4, 5.
- Error display in toast → Task 4 (`_setPastePreviewError`).
- No backend changes → no backend tasks.
- Visual regression → Task 6.

**Placeholder scan:** No TBD/TODO; every step shows concrete code or commands.

**Type consistency:** Functions `_showPastePreview`, `_hidePastePreview`, `_uploadFromPastePreview` are defined before use. The variable names (`_pastePreviewFile`, `_pastePreviewDataUrl`) match across all helpers.
