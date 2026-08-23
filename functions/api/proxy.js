// Cloudflare Pages Function: /api/proxy
// Recibe peticiones del frontend (que ya pasó Cloudflare Access),
// inyecta la clave secreta, y hace fetch al Google Apps Script backend.
// Sigue redirects manualmente porque Apps Script redirige a
// script.googleusercontent.com (otro dominio) y `redirect: 'follow'`
// tiene issues con eso en Cloudflare Workers (tira error 1101).
// Variables WEB_APP_URL_BELLEZA y BELLEZA_KEY se configuran en el
// dashboard de Cloudflare Pages → Settings → Environment variables.
// Mismo patrón que /api/proxy de vida-panel — no reinventar si se toca.

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (!env.WEB_APP_URL_BELLEZA || !env.BELLEZA_KEY) {
      return json({ ok: false, error: 'env vars not configured' }, 500);
    }

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const params = new URLSearchParams(url.search);
      params.set('key', env.BELLEZA_KEY);
      const upstream = env.WEB_APP_URL_BELLEZA + '?' + params.toString();
      const text = await fetchFollow(upstream, { method: 'GET' });
      return new Response(text, {
        headers: { 'content-type': 'application/json' }
      });
    }

    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'invalid json in request body' }, 400);
      }
      body.key = env.BELLEZA_KEY;
      const text = await fetchFollow(env.WEB_APP_URL_BELLEZA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return new Response(text, {
        headers: { 'content-type': 'application/json' }
      });
    }

    return json({ ok: false, error: 'method not allowed' }, 405);

  } catch (err) {
    return json({ ok: false, error: 'proxy exception: ' + (err && err.message || String(err)) }, 500);
  }
}

// Sigue redirects manualmente hasta 5 saltos.
// Apps Script devuelve 302 al primer hit, con Location apuntando a
// script.googleusercontent.com/macros/echo?... — ahí sí llega el JSON.
async function fetchFollow(url, init) {
  let r = await fetch(url, Object.assign({}, init, { redirect: 'manual' }));
  for (let i = 0; i < 5; i++) {
    if (r.status !== 301 && r.status !== 302 && r.status !== 303 && r.status !== 307 && r.status !== 308) break;
    const loc = r.headers.get('location');
    if (!loc) break;
    r = await fetch(loc, { method: 'GET', redirect: 'manual' });
  }
  return await r.text();
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json' }
  });
}
