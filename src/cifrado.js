import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from 'cloudflare:workers';

// Secretos de los usuarios guardados en D1 (refresh token de Google, tokens de Meta): AES-256-GCM con el secret
// CLAVE_TOKENS (64 hex: `openssl rand -hex 32`)
function clave() {
  const k = Buffer.from(env.CLAVE_TOKENS || '', 'hex');
  if (k.length !== 32) throw new Error('CLAVE_TOKENS tiene que ser de 32 bytes (64 caracteres hex)');
  return k;
}

export function cifrar(texto) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', clave(), iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), datos].map(b => b.toString('base64url')).join('.');
}

export function descifrar(s) {
  const [iv, tag, datos] = s.split('.').map(b => Buffer.from(b, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', clave(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(datos), d.final()]).toString('utf8');
}
