// Service worker mínimo: hace a WebTerminal instalable (PWA) en el móvil.
// La terminal es dinámica y autenticada, así que NO cacheamos contenido;
// solo habilitamos la instalación. Activación inmediata.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* passthrough: el navegador maneja la red */ });
