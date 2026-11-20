// Sogilex Menus (milestone 1+): a form for the menu, a live print preview that fits itself to one page or flows onto
// a second (front and back), and autosave to the person's Sogilex account. No AI: every word and price on the menu is
// exactly what was typed. Section kinds: regular, specials box, set price (prix fixe / tasting). Add-ons per dish or
// per section ("Add bacon +2", "Choice of fries or salad"). Restaurant-type starters set sections and a look, never dishes.
(() => {
  const SUPABASE_URL = 'https://sdltqbctuieyjlujsdhj.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM'; // public by design; RLS protects data
  const $ = (id) => document.getElementById(id);
  const db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: window.SogilexAuth ? window.SogilexAuth.clientOptions() : { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  async function session() { try { const { data } = await within(db.auth.getSession(), 10000); return data.session; } catch { return null; } }

  const TAGS = [['V', 'vegetarian'], ['VG', 'vegan'], ['GF', 'gluten-free'], ['SP', 'spicy'], ['N', 'contains nuts']];
  const blankItem = (labels) => ({ name: '', desc: '', prices: (labels || ['']).map((label) => ({ label, amount: '' })), tags: [], extras: null });
  const blankSection = (name, kind, extrasLead, labels) => ({
    name: name || '', note: '', kind: kind || 'normal', price: '', items: [blankItem(labels)],
    extras: extrasLead ? { lead: extrasLead, list: [{ name: '', price: '' }] } : null,
  });
  const blankMenu = () => ({
    v: 1, name: '', tagline: '', showTagline: true, currency: '$', showCurrency: true, paper: 'letter', pages: 1, showLogo: true,
    font: 'classic', palette: 'cream', layout: 'centered', border: 'none',
    sections: [blankSection()], footer: { address: '', phone: '', hours: '', website: '' },
    qr: { url: '', label: '' },
  });

  // Curated looks: every combination is designed to work, and every palette passes WCAG AA (checked).
  const FONTS = [
    ['classic', 'Classic', "'EB Garamond', Georgia, serif"],
    ['elegant', 'Elegant', "'Playfair Display', Georgia, serif"],
    ['modern', 'Modern', "Inter, system-ui, sans-serif"],
    ['bold', 'Bold', "'Bebas Neue', Impact, sans-serif"],
    ['warm', 'Warm', "Fraunces, Georgia, serif"],
    // Display lettering for the name and headings; dishes stay in an easy-to-read body font.
    ['heavy', 'Heavy', "Anton, Impact, sans-serif"],
    ['slab', 'Slab', "'Alfa Slab One', Rockwell, serif"],
    ['western', 'Western', "Rye, Georgia, serif"],
    ['script', 'Script', "Lobster, 'Brush Script MT', cursive"],
  ];
  const PALETTES = [ // [id, name, paper, ink, muted, accent]
    ['cream', 'Cream', '#FBF8F2', '#221C18', '#6B5D52', '#8E3B24'],
    ['tavern', 'Tavern', '#F6EFE2', '#2A1A14', '#6B5446', '#8A1F24'],
    ['paper', 'Black & white', '#FFFFFF', '#141414', '#5A5A5A', '#141414'],
    ['sage', 'Sage', '#F2F4EE', '#1E2A22', '#56645A', '#3D6B48'],
    ['harbor', 'Harbor', '#F4F3EF', '#18213A', '#5A6175', '#27467F'],
    ['terracotta', 'Terracotta', '#FBF2EA', '#2B1A14', '#735A4E', '#A84A28'],
    ['blush', 'Blush', '#FCF3F2', '#2A1D21', '#72595F', '#A8345A'],
    ['butter', 'Butter', '#FBF5DF', '#2A2414', '#6B5F3E', '#8A5A00'],
    ['midnight', 'Midnight', '#141922', '#F2EEE6', '#ADA69A', '#E0AE4C'],
    ['forest', 'Forest', '#14251C', '#F0ECE2', '#B5B2A3', '#E3B868'],
    ['charcoal', 'Charcoal', '#1B1B1B', '#F3F3F3', '#A9A9A9', '#F0715A'],
    ['mustard', 'Mustard', '#1C1A17', '#F4EFE6', '#B8B0A2', '#F2B705'],
    ['ketchup', 'Ketchup', '#FFF8EE', '#2A1712', '#6E5248', '#C8281E'],
  ];
  const LAYOUTS = [['centered', 'Centered'], ['left', 'Left-aligned'], ['leaders', 'Dotted lines'], ['banner', 'Colour bands'], ['bold', 'Bold']];
  // Ready-made looks: one click sets fonts, colours, layout and border together.
  const LOOKS = [
    ['Bold grill', { font: 'heavy', palette: 'ketchup', layout: 'bold', border: 'none' }],
    ['Night market', { font: 'heavy', palette: 'mustard', layout: 'bold', border: 'none' }],
    ['Saloon', { font: 'western', palette: 'tavern', layout: 'bold', border: 'none' }],
    ['Retro diner', { font: 'slab', palette: 'harbor', layout: 'bold', border: 'none' }],
    ['Sweet shop', { font: 'script', palette: 'blush', layout: 'bold', border: 'none' }],
    ['Tavern', { font: 'elegant', palette: 'tavern', layout: 'banner', border: 'double' }],
    ['Sports bar', { font: 'bold', palette: 'charcoal', layout: 'banner', border: 'none' }],
    ['Bistro', { font: 'classic', palette: 'cream', layout: 'leaders', border: 'thin' }],
    ['Diner', { font: 'bold', palette: 'harbor', layout: 'banner', border: 'thin' }],
    ['Café', { font: 'warm', palette: 'butter', layout: 'centered', border: 'none' }],
    ['Clean modern', { font: 'modern', palette: 'paper', layout: 'left', border: 'none' }],
  ];
  const BORDERS = [['none', 'No border'], ['thin', 'Thin frame'], ['double', 'Double frame']];
  const KINDS = [['normal', 'Regular section'], ['specials', 'Specials box'], ['set', 'Set price (prix fixe, tasting)']];
  // Starters: section headings and a look for a type of restaurant. Never dishes or prices (those are the owner's facts).
  const STARTERS = [
    ['grill', 'Bar & grill', { font: 'bold', palette: 'charcoal', layout: 'left', border: 'none', pages: 2, showCurrency: true },
      [['Specials', 'specials'], ['Starters'], ['Wings'], ['Burgers', 'normal', 'Add'], ['Sandwiches'], ['Salads'], ['Sides'], ['Drinks']]],
    ['fine', 'Fine dining', { font: 'elegant', palette: 'cream', layout: 'centered', border: 'thin', pages: 1, showCurrency: false },
      [['Tasting menu', 'set'], ['To begin'], ['Mains'], ['Dessert']]],
    ['cafe', 'Café & bakery', { font: 'warm', palette: 'butter', layout: 'centered', border: 'none', pages: 1, showCurrency: true },
      [['Coffee', 'normal', '', ['Small', 'Large']], ['Tea'], ['Breakfast'], ['Pastries'], ['Lunch']]],
    ['pizza', 'Pizzeria', { font: 'bold', palette: 'terracotta', layout: 'left', border: 'none', pages: 2, showCurrency: true },
      [['Specials', 'specials'], ['Pizzas', 'normal', 'Toppings', ['Small', 'Large']], ['Starters'], ['Salads'], ['Desserts'], ['Drinks']]],
    ['taqueria', 'Taqueria & food truck', { font: 'modern', palette: 'sage', layout: 'left', border: 'none', pages: 1, showCurrency: true },
      [['Tacos', 'normal', 'Add'], ['Burritos'], ['Plates'], ['Sides'], ['Drinks']]],
  ];
  // Fill in anything an older saved menu doesn't have, and keep the shapes right.
  function normalize(m) {
    const ex = (e) => (e && Array.isArray(e.list) ? { lead: String(e.lead || ''), list: e.list.map((x) => ({ name: String(x.name || ''), price: String(x.price || '') })) } : null);
    m.pages = m.pages === 2 ? 2 : 1;
    m.qr = { url: String((m.qr && m.qr.url) || ''), label: String((m.qr && m.qr.label) || '') };
    m.hero = typeof m.hero === 'string' && m.hero ? m.hero : null;
    m.sections = (m.sections || []).map((sec) => ({
      name: '', note: '', price: '', ...sec, feature: !!sec.feature, photo: typeof sec.photo === 'string' && sec.photo ? sec.photo : null,
      kind: KINDS.some(([k]) => k === sec.kind) ? sec.kind : 'normal',
      extras: ex(sec.extras),
      items: (sec.items || []).map((it) => ({ name: '', desc: '', tags: [], ...it, prices: it.prices && it.prices.length ? it.prices : [{ label: '', amount: '' }], extras: ex(it.extras) })),
    }));
    return m;
  }
  // The menu's logo: its own if the owner chose one for the menu only, otherwise the account's (shared with the website).
  const menuLogo = () => (kit.menu_logo
    ? { logo: kit.menu_logo, name: kit.menu_logo_name, colors: kit.menu_colors || [], own: true }
    : { logo: kit.logo, name: kit.logo_name, colors: kit.colors || [], own: false });
  async function saveMenuLogo(next) {
    const { error } = await db.from('brand_kits').upsert({ user_id: uid, menu_logo: next.menu_logo, menu_logo_name: next.menu_logo_name, menu_colors: next.menu_colors || [], updated_at: new Date().toISOString() }).abortSignal(AbortSignal.timeout(15000));
    if (error) throw error;
    kit = { ...kit, ...next };
  }
  function menuLogoBox() {
    const ml = menuLogo();
    const status = h('p', { class: 'mhint mread-status', role: 'status', 'aria-live': 'polite' });
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,.pdf', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files[0]; input.value = '';
      if (!file) return;
      status.textContent = 'Adding the menu logo…'; status.classList.remove('err');
      try {
        const k = await SogilexBrand.fileToKit(file);
        await saveMenuLogo({ menu_logo: k.logo, menu_logo_name: k.logo_name, menu_colors: k.colors });
        menu.showLogo = true; changed(true);
      } catch (e) { status.textContent = (e && e.message) || "Couldn't add that logo."; status.classList.add('err'); }
    });
    if (ml.own) {
      return h('div', { class: 'mlogo-own' },
        h('div', { class: 'logo-have' },
          h('div', { class: 'logo-thumb' }, h('img', { src: ml.logo, alt: 'Menu logo' })),
          h('div', { class: 'logo-meta' },
            h('span', { class: 'logo-name', text: ml.name || 'Menu logo' }),
            h('span', { class: 'mhint', text: 'Used on this menu only. Your website keeps its own logo.' }),
            h('span', { class: 'logo-actions' },
              h('button', { type: 'button', class: 'linkish', text: 'Replace', onclick: () => input.click() }),
              h('button', { type: 'button', class: 'linkish', text: kit.logo ? 'Use my shared logo instead' : 'Remove', onclick: async () => {
                try { await saveMenuLogo({ menu_logo: null, menu_logo_name: null, menu_colors: [] }); if (menu.palette === 'logo' && !(kit.colors && kit.colors[0])) menu.palette = 'cream'; changed(true); }
                catch { status.textContent = "Couldn't change it. Try again."; status.classList.add('err'); }
              } })))),
        input, status);
    }
    const shared = h('div');
    if (uid && window.SogilexBrand) SogilexBrand.mountLogo(shared, { db, uid, kit, onChange: (k) => { kit = { ...kit, ...k }; renderEditor(); renderPreview(); } });
    return h('div', {},
      shared,
      h('p', { class: 'mhint', text: kit.logo ? 'This logo is shared with your website: changing it here changes it there too.' : 'A logo added here is also used on your website. You can choose a different one for the menu afterwards.' }),
      kit.logo ? h('button', { type: 'button', class: 'iconbtn', text: 'Use a different logo for this menu', onclick: () => input.click() }) : null,
      input, status);
  }
  // White or ink on the accent colour, whichever reads better (for the colour bands).
  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const onAccent = (accent, ink, bg) => ['#FFFFFF', '#141414', bg, ink].sort((p, q) => contrast(q, accent) - contrast(p, accent))[0];
  function paletteOf(id) {
    if (id === 'logo' && menuLogo().colors[0]) return ['logo', 'My logo', '#FBF8F2', '#221C18', '#6B5D52', SogilexBrand.readableOnLight(menuLogo().colors[0])];
    return PALETTES.find((p) => p[0] === id) || PALETTES[0];
  }

  let menu = blankMenu();
  let uid = null;
  let kit = { logo: null, logo_name: null, colors: [] };

  // ---------- food photos (the same private library as Build's "Your photos") ----------
  let photos = []; let photoBox = null; let photoBoxEl = null;
  const photoUrl = (id) => (photoBox && photoBox.links[id]) || null;
  const photoName = (id) => { const p = photos.find((x) => x.id === id); return p ? (p.name || '').trim() : ''; };
  function photoSelect(obj, key, id) {
    const sel = h('select', { class: 'mselect m-photo-sel', id, onchange: (e) => { obj[key] = e.target.value || null; changed(); } });
    const fill = () => {
      sel.replaceChildren(h('option', { value: '', text: 'None' }),
        ...photos.map((p, i) => h('option', { value: p.id, selected: obj[key] === p.id ? true : null, text: p.name.trim() || `Photo ${i + 1}` })));
    };
    sel._fill = fill; fill();
    return sel;
  }
  function startPhotos() {
    if (!window.SogilexPhotos || photoBoxEl) return;
    photoBoxEl = h('div', { class: 'm-photos' });
    photoBox = SogilexPhotos.mount(photoBoxEl, {
      db, uid,
      onChange: (list) => {
        const had = photos.length;
        photos = list;
        // A photo that was removed comes off the menu too.
        const ids = new Set(list.map((p) => p.id));
        if (menu.hero && !ids.has(menu.hero)) menu.hero = null;
        menu.sections.forEach((s) => { if (s.photo && !ids.has(s.photo)) s.photo = null; });
        if (!had && list.length) renderEditor(); // first photos: the section pickers appear
        else document.querySelectorAll('.m-photo-sel').forEach((s) => s._fill && s._fill());
        clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 120);
      },
    });
  }

  // ---------- small DOM helper ----------
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }
  // A text input bound to obj[key]: typing updates the menu without rebuilding the form (so focus stays put).
  function field(obj, key, attrs) {
    const n = h('input', { class: 'input', type: 'text', value: obj[key] || '', ...attrs, oninput: (e) => { obj[key] = e.target.value; changed(); } });
    // A price read from a photo stays highlighted until the owner has looked at it (clicked or tabbed into it).
    if (obj.chk && (key === 'amount' || key === 'price')) {
      n.classList.add('unchecked');
      n.title = 'Read from your photo: check it against your menu';
      n.addEventListener('focus', () => { delete obj.chk; n.classList.remove('unchecked'); n.removeAttribute('title'); changed(); updateCheck(); }, { once: true });
    }
    return n;
  }

  // ---------- the online menu (https://<name>.sogilex.net/menu) ----------
  // Closed beta like website publishing. Once it's online, every save updates it too, unless a price read from a
  // photo is still unchecked (those never go online).
  let online = { can_publish: false, slug: null, site_slug: null };
  const menuUrl = (slug) => `https://${slug}.sogilex.net/menu`;
  const slugify = (v) => (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 32);
  async function loadOnline() {
    try {
      const { data, error } = await db.rpc('my_online_menu').abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      online = data || online;
    } catch { /* stays hidden */ }
  }
  function onlineSay(text, err) {
    const el = $('m-online-status');
    if (el) { el.textContent = text; el.classList.toggle('err', !!err); }
  }
  async function publishOnline(slug) {
    if (uncheckedCount()) { onlineSay('Not updated yet: check the highlighted prices first. Prices read from a photo never go online unchecked.', true); return false; }
    try {
      const { data, error } = await db.rpc('publish_menu', { p_slug: slug || '', p_data: menu }).abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      online.slug = data.slug;
      onlineSay(`Up to date. Changes show online within a minute.`);
      syncOnlinePhotos();
      return true;
    } catch (e) { onlineSay((e && e.message) || "Couldn't update the online menu. Check your connection.", true); return false; }
  }
  // The online menu's photos are copied by the publishing service (api.sogilex.net) with the owner's sign-in.
  // Only when the photos used change (or the name does), so ordinary price edits don't copy anything.
  let syncedPhotos = null;
  async function syncOnlinePhotos() {
    const key = online.slug + '|' + [menu.hero, ...menu.sections.map((s) => s.photo)].filter(Boolean).join(',');
    if (key === syncedPhotos) return;
    try {
      const s = await session();
      if (!s) return;
      const res = await fetch('https://api.sogilex.net/menu-photos', {
        method: 'POST', headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) syncedPhotos = key;
    } catch { /* tried again on the next save */ }
  }
  function onlineGroup() {
    if (!online.can_publish) return null;
    const status = h('p', { class: 'mhint mread-status', id: 'm-online-status', role: 'status', 'aria-live': 'polite' });
    if (!online.slug) {
      const slugIn = h('input', { class: 'input', type: 'text', value: online.site_slug || slugify(menu.name) || '', maxlength: '32', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Web address name', placeholder: 'your-restaurant' });
      slugIn.addEventListener('input', () => { const v = slugify(slugIn.value); if (v !== slugIn.value) slugIn.value = v; });
      return h('div', { class: 'mgroup' },
        h('h3', { text: 'Online menu' }),
        h('p', { class: 'mhint', text: 'Put this menu on its own web page, made for phones. It updates by itself whenever you change your menu, so your QR code always shows today\'s prices.' }),
        h('div', { class: 'mrow' }, slugIn, h('span', { class: 'mini', text: '.sogilex.net/menu' })),
        h('button', { type: 'button', class: 'btn mread-btn', text: 'Put my menu online', onclick: async (e) => {
          const v = slugify(slugIn.value);
          if (v.length < 3) { onlineSay('Choose a name of at least 3 letters or numbers.', true); return; }
          e.target.disabled = true;
          if (await publishOnline(v)) changed(true); else e.target.disabled = false;
        } }),
        status);
    }
    const url = menuUrl(online.slug);
    return h('div', { class: 'mgroup' },
      h('h3', { text: 'Online menu' }),
      h('p', { class: 'mhint' }, 'Live at ', h('a', { href: url, target: '_blank', rel: 'noopener', class: 'qr-test', text: url.replace('https://', '') + ' ↗' }), '. It updates by itself when you change your menu.'),
      h('div', { class: 'mrow' },
        menu.qr.url === url ? h('span', { class: 'mini', text: '✓ Your QR code opens this menu' })
          : h('button', { type: 'button', class: 'iconbtn', text: 'Use it for my QR code', onclick: () => { menu.qr.url = url; if (!menu.qr.label.trim()) menu.qr.label = 'Scan for our menu'; changed(true); } }),
        h('button', { type: 'button', class: 'iconbtn danger', text: 'Take it offline', onclick: async () => {
          if (!confirm(`Take ${url.replace('https://', '')} offline? Any QR codes already printed will stop working until you put it back online.`)) return;
          try { const { error } = await db.rpc('unpublish_menu'); if (error) throw error; online.slug = null; changed(true); }
          catch { onlineSay("Couldn't take it offline. Try again.", true); }
        } })),
      status);
  }

  // ---------- read a menu from photos ----------
  const READ_URL = `${SUPABASE_URL}/functions/v1/read-menu`;
  let unsure = [];
  // Every price-holding object (item price, add-on, set price), for counting and clearing the "check me" marks.
  function priceHolders() {
    const out = [];
    for (const sec of menu.sections) {
      if (sec.kind === 'set') out.push(sec);
      if (sec.extras) out.push(...sec.extras.list);
      for (const it of sec.items) { out.push(...it.prices); if (it.extras) out.push(...it.extras.list); }
    }
    return out;
  }
  const uncheckedCount = () => priceHolders().filter((o) => o.chk).length;
  function checkBanner() {
    const n = uncheckedCount();
    if (!n && !unsure.length) return null;
    return h('div', { class: 'mcheck', id: 'm-check', role: 'status' },
      n ? h('p', {}, h('strong', { text: `Check ${n} ${n === 1 ? 'price' : 'prices'} against your menu.` }), ' They were read from your photo and are highlighted below. Click each one to mark it checked.') : null,
      unsure.length ? h('p', {}, h('strong', { text: "Couldn't read clearly: " }), unsure.join(' · ')) : null,
      h('div', { class: 'mrow' },
        n ? h('button', { type: 'button', class: 'iconbtn', text: "I've checked every price", onclick: () => {
          if (!confirm(`Mark all ${n} prices as checked? Only do this once you've compared each one with your menu.`)) return;
          priceHolders().forEach((o) => { delete o.chk; }); changed(true);
        } }) : null,
        unsure.length ? h('button', { type: 'button', class: 'iconbtn', text: 'Hide this note', onclick: () => { unsure = []; changed(true); } }) : null));
  }
  function updateCheck() {
    const old = $('m-check'); const next = checkBanner();
    if (old && next) old.replaceWith(next); else if (old) old.remove();
  }
  // Photos are redrawn at most 2000 px as JPEG (sharp enough to read, small enough to send); PDFs go as they are.
  async function fileForReading(file) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} is over 8 MB. Try a smaller PDF, or photos of each page.`);
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
      return { type: 'application/pdf', data };
    }
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) throw new Error(`${file.name} isn't a photo or a PDF.`);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url;
      try { await img.decode(); } catch { throw new Error(`${file.name} couldn't be opened here. Try saving it as a JPG.`); }
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      return { type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] };
    } finally { URL.revokeObjectURL(url); }
  }
  let reading = false;
  async function readFromPhotos(files, statusEl, btn) {
    if (reading || !files.length) return;
    files = files.slice(0, 4);
    const hasDishes = menu.sections.some((sec) => sec.items.some((it) => it.name.trim()));
    if (hasDishes && !confirm('Replace the dishes on your menu with the ones read from your photos? Your look, logo and paper stay the same.')) return;
    const say = (t, err) => { statusEl.textContent = t; statusEl.classList.toggle('err', !!err); };
    reading = true; btn.disabled = true; btn.textContent = 'Reading your menu…';
    try {
      const payload = [];
      for (const f of files) payload.push(await fileForReading(f));
      const s = await session();
      if (!s) throw new Error('Your sign-in expired. Reload the page and sign in again.');
      say(`Reading ${files.length === 1 ? 'your menu' : `${files.length} pages`}. This usually takes 20 to 60 seconds.`);
      const res = await fetch(READ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: PUBLISHABLE_KEY },
        body: JSON.stringify({ files: payload }),
      });
      if (!res.ok || !res.body) {
        let m = `Reading the menu didn't work (${res.status}).`;
        try { const j = await res.json(); if (j.error) m = j.error; } catch { /* not JSON */ }
        throw new Error(m);
      }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let result = null; let failed = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!ln.trim()) continue;
          const m = JSON.parse(ln);
          if (m.t === 'done') result = m; else if (m.t === 'error') failed = m.message;
        }
      }
      if (failed) throw new Error(failed);
      if (!result) throw new Error('The connection dropped before the menu was read. Please try again.');
      applyRead(result);
      say(`Read ${result.menu.sections.reduce((n, sec) => n + sec.items.length, 0)} dishes in ${result.menu.sections.length} sections. Check the highlighted prices below.`);
    } catch (e) {
      say((e && e.message) || 'Something went wrong. Please try again.', true);
    } finally {
      reading = false; btn.disabled = false; btn.textContent = 'Read it from a photo';
    }
  }
  function applyRead(r) {
    const m = r.menu;
    // Fill only what's blank: the owner's own name, line and contact details are never overwritten.
    if (!menu.name.trim() && m.name) menu.name = m.name;
    if (!menu.tagline.trim() && m.tagline) menu.tagline = m.tagline;
    for (const k of ['address', 'phone', 'hours', 'website']) if (!(menu.footer[k] || '').trim() && m.footer[k]) menu.footer[k] = m.footer[k];
    if (r.currency) { menu.currency = r.currency; menu.showCurrency = true; }
    menu.sections = m.sections;
    normalize(menu);
    priceHolders().forEach((o) => { if ((o.amount !== undefined ? o.amount : o.price || '').trim()) o.chk = true; });
    unsure = r.unsure || [];
    const items = menu.sections.reduce((n, sec) => n + sec.items.length, 0);
    if (menu.pages === 1 && items > 30) menu.pages = 2;
    changed(true);
  }
  // Add-ons for a dish or a whole section: a lead word ("Add", "Choice of") and names with optional prices.
  function extrasEditor(owner, startLabel) {
    if (!owner.extras) {
      return h('button', { type: 'button', class: 'iconbtn', text: startLabel, onclick: () => { owner.extras = { lead: 'Add', list: [{ name: '', price: '' }] }; changed(true); } });
    }
    const ex = owner.extras;
    return h('div', { class: 'mextras' },
      h('div', { class: 'mrow' },
        h('label', { class: 'mini' }, 'Starts with'),
        field(ex, 'lead', { class: 'input elead', maxlength: '40', placeholder: 'Add', 'aria-label': 'Word before the add-ons, e.g. Add or Choice of' }),
        h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove these add-ons', text: '✕', onclick: () => { owner.extras = null; changed(true); } })),
      ex.list.map((x, i) => h('div', { class: 'mprice' },
        field(x, 'name', { class: 'input ename', maxlength: '60', placeholder: i ? 'Avocado' : 'Bacon', 'aria-label': `Add-on ${i + 1}` }),
        field(x, 'price', { class: 'input pamount', maxlength: '16', placeholder: '+2 (opt.)', 'aria-label': `Add-on ${i + 1} price` }),
        ex.list.length > 1 ? h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove this add-on', text: '✕', onclick: () => { ex.list.splice(i, 1); changed(true); } }) : null)),
      ex.list.length < 10 ? h('button', { type: 'button', class: 'iconbtn', text: '+ another', onclick: () => { ex.list.push({ name: '', price: '' }); changed(true); } }) : null);
  }
  function applyStarter(id) {
    const st = STARTERS.find((x) => x[0] === id);
    if (!st) return;
    const hasDishes = menu.sections.some((sec) => sec.items.some((it) => it.name.trim()));
    if (hasDishes && !confirm(`Start over with ${st[1]} sections? Your dishes will be removed. Your name, logo and contact details stay.`)) return;
    Object.assign(menu, st[2]);
    menu.sections = st[3].map(([name, kind, lead, labels]) => blankSection(name, kind, lead, labels));
    changed(true);
  }
  function move(list, i, d) { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; changed(true); }

  // ---------- the form ----------
  function renderEditor() {
    const root = $('fields');
    root.replaceChildren();
    const wrap = h('div', { class: 'mfields' });

    const banner = checkBanner();
    if (banner) wrap.append(banner);
    const readInput = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true });
    const readStatus = h('p', { class: 'mhint mread-status', role: 'status', 'aria-live': 'polite' });
    const readBtn = h('button', { type: 'button', class: 'btn mread-btn', text: reading ? 'Reading your menu…' : 'Read it from a photo', disabled: reading ? true : null, onclick: () => readInput.click() });
    readInput.addEventListener('change', () => { const f = [...readInput.files]; readInput.value = ''; readFromPhotos(f, readStatus, readBtn); });
    wrap.append(h('div', { class: 'mgroup mread' },
      h('h3', { text: 'Already have a menu?' }),
      h('p', { class: 'mhint', text: 'Take a photo of it (up to 4 pages, or a PDF) and Sogilex fills in your dishes, prices and details. You check every price before printing. Photos aren\'t kept.' }),
      readBtn, readInput, readStatus));

    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Start from a type of restaurant' }),
      h('p', { class: 'mhint', text: 'Sets up the sections and a matching look. You add your own dishes and prices.' }),
      h('div', { class: 'choices' }, STARTERS.map(([id, label]) => h('button', { type: 'button', class: 'choice', onclick: () => applyStarter(id) }, label)))));

    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Restaurant' }),
      h('div', { class: 'field' }, h('label', { for: 'm-name', text: 'Name' }), field(menu, 'name', { id: 'm-name', maxlength: '60', placeholder: 'Ninth & Pine' })),
      h('div', { class: 'field' }, h('label', { for: 'm-tag', text: 'Line under the name (optional)' }), field(menu, 'tagline', { id: 'm-tag', maxlength: '100', placeholder: 'Neighbourhood kitchen' })),
      h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: menu.showTagline, onchange: (e) => { menu.showTagline = e.target.checked; changed(); } }), 'Show this line on the menu')));

    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Logo' }),
      uid ? menuLogoBox() : null,
      menuLogo().logo ? h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: menu.showLogo, onchange: (e) => { menu.showLogo = e.target.checked; changed(); } }), 'Show my logo at the top of the menu') : null,
      null));

    if (uid && photoBoxEl) {
      wrap.append(h('div', { class: 'mgroup' },
        h('h3', { text: 'Food photos' }),
        h('p', { class: 'mhint', text: 'Your own photos (the same ones your website uses). Pick one for the top of the menu, and one for any section you like. Photos look best with the Bold layout.' }),
        h('div', { class: 'mrow' }, h('label', { class: 'mini', for: 'm-hero' }, 'Big photo at the top'), photoSelect(menu, 'hero', 'm-hero')),
        photoBoxEl));
    }

    // ---------- the look ----------
    const choice = (key, value, label, extra) => h('button', {
      type: 'button', class: 'choice' + (extra && extra.cls ? ' ' + extra.cls : ''), 'aria-pressed': String(menu[key] === value),
      style: extra && extra.style, title: extra && extra.title, onclick: () => { menu[key] = value; changed(true); },
    }, label);
    const palettes = [...PALETTES];
    if (menuLogo().colors[0]) palettes.unshift(paletteOf('logo'));
    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Look' }),
      h('div', { class: 'choice-label', text: 'Ready-made looks' }),
      h('div', { class: 'choices' }, LOOKS.map(([label, look]) => h('button', {
        type: 'button', class: 'choice', 'aria-pressed': String(Object.entries(look).every(([k, v]) => menu[k] === v)),
        onclick: () => { Object.assign(menu, look); changed(true); },
      }, label))),
      h('p', { class: 'mhint', text: 'Or mix your own below. Every combination is designed to look good and stay easy to read.' }),
      h('div', { class: 'choice-label', text: 'Fonts' }),
      h('div', { class: 'choices' }, FONTS.map(([id, label, family]) => choice('font', id, label, { cls: 'font-choice', style: `font-family:${family}` }))),
      h('div', { class: 'choice-label', text: 'Colours' }),
      h('div', { class: 'choices' }, palettes.map(([id, label, bg, , , accent]) => choice('palette', id, h('span', { class: 'pal' },
        h('i', { style: `background:${bg}` }), h('i', { style: `background:${accent}` })), { cls: 'pal-choice', title: label }))),
      h('div', { class: 'choice-label', text: 'Layout' }),
      h('div', { class: 'choices' }, LAYOUTS.map(([id, label]) => choice('layout', id, label))),
      h('div', { class: 'choice-label', text: 'Border' }),
      h('div', { class: 'choices' }, BORDERS.map(([id, label]) => choice('border', id, label)))));

    menu.sections.forEach((sec, si) => {
      const items = h('div', { class: 'mitems' });
      sec.items.forEach((it, ii) => {
        const prices = it.prices.map((p, pi) => h('div', { class: 'mprice' },
          field(p, 'label', { class: 'input plabel', maxlength: '40', placeholder: it.prices.length > 1 ? 'Size' : 'Size (opt.)', 'aria-label': `Price ${pi + 1} label` }),
          field(p, 'amount', { class: 'input pamount', maxlength: '16', placeholder: '12.50', inputmode: 'decimal', 'aria-label': `Price ${pi + 1}` }),
          it.prices.length > 1 ? h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove this price', text: '✕', onclick: () => { it.prices.splice(pi, 1); changed(true); } }) : null));
        items.append(h('div', { class: 'mitem' },
          h('div', { class: 'mrow' },
            field(it, 'name', { maxlength: '80', placeholder: 'Dish name', 'aria-label': `Dish ${ii + 1} in section ${si + 1}` }),
            h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move dish up', text: '↑', onclick: () => move(sec.items, ii, -1) }),
            h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move dish down', text: '↓', onclick: () => move(sec.items, ii, 1) }),
            h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove dish', text: '✕', onclick: () => { sec.items.splice(ii, 1); changed(true); } })),
          field(it, 'desc', { maxlength: '300', placeholder: 'Short description (optional)', 'aria-label': 'Description' }),
          ...(sec.kind === 'set' ? [] : prices),
          it.extras ? extrasEditor(it, '') : null,
          h('div', { class: 'mrow' },
            sec.kind !== 'set' && it.prices.length < 4 ? h('button', { type: 'button', class: 'iconbtn', text: '+ another size', onclick: () => { it.prices.push({ label: '', amount: '' }); changed(true); } }) : null,
            !it.extras ? extrasEditor(it, '+ add-ons') : null,
            h('div', { class: 'tags', role: 'group', 'aria-label': 'Dietary tags' }, TAGS.map(([code, label]) =>
              h('label', { class: 'mini', title: label }, h('input', { type: 'checkbox', checked: it.tags.includes(code), onchange: (e) => {
                it.tags = e.target.checked ? [...new Set([...it.tags, code])] : it.tags.filter((t) => t !== code); changed();
              } }), code))))));
      });
      wrap.append(h('div', { class: 'msec' },
        h('div', { class: 'mrow msec-head' },
          field(sec, 'name', { maxlength: '60', placeholder: 'Section, e.g. Starters', 'aria-label': `Section ${si + 1} name` }),
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move section up', text: '↑', onclick: () => move(menu.sections, si, -1) }),
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move section down', text: '↓', onclick: () => move(menu.sections, si, 1) }),
          h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove section', text: '✕', onclick: () => {
            if (sec.items.some((i) => i.name) && !confirm(`Remove the section "${sec.name || 'untitled'}" and its dishes?`)) return;
            menu.sections.splice(si, 1); changed(true);
          } })),
        h('div', { class: 'mrow' },
          h('label', { class: 'mini', for: `m-kind-${si}` }, 'Kind'),
          h('select', { class: 'mselect', id: `m-kind-${si}`, onchange: (e) => { sec.kind = e.target.value; changed(true); } },
            KINDS.map(([k, label]) => h('option', { value: k, selected: sec.kind === k ? true : null }, label))),
          uid && photos.length ? h('label', { class: 'mini', for: `m-photo-${si}` }, 'Photo') : null,
          uid && photos.length ? photoSelect(sec, 'photo', `m-photo-${si}`) : null),
        sec.kind === 'set' ? h('div', { class: 'mprice' },
          h('label', { class: 'mini', for: `m-setp-${si}` }, 'Price for the whole set'),
          field(sec, 'price', { id: `m-setp-${si}`, class: 'input pamount', maxlength: '16', placeholder: '95' })) : null,
        sec.kind === 'set' ? h('p', { class: 'mhint', text: 'Dishes in a set have no prices of their own. For a wine pairing, use "+ add-ons for the whole section" (e.g. Wine pairing 60).' }) : null,
        sec.kind === 'specials' ? h('p', { class: 'mhint', text: 'Prints in a box so it stands out. Good for happy hour, daily specials or a combo deal.' }) : null,
        sec.kind === 'normal' ? h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: sec.feature, onchange: (e) => { sec.feature = e.target.checked; changed(); } }), 'Feature this section (coloured panel, bigger heading): best for one or two signature sections') : null,
        field(sec, 'note', { maxlength: '300', placeholder: sec.kind === 'set' ? 'Note, e.g. Five courses, served to the whole table' : 'Note under the section (optional), e.g. Served with rice', 'aria-label': 'Section note' }),
        items,
        h('div', { class: 'mrow' },
          h('button', { type: 'button', class: 'addbtn', text: '+ Add a dish', onclick: () => { sec.items.push(blankItem()); changed(true); } }),
          !sec.extras ? extrasEditor(sec, '+ add-ons for the whole section') : null),
        sec.extras ? h('div', { class: 'msec-extras' }, h('div', { class: 'choice-label', text: 'Add-ons for the whole section' }), extrasEditor(sec, '')) : null));
    });
    wrap.append(h('button', { type: 'button', class: 'addbtn', text: '+ Add a section', onclick: () => { menu.sections.push(blankSection()); changed(true); } }));

    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Prices' }),
      h('div', { class: 'mrow' },
        h('label', { class: 'mini', for: 'm-cur' }, 'Currency symbol'),
        field(menu, 'currency', { id: 'm-cur', maxlength: '3', style: 'flex:0 0 70px' }),
        h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: menu.showCurrency, onchange: (e) => { menu.showCurrency = e.target.checked; changed(); } }), 'Show it before prices')),
      h('p', { class: 'mhint', text: 'Prices print exactly as you type them. Words like "Market" are fine too.' })));

    const f = menu.footer;
    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Bottom of the menu (optional)' }),
      field(f, 'address', { maxlength: '200', placeholder: 'Address', 'aria-label': 'Address' }),
      field(f, 'phone', { maxlength: '80', placeholder: 'Phone', 'aria-label': 'Phone' }),
      field(f, 'hours', { maxlength: '160', placeholder: 'Hours, e.g. Tue–Sun 11–9', 'aria-label': 'Hours' }),
      field(f, 'website', { maxlength: '100', placeholder: 'Website', 'aria-label': 'Website' }),
      h('p', { class: 'mhint', text: 'Anything left blank is simply left off the menu.' })));

    const og = onlineGroup();
    if (og) wrap.append(og);

    const q = menu.qr;
    const qrTest = h('a', { class: 'mhint qr-test', target: '_blank', rel: 'noopener' });
    const qrCheck = () => {
      const u = qrUrl(q.url);
      qrTest.hidden = !u;
      if (u) { qrTest.href = u; qrTest.textContent = `Test it: ${u} ↗`; }
    };
    const qrInput = field(q, 'url', { maxlength: '200', placeholder: 'Web address, e.g. yourrestaurant.com/order', 'aria-label': 'QR code web address', inputmode: 'url', autocomplete: 'off', spellcheck: 'false' });
    qrInput.addEventListener('input', qrCheck);
    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'QR code (optional)' }),
      h('p', { class: 'mhint', text: 'Prints a code at the bottom of your menu that opens a web page when a phone camera points at it: your website, online ordering, reviews or Instagram.' }),
      qrInput,
      field(q, 'label', { maxlength: '40', placeholder: 'Line next to it, e.g. Scan to order online', 'aria-label': 'Line next to the QR code' }),
      qrTest));
    qrCheck();

    root.append(wrap);
  }

  // ---------- the menu pages ----------
  function priceText(amount) {
    const a = (amount || '').trim();
    if (!a) return '';
    return menu.showCurrency && menu.currency && /^\d/.test(a) ? menu.currency + a : a;
  }
  // A QR code needs a full web address. Add https:// if it's missing; refuse anything that isn't a web link.
  function qrUrl(raw) {
    let u = (raw || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { const x = new URL(u); return /\./.test(x.hostname) && !/\s/.test(u) ? x.href : ''; } catch { return ''; }
  }
  // The QR code as an SVG: dark squares on a white tile, whatever the menu's colours (light-on-dark codes scan badly).
  function qrSvg(url) {
    if (!window.qrcode) return null;
    const qr = window.qrcode(0, 'M');
    qr.addData(url); qr.make();
    const n = qr.getModuleCount(); const q = 2;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${n + q * 2} ${n + q * 2}`);
    svg.setAttribute('class', 'm-qr-code'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `QR code for ${url}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#ffffff');
    const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); path.setAttribute('fill', '#111111');
    svg.append(bg, path);
    return svg;
  }
  function extrasEl(ex) {
    if (!ex) return null;
    const list = ex.list.filter((x) => x.name.trim());
    if (!list.length) return null;
    const p = h('p', { class: 'm-extras' }, ex.lead.trim() ? h('em', { text: ex.lead.trim() + ' ' }) : null);
    list.forEach((x, i) => {
      if (i) p.append(' · ');
      p.append(x.name.trim());
      if (x.price.trim()) p.append(h('span', { class: 'm-xprice', text: ' ' + priceText(x.price) }));
    });
    return p;
  }
  function itemEl(it, set) {
    const prices = set ? [] : it.prices.filter((p) => p.amount.trim());
    const priceEl = h('span', { class: 'm-price' });
    prices.forEach((p, i) => {
      if (i) priceEl.append(' · ');
      if (p.label.trim()) priceEl.append(h('small', { text: p.label.trim() + ' ' }));
      priceEl.append(priceText(p.amount));
    });
    return h('div', { class: 'm-item' + (prices.length ? '' : ' noprice') },
      h('span', { class: 'm-iname' }, it.name.trim(), it.tags.length ? h('span', { class: 'm-itags', text: it.tags.join(' · ') }) : null),
      h('span', { class: 'm-dots', 'aria-hidden': 'true' }),
      priceEl,
      it.desc.trim() ? h('span', { class: 'm-desc', text: it.desc.trim() }) : null,
      extrasEl(it.extras));
  }
  // A section's box with its heading. `cont` = it started on the page before ("Burgers, continued").
  function sectionShell(sec, cont) {
    const name = sec.name.trim();
    const el = h('section', { class: 'm-sec' + (sec.kind === 'specials' ? ' m-specials' : '') + (sec.kind === 'set' ? ' m-set' : '') + (sec.feature && sec.kind === 'normal' ? ' m-feature' : '') });
    const setPrice = sec.kind === 'set' && sec.price.trim() && !cont;
    if (setPrice) {
      el.append(h('div', { class: 'm-sethead' }, h('h2', {}, h('span', { class: 'm-sec-t', text: name })), h('span', { class: 'm-dots', 'aria-hidden': 'true' }), h('span', { class: 'm-price', text: priceText(sec.price) })));
    } else if (name) el.append(h('h2', {}, h('span', { class: 'm-sec-t', text: cont ? `${name}, continued` : name })));
    const photo = !cont && sec.photo ? photoUrl(sec.photo) : null;
    if (photo) el.append(h('img', { class: 'm-sec-photo', src: photo, alt: photoName(sec.photo) || name }));
    if (!cont && sec.note.trim()) el.append(h('p', { class: 'm-note', text: sec.note.trim() }));
    return el;
  }
  // The menu as a list of pieces that can flow between pages: single dishes for regular sections (a section can
  // break between dishes), whole boxes for specials and set menus (they never break).
  function buildUnits() {
    const units = []; const used = new Set();
    for (const sec of menu.sections) {
      const items = sec.items.filter((it) => it.name.trim());
      const extras = extrasEl(sec.extras);
      if (!items.length && !sec.name.trim() && !extras) continue;
      items.forEach((it) => it.tags.forEach((t) => used.add(t)));
      const nodes = items.map((it) => itemEl(it, sec.kind === 'set'));
      // Specials, set menus and featured sections stay in one piece; regular sections can break between dishes.
      if (sec.kind !== 'normal' || sec.feature) units.push({ sec, nodes: extras ? [...nodes, extras] : nodes });
      else {
        if (!nodes.length) units.push({ sec, nodes: [] });
        nodes.forEach((n) => units.push({ sec, nodes: [n] }));
        if (extras) units.push({ sec, nodes: [extras] });
      }
    }
    return { units, used };
  }
  function makePages() {
    const [, , bg, ink, muted, accent] = paletteOf(menu.palette);
    const n = menu.pages === 2 ? 2 : 1;
    const { units, used } = buildUnits();
    const f = menu.footer;
    const contact = [f.address, f.phone, f.website].map((x) => (x || '').trim()).filter(Boolean).join(' · ');
    const legend = TAGS.filter(([code]) => used.has(code)).map(([code, label]) => `${code} ${label}`).join(' · ');
    const pages = [];
    for (let i = 0; i < n; i++) {
      const page = h('div', { class: ['menu-page', menu.paper === 'a4' ? 'a4' : '', 'font-' + menu.font, 'layout-' + menu.layout, 'border-' + menu.border, i ? 'page-next' : ''].filter(Boolean).join(' ') });
      page.style.setProperty('--m-bg', bg); page.style.setProperty('--m-ink', ink);
      page.style.setProperty('--m-muted', muted); page.style.setProperty('--m-accent', accent);
      page.style.setProperty('--m-on', onAccent(accent, ink, bg));
      if (i === 0) {
        const hero = menu.hero ? photoUrl(menu.hero) : null;
        page.append(h('header', { class: 'm-head' + (hero ? ' has-hero' : '') },
          h('div', { class: 'm-head-text' },
            menuLogo().logo && menu.showLogo ? h('span', { class: 'm-logo-tile' }, h('img', { class: 'm-logo', src: menuLogo().logo, alt: (menu.name.trim() || 'Restaurant') + ' logo' })) : null,
            h('h1', { class: 'm-name', text: menu.name.trim() || 'Your restaurant' }),
            menu.showTagline && menu.tagline.trim() ? h('p', { class: 'm-tagline', text: menu.tagline.trim() }) : null,
            h('div', { class: 'm-rule' })),
          hero ? h('img', { class: 'm-hero', src: hero, alt: photoName(menu.hero) || 'Food photo' }) : null));
      } else if (menu.name.trim()) {
        page.append(h('header', { class: 'm-head m-head-small' }, h('p', { class: 'm-name-small', text: menu.name.trim() })));
      }
      const body = h('div', { class: 'm-body' });
      page.append(body);
      const qu = qrUrl(menu.qr && menu.qr.url);
      const qrEl = i === n - 1 && qu ? h('div', { class: 'm-qr' }, qrSvg(qu), (menu.qr.label || '').trim() ? h('span', { class: 'm-qr-label', text: menu.qr.label.trim() }) : null) : null;
      if (i === n - 1 && (contact || (f.hours || '').trim() || legend || qrEl)) {
        page.append(h('footer', { class: 'm-foot' + (qrEl ? ' has-qr' : '') },
          qrEl,
          h('div', { class: 'm-foot-text' },
            legend ? h('p', { text: legend }) : null,
            (f.hours || '').trim() ? h('p', { text: f.hours.trim() }) : null,
            contact ? h('p', { text: contact }) : null)));
      }
      pages.push({ page, body });
    }
    return { pages, units };
  }
  const over = (body) => body.scrollHeight > body.clientHeight + 1 || body.scrollWidth > body.clientWidth + 1;
  // Fill each page in order until the next piece doesn't fit; the last page takes whatever is left.
  function flow(pages, units) {
    let k = 0;
    const started = new Set();
    pages.forEach(({ body }, pi) => {
      body.replaceChildren();
      const last = pi === pages.length - 1;
      let cur = null; // { sec, el } of the section box open on this page
      for (; k < units.length; k++) {
        const u = units[k];
        let fresh = false;
        if (!cur || cur.sec !== u.sec) {
          cur = { sec: u.sec, el: sectionShell(u.sec, started.has(u.sec)) };
          body.append(cur.el); fresh = true;
        }
        u.nodes.forEach((nd) => cur.el.append(nd));
        if (last || !over(body)) { started.add(u.sec); continue; }
        // Doesn't fit: take it back and move to the next page, unless the page is still empty (then it has to go here).
        if (fresh) { cur.el.remove(); cur = null; } else u.nodes.forEach((nd) => nd.remove());
        if (!body.childNodes.length) {
          cur = { sec: u.sec, el: sectionShell(u.sec, started.has(u.sec)) };
          body.append(cur.el); u.nodes.forEach((nd) => cur.el.append(nd)); started.add(u.sec); k++;
        }
        break;
      }
    });
    if (!units.length) pages[0].body.append(h('p', { class: 'm-empty', text: 'Add a section and some dishes, and your menu appears here.' }));
    return pages.every(({ body }) => !over(body));
  }

  // Shrink the type (never below ~10 pt) and switch to two columns until the menu fits its page(s).
  const STEPS = [[1, 1], [1, 0.96], [1, 0.92], [2, 1], [2, 0.96], [2, 0.92], [2, 0.88], [2, 0.84], [2, 0.8]];
  function fit(pages, units) {
    for (const [cols, s] of STEPS) {
      pages.forEach(({ page, body }) => { body.classList.toggle('two', cols === 2); page.style.setProperty('--s', String(s)); });
      if (flow(pages, units)) {
        const lastBody = pages[pages.length - 1].body;
        return { ok: true, cols, s, emptyBack: pages.length > 1 && !lastBody.childNodes.length };
      }
    }
    return { ok: false };
  }
  function scalePreview() {
    const wrapEl = $('sheet-wrap'); const sheets = $('sheets');
    const avail = wrapEl.clientWidth - 36;
    // On wide screens the preview stays on screen while you edit, so fit it to the window height too.
    const sticky = window.matchMedia('(min-width: 901px)').matches;
    sheets.classList.toggle('stacked', !sticky);
    const room = sticky ? window.innerHeight - 84 - 80 - 36 : Infinity;
    const scale = Math.min(1, avail / sheets.offsetWidth, room / sheets.offsetHeight);
    sheets.style.transform = `scale(${scale})`;
    wrapEl.style.height = `${sheets.offsetHeight * scale + 36}px`;
  }
  function renderPreview() {
    const sheets = $('sheets');
    const { pages, units } = makePages();
    sheets.replaceChildren(...pages.map((p) => p.page));
    sheets.style.transform = 'none';
    const r = fit(pages, units);
    const fitEl = $('fit');
    fitEl.classList.toggle('warn', !r.ok);
    const how = r.ok ? [r.cols === 2 ? 'in two columns' : '', r.s < 1 ? `type at ${Math.round(r.s * 100)}%` : ''].filter(Boolean).join(', ') : '';
    fitEl.replaceChildren();
    if (menu.pages === 2) {
      fitEl.textContent = !r.ok ? 'Too long for two pages. Remove a few dishes or shorten descriptions.'
        : r.emptyBack ? 'Everything fits on the front. You can switch to one page.'
          : `Fits front and back${how ? ', ' + how : ''}. Print double-sided.`;
    } else if (r.ok) {
      fitEl.textContent = `Fits on one page${how ? ', ' + how : ''}.`;
    } else {
      fitEl.append('Too long for one page. ', h('button', { type: 'button', class: 'linkbtn', text: 'Use front and back', onclick: () => { menu.pages = 2; changed(); } }));
    }
    $('paper').value = menu.paper;
    $('pages').value = String(menu.pages);
    $('page-size').textContent = `@page { size: ${menu.paper === 'a4' ? 'A4' : 'letter'}; margin: 0; }`;
    scalePreview();
  }

  // ---------- saving ----------
  let previewTimer = null; let saveTimer = null;
  function changed(rebuild) {
    if (rebuild) renderEditor();
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 120);
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200);
    $('save-state').textContent = 'Unsaved changes';
  }
  async function save() {
    if (!uid) return;
    $('save-state').textContent = 'Saving…';
    try {
      const { error } = await db.from('menus').upsert({ user_id: uid, data: menu, updated_at: new Date().toISOString() }).abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      $('save-state').textContent = 'Saved';
    } catch { $('save-state').textContent = "Couldn't save. Check your connection."; return; }
    if (online.slug) publishOnline(); // keep the online menu in step
  }
  window.addEventListener('beforeunload', (e) => { if ($('save-state').textContent !== 'Saved' && uid && $('save-state').textContent) { save(); e.preventDefault(); } });

  // ---------- start ----------
  $('paper').addEventListener('change', (e) => { menu.paper = e.target.value === 'a4' ? 'a4' : 'letter'; changed(); });
  $('pages').addEventListener('change', (e) => { menu.pages = e.target.value === '2' ? 2 : 1; changed(); });
  $('print').addEventListener('click', () => {
    const n = uncheckedCount();
    if (n && !confirm(`${n} ${n === 1 ? 'price was' : 'prices were'} read from your photo and not checked yet (highlighted in the form). Print anyway?`)) return;
    // Print a copy of the preview, which has already been fitted to the page (a hidden copy can't measure itself).
    renderPreview();
    const copies = [...$('sheets').children].map((pg) => pg.cloneNode(true));
    $('print-root').replaceChildren(...copies);
    window.print();
  });
  window.addEventListener('resize', scalePreview);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(renderPreview);
  // A newly chosen font loads after the first layout: fit again once it arrives.
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => renderPreview());

  $('signout').addEventListener('click', async () => { try { await within(db.auth.signOut(), 8000); } catch { /* cleared locally */ } location.reload(); });
  $('pwbtn').addEventListener('click', () => { SogilexAuth.mountPasswordForm($('pw-mount'), { client: db }); $('pwdialog').showModal(); });

  (async () => {
    const s = await session();
    renderPreview();
    if (!s) {
      $('signin').hidden = false;
      SogilexAuth.mountSignIn($('signin-mount'), { client: db, redirectTo: location.href.split('#')[0], onSignedIn: () => location.reload() });
      return;
    }
    uid = s.user.id;
    if (window.SogilexBrand) kit = await SogilexBrand.load(db, uid);
    startPhotos();
    await loadOnline();
    $('signout').hidden = false; $('pwbtn').hidden = false;
    try {
      const { data, error } = await db.from('menus').select('data').eq('user_id', uid).maybeSingle().abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      if (data && data.data && Array.isArray(data.data.sections)) menu = normalize({ ...blankMenu(), ...data.data, footer: { ...blankMenu().footer, ...(data.data.footer || {}) } });
      if (menu.logoColor && menu.palette === 'cream') menu.palette = 'logo';
      $('save-state').textContent = data ? 'Saved' : '';
    } catch { $('save-state').textContent = "Couldn't load your menu. Refresh to try again."; }
    $('editor').hidden = false;
    renderEditor();
    renderPreview();
  })();
})();
