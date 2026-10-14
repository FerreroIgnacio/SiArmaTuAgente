import { mkdirSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const BOTS_DIR = path.join(DATA_DIR, 'bots');
export const AUTH_DIR = path.join(DATA_DIR, 'auth');
export const ARCHIVOS_DIR = path.join(DATA_DIR, 'archivos');
export const METRICAS_DIR = path.join(DATA_DIR, 'metricas');

// Sincrónico (sin await de nivel superior) para poder empaquetar el ejecutable local
for (const d of [BOTS_DIR, AUTH_DIR, ARCHIVOS_DIR, METRICAS_DIR]) mkdirSync(d, { recursive: true });

// flujo: { nodos: [estado] }, el estado 'inicio' es donde arranca la charla. Es una máquina de estados.
// estado: { id, nombre, mensajes: [mensaje], salidas: [salida], formatoOpciones, pregunta (de la encuesta), pos }
//   formatoOpciones 'lista' (numeradas) | 'encuesta' (de WhatsApp) | 'ninguno' (solo escucha)
//   guardarEn: nombre de variable → lo que conteste el cliente en este estado se guarda como {variable}
// salida: { id, texto, disparadores, destino } → una respuesta que escucha el estado y a qué estado lleva
//   { id, cualquiera: true, destino } → si lo que escribe no coincide con ninguna, sigue por acá
// nodo de acción (terminal): { id, tipo: 'accion', nombre, accion, pos } → hace una sola acción (ver acciones.js)
// nodo de salto (terminal): { id, tipo: 'salto', nombre, objetivo, pos } → la charla sigue en el estado llamado `objetivo`
// mensaje: { tipo, ...contenido }
//   tipo 'texto'     → texto
//   tipo 'imagen'    → url, texto (pie)
//   tipo 'documento' → url, nombreArchivo, texto
//   tipo 'ubicacion' → nombre, direccion, lat, lng
//   tipo 'contacto'  → nombre, telefono
// Al entrar a un estado se mandan sus mensajes en orden y después sus respuestas como opciones.
export const BIENVENIDA = 'Hola, soy un agente automatizado. ¿En qué puedo ayudarte hoy?';

export function botVacio() {
  return {
    negocio: { nombre: '', rubro: '', descripcion: '', horarios: '', ubicacion: '', contactoHumano: '' },
    agente: {
      nombre: 'Agente de <tu nombre>',
      fallback: 'Perdón, no te entendí. ¿Me lo escribís de otra forma?',
      usarLLM: false,
    },
    flujo: { nodos: [{ id: 'inicio', nombre: 'Inicio', mensajes: [{ tipo: 'texto', texto: BIENVENIDA }], salidas: [], formatoOpciones: 'lista' }] },
    reglas: { ignorarGrupos: true },
    conexion: { proveedor: 'baileys', meta: { phoneNumberId: '', accessToken: '', verifyToken: '' } },
  };
}

// Árbol anidado (con ramas sueltas) → lista plana de nodos con hijos por id
function arbolAFlujo(arbol) {
  const nodos = [];
  const visitar = n => {
    const { hijos = [], sueltos, ...resto } = n;
    nodos.push({ ...resto, hijos: hijos.map(h => h.id) });
    hijos.forEach(visitar);
  };
  [arbol, ...(arbol.sueltos || [])].forEach(visitar);
  return { nodos };
}

// Nodo de un solo mensaje ({ tipo, ...contenido }) → estado con lista de mensajes
const CONTENIDO = ['tipo', 'texto', 'url', 'nombreArchivo', 'nombre', 'direccion', 'lat', 'lng', 'telefono'];
function aEstado(n) {
  if (Array.isArray(n.mensajes) || n.tipo === 'accion' || n.tipo === 'salto') return n;
  const mensaje = Object.fromEntries(CONTENIDO.filter(k => k in n).map(k => [k, n[k]]));
  const resto = Object.fromEntries(Object.entries(n).filter(([k]) => !CONTENIDO.includes(k)));
  if (n.tipo === 'encuesta') return { ...resto, mensajes: [], formatoOpciones: 'encuesta', pregunta: n.texto || '' };
  return { ...resto, mensajes: [{ tipo: 'texto', ...mensaje }] };
}

// Nodos con hijos (el título del hijo era la opción) → estados con salidas
function aSalidas(nodos) {
  const mapa = new Map(nodos.map(n => [n.id, n]));
  return nodos.map(n => {
    if (Array.isArray(n.salidas) || n.tipo === 'accion' || n.tipo === 'salto') return n;
    const { hijos = [], titulo, disparadores, ...resto } = n;
    const salidas = hijos.filter(id => mapa.has(id)).map(id => ({
      id: randomUUID(), texto: mapa.get(id).titulo || '', disparadores: mapa.get(id).disparadores || '', destino: id,
    }));
    return { ...resto, nombre: titulo || '', salidas, formatoOpciones: n.formatoOpciones || 'lista' };
  });
}

// Listas de acciones (dentro de un estado o de un nodo de acción) → un nodo de acción por acción.
// El primero conserva el id (y sus conexiones); los demás quedan sin conectar, para que no se pierdan.
function separarAcciones(nodos) {
  return nodos.flatMap(n => {
    if (!n.acciones?.length) return [n];
    const { acciones, ...resto } = n;
    const esAccion = n.tipo === 'accion';
    const nuevos = acciones.map((accion, i) => ({
      id: esAccion && i === 0 ? n.id : `${n.id}-accion-${i + 1}`,
      tipo: 'accion',
      nombre: esAccion && i === 0 ? n.nombre || '' : `Acción de ${n.nombre || 'Inicio'}`,
      accion,
      ...(n.pos ? { pos: { x: n.pos.x, y: n.pos.y + (esAccion ? i : -(i + 1)) * 80 } } : {}),
    }));
    return esAccion ? nuevos : [resto, ...nuevos];
  });
}

// Formatos anteriores: agente.faqs → respuestas[] (con menús por id) → arbol → flujo
function migrar(bot) {
  const base = botVacio();
  bot.agente = { ...base.agente, ...bot.agente };
  if (!bot.flujo && !bot.arbol) {
    let respuestas = bot.respuestas;
    if (!Array.isArray(respuestas)) {
      respuestas = (bot.agente.faqs || []).map(f => ({ id: randomUUID(), titulo: f.p, disparadores: f.p, tipo: 'texto', texto: f.r }));
    }
    const porId = Object.fromEntries(respuestas.map(r => [r.id, r]));
    const aNodo = (r, titulo, vistos) => {
      const { opciones, ...resto } = r;
      const nodo = { ...resto, id: randomUUID(), titulo: titulo || r.titulo, tipo: r.tipo === 'menu' ? 'texto' : r.tipo, hijos: [] };
      if (r.tipo === 'menu' && !vistos.has(r.id)) {
        for (const o of opciones || []) {
          if (porId[o.destino]) nodo.hijos.push(aNodo(porId[o.destino], o.etiqueta, new Set([...vistos, r.id])));
        }
      }
      return nodo;
    };
    const inicial = porId[bot.agente.bienvenidaRespuesta];
    const raiz = { id: 'inicio', texto: bot.agente.bienvenida || BIENVENIDA, hijos: [] };
    if (inicial?.tipo === 'menu') {
      raiz.texto = [bot.agente.bienvenida, inicial.texto].filter(Boolean).join('\n\n') || BIENVENIDA;
      raiz.hijos = aNodo(inicial, '', new Set()).hijos;
    }
    const usados = new Set([inicial?.id, ...respuestas.flatMap(r => (r.opciones || []).map(o => o.destino))]);
    for (const r of respuestas) if (!usados.has(r.id)) raiz.hijos.push(aNodo(r, '', new Set()));
    bot.arbol = raiz;
  }
  if (!bot.flujo) bot.flujo = arbolAFlujo(bot.arbol);
  delete bot.arbol;
  bot.flujo.nodos = separarAcciones(aSalidas(bot.flujo.nodos.map(aEstado)));
  for (const k of ['faqs', 'tono', 'instrucciones', 'bienvenida', 'bienvenidaRespuesta']) delete bot.agente[k];
  delete bot.respuestas;
  return bot;
}

export const porId = flujo => new Map((flujo?.nodos || []).map(n => [n.id, n]));

// Nodos alcanzables desde el inicio, cada uno con su camino más corto: [{ nodo, camino: [inicio, ..., nodo] }]
export function aplanar(flujo) {
  const mapa = porId(flujo);
  const inicio = mapa.get('inicio');
  if (!inicio) return [];
  const out = [{ nodo: inicio, camino: [inicio] }];
  const vistos = new Set(['inicio']);
  for (let i = 0; i < out.length; i++) {
    for (const { destino } of out[i].nodo.salidas || []) {
      const h = mapa.get(destino);
      if (!h || vistos.has(destino)) continue;
      vistos.add(destino);
      out.push({ nodo: h, camino: [...out[i].camino, h] });
    }
  }
  return out;
}

const archivo = id => path.join(BOTS_DIR, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`);

export async function getBot(id) {
  try {
    const bot = JSON.parse(await readFile(archivo(id), 'utf8'));
    if (bot.flujo) return migrar(bot);
    // La migración genera ids nuevos: guardarla para que sean estables
    await writeFile(archivo(id), JSON.stringify(migrar(bot), null, 2));
    return bot;
  } catch {
    return null;
  }
}

export async function listBots() {
  const files = (await readdir(BOTS_DIR)).filter(f => f.endsWith('.json'));
  return Promise.all(files.map(f => getBot(f.slice(0, -5))));
}

// Mezcla por sección para que un PUT parcial no borre el resto
export async function saveBot(id, datos, dueno) {
  const base = (id && (await getBot(id))) || { ...botVacio(), id: randomUUID(), dueno: dueno?.sub, creado: new Date().toISOString() };
  // El mail del dueño se usa como "responder a" en los mails de las acciones
  if (dueno?.email) base.duenoEmail = dueno.email;
  const bot = { ...base };
  for (const k of ['negocio', 'agente', 'reglas', 'conexion']) {
    if (datos[k]) bot[k] = { ...base[k], ...datos[k] };
  }
  if (datos.conexion?.meta) bot.conexion.meta = { ...base.conexion.meta, ...datos.conexion.meta };
  if (Array.isArray(datos.flujo?.nodos) && datos.flujo.nodos.some(n => n.id === 'inicio')) bot.flujo = { nodos: datos.flujo.nodos };
  bot.actualizado = new Date().toISOString();
  await writeFile(archivo(bot.id), JSON.stringify(bot, null, 2));
  return bot;
}

// Borra el agente y todo lo suyo: configuración, sesión de WhatsApp, archivos subidos y métricas
export async function borrarBot(id) {
  const limpio = id.replace(/[^a-zA-Z0-9-]/g, '');
  await Promise.all([
    rm(archivo(limpio), { force: true }),
    rm(path.join(AUTH_DIR, limpio), { recursive: true, force: true }),
    rm(path.join(ARCHIVOS_DIR, limpio), { recursive: true, force: true }),
    rm(path.join(METRICAS_DIR, `${limpio}.json`), { force: true }),
  ]);
}

// Lo que se manda al navegador: sin el token de Meta
export function botPublico(bot) {
  const meta = { ...bot.conexion.meta, accessToken: bot.conexion.meta?.accessToken ? '••••••••' : '' };
  return { ...bot, conexion: { ...bot.conexion, meta } };
}

// URLs '/archivos/...' son archivos subidos desde la herramienta: se mandan desde disco
export function resolverArchivo(url) {
  if (!url?.startsWith('/archivos/')) return url;
  const destino = path.resolve(ARCHIVOS_DIR, decodeURIComponent(url.slice('/archivos/'.length)));
  if (!destino.startsWith(ARCHIVOS_DIR + path.sep)) throw new Error('Ruta de archivo inválida');
  return destino;
}
