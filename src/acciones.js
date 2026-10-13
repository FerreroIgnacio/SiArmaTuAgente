import { actualizarFila, agregarFila } from './google.js';
import { enviarMail } from './mail.js';

// Acciones de un estado: se ejecutan al entrar, después de mandar sus mensajes.
//   tipo 'mail'     → para, asunto, cuerpo                         (SMTP de la plataforma, responde al dueño)
//   tipo 'whatsapp' → numero, texto                                (sale por el número conectado del agente)
//   tipo 'sheets'   → planilla, hoja, modo 'agregar' | 'actualizar', columnas: [{ columna, valor }],
//                     buscarColumna, buscarValor, crear            (Sheets del dueño, creada desde la app)
// Los textos aceptan variables: {nombre} {telefono} {mensaje} {fecha} {hora}

export function variables({ nombre = '', telefono = '', mensaje = '' } = {}) {
  const ahora = new Date();
  const zona = { timeZone: process.env.TZ || 'America/Argentina/Buenos_Aires' };
  return {
    nombre,
    telefono: String(telefono).split('@')[0].split(':')[0],
    mensaje,
    fecha: ahora.toLocaleDateString('es-AR', zona),
    hora: ahora.toLocaleTimeString('es-AR', { ...zona, hour: '2-digit', minute: '2-digit' }),
  };
}

export const interpolar = (t, vars) => String(t ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

// La acción con las variables reemplazadas
function resolver(a, vars) {
  const v = t => interpolar(t, vars);
  switch (a.tipo) {
    case 'mail': return { ...a, para: v(a.para).trim(), asunto: v(a.asunto), cuerpo: v(a.cuerpo) };
    case 'whatsapp': return { ...a, numero: v(a.numero).replace(/\D/g, ''), texto: v(a.texto) };
    case 'sheets': return {
      ...a,
      buscarValor: v(a.buscarValor),
      columnas: (a.columnas || []).filter(c => /^[a-z]{1,2}$/i.test(c.columna || '')).map(c => ({ columna: c.columna.toUpperCase(), valor: v(c.valor) })),
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

// Ejecuta una acción. `enviarWhatsApp(jid, texto)` lo da el runtime (usa el proveedor conectado).
export async function ejecutar(bot, a, vars, { enviarWhatsApp }) {
  const r = resolver(a, vars);
  switch (r.tipo) {
    case 'mail':
      if (!r.para) throw new Error('El mail no tiene destinatario');
      await enviarMail({ ...r, responderA: bot.duenoEmail });
      return `Mail enviado a ${r.para}`;
    case 'whatsapp':
      if (!r.numero) throw new Error('El WhatsApp no tiene número');
      if (!r.texto.trim()) throw new Error('El WhatsApp no tiene texto');
      await enviarWhatsApp(`${r.numero}@s.whatsapp.net`, r.texto);
      return `WhatsApp enviado a +${r.numero}`;
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
