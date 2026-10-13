import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

// Cuenta de Google del dueño para las acciones de Sheets. Se guarda el refresh token por usuario.
// Se pide drive.file (no sensible, sin la advertencia de app no verificada): solo da acceso a las planillas
// que crea la app, por eso las planillas se crean desde acá.
const DIR = path.join(DATA_DIR, 'google');
await mkdir(DIR, { recursive: true });

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPES_INTEGRACION = ['openid', 'email', DRIVE_FILE];

const archivo = sub => path.join(DIR, `${String(sub).replace(/[^\w-]/g, '')}.json`);
const accesos = new Map(); // sub → { token, vence }

async function leer(sub) {
  try { return JSON.parse(await readFile(archivo(sub), 'utf8')); } catch { return null; }
}

export async function guardarCuenta(sub, { refresh_token, email, scope }) {
  const previa = await leer(sub);
  // Google solo manda el refresh token la primera vez que se da permiso: conservar el anterior
  const refresh = refresh_token || previa?.refresh_token;
  if (!refresh) throw new Error('Google no devolvió un refresh token');
  await writeFile(archivo(sub), JSON.stringify({ refresh_token: refresh, email, scope }, null, 2), { mode: 0o600 });
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
  await rm(archivo(sub), { force: true });
  accesos.delete(sub);
}

async function tokenDe(sub) {
  const cache = accesos.get(sub);
  if (cache && cache.vence > Date.now() + 60000) return cache.token;
  const c = await leer(sub);
  if (!c) throw new Error('La cuenta de Google no está conectada (General → Integraciones)');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: c.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Google: ${data.error_description || data.error}. Volvé a conectar la cuenta.`);
  accesos.set(sub, { token: data.access_token, vence: Date.now() + data.expires_in * 1000 });
  return data.access_token;
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

/* ---------- Sheets ---------- */
// Acepta el link completo de la planilla o solo su id
export const idPlanilla = s => String(s || '').match(/\/d\/([\w-]+)/)?.[1] || String(s || '').trim();

const letraANumero = l => [...l.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
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

// Planillas a las que tiene acceso la app (con drive.file: las que creó), de la más reciente a la más vieja
export async function listarPlanillas(sub) {
  const q = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    orderBy: 'modifiedTime desc',
    pageSize: '100',
    fields: 'files(id,name,webViewLink,modifiedTime)',
  });
  const { files = [] } = await api(sub, 'GET', `https://www.googleapis.com/drive/v3/files?${q}`);
  return files.map(f => ({ id: f.id, nombre: f.name, url: f.webViewLink, modificada: f.modifiedTime }));
}

export async function hojasDe(sub, planilla) {
  const { sheets = [] } = await api(sub, 'GET', `${base(idPlanilla(planilla))}?fields=sheets.properties.title`);
  return sheets.map(s => s.properties.title);
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
    await agregarFila(sub, { planilla, hoja, columnas: [{ columna: col, valor: buscarValor }, ...columnas] });
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
