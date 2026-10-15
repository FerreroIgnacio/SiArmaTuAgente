const error = new URLSearchParams(location.search).get('error');
if (error !== null) {
  document.getElementById('error').hidden = false;
  if (error === 'permiso') document.getElementById('error').textContent = 'Tu cuenta todavía no tiene acceso. Pedíselo a quien te invitó.';
}

const fondo = document.getElementById('fondo');
if (fondo) {
  const mostrar = () => fondo.classList.add('listo');
  fondo.addEventListener('load', mostrar);
  setTimeout(mostrar, 8000);
}
