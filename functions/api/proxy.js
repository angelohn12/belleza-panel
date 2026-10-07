// Cloudflare Pages Function: /api/proxy
// Recibe peticiones del frontend (que ya pasó Cloudflare Access),
// inyecta la clave secreta, y hace fetch al Google Apps Script backend.
// Sigue redirects manualmente porque Apps Script redirige a
// script.googleusercontent.com (otro dominio) y `redirect: 'follow'`
// tiene issues con eso en Cloudflare Workers (tira error 1101).
// Variables WEB_APP_URL_BELLEZA y BELLEZA_KEY se configuran en el
// dashboard de Cloudflare Pages → Settings → Environment variables.
// Mismo patrón que /api/proxy de vida-panel — no reinventar si se toca.

// Cloudflare Access protege belleza-panel.pages.dev, pero NO las direcciones
// de vista previa que Cloudflare crea en cada publicación
// (xxxxxxxx.belleza-panel.pages.dev): ahí este proxy respondía con la clave
// del servidor sin pedir login. Por eso ahora el proxy mismo comprueba el
// pase que Access le pone a cada visita autenticada (un JWT firmado por
// Cloudflare, en la cabecera Cf-Access-Jwt-Assertion). Sin un pase válido
// para ESTA aplicación, no se toca el backend.
const ACCESS_EQUIPO = 'https://silent-recipe-1a33.cloudflareaccess.com';
const ACCESS_AUD = '26d2eee0110741042261f246de057c06f5d9dca9fb6aae5f720c0101f0d8841f';

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (!env.WEB_APP_URL_BELLEZA || !env.BELLEZA_KEY) {
      return json({ ok: false, error: 'env vars not configured' }, 500);
    }

    if (!(await paseDeAccessValido(request))) {
      return json({ ok: false, error: 'acceso no autorizado' }, 403);
    }

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const params = new URLSearchParams(url.search);
      params.set('key', env.BELLEZA_KEY);
      const upstream = env.WEB_APP_URL_BELLEZA + '?' + params.toString();
      const r = await fetchFollow(upstream, { method: 'GET' });
      // Se devuelve el cuerpo TAL CUAL, sin leerlo acá. Leerlo con .text()
      // obligaba a este worker a cargar en memoria y reprocesar los ~800 KB
      // de la lectura completa (1.200+ productos), y Cloudflare le da muy
      // poco tiempo de CPU: por eso el panel se quedaba sin cargar nada al
      // darle "Actualizar". Pasando el flujo de largo, el worker casi no
      // trabaja y el tamaño de la respuesta deja de importar.
      return new Response(r.body, {
        status: r.status,
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
      const r = await fetchFollow(env.WEB_APP_URL_BELLEZA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': 'application/json' }
      });
    }

    return json({ ok: false, error: 'method not allowed' }, 405);

  } catch (err) {
    return json({ ok: false, error: 'proxy exception: ' + (err && err.message || String(err)) }, 500);
  }
}

// ---------- Pase de Cloudflare Access ----------

// Las llaves públicas con que Cloudflare firma los pases. Se guardan un rato
// en memoria del worker para no pedirlas en cada lectura del panel.
let llavesAccess = null;
let llavesAccessHasta = 0;

async function llavesDeAccess(forzar) {
  if (!forzar && llavesAccess && Date.now() < llavesAccessHasta) return llavesAccess;
  const r = await fetch(ACCESS_EQUIPO + '/cdn-cgi/access/certs');
  if (!r.ok) throw new Error('no se pudieron leer las llaves de Access');
  const datos = await r.json();
  llavesAccess = datos.keys || [];
  llavesAccessHasta = Date.now() + 60 * 60 * 1000;
  return llavesAccess;
}

function base64urlABytes(texto) {
  const b64 = texto.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((texto.length + 3) % 4);
  const binario = atob(b64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

function base64urlAJson(texto) {
  return JSON.parse(new TextDecoder().decode(base64urlABytes(texto)));
}

// true solo si el pase está firmado por Cloudflare para esta aplicación y
// no venció. Cualquier cosa rara (sin pase, mal formado, firma que no
// coincide) → false: ante la duda, no se entra.
async function paseDeAccessValido(request) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  const partes = token.split('.');
  if (partes.length !== 3) return false;

  let cabecera, datos;
  try {
    cabecera = base64urlAJson(partes[0]);
    datos = base64urlAJson(partes[1]);
  } catch {
    return false;
  }
  if (cabecera.alg !== 'RS256' || !cabecera.kid) return false;

  const audiencias = Array.isArray(datos.aud) ? datos.aud : [datos.aud];
  if (audiencias.indexOf(ACCESS_AUD) === -1) return false;
  if (datos.iss !== ACCESS_EQUIPO) return false;
  const ahora = Math.floor(Date.now() / 1000);
  if (!(Number(datos.exp) > ahora)) return false;
  if (datos.nbf && Number(datos.nbf) > ahora + 60) return false;

  // Si la llave no está en las guardadas, puede que Cloudflare la haya
  // rotado: se vuelven a pedir una vez.
  let llaves = await llavesDeAccess(false);
  let jwk = llaves.find(k => k.kid === cabecera.kid);
  if (!jwk) {
    llaves = await llavesDeAccess(true);
    jwk = llaves.find(k => k.kid === cabecera.kid);
  }
  if (!jwk) return false;

  const llave = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', llave,
    base64urlABytes(partes[2]),
    new TextEncoder().encode(partes[0] + '.' + partes[1])
  );
}

// Sigue redirects manualmente hasta 5 saltos.
// Apps Script devuelve 302 al primer hit, con Location apuntando a
// script.googleusercontent.com/macros/echo?... — ahí sí llega el JSON.
//
// Devuelve la respuesta ENTERA (no su texto): así quien llama puede pasar el
// cuerpo de largo como flujo, sin que este worker tenga que cargarse en
// memoria respuestas de cientos de KB.
async function fetchFollow(url, init) {
  let r = await fetch(url, Object.assign({}, init, { redirect: 'manual' }));
  for (let i = 0; i < 5; i++) {
    if (r.status !== 301 && r.status !== 302 && r.status !== 303 && r.status !== 307 && r.status !== 308) break;
    const loc = r.headers.get('location');
    if (!loc) break;
    r = await fetch(loc, { method: 'GET', redirect: 'manual' });
  }
  return r;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json' }
  });
}
