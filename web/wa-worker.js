// WhatsApp (Baileys) corriendo en un Web Worker del navegador del usuario: la conexión sale de su
// compu y su IP, sin servidor de por medio. Se bundlea con `npm run build:web` → public/wa-worker.js
// Mensajes con la página (ver public/whatsapp.js):
//   recibe  { tipo: 'iniciar', botId } | { tipo: 'enviar', id, to, mensaje } | { tipo: 'escribiendo', to } | { tipo: 'detener' } | { tipo: 'cerrarSesion' }
//   manda   { tipo: 'estado', estado, qr?, numero?, detalle? } | { tipo: 'mensaje', chatId, from, nombre, texto } | { tipo: 'respuesta', id, error? }
import './shims/timers.js';
import { createHash, randomBytes } from 'crypto';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  decryptPollVote,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  initAuthCreds,
  isJidBroadcast,
  isJidStatusBroadcast,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
} from 'baileys';
import { cifrarLocal, descifrarLocal, estaCifrado, importarClave } from '../public/cifrado-local.js';

// Los errores dentro del objeto se muestran con su stack (copiados desde la consola salen como {})
const log = f => (o, ...a) => { const e = o?.err || o?.error; f('[baileys]', ...a, o, ...(e ? [e?.stack || e] : [])); };
const logger = { level: 'warn', child: () => logger, trace() {}, debug() {}, info() {}, warn: log(console.warn), error: log(console.error), fatal: log(console.error) };

/* ---------- Sesión en IndexedDB (equivalente a useMultiFileAuthState), cifrada con la clave del usuario ---------- */
let clave = null;
const db = new Promise((ok, mal) => {
  const r = indexedDB.open('siagente-wa', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => mal(r.error);
});
async function tx(modo, fn) {
  const t = (await db).transaction('kv', modo);
  const res = fn(t.objectStore('kv'));
  await new Promise((ok, mal) => { t.oncomplete = ok; t.onerror = t.onabort = () => mal(t.error); });
  return res?.result;
}
// Si no se puede descifrar (era de otra cuenta) es como si no hubiera nada: pide el QR de nuevo
const leer = async k => {
  const v = await tx('readonly', s => s.get(k));
  try { return v ? JSON.parse(await descifrarLocal(clave, v), BufferJSON.reviver) : null; } catch { return null; }
};
// Las escrituras se cifran antes de abrir la transacción y van en orden
let escrituras = Promise.resolve();
const escribir = async cambios => {
  const listos = await Promise.all(cambios.map(async ([k, v]) => [k, v == null ? null : await cifrarLocal(clave, JSON.stringify(v, BufferJSON.replacer))]));
  const hecho = escrituras.then(() => tx('readwrite', s => { for (const [k, v] of listos) v == null ? s.delete(k) : s.put(v, k); }));
  escrituras = hecho.catch(() => {});
  return hecho;
};

async function sesionGuardada(botId) {
  const pre = `${botId}:`;
  // Lo guardado antes sin cifrar se cifra
  const rango = IDBKeyRange.bound(pre, `${pre}￿`);
  const [ks, vs] = await Promise.all([tx('readonly', s => s.getAllKeys(rango)), tx('readonly', s => s.getAll(rango))]);
  const planos = ks.map((k, i) => [k, vs[i]]).filter(([, v]) => !estaCifrado(v));
  if (planos.length) await escribir(planos.map(([k, v]) => [k, JSON.parse(v, BufferJSON.reviver)]));
  const creds = (await leer(`${pre}creds`)) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const datos = {};
          await Promise.all(ids.map(async id => {
            let v = await leer(`${pre}${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            datos[id] = v;
          }));
          return datos;
        },
        set: data => escribir(Object.entries(data).flatMap(([type, ids]) =>
          Object.entries(ids).map(([id, v]) => [`${pre}${type}-${id}`, v || null]))),
      },
    },
    guardarCreds: () => escribir([[`${pre}creds`, creds]]),
    borrar: () => escrituras.then(() => tx('readwrite', s => s.delete(IDBKeyRange.bound(pre, `${pre}￿`)))),
  };
}

/* ---------- Mensajes ---------- */
const MIMES = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  mp3: 'audio/mpeg', mpeg: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'video/mp4',
};
const mimeDe = nombre => MIMES[String(nombre).split('.').pop().toLowerCase()] || 'application/octet-stream';

// Mensaje genérico → contenido de Baileys. Imágenes y documentos llegan ya descargados (m.datos)
function contenido(m) {
  switch (m.tipo) {
    case 'imagen':
      return { image: Buffer.from(m.datos), caption: m.texto || undefined };
    case 'documento':
      return { document: Buffer.from(m.datos), fileName: m.nombreArchivo, mimetype: mimeDe(m.nombreArchivo || m.url), caption: m.texto || undefined };
    case 'audio':
      return { audio: Buffer.from(m.datos), mimetype: m.nota ? 'audio/ogg; codecs=opus' : mimeDe(m.nombreArchivo || m.url), ptt: !!m.nota };
    case 'video':
      return { video: Buffer.from(m.datos), caption: m.texto || undefined };
    case 'ubicacion':
      return { location: { degreesLatitude: m.lat, degreesLongitude: m.lng, name: m.nombre || undefined, address: m.direccion || undefined } };
    case 'encuesta':
      return { poll: { name: m.texto, values: m.opciones, selectableCount: 1, messageSecret: randomBytes(32) } };
    case 'contacto': {
      const tel = String(m.telefono).replace(/[^\d+]/g, '');
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${m.nombre}\nTEL;type=CELL;waid=${tel.replace('+', '')}:${tel}\nEND:VCARD`;
      return { contacts: { displayName: m.nombre, contacts: [{ vcard }] } };
    }
    default:
      return { text: m.texto };
  }
}

function textoDe(msg) {
  const m = normalizeMessageContent(msg.message);
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

// Lo que mandó el cliente además (o en vez) de texto: { tipo, nombreArchivo? }
function adjuntoDe(msg) {
  const m = normalizeMessageContent(msg.message);
  if (!m) return null;
  if (m.imageMessage) return { tipo: 'imagen' };
  if (m.videoMessage) return { tipo: m.videoMessage.gifPlayback ? 'gif' : 'video' };
  if (m.audioMessage) return { tipo: m.audioMessage.ptt ? 'nota de voz' : 'audio' };
  if (m.documentMessage) return { tipo: 'documento', nombreArchivo: m.documentMessage.fileName || '' };
  if (m.stickerMessage) return { tipo: 'sticker' };
  if (m.locationMessage || m.liveLocationMessage) return { tipo: 'ubicacion' };
  if (m.contactMessage || m.contactsArrayMessage) return { tipo: 'contacto' };
  return null;
}

// Fotos, audios, etc. se bajan a IndexedDB ('adjuntos', por id de mensaje) y la página los muestra en el registro
const mediaDB = new Promise((ok, mal) => {
  const r = indexedDB.open('adjuntos', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('media');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => mal(r.error);
});
const MEDIA = new Set(['imagen', 'video', 'gif', 'audio', 'nota de voz', 'documento', 'sticker']);
const MAX_MEDIA = 30 * 1024 * 1024;
async function bajarMedia(msg, id, s) {
  const m = normalizeMessageContent(msg.message);
  const info = m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage;
  if (Number(info?.fileLength || 0) > MAX_MEDIA) return;
  try {
    const buf = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: s.updateMediaMessage, logger });
    const t = (await mediaDB).transaction('media', 'readwrite');
    t.objectStore('media').put(new Blob([buf], { type: info?.mimetype || '' }), id);
    await new Promise((ok, mal) => { t.oncomplete = ok; t.onerror = t.onabort = () => mal(t.error); });
    avisar({ tipo: 'media', id });
  } catch (err) { console.warn('[wa] no se pudo bajar el adjunto', err); }
}

/* ---------- Conexión ---------- */
const avisar = d => postMessage(d);
let botId = null, sock = null, sesion = null, detenido = false;
// Encuestas enviadas (en memoria): id → { secreto, opciones }, para descifrar los votos
const encuestas = new Map();
// Fotos de perfil ya pedidas en esta sesión (jid → url | null)
const fotos = new Map();
async function avisarFoto(jid) {
  if (fotos.has(jid)) return;
  fotos.set(jid, null);
  const url = await sock?.profilePictureUrl(jid, 'image').catch(() => null);
  fotos.set(jid, url || null);
  if (url) avisar({ tipo: 'foto', chatId: jid, url });
}

// El voto llega cifrado; la opción elegida viene como sha256 de su texto
function votoDe(msg) {
  const voto = msg.message?.pollUpdateMessage;
  const enc = encuestas.get(voto?.pollCreationMessageKey?.id);
  if (!enc) return '';
  const yo = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map(jidNormalizedUser);
  const votantes = [msg.key.remoteJidAlt, msg.key.remoteJid, msg.key.participantAlt, msg.key.participant].filter(Boolean).map(jidNormalizedUser);
  for (const pollCreatorJid of yo) {
    for (const voterJid of votantes) {
      try {
        const { selectedOptions } = decryptPollVote(voto.vote, { pollEncKey: enc.secreto, pollCreatorJid, pollMsgId: voto.pollCreationMessageKey.id, voterJid });
        const hash = selectedOptions?.[0] && Buffer.from(selectedOptions[0]).toString('hex');
        return enc.opciones.find(o => createHash('sha256').update(o).digest('hex') === hash) || '';
      } catch {}
    }
  }
  return '';
}

async function iniciar() {
  detenido = false;
  avisar({ tipo: 'estado', estado: 'conectando' });
  sesion = await sesionGuardada(botId);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const s = makeWASocket({
    auth: sesion.state,
    version,
    logger,
    browser: Browsers.ubuntu('Si Arma Tu Agente'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock = s;

  s.ev.on('creds.update', sesion.guardarCreds);

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s !== sock) return;
    if (qr) {
      const svg = await QRCode.toString(qr, { type: 'svg', margin: 1, width: 280, color: { dark: '#1f1a17' } });
      avisar({ tipo: 'estado', estado: 'esperando_qr', qr: `data:image/svg+xml;base64,${btoa(svg)}` });
    }
    if (connection === 'open') {
      avisar({ tipo: 'estado', estado: 'conectado', numero: s.user?.id?.split(':')[0]?.split('@')[0] });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      sock = null;
      if (detenido) return;
      if (code === DisconnectReason.loggedOut) {
        await sesion.borrar();
        avisar({ tipo: 'estado', estado: 'desconectado', detalle: 'Se cerró la sesión desde el teléfono.' });
        return;
      }
      // restartRequired (tras escanear el QR), caídas de red, etc.: reconectar
      setTimeout(() => iniciar().catch(err => avisar({ tipo: 'estado', estado: 'error', detalle: err.message })), 1500);
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    console.debug('[wa] upsert', type, messages);
    if (type !== 'notify') return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid || msg.key.fromMe) continue;
      if (isJidStatusBroadcast(jid) || isJidBroadcast(jid)) continue;
      const texto = msg.message?.pollUpdateMessage ? votoDe(msg) : textoDe(msg);
      const adjunto = adjuntoDe(msg);
      if (!texto && !adjunto) { console.warn('[wa] mensaje sin texto, ignorado', msg); continue; }
      s.readMessages([msg.key]).catch(() => {}); // tildes azules
      if (adjunto && MEDIA.has(adjunto.tipo)) adjunto.id = msg.key.id;
      avisar({ tipo: 'mensaje', chatId: jid, from: msg.key.remoteJidAlt || jid, nombre: msg.pushName || '', texto, adjunto });
      if (adjunto?.id) bajarMedia(msg, adjunto.id, s);
      avisarFoto(jid);
    }
  });
}

async function enviar(to, mensaje) {
  if (!sock) throw new Error('WhatsApp no está conectado');
  await sock.sendPresenceUpdate('paused', to).catch(() => {});
  const c = contenido(mensaje);
  const enviado = await sock.sendMessage(to, c);
  if (c.poll && enviado?.key?.id) encuestas.set(enviado.key.id, { secreto: c.poll.messageSecret, opciones: mensaje.opciones });
}

onmessage = async ({ data: d }) => {
  try {
    switch (d.tipo) {
      case 'iniciar':
        botId = d.botId;
        clave = await importarClave(d.clave);
        await iniciar();
        break;
      case 'enviar':
        try { await enviar(d.to, d.mensaje); avisar({ tipo: 'respuesta', id: d.id }); }
        catch (err) { avisar({ tipo: 'respuesta', id: d.id, error: err.message }); }
        break;
      case 'escribiendo':
        await sock?.sendPresenceUpdate('composing', d.to).catch(() => {});
        break;
      case 'detener': {
        detenido = true;
        const s = sock;
        sock = null;
        s?.end(undefined);
        avisar({ tipo: 'estado', estado: 'desconectado' });
        break;
      }
      case 'cerrarSesion': {
        detenido = true;
        const s = sock;
        sock = null;
        await s?.logout().catch(() => {});
        await sesion?.borrar();
        avisar({ tipo: 'estado', estado: 'desconectado', detalle: 'Sesión cerrada.' });
        break;
      }
    }
  } catch (err) {
    avisar({ tipo: 'estado', estado: 'error', detalle: err.message });
  }
};
