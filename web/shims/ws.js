// `ws` (Node) sobre el WebSocket nativo, con la interfaz que usa Baileys
import { EventEmitter } from 'events';

export default class WebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    const ws = (this.ws = new globalThis.WebSocket(url));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.emit('open');
    ws.onmessage = e => this.emit('message', Buffer.from(e.data));
    ws.onerror = () => this.emit('error', new Error('Error de conexión con WhatsApp'));
    ws.onclose = e => this.emit('close', e.code, e.reason);
  }

  get readyState() { return this.ws.readyState; }

  send(data, cb) {
    try { this.ws.send(data); cb?.(); }
    catch (err) { cb?.(err); }
  }

  close() { this.ws.close(); }
  terminate() { this.ws.close(); }
}
