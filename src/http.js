import { env } from 'cloudflare:workers';

// Ayudas para armar respuestas en el Worker
// CSP de las páginas: igual que la de public/_headers
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com', "img-src 'self' data: blob: https:", "media-src 'self' data: blob: https:",
  "connect-src 'self' https: wss://*.whatsapp.com", "worker-src 'self'", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", 'frame-src https://sisoftwaresolutions.com', "frame-ancestors 'none'",
].join('; ');

export const SEGURIDAD = {
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function conCookies(headers, lista = []) {
  const h = new Headers({ ...SEGURIDAD, ...headers });
  for (const c of lista) h.append('Set-Cookie', c);
  return h;
}

export const json = (datos, status = 200, setCookies) =>
  new Response(JSON.stringify(datos), { status, headers: conCookies({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, setCookies) });

export const redirigir = (destino, setCookies) => new Response(null, { status: 302, headers: conCookies({ Location: destino }, setCookies) });

export const setCookie = (nombre, valor, segundos) =>
  `${nombre}=${encodeURIComponent(valor)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(segundos)}`;

export function cookies(req) {
  return Object.fromEntries((req.headers.get('cookie') || '').split(/;\s*/).filter(Boolean).map(c => {
    const i = c.indexOf('=');
    try { return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; } catch { return [c.slice(0, i), '']; }
  }));
}

// Límites de pedidos (bindings `ratelimits` de wrangler.jsonc). Sin el binding no limita
export const dentroDelLimite = async (limite, key) => !env[limite] || (await env[limite].limit({ key })).success;
export const demasiados = () => json({ error: 'Demasiados pedidos seguidos, esperá un momento' }, 429);
