import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { db, getBot } from './store.js';
import { descifrar } from './cifrado.js';
import { EXPIRA_MS, responder, resumenMensaje } from './engine.js';
import { ejecutar, interpolar } from './acciones.js';
import { registrar } from './metricas.js';
import { bajarArchivo, subirArchivo } from './google.js';

// WhatsApp Cloud API (Meta). A diferencia de WhatsApp personal, corre entero en el Worker: no hace falta la pestaña abierta.
//   bot.conexion.meta: { phoneNumberId, accessToken (cifrado), appSecret (cifrado), verifyToken, activo, numero }
//   Webhook /webhooks/meta/:botId → GET verifica el verify token; POST trae los mensajes (firmados con el app secret)
//   Lo que tiene que pasar más tarde (avance automático largo, despedida por inactividad) queda en la tabla pendientes
//   y lo corre el cron de cada minuto. El registro de conversaciones queda 7 días en la tabla registro (lo lee el panel)
const GRAPH = 'https://graph.facebook.com/v23.0';
const AUTO_EN_LINEA = 10; // s: avances automáticos más cortos se hacen en el momento; los demás, por el cron

const config = bot => bot.conexion?.meta || {};
const secreto = v => { try { return v ? descifrar(v) : ''; } catch { return ''; } };

async function graph(bot, metodo, ruta, body) {
  const form = body instanceof FormData;
  const r = await fetch(`${GRAPH}/${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${secreto(config(bot).accessToken)}`, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Meta: ${data.error?.error_user_msg || data.error?.message || r.status}`);
  return data;
}

// Valida los datos contra Meta → { numero, nombre }
export async function verificar(bot) {
  const { phoneNumberId, accessToken, appSecret, verifyToken } = config(bot);
  const faltan = [['Phone number ID', phoneNumberId], ['Access token', accessToken], ['App secret', appSecret], ['Verify token', verifyToken]].filter(([, v]) => !v).map(([k]) => k);
  if (faltan.length) throw new Error(`Faltan datos de Meta: ${faltan.join(', ')}`);
  const d = await graph(bot, 'GET', `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`);
  return { numero: String(d.display_phone_number || '').replace(/\D/g, ''), nombre: d.verified_name || '' };
}

// Archivo de un mensaje → { id } (subido a Meta) o { link } (URL pública)
async function media(bot, url, nombre) {
  if (url?.startsWith('drive:')) {
    const { datos, tipo } = await bajarArchivo(bot.dueno, url.slice(6));
    const f = new FormData();
    f.append('messaging_product', 'whatsapp');
    f.append('type', tipo);
    f.append('file', new Blob([datos], { type: tipo }), nombre || 'archivo');
    return { id: (await graph(bot, 'POST', `${config(bot).phoneNumberId}/media`, f)).id };
  }
  if (url?.startsWith('/')) return { link: `${env.BASE_URL}${url}` };
  if (/^https:\/\//.test(url || '')) return { link: url };
  throw new Error('El archivo no está disponible para la API de Meta (subilo de nuevo con Google conectado)');
}

// Mensaje genérico (ver engine.renderizar) → mensaje de la Cloud API
async function contenido(bot, m) {
  switch (m.tipo) {
    case 'imagen': return { type: 'image', image: { ...(await media(bot, m.url, 'imagen')), caption: m.texto || undefined } };
    case 'documento': return { type: 'document', document: { ...(await media(bot, m.url, m.nombreArchivo)), filename: m.nombreArchivo || 'archivo', caption: m.texto || undefined } };
    case 'audio': return { type: 'audio', audio: await media(bot, m.url, m.nombreArchivo || 'audio') };
    case 'video': return { type: 'video', video: { ...(await media(bot, m.url, m.nombreArchivo || 'video')), caption: m.texto || undefined } };
    case 'ubicacion': return { type: 'location', location: { latitude: m.lat, longitude: m.lng, name: m.nombre || undefined, address: m.direccion || undefined } };
    case 'contacto': {
      const tel = String(m.telefono).replace(/[^\d+]/g, '');
      return { type: 'contacts', contacts: [{ name: { formatted_name: m.nombre, first_name: m.nombre }, phones: [{ phone: tel, wa_id: tel.replace('+', ''), type: 'CELL' }] }] };
    }
    case 'encuesta': return { type: 'text', text: { body: resumenMensaje(m) } };
    default: return { type: 'text', text: { body: m.texto, preview_url: false } };
  }
}

export async function enviar(bot, to, m) {
  const numero = String(to).split('@')[0].split(':')[0].replace(/\D/g, '');
  await graph(bot, 'POST', `${config(bot).phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: numero, ...(await contenido(bot, m)) });
}

// Tildes azules y "escribiendo…" (dura hasta que sale la respuesta o 25 s)
const escribiendo = (bot, messageId) => graph(bot, 'POST', `${config(bot).phoneNumberId}/messages`,
  { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }).catch(() => {});

const esperar = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Registro de conversaciones (lo muestra el panel) ---------- */
const anotar = (botId, m) => db().prepare('INSERT INTO registro (bot, ts, datos) VALUES (?, ?, ?)').bind(botId, m.ts, JSON.stringify(m)).run();

export async function registroDesde(botId, desde) {
  const { results } = await db().prepare('SELECT datos FROM registro WHERE bot = ? AND ts > ? ORDER BY ts LIMIT 500').bind(botId, Number(desde) || 0).all();
  return results.map(f => JSON.parse(f.datos));
}

/* ---------- Webhook ---------- */
function firmaValida(bot, cuerpo, firma) {
  const app = secreto(config(bot).appSecret);
  if (!app || !firma?.startsWith('sha256=')) return false;
  const a = Buffer.from(firma.slice(7)), b = Buffer.from(createHmac('sha256', app).update(cuerpo).digest('hex'));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function webhook(req, url, ctx) {
  const bot = await getBot(url.pathname.split('/')[3] || '');
  if (!bot || bot.conexion?.proveedor !== 'meta') return new Response('No encontrado', { status: 404 });
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && config(bot).verifyToken && url.searchParams.get('hub.verify_token') === config(bot).verifyToken;
    return ok ? new Response(url.searchParams.get('hub.challenge') || '') : new Response('Verify token inválido', { status: 403 });
  }
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const cuerpo = await req.text();
  if (!firmaValida(bot, cuerpo, req.headers.get('x-hub-signature-256'))) return new Response('Firma inválida', { status: 401 });
  if (!config(bot).activo) return new Response('ok');
  let datos;
  try { datos = JSON.parse(cuerpo); } catch { return new Response('JSON inválido', { status: 400 }); }
  for (const cambio of (datos.entry || []).flatMap(e => e.changes || [])) {
    const v = cambio.value || {};
    if (v.metadata?.phone_number_id && v.metadata.phone_number_id !== config(bot).phoneNumberId) continue;
    for (const msg of v.messages || []) {
      const nombre = v.contacts?.find(c => c.wa_id === msg.from)?.profile?.name || '';
      ctx.waitUntil(recibir(bot, msg, nombre).catch(err => console.error(`[${bot.id}] meta`, err)));
    }
  }
  // Meta reintenta si no recibe 200 rápido: se contesta ya y se procesa en segundo plano
  return new Response('ok');
}

// Texto y adjunto de un mensaje entrante
function leer(msg) {
  const t = msg.type;
  if (t === 'text') return { texto: msg.text?.body || '' };
  if (t === 'interactive') return { texto: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '' };
  if (t === 'button') return { texto: msg.button?.text || '' };
  const tipos = { image: 'imagen', video: 'video', document: 'documento', sticker: 'sticker', location: 'ubicacion', contacts: 'contacto' };
  if (t === 'audio') return { texto: '', adjunto: { tipo: msg.audio?.voice ? 'nota de voz' : 'audio', mediaId: msg.audio?.id } };
  if (!tipos[t]) return null;
  const m = msg[t] || {};
  return { texto: (m.caption || '').trim(), adjunto: { tipo: tipos[t], nombreArchivo: m.filename || '', mediaId: m.id } };
}

async function recibir(bot, msg, nombre) {
  // Meta puede mandar el mismo mensaje más de una vez
  const nuevo = await db().prepare('INSERT OR IGNORE INTO meta_vistos (id, ts) VALUES (?, ?)').bind(msg.id, Date.now()).run();
  if (!nuevo.meta.changes) return;
  const leido = leer(msg);
  if (!leido) return;
  const { texto, adjunto } = leido;
  if (adjunto?.mediaId) {
    // Si el estado pide un archivo: se baja de Meta y se guarda en el Drive del dueño
    adjunto.bajar = async () => {
      try {
        const info = await graph(bot, 'GET', encodeURIComponent(adjunto.mediaId));
        const r = await fetch(info.url, { headers: { Authorization: `Bearer ${secreto(config(bot).accessToken)}` } });
        if (!r.ok) throw new Error(`Meta: no se pudo bajar el archivo (${r.status})`);
        const ext = String(info.mime_type || '').split(';')[0].split('/')[1] || 'bin';
        const subido = await subirArchivo(bot.dueno, await r.arrayBuffer(), info.mime_type || 'application/octet-stream', adjunto.nombreArchivo || `${adjunto.tipo.replace(' ', '-')}.${ext}`);
        adjunto.link = subido.link;
        return subido.url;
      } catch (err) { adjunto.error = err.message; return null; }
    };
  }
  escribiendo(bot, msg.id);
  await turno(bot, { chatId: msg.from, nombre, texto: texto || null, adjunto });
}

// Un turno de la charla: responde, ejecuta las acciones y deja programado lo que sigue
async function turno(bot, { chatId, nombre, texto = null, adjunto = null, avanzar = null }) {
  const t0 = Date.now();
  await db().prepare('DELETE FROM pendientes WHERE bot = ? AND chat = ?').bind(bot.id, chatId).run();
  const actual = (await getBot(bot.id)) || bot;
  const { mensajes, acciones, vars, archivos, fuente, respuestaId, auto, ignorado, faltaArchivo } = await responder(actual, chatId, texto, { nombre, telefono: chatId }, { avanzar, adjunto });
  if (!avanzar && (texto || adjunto)) await anotar(bot.id, { chatId, nombre, texto: texto || '', adjunto: adjunto && { tipo: adjunto.tipo, nombreArchivo: adjunto.nombreArchivo }, de: 'cliente', ts: t0 });
  // El estado pedía un archivo pero no se pudo guardar (sin Google conectado): queda avisado en el registro
  if (faltaArchivo) await anotar(bot.id, { chatId, nombre, texto: `⚠ No se pudo guardar el archivo del cliente: ${adjunto?.error || 'conectá Google en General → Integraciones'}`, de: 'bot', fuente: 'accion', ts: Date.now() });
  if (ignorado || faltaArchivo) return;
  for (const [i, m] of mensajes.entries()) {
    if (i) await esperar(1000);
    try {
      await enviar(actual, chatId, m);
      await anotar(bot.id, { chatId, nombre, texto: resumenMensaje(m), de: 'bot', fuente, ts: Date.now() });
    } catch (err) {
      await anotar(bot.id, { chatId, nombre, texto: `⚠ No se pudo enviar: ${err.message}`, de: 'bot', fuente: 'accion', ts: Date.now() });
    }
  }
  await registrar(bot.id, { chatId, fuente, respuestaId, enviados: mensajes.length, ms: Date.now() - t0 });
  for (const a of acciones) {
    let resultado;
    try { resultado = `⚙ ${await ejecutar(actual, a, vars, { enviarWhatsApp: (jid, m) => enviar(actual, jid, m), archivos })}`; }
    catch (err) { resultado = `⚠ Acción fallida: ${err.message}`; }
    await anotar(bot.id, { chatId, nombre, texto: resultado, de: 'bot', fuente: 'accion', ts: Date.now() });
  }
  // Lo que sigue: avance automático (corto: ahora; largo: por el cron) o despedida si el cliente deja de escribir
  if (auto?.destino && auto.espera <= AUTO_EN_LINEA) {
    await esperar(auto.espera * 1000);
    return turno(bot, { chatId, nombre, avanzar: auto.destino });
  }
  const despedida = auto && !auto.destino ? '' : interpolar(actual.agente.despedida, vars).trim();
  const pendiente = auto?.destino ? { tipo: 'avanzar', valor: auto.destino, cuando: Date.now() + auto.espera * 1000 }
    : despedida ? { tipo: 'despedida', valor: despedida, cuando: Date.now() + EXPIRA_MS } : null;
  if (pendiente) {
    await db().prepare('INSERT INTO pendientes (bot, chat, nombre, tipo, valor, cuando) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(bot, chat) DO UPDATE SET nombre = excluded.nombre, tipo = excluded.tipo, valor = excluded.valor, cuando = excluded.cuando')
      .bind(bot.id, chatId, nombre, pendiente.tipo, pendiente.valor, pendiente.cuando).run();
  }
}

// Cron: avances automáticos y despedidas que ya tocan; limpieza de lo viejo
export async function correrPendientes() {
  const ahora = Date.now();
  const { results } = await db().prepare('SELECT * FROM pendientes WHERE cuando <= ? LIMIT 100').bind(ahora).all();
  for (const p of results) {
    const borrado = await db().prepare('DELETE FROM pendientes WHERE bot = ? AND chat = ? AND cuando = ?').bind(p.bot, p.chat, p.cuando).run();
    if (!borrado.meta.changes) continue;
    const bot = await getBot(p.bot);
    if (!bot || bot.conexion?.proveedor !== 'meta' || !config(bot).activo) continue;
    try {
      if (p.tipo === 'avanzar') await turno(bot, { chatId: p.chat, nombre: p.nombre, avanzar: p.valor });
      else {
        await enviar(bot, p.chat, { tipo: 'texto', texto: p.valor });
        await anotar(bot.id, { chatId: p.chat, nombre: p.nombre, texto: p.valor, de: 'bot', fuente: 'despedida', ts: Date.now() });
      }
    } catch (err) { console.error(`[${p.bot}] pendiente`, err); }
  }
  await db().batch([
    db().prepare('DELETE FROM meta_vistos WHERE ts < ?').bind(ahora - 24 * 3600 * 1000),
    db().prepare('DELETE FROM registro WHERE ts < ?').bind(ahora - 7 * 24 * 3600 * 1000),
  ]);
}
