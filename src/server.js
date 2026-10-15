import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { ARCHIVOS_DIR, botPublico, getBot, listBots, saveBot } from './store.js';
import { botActualizado, conectar, desconectar, estado, providerDe, suscribir } from './runtime.js';
import { responder, olvidarChat } from './engine.js';
import { proveedoresDisponibles } from './providers/index.js';
import { charlasHoy, resumen as resumenMetricas } from './metricas.js';
import { estadoLLM } from './llm.js';
import { requerirLogin, rutasAuth } from './auth.js';
import { ejecutar, variables } from './acciones.js';
import { ejecutableDelAgente, plataformasDisponibles } from './descarga.js';
import { crearPlanilla, desconectarGoogle, estadoGoogle, hojasDe, idPlanilla, listarPlanillas, vistaPrevia } from './google.js';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '200kb' }));
rutasAuth(app);
app.get(['/', '/index.html'], requerirLogin);
app.get('/ayuda/variables', (req, res) => res.sendFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/ayuda-variables.html')));
app.get('/ayuda/api-meta', (req, res) => res.sendFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/ayuda-api-meta.html')));
app.use('/api', requerirLogin);
app.use(express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')));
app.use('/archivos', express.static(ARCHIVOS_DIR));

const conBot = fn => async (req, res) => {
  try {
    const bot = await getBot(req.params.id);
    if (!bot || bot.dueno !== req.usuario.sub) return res.status(404).json({ error: 'Bot no encontrado' });
    await fn(bot, req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

function validar(datos) {
  const p = datos.conexion?.proveedor;
  if (p && !proveedoresDisponibles.includes(p)) throw new Error(`Proveedor inválido: ${p}`);
  // El token enmascarado que viene del navegador no pisa el guardado
  if (datos.conexion?.meta?.accessToken === '••••••••') delete datos.conexion.meta.accessToken;
  return datos;
}

app.get('/api/yo', (req, res) => res.json(req.usuario));

app.get('/api/bots', async (req, res) => {
  const bots = (await listBots()).filter(b => b?.dueno === req.usuario.sub).sort((a, b) => a.creado.localeCompare(b.creado));
  res.json(await Promise.all(bots.map(async b => ({
    id: b.id, nombre: b.agente.nombre, estado: estado(b.id).estado,
    estados: Math.max((b.flujo?.nodos?.length || 1) - 1, 0), charlasHoy: await charlasHoy(b.id),
  }))));
});

app.post('/api/bots', async (req, res) => {
  try {
    if ((await listBots()).some(b => b?.dueno === req.usuario.sub)) return res.status(409).json({ error: 'Cada cuenta tiene un solo agente' });
    // Nombre por defecto: "Agente de <nombre de la cuenta>"
    const nombre = `Agente de ${req.usuario.nombre || req.usuario.email.split('@')[0]}`;
    const datos = validar(req.body);
    res.status(201).json(botPublico(await saveBot(null, { ...datos, agente: { nombre, ...datos.agente } }, req.usuario)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/bots/:id', conBot((bot, req, res) => res.json({ ...botPublico(bot), estado: estado(bot.id) })));

app.put('/api/bots/:id', conBot(async (bot, req, res) => {
  const nuevo = await saveBot(bot.id, validar(req.body), req.usuario);
  // Cambiar de proveedor corta la conexión actual: hay que volver a conectar
  if (nuevo.conexion.proveedor !== bot.conexion.proveedor) await desconectar(bot.id);
  else botActualizado(nuevo);
  res.json(botPublico(nuevo));
}));

app.post('/api/bots/:id/conectar', conBot(async (bot, req, res) => res.json(await conectar(bot.id))));
app.post('/api/bots/:id/desconectar', conBot(async (bot, req, res) =>
  res.json(await desconectar(bot.id, { cerrarSesion: !!req.body?.cerrarSesion }))));

// Probar el agente desde la página, sin WhatsApp
app.post('/api/bots/:id/probar', conBot(async (bot, req, res) => {
  const chatId = `prueba:${req.body?.sesion || 'web'}`;
  if (req.body?.reiniciar) { olvidarChat(bot.id, chatId); return res.json({ ok: true }); }
  const avanzar = req.body?.avanzar || null;
  const texto = String(req.body?.texto || '').trim();
  if (!texto && !avanzar) return res.status(400).json({ error: 'Mensaje vacío' });
  // En la vista previa las acciones se ejecutan de verdad, con el usuario logueado como cliente
  const { vars, ...res2 } = await responder(bot, chatId, texto, { nombre: req.usuario.nombre || 'Cliente de prueba', telefono: '5491100000000' }, { avanzar });
  const acciones = [];
  for (const a of res2.acciones) {
    try { acciones.push({ ok: true, detalle: await ejecutar(bot, a, vars, { enviarWhatsApp: enviarWhatsAppDe(bot) }) }); }
    catch (err) { acciones.push({ ok: false, detalle: `Falló la acción de ${{ mail: 'mail', whatsapp: 'WhatsApp', sheets: 'Sheets' }[a.tipo] || a.tipo}: ${err.message}` }); }
  }
  res.json({ ...res2, acciones });
}));

// Las acciones de WhatsApp salen por el número conectado del agente
const enviarWhatsAppDe = bot => async (jid, texto) => {
  const p = providerDe(bot.id);
  if (!p || estado(bot.id).estado !== 'conectado') throw new Error('conectá el agente a WhatsApp para que salga');
  await p.send(jid, { tipo: 'texto', texto });
};

// Ejecuta de verdad una acción con datos de prueba, para chequear que esté bien configurada
app.post('/api/bots/:id/acciones/probar', conBot(async (bot, req, res) => {
  const vars = variables({ nombre: 'Cliente de prueba', telefono: '5491100000000', mensaje: 'Mensaje de prueba' });
  const enviarWhatsApp = enviarWhatsAppDe(bot);
  try {
    res.json({ ok: true, detalle: await ejecutar(bot, req.body?.accion || {}, vars, { enviarWhatsApp }) });
  } catch (err) {
    res.json({ ok: false, detalle: err.message });
  }
}));

// Planillas del dueño para las acciones de Sheets (con drive.file la app solo ve y escribe las que crea)
const conGoogle = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) { res.status(400).json({ error: err.message }); }
};
// Cada planilla con cuántas acciones de Sheets (de todos los agentes del dueño) la usan
app.get('/api/planillas', conGoogle(async (req, res) => {
  const usos = {};
  for (const b of (await listBots()).filter(b => b?.dueno === req.usuario.sub)) {
    for (const n of b.flujo?.nodos || []) {
      if (n.tipo !== 'accion' || n.accion?.tipo !== 'sheets' || !n.accion.planilla) continue;
      const u = (usos[idPlanilla(n.accion.planilla)] ??= { acciones: 0, agentes: new Set() });
      u.acciones++;
      u.agentes.add(b.agente.nombre);
    }
  }
  res.json((await listarPlanillas(req.usuario.sub)).map(p => ({
    ...p, acciones: usos[p.id]?.acciones || 0, agentes: [...(usos[p.id]?.agentes || [])],
  })));
}));
app.post('/api/planillas', conGoogle(async (req, res) => {
  const encabezados = (req.body?.encabezados || []).map(String).slice(0, 26);
  res.status(201).json(await crearPlanilla(req.usuario.sub, { titulo: String(req.body?.titulo || 'Registros del agente').slice(0, 120), encabezados }));
}));
app.get('/api/planillas/:id/hojas', conGoogle(async (req, res) => res.json(await hojasDe(req.usuario.sub, req.params.id))));

app.get('/api/planillas/:id/preview', conGoogle(async (req, res) => res.json(await vistaPrevia(req.usuario.sub, req.params.id, req.query.hoja))));

app.get('/api/google', async (req, res) => res.json(await estadoGoogle(req.usuario.sub)));
app.post('/api/google/desconectar', async (req, res) => { await desconectarGoogle(req.usuario.sub); res.json({ ok: true }); });

app.get('/api/bots/:id/metricas', conBot(async (bot, req, res) => res.json(await resumenMetricas(bot))));

// Subida de imágenes/documentos para las respuestas
app.post('/api/bots/:id/archivos', express.raw({ type: () => true, limit: '16mb' }), conBot(async (bot, req, res) => {
  if (!req.body?.length) throw new Error('Archivo vacío');
  const nombre = decodeURIComponent(req.get('x-nombre') || 'archivo').replace(/[^\w.\- ]+/g, '_').slice(-80);
  const rel = `${bot.id}/${randomUUID().slice(0, 8)}-${nombre}`;
  await mkdir(path.join(ARCHIVOS_DIR, bot.id), { recursive: true });
  await writeFile(path.join(ARCHIVOS_DIR, rel), req.body);
  res.status(201).json({ url: `/archivos/${rel.split('/').map(encodeURIComponent).join('/')}`, nombre });
}));

// Estado que muestra el panel. ESTADO_SERVIDOR=degradado|caido en .env para avisar demoras o mantenimiento
app.get('/api/estado', (req, res) => res.json({ estado: ['degradado', 'caido'].includes(process.env.ESTADO_SERVIDOR) ? process.env.ESTADO_SERVIDOR : 'operativo' }));

// Descargar el agente para correrlo localmente (ver src/local)
app.get('/api/descargas', (req, res) => res.json(plataformasDisponibles()));
app.get('/api/bots/:id/descargar', conBot(async (bot, req, res) => {
  const { nombre, exe, tam, paquete } = await ejecutableDelAgente(bot, String(req.query.plataforma || ''));
  res.attachment(nombre);
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(tam) });
  const lectura = createReadStream(exe);
  lectura.on('error', () => res.destroy());
  lectura.on('end', () => res.end(paquete));
  lectura.pipe(res, { end: false });
}));

app.get('/api/llm', async (req, res) => res.json(await estadoLLM()));

app.get('/api/bots/:id/eventos', conBot((bot, req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (evento, data) => res.write(`event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`);
  const salir = suscribir(bot.id, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); salir(); });
}));

// Webhook de la API de Meta (stub). Ver src/providers/meta.js
app.all('/webhooks/meta/:id', (req, res) => res.sendStatus(501));

const PORT = Number(process.env.PORT) || 3210;
app.listen(PORT, () => console.log(`Si · Armá tu agente → http://localhost:${PORT}`));
