import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { SCOPES_INTEGRACION, guardarCuenta } from './google.js';

// Login con Google (OAuth 2.0, flujo de código en el servidor).
// La sesión es una cookie firmada con HMAC: no hace falta guardar nada en disco.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const DURACION = 30 * 24 * 3600 * 1000;

async function cargarSecreto() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const archivo = path.join(DATA_DIR, '.secreto-sesion');
  try { return (await readFile(archivo, 'utf8')).trim(); } catch {}
  const s = randomBytes(32).toString('hex');
  await writeFile(archivo, s, { mode: 0o600 });
  return s;
}
const SECRETO = await cargarSecreto();

const firmar = v => createHmac('sha256', SECRETO).update(v).digest('base64url');

function sellar(datos) {
  const v = Buffer.from(JSON.stringify(datos)).toString('base64url');
  return `${v}.${firmar(v)}`;
}

function abrir(token) {
  const [v, f] = String(token || '').split('.');
  if (!v || !f) return null;
  const a = Buffer.from(f), b = Buffer.from(firmar(v));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const datos = JSON.parse(Buffer.from(v, 'base64url').toString());
    return datos.exp > Date.now() ? datos : null;
  } catch { return null; }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => {
    const i = c.indexOf('=');
    return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
  }));
}

const opcionesCookie = req => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
const redirectUri = req => `${process.env.BASE_URL || `${req.protocol}://${req.get('host')}`}/auth/google/callback`;

export function usuario(req) {
  return abrir(cookies(req).sesion);
}

// /api/* devuelve 401; las páginas redirigen al login
export function requerirLogin(req, res, next) {
  req.usuario = usuario(req);
  if (req.usuario) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Sesión vencida' });
  res.redirect('/login.html');
}

export function rutasAuth(app) {
  // Mismo flujo para el login y para conectar Gmail/Sheets; el state dice cuál es
  const autorizar = (req, res, { proposito, scope, extra }) => {
    if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send('Falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en .env');
    const state = `${proposito}.${randomBytes(16).toString('hex')}`;
    res.cookie('oauth_state', state, { ...opcionesCookie(req), maxAge: 10 * 60 * 1000 });
    const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirectUri(req), response_type: 'code', scope, state, ...extra });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  };

  app.get('/auth/google', (req, res) =>
    autorizar(req, res, { proposito: 'login', scope: 'openid email profile', extra: { prompt: 'select_account' } }));

  // Permisos para las acciones: mandar mails y editar planillas con la cuenta del dueño
  app.get('/auth/google/conectar', requerirLogin, (req, res) =>
    autorizar(req, res, {
      proposito: 'conectar',
      scope: SCOPES_INTEGRACION.join(' '),
      extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', login_hint: req.usuario.email },
    }));

  app.get('/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const esperado = cookies(req).oauth_state;
    res.clearCookie('oauth_state', opcionesCookie(req));
    const conectando = String(state || '').startsWith('conectar.');
    const fallo = conectando ? '/?google=error#comportamiento' : '/login.html?error=1';
    if (error || !code || !state || state !== esperado) return res.redirect(fallo);
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri(req), grant_type: 'authorization_code' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error_description || data.error);
      // El id_token viene directo de Google por TLS: alcanza con decodificarlo
      const p = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
      if (p.aud !== CLIENT_ID || !p.email_verified) throw new Error('Token inválido');
      if (conectando) {
        const yo = usuario(req);
        if (!yo) return res.redirect('/login.html');
        await guardarCuenta(yo.sub, { refresh_token: data.refresh_token, email: p.email, scope: data.scope });
        return res.redirect('/?google=ok#comportamiento');
      }
      res.cookie('sesion', sellar({ sub: p.sub, email: p.email, nombre: p.name, foto: p.picture, exp: Date.now() + DURACION }),
        { ...opcionesCookie(req), maxAge: DURACION });
      res.redirect('/');
    } catch (err) {
      console.error('Google OAuth:', err.message);
      res.redirect(fallo);
    }
  });

  app.post('/auth/salir', (req, res) => {
    res.clearCookie('sesion', opcionesCookie(req));
    res.json({ ok: true });
  });
}
