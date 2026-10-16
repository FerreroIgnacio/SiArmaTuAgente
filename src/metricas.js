import { aplanar, db } from './store.js';

// Una ficha JSON por bot en D1. Solo cuenta mensajes reales de WhatsApp, no los de la vista previa.
// Solo cantidades: no se guardan teléfonos, chats ni textos. Una conversación es una charla nueva (engine: vence a los 10 min)
const vacio = () => ({ recibidos: 0, enviados: 0, msTotal: 0, conversaciones: 0, porFuente: {}, porRespuesta: {}, porDia: {} });
const DIAS_GUARDADOS = 30;

async function cargar(botId) {
  const fila = await db().prepare('SELECT datos FROM metricas WHERE bot = ?').bind(botId).first();
  if (!fila) return vacio();
  const m = JSON.parse(fila.datos);
  // Fichas de antes, con los chats: quedan solo las cantidades
  if (m.chats) {
    m.conversaciones = Object.keys(m.chats).length;
    delete m.chats;
    for (const d of Object.values(m.porDia)) { d.conversaciones = d.chats?.length || 0; delete d.chats; }
    await persistir(botId, m);
  }
  return m;
}

const persistir = (botId, m) => db().prepare('INSERT INTO metricas (bot, datos) VALUES (?1, ?2) ON CONFLICT(bot) DO UPDATE SET datos = ?2')
  .bind(botId, JSON.stringify(m)).run();

// Día en hora argentina (el Worker corre en UTC)
const dia = (ts = Date.now()) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

export async function registrar(botId, { nueva, fuente, respuestaId, enviados, ms }) {
  const m = await cargar(botId);
  const d = (m.porDia[dia()] ??= { recibidos: 0, conversaciones: 0 });
  m.recibidos++;
  m.enviados += enviados;
  m.msTotal += ms;
  m.porFuente[fuente] = (m.porFuente[fuente] || 0) + 1;
  if (respuestaId) m.porRespuesta[respuestaId] = (m.porRespuesta[respuestaId] || 0) + 1;
  d.recibidos++;
  if (nueva) { m.conversaciones++; d.conversaciones++; }
  const viejo = dia(Date.now() - DIAS_GUARDADOS * 86400000);
  for (const f of Object.keys(m.porDia)) if (f < viejo) delete m.porDia[f];
  await persistir(botId, m);
}

export const charlasHoy = async botId => (await cargar(botId)).porDia[dia()]?.conversaciones || 0;

export async function resumen(bot, dias = 14) {
  const m = await cargar(bot.id);
  const serie = [];
  for (let i = dias - 1; i >= 0; i--) {
    const fecha = dia(Date.now() - i * 86400000);
    const d = m.porDia[fecha];
    serie.push({ fecha, recibidos: d?.recibidos || 0, conversaciones: d?.conversaciones || 0 });
  }
  const titulos = Object.fromEntries(aplanar(bot.flujo).map(({ nodo, camino }) =>
    [nodo.id, camino.length === 1 ? 'Inicio' : camino.slice(1).map(n => n.nombre || 'Sin nombre').join(' › ')]));
  const resueltos = m.recibidos - (m.porFuente.sin_coincidencia || 0);
  return {
    recibidos: m.recibidos,
    enviados: m.enviados,
    conversaciones: m.conversaciones,
    mensajesPorConversacion: m.conversaciones ? Math.round((m.recibidos / m.conversaciones) * 10) / 10 : 0,
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
