import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Se importa antes que store.js: decide dónde guarda los datos el agente local.
// La descarga es la app con el agente pegado al final: [JSON][largo u64][MARCA] (ver src/descarga.js)
export const MARCA = 'SIAGENTE';

// AppImage (Linux) y portable (Windows) se descomprimen al abrirse: el archivo descargado es el de la variable
const ejecutable = () => (process.platform === 'win32' ? process.env.PORTABLE_EXECUTABLE_FILE : process.env.APPIMAGE) || process.execPath;

function leerPaquete() {
  const fd = openSync(ejecutable(), 'r');
  try {
    const { size } = fstatSync(fd);
    if (size < 16) return null;
    const cola = Buffer.alloc(16);
    readSync(fd, cola, 0, 16, size - 16);
    if (cola.toString('latin1', 8) !== MARCA) return null;
    const largo = Number(cola.readBigUInt64LE(0));
    const json = Buffer.alloc(largo);
    readSync(fd, json, 0, largo, size - 16 - largo);
    return JSON.parse(json.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

const carpetaApp = () => process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SiAgente')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'SiAgente')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'SiAgente');

// Vuelca el agente del paquete en la carpeta de datos. La sesión de WhatsApp y las métricas
// que ya haya se conservan; la configuración se pisa solo si la descargada es más nueva.
function instalar(dir, { bot, metricas, planillas, archivos = {} }) {
  const escribir = (rel, datos, pisar = false) => {
    const destino = path.join(dir, rel);
    if (!pisar && existsSync(destino)) return;
    mkdirSync(path.dirname(destino), { recursive: true });
    writeFileSync(destino, datos);
  };
  const rutaBot = path.join('bots', `${bot.id}.json`);
  let actual = null;
  try { actual = JSON.parse(readFileSync(path.join(dir, rutaBot), 'utf8')); } catch {}
  const nuevo = !actual || (bot.actualizado || '') > (actual.actualizado || '');
  escribir(rutaBot, JSON.stringify(bot, null, 2), nuevo);
  if (planillas) escribir('planillas.json', JSON.stringify(planillas), nuevo);
  if (metricas) escribir(path.join('metricas', `${bot.id}.json`), JSON.stringify(metricas));
  for (const [nombre, b64] of Object.entries(archivos)) escribir(path.join('archivos', bot.id, nombre), Buffer.from(b64, 'base64'));
}

let paquete = null;
try { paquete = leerPaquete(); } catch (err) { console.error('No se pudo leer el agente del ejecutable:', err.message); }
if (paquete) {
  process.env.DATA_DIR ||= path.join(carpetaApp(), paquete.bot.id);
  instalar(process.env.DATA_DIR, paquete);
}
process.env.DATA_DIR ||= path.resolve('datos-local');
export const DATOS = process.env.DATA_DIR;
