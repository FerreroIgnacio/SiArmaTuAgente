import QRCode from 'qrcode';
import { createProvider } from './providers/index.js';
import { responder, resumenMensaje } from './engine.js';
import { ejecutar } from './acciones.js';
import { registrar } from './metricas.js';
import { getBot } from './store.js';

// Un runtime por bot: provider activo + estado + suscriptores SSE
const runtimes = new Map();

function rt(botId) {
  if (!runtimes.has(botId)) {
    runtimes.set(botId, { provider: null, estado: { estado: 'desconectado' }, subs: new Set() });
  }
  return runtimes.get(botId);
}

function publicar(botId, evento, data) {
  for (const send of rt(botId).subs) send(evento, data);
}

export function estado(botId) {
  return rt(botId).estado;
}

export function suscribir(botId, send) {
  const r = rt(botId);
  r.subs.add(send);
  send('status', r.estado);
  return () => r.subs.delete(send);
}

export async function conectar(botId) {
  const bot = await getBot(botId);
  if (!bot) throw new Error('Bot no encontrado');
  const r = rt(botId);
  if (r.provider) await r.provider.stop();

  const provider = createProvider(bot);
  r.provider = provider;

  provider.on('status', async s => {
    if (r.provider !== provider) return;
    const { qr, ...resto } = s;
    r.estado = { ...resto, proveedor: bot.conexion.proveedor };
    if (qr) r.estado.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280, color: { dark: '#1f1a17' } });
    publicar(botId, 'status', r.estado);
  });

  provider.on('message', async ({ chatId, from, nombre, texto }) => {
    const t0 = Date.now();
    publicar(botId, 'mensaje', { chatId, nombre, texto, de: 'cliente', ts: t0 });
    try {
      const actual = (await getBot(botId)) || bot;
      const { mensajes, acciones, vars, fuente, respuestaId } = await responder(actual, chatId, texto, { nombre, telefono: from || chatId });
      for (const m of mensajes) {
        // Pausa "escribiendo…" de 2 a 6 s antes de cada mensaje, para no responder como un bot instantáneo
        await provider.typing(chatId);
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 4000));
        await provider.send(chatId, m);
        publicar(botId, 'mensaje', { chatId, nombre, texto: resumenMensaje(m), de: 'bot', fuente, ts: Date.now() });
      }
      await registrar(botId, { chatId, fuente, respuestaId, enviados: mensajes.length, ms: Date.now() - t0 });
      // Las acciones van después de responder: un error en una no frena la charla ni las demás
      for (const a of acciones) {
        let resultado;
        try { resultado = `⚙ ${await ejecutar(actual, a, vars, { enviarWhatsApp: (jid, t) => provider.send(jid, { tipo: 'texto', texto: t }) })}`; }
        catch (err) { resultado = `⚠ Acción fallida: ${err.message}`; console.error(`[${botId}] acción`, err.message); }
        publicar(botId, 'mensaje', { chatId, nombre, texto: resultado, de: 'bot', fuente: 'accion', ts: Date.now() });
      }
      publicar(botId, 'metricas', {});
    } catch (err) {
      console.error(`[${botId}]`, err.message);
    }
  });

  await provider.start();
  return r.estado;
}

export async function desconectar(botId, { cerrarSesion = false } = {}) {
  const r = rt(botId);
  if (!r.provider) return r.estado;
  const p = r.provider;
  if (cerrarSesion) await p.logout(); else await p.stop();
  r.provider = null;
  r.estado = { estado: 'desconectado' };
  publicar(botId, 'status', r.estado);
  return r.estado;
}

// El provider lee reglas de su copia del bot: mantenerla al día cuando se guarda
export function botActualizado(bot) {
  const p = runtimes.get(bot.id)?.provider;
  if (p) p.bot = bot;
}

export function providerDe(botId) {
  return runtimes.get(botId)?.provider || null;
}
