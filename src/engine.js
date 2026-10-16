import { generar } from './llm.js';
import { db, porId } from './store.js';
import { archivosEn, interpolar, mensajesConArchivos, variables } from './acciones.js';

const MAX_HISTORIAL = 16;
export const EXPIRA_MS = 10 * 60 * 1000; // a los 10 min sin mensajes el agente se despide y la charla vuelve a empezar
const VOLVER_AL_INICIO = /^ (menu|menu principal|inicio|empezar|volver al inicio) $/;

// Estado por bot+chat, en D1 (tabla charlas): historial (para el LLM), la pila de menús por los que pasó
// y las variables que guardó (respuestas del cliente en estados con "guardarEn"; en `archivos`, las que son un archivo).
// Las vencidas las borra el cron (ver worker.js)

const normalizar = s => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim()} `;

const vence = c => Math.min(c.ultimo + EXPIRA_MS, c.reinicia || Infinity);

async function estadoChat(clave) {
  const fila = await db().prepare('SELECT datos FROM charlas WHERE clave = ? AND vence > ?').bind(clave, Date.now()).first();
  return fila ? JSON.parse(fila.datos) : { historial: [], menus: ['inicio'], vars: {}, archivos: {}, ultimo: 0 };
}

const guardarChat = (clave, c) => c.ultimo && db().prepare('INSERT INTO charlas (clave, datos, vence) VALUES (?1, ?2, ?3) ON CONFLICT(clave) DO UPDATE SET datos = ?2, vence = ?3')
  .bind(clave, JSON.stringify(c), vence(c)).run();

export const borrarCharlasVencidas = () => db().prepare('DELETE FROM charlas WHERE vence <= ?').bind(Date.now()).run();

// Respuestas del estado que llevan a algún lado (las que se pueden elegir)
// Un estado temporizado no escucha: no tiene respuestas para elegir
// Un estado numérico escucha un número (la salida "numero") además de sus respuestas de texto
const salidasDe = (nodo, nodos) => nodo.timed ? [] : (nodo.salidas || []).filter(s => !s.tiempo && (s.numero ? !!nodo.numerico : s.texto?.trim()) && nodos.has(s.destino));
// Estado que no escucha: si es temporizado pasa por la salida por tiempo tras `espera` segundos;
// si no, tras la espera la charla se reinicia (destino null).
// Una acción con salida por tiempo pasa enseguida al nodo conectado (así se encadenan acciones)
const autoDe = (nodo, nodos) => {
  if (nodo?.tipo === 'accion') {
    const d = (nodo.salidas || []).find(x => x.tiempo)?.destino;
    return nodos.has(d) ? { destino: d, espera: 0 } : null;
  }
  if (!nodo || nodo.tipo === 'salto' || salidasDe(nodo, nodos).length) return null;
  // Temporizado: tras la espera pasa por la salida por tiempo (o la primera, en estados viejos), sin importar lo que escuche
  if (nodo.timed) {
    const d = ((nodo.salidas || []).find(x => x.tiempo) || nodo.salidas?.[0])?.destino;
    return { destino: nodos.has(d) ? d : null, espera: Math.max(0, Number(nodo.espera ?? 5) || 0) };
  }
  // Sin tiempo no pasa solo (las salidas sin texto no cuentan): tras la espera la charla se reinicia
  if (nodo.id === 'inicio' || nodo.guardarEn || nodo.numerico) return null;
  return { destino: null, espera: Math.max(0, Number(nodo.espera ?? 5) || 0) };
};
// Las que se le muestran al cliente como opciones (con texto, y si el estado las muestra)
const opcionesDe = (nodo, nodos) => salidasDe(nodo, nodos).filter(s => s.texto);

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
    if (s.numero) continue;
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
    if (s.numero) continue;
    for (const frase of [s.texto, ...String(s.disparadores || '').split(',')]) {
      const d = parecida(normalizar(frase), t);
      if (d < dist) { mejor = s; dist = d; }
    }
  }
  return mejor && nodos.get(mejor.destino);
}

// Número que escribió el cliente (entero, o decimal con coma o punto) o null si no es válido
const MSG_NUMERO = 'Por favor, respondé con un número válido.';
function numeroDe(texto, tipo) {
  const t = String(texto || '').trim().replace(/\s+/g, '');
  if (!(tipo === 'decimal' ? /^[+-]?\d+([.,]\d+)?$/ : /^[+-]?\d+$/).test(t)) return null;
  return String(Number(t.replace(',', '.')));
}

// Estados que piden un archivo (numerico 'imagen' | 'documento' | 'audio' | 'video' | 'archivo'):
// solo siguen si el cliente manda un adjunto de esos tipos
const ARCHIVOS = {
  imagen: ['imagen'], documento: ['documento'], audio: ['audio', 'nota de voz'], video: ['video', 'gif'],
  archivo: ['imagen', 'documento', 'audio', 'nota de voz', 'video', 'gif'],
};
const MSG_ARCHIVO = { imagen: 'una imagen', documento: 'un documento', audio: 'un audio', video: 'un video', archivo: 'un archivo' };

const estadoLlamado = (nodos, nombre) => {
  const n = normalizar(nombre);
  if (!n.trim()) return null;
  const iguales = [...nodos.values()].filter(x => x.tipo !== 'salto' && normalizar(x.id === 'inicio' ? x.nombre || 'Inicio' : x.nombre) === n);
  if (iguales.length > 1) { console.warn(`Salto a "${nombre}": hay ${iguales.length} estados con ese nombre, no se salta`); return null; }
  return iguales[0] || (n === ' inicio ' ? nodos.get('inicio') : null);
};

// Mensajes de un estado → mensajes que entiende cualquier proveedor, con las {variables} reemplazadas
// Un texto que usa una variable con un archivo del cliente manda ese archivo adjunto
export const renderizar = (nodo, vars = {}, archivos = {}) => (nodo.mensajes || []).flatMap(m =>
  (m.tipo || 'texto') === 'texto' && archivosEn(m.texto, archivos).length ? mensajesConArchivos(m.texto, vars, archivos) : renderizarMensaje(conVariables(m, vars)));

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

// Qué puede responder el cliente en el estado. Es la variable {opciones}:
// las opciones numeradas como se le muestran, o lo que pide (un archivo, un número, una respuesta libre);
// '' si no escucha nada (final, temporizado, acción o salto)
function listaOpciones(nodo, nodos, esRaiz) {
  if (!nodo || nodo.tipo === 'accion' || nodo.tipo === 'salto' || nodo.timed) return '';
  const salidas = opcionesDe(nodo, nodos);
  if (nodo.numerico) {
    const pide = ARCHIVOS[nodo.numerico] ? `Enviá ${MSG_ARCHIVO[nodo.numerico]}` : nodo.numerico === 'decimal' ? 'Respondé con un número (puede tener decimales)' : 'Respondé con un número';
    return salidas.length ? `${pide}, o escribí: ${salidas.map(s => s.texto).join(', ')}.` : `${pide}.`;
  }
  if (!salidas.length) return nodo.guardarEn ? 'Escribí tu respuesta.' : '';
  return [...salidas.map((s, i) => `*${i + 1}.* ${s.texto}`), ...(esRaiz ? [] : ['*0.* Menú'])].join('\n');
}

// Mensajes del estado + sus opciones, numeradas al final
function mensajesDe(nodo, nodos, { esRaiz, vars, archivos }) {
  const mensajes = renderizar(nodo, { ...vars, opciones: listaOpciones(nodo, nodos, esRaiz) }, archivos);
  const salidas = opcionesDe(nodo, nodos);
  if (!salidas.length) return mensajes;
  // En un estado numérico los números son la respuesta: las opciones van sin numerar y sin "0. Menú"
  const lista = nodo.numerico ? salidas.map(s => `- ${s.texto}`).join('\n')
    : [...salidas.map((s, i) => `*${i + 1}.* ${s.texto}`), ...(esRaiz ? [] : ['*0.* Menú'])].join('\n');
  const opciones = [...salidas.map(s => s.texto), ...(esRaiz || nodo.numerico ? [] : ['Menú'])];
  const ultimo = mensajes.at(-1);
  if (ultimo?.tipo === 'texto') { ultimo.texto += `\n\n${lista}`; ultimo.opciones = opciones; }
  else mensajes.push({ tipo: 'texto', texto: lista, opciones });
  return mensajes;
}

const resumen = m => m.tipo === 'texto' ? m.texto : m.tipo === 'encuesta' ? `${m.texto}\n${m.opciones.map(o => `- ${o}`).join('\n')}` : `[${m.tipo}] ${m.texto || m.nombre || m.nombreArchivo || ''}`.trim();

// Devuelve { mensajes: [...], acciones, vars, fuente, respuestaId }
//   fuente: 'inicio' | 'opcion' | 'llm' | 'sin_coincidencia' | 'no_numero'
//   cliente: { nombre, telefono } para las variables {nombre} y {telefono}
//   adjunto: { tipo, nombreArchivo?, url?, link?, bajar? } lo que mandó además del texto; url es 'drive:<id>' | 'local:<id>'
//     (o lo que devuelva `bajar()`). En la variable queda `link` (el de Drive o el nombre); el texto que lo acompaña se ignora
// { ignorado: true } → adjunto sin texto en un estado que no es numérico ni pide archivo: el agente no responde
// { faltaArchivo: true } → el estado acepta el adjunto pero no vino su URL: hay que subirlo y repetir el turno
export async function responder(bot, chatId, texto, cliente = {}, opciones = {}) {
  const clave = `${bot.id}:${chatId}`;
  const chat = await estadoChat(clave);
  try { return await turno(bot, chat, chatId, texto, cliente, opciones); }
  finally { await guardarChat(clave, chat); }
}

async function turno(bot, chat, chatId, texto, cliente, { avanzar = null, adjunto = null }) {
  const nodos = porId(bot.flujo);
  const raiz = nodos.get('inicio');
  // Pila de menús: se descartan los nodos que ya no existen
  const menus = chat.menus.map(id => nodos.get(id)).filter(Boolean);
  if (menus[0] !== raiz) menus.unshift(raiz);
  const actual = menus.at(-1);
  const primerMensaje = chat.historial.length === 0;
  const t = normalizar(texto);
  const pideArchivo = !actual.timed && !!ARCHIVOS[actual.numerico];
  // Un estado numérico o que pide archivo responde a cualquier adjunto (aunque sea para avisar que no sirve)
  const escuchaAdjunto = !actual.timed && !!actual.numerico;
  const sinCambios = { mensajes: [], acciones: [], vars: chat.vars, fuente: null, respuestaId: null, nodoActual: chat.menus.at(-1), auto: null };
  if (!avanzar && !texto && !(adjunto && escuchaAdjunto && !primerMensaje)) return { ...sinCambios, ignorado: true };
  chat.reinicia = 0;

  let destino = null, fuente = null, nivel = menus.length, noNumero = false;
  if (avanzar) {
    // Continuación automática: el estado anterior no escucha, así que se pasa directo al siguiente
    destino = nodos.get(avanzar);
    if (!destino) return { mensajes: [], acciones: [], vars: chat.vars, fuente: 'inicio', respuestaId: null, nodoActual: chat.menus.at(-1), auto: null };
  } else if (primerMensaje) {
    // El primer mensaje siempre recibe el saludo, aunque coincida con una opción
    destino = raiz;
    nivel = 1;
  } else if (actual.numerico && !actual.timed && !VOLVER_AL_INICIO.test(t)) {
    // Estado numérico o que pide un archivo: sigue con un número válido o un adjunto del tipo pedido,
    // o con una de sus respuestas de texto; si no, se le avisa y se queda acá. Del archivo se guarda su URL.
    let num = null;
    if (!pideArchivo) num = numeroDe(texto, actual.numerico);
    else if (ARCHIVOS[actual.numerico].includes(adjunto?.tipo)) {
      num = adjunto.url || await adjunto.bajar?.() || null;
      if (!num) return { ...sinCambios, faltaArchivo: true };
    }
    if (num === null) destino = elegir(actual, texto, nodos, { numeros: false });
    noNumero = num === null && !destino;
    if (num !== null) {
      const g = actual.guardarEn;
      if (g && pideArchivo) {
        chat.vars[g] = adjunto.link || adjunto.nombreArchivo || num;
        chat.archivos[g] = { url: num, tipo: adjunto.tipo, nombreArchivo: adjunto.nombreArchivo || adjunto.link || 'archivo' };
      } else if (g) { chat.vars[g] = num; delete chat.archivos[g]; }
      destino = nodos.get(salidasDe(actual, nodos).find(s => s.numero)?.destino);
    }
  } else if (t.trim() === '0' && actual !== raiz) {
    // "0. Menú": vuelve al primer mensaje
    destino = raiz;
    nivel = 0;
  } else {
    // Estado que pregunta algo: lo que conteste se guarda en su variable
    // Si eligió una opción por su número se guarda el texto de la opción
    if (actual.guardarEn) {
      const num = Number(t.trim()), opciones = opcionesDe(actual, nodos);
      chat.vars[actual.guardarEn] = Number.isInteger(num) && num >= 1 && num <= opciones.length ? opciones[num - 1].texto : String(texto).trim();
      delete chat.archivos[actual.guardarEn];
    }
    destino = elegir(actual, texto, nodos);
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

  // {opciones}: las del estado donde está la charla (al mostrar un estado, las de ese estado)
  const vars = { ...variables({ ...cliente, mensaje: texto }), ...chat.vars, opciones: listaOpciones(actual, nodos, actual === raiz) };
  const mensajes = [];
  const acciones = [];
  if (destino) {
    fuente = destino === raiz ? 'inicio' : 'opcion';
    // Un nodo de acción no manda mensajes ni tiene respuestas: ejecuta su acción y la charla sigue donde estaba
    if (destino.tipo === 'accion' && destino.accion) acciones.push(destino.accion);
    mensajes.push(...mensajesDe(destino, nodos, { esRaiz: destino === raiz, vars, archivos: chat.archivos }));
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
    // LLM (stub, no genera nada) o mensaje de "no entendí"; el contexto no cambia
    const generado = !noNumero && bot.agente.usarLLM ? await generar(bot, [...chat.historial, { role: 'user', content: texto }]) : '';
    if (noNumero) {
      const aviso = actual.msgNumero?.trim() || (pideArchivo ? `Por favor, enviá ${MSG_ARCHIVO[actual.numerico]}.` : MSG_NUMERO);
      mensajes.push({ tipo: 'texto', texto: interpolar(aviso, vars) });
      fuente = 'no_numero';
    }
    else if (generado) { mensajes.push({ tipo: 'texto', texto: generado }); fuente = 'llm'; }
    else {
      fuente = 'sin_coincidencia';
      if (bot.agente.fallback) mensajes.push({ tipo: 'texto', texto: interpolar(bot.agente.fallback, vars) });
    }
  }

  if (!avanzar) chat.historial.push({ role: 'user', content: texto || `[${adjunto?.tipo}]` });
  if (mensajes.length) chat.historial.push({ role: 'assistant', content: mensajes.map(resumen).join('\n') });
  while (chat.historial.length > MAX_HISTORIAL) chat.historial.splice(0, 2);
  chat.ultimo = Date.now();

  // Estado final (sin salidas conectadas ni pregunta): se despide y, pasada la espera, el próximo mensaje arranca de cero
  // Una acción a la que se llegó sola (tras un estado temporizado) también cierra la charla, salvo que siga en otro nodo
  const auto = autoDe(destino, nodos);
  if (auto && !auto.destino || avanzar && destino?.tipo === 'accion' && !auto) {
    chat.reinicia = chat.ultimo + (auto?.espera ?? 0) * 1000;
    const despedida = interpolar(bot.agente.despedida, vars).trim();
    if (despedida) {
      mensajes.push({ tipo: 'texto', texto: despedida, despedida: true });
      chat.historial.push({ role: 'assistant', content: despedida });
    }
  }

  // Las acciones ven las opciones del estado donde queda la charla
  const enCurso = nodos.get(chat.menus.at(-1));
  vars.opciones = listaOpciones(enCurso, nodos, enCurso === raiz);

  const nombre = id => { const n = nodos.get(id); return n ? n.nombre || n.id : id; };
  console.log(`[${bot.id}] ${cliente.nombre || chatId}: "${texto ?? ''}" ${nombre(actual.id)} → ${destino ? nombre(destino.id) : '-'} (${fuente}) pila=[${chat.menus.map(nombre).join(' > ')}] vars=${JSON.stringify(chat.vars)}`);
  return { mensajes, acciones, vars, archivos: chat.archivos, fuente, respuestaId: destino?.id || null, nodoActual: chat.menus.at(-1), auto };
}

export { resumen as resumenMensaje };

export async function olvidarChat(botId, chatId) {
  await db().prepare('DELETE FROM charlas WHERE clave = ?').bind(`${botId}:${chatId}`).run();
}
