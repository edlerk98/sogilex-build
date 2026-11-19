// Sogilex Sites: the Cloudflare Worker behind *.sogilex.net.
//
//   name.sogilex.net        serves a published site from KV (key "site:<name>"), with a strict
//                           Content-Security-Policy: no scripts, nothing loaded from elsewhere.
//   name.sogilex.net/__form receives the site's contact form and stores it through Supabase.
//   name.sogilex.net/photos/<id>.jpg  the owner's photos that the site uses, copied to KV when it's published.
//   name.sogilex.net/menu              the owner's online menu, built here from their menu text (public_menu).
//   name.sogilex.net/logo.png          the owner's logo, copied to KV when the site is published (one cached file,
//                                      instead of a copy inside the page for every place the logo appears).
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
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; font-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cache-Control': 'public, max-age=60',
  // Browsers remember to use https for a year, so a link typed without it never lands on an insecure page.
  'Strict-Transport-Security': 'max-age=31536000',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    // Never serve anything over plain http: browsers warn visitors that a contact form isn't secure. (Cloudflare's
    // "Always Use HTTPS" does this too; this keeps it true if that setting is ever turned off.) 308 keeps a POST a POST.
    if (url.protocol === 'http:') return Response.redirect('https://' + url.host + url.pathname + url.search, 308);
    if (host === ROOT || host === 'www.' + ROOT) return Response.redirect('https://sogilex.com/', 301);
    if (!host.endsWith('.' + ROOT)) return page(404, 'Not found', 'There is nothing here.');
    const slug = host.slice(0, -(ROOT.length + 1));
    if (slug === 'api') return api(req, env, url);
    if (!/^[a-z0-9-]{3,32}$/.test(slug)) return notFound();

    if (url.pathname === '/__form') {
      if (req.method !== 'POST') return Response.redirect(url.origin + '/', 303);
      return form(req, env, slug, url);
    }
    if (url.pathname === '/logo.png' && (req.method === 'GET' || req.method === 'HEAD')) return serveLogo(env, slug, req.method);
    if ((url.pathname === '/menu' || url.pathname === '/menu/') && (req.method === 'GET' || req.method === 'HEAD')) return serveMenu(env, slug, req.method);
    const photo = url.pathname.match(/^\/photos\/([0-9a-f-]{36})\.jpg$/);
    if (photo && (req.method === 'GET' || req.method === 'HEAD')) return servePhoto(env, slug, photo[1], req.method);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'Content-Type': 'text/plain' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (url.pathname !== '/' && url.pathname !== '/index.html') return Response.redirect(url.origin + '/', 302);

    const html = await env.SITES.get('site:' + slug);
    if (!html) {
      const m = await publicMenu(env, slug);
      return m ? Response.redirect(url.origin + '/menu', 302) : notFound();
    }
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
      const withPhotos = await copyPhotos(env, token, result.slug, result.html);
      const hasLogo = await copyLogo(env, result.slug, result.logo);
      const html = await prepare(withPhotos, result.slug, hasLogo);
      await env.SITES.put('site:' + result.slug, html);
      if (result.old_slug) { await env.SITES.delete('site:' + result.old_slug); await dropPhotos(env, result.old_slug, []); await env.SITES.delete('logo:' + result.old_slug); }
      return json({ slug: result.slug, url: `https://${result.slug}.${ROOT}/` });
    }
    if (url.pathname === '/unpublish') {
      const slug = await rpc(env, 'unpublish_site', {}, token);
      if (slug) { await env.SITES.delete('site:' + slug); await dropPhotos(env, slug, []); await env.SITES.delete('logo:' + slug); }
      return json({ ok: true, slug: slug || null });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    const status = err.status === 401 ? 401 : 400;
    return json({ error: status === 401 ? 'Your sign-in has expired. Sign in again.' : err.message }, status);
  }
}

// ---------- the owner's photos ----------
// Build pages refer to photos as sogilex:photo:<id>. When a site is published, the photos it uses are read from
// the owner's private Storage folder with their own sign-in, copied to KV ("photo:<site>:<id>") and the page is
// pointed at /photos/<id>.jpg on the site's own address. "photos:<site>" lists them, so a republish or unpublish
// can remove the ones no longer used. Photos that were deleted are left out (a blank image takes their place).
const PHOTO_TAG = /sogilex:photo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const MAX_SITE_PHOTOS = 40; // each copy is one fetch; Workers allow 50 per request

async function copyPhotos(env, token, slug, html) {
  const ids = [...new Set([...html.matchAll(PHOTO_TAG)].map((m) => m[1]))].slice(0, MAX_SITE_PHOTOS);
  const kept = [];
  if (ids.length) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/site_photos?select=id,user_id&id=in.(${ids.join(',')})`, {
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    const rows = res.ok ? await res.json() : [];
    await Promise.all(rows.map(async (r) => {
      const file = await fetch(`${env.SUPABASE_URL}/storage/v1/object/authenticated/site-photos/${r.user_id}/${r.id}.jpg`, {
        headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` },
      });
      if (!file.ok) return;
      const bytes = await file.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 3 * 1024 * 1024) return;
      await env.SITES.put(`photo:${slug}:${r.id}`, bytes);
      kept.push(r.id);
    }));
  }
  await dropPhotos(env, slug, kept);
  await env.SITES.put('photos:' + slug, JSON.stringify(kept));
  return html.replace(PHOTO_TAG, (_, id) => (kept.includes(id) ? `/photos/${id}.jpg` : BLANK_PNG));
}

// Remove a site's copied photos, except the ones in `keep`.
async function dropPhotos(env, slug, keep) {
  let old = [];
  try { old = JSON.parse((await env.SITES.get('photos:' + slug)) || '[]'); } catch { /* none */ }
  await Promise.all(old.filter((id) => !keep.includes(id)).map((id) => env.SITES.delete(`photo:${slug}:${id}`)));
  if (!keep.length) await env.SITES.delete('photos:' + slug);
}

// The logo comes from brand_kits as a PNG data URL; store it as a real file the page points at.
async function copyLogo(env, slug, logo) {
  const m = typeof logo === 'string' && logo.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) { await env.SITES.delete('logo:' + slug); return false; }
  const bin = atob(m[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) { await env.SITES.delete('logo:' + slug); return false; } // not a PNG
  await env.SITES.put('logo:' + slug, bytes);
  return true;
}
async function serveLogo(env, slug, method) {
  let bytes = await env.SITES.get('logo:' + slug, 'arrayBuffer');
  if (!bytes) { // a name with an online menu but no website: the logo comes with the menu
    const m = await publicMenu(env, slug);
    const b64 = m && typeof m.logo === 'string' && (m.logo.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/) || [])[1];
    if (b64) { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
    if (bytes && !(bytes[0] === 0x89 && bytes[1] === 0x50)) bytes = null;
    if (bytes) bytes = bytes.buffer;
  }
  if (!bytes) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  return new Response(method === 'HEAD' ? null : bytes, {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' },
  });
}

async function servePhoto(env, slug, id, method) {
  const bytes = await env.SITES.get(`photo:${slug}:${id}`, 'arrayBuffer');
  if (!bytes) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  return new Response(method === 'HEAD' ? null : bytes, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}

// ---------- the online menu ----------
// Built here from the owner's menu text (the same JSON the Menus form saves). Every piece of text is escaped, so
// nothing the owner types can become markup. Looks follow their menu: palette, heading font, layout.
async function publicMenu(env, slug) {
  try {
    const m = await rpc(env, 'public_menu', { p_slug: slug });
    return m && m.data && Array.isArray(m.data.sections) ? m : null;
  } catch { return null; }
}
const MENU_PALETTES = { // paper, ink, muted, accent (same as the Menus page)
  cream: ['#FBF8F2', '#221C18', '#6B5D52', '#8E3B24'], paper: ['#FFFFFF', '#141414', '#5A5A5A', '#141414'],
  sage: ['#F2F4EE', '#1E2A22', '#56645A', '#3D6B48'], harbor: ['#F4F3EF', '#18213A', '#5A6175', '#27467F'],
  terracotta: ['#FBF2EA', '#2B1A14', '#735A4E', '#A84A28'], blush: ['#FCF3F2', '#2A1D21', '#72595F', '#A8345A'],
  butter: ['#FBF5DF', '#2A2414', '#6B5F3E', '#8A5A00'], midnight: ['#141922', '#F2EEE6', '#ADA69A', '#E0AE4C'],
  forest: ['#14251C', '#F0ECE2', '#B5B2A3', '#E3B868'], charcoal: ['#1B1B1B', '#F3F3F3', '#A9A9A9', '#F0715A'],
};
// System fonts that keep each look's character (online pages load nothing from elsewhere).
const MENU_FONTS = {
  classic: ['"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif', '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif', 'uppercase', '.14em'],
  elegant: ['Georgia, "Times New Roman", serif', 'Didot, "Bodoni 72", Georgia, serif', 'none', '.01em'],
  modern: ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'uppercase', '.12em'],
  bold: ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', '"Arial Narrow", "Helvetica Neue Condensed", Impact, sans-serif', 'uppercase', '.04em'],
  warm: ['Georgia, "Times New Roman", serif', 'Georgia, "Times New Roman", serif', 'none', '0'],
};
const MENU_TAGS = { V: 'vegetarian', VG: 'vegan', GF: 'gluten-free', SP: 'spicy', N: 'contains nuts' };
function darkenForLight(hex) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = () => 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
  for (let i = 0; i < 20 && 0.99 / (L() + 0.05) < 4.5; i++) { r = Math.round(r * 0.85); g = Math.round(g * 0.85); b = Math.round(b * 0.85); }
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
const txt = (v, max) => esc(String(v == null ? '' : v).slice(0, max || 400).trim());
function menuPage(m) {
  const d = m.data;
  const colors = Array.isArray(m.colors) ? m.colors.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)) : [];
  const pal = d.palette === 'logo' && colors[0] ? ['#FBF8F2', '#221C18', '#6B5D52', darkenForLight(colors[0])] : (MENU_PALETTES[d.palette] || MENU_PALETTES.cream);
  const [body, head, tf, ls] = MENU_FONTS[d.font] || MENU_FONTS.classic;
  const center = d.layout !== 'left' && d.layout !== 'leaders';
  const cur = d.showCurrency !== false && typeof d.currency === 'string' ? d.currency.slice(0, 3) : '';
  const price = (a) => { a = String(a || '').trim().slice(0, 16); return a ? (cur && /^\d/.test(a) ? esc(cur) + esc(a) : esc(a)) : ''; };
  const extras = (ex) => {
    if (!ex || !Array.isArray(ex.list)) return '';
    const list = ex.list.filter((x) => x && String(x.name || '').trim()).slice(0, 10);
    if (!list.length) return '';
    return `<p class="x">${ex.lead && String(ex.lead).trim() ? `<em>${txt(ex.lead, 24)}</em> ` : ''}${list.map((x) => txt(x.name, 40) + (String(x.price || '').trim() ? ` <span class="xp">${price(x.price)}</span>` : '')).join(' · ')}</p>`;
  };
  const used = new Set();
  const sections = (d.sections || []).slice(0, 40).map((s) => {
    if (!s) return '';
    const set = s.kind === 'set';
    const items = (Array.isArray(s.items) ? s.items : []).filter((it) => it && String(it.name || '').trim()).slice(0, 120).map((it) => {
      const tags = (Array.isArray(it.tags) ? it.tags : []).filter((t) => MENU_TAGS[t]);
      tags.forEach((t) => used.add(t));
      const ps = set ? [] : (Array.isArray(it.prices) ? it.prices : []).filter((p) => p && String(p.amount || '').trim()).slice(0, 4);
      const pr = ps.map((p) => `${String(p.label || '').trim() ? `<small>${txt(p.label, 20)}</small> ` : ''}${price(p.amount)}`).join(' <span class="dot">·</span> ');
      return `<li class="it"><div class="row"><span class="nm">${txt(it.name, 60)}${tags.length ? ` <span class="tg">${tags.join(' · ')}</span>` : ''}</span>${pr ? `<span class="lead" aria-hidden="true"></span><span class="pr">${pr}</span>` : ''}</div>${String(it.desc || '').trim() ? `<p class="ds">${txt(it.desc, 160)}</p>` : ''}${extras(it.extras)}</li>`;
    }).join('');
    const name = String(s.name || '').trim();
    if (!items && !name) return '';
    const sp = set && String(s.price || '').trim() ? `<span class="pr">${price(s.price)}</span>` : '';
    return `<section class="sec${s.kind === 'specials' ? ' specials' : ''}${set ? ' set' : ''}">${name || sp ? `<h2><span>${txt(name, 40)}</span>${sp}</h2>` : ''}${String(s.note || '').trim() ? `<p class="nt">${txt(s.note, 100)}</p>` : ''}${items ? `<ul>${items}</ul>` : ''}${extras(s.extras)}</section>`;
  }).join('');
  const f = d.footer || {};
  const contact = [f.address, f.phone].map((x) => txt(x, 100)).filter(Boolean).join(' · ');
  const legend = Object.keys(MENU_TAGS).filter((k) => used.has(k)).map((k) => `${k} ${MENU_TAGS[k]}`).join(' · ');
  const title = txt(d.name, 60) || 'Menu';
  const logo = m.logo && d.showLogo !== false ? '<img class="logo" src="sogilex:logo" alt="' + title + ' logo">' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Menu</title><meta name="description" content="${title} menu${d.tagline ? ': ' + txt(d.tagline, 80) : ''}"><meta name="theme-color" content="${pal[0]}">
<style>
:root{--bg:${pal[0]};--ink:${pal[1]};--mu:${pal[2]};--ac:${pal[3]};--rule:color-mix(in srgb,var(--mu) 40%,var(--bg))}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.45 ${body}}
main{max-width:680px;margin:0 auto;padding:32px 20px 40px}
header{text-align:${center ? 'center' : 'left'};margin-bottom:28px}
.logo{display:block;max-height:72px;max-width:60%;width:auto;margin:${center ? '0 auto 14px' : '0 0 14px'}}
h1{margin:0;font:600 clamp(28px,8vw,40px)/1.1 ${head};text-transform:${tf};letter-spacing:${ls};overflow-wrap:anywhere}
.tl{margin:6px 0 0;color:var(--mu);font-style:italic}
.sec{margin:0 0 30px}
h2{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--rule);color:var(--ac);font:600 15px/1.2 ${head};text-transform:uppercase;letter-spacing:.16em}
.nt{margin:-4px 0 10px;color:var(--mu);font-style:italic;font-size:15px}
ul{list-style:none;margin:0;padding:0}
.it{padding:9px 0;border-bottom:1px dotted var(--rule)}
.it:last-child{border-bottom:0}
.row{display:flex;align-items:baseline;gap:8px}
.nm{font-weight:600;overflow-wrap:anywhere}
.tg{font-weight:400;font-size:11px;letter-spacing:.08em;color:var(--mu);white-space:nowrap}
.lead{flex:1;${d.layout === 'leaders' ? 'border-bottom:1.5px dotted var(--rule);transform:translateY(-.3em);' : ''}min-width:10px}
.pr{white-space:nowrap;font-variant-numeric:tabular-nums}.pr small{color:var(--mu);font-size:.8em}.dot{color:var(--mu)}
.ds{margin:2px 0 0;color:var(--mu);font-size:15px;font-style:italic}
.x{margin:4px 0 0;font-size:14px;color:var(--mu)}.x em{color:var(--ink)}
.specials{border:1.5px solid var(--ac);border-radius:10px;padding:14px 16px 6px}
.specials h2{border:0;justify-content:center;padding:0}
.set .it .row{justify-content:flex-start}
footer.mf{text-align:center;color:var(--mu);font-size:14px;border-top:1px solid var(--rule);padding-top:16px}
footer.mf p{margin:3px 0}
a{color:var(--ac)}
</style></head><body><main>
<header>${logo}<h1>${title}</h1>${d.showTagline !== false && String(d.tagline || '').trim() ? `<p class="tl">${txt(d.tagline, 80)}</p>` : ''}</header>
${sections || '<p>This menu is being updated. Please check back soon.</p>'}
${legend || contact || String(f.hours || '').trim() ? `<footer class="mf">${legend ? `<p>${legend}</p>` : ''}${String(f.hours || '').trim() ? `<p>${txt(f.hours, 100)}</p>` : ''}${contact ? `<p>${contact}</p>` : ''}</footer>` : ''}
</main></body></html>`;
}
async function serveMenu(env, slug, method) {
  const m = await publicMenu(env, slug);
  if (!m) return notFound();
  const html = await prepare(menuPage(m), slug, !!m.logo && m.data.showLogo !== false);
  return new Response(method === 'HEAD' ? null : html, { headers: { ...SITE_HEADERS, 'Cache-Control': 'public, max-age=60' } });
}

// ---------- making a generated page safe to host ----------
// Generated sites contain no scripts, but this runs anyway: it strips anything active, points forms at
// /__form, and adds the Sogilex footer. The Content-Security-Policy above is the second line of defence.
const ACTIVE = 'script, iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv], link';
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'srcset', 'poster', 'data']);

async function prepare(html, slug, hasLogo) {
  const footer = `<div style="all:initial;display:block;padding:14px 16px;text-align:center;font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;background:#120A18;color:#BBA9C2">Made with <a href="https://sogilex.com/" style="color:#FF9A4D">Sogilex</a> · <a href="mailto:hello@sogilex.com?subject=${encodeURIComponent('Report: ' + slug + '.' + ROOT)}" style="color:#BBA9C2">Report this site</a></div>`;
  const trap = '<div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true"><label>Leave this empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>';
  const rewriter = new HTMLRewriter()
    .on(ACTIVE, { element(el) { el.remove(); } })
    // The owner's logo: Build writes src="sogilex:logo"; it points at /logo.png (copied at publish), or goes away.
    .on('img', { element(el) {
      if (el.getAttribute('src') !== 'sogilex:logo') return;
      if (hasLogo) el.setAttribute('src', '/logo.png');
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
