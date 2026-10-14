import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVOS_DIR, METRICAS_DIR } from './store.js';
import { listarPlanillas } from './google.js';

// Descarga del agente para correrlo localmente: la app de escritorio (armada con npm run build:local)
// con el agente pegado al final: [JSON][largo u64][MARCA]. Lo lee src/local/env.js al arrancar.
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const EXTENSIONES = { 'win-x64': '.exe', 'linux-x64': '.AppImage' };
const MARCA = 'SIAGENTE';
const binario = p => path.join(DIST, `si-agente-${p}${EXTENSIONES[p]}`);

export const plataformasDisponibles = () => Object.keys(EXTENSIONES).filter(p => existsSync(binario(p)));

export async function ejecutableDelAgente(bot, plataforma) {
  if (!plataformasDisponibles().includes(plataforma)) throw new Error('Esa plataforma no está disponible para descargar');
  const slug = (bot.agente.nombre || 'agente').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agente';
  const exe = binario(plataforma);

  const archivos = {};
  const dirArchivos = path.join(ARCHIVOS_DIR, bot.id);
  for (const f of await readdir(dirArchivos).catch(() => [])) archivos[f] = (await readFile(path.join(dirArchivos, f))).toString('base64');
  const metricas = await readFile(path.join(METRICAS_DIR, `${bot.id}.json`), 'utf8').then(JSON.parse).catch(() => null);
  // Nombres y links de las planillas para la pestaña Planillas (sin Google conectado va vacía)
  const planillas = await listarPlanillas(bot.dueno).then(ps => ps.map(({ id, nombre, url }) => ({ id, nombre, url })), () => []);
  const json = Buffer.from(JSON.stringify({ bot, metricas, planillas, archivos }));
  const cola = Buffer.alloc(16);
  cola.writeBigUInt64LE(BigInt(json.length), 0);
  cola.write(MARCA, 8, 'latin1');

  return {
    nombre: `SiAgente-${slug}${EXTENSIONES[plataforma]}`,
    exe,
    tam: (await stat(exe)).size + json.length + cola.length,
    paquete: Buffer.concat([json, cola]),
  };
}
