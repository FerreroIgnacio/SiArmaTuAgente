import { env } from 'cloudflare:workers';
import { cifrar, descifrar } from './cifrado.js';
import { db } from './store.js';

// Cuenta de Google del dueño para las acciones de Sheets. Se guarda el refresh token por usuario (tabla google).
// Se pide drive.file (no sensible, sin la advertencia de app no verificada): solo da acceso a las planillas
// que crea la app, por eso las planillas se crean desde acá.
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
// Sin openid/email: así Google muestra una sola pantalla (la del permiso), no además la de "volver a acceder"
export const SCOPES_INTEGRACION = [DRIVE_FILE];

const accesos = new Map(); // sub → { token, vence }

// El refresh token se guarda cifrado (ver cifrado.js): una copia de la base sola no alcanza para entrar al Drive de nadie
const escribir = (sub, { refresh_token, email, scope }) =>
  db().prepare('INSERT INTO google (sub, datos) VALUES (?1, ?2) ON CONFLICT(sub) DO UPDATE SET datos = ?2')
    .bind(String(sub), JSON.stringify({ refresh: cifrar(refresh_token), email, scope })).run();

async function leer(sub) {
  const fila = await db().prepare('SELECT datos FROM google WHERE sub = ?').bind(String(sub)).first();
  if (!fila) return null;
  const c = JSON.parse(fila.datos);
  try { return { ...c, refresh_token: descifrar(c.refresh) }; } catch { return null; }
}

export async function guardarCuenta(sub, { refresh_token, email, scope }) {
  const previa = await leer(sub);
  // Google solo manda el refresh token la primera vez que se da permiso: conservar el anterior
  const refresh = refresh_token || previa?.refresh_token;
  if (!refresh) throw new Error('Google no devolvió un refresh token');
  await escribir(sub, { refresh_token: refresh, email, scope });
  accesos.delete(sub);
}

export async function estadoGoogle(sub) {
  const c = await leer(sub);
  if (!c) return { conectado: false };
  const scopes = String(c.scope || '').split(' ');
  return {
    conectado: true,
    email: c.email,
    sheets: scopes.includes(DRIVE_FILE) || scopes.includes('https://www.googleapis.com/auth/spreadsheets'),
  };
}

export async function desconectarGoogle(sub) {
  const c = await leer(sub);
  if (c?.refresh_token) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(c.refresh_token)}`, { method: 'POST' }).catch(() => {});
  }
  await db().prepare('DELETE FROM google WHERE sub = ?').bind(String(sub)).run();
  accesos.delete(sub);
}

export async function tokenDe(sub, { conVencimiento = false } = {}) {
  const cache = accesos.get(sub);
  if (cache && cache.vence > Date.now() + 60000) return conVencimiento ? cache : cache.token;
  const c = await leer(sub);
  if (!c) throw new Error('La cuenta de Google no está conectada (General → Integraciones)');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: c.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    // Token vencido o revocado: se olvida la cuenta para que se pueda volver a conectar
    if (data.error === 'invalid_grant') await db().prepare('DELETE FROM google WHERE sub = ?').bind(String(sub)).run();
    throw new Error(`Google: ${data.error_description || data.error}. Volvé a conectar la cuenta.`);
  }
  const acceso = { token: data.access_token, vence: Date.now() + data.expires_in * 1000 };
  accesos.set(sub, acceso);
  return conVencimiento ? acceso : acceso.token;
}

async function api(sub, metodo, url, body) {
  const r = await fetch(url, {
    method: metodo,
    headers: { Authorization: `Bearer ${await tokenDe(sub)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google: ${data.error?.message || r.status}`);
  return data;
}

// Contenido de un archivo del Drive del dueño (para adjuntarlo a un mail) → { datos, tipo }. Se usa en memoria, no se guarda
export async function bajarArchivo(sub, id) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${await tokenDe(sub)}` } });
  if (!r.ok) throw new Error(`Google Drive: no se pudo leer el archivo (${r.status})`);
  return { datos: await r.arrayBuffer(), tipo: r.headers.get('content-type') || 'application/octet-stream' };
}

// Archivo que mandó un cliente por la API de Meta → Drive del dueño ({ url: 'drive:<id>', link }), como hace la página con WhatsApp personal
export async function subirArchivo(sub, datos, tipo, nombre) {
  const cuerpo = new FormData();
  cuerpo.append('metadata', new Blob([JSON.stringify({ name: nombre || 'archivo', mimeType: tipo })], { type: 'application/json' }));
  cuerpo.append('file', new Blob([datos], { type: tipo }));
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST', headers: { Authorization: `Bearer ${await tokenDe(sub)}` }, body: cuerpo,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Drive: ${data.error?.message || r.status}`);
  return { url: `drive:${data.id}`, link: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
}

/* ---------- Sheets ---------- */
// Acepta el link completo de la planilla o solo su id
export const idPlanilla = s => String(s || '').match(/\/d\/([\w-]+)/)?.[1] || String(s || '').trim();

export const letraANumero = l => [...l.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const numeroALetra = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const rango = (hoja, r) => encodeURIComponent(hoja ? `'${hoja.replace(/'/g, "''")}'!${r}` : r);
const base = id => `https://sheets.googleapis.com/v4/spreadsheets/${id}`;

// Planilla nueva en el Drive del dueño, con una fila de títulos. Con drive.file el archivo tiene que
// crearse por la Drive API (la Sheets API responde 403); después se escribe con la Sheets API.
export async function crearPlanilla(sub, { titulo, encabezados = [] }) {
  const f = await api(sub, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id,webViewLink',
    { name: titulo || 'Agente', mimeType: 'application/vnd.google-apps.spreadsheet' });
  const { sheets = [] } = await api(sub, 'GET', `${base(f.id)}?fields=sheets.properties`);
  const hoja = sheets[0]?.properties?.title || 'Hoja 1';
  if (encabezados.length) {
    await api(sub, 'PUT', `${base(f.id)}/values/${rango(hoja, 'A1')}?valueInputOption=RAW`, { values: [encabezados] });
  }
  return { id: f.id, url: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`, hoja };
}

// Escribe una tabla de valores desde A1 (sincronización de una planilla local)
export async function escribirValores(sub, planilla, hoja, values) {
  await api(sub, 'PUT', `${base(idPlanilla(planilla))}/values/${rango(hoja, 'A1')}?valueInputOption=RAW`, { values });
}

// Manda la planilla a la papelera del Drive del dueño (se puede recuperar desde Drive)
export async function borrarPlanilla(sub, planilla) {
  await api(sub, 'PATCH', `https://www.googleapis.com/drive/v3/files/${idPlanilla(planilla)}`, { trashed: true });
  previas.clear();
}

// Planillas a las que tiene acceso la app (con drive.file: las que creó), de la más reciente a la más vieja
export async function listarPlanillas(sub) {
  const q = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    orderBy: 'modifiedTime desc',
    pageSize: '100',
    fields: 'files(id,name,webViewLink,modifiedTime,createdTime)',
  });
  const { files = [] } = await api(sub, 'GET', `https://www.googleapis.com/drive/v3/files?${q}`);
  return files.map(f => ({ id: f.id, nombre: f.name, url: f.webViewLink, modificada: f.modifiedTime, creada: f.createdTime }));
}

export async function hojasDe(sub, planilla) {
  const { sheets = [] } = await api(sub, 'GET', `${base(idPlanilla(planilla))}?fields=sheets.properties.title`);
  return sheets.map(s => s.properties.title);
}

// Primeras filas de una hoja (sin hoja: la primera) junto con la lista de hojas, para la vista previa.
// Cache corto: la lista de planillas pide una vista previa por planilla.
const previas = new Map();
export async function vistaPrevia(sub, planilla, hoja, filas = 20) {
  const id = idPlanilla(planilla), clave = `${sub}|${id}|${hoja || ''}`;
  const c = previas.get(clave);
  if (c && Date.now() - c.t < 15000) return c.d;
  const hojas = await hojasDe(sub, id);
  hoja = hojas.includes(hoja) ? hoja : hojas[0];
  const { values = [] } = await api(sub, 'GET', `${base(id)}/values/${rango(hoja, `A1:Z${filas}`)}`);
  const d = { hojas, hoja, filas: values };
  previas.set(clave, { t: Date.now(), d });
  return d;
}

// columnas: [{ columna: 'A', valor }]. Agrega una fila nueva con esos valores.
export async function agregarFila(sub, { planilla, hoja, columnas }) {
  const id = idPlanilla(planilla);
  const fila = [];
  for (const { columna, valor } of columnas) fila[letraANumero(columna) - 1] = valor;
  await api(sub, 'POST', `${base(id)}/values/${rango(hoja, 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { values: [Array.from(fila, v => v ?? '')] });
}

// Busca la primera fila donde `buscarColumna` vale `buscarValor` y escribe ahí las columnas.
// Si no la encuentra y `crear` es true, agrega una fila nueva.
export async function actualizarFila(sub, { planilla, hoja, buscarColumna, buscarValor, columnas, crear }) {
  const id = idPlanilla(planilla);
  const col = buscarColumna.toUpperCase();
  const { values = [] } = await api(sub, 'GET', `${base(id)}/values/${rango(hoja, `${col}:${col}`)}`);
  const i = values.findIndex(([v]) => String(v ?? '').trim().toLowerCase() === String(buscarValor).trim().toLowerCase());
  if (i < 0) {
    if (!crear) return { encontrada: false };
    // El valor buscado viene del cliente: si parece una fórmula va como texto (ver celda en acciones.js)
    const valor = /^[=+\-@\t\r]/.test(buscarValor) && !/^[-+]?\d+([.,]\d+)?$/.test(buscarValor) ? `'${buscarValor}` : buscarValor;
    await agregarFila(sub, { planilla, hoja, columnas: [{ columna: col, valor }, ...columnas] });
    return { encontrada: false, agregada: true };
  }
  await api(sub, 'POST', `${base(id)}/values:batchUpdate`, {
    valueInputOption: 'USER_ENTERED',
    data: columnas.map(({ columna, valor }) => ({
      range: decodeURIComponent(rango(hoja, `${numeroALetra(letraANumero(columna))}${i + 1}`)),
      values: [[valor]],
    })),
  });
  return { encontrada: true, fila: i + 1 };
}
