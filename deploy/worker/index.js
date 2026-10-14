// Front en Cloudflare: estáticos desde public/ (assets) y el resto se proxea a la VM.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('X-Origin-Secret', env.ORIGIN_SECRET);
    headers.set('X-Forwarded-Proto', 'https');
    headers.set('X-Forwarded-Host', url.host);
    return fetch(new Request(env.ORIGIN + url.pathname + url.search, {
      method: request.method, headers, body: request.body, redirect: 'manual',
    }));
  },
};
