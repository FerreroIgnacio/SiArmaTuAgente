import './env.js';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, listBots, saveBot } from '../store.js';
import { idPlanilla } from '../google.js';
import { botActualizado, conectar, desconectar, estado, suscribir } from '../runtime.js';
import { resumen } from '../metricas.js';

// Versión local de un agente: corre en la compu del dueño, sin login ni nuestros servidores.
// La app de escritorio (src/desktop) la muestra en su ventana. Solo escucha en 127.0.0.1.
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const recurso = nombre => readFileSync(path.join(PUBLIC, nombre), 'utf8');

// Si quedó prendido al cerrar, se vuelve a prender al abrir
const ARCHIVO_LOCAL = path.join(DATA_DIR, 'local.json');
const leerLocal = () => { try { return JSON.parse(readFileSync(ARCHIVO_LOCAL, 'utf8')); } catch { return {}; } };
const guardarEncendido = encendido => writeFileSync(ARCHIVO_LOCAL, JSON.stringify({ ...leerLocal(), encendido }));

// Últimos mensajes de cada chat, en memoria, para que la vista de conversaciones sobreviva a recargar la página
const MAX_POR_CHAT = 200;
const chats = new Map();

// Planillas del dueño al momento de descargar (con nombre y link) + las que usan las acciones del agente
function planillasDe(bot) {
  let conocidas = [];
  try { conocidas = JSON.parse(readFileSync(path.join(DATA_DIR, 'planillas.json'), 'utf8')); } catch {}
  const usos = {};
  for (const n of bot.flujo?.nodos || []) {
    if (n.tipo !== 'accion' || n.accion?.tipo !== 'sheets' || !n.accion.planilla) continue;
    (usos[idPlanilla(n.accion.planilla)] ??= []).push(n.nombre || 'Acción sin nombre');
  }
  const lista = conocidas.map(p => ({ ...p, acciones: usos[p.id] || [] }));
  for (const id of Object.keys(usos)) {
    if (!lista.some(p => p.id === id)) lista.push({ id, nombre: 'Planilla sin nombre', url: `https://docs.google.com/spreadsheets/d/${id}/edit`, acciones: usos[id] });
  }
  return lista.sort((a, b) => b.acciones.length - a.acciones.length);
}

export async function arrancar({ puerto = Number(process.env.PORT) || 0 } = {}) {
  const [bot] = (await listBots()).filter(Boolean);
  if (!bot) throw new Error(`No encontré el agente en ${path.join(DATA_DIR, 'bots')}. Descargá el agente de nuevo desde el creador de agentes.`);
  const id = bot.id;

  suscribir(id, (evento, m) => {
    if (evento !== 'mensaje') return;
    const lista = chats.get(m.chatId) || [];
    lista.push(m);
    chats.set(m.chatId, lista.slice(-MAX_POR_CHAT));
  });

  const app = express();
  app.use(express.json({ limit: '200kb' }));
  const ruta = fn => async (req, res) => {
    try { res.json(await fn(req)); } catch (err) { res.status(400).json({ error: err.message }); }
  };

  app.get(['/', '/index.html'], (req, res) => res.type('html').send(recurso('local.html')));
  app.get('/styles.css', (req, res) => res.type('css').send(recurso('styles.css')));

  app.get('/api/agente', ruta(async () => {
    const b = (await listBots()).find(x => x?.id === id);
    return { nombre: b.agente.nombre, fallback: b.agente.fallback, ignorarGrupos: !!b.reglas?.ignorarGrupos, estado: estado(id) };
  }));
  app.put('/api/agente', ruta(async req => {
    const { nombre, fallback, ignorarGrupos } = req.body || {};
    const agente = {};
    if (typeof nombre === 'string') agente.nombre = nombre.slice(0, 80);
    if (typeof fallback === 'string') agente.fallback = fallback.slice(0, 1000);
    const nuevo = await saveBot(id, { agente, ...(typeof ignorarGrupos === 'boolean' ? { reglas: { ignorarGrupos } } : {}) });
    botActualizado(nuevo);
    return { ok: true };
  }));

  app.post('/api/prender', ruta(async () => { guardarEncendido(true); return conectar(id); }));
  app.post('/api/apagar', ruta(async () => { guardarEncendido(false); return desconectar(id); }));
  app.post('/api/desvincular', ruta(async () => { guardarEncendido(false); return desconectar(id, { cerrarSesion: true }); }));

  app.get('/api/metricas', ruta(async () => resumen((await listBots()).find(x => x?.id === id))));
  app.get('/api/planillas', ruta(async () => planillasDe((await listBots()).find(x => x?.id === id))));
  app.get('/api/conversaciones', ruta(async () => Object.fromEntries(chats)));

  app.get('/api/eventos', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const salir = suscribir(id, (evento, data) => res.write(`event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); salir(); });
  });

  const srv = http.createServer(app);
  await new Promise((ok, mal) => srv.once('error', mal).listen(puerto, '127.0.0.1', ok));
  if (leerLocal().encendido) conectar(id).catch(err => console.error('No se pudo prender el agente:', err.message));
  return { url: `http://127.0.0.1:${srv.address().port}`, nombre: bot.agente.nombre };
}

// Un error suelto (p. ej. de la conexión con WhatsApp) no tiene que tirar abajo el agente
process.on('uncaughtException', err => console.error('[error]', err.message));
process.on('unhandledRejection', err => console.error('[error]', err?.message || err));
