// Redirige los dispositivos táctiles estrechos a la versión móvil específica (/m/),
// salvo que el usuario haya elegido explícitamente la versión de escritorio.
try {
  if (matchMedia("(pointer: coarse)").matches && window.innerWidth <= 820
      && !localStorage.getItem("wt_force_desktop")
      && !location.pathname.startsWith("/m")) {
    location.replace("/m/");
  }
} catch (e) {}
