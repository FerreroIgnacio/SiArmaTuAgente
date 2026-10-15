// Archivos del agente: viven en el Drive del dueño (permiso drive.file), nunca en el servidor.
// El navegador pide un access token corto (/api/google/token) y sube y baja directo de Google.
//   'drive:<id>'  → archivo en el Drive del dueño
//   'local:<id>'  → adjunto de un cliente que quedó solo en este navegador (IndexedDB 'adjuntos'), sin Google conectado
//   cualquier otra → URL externa que pegó el dueño
let token = null;

async function tokenDrive() {
  if (token && token.vence > Date.now() + 60000) return token.token;
  const res = await fetch('/api/google/token');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Conectá tu cuenta de Google en General → Integraciones');
  token = data;
  return data.token;
}

// → { url: 'drive:<id>', link } (link: el que se abre desde Drive, para planillas)
export async function subirADrive(blob, nombre) {
  const meta = { name: nombre || 'archivo', mimeType: blob.type || 'application/octet-stream' };
  const cuerpo = new FormData();
  cuerpo.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  cuerpo.append('file', blob);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST', headers: { Authorization: `Bearer ${await tokenDrive()}` }, body: cuerpo,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Drive: ${data.error?.message || res.status}`);
  return { url: `drive:${data.id}`, link: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
}

const leerLocal = id => new Promise((ok, mal) => {
  const r = indexedDB.open('adjuntos', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('media');
  r.onerror = () => mal(r.error);
  r.onsuccess = () => {
    const g = r.result.transaction('media').objectStore('media').get(id);
    g.onsuccess = () => { ok(g.result); r.result.close(); };
    g.onerror = () => mal(g.error);
  };
});

export async function bajarArchivo(url) {
  if (url.startsWith('local:')) {
    const blob = await leerLocal(url.slice(6));
    if (!blob) throw new Error('El archivo ya no está en este navegador');
    return blob;
  }
  const drive = url.startsWith('drive:');
  const res = await fetch(drive ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(url.slice(6))}?alt=media` : url,
    drive ? { headers: { Authorization: `Bearer ${await tokenDrive()}` } } : {});
  if (!res.ok) throw new Error(`No se pudo leer el archivo (${res.status})`);
  return res.blob();
}

// Para <img>/<audio>/<video>: las URLs externas van directo, las de Drive se bajan y se muestran como blob
const vistas = new Map();
export function mostrarEn(elemento, url) {
  if (!url) return elemento;
  if (!/^(drive|local):/.test(url)) { elemento.src = url; return elemento; }
  if (!vistas.has(url)) vistas.set(url, bajarArchivo(url).then(b => URL.createObjectURL(b)).catch(err => { vistas.delete(url); throw err; }));
  vistas.get(url).then(src => (elemento.src = src), err => console.warn('No se pudo mostrar el archivo', err));
  return elemento;
}
