import { bajarArchivo, subirADrive } from './drive.js';

// WhatsApp personal corriendo en esta pestaña: Baileys vive en un Web Worker (wa-worker.js) y la conexión
// sale de la compu del usuario. Por cada mensaje se le pregunta al servidor qué responder (/turno) y se
// envía desde acá. Una sola pestaña por agente a la vez (Web Locks): las demás esperan su turno.
//   alEstado(s)    → mismo formato que el estado del servidor ({ estado, qr?, numero?, detalle?, proveedor })
//   alMensaje(m)   → { chatId, nombre, texto, adjunto?, de, fuente?, ts } para el registro de conversaciones
//   alFoto(chatId, url) → foto de perfil del contacto
//   alMedia(id)    → el worker guardó el archivo de un adjunto (adjunto.id) en IndexedDB 'adjuntos'
//   claveLocal     → hex de /api/yo: el worker cifra con ella la sesión que guarda en IndexedDB
export function crearWhatsApp({ botId, claveLocal, api, alEstado, alMensaje, alFoto, alMedia }) {
  let worker = null, liberar = null, estado = { estado: 'desconectado' }, cerrado = false, quiere = false, pedido = false;
  let siguiente = 0;
  const pendientes = new Map();
  const timers = new Set();
  // Despedida pendiente por chat: si el cliente no escribe en 10 min (lo mismo que tarda en vencer la charla en el servidor)
  const despedidas = new Map();
  const INACTIVIDAD_MS = 10 * 60 * 1000;

  const pintar = s => { estado = { ...s, proveedor: 'baileys' }; alEstado(estado); };
  const pedir = (tipo, datos = {}, transferir = []) => new Promise((ok, mal) => {
    if (!worker) return mal(new Error('WhatsApp no está conectado'));
    const id = ++siguiente;
    pendientes.set(id, { ok, mal });
    worker.postMessage({ tipo, id, ...datos }, transferir);
  });
  const esperar = ms => new Promise(r => { const t = setTimeout(() => { timers.delete(t); r(); }, ms); timers.add(t); });

  // Imágenes, documentos, audios y videos se bajan acá (del Drive del dueño o de este navegador) y se le pasan al worker
  async function enviar(to, mensaje) {
    const m = { ...mensaje };
    if (['imagen', 'documento', 'audio', 'video'].includes(m.tipo)) m.datos = await (await bajarArchivo(m.url)).arrayBuffer();
    await pedir('enviar', { to, mensaje: m }, m.datos ? [m.datos] : []);
  }

  // Archivo de un adjunto: lo baja el worker a IndexedDB (puede tardar); se sube al Drive del dueño para guardarlo
  // en una variable → { url, link }. Sin Google conectado queda solo en este navegador y la variable guarda el nombre
  const leerMedia = id => new Promise((ok, mal) => {
    const r = indexedDB.open('adjuntos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('media');
    r.onerror = () => mal(r.error);
    r.onsuccess = () => {
      const g = r.result.transaction('media').objectStore('media').get(id);
      g.onsuccess = () => { ok(g.result); r.result.close(); };
      g.onerror = () => mal(g.error);
    };
  });
  async function subirAdjunto(a) {
    for (let i = 0; a.id && i < 120 && !cerrado; i++) {
      const blob = await leerMedia(a.id);
      if (blob) {
        const nombre = a.nombreArchivo || `${a.tipo.replace(' ', '-')}.${blob.type.split(';')[0].split('/')[1] || 'bin'}`;
        try { return await subirADrive(blob, nombre); }
        catch (err) { console.warn('Adjunto sin subir a Drive', err); return { url: `local:${a.id}`, link: nombre }; }
      }
      await esperar(500);
    }
    throw new Error('No se pudo bajar el archivo que mandó el cliente');
  }

  function programarDespedida(chatId, nombre, texto) {
    clearTimeout(despedidas.get(chatId));
    despedidas.delete(chatId);
    if (!texto) return;
    despedidas.set(chatId, setTimeout(async () => {
      despedidas.delete(chatId);
      try {
        await enviar(chatId, { tipo: 'texto', texto });
        alMensaje({ chatId, nombre, texto, de: 'bot', fuente: 'despedida', ts: Date.now() });
      } catch (err) { console.error('Despedida', err); }
    }, INACTIVIDAD_MS));
  }

  async function turno({ chatId, from, nombre, texto, adjunto }, avanzar = null) {
    const pedido = { chatId, telefono: from || chatId, nombre, texto, avanzar, adjunto: !avanzar && adjunto ? { tipo: adjunto.tipo, nombreArchivo: adjunto.nombreArchivo } : null };
    let t = await api('POST', `/api/bots/${botId}/turno`, pedido);
    // El estado pide un archivo y este le sirve: se sube y se repite el turno
    if (t.faltaArchivo) {
      Object.assign(pedido.adjunto, await subirAdjunto(adjunto));
      t = await api('POST', `/api/bots/${botId}/turno`, pedido);
    }
    if (cerrado) return;
    // Adjunto sin texto que el estado no pide: queda en el registro, pero el agente no responde
    if (t.ignorado) return !texto && adjunto && !avanzar && alMensaje({ chatId, nombre, texto: '', adjunto, de: 'cliente', ts: Date.now() });
    // Escribió (y el agente le contesta): la despedida pendiente se cancela; se vuelve a programar al final
    programarDespedida(chatId);
    if (!avanzar) alMensaje({ chatId, nombre, texto: texto || '', adjunto, de: 'cliente', ts: Date.now() });
    for (const m of t.mensajes) {
      // Pausa "escribiendo…" de 2 a 6 s antes de cada mensaje, para no responder como un bot instantáneo
      worker?.postMessage({ tipo: 'escribiendo', to: chatId });
      await esperar(2000 + Math.random() * 4000);
      await enviar(chatId, m);
      alMensaje({ chatId, nombre, texto: m.resumen, de: 'bot', fuente: t.fuente, ts: Date.now() });
    }
    for (const w of t.whatsapp) await enviar(w.jid, w.mensaje).catch(err => console.error('WhatsApp de acción', err));
    for (const r of t.registro) alMensaje({ chatId, nombre, texto: r, de: 'bot', fuente: 'accion', ts: Date.now() });
    if (t.auto?.destino) {
      await esperar(t.auto.espera * 1000);
      if (!cerrado) await turno({ chatId, from, nombre, texto: null }, t.auto.destino);
    } else programarDespedida(chatId, nombre, t.despedida);
  }

  function arrancarWorker() {
    worker = new Worker('/wa-worker.js', { type: 'module' });
    worker.onmessage = ({ data: d }) => {
      if (d.tipo === 'estado') pintar(d);
      else if (d.tipo === 'respuesta') {
        const p = pendientes.get(d.id);
        pendientes.delete(d.id);
        if (d.error) p?.mal(new Error(d.error)); else p?.ok();
      } else if (d.tipo === 'mensaje') turno(d).catch(err => console.error('WhatsApp', err));
      else if (d.tipo === 'media') alMedia?.(d.id);
      else if (d.tipo === 'foto') alFoto?.(d.chatId, d.url);
    };
    worker.onerror = e => pintar({ estado: 'error', detalle: e.message || 'No se pudo iniciar WhatsApp en el navegador.' });
    worker.postMessage({ tipo: 'iniciar', botId, clave: claveLocal });
  }

  function apagarWorker() {
    worker?.terminate();
    worker = null;
    for (const t of [...timers, ...despedidas.values()]) clearTimeout(t);
    timers.clear();
    despedidas.clear();
    for (const p of pendientes.values()) p.mal(new Error('WhatsApp se desconectó'));
    pendientes.clear();
  }

  async function conectar() {
    if (quiere || cerrado) return;
    quiere = true;
    if (pedido) return; // ya está esperando el lock
    pedido = true;
    const nombre = `wa:${botId}`;
    const ocupado = (await navigator.locks.query()).held?.some(l => l.name === nombre);
    if (ocupado) pintar({ estado: 'desconectado', detalle: 'El agente ya está corriendo en otra pestaña.' });
    navigator.locks.request(nombre, () => new Promise(r => {
      pedido = false;
      liberar = r;
      if (cerrado || !quiere) { liberar = null; return r(); }
      arrancarWorker();
    }));
  }

  // Corta la conexión (la sesión queda guardada) o desvincula el número
  async function desconectar({ cerrarSesion = false } = {}) {
    quiere = false;
    if (worker) {
      if (cerrarSesion) {
        worker.postMessage({ tipo: 'cerrarSesion' });
        await new Promise(r => { const t = setTimeout(r, 4000); worker.addEventListener('message', e => { if (e.data.tipo === 'estado' && e.data.estado === 'desconectado') { clearTimeout(t); r(); } }); });
      } else worker.postMessage({ tipo: 'detener' });
    }
    apagarWorker();
    liberar?.();
    liberar = null;
    pintar({ estado: 'desconectado', detalle: cerrarSesion ? 'Sesión cerrada.' : '' });
  }

  return {
    conectar,
    desconectar,
    // Al cambiar de agente o cerrar la página: soltar todo sin avisar a nadie
    cerrar() { cerrado = true; apagarWorker(); liberar?.(); liberar = null; },
    estado: () => estado,
    enviar,
  };
}
