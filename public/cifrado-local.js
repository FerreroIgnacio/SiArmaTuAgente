// Lo que queda guardado en el navegador (conversaciones, sesión de WhatsApp) va cifrado con AES-GCM. La clave la da
// el servidor solo con la sesión iniciada (/api/yo → claveLocal): al salir los datos siguen acá, pero solo los puede
// leer la misma cuenta al volver a entrar. Lo guardado antes sin cifrar se lee igual y se cifra al volver a guardarse
const PREFIJO = 'c1:';

export const importarClave = hex =>
  crypto.subtle.importKey('raw', Uint8Array.from(hex.match(/../g), h => parseInt(h, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);

function aBase64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function cifrarLocal(clave, texto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, clave, new TextEncoder().encode(texto)));
  const todo = new Uint8Array(iv.length + datos.length);
  todo.set(iv);
  todo.set(datos, iv.length);
  return PREFIJO + aBase64(todo);
}

export const estaCifrado = s => typeof s === 'string' && s.startsWith(PREFIJO);

// Falla si es de otra cuenta
export async function descifrarLocal(clave, s) {
  if (!estaCifrado(s)) return s;
  const b = Uint8Array.from(atob(s.slice(PREFIJO.length)), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, clave, b.subarray(12)));
}
