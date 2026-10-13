import { aplanar } from './store.js';

// LLM local con Ollama (corre en el server de la empresa).
// OLLAMA_URL   → p. ej. http://192.168.1.50:11434
// OLLAMA_MODEL → modelo ya bajado con `ollama pull`
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 60000;

// TODO: prompts definitivos. Por ahora uno base armado con lo que hay cargado.
export function construirPrompt(bot) {
  const { negocio: n, agente: a } = bot;
  const respuestas = aplanar(bot.flujo)
    .map(({ nodo, camino }) => ({ camino, texto: (nodo.mensajes || []).filter(m => m.tipo === 'texto' && m.texto).map(m => m.texto).join('\n') }))
    .filter(({ camino, texto }) => camino.length > 1 && texto)
    .map(({ camino, texto }) => `- ${camino.slice(1).map(n => n.nombre).join(' › ')}: ${texto}`)
    .join('\n');
  return [
    `Sos ${a.nombre || 'un asistente'}, que atiende por WhatsApp${n.nombre ? ` a los clientes de ${n.nombre}` : ''}.`,
    'Respondé en español, corto y claro. No inventes datos que no estén acá.',
    respuestas && `Información disponible:\n${respuestas}`,
  ].filter(Boolean).join('\n\n');
}

export async function generar(bot, historial) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [{ role: 'system', content: construirPrompt(bot) }, ...historial],
    }),
  });
  if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
  const data = await res.json();
  return data.message?.content?.trim() || '';
}

export async function estadoLLM() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    const disponible = models.some(m => m.name === OLLAMA_MODEL || m.name === `${OLLAMA_MODEL}:latest`);
    return {
      ok: disponible,
      url: OLLAMA_URL,
      modelo: OLLAMA_MODEL,
      detalle: disponible ? 'Conectado' : `Ollama responde, pero no tiene el modelo ${OLLAMA_MODEL}`,
    };
  } catch (err) {
    return { ok: false, url: OLLAMA_URL, modelo: OLLAMA_MODEL, detalle: `Sin conexión con Ollama (${err.message})` };
  }
}
