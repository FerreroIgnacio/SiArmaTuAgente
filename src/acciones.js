import { actualizarFila, agregarFila, bajarArchivo } from './google.js';
import { enviarMail } from './mail.js';

// Acciones de un estado: se ejecutan al entrar, después de mandar sus mensajes.
//   tipo 'mail'     → para, asunto, cuerpo                         (Email Service de la plataforma, responde al dueño)
//   tipo 'whatsapp' → numero, texto                                (sale por el número conectado del agente)
//   tipo 'sheets'   → planilla, hoja, modo 'agregar' | 'actualizar', columnas: [{ columna, valor }],
//                     buscarColumna, buscarValor, crear            (Sheets del dueño, creada desde la app)
// Los textos aceptan variables: {nombre} {telefono} {mensaje} {fecha} {hora} {opciones} (las del estado actual, ver engine)

export function variables({ nombre = '', telefono = '', mensaje = '', opciones = '' } = {}) {
  const ahora = new Date();
  const zona = { timeZone: 'America/Argentina/Buenos_Aires' };
  return {
    nombre,
    telefono: String(telefono).split('@')[0].split(':')[0],
    mensaje,
    opciones,
    fecha: ahora.toLocaleDateString('es-AR', zona),
    hora: ahora.toLocaleTimeString('es-AR', { ...zona, hour: '2-digit', minute: '2-digit' }),
  };
}

export const interpolar = (t, vars) => String(t ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// Variables con un archivo que mandó el cliente: archivos[variable] = { url: 'drive:<id>' | 'local:<id>', tipo, nombreArchivo }.
// Donde se usan, el archivo va adjunto (en Sheets queda el link, que es el valor de la variable)
export const archivosEn = (t, archivos = {}) =>
  [...new Set([...String(t ?? '').matchAll(/\{(\w+)\}/g)].map(m => m[1]))].filter(k => archivos[k]).map(k => archivos[k]);
const sinArchivos = (vars, archivos = {}, valor = () => '') => ({ ...vars, ...Object.fromEntries(Object.entries(archivos).map(([k, a]) => [k, valor(a)])) });
const TIPO_ENVIO = { imagen: 'imagen', documento: 'documento', audio: 'audio', 'nota de voz': 'audio', video: 'video', gif: 'video' };

// Texto → mensajes de WhatsApp: cada archivo usado va como mensaje propio y el texto de pie del primero que lo acepta
// (los audios no llevan pie: entonces el texto va aparte)
export function mensajesConArchivos(t, vars, archivos = {}) {
  const texto = interpolar(t, sinArchivos(vars, archivos)).replace(/[ \t]+\n/g, '\n').trim();
  const mensajes = archivosEn(t, archivos).map(a => ({ tipo: TIPO_ENVIO[a.tipo] || 'documento', url: a.url, nombreArchivo: a.nombreArchivo || 'archivo', nota: a.tipo === 'nota de voz', texto: '' }));
  const conPie = mensajes.find(m => m.tipo !== 'audio');
  if (texto && conPie) conPie.texto = texto;
  else if (texto) mensajes.push({ tipo: 'texto', texto });
  return mensajes;
}

// Celda de Sheets: si lo que escribió el cliente la hace arrancar con = + - @ (fórmula), va como texto con '.
// Las fórmulas que pone el dueño en la plantilla y los números negativos se respetan
const FORMULA = /^[=+\-@\t\r]/;
function celda(t, vars) {
  const valor = interpolar(t, vars);
  if (FORMULA.test(String(t ?? '')) || !FORMULA.test(valor) || /^[-+]?\d+([.,]\d+)?$/.test(valor)) return valor;
  return `'${valor}`;
}

// WhatsApp: las líneas con variables que la charla no tiene se omiten (un mismo aviso sirve para varios caminos)
const conVariables = (t, vars, archivos = {}) => String(t ?? '').split('\n')
  .filter(l => [...l.matchAll(/\{(\w+)\}/g)].every(m => m[1] in vars || m[1] in archivos)).join('\n');

// La acción con las variables reemplazadas
function resolver(a, vars) {
  const v = t => interpolar(t, vars);
  switch (a.tipo) {
    case 'mail': return { ...a, para: v(a.para).trim(), asunto: v(a.asunto), cuerpo: v(a.cuerpo) };
    case 'whatsapp': return { ...a, numero: v(a.numero).replace(/\D/g, ''), texto: v(conVariables(a.texto, vars)) };
    case 'sheets': return {
      ...a,
      buscarValor: v(a.buscarValor),
      columnas: (a.columnas || []).filter(c => /^[a-z]{1,2}$/i.test(c.columna || '')).map(c => ({ columna: c.columna.toUpperCase(), valor: celda(c.valor, vars) })),
    };
    default: return a;
  }
}

// Para la vista previa: qué haría, sin hacerlo
export function describir(a, vars) {
  const r = resolver(a, vars);
  switch (r.tipo) {
    case 'mail': return `Mandaría un mail a ${r.para || '(sin destinatario)'}: "${r.asunto}"`;
    case 'whatsapp': return `Mandaría un WhatsApp a +${r.numero || '(sin número)'}: "${r.texto}"`;
    case 'sheets': {
      const cols = r.columnas.map(c => `${c.columna}=${c.valor}`).join(', ');
      return r.modo === 'actualizar'
        ? `Actualizaría en Sheets la fila con ${r.buscarColumna || '?'}="${r.buscarValor}": ${cols}`
        : `Agregaría una fila en Sheets: ${cols}`;
    }
    default: return 'Acción desconocida';
  }
}

// Ejecuta una acción. `enviarWhatsApp(jid, mensaje)` lo da el runtime (usa el proveedor conectado).
// `archivos`: las variables con archivos del cliente; en mails y WhatsApp se mandan adjuntos
export async function ejecutar(bot, a, vars, { enviarWhatsApp, archivos = {} }) {
  const r = resolver(a, vars);
  switch (r.tipo) {
    case 'mail': {
      if (!r.para) throw new Error('El mail no tiene destinatario');
      // Solo se adjuntan los que están en Drive; los que quedaron en el navegador del dueño no llegan al servidor
      const adjuntos = archivosEn(a.cuerpo, archivos).filter(x => x.url?.startsWith('drive:'));
      const cuerpo = interpolar(a.cuerpo, sinArchivos(vars, archivos, x => x.url?.startsWith('drive:') ? `${x.nombreArchivo} (adjunto)` : `${x.nombreArchivo} (no adjuntado: conectá Google)`));
      const contenidos = await Promise.all(adjuntos.map(async x => {
        const { datos, tipo } = await bajarArchivo(bot.dueno, x.url.slice(6));
        return { filename: x.nombreArchivo, content: datos, type: tipo };
      }));
      await enviarMail({ ...r, cuerpo, adjuntos: contenidos, responderA: bot.duenoEmail });
      return `Mail enviado a ${r.para}${adjuntos.length ? ` con ${adjuntos.length} adjunto${adjuntos.length > 1 ? 's' : ''}` : ''}`;
    }
    case 'whatsapp': {
      if (!r.numero) throw new Error('El WhatsApp no tiene número');
      const mensajes = mensajesConArchivos(conVariables(a.texto, vars, archivos), vars, archivos).filter(m => m.tipo !== 'texto' || m.texto);
      if (!mensajes.length) throw new Error('El WhatsApp no tiene texto');
      for (const m of mensajes) await enviarWhatsApp(`${r.numero}@s.whatsapp.net`, m);
      return `WhatsApp enviado a +${r.numero}`;
    }
    case 'sheets': {
      if (!r.planilla) throw new Error('Falta la planilla');
      if (!r.columnas.length) throw new Error('Faltan las columnas a escribir');
      if (r.modo === 'actualizar') {
        if (!r.buscarColumna) throw new Error('Falta la columna donde buscar');
        const res = await actualizarFila(bot.dueno, r);
        return res.encontrada ? `Fila ${res.fila} actualizada en Sheets` : res.agregada ? 'No estaba: se agregó una fila en Sheets' : 'No se encontró la fila en Sheets';
      }
      await agregarFila(bot.dueno, r);
      return 'Fila agregada en Sheets';
    }
    default:
      throw new Error(`Acción desconocida: ${r.tipo}`);
  }
}
