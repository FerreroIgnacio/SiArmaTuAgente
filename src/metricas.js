import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { METRICAS_DIR, aplanar } from './store.js';

// Una ficha JSON por bot. Solo cuenta mensajes reales de WhatsApp, no los de la vista previa.
const cache = new Map();
const pendientes = new Map();

const archivo = id => path.join(METRICAS_DIR, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`);
const vacio = () => ({ recibidos: 0, enviados: 0, msTotal: 0, porFuente: {}, porRespuesta: {}, porDia: {}, chats: {} });

async function cargar(botId) {
  if (!cache.has(botId)) {
    const m = await readFile(archivo(botId), 'utf8').then(JSON.parse).catch(vacio);
    cache.set(botId, m);
  }
  return cache.get(botId);
}

function persistir(botId) {
  clearTimeout(pendientes.get(botId));
  pendientes.set(botId, setTimeout(() => {
    writeFile(archivo(botId), JSON.stringify(cache.get(botId))).catch(err => console.error('[metricas]', err.message));
  }, 1000));
}

const dia = (ts = Date.now()) => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export async function registrar(botId, { chatId, fuente, respuestaId, enviados, ms }) {
  const m = await cargar(botId);
  const d = (m.porDia[dia()] ??= { recibidos: 0, chats: [] });
  m.recibidos++;
  m.enviados += enviados;
  m.msTotal += ms;
  m.porFuente[fuente] = (m.porFuente[fuente] || 0) + 1;
  if (respuestaId) m.porRespuesta[respuestaId] = (m.porRespuesta[respuestaId] || 0) + 1;
  m.chats[chatId] = Date.now();
  d.recibidos++;
  if (!d.chats.includes(chatId)) d.chats.push(chatId);
  persistir(botId);
}

export async function resumen(bot, dias = 14) {
  const m = await cargar(bot.id);
  const serie = [];
  for (let i = dias - 1; i >= 0; i--) {
    const fecha = dia(Date.now() - i * 86400000);
    const d = m.porDia[fecha];
    serie.push({ fecha, recibidos: d?.recibidos || 0, conversaciones: d?.chats.length || 0 });
  }
  const titulos = Object.fromEntries(aplanar(bot.flujo).map(({ nodo, camino }) =>
    [nodo.id, camino.length === 1 ? 'Inicio' : camino.slice(1).map(n => n.nombre || 'Sin nombre').join(' › ')]));
  const resueltos = m.recibidos - (m.porFuente.sin_coincidencia || 0);
  return {
    recibidos: m.recibidos,
    enviados: m.enviados,
    conversaciones: Object.keys(m.chats).length,
    resueltos,
    sinCoincidencia: m.porFuente.sin_coincidencia || 0,
    porFuente: m.porFuente,
    msPromedio: m.recibidos ? Math.round(m.msTotal / m.recibidos) : 0,
    serie,
    top: Object.entries(m.porRespuesta)
      .map(([id, usos]) => ({ id, titulo: titulos[id] || 'Respuesta eliminada', usos }))
      .sort((a, b) => b.usos - a.usos)
      .slice(0, 10),
  };
}
