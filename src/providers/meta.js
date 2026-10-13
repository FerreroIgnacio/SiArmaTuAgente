import { EventEmitter } from 'node:events';

// Stub de WhatsApp Cloud API (Meta). Misma interfaz que BaileysProvider.
// Para implementarlo:
//   - start(): validar accessToken + phoneNumberId (GET https://graph.facebook.com/v21.0/{phoneNumberId})
//     y emitir 'conectado' con el número. No hay QR.
//   - Webhook (src/server.js → /webhooks/meta/:botId): GET verifica hub.verify_token,
//     POST recibe entry[].changes[].value.messages[] → llamar a provider.recibir(...)
//   - send(): POST /{phoneNumberId}/messages con type text | image | document | location | contacts
//     (los menús ya llegan como texto; con Meta se podrían pasar a mensajes interactivos)
export class MetaProvider extends EventEmitter {
  constructor(bot) {
    super();
    this.bot = bot;
    this.config = bot.conexion?.meta || {};
  }

  async start() {
    const faltan = ['phoneNumberId', 'accessToken', 'verifyToken'].filter(k => !this.config[k]);
    if (faltan.length) {
      this.emit('status', { estado: 'error', detalle: `Faltan datos de Meta: ${faltan.join(', ')}` });
      return;
    }
    this.emit('status', { estado: 'error', detalle: 'La conexión con la API de Meta todavía no está disponible.' });
  }

  // Lo llamará el webhook con cada mensaje entrante
  recibir({ from, nombre, texto }) {
    this.emit('message', { chatId: from, from, nombre: nombre || '', texto });
  }

  async typing() {}

  async send() {
    throw new Error('API de Meta: send no implementado');
  }

  async stop() {
    this.emit('status', { estado: 'desconectado' });
  }

  async logout() {
    await this.stop();
  }
}
