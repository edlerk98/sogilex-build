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
// Publishing is checked by Supabase database functions using the person's own sign-in token, and the Supabase key
// here is the public (publishable) one. The one secret, FORM_SECRET, only proves contact forms came through here.
//
// Bindings: SITES (KV namespace), SUPABASE_URL, SUPABASE_KEY (publishable), FORM_SECRET (secret: contact forms, 027).

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
    if (url.pathname === '/menu-logo.png' && (req.method === 'GET' || req.method === 'HEAD')) return serveMenuLogo(env, slug, req.method);
    const mphoto = url.pathname.match(/^\/menu-photos\/([0-9a-f-]{36})\.jpg$/);
    if (mphoto && (req.method === 'GET' || req.method === 'HEAD')) return servePhoto(env, slug, mphoto[1], req.method, 'mphoto');
    const photo = url.pathname.match(/^\/photos\/([0-9a-f-]{36})\.jpg$/);
    if (photo && (req.method === 'GET' || req.method === 'HEAD')) return servePhoto(env, slug, photo[1], req.method);
    if (url.pathname === '/robots.txt') return new Response(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' } });
    if (url.pathname === '/sitemap.xml' && (req.method === 'GET' || req.method === 'HEAD')) return sitemap(env, slug, url, req.method);
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
      const args = { p_build_id: String(body.build_id || ''), p_slug: String(body.slug || '') };
      if (typeof body.preview === 'string' && body.preview) args.p_preview = body.preview.slice(0, 40);
      const result = await rpc(env, 'publish_site', args, token);
      // The link preview photo (025): a chosen photo is copied too, even if the page itself doesn't show it.
      const pick = typeof result.preview === 'string' && UUID.test(result.preview) ? result.preview : null;
      // A renamed site starts with no photos at its new name, so drop the old name's copies first.
      if (result.old_slug) { await env.SITES.delete('site:' + result.old_slug); await dropPhotos(env, result.old_slug, []); await env.SITES.delete('logo:' + result.old_slug); }
      const { html: withPhotos, kept, order, more } = await copyPhotos(env, token, result.slug, result.html, pick ? [pick] : []);
      const hasLogo = await copyLogo(env, result.slug, result.logo);
      const og = linkPreview(result.slug, result.preview, kept, order, hasLogo);
      og.hours = result.hours || null; // business hours (028): used for Google's data only when the page shows them
      og.logo = hasLogo;
      const html = await prepare(withPhotos, result.slug, hasLogo, og);
      await env.SITES.put('site:' + result.slug, html);
      return json({ slug: result.slug, url: `https://${result.slug}.${ROOT}/`, more: !!more });
    }
    if (url.pathname === '/menu-photos') return json(await copyMenuPhotos(env, token));
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
// A Worker on the free plan may make 50 outside requests per visit: publishing uses 2 (publish_site, site_photos) and one
// per photo it copies, so each publish copies at most 45 NEW photos. Photos already copied for this site are kept as
// they are (a photo's id never changes, so its file never does): a republish costs a few KV writes, not one per photo
// (on 2026-11-22 every republish of a 46-photo site re-copied 40 photos and used half the free daily KV writes). When
// more photos are waiting, publish answers more: true and Build simply calls publish again.
const MAX_NEW_PHOTOS = 45;

async function copyPhotos(env, token, slug, html, extra) {
  const order = [...new Set([...html.matchAll(PHOTO_TAG)].map((m) => m[1]))]; // the page's photos, first to last
  const want = [...new Set([...(extra || []), ...order])];
  let old = [];
  try { old = JSON.parse((await env.SITES.get('photos:' + slug)) || '[]'); } catch { /* none */ }
  const kept = want.filter((id) => old.includes(id));
  const need = want.filter((id) => !old.includes(id));
  const batch = need.slice(0, MAX_NEW_PHOTOS);
  if (batch.length) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/site_photos?select=id,user_id&id=in.(${batch.join(',')})`, {
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
  const more = need.length > batch.length;
  await dropPhotos(env, slug, kept);
  const same = kept.length === old.length && kept.every((id) => old.includes(id));
  if (kept.length && !same) await env.SITES.put('photos:' + slug, JSON.stringify(kept));
  return { html: html.replace(PHOTO_TAG, (_, id) => (kept.includes(id) ? `/photos/${id}.jpg` : BLANK_PNG)), kept, order, more };
}

// The picture for shared links: the chosen photo, the logo, or (automatic) the first photo on the page, else the
// logo. A chosen photo that couldn't be copied falls back to automatic. Absolute https addresses, as apps require.
function linkPreview(slug, choice, kept, order, hasLogo) {
  const base = `https://${slug}.${ROOT}`;
  const photo = (id) => ({ image: `${base}/photos/${id}.jpg`, large: true });
  const logo = hasLogo ? { image: `${base}/logo.png`, large: false } : null;
  if (typeof choice === 'string' && UUID.test(choice) && kept.includes(choice)) return { url: base + '/', ...photo(choice) };
  if (choice === 'logo' && logo) return { url: base + '/', ...logo };
  const first = order.find((id) => kept.includes(id));
  if (first) return { url: base + '/', ...photo(first) };
  return { url: base + '/', ...(logo || { image: null, large: false }) };
}

// The online menu's photos (a big one at the top, one per section). The menu text is saved straight to the database
// by the Menus page, so after each save that changes which photos it uses, the page asks for this copy with the
// owner's sign-in. Same rules as a site: only their own photos, kept in KV as "mphoto:<name>:<id>".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function copyMenuPhotos(env, token) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/online_menus?select=slug,data`, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) { const e = new Error('expired'); e.status = 401; throw e; }
  const rows = res.ok ? await res.json() : [];
  const row = rows[0];
  if (!row) return { slug: null, kept: [] };
  const d = row.data || {};
  const ids = [...new Set([d.hero, ...(Array.isArray(d.sections) ? d.sections.map((s) => s && s.photo) : [])]
    .filter((x) => typeof x === 'string' && UUID.test(x)))].slice(0, 20);
  let old = [];
  try { old = JSON.parse((await env.SITES.get('mphotos:' + row.slug)) || '[]'); } catch { /* none */ }
  const kept = ids.filter((id) => old.includes(id)); // already copied: a photo id's file never changes
  const need = ids.filter((id) => !old.includes(id));
  if (need.length) {
    const r2 = await fetch(`${env.SUPABASE_URL}/rest/v1/site_photos?select=id,user_id&id=in.(${need.join(',')})`, {
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    const photos = r2.ok ? await r2.json() : [];
    await Promise.all(photos.map(async (p) => {
      const file = await fetch(`${env.SUPABASE_URL}/storage/v1/object/authenticated/site-photos/${p.user_id}/${p.id}.jpg`, {
        headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` },
      });
      if (!file.ok) return;
      const bytes = await file.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 3 * 1024 * 1024) return;
      await env.SITES.put(`mphoto:${row.slug}:${p.id}`, bytes);
      kept.push(p.id);
    }));
  }
  await Promise.all(old.filter((id) => !kept.includes(id)).map((id) => env.SITES.delete(`mphoto:${row.slug}:${id}`)));
  if (!(kept.length === old.length && kept.every((id) => old.includes(id)))) await env.SITES.put('mphotos:' + row.slug, JSON.stringify(kept));
  return { slug: row.slug, kept };
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
  const now = await env.SITES.get('logo:' + slug, 'arrayBuffer');
  if (now && now.byteLength === bytes.length && new Uint8Array(now).every((v, k) => v === bytes[k])) return true; // unchanged: no write
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

async function servePhoto(env, slug, id, method, prefix) {
  const bytes = await env.SITES.get(`${prefix || 'photo'}:${slug}:${id}`, 'arrayBuffer');
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
  tavern: ['#F6EFE2', '#2A1A14', '#6B5446', '#8A1F24'], mustard: ['#1C1A17', '#F4EFE6', '#B8B0A2', '#F2B705'],
  ketchup: ['#FFF8EE', '#2A1712', '#6E5248', '#C8281E'],
};
// System fonts that keep each look's character (online pages load nothing from elsewhere).
const MENU_FONTS = {
  classic: ['"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif', '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif', 'uppercase', '.14em'],
  elegant: ['Georgia, "Times New Roman", serif', 'Didot, "Bodoni 72", Georgia, serif', 'none', '.01em'],
  modern: ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'uppercase', '.12em'],
  bold: ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', '"Arial Narrow", "Helvetica Neue Condensed", Impact, sans-serif', 'uppercase', '.04em'],
  warm: ['Georgia, "Times New Roman", serif', 'Georgia, "Times New Roman", serif', 'none', '0'],
  heavy: ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'Impact, "Arial Narrow Bold", "Helvetica Neue Condensed", sans-serif', 'uppercase', '.02em'],
  slab: ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'Rockwell, "Roboto Slab", "Courier New", serif', 'none', '0'],
  western: ['Georgia, "Times New Roman", serif', 'Rockwell, Georgia, serif', 'uppercase', '.06em'],
  script: ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive', 'none', '0'],
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
function menuPage(m, photos) {
  const d = m.data;
  // Only photos that were copied for this menu are shown; the id is checked against that list, never trusted.
  const pic = (id, cls, alt) => (typeof id === 'string' && photos && photos.has(id) ? `<img class="${cls}" src="/menu-photos/${id}.jpg" alt="${alt}" loading="lazy">` : '');
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
    return `<p class="x">${ex.lead && String(ex.lead).trim() ? `<em>${txt(ex.lead, 40)}</em> ` : ''}${list.map((x) => txt(x.name, 60) + (String(x.price || '').trim() ? ` <span class="xp">${price(x.price)}</span>` : '')).join(' · ')}</p>`;
  };
  const used = new Set();
  const sections = (d.sections || []).slice(0, 40).map((s) => {
    if (!s) return '';
    const set = s.kind === 'set';
    const items = (Array.isArray(s.items) ? s.items : []).filter((it) => it && String(it.name || '').trim()).slice(0, 120).map((it) => {
      const tags = (Array.isArray(it.tags) ? it.tags : []).filter((t) => MENU_TAGS[t]);
      tags.forEach((t) => used.add(t));
      const ps = set ? [] : (Array.isArray(it.prices) ? it.prices : []).filter((p) => p && String(p.amount || '').trim()).slice(0, 4);
      const pr = ps.map((p) => `${String(p.label || '').trim() ? `<small>${txt(p.label, 40)}</small> ` : ''}${price(p.amount)}`).join(' <span class="dot">·</span> ');
      return `<li class="it"><div class="row"><span class="nm">${txt(it.name, 80)}${tags.length ? ` <span class="tg">${tags.join(' · ')}</span>` : ''}</span>${pr ? `<span class="lead" aria-hidden="true"></span><span class="pr">${pr}</span>` : ''}</div>${String(it.desc || '').trim() ? `<p class="ds">${txt(it.desc, 300)}</p>` : ''}${extras(it.extras)}</li>`;
    }).join('');
    const name = String(s.name || '').trim();
    if (!items && !name) return '';
    const sp = set && String(s.price || '').trim() ? `<span class="pr">${price(s.price)}</span>` : '';
    return `<section class="sec${s.kind === 'specials' ? ' specials' : ''}${set ? ' set' : ''}">${name || sp ? `<h2><span>${txt(name, 60)}</span>${sp}</h2>` : ''}${pic(s.photo, 'sp', txt(name, 60))}${String(s.note || '').trim() ? `<p class="nt">${txt(s.note, 300)}</p>` : ''}${items ? `<ul>${items}</ul>` : ''}${extras(s.extras)}</section>`;
  }).join('');
  const f = d.footer || {};
  const contact = [f.address, f.phone].map((x) => txt(x, 200)).filter(Boolean).join(' · ');
  const legend = Object.keys(MENU_TAGS).filter((k) => used.has(k)).map((k) => `${k} ${MENU_TAGS[k]}`).join(' · ');
  const title = txt(d.name, 60) || 'Menu';
  // The menu's own logo file: it can differ from the website's (/logo.png) when the owner chose one for the menu only.
  const logo = m.logo && d.showLogo !== false ? '<img class="logo" src="/menu-logo.png" alt="' + title + ' logo">' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Menu</title><meta name="description" content="${title} menu${d.tagline ? ': ' + txt(d.tagline, 100) : ''}"><meta name="theme-color" content="${pal[0]}">
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
.hero{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:14px;margin:18px 0 0}
.sp{display:block;width:100%;aspect-ratio:2/1;object-fit:cover;border-radius:10px;margin:0 0 12px}
</style></head><body><main>
<header>${logo}<h1>${title}</h1>${d.showTagline !== false && String(d.tagline || '').trim() ? `<p class="tl">${txt(d.tagline, 100)}</p>` : ''}${pic(d.hero, 'hero', 'Food at ' + title)}</header>
${sections || '<p>This menu is being updated. Please check back soon.</p>'}
${legend || contact || String(f.hours || '').trim() ? `<footer class="mf">${legend ? `<p>${legend}</p>` : ''}${String(f.hours || '').trim() ? `<p>${txt(f.hours, 160)}</p>` : ''}${contact ? `<p>${contact}</p>` : ''}</footer>` : ''}
</main></body></html>`;
}
async function serveMenuLogo(env, slug, method) {
  const m = await publicMenu(env, slug);
  const b64 = m && typeof m.logo === 'string' && (m.logo.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/) || [])[1];
  let bytes = null;
  if (b64) { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
  if (!bytes || bytes[0] !== 0x89 || bytes[1] !== 0x50) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  return new Response(method === 'HEAD' ? null : bytes, {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Strict-Transport-Security': 'max-age=31536000' },
  });
}
async function serveMenu(env, slug, method) {
  const m = await publicMenu(env, slug);
  if (!m) return notFound();
  let photos = new Set();
  try { photos = new Set(JSON.parse((await env.SITES.get('mphotos:' + slug)) || '[]')); } catch { /* none */ }
  const html = await prepare(menuPage(m, photos), slug, false);
  return new Response(method === 'HEAD' ? null : html, { headers: { ...SITE_HEADERS, 'Cache-Control': 'public, max-age=60' } });
}

// ---------- making a generated page safe to host ----------
// Generated sites contain no scripts, but this runs anyway: it strips anything active, points forms at
// /__form, and adds the Sogilex footer. The Content-Security-Policy above is the second line of defence.
const ACTIVE = 'script, iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv], link';
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'srcset', 'poster', 'data']);

// Shared-link tags (Open Graph + Twitter/X card). Any the generated page wrote itself are replaced by these.
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') { const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k] || m;
  });
}
function ogTags(og, title, desc) {
  const t = decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 120);
  const d = decodeEntities(desc).replace(/\s+/g, ' ').trim().slice(0, 300);
  const m = (attr, key, val) => `<meta ${attr}="${key}" content="${esc(val)}">`;
  return [
    m('property', 'og:type', 'website'), m('property', 'og:url', og.url),
    t ? m('property', 'og:title', t) : '', d ? m('property', 'og:description', d) : '',
    og.image ? m('property', 'og:image', og.image) : '', og.image && t ? m('property', 'og:image:alt', t) : '',
    m('name', 'twitter:card', og.image && og.large ? 'summary_large_image' : 'summary'),
  ].filter(Boolean).join('');
}

// ---------- showing up on Google (2026-11-24) ----------
// Published pages get: a canonical address, a sitemap (/sitemap.xml, listed in robots.txt) and schema.org data
// (JSON-LD) built only from facts the page itself shows, so Google never reads something a visitor can't see:
//   WebSite        the business name (from the page title, before " | ") and address, always;
//   LocalBusiness  added when the page has a real phone link or shows the owner's saved business hours.
// Hours come from business_hours (publish_site returns them, 028), but are used only if every time in them
// appears on the page: a site built before the hours changed keeps showing old hours, and Google must not get new ones.
// Anything still holding a [PLACEHOLDER] is left out. JSON-LD is a data block, not a script: the CSP doesn't apply.
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_SCHEMA = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// The same wording build-site uses for hours on the page ("9 AM", "11:30 AM", "noon", "midnight").
function clock(t) {
  const [h, m] = t.split(':').map(Number);
  if (h === 12 && m === 0) return 'noon';
  if (h === 0 && m === 0) return 'midnight';
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}
// Page text squeezed for comparing times: "9 AM", "9am", "9 a.m." and "9:00 AM" all become "9am".
function squeezeTimes(s) {
  return s.toLowerCase().replace(/\s+/g, '').replace(/a\.m\.?/g, 'am').replace(/p\.m\.?/g, 'pm').replace(/(\d):00(?=[ap]m)/g, '$1');
}
function openingHours(hours, pageText) {
  const days = hours && typeof hours === 'object' && hours.days && typeof hours.days === 'object' ? hours.days : null;
  if (!days) return null;
  const text = squeezeTimes(pageText);
  const specs = [];
  for (const k of DAY_KEYS) {
    const d = days[k];
    if (d === undefined) continue;
    if (d === 'closed') continue; // a day with no opening hours is how schema.org says closed
    if (!Array.isArray(d)) return null;
    for (const r of d) {
      if (!Array.isArray(r) || !HHMM.test(r[0]) || !HHMM.test(r[1])) return null;
      if (!text.includes(squeezeTimes(clock(r[0]))) || !text.includes(squeezeTimes(clock(r[1])))) return null;
      specs.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: DAY_SCHEMA[k], opens: r[0], closes: r[1] });
    }
  }
  return specs.length ? specs : null;
}
// First pass over the page: what it says about itself.
async function inspect(html) {
  const info = { title: '', desc: '', h1: '', tels: [], text: '' };
  let skip = 0; let inH1 = false;
  await new HTMLRewriter()
    .on('title', { text(t) { if (info.title.length < 400) info.title += t.text; } })
    .on('meta', { element(el) { if ((el.getAttribute('name') || '').toLowerCase() === 'description' && !info.desc) info.desc = el.getAttribute('content') || ''; } })
    .on('a[href^="tel:"]', { element(el) { if (info.tels.length < 10) info.tels.push(el.getAttribute('href').slice(4)); } })
    .on('style, script, template, noscript', { element(el) { skip++; el.onEndTag(() => { skip--; }); } })
    .on('h1', { element(el) { if (!info.h1) { inH1 = true; el.onEndTag(() => { inH1 = false; }); } } })
    .on('body *', { text(t) {
      if (skip) return;
      if (inH1 && info.h1.length < 200) info.h1 += t.text;
      if (info.text.length < 100000) info.text += t.text + (t.lastInTextNode ? ' ' : '');
    } })
    .transform(new Response(html, { headers: { 'Content-Type': 'text/html' } })).text();
  return info;
}
const clean = (s, max) => decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, max);
const hasBlank = (s) => /\[[^\]]{2,}\]/.test(s);
function phone(tels) {
  for (const raw of tels) {
    const t = decodeURIComponent(raw).replace(/[\s().-]/g, '');
    if (!/^\+?\d{7,15}$/.test(t)) continue; // "[PHONE NUMBER]" and junk are skipped
    if (/^\d{10}$/.test(t)) return '+1' + t; // a US number written without the country code
    if (/^1\d{10}$/.test(t)) return '+' + t;
    return t;
  }
  return null;
}
function structuredData(info, slug, og) {
  const url = `https://${slug}.${ROOT}/`;
  const title = clean(info.title, 200);
  let name = title.split(/\s+[|·•–—-]\s+/)[0].trim();
  if (!name || name.length > 80) name = clean(info.h1, 80);
  if (!name || hasBlank(name)) return [];
  const desc = clean(info.desc, 300);
  const out = [{ '@context': 'https://schema.org', '@type': 'WebSite', name, url }];
  const tel = phone(info.tels);
  const hours = openingHours(og.hours, info.text);
  if (tel || hours) {
    const b = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name, url };
    if (desc && !hasBlank(desc)) b.description = desc;
    if (og.logo) b.logo = url + 'logo.png';
    if (og.image) b.image = og.image;
    if (tel) b.telephone = tel;
    if (hours) b.openingHoursSpecification = hours;
    out.push(b);
  }
  return out;
}
// A JSON-LD block that can't end its own element early: <, > and & are written as \u escapes.
function jsonLd(obj) {
  const j = JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<script type="application/ld+json">${j}</script>`;
}
async function sitemap(env, slug, url, method) {
  const pages = [];
  if (await env.SITES.get('site:' + slug)) pages.push(url.origin + '/');
  if (await publicMenu(env, slug)) pages.push(url.origin + '/menu');
  if (!pages.length) return notFound();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${esc(p)}</loc></url>`).join('\n')}\n</urlset>\n`;
  return new Response(method === 'HEAD' ? null : xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
}

async function prepare(html, slug, hasLogo, og) {
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
  if (og) {
    const info = await inspect(html);
    const seo = `<link rel="canonical" href="${esc(og.url)}">` + structuredData(info, slug, og).map(jsonLd).join('');
    let title = ''; let desc = ''; let added = false;
    rewriter
      .on('meta', { element(el) {
        const key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
        if (key.startsWith('og:') || key.startsWith('twitter:')) el.remove();
        else if (key === 'description' && !desc) desc = el.getAttribute('content') || '';
      } })
      .on('title', { text(t) { if (title.length < 400) title += t.text; } })
      .on('head', { element(el) { el.onEndTag((end) => { added = true; end.before(ogTags(og, title, desc) + seo, { html: true }); }); } })
      // A page without a <head> (shouldn't happen): put the tags at the start of the body instead.
      .on('body', { element(el) { if (!added) { added = true; el.prepend(ogTags(og, title, desc) + seo, { html: true }); } } });
  }
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
    // FORM_SECRET (a Cloudflare secret) proves the message came through this Worker, not a direct call (027).
    const args = { p_slug: slug, p_fields: fields, p_ip_hash: ipHash };
    if (env.FORM_SECRET) args.p_secret = env.FORM_SECRET;
    const ok = await rpc(env, 'submit_site_message', args);
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
