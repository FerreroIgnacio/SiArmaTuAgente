import { BaileysProvider } from './baileys.js';
import { MetaProvider } from './meta.js';

// Todos los proveedores exponen la misma interfaz (EventEmitter):
//   start(), stop(), logout(), send(to, mensaje), typing(to)
//   mensaje: { tipo: 'texto'|'imagen'|'documento'|'ubicacion'|'contacto', ... } (ver engine.renderizar)
//   emite 'status' { estado, qr?, detalle?, numero? }  y  'message' { chatId, from, nombre, texto }
// Elegir uno u otro es solo config: bot.conexion.proveedor
const PROVEEDORES = {
  baileys: BaileysProvider,
  meta: MetaProvider,
};

export function createProvider(bot) {
  const Provider = PROVEEDORES[bot.conexion?.proveedor];
  if (!Provider) throw new Error(`Proveedor desconocido: ${bot.conexion?.proveedor}`);
  return new Provider(bot);
}

export const proveedoresDisponibles = Object.keys(PROVEEDORES);
