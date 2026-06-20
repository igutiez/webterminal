# Especificación: Toast de previsualización de imagen pegada

- **Fecha:** 2026-06-20
- **Proyecto:** WebTerminal (`/home/ubuntu/webterminal`)
- **Estado:** Aprobado para implementación

## 1. Contexto

WebTerminal ya permite pegar una imagen con `Ctrl+V` en el escritorio. El listener de `paste` detecta el blob de tipo `image/*` y lo sube inmediatamente mediante `uploadFile()`. El usuario quiere ver una previsualización de la foto pegada antes de que se suba, en un componente no intrusivo (toast/card en esquina).

## 2. Objetivo

Mostrar una previsualización de la imagen pegada en un card flotante, con la opción de confirmar la subida o descartarla, antes de enviar nada al backend.

## 3. Fuera de alcance

- No se modifica el backend; se reutiliza `POST /upload` existente.
- No se implementa en la versión móvil (`frontend/m/`) en esta iteración, dado que no hay handler de paste nativo.
- No se implementa drag-and-drop ni input de archivo en esta iteración, aunque el card estará preparado para reutilizarse.

## 4. Diseño

### 4.1. Puntos de enganche

- `frontend/app.js`, handler de paste global (~línea 1006).
- `frontend/app.js`, `pasteFromClipboard()` (~línea 912) como punto alternativo de entrada.

### 4.2. Flujo de datos

```
Usuario pega Ctrl+V
    │
    ▼
Detectar item de tipo image/*
    │
    ▼
FileReader.readAsDataURL(blob)
    │
    ▼
Mostrar #paste-preview-toast con:
  - miniatura data:
  - nombre sugerido
  - tamaño
  - botones "Descartar" / "Subir"
    │
    ├── Usuario pulsa "Descartar" → ocultar toast, liberar data URL
    │
    └── Usuario pulsa "Subir"
            │
            ▼
        Llamar uploadFile(file) existente
            │
            ▼
        Si éxito → ocultar toast, inyectar ruta en terminal
        Si error → mostrar error en el toast, mantener botones
```

### 4.3. UI/UX

- Nuevo elemento `#paste-preview-toast` en `frontend/index.html`.
- Estilo en `frontend/style.css`: posición fija (`bottom: 1rem; right: 1rem;`), ancho ~280 px, fondo `var(--panel)`, borde `var(--border)`, radio `var(--r-l)`, sombra `var(--shadow-2)`.
- Miniatura con `max-height: 120px` y `object-fit: contain`.
- Botones alineados a la derecha, reutilizando clases de `.ui-modal-actions`.
- Animación de entrada sutil (`translateY(10px)` + fade-in).
- Cierre con:
  - clic en "Descartar",
  - tecla `Escape`,
  - clic fuera del card,
  - subida completada.
- Si se pega otra imagen mientras el card está visible, se reemplaza por la nueva.

### 4.4. Manejo de errores

- Error de `FileReader`: ocultar el toast y mostrar notificación breve.
- Error en `uploadFile()`: mostrar el mensaje en el toast y mantener "Descartar" / "Reintentar".
- Si el backend rechaza el archivo (por tamaño u otro motivo), se muestra el mensaje de error dentro del toast y se permite reintentar.

### 4.5. Seguridad

- La previsualización usa `data:` URL, compatible con la CSP actual (`img-src 'self' data:`).
- No se usa `blob:` ni scripts inline.
- La subida sigue requiriendo JWT como hoy.

## 5. Tests de validación

1. Pegar imagen pequeña → aparece el card con miniatura.
2. Pulsar "Subir" → se sube, desaparece el card y se inyecta la ruta en la terminal.
3. Pulsar "Descartar" → el card desaparece y no se sube nada.
4. Pulsar `Escape` → el card desaparece.
5. Clic fuera del card → el card desaparece.
6. Pegar una segunda imagen antes de actuar → reemplaza la primera.
7. Forzar error de red en la subida → el card muestra error y permite reintentar.
8. Verificar que la miniatura se renderiza correctamente con la CSP activa.

## 6. Notas de implementación

- Invalidar caché actualizando el parámetro `?v=...` de `app.js` y `style.css` en `index.html`.
- Mantener convenciones del proyecto: funciones privadas con prefijo `_`, modales con `.hidden` y cierre con `Escape`.
- No añadir dependencias externas.
