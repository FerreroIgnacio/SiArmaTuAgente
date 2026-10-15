import { env } from 'cloudflare:workers';
import { botPublico, botsDe, getBot, saveBot } from './store.js';
import { borrarCharlasVencidas, olvidarChat, responder, resumenMensaje } from './engine.js';
import { charlasHoy, registrar, resumen as resumenMetricas } from './metricas.js';
import { rutasAuth, usuario } from './auth.js';
import { ejecutar, interpolar, variables } from './acciones.js';
import { borrarPlanilla, crearPlanilla, desconectarGoogle, estadoGoogle, hojasDe, idPlanilla, listarPlanillas, tokenDe, vistaPrevia } from './google.js';
import { SEGURIDAD, json, redirigir } from './http.js';
import plantilla from './plantilla.json';
import { cifrar } from './cifrado.js';
import { correrPendientes, enviar as enviarMeta, registroDesde, verificar, webhook } from './meta.js';

// Todo el servidor en un Worker de Cloudflare: los estáticos de public/ los sirve Assets y acá solo llegan
// las rutas de run_worker_first (wrangler.jsonc). Guarda en D1 (ver store.js); WhatsApp corre en el navegador.
const PROVEEDORES = ['baileys', 'meta'];
const MAX_CUERPO = 200 * 1024;

const rutas = [];
const ruta = (metodo, patron, fn, { bot = false } = {}) =>
  rutas.push({ metodo, re: new RegExp(`^${patron.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn, bot });

function validar(datos) {
  const p = datos.conexion?.proveedor;
  if (p && !PROVEEDORES.includes(p)) throw new Error(`Proveedor inválido: ${p}`);
  // Los secretos de Meta se guardan cifrados; el valor enmascarado que viene del navegador no pisa el guardado
  const meta = datos.conexion?.meta;
  for (const k of ['accessToken', 'appSecret']) {
    if (meta?.[k] === '••••••••') delete meta[k];
    else if (meta?.[k]) meta[k] = cifrar(String(meta[k]).trim());
  }
  if (meta) { delete meta.activo; delete meta.numero; }
  return datos;
}

// Adjunto que mandó el cliente ({ tipo, nombreArchivo, url, link }). Los archivos nunca pasan por acá: el navegador
// los sube al Drive del dueño (url 'drive:<id>') o, sin Google, quedan en el navegador ('local:<id>').
// `link` es lo que guarda la variable (el link de Drive, para planillas, o el nombre del archivo)
function adjuntoSubido(body) {
  const a = body?.adjunto;
  if (!a?.tipo) return null;
  const url = typeof a.url === 'string' && /^(drive|local):[\w-]+$/.test(a.url) ? a.url : null;
  const link = typeof a.link === 'string' && (/^https:\/\/drive\.google\.com\//.test(a.link) || !/^\w+:/.test(a.link)) ? a.link.slice(0, 300) : '';
  return { tipo: String(a.tipo), nombreArchivo: String(a.nombreArchivo || '').slice(0, 200), url, link };
}

// Las acciones de WhatsApp salen por el número conectado del agente. Con WhatsApp personal la conexión
// está en el navegador: se juntan en `pendientes` y las manda la página (que avisa si está conectada)
const enviarWhatsAppDe = (bot, conectado, pendientes) => async (jid, mensaje) => {
  if (bot.conexion?.proveedor === 'meta' && bot.conexion.meta?.activo) return enviarMeta(bot, jid, mensaje);
  if (bot.conexion?.proveedor !== 'baileys' || !conectado) throw new Error('conectá el agente a WhatsApp para que salga');
  pendientes.push({ jid, mensaje });
};

// Con la API de Meta la conexión vive en el servidor; WhatsApp personal la informa la página
const estadoDe = bot => bot.conexion?.proveedor === 'meta' && bot.conexion.meta?.activo
  ? { estado: 'conectado', numero: bot.conexion.meta.numero, proveedor: 'meta' }
  : { estado: 'desconectado', proveedor: bot.conexion?.proveedor };

ruta('GET', '/api/yo', ({ yo }) => json(yo));

ruta('GET', '/api/bots', async ({ yo }) => json(await Promise.all((await botsDe(yo.sub)).map(async b => ({
  id: b.id, nombre: b.agente.nombre, estado: estadoDe(b).estado,
  estados: Math.max((b.flujo?.nodos?.length || 1) - 1, 0), charlasHoy: await charlasHoy(b.id),
})))));

// Cada cuenta arranca con el agente de ejemplo (src/plantilla.json, archivos en public/plantilla/).
// Los mails de sus acciones van al dueño; las planillas las elige él
ruta('POST', '/api/bots', async ({ yo, body }) => {
  if ((await botsDe(yo.sub)).length) return json({ error: 'Cada cuenta tiene un solo agente' }, 409);
  const ejemplo = structuredClone(plantilla);
  for (const n of ejemplo.flujo.nodos) if (n.accion?.tipo === 'mail') n.accion.para = yo.email;
  const datos = validar(body || {});
  return json(botPublico(await saveBot(null, { ...ejemplo, ...datos, agente: { ...ejemplo.agente, ...datos.agente } }, yo)), 201);
});

ruta('GET', '/api/bots/:id', ({ bot }) => json({ ...botPublico(bot), estado: estadoDe(bot) }), { bot: true });
ruta('PUT', '/api/bots/:id', async ({ bot, yo, body }) => {
  const datos = validar(body || {});
  // Cambiar de proveedor o de número corta la conexión con Meta: hay que volver a conectar
  const m = datos.conexion?.meta;
  if ((datos.conexion?.proveedor && datos.conexion.proveedor !== 'meta') || (m && Object.keys(m).some(k => m[k] !== bot.conexion.meta?.[k]))) {
    datos.conexion = { ...datos.conexion, meta: { ...m, activo: false } };
  }
  const nuevo = await saveBot(bot.id, datos, yo);
  return json({ ...botPublico(nuevo), estado: estadoDe(nuevo) });
}, { bot: true });

// Solo la API de Meta se conecta desde acá (WhatsApp personal corre en la página): valida los datos contra Meta
ruta('POST', '/api/bots/:id/conectar', async ({ bot, yo }) => {
  if (bot.conexion?.proveedor !== 'meta') return json({ estado: 'error', detalle: 'WhatsApp personal se conecta desde la página.' });
  try {
    const { numero } = await verificar(bot);
    const nuevo = await saveBot(bot.id, { conexion: { meta: { activo: true, numero } } }, yo);
    return json(estadoDe(nuevo));
  } catch (err) {
    return json({ estado: 'error', detalle: err.message, proveedor: 'meta' });
  }
}, { bot: true });
ruta('POST', '/api/bots/:id/desconectar', async ({ bot, yo }) => {
  if (bot.conexion?.proveedor === 'meta') await saveBot(bot.id, { conexion: { meta: { activo: false } } }, yo);
  return json({ estado: 'desconectado', proveedor: bot.conexion?.proveedor });
}, { bot: true });
// Conversaciones de la API de Meta (las de WhatsApp personal las guarda la página)
ruta('GET', '/api/bots/:id/registro', async ({ bot, url }) => json(await registroDesde(bot.id, url.searchParams.get('desde'))), { bot: true });
// Eventos en vivo del servidor: no hay (el panel consulta /registro); 204 hace que el navegador no reintente
ruta('GET', '/api/bots/:id/eventos', () => new Response(null, { status: 204 }), { bot: true });

// Probar el agente desde la página, sin WhatsApp
ruta('POST', '/api/bots/:id/probar', async ({ bot, yo, body = {} }) => {
  const chatId = `prueba:${String(body.sesion || 'web').slice(0, 64)}`;
  if (body.reiniciar) { await olvidarChat(bot.id, chatId); return json({ ok: true }); }
  const avanzar = body.avanzar || null;
  const texto = String(body.texto || '').trim();
  const adjunto = adjuntoSubido(body);
  if (!texto && !avanzar && !adjunto) return json({ error: 'Mensaje vacío' }, 400);
  // En la vista previa las acciones se ejecutan de verdad, con el usuario logueado como cliente
  const { vars, archivos, ...res } = await responder(bot, chatId, texto, { nombre: yo.nombre || 'Cliente de prueba', telefono: '5491100000000' }, { avanzar, adjunto });
  const acciones = [], whatsapp = [];
  for (const a of res.acciones) {
    try { acciones.push({ ok: true, detalle: await ejecutar(bot, a, vars, { enviarWhatsApp: enviarWhatsAppDe(bot, body.whatsappConectado, whatsapp), archivos }) }); }
    catch (err) { acciones.push({ ok: false, detalle: `Falló la acción de ${{ mail: 'mail', whatsapp: 'WhatsApp', sheets: 'Sheets' }[a.tipo] || a.tipo}: ${err.message}` }); }
  }
  return json({ ...res, acciones, whatsapp });
}, { bot: true });

// WhatsApp personal corre en el navegador (public/whatsapp.js): por cada mensaje que le llega pregunta acá
// qué responder. Las acciones se ejecutan acá; las de WhatsApp vuelven en `whatsapp` para que las mande la página
ruta('POST', '/api/bots/:id/turno', async ({ bot, body = {} }) => {
  const { chatId, telefono, nombre = '', texto = null, avanzar = null } = body;
  if (!chatId || typeof chatId !== 'string') throw new Error('Falta el chat');
  if (chatId.endsWith('@g.us') && bot.reglas?.ignorarGrupos !== false) return json({ ignorado: true });
  const t0 = Date.now();
  const { mensajes, acciones, vars, archivos, fuente, respuestaId, auto, ignorado, faltaArchivo } = await responder(bot, chatId, texto, { nombre, telefono: telefono || chatId }, { avanzar, adjunto: adjuntoSubido(body) });
  if (ignorado || faltaArchivo) return json({ ignorado, faltaArchivo });
  const whatsapp = [], registro = [];
  for (const a of acciones) {
    try { registro.push(`⚙ ${await ejecutar(bot, a, vars, { enviarWhatsApp: enviarWhatsAppDe(bot, true, whatsapp), archivos })}`); }
    catch (err) { registro.push(`⚠ Acción fallida: ${err.message}`); console.error(`[${bot.id}] acción`, err.message); }
  }
  await registrar(bot.id, { chatId, fuente, respuestaId, enviados: mensajes.length, ms: Date.now() - t0 });
  // Si la charla queda abierta, la página manda la despedida cuando el cliente deja de escribir (engine.EXPIRA_MS)
  const despedida = auto && !auto.destino ? '' : interpolar(bot.agente.despedida, vars).trim();
  return json({ mensajes: mensajes.map(m => ({ ...m, resumen: resumenMensaje(m) })), whatsapp, registro, fuente, auto, despedida });
}, { bot: true });

// Ejecuta de verdad una acción con datos de prueba, para chequear que esté bien configurada
ruta('POST', '/api/bots/:id/acciones/probar', async ({ bot, body = {} }) => {
  const vars = variables({ nombre: 'Cliente de prueba', telefono: '5491100000000', mensaje: 'Mensaje de prueba' });
  const whatsapp = [];
  try {
    return json({ ok: true, detalle: await ejecutar(bot, body.accion || {}, vars, { enviarWhatsApp: enviarWhatsAppDe(bot, body.whatsappConectado, whatsapp) }), whatsapp });
  } catch (err) {
    return json({ ok: false, detalle: err.message });
  }
}, { bot: true });

ruta('GET', '/api/bots/:id/metricas', async ({ bot }) => json(await resumenMetricas(bot)), { bot: true });

// Planillas del dueño para las acciones de Sheets (con drive.file la app solo ve y escribe las que crea).
// Cada una con cuántas acciones de Sheets (de todos los agentes del dueño) la usan
ruta('GET', '/api/planillas', async ({ yo }) => {
  const usos = {};
  for (const b of await botsDe(yo.sub)) {
    for (const n of b.flujo?.nodos || []) {
      if (n.tipo !== 'accion' || n.accion?.tipo !== 'sheets' || !n.accion.planilla) continue;
      const u = (usos[idPlanilla(n.accion.planilla)] ??= { acciones: 0, agentes: new Set() });
      u.acciones++;
      u.agentes.add(b.agente.nombre);
    }
  }
  return json((await listarPlanillas(yo.sub)).map(p => ({ ...p, acciones: usos[p.id]?.acciones || 0, agentes: [...(usos[p.id]?.agentes || [])] })));
});
ruta('POST', '/api/planillas', async ({ yo, body = {} }) => {
  const encabezados = (body.encabezados || []).map(String).slice(0, 26);
  return json(await crearPlanilla(yo.sub, { titulo: String(body.titulo || 'Registros del agente').slice(0, 120), encabezados }), 201);
});
ruta('DELETE', '/api/planillas/:id', async ({ yo, params }) => { await borrarPlanilla(yo.sub, params.id); return json({ ok: true }); });
ruta('GET', '/api/planillas/:id/hojas', async ({ yo, params }) => json(await hojasDe(yo.sub, params.id)));
ruta('GET', '/api/planillas/:id/preview', async ({ yo, params, url }) => json(await vistaPrevia(yo.sub, params.id, url.searchParams.get('hoja'))));

ruta('GET', '/api/google', async ({ yo }) => json(await estadoGoogle(yo.sub)));
// Access token corto (drive.file) para que el navegador suba y baje los archivos directo de Drive
ruta('GET', '/api/google/token', async ({ yo }) => json(await tokenDe(yo.sub, { conVencimiento: true })));
ruta('POST', '/api/google/desconectar', async ({ yo }) => { await desconectarGoogle(yo.sub); return json({ ok: true }); });

// Estado que muestra el panel. Variable ESTADO_SERVIDOR=degradado|caido para avisar demoras o mantenimiento
ruta('GET', '/api/estado', () => json({ estado: ['degradado', 'caido'].includes(env.ESTADO_SERVIDOR) ? env.ESTADO_SERVIDOR : 'operativo' }));

async function api(req, url) {
  const yo = await usuario(req);
  if (!yo) return json({ error: 'Sesión vencida' }, 401);
  const def = rutas.find(x => x.metodo === req.method && x.re.test(url.pathname));
  if (!def) return json({ error: 'No encontrado' }, 404);
  const params = Object.fromEntries(Object.entries(url.pathname.match(def.re).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
  try {
    let body;
    if (['POST', 'PUT'].includes(req.method)) {
      const texto = await req.text();
      if (texto.length > MAX_CUERPO) return json({ error: 'Pedido demasiado grande' }, 413);
      body = texto ? JSON.parse(texto) : {};
    }
    let bot;
    if (def.bot) {
      bot = await getBot(params.id);
      if (!bot || bot.dueno !== yo.sub) return json({ error: 'Bot no encontrado' }, 404);
    }
    return await def.fn({ req, url, params, body, yo, bot });
  } catch (err) {
    console.error(`${req.method} ${url.pathname}`, err);
    return json({ error: err.message }, 400);
  }
}

// Página servida desde Assets, con los headers de seguridad
const pagina = async (req, ruta) => {
  const r = await env.ASSETS.fetch(new URL(ruta, req.url));
  const res = new Response(r.body, r);
  for (const [k, v] of Object.entries(SEGURIDAD)) res.headers.set(k, v);
  return res;
};

export default {
  async fetch(req, _env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p.startsWith('/webhooks/meta/')) return webhook(req, url, ctx);
    if (p.startsWith('/auth/')) return (await rutasAuth(req, url)) || json({ error: 'No encontrado' }, 404);
    if (p.startsWith('/api/')) return api(req, url);
    if (p === '/index.html') return redirigir('/');
    if (p === '/') return (await usuario(req)) ? pagina(req, '/') : redirigir('/login');
    // Assets sirve cada página .html sin la extensión (/ayuda-variables)
    if (p === '/ayuda/variables') return pagina(req, '/ayuda-variables');
    if (p === '/ayuda/api-meta') return pagina(req, '/ayuda-api-meta');
    return env.ASSETS.fetch(req);
  },

  // Cron (wrangler.jsonc): lo programado de la API de Meta y limpieza
  async scheduled() {
    await correrPendientes();
    await borrarCharlasVencidas();
  },
};
