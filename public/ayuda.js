// Flecha para volver: vuelve a la página de la que saliste, o al inicio si se entró directo
document.querySelectorAll('.volver').forEach(a => a.addEventListener('click', e => {
  let mismoSitio = false;
  try { mismoSitio = new URL(document.referrer).origin === location.origin; } catch {}
  if (mismoSitio && history.length > 1) { e.preventDefault(); history.back(); }
}));
