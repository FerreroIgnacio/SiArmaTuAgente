import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  decryptPollVote,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  useMultiFileAuthState,
} from 'baileys';
import { AUTH_DIR, resolverArchivo } from '../store.js';

const logger = pino({ level: 'silent' });

const MIMES = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
};
const mimeDe = nombre => MIMES[String(nombre).split('.').pop().toLowerCase()] || 'application/octet-stream';

// Mensaje genérico → contenido de Baileys
function contenido(m) {
  switch (m.tipo) {
    case 'imagen':
      return { image: { url: resolverArchivo(m.url) }, caption: m.texto || undefined };
    case 'documento':
      return { document: { url: resolverArchivo(m.url) }, fileName: m.nombreArchivo, mimetype: mimeDe(m.nombreArchivo || m.url), caption: m.texto || undefined };
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
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

export class BaileysProvider extends EventEmitter {
  constructor(bot) {
    super();
    this.bot = bot;
    this.sock = null;
    this.detenido = false;
    this.authDir = path.join(AUTH_DIR, bot.id);
    // Encuestas enviadas (en memoria): id → { secreto, opciones }, para descifrar los votos
    this.encuestas = new Map();
  }

  // El voto llega cifrado; la opción elegida viene como sha256 de su texto
  votoDe(msg) {
    const voto = msg.message?.pollUpdateMessage;
    const enc = this.encuestas.get(voto?.pollCreationMessageKey?.id);
    if (!enc) return '';
    const yo = [this.sock?.user?.id, this.sock?.user?.lid].filter(Boolean).map(jidNormalizedUser);
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

  async start() {
    this.detenido = false;
    this.emit('status', { estado: 'conectando' });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
      auth: state,
      version,
      logger,
      browser: Browsers.ubuntu('Si Arma Tu Agente'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (sock !== this.sock) return;
      if (qr) this.emit('status', { estado: 'esperando_qr', qr });

      if (connection === 'open') {
        const numero = sock.user?.id?.split(':')[0]?.split('@')[0];
        this.emit('status', { estado: 'conectado', numero });
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        this.sock = null;
        if (this.detenido) return;
        if (code === DisconnectReason.loggedOut) {
          await rm(this.authDir, { recursive: true, force: true });
          this.emit('status', { estado: 'desconectado', detalle: 'Se cerró la sesión desde el teléfono.' });
          return;
        }
        // restartRequired (tras escanear el QR), caídas de red, etc.: reconectar
        setTimeout(() => this.start().catch(err => this.emit('status', { estado: 'error', detalle: err.message })), 1500);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        if (!jid || msg.key.fromMe) continue;
        if (isJidStatusBroadcast(jid) || isJidBroadcast(jid)) continue;
        if (isJidGroup(jid) && this.bot.reglas?.ignorarGrupos !== false) continue;
        const texto = msg.message?.pollUpdateMessage ? this.votoDe(msg) : textoDe(msg);
        if (!texto) continue;
        this.emit('message', {
          chatId: jid,
          from: msg.key.remoteJidAlt || jid,
          nombre: msg.pushName || '',
          texto,
        });
      }
    });
  }

  async typing(to) {
    await this.sock?.sendPresenceUpdate('composing', to).catch(() => {});
  }

  async send(to, mensaje) {
    if (!this.sock) throw new Error('WhatsApp no está conectado');
    await this.sock.sendPresenceUpdate('paused', to).catch(() => {});
    const c = contenido(mensaje);
    const enviado = await this.sock.sendMessage(to, c);
    if (c.poll && enviado?.key?.id) this.encuestas.set(enviado.key.id, { secreto: c.poll.messageSecret, opciones: mensaje.opciones });
  }

  async stop() {
    this.detenido = true;
    const sock = this.sock;
    this.sock = null;
    sock?.end(undefined);
    this.emit('status', { estado: 'desconectado' });
  }

  async logout() {
    this.detenido = true;
    const sock = this.sock;
    this.sock = null;
    await sock?.logout().catch(() => {});
    await rm(this.authDir, { recursive: true, force: true });
    this.emit('status', { estado: 'desconectado', detalle: 'Sesión cerrada.' });
  }
}
