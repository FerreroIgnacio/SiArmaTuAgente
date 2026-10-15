import { generar } from './llm.js';
import { porId } from './store.js';
import { interpolar, variables } from './acciones.js';

const MAX_HISTORIAL = 16;
const EXPIRA_MS = 6 * 60 * 60 * 1000; // a las 6 hs sin mensajes la charla vuelve a empezar
const VOLVER_AL_INICIO = /^ (menu|menu principal|inicio|empezar|volver al inicio) $/;

// Estado por bot+chat, en memoria: historial (para el LLM), la pila de menús por los que pasó
// y las variables que guardó (respuestas del cliente en estados con "guardarEn")
const chats = new Map();

const normalizar = s => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim()} `;

function estadoChat(clave) {
  const c = chats.get(clave);
  if (c && Date.now() - c.ultimo < EXPIRA_MS && !(c.reinicia && Date.now() >= c.reinicia)) return c;
  const nuevo = { historial: [], menus: ['inicio'], vars: {}, ultimo: 0 };
  chats.set(clave, nuevo);
  return nuevo;
}

// Respuestas del estado que llevan a algún lado (las que se pueden elegir)
// Un estado temporizado no escucha: no tiene respuestas para elegir
const salidasDe = (nodo, nodos) => nodo.timed ? [] : (nodo.salidas || []).filter(s => !s.tiempo && (s.texto?.trim() || s.cualquiera) && nodos.has(s.destino));
// Estado que no escucha (todas sus salidas desconectadas o sin texto): pasa solo al siguiente tras `espera` segundos.
// Si no tiene ninguna salida conectada (estado final), tras la espera la charla se reinicia (destino null).
const autoDe = (nodo, nodos) => {
  if (!nodo || nodo.tipo === 'accion' || nodo.tipo === 'salto' || salidasDe(nodo, nodos).length) return null;
  // Temporizado: tras la espera pasa por la salida por tiempo (o la primera, en estados viejos), sin importar lo que escuche
  if (nodo.timed) {
    const d = ((nodo.salidas || []).find(x => x.tiempo) || nodo.salidas?.[0])?.destino;
    return { destino: nodos.has(d) ? d : null, espera: Math.max(0, Number(nodo.espera ?? 5) || 0) };
  }
  const s = (nodo.salidas || []).find(x => !x.tiempo && nodos.has(x.destino));
  if (!s && (nodo.id === 'inicio' || nodo.guardarEn)) return null;
  return { destino: s?.destino || null, espera: Math.max(0, Number(nodo.espera ?? 5) || 0) };
};
// Las que se le muestran al cliente como opciones (con texto, y si el estado las muestra)
const opcionesDe = (nodo, nodos) => nodo.formatoOpciones === 'ninguno' ? [] : salidasDe(nodo, nodos).filter(s => s.texto);

function levenshtein(a, b) {
  let fila = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const nueva = [i];
    for (let j = 1; j <= b.length; j++) nueva[j] = Math.min(fila[j] + 1, nueva[j - 1] + 1, fila[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    fila = nueva;
  }
  return fila[b.length];
}

// Tolera errores de tipeo (hasta 2 letras; menos en frases cortas, para no confundir "si" con "no")
function parecida(frase, t) {
  const f = frase.trim(), palabras = t.trim().split(' '), k = f.split(' ').length;
  const max = Math.min(2, Math.floor(f.length / 3));
  if (!f || !max) return Infinity;
  let mejor = Infinity;
  for (let i = 0; i + k <= palabras.length; i++) mejor = Math.min(mejor, levenshtein(f, palabras.slice(i, i + k).join(' ')));
  return mejor <= max ? mejor : Infinity;
}

// Entre las respuestas que escucha `nodo`, cuál dijo el cliente: por número (si se muestran numeradas),
// por el texto de la respuesta o por sus disparadores. Devuelve el estado al que lleva.
function elegir(nodo, texto, nodos, { numeros = true } = {}) {
  const t = normalizar(texto);
  const num = Number(t.trim());
  const opciones = opcionesDe(nodo, nodos);
  if (numeros && Number.isInteger(num) && num >= 1 && num <= opciones.length) return nodos.get(opciones[num - 1].destino);
  let mejor = null, largo = 0;
  for (const s of salidasDe(nodo, nodos)) {
    for (const frase of [s.texto, ...String(s.disparadores || '').split(',')]) {
      const n = normalizar(frase);
      if (!n.trim()) continue;
      const exacta = n === t;
      if ((exacta || t.includes(n)) && n.length + (exacta ? 1000 : 0) > largo) { mejor = s; largo = n.length + (exacta ? 1000 : 0); }
    }
  }
  if (mejor) return nodos.get(mejor.destino);
  let dist = Infinity;
  for (const s of salidasDe(nodo, nodos)) {
    for (const frase of [s.texto, ...String(s.disparadores || '').split(',')]) {
      const d = parecida(normalizar(frase), t);
      if (d < dist) { mejor = s; dist = d; }
    }
  }
  return mejor && nodos.get(mejor.destino);
}

const estadoLlamado = (nodos, nombre) => {
  const n = normalizar(nombre);
  if (!n.trim()) return null;
  const iguales = [...nodos.values()].filter(x => x.tipo !== 'salto' && normalizar(x.id === 'inicio' ? x.nombre || 'Inicio' : x.nombre) === n);
  if (iguales.length > 1) { console.warn(`Salto a "${nombre}": hay ${iguales.length} estados con ese nombre, no se salta`); return null; }
  return iguales[0] || (n === ' inicio ' ? nodos.get('inicio') : null);
};

// Mensajes de un estado → mensajes que entiende cualquier proveedor, con las {variables} reemplazadas
export const renderizar = (nodo, vars = {}) => (nodo.mensajes || []).flatMap(m => renderizarMensaje(conVariables(m, vars)));

const conVariables = (m, vars) => Object.fromEntries(Object.entries(m).map(([k, v]) =>
  [k, typeof v === 'string' && ['texto', 'nombre', 'direccion', 'telefono', 'nombreArchivo'].includes(k) ? interpolar(v, vars) : v]));

function renderizarMensaje(n) {
  switch (n.tipo) {
    case 'imagen':
      return n.url ? [{ tipo: 'imagen', url: n.url, texto: n.texto || '' }] : [];
    case 'documento':
      return n.url ? [{ tipo: 'documento', url: n.url, nombreArchivo: n.nombreArchivo || 'archivo', texto: n.texto || '' }] : [];
    case 'ubicacion': {
      const lat = Number(n.lat), lng = Number(n.lng);
      return n.lat !== '' && n.lng !== '' && Number.isFinite(lat) && Number.isFinite(lng)
        ? [{ tipo: 'ubicacion', lat, lng, nombre: n.nombre || '', direccion: n.direccion || '' }]
        : [];
    }
    case 'contacto':
      return n.telefono ? [{ tipo: 'contacto', nombre: n.nombre || n.telefono, telefono: n.telefono }] : [];
    default:
      return n.texto ? [{ tipo: 'texto', texto: n.texto }] : [];
  }
}

// Mensajes del estado + sus opciones: numeradas al final, o como encuesta de WhatsApp (máx. 12 opciones)
function mensajesDe(nodo, nodos, { esRaiz, vars }) {
  const mensajes = renderizar(nodo, vars);
  const salidas = opcionesDe(nodo, nodos);
  if (!salidas.length) return mensajes;
  const opciones = [...salidas.map(s => s.texto), ...(esRaiz ? [] : ['Volver'])];
  if (nodo.formatoOpciones === 'encuesta' && opciones.length <= 12) {
    return [...mensajes, { tipo: 'encuesta', texto: interpolar(nodo.pregunta || 'Elegí una opción', vars), opciones }];
  }
  const lista = [
    ...salidas.map((s, i) => `*${i + 1}.* ${s.texto}`),
    ...(esRaiz ? [] : ['*0.* Volver']),
  ].join('\n');
  const ultimo = mensajes.at(-1);
  if (ultimo?.tipo === 'texto') { ultimo.texto += `\n\n${lista}`; ultimo.opciones = opciones; }
  else mensajes.push({ tipo: 'texto', texto: lista, opciones });
  return mensajes;
}

const resumen = m => m.tipo === 'texto' ? m.texto : m.tipo === 'encuesta' ? `${m.texto}\n${m.opciones.map(o => `- ${o}`).join('\n')}` : `[${m.tipo}] ${m.texto || m.nombre || m.nombreArchivo || ''}`.trim();

// Devuelve { mensajes: [...], acciones, vars, fuente, respuestaId }
//   fuente: 'inicio' | 'opcion' | 'llm' | 'sin_coincidencia'
//   cliente: { nombre, telefono } para las variables {nombre} y {telefono}
export async function responder(bot, chatId, texto, cliente = {}, { avanzar = null } = {}) {
  const chat = estadoChat(`${bot.id}:${chatId}`);
  chat.reinicia = 0;
  const nodos = porId(bot.flujo);
  const raiz = nodos.get('inicio');
  // Pila de menús: se descartan los nodos que ya no existen
  const menus = chat.menus.map(id => nodos.get(id)).filter(Boolean);
  if (menus[0] !== raiz) menus.unshift(raiz);
  const actual = menus.at(-1);
  const primerMensaje = chat.historial.length === 0;
  const t = normalizar(texto);

  let destino = null, fuente = null, nivel = menus.length;
  if (avanzar) {
    // Continuación automática: el estado anterior no escucha, así que se pasa directo al siguiente
    destino = nodos.get(avanzar);
    if (!destino) return { mensajes: [], acciones: [], vars: chat.vars, fuente: 'inicio', respuestaId: null, nodoActual: chat.menus.at(-1), auto: null };
  } else if (primerMensaje) {
    // Si el primer mensaje ya pide una opción de primer nivel, va directo (después del saludo)
    destino = elegir(raiz, texto, nodos, { numeros: false }) || raiz;
    nivel = 1;
  } else if ((t.trim() === '0' || t === ' volver ') && menus.length > 1) {
    destino = menus.at(-2);
    nivel = menus.length - 2;
  } else {
    // Estado que pregunta algo: lo que conteste se guarda en su variable
    if (actual.guardarEn) chat.vars[actual.guardarEn] = String(texto).trim();
    destino = elegir(actual, texto, nodos);
    // "Cualquier respuesta": si no coincidió con ninguna, sigue por esa salida
    const cualquiera = (actual.salidas || []).find(s => s.cualquiera && nodos.has(s.destino));
    if (!destino && cualquiera) destino = nodos.get(cualquiera.destino);
    // Si no está entre las opciones de este menú, buscar en los menús anteriores (sin números)
    for (let i = menus.length - 2; !destino && i >= 0; i--) {
      destino = elegir(menus[i], texto, nodos, { numeros: false });
      nivel = i + 1;
    }
    if (!destino && VOLVER_AL_INICIO.test(t)) { destino = raiz; nivel = 0; }
  }

  // Nodo de salto: la charla sigue en el estado con ese nombre (como si se hubiera llegado directo)
  for (let saltos = 0; destino?.tipo === 'salto' && saltos < 10; saltos++) destino = estadoLlamado(nodos, destino.objetivo);
  if (destino?.tipo === 'salto') destino = null;

  const vars = { ...variables({ ...cliente, mensaje: texto }), ...chat.vars };
  const mensajes = [];
  const acciones = [];
  if (destino) {
    fuente = destino === raiz ? 'inicio' : 'opcion';
    if (primerMensaje && destino !== raiz) mensajes.push(...renderizar(raiz, vars));
    // Un nodo de acción no manda mensajes ni tiene respuestas: ejecuta su acción y la charla sigue donde estaba
    if (destino.tipo === 'accion' && destino.accion) acciones.push(destino.accion);
    mensajes.push(...mensajesDe(destino, nodos, { esRaiz: destino === raiz, vars }));
    // Si el destino tiene opciones pasa a ser el menú actual; si ya estaba en la pila (volvió a un
    // menú anterior) se corta ahí. En una hoja, el contexto sigue siendo el menú desde donde se eligió.
    const pila = menus.slice(0, Math.max(nivel, 1));
    if (salidasDe(destino, nodos).length) {
      const ya = pila.indexOf(destino);
      if (ya >= 0) pila.length = ya + 1;
      else pila.push(destino);
    }
    chat.menus = pila.slice(-20).map(n => n.id);
    if (chat.menus[0] !== 'inicio') chat.menus.unshift('inicio');
  } else {
    // LLM local (experimental) o mensaje de "no entendí"; el contexto no cambia
    let generado = '';
    // Todavía no está disponible: solo corre si el servidor tiene OLLAMA_URL configurado
    if (bot.agente.usarLLM && process.env.OLLAMA_URL) {
      try {
        generado = await generar(bot, [...chat.historial, { role: 'user', content: texto }]);
      } catch (err) {
        console.error('[llm]', err.message);
      }
    }
    if (generado) { mensajes.push({ tipo: 'texto', texto: generado }); fuente = 'llm'; }
    else {
      fuente = 'sin_coincidencia';
      if (bot.agente.fallback) mensajes.push({ tipo: 'texto', texto: bot.agente.fallback });
    }
  }

  if (!avanzar) chat.historial.push({ role: 'user', content: texto });
  if (mensajes.length) chat.historial.push({ role: 'assistant', content: mensajes.map(resumen).join('\n') });
  while (chat.historial.length > MAX_HISTORIAL) chat.historial.splice(0, 2);
  chat.ultimo = Date.now();

  // Estado final (sin salidas conectadas ni pregunta): pasada la espera, el próximo mensaje arranca de cero
  const auto = autoDe(destino, nodos);
  if (auto && !auto.destino) chat.reinicia = chat.ultimo + auto.espera * 1000;

  return { mensajes, acciones, vars, fuente, respuestaId: destino?.id || null, nodoActual: chat.menus.at(-1), auto };
}

export { resumen as resumenMensaje };

export function olvidarChat(botId, chatId) {
  chats.delete(`${botId}:${chatId}`);
}
