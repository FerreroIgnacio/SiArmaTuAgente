const error = new URLSearchParams(location.search).get('error');
if (error !== null) {
  document.getElementById('error').hidden = false;
  if (error === 'permiso') document.getElementById('error').textContent = 'Tu cuenta todavía no tiene acceso. Pedíselo a quien te invitó.';
}
