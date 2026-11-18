// Sogilex Sites: the Cloudflare Worker behind *.sogilex.net.
//
//   name.sogilex.net        serves a published site from KV (key "site:<name>"), with a strict
//                           Content-Security-Policy: no scripts, nothing loaded from elsewhere.
//   name.sogilex.net/__form receives the site's contact form and stores it through Supabase.
//   api.sogilex.net         publish / unpublish, called by build.sogilex.com with the person's sign-in.
//   sogilex.net, www        redirect to sogilex.com.
//
// No secrets: publishing is checked by Supabase database functions using the person's own sign-in token,
// and the Supabase key here is the public (publishable) one.
//
// Bindings: SITES (KV namespace), SUPABASE_URL, SUPABASE_KEY (publishable).

const ROOT = 'sogilex.net';
const BUILD_ORIGIN = 'https://build.sogilex.com';

const SITE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cache-Control': 'public, max-age=60',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    if (host === ROOT || host === 'www.' + ROOT) return Response.redirect('https://sogilex.com/', 301);
    if (!host.endsWith('.' + ROOT)) return page(404, 'Not found', 'There is nothing here.');
    const slug = host.slice(0, -(ROOT.length + 1));
    if (slug === 'api') return api(req, env, url);
    if (!/^[a-z0-9-]{3,32}$/.test(slug)) return notFound();

    if (url.pathname === '/__form') {
      if (req.method !== 'POST') return Response.redirect(url.origin + '/', 303);
      return form(req, env, slug, url);
    }
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'Content-Type': 'text/plain' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (url.pathname !== '/' && url.pathname !== '/index.html') return Response.redirect(url.origin + '/', 302);

    const html = await env.SITES.get('site:' + slug);
    if (!html) return notFound();
    return new Response(req.method === 'HEAD' ? null : html, { headers: SITE_HEADERS });
  },
};

// ---------- publish API (api.sogilex.net) ----------
function cors(extra) {
  return { 'Access-Control-Allow-Origin': BUILD_ORIGIN, 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin', ...extra };
}
function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: cors({ 'Content-Type': 'application/json' }) });
}

async function rpc(env, fn, args, token) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token || env.SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error_description || data.error)) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function api(req, env, url) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in first.' }, 401);
  try {
    if (url.pathname === '/publish') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'Send JSON.' }, 400); }
      const result = await rpc(env, 'publish_site', { p_build_id: String(body.build_id || ''), p_slug: String(body.slug || '') }, token);
      const html = await prepare(result.html, result.slug, result.logo);
      await env.SITES.put('site:' + result.slug, html);
      if (result.old_slug) await env.SITES.delete('site:' + result.old_slug);
      return json({ slug: result.slug, url: `https://${result.slug}.${ROOT}/` });
    }
    if (url.pathname === '/unpublish') {
      const slug = await rpc(env, 'unpublish_site', {}, token);
      if (slug) await env.SITES.delete('site:' + slug);
      return json({ ok: true, slug: slug || null });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    const status = err.status === 401 ? 401 : 400;
    return json({ error: status === 401 ? 'Your sign-in has expired. Sign in again.' : err.message }, status);
  }
}

// ---------- making a generated page safe to host ----------
// Generated sites contain no scripts, but this runs anyway: it strips anything active, points forms at
// /__form, and adds the Sogilex footer. The Content-Security-Policy above is the second line of defence.
const ACTIVE = 'script, iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv], link';
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'srcset', 'poster', 'data']);

async function prepare(html, slug, logo) {
  const footer = `<div style="all:initial;display:block;padding:14px 16px;text-align:center;font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;background:#120A18;color:#BBA9C2">Made with <a href="https://sogilex.com/" style="color:#FF9A4D">Sogilex</a> · <a href="mailto:hello@sogilex.com?subject=${encodeURIComponent('Report: ' + slug + '.' + ROOT)}" style="color:#BBA9C2">Report this site</a></div>`;
  const trap = '<div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true"><label>Leave this empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>';
  const rewriter = new HTMLRewriter()
    .on(ACTIVE, { element(el) { el.remove(); } })
    // The owner's logo: Build writes src="sogilex:logo"; the real image (a PNG data URL) goes in here.
    .on('img', { element(el) {
      if (el.getAttribute('src') !== 'sogilex:logo') return;
      if (typeof logo === 'string' && logo.startsWith('data:image/png;base64,')) el.setAttribute('src', logo);
      else el.remove();
    } })
    .on('*', {
      element(el) {
        const drop = [];
        for (const [name, value] of el.attributes) {
          const n = name.toLowerCase();
          if (n.startsWith('on')) drop.push(name);
          else if (URL_ATTRS.has(n) && /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) drop.push(name);
        }
        drop.forEach((n) => el.removeAttribute(n));
        if (el.tagName === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password') el.remove();
      },
      comments(c) { c.remove(); },
    })
    .onDocument({ comments(c) { c.remove(); } })
    .on('form', {
      element(el) {
        el.setAttribute('action', '/__form');
        el.setAttribute('method', 'post');
        el.removeAttribute('target');
        el.removeAttribute('enctype');
        el.prepend(trap, { html: true });
      },
    })
    .on('body', { element(el) { el.append(footer, { html: true }); } });
  return rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html' } })).text();
}

// ---------- contact forms ----------
async function form(req, env, slug, url) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > 20000) return page(413, 'Too long', 'That message is too long. Please shorten it and try again.', url.origin + '/');
  let data;
  try { data = await req.formData(); } catch { return page(400, 'Something went wrong', "Your message couldn't be read. Please go back and try again.", url.origin + '/'); }
  if (String(data.get('_hp') || '')) return thanks(url); // a bot filled the hidden field: pretend it worked
  const fields = {};
  let n = 0;
  for (const [key, value] of data.entries()) {
    if (key === '_hp' || typeof value !== 'string' || !value.trim()) continue;
    if (++n > 12) break;
    fields[String(key).slice(0, 60)] = value.slice(0, 2000);
  }
  if (!n) return page(400, 'Nothing to send', 'The form was empty. Please go back and fill it in.', url.origin + '/');
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|' + day));
  const ipHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  try {
    const ok = await rpc(env, 'submit_site_message', { p_slug: slug, p_fields: fields, p_ip_hash: ipHash });
    if (!ok) return page(429, 'Please try again later', "Too many messages were sent from here in a short time. Please try again in an hour.", url.origin + '/');
  } catch {
    return page(502, 'Something went wrong', "Your message didn't go through. Please try again in a few minutes.", url.origin + '/');
  }
  return thanks(url);
}

function thanks(url) {
  return page(200, 'Message sent', 'Thanks. Your message was sent to the owner of this site.', url.origin + '/');
}

// ---------- small pages ----------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
function page(status, title, text, back) {
  const link = back ? `<p><a href="${esc(back)}" style="color:#FF9A4D">← Back to the site</a></p>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#120A18;color:#F7EFF3;font:17px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;box-sizing:border-box">
<main style="max-width:30rem"><h1 style="font-size:28px;margin:0 0 12px">${esc(title)}</h1><p style="margin:0 0 20px;color:#BBA9C2">${esc(text)}</p>${link}</main></body></html>`;
  return new Response(html, { status, headers: { ...SITE_HEADERS, 'Cache-Control': 'no-store' } });
}
function notFound() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No site here yet</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#120A18;color:#F7EFF3;font:17px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;box-sizing:border-box">
<main style="max-width:30rem"><p style="margin:0 0 10px;font:13px ui-monospace,monospace;letter-spacing:.18em;color:#BBA9C2">SOGILEX</p><h1 style="font-size:28px;margin:0 0 12px">No site here yet.</h1>
<p style="margin:0 0 20px;color:#BBA9C2">This address isn't in use. Want a website like the ones hosted here?</p>
<p><a href="https://build.sogilex.com/" style="color:#FF9A4D">Build one with Sogilex →</a></p></main></body></html>`;
  return new Response(html, { status: 404, headers: { ...SITE_HEADERS, 'Cache-Control': 'public, max-age=30' } });
}
