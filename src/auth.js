import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { db } from './store.js';
import { SCOPES_INTEGRACION, guardarCuenta } from './google.js';
import { cookies, json, redirigir, setCookie } from './http.js';

// Login con Google (OAuth 2.0, flujo de código en el servidor).
// La sesión es una cookie firmada con HMAC (secret SESSION_SECRET). Lleva la versión de sesiones del usuario
// (tabla sesiones): "cerrar sesión en todos los dispositivos" la sube y todas las cookies anteriores dejan de valer.
const DURACION = 5 * 24 * 3600 * 1000;
// Variable USUARIOS_PERMITIDOS="a@x.com,b@y.com": solo esas cuentas pueden entrar (vacía = cualquiera)
const permitido = email => {
  const lista = String(env.USUARIOS_PERMITIDOS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return !lista.length || lista.includes(String(email).toLowerCase());
};

const firmar = v => createHmac('sha256', env.SESSION_SECRET).update(v).digest('base64url');

function sellar(datos) {
  const v = Buffer.from(JSON.stringify(datos)).toString('base64url');
  return `${v}.${firmar(v)}`;
}

const version = async sub => (await db().prepare('SELECT ver FROM sesiones WHERE sub = ?').bind(String(sub)).first())?.ver || 0;

async function abrir(token) {
  const [v, f] = String(token || '').split('.');
  if (!v || !f) return null;
  const a = Buffer.from(f), b = Buffer.from(firmar(v));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const datos = JSON.parse(Buffer.from(v, 'base64url').toString());
    return datos.exp > Date.now() && permitido(datos.email) && (datos.ver || 0) === (await version(datos.sub)) ? datos : null;
  } catch { return null; }
}

const redirectUri = () => `${env.BASE_URL}/auth/google/callback`;

export const usuario = req => abrir(cookies(req).sesion);

// Mismo flujo para el login y para conectar Drive/Sheets; el state dice cuál es
function autorizar({ proposito, scope, extra }) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return new Response('Falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET', { status: 500 });
  const state = `${proposito}.${randomBytes(16).toString('hex')}`;
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope, state, ...extra });
  return redirigir(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, [setCookie('oauth_state', state, 10 * 60)]);
}

// → Response si la ruta es de auth; null si no
export async function rutasAuth(req, url) {
  const ruta = `${req.method} ${url.pathname}`;

  if (ruta === 'GET /auth/google') return autorizar({ proposito: 'login', scope: 'openid email profile', extra: { prompt: 'select_account' } });

  // Permisos para las acciones: archivos y planillas en el Drive del dueño
  if (ruta === 'GET /auth/google/conectar') {
    const yo = await usuario(req);
    if (!yo) return redirigir('/login.html');
    // Se vuelve a la sección desde donde se conectó (General o Planillas)
    return autorizar({
      proposito: url.searchParams.get('volver') === 'planillas' ? 'conectar.planillas' : 'conectar',
      scope: SCOPES_INTEGRACION.join(' '),
      extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', login_hint: yo.email },
    });
  }

  if (ruta === 'GET /auth/google/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state'), error = url.searchParams.get('error');
    const esperado = cookies(req).oauth_state;
    const borrarState = setCookie('oauth_state', '', 0);
    const conectando = String(state || '').startsWith('conectar.');
    const volver = String(state).split('.')[1] === 'planillas' ? 'planillas' : 'general';
    const fallo = conectando ? `/?google=error#${volver}` : '/login.html?error=1';
    if (error || !code || !state || state !== esperado) return redirigir(fallo, [borrarState]);
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error_description || data.error);
      // Conectar no pide openid: el mail de la cuenta conectada sale de Drive
      if (conectando) {
        const yo = await usuario(req);
        if (!yo) return redirigir('/login.html', [borrarState]);
        const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: `Bearer ${data.access_token}` } })
          .then(x => x.ok ? x.json() : null).catch(() => null);
        await guardarCuenta(yo.sub, { refresh_token: data.refresh_token, email: about?.user?.emailAddress || yo.email, scope: data.scope });
        return redirigir(`/?google=ok#${volver}`, [borrarState]);
      }
      // El id_token viene directo de Google por TLS: alcanza con decodificarlo
      const p = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
      if (p.aud !== env.GOOGLE_CLIENT_ID || !p.email_verified) throw new Error('Token inválido');
      if (!permitido(p.email)) return redirigir('/login.html?error=permiso', [borrarState]);
      const sesion = sellar({ sub: p.sub, email: p.email, nombre: p.name, foto: p.picture, ver: await version(p.sub), exp: Date.now() + DURACION });
      return redirigir('/', [borrarState, setCookie('sesion', sesion, DURACION / 1000)]);
    } catch (err) {
      console.error('Google OAuth:', err.message);
      return redirigir(fallo, [borrarState]);
    }
  }

  // ?todas=1 invalida las sesiones de todos los dispositivos
  if (ruta === 'POST /auth/salir') {
    const yo = await usuario(req);
    if (yo && url.searchParams.get('todas')) {
      await db().prepare('INSERT INTO sesiones (sub, ver) VALUES (?, 1) ON CONFLICT(sub) DO UPDATE SET ver = ver + 1').bind(String(yo.sub)).run();
    }
    return json({ ok: true }, 200, [setCookie('sesion', '', 0)]);
  }

  return null;
}
