// Sogilex Flyers (beta): a short form, a live preview that fits itself to the page, and autosave to the person's
// Sogilex account (several flyers each). No AI: every word on the flyer is exactly what was typed, and anything left
// blank is left off. Looks are curated (fonts x colours x layouts), the same approach as Menus.
// Sizes: US Letter and A4 for print (browser print dialog, Save as PDF), Square for social posts ("Save image").
// The same engine runs Sogilex Posts (build.sogilex.com/posts/, <body data-tool="posts">): social media images in
// square and story sizes, its own kinds of post and its own saved list (table posts).
(() => {
  const SUPABASE_URL = 'https://sdltqbctuieyjlujsdhj.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM'; // public by design; RLS protects data
  const $ = (id) => document.getElementById(id);
  const db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: window.SogilexAuth ? window.SogilexAuth.clientOptions() : { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  const UP = (m) => !!(window.SogilexUpgrade && window.SogilexUpgrade.offer(m)); // a plan limit opens the upgrade box
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  async function session() { try { const { data } = await within(db.auth.getSession(), 10000); return data.session; } catch { return null; } }

  const POSTS = document.body.dataset.tool === 'posts';
  if (window.SogilexUpgrade) {
    SogilexUpgrade.init(db); SogilexUpgrade.trialBar(POSTS ? 'posts' : 'flyers');
    SogilexUpgrade.ready().then(() => { if (TRIAL() && $('sheets') && $('sheets').firstChild) renderPreview(); });
  }
  const TRIAL = () => !!(window.SogilexUpgrade && window.SogilexUpgrade.isTrial()); // free trial: downloads carry the Sogilex line

  const TABLE = POSTS ? 'posts' : 'flyers';
  const NOUN = POSTS ? 'post' : 'flyer';
  const MAX_DETAILS = 5;
  const blankFlyer = () => ({
    v: 1, starter: POSTS ? 'deal' : 'event', size: POSTS ? 'square' : 'letter', font: 'modern', palette: 'cream', layout: 'poster', showLogo: true, showBiz: true,
    kicker: '', headline: '', sub: '', offer: '', when: '', where: '', details: [''], cta: '', fine: '',
    biz: { name: '', phone: '', website: '', address: '' }, qr: { url: '', label: '' }, caption: '', tone: 'friendly',
  });

  // Same curated fonts and colours as Menus (every palette passes WCAG AA).
  const FONTS = [
    ['modern', 'Modern', 'Inter, system-ui, sans-serif'],
    ['bold', 'Bold', "'Bebas Neue', Impact, sans-serif"],
    ['classic', 'Classic', "'EB Garamond', Georgia, serif"],
    ['elegant', 'Elegant', "'Playfair Display', Georgia, serif"],
    ['warm', 'Warm', 'Fraunces, Georgia, serif'],
    ['heavy', 'Heavy', 'Anton, Impact, sans-serif'],
    ['slab', 'Slab', "'Alfa Slab One', Rockwell, serif"],
    ['western', 'Western', 'Rye, Georgia, serif'],
    ['script', 'Script', "Lobster, 'Brush Script MT', cursive"],
  ];
  const PALETTES = [ // [id, name, paper, ink, muted, accent]
    ['cream', 'Cream', '#FBF8F2', '#221C18', '#6B5D52', '#8E3B24'],
    ['paper', 'Black & white', '#FFFFFF', '#141414', '#5A5A5A', '#141414'],
    ['sage', 'Sage', '#F2F4EE', '#1E2A22', '#56645A', '#3D6B48'],
    ['harbor', 'Harbor', '#F4F3EF', '#18213A', '#5A6175', '#27467F'],
    ['terracotta', 'Terracotta', '#FBF2EA', '#2B1A14', '#735A4E', '#A84A28'],
    ['blush', 'Blush', '#FCF3F2', '#2A1D21', '#72595F', '#A8345A'],
    ['butter', 'Butter', '#FBF5DF', '#2A2414', '#6B5F3E', '#8A5A00'],
    ['midnight', 'Midnight', '#141922', '#F2EEE6', '#ADA69A', '#E0AE4C'],
    ['forest', 'Forest', '#14251C', '#F0ECE2', '#B5B2A3', '#E3B868'],
    ['charcoal', 'Charcoal', '#1B1B1B', '#F3F3F3', '#A9A9A9', '#F0715A'],
    ['tavern', 'Tavern', '#F6EFE2', '#2A1A14', '#6B5446', '#8A1F24'],
    ['mustard', 'Mustard', '#1C1A17', '#F4EFE6', '#B8B0A2', '#F2B705'],
    ['ketchup', 'Ketchup', '#FFF8EE', '#2A1712', '#6E5248', '#C8281E'],
  ];
  const LAYOUTS = [['poster', 'Poster'], ['block', 'Colour block'], ['left', 'Left-aligned']];
  const SIZES = POSTS ? ['square', 'story'] : ['letter', 'a4', 'square'];
  // Starters: a kind of flyer. They set a look and the example text in the empty boxes, never words on the flyer.
  // Optional: `labels` renames boxes for that kind, `hide` leaves boxes out (and off the image), `note` adds a rule,
  // `dish` shows "Use a dish from my menu" (only kinds about a dish or a deal: an event or a review has no dish).
  const FLYER_STARTERS = {
    event: { label: 'Event', look: { font: 'modern', palette: 'harbor', layout: 'poster' },
      hint: { kicker: 'Every Thursday', headline: 'Trivia Night', sub: 'Teams of up to six. Prizes for the top three.', offer: '', when: 'Thursdays, 7–9pm', where: 'Your place, address', detail: 'Free to play', cta: 'Call to reserve a table' } },
    special: { label: 'Special or deal', dish: true, look: { font: 'bold', palette: 'charcoal', layout: 'block' },
      hint: { kicker: 'Monday to Friday', headline: 'Happy Hour', sub: 'Half-price appetizers at the bar', offer: '$5 drafts', when: '3–6pm', where: '', detail: '$7 house wines', cta: 'Walk-ins welcome' } },
    music: { label: 'Live music', look: { font: 'bold', palette: 'midnight', layout: 'poster' },
      hint: { kicker: 'Live on the patio', headline: 'The band name', sub: 'Blues and soul covers', offer: '', when: 'Saturday, May 3 · 8pm', where: 'Address', detail: 'No cover', cta: 'Scan for the full line-up' } },
    opening: { label: 'Grand opening', look: { font: 'elegant', palette: 'cream', layout: 'poster' },
      hint: { kicker: 'Now open', headline: 'Grand Opening', sub: 'Come meet the team', offer: 'Free coffee all day', when: 'Saturday, June 7 · 8am–2pm', where: 'Address', detail: 'Kids welcome', cta: 'Follow us on Instagram' } },
    class: { label: 'Class or sign-up', look: { font: 'warm', palette: 'sage', layout: 'left' },
      hint: { kicker: 'Hands-on workshop', headline: 'Pasta from Scratch', sub: 'Make, cook and eat three shapes', offer: '$45 per person', when: 'Sunday, March 9 · 2–4pm', where: 'Address', detail: 'All ingredients included', cta: 'Book at yoursite.com' } },
    notice: { label: 'Notice or hours', look: { font: 'classic', palette: 'paper', layout: 'left' },
      hint: { kicker: 'Holiday hours', headline: 'Closed Thanksgiving Day', sub: 'Back to regular hours on Friday', offer: '', when: 'Thursday, November 26', where: '', detail: 'Order pies by Monday', cta: 'Thank you for a great year' } },
  };
  const POST_STARTERS = {
    deal: { label: 'Deal or special', dish: true, look: { font: 'heavy', palette: 'mustard', layout: 'block' },
      hint: { kicker: 'This week only', headline: 'Wing Night', sub: 'Any sauce, all night', offer: '$9.99', when: 'Tuesdays, 4pm–close', where: '', detail: 'Dine in only', cta: 'See you tonight' } },
    event: { label: 'Event', look: { font: 'modern', palette: 'harbor', layout: 'poster' },
      hint: { kicker: 'This Saturday', headline: 'Live Music', sub: 'Blues and soul covers', offer: '', when: 'Saturday · 8pm', where: 'On the patio', detail: 'No cover', cta: 'Bring a friend' } },
    item: { label: 'Featured item', dish: true, look: { font: 'heavy', palette: 'ketchup', layout: 'block' },
      hint: { kicker: 'New on the menu', headline: 'Big Ben Burger', sub: '12 oz, cheddar, pickle and onion', offer: '$14', when: '', where: '', detail: 'Served with steak fries', cta: 'Available all week' },
      labels: { headline: 'Name of the dish or product', sub: 'Short description (optional)', offer: 'Price (optional)' }, hide: ['when', 'where'] },
    announce: { label: 'Announcement', look: { font: 'classic', palette: 'paper', layout: 'left' },
      hint: { kicker: 'Holiday hours', headline: 'Closed Thanksgiving Day', sub: 'Back to regular hours on Friday', offer: '', when: 'Thursday, November 26', where: '', detail: 'Order pies by Monday', cta: 'Thank you for a great year' } },
    hiring: { label: 'Now hiring', look: { font: 'slab', palette: 'harbor', layout: 'poster' },
      hint: { kicker: 'Join the team', headline: 'Now Hiring', sub: 'Line cooks and servers', offer: '', when: 'Full and part time', where: '', detail: 'Flexible schedules', cta: 'Apply in person or send us a message' },
      labels: { headline: 'Headline', sub: 'Which jobs', when: 'Hours (optional)' }, rows: { when: 'Hours' }, hide: ['offer', 'where'] },
    review: { label: 'Customer review', look: { font: 'elegant', palette: 'cream', layout: 'poster' },
      hint: { kicker: 'What our customers say', headline: 'The review, copied exactly as they wrote it', sub: 'Their name, as they signed it', offer: '', when: '', where: '', detail: '', cta: 'Thank you!' },
      labels: { headline: 'The review, word for word', sub: 'Who wrote it, as they signed it (for example "Sarah M., on Google")' }, hide: ['offer', 'when', 'where', 'details'],
      note: 'Only real reviews, copied exactly. Ask before using someone\'s full name.' },
  };
  const STARTERS = POSTS ? POST_STARTERS : FLYER_STARTERS;
  const CAPTION_TONES = [['friendly', 'Friendly'], ['fun', 'Fun'], ['professional', 'Professional'], ['short', 'Short']];
  const hidden = (k) => (STARTERS[flyer.starter].hide || []).includes(k);
  const lbl = (k, fallback) => (STARTERS[flyer.starter].labels || {})[k] || fallback;

  function normalize(f) {
    const b = blankFlyer();
    const out = { ...b, ...f, biz: { ...b.biz, ...(f.biz || {}) }, qr: { ...b.qr, ...(f.qr || {}) } };
    for (const k of ['kicker', 'headline', 'sub', 'offer', 'when', 'where', 'cta', 'fine']) out[k] = String(out[k] || '');
    out.details = Array.isArray(out.details) && out.details.length ? out.details.slice(0, MAX_DETAILS).map((x) => String(x || '')) : [''];
    if (!STARTERS[out.starter]) out.starter = POSTS ? 'deal' : 'event';
    if (!SIZES.includes(out.size)) out.size = SIZES[0];
    if (!FONTS.some(([id]) => id === out.font)) out.font = 'modern';
    if (!LAYOUTS.some(([id]) => id === out.layout)) out.layout = 'poster';
    if (out.palette !== 'logo' && !PALETTES.some(([id]) => id === out.palette)) out.palette = 'cream';
    out.photo = typeof out.photo === 'string' && out.photo ? out.photo : null;
    out.caption = typeof out.caption === 'string' ? out.caption.slice(0, 2200) : '';
    if (!CAPTION_TONES.some(([id]) => id === out.tone)) out.tone = 'friendly';
    return out;
  }

  let flyer = blankFlyer();
  let flyerId = null; // the saved row being edited
  let list = []; // [{ id, data, updated_at }]
  let uid = null;
  let kit = { logo: null, logo_name: null, colors: [] };

  // ---------- photos (the same private library as Build's "Your photos") ----------
  let photos = []; let photoBox = null; let photoBoxEl = null;
  const photoUrl = (id) => (photoBox && photoBox.links[id]) || null;
  const photoName = (id) => { const p = photos.find((x) => x.id === id); return p ? (p.name || '').trim() : ''; };
  function startPhotos() {
    if (!window.SogilexPhotos || photoBoxEl) return;
    photoBoxEl = h('div', { class: 'm-photos' });
    photoBox = SogilexPhotos.mount(photoBoxEl, {
      db, uid,
      onChange: (list) => {
        photos = list;
        if (flyer.photo && !list.some((p) => p.id === flyer.photo)) flyer.photo = null; // removed from the library
        const sel = $('f-photo');
        if (sel) {
          sel.replaceChildren(h('option', { value: '', text: 'No photo' }),
            ...photos.map((p, i) => h('option', { value: p.id, selected: flyer.photo === p.id ? true : null, text: p.name.trim() || `Photo ${i + 1}` })));
        }
        clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 120);
      },
    });
  }

  function paletteOf(id) {
    if (id === 'logo' && kit.colors && kit.colors[0] && window.SogilexBrand) return ['logo', 'My logo', '#FBF8F2', '#221C18', '#6B5D52', SogilexBrand.readableOnLight(kit.colors[0])];
    return PALETTES.find((p) => p[0] === id) || PALETTES[0];
  }
  // White or ink text on the accent colour, whichever reads better.
  function lum(hex) {
    const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const onAccent = (accent, ink, bg) => [ '#FFFFFF', '#141414', bg, ink ].sort((p, q) => contrast(q, accent) - contrast(p, accent))[0];

  // The account's plan (supabase/021_plans.sql): limits are per day on Beta, per month on paid plans, once on the
  // free trial. Loaded once; the counters say "left today", "left this month" or "left on your free trial".
  let planInfo = null;
  async function getPlan() {
    if (planInfo) return planInfo;
    try { const { data, error } = await db.rpc('my_plan').abortSignal(AbortSignal.timeout(8000)); if (error) throw error; planInfo = data || {}; }
    catch { planInfo = {}; }
    return planInfo;
  }
  const leftWhen = (p) => ({ 'this month': 'this month', 'on the free trial': 'on your free trial' }[p && p.when] || 'today');
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
  function field(obj, key, attrs) {
    return h('input', { class: 'input', type: 'text', value: obj[key] || '', ...attrs, oninput: (e) => { obj[key] = e.target.value; changed(); } });
  }
  function labelled(id, label, input) { input.id = id; return h('div', { class: 'field' }, h('label', { for: id, text: label }), input); }
  const hint = () => STARTERS[flyer.starter].hint;

  // ---------- "Use a dish from my menu" ----------
  // Copies a dish's name, description, price (exactly as on the menu) and its section's photo into the boxes.
  // Prices that were read from a photo and never checked are left out, so an unchecked price can't reach a post.
  let menuDishes = []; // [{ sec, name, desc, price, photo }]
  function dishesOf(md) {
    if (!md || !Array.isArray(md.sections)) return [];
    const cur = md.showCurrency !== false && typeof md.currency === 'string' ? md.currency : '';
    const money = (a) => { a = String(a || '').trim(); return a && cur && /^\d/.test(a) ? cur + a : a; };
    const out = [];
    for (const sec of md.sections) {
      for (const it of (sec && sec.items) || []) {
        const name = String((it && it.name) || '').trim();
        if (!name) continue;
        const prices = sec.kind === 'set' ? [] : ((it.prices || []).filter((p) => p && String(p.amount || '').trim() && !p.chk));
        out.push({
          sec: String(sec.name || '').trim() || 'Menu', name, desc: String(it.desc || '').trim(),
          price: prices.map((p) => (String(p.label || '').trim() ? p.label.trim() + ' ' : '') + money(p.amount)).join(' · ').slice(0, 32),
          photo: typeof sec.photo === 'string' ? sec.photo : null,
        });
      }
    }
    return out.slice(0, 300);
  }
  function dishPicker() {
    if (!menuDishes.length || !STARTERS[flyer.starter].dish) return null;
    const groups = new Map();
    menuDishes.forEach((d, i) => { if (!groups.has(d.sec)) groups.set(d.sec, []); groups.get(d.sec).push([i, d]); });
    const sel = h('select', { class: 'mselect', id: 'f-dish', onchange: (e) => {
      const d = menuDishes[Number(e.target.value)];
      if (!d) return;
      flyer.headline = d.name.slice(0, 60);
      flyer.sub = d.desc.slice(0, 110);
      if (!hidden('offer')) flyer.offer = d.price;
      if (d.photo && photos.some((p) => p.id === d.photo)) flyer.photo = d.photo;
      changed(true);
    } }, h('option', { value: '', text: 'Choose a dish…' }),
      ...[...groups].map(([sec, items]) => h('optgroup', { label: sec }, items.map(([i, d]) => h('option', { value: String(i), text: d.price ? `${d.name} (${d.price})` : d.name })))));
    return h('div', { class: 'mrow' }, h('label', { class: 'mini', for: 'f-dish' }, 'Use a dish from my menu'), sel);
  }

  // ---------- caption (Posts): written by AI from the post's facts (Edge Function write-caption) ----------
  // The words around the facts are AI-written; the facts are only the ones on the post (or typed in a change
  // request). The owner can always edit the caption by hand, and it's saved with the post.
  const CAPTION_URL = `${SUPABASE_URL}/functions/v1/write-caption`;
  let captionBusy = false;
  function captionPayload() {
    const t = (v) => String(v || '').trim();
    return {
      kind: flyer.starter, kicker: t(flyer.kicker), headline: t(flyer.headline), sub: t(flyer.sub),
      offer: hidden('offer') ? '' : t(flyer.offer), when: hidden('when') ? '' : t(flyer.when), where: hidden('where') ? '' : t(flyer.where),
      details: hidden('details') ? [] : flyer.details.map(t).filter(Boolean), cta: t(flyer.cta), fine: t(flyer.fine),
      business: { name: t(flyer.biz.name), phone: t(flyer.biz.phone), website: t(flyer.biz.website), address: t(flyer.biz.address) },
    };
  }
  async function askCaption(instruction, say, buttons) {
    if (captionBusy) return;
    if (!flyer.headline.trim()) { say('Fill in the headline first, then write a caption.', true); return; }
    captionBusy = true; buttons.forEach((b) => { b.disabled = true; });
    say(instruction ? 'Changing the caption…' : 'Writing a caption…');
    try {
      const s = await session();
      if (!s) throw new Error('Your sign-in has expired. Sign in again.');
      const res = await fetch(CAPTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: PUBLISHABLE_KEY },
        body: JSON.stringify({ post: captionPayload(), tone: flyer.tone, current: instruction ? flyer.caption : '', instruction }),
        signal: AbortSignal.timeout(100000),
      });
      let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
      if (!res.ok || !data.caption) throw new Error(data.error || `That didn't work (${res.status}). Please try again.`);
      flyer.caption = data.caption;
      const box = $('f-caption'); if (box) box.value = flyer.caption;
      changed();
      say(`Done. Read it before you post: it only uses your facts, but you know your business best.${typeof data.left === 'number' ? ` ${data.left} caption${data.left === 1 ? '' : 's'} left ${leftWhen(await getPlan())}.` : ''}`);
    } catch (e) { say((e && e.message) || "That didn't work. Please try again.", true); UP(e && e.message); }
    finally { captionBusy = false; buttons.forEach((b) => { b.disabled = false; }); }
  }
  function captionGroup() {
    const status = h('p', { class: 'mhint mread-status', role: 'status', 'aria-live': 'polite' });
    const say = (text, err) => { status.textContent = text; status.classList.toggle('err', !!err); };
    const box = h('textarea', { class: 'input mtext', id: 'f-caption', rows: '8', maxlength: '2200', placeholder: 'Your caption appears here. You can also type or edit it yourself.',
      oninput: (e) => { flyer.caption = e.target.value; changed(); } });
    box.value = flyer.caption;
    const writeBtn = h('button', { type: 'button', class: 'btn mread-btn', text: flyer.caption.trim() ? 'Write a new one' : 'Write a caption' });
    const ask = h('input', { class: 'input', type: 'text', id: 'f-cap-ask', maxlength: '300', 'aria-label': 'What should change in the caption?',
      placeholder: 'Change it: "make it shorter", "mention we\'re dog friendly"' });
    const changeBtn = h('button', { type: 'button', class: 'iconbtn', text: 'Change it' });
    const copyBtn = h('button', { type: 'button', class: 'iconbtn', text: 'Copy caption' });
    const buttons = [writeBtn, changeBtn];
    writeBtn.addEventListener('click', () => askCaption('', say, buttons).then(() => { writeBtn.textContent = flyer.caption.trim() ? 'Write a new one' : 'Write a caption'; }));
    const change = () => {
      const v = ask.value.trim();
      if (!v) { ask.focus(); return; }
      if (!flyer.caption.trim()) { say('Write a caption first, then ask for changes.', true); return; }
      askCaption(v, say, buttons).then(() => { if (!status.classList.contains('err')) ask.value = ''; });
    };
    changeBtn.addEventListener('click', change);
    ask.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); change(); } });
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(flyer.caption); say('Copied. Paste it under your post.'); }
      catch { box.select(); say('Press Ctrl+C (or Cmd+C) to copy.'); }
    });
    const tones = h('div', { class: 'choices' }, CAPTION_TONES.map(([id, label]) => h('button', {
      type: 'button', class: 'choice', 'aria-pressed': String(flyer.tone === id),
      onclick: (e) => { flyer.tone = id; changed(); e.target.parentElement.querySelectorAll('.choice').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target))); },
    }, label)));
    return h('div', { class: 'mgroup' },
      h('h3', { text: 'Caption' }),
      h('p', { class: 'mhint', text: 'Written by AI from the facts above. It won\'t add prices, dates or claims you didn\'t give. Check it before you post.' }),
      h('div', { class: 'choice-label', text: 'Tone' }), tones,
      h('div', { class: 'mrow' }, writeBtn, copyBtn),
      box,
      h('div', { class: 'mrow' }, ask, changeBtn),
      status);
  }

  // ---------- the editor ----------
  const titleOf = (d) => (d.headline || '').trim() || `Untitled ${NOUN}`;
  function listGroup() {
    if (!uid) return null;
    const sel = h('select', { class: 'mselect', 'aria-label': `Your saved ${NOUN}s`, onchange: (e) => openFlyer(e.target.value) },
      list.map((r) => h('option', { value: r.id, selected: r.id === flyerId ? true : null }, titleOf(r.id === flyerId ? flyer : r.data))));
    return h('div', { class: 'mgroup' },
      h('h3', { text: `Your ${NOUN}s` }),
      h('div', { class: 'flyer-list' },
        list.length ? sel : h('span', { class: 'mhint', text: `Nothing saved yet. Your ${NOUN} saves as you type.` }),
        h('button', { type: 'button', class: 'iconbtn', text: '+ New', onclick: () => newFlyer() }),
        flyerId ? h('button', { type: 'button', class: 'iconbtn', text: 'Duplicate', onclick: () => newFlyer(JSON.parse(JSON.stringify(flyer))) }) : null,
        flyerId ? h('button', { type: 'button', class: 'iconbtn danger', text: 'Delete', onclick: deleteFlyer }) : null),
      h('p', { class: 'mhint', text: POSTS ? 'Duplicate is handy for next week\'s post: change the date and save the image.' : 'Duplicate is handy for next week\'s version: change the date and print.' }));
  }

  function renderEditor() {
    const root = $('fields');
    root.replaceChildren();
    const wrap = h('div', { class: 'mfields' });
    const ht = hint();
    wrap.append(listGroup() || '');

    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: `What kind of ${NOUN}?` }),
      h('p', { class: 'mhint', text: 'Picks a matching look and shows examples in the empty boxes. Your words are never changed.' }),
      h('div', { class: 'choices' }, Object.entries(STARTERS).map(([id, s]) => h('button', {
        type: 'button', class: 'choice', 'aria-pressed': String(flyer.starter === id),
        onclick: () => { flyer.starter = id; Object.assign(flyer, s.look); changed(true); },
      }, s.label)))));

    const note = STARTERS[flyer.starter].note;
    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'The message' }),
      dishPicker(),
      note ? h('p', { class: 'mcheck', text: note }) : null,
      labelled('f-head', lbl('headline', 'Headline (the one thing people should notice)'), field(flyer, 'headline', { maxlength: flyer.starter === 'review' ? '200' : '60', placeholder: ht.headline })),
      labelled('f-kicker', lbl('kicker', 'Small line above it (optional)'), field(flyer, 'kicker', { maxlength: '40', placeholder: ht.kicker })),
      labelled('f-sub', lbl('sub', 'Line under it (optional)'), field(flyer, 'sub', { maxlength: '110', placeholder: ht.sub })),
      hidden('offer') ? null : labelled('f-offer', lbl('offer', 'Price or deal, shown big (optional)'), field(flyer, 'offer', { maxlength: '32', placeholder: ht.offer || '$5 drafts' })),
      h('p', { class: 'mhint', text: `Short headlines show biggest. Anything left blank is left off the ${NOUN}.` })));

    const details = h('div', { class: 'stack' });
    flyer.details.forEach((d, i) => details.append(h('div', { class: 'mrow' },
      field(flyer.details, i, { maxlength: '70', placeholder: i ? 'Another detail' : ht.detail, 'aria-label': `Detail ${i + 1}` }),
      flyer.details.length > 1 ? h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove this detail', text: '✕', onclick: () => { flyer.details.splice(i, 1); changed(true); } }) : null)));
    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'The facts' }),
      hidden('when') ? null : labelled('f-when', lbl('when', 'When'), field(flyer, 'when', { maxlength: '60', placeholder: ht.when || 'Saturday, May 3 · 8pm' })),
      hidden('where') ? null : labelled('f-where', lbl('where', 'Where'), field(flyer, 'where', { maxlength: '80', placeholder: ht.where || 'Address' })),
      hidden('details') ? null : h('div', { class: 'choice-label', text: 'Details (short lines)' }),
      hidden('details') ? null : details,
      hidden('details') ? null : flyer.details.length < MAX_DETAILS ? h('button', { type: 'button', class: 'addbtn', text: '+ Add a detail', onclick: () => { flyer.details.push(''); changed(true); } }) : null,
      labelled('f-cta', 'What should people do? (optional)', field(flyer, 'cta', { maxlength: '60', placeholder: ht.cta })),
      labelled('f-fine', 'Fine print (optional)', field(flyer, 'fine', { maxlength: '140', placeholder: 'e.g. 21+ · While supplies last' }))));

    if (POSTS && uid) wrap.append(captionGroup());

    const b = flyer.biz;
    const logoBox = h('div');
    if (uid && window.SogilexBrand) SogilexBrand.mountLogo(logoBox, { db, uid, kit, onChange: (k) => { kit = { ...kit, ...k }; renderEditor(); renderPreview(); } });
    if (uid && photoBoxEl) {
      const sel = h('select', { class: 'mselect', id: 'f-photo', onchange: (e) => { flyer.photo = e.target.value || null; changed(); } },
        h('option', { value: '', text: 'No photo' }),
        ...photos.map((p, i) => h('option', { value: p.id, selected: flyer.photo === p.id ? true : null, text: p.name.trim() || `Photo ${i + 1}` })));
      wrap.append(h('div', { class: 'mgroup' },
        h('h3', { text: 'Photo' }),
        h('p', { class: 'mhint', text: 'One of your own photos: the dish, the band, the room. The same photos your website and menu use. Leave it out and the headline does the work.' }),
        h('div', { class: 'mrow' }, h('label', { class: 'mini', for: 'f-photo' }, `Photo on the ${NOUN}`), sel),
        photoBoxEl));
    }

    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Your business' }),
      field(b, 'name', { maxlength: '60', placeholder: 'Business name', 'aria-label': 'Business name' }),
      field(b, 'phone', { maxlength: '40', placeholder: 'Phone', 'aria-label': 'Phone' }),
      field(b, 'website', { maxlength: '80', placeholder: 'Website or @instagram', 'aria-label': 'Website' }),
      field(b, 'address', { maxlength: '100', placeholder: 'Address', 'aria-label': 'Address' }),
      h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: flyer.showBiz, onchange: (e) => { flyer.showBiz = e.target.checked; changed(); } }), 'Show the business name at the top'),
      logoBox,
      kit.logo ? h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: flyer.showLogo, onchange: (e) => { flyer.showLogo = e.target.checked; changed(); } }), 'Show my logo') : null,
      h('p', { class: 'mhint', text: 'Your logo is shared with your website and menu.' })));

    const choice = (key, value, label, extra) => h('button', {
      type: 'button', class: 'choice' + (extra && extra.cls ? ' ' + extra.cls : ''), 'aria-pressed': String(flyer[key] === value),
      style: extra && extra.style, title: extra && extra.title, onclick: () => { flyer[key] = value; changed(true); },
    }, label);
    const palettes = [...PALETTES];
    if (kit.colors && kit.colors[0]) palettes.unshift(paletteOf('logo'));
    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Look' }),
      h('p', { class: 'mhint', text: 'Every combination is designed to look good and stay easy to read from across a room.' }),
      h('div', { class: 'choice-label', text: 'Layout' }),
      h('div', { class: 'choices' }, LAYOUTS.map(([id, label]) => choice('layout', id, label))),
      h('div', { class: 'choice-label', text: 'Fonts' }),
      h('div', { class: 'choices' }, FONTS.map(([id, label, family]) => choice('font', id, label, { cls: 'font-choice', style: `font-family:${family}` }))),
      h('div', { class: 'choice-label', text: 'Colours' }),
      h('div', { class: 'choices' }, palettes.map(([id, label, bg, , , accent]) => choice('palette', id, h('span', { class: 'pal' },
        h('i', { style: `background:${bg}` }), h('i', { style: `background:${accent}` })), { cls: 'pal-choice', title: label })))));

    const q = flyer.qr;
    const qrTest = h('a', { class: 'mhint qr-test', target: '_blank', rel: 'noopener' });
    const qrCheck = () => { const u = qrUrl(q.url); qrTest.hidden = !u; if (u) { qrTest.href = u; qrTest.textContent = `Test it: ${u} ↗`; } };
    const qrInput = field(q, 'url', { maxlength: '200', placeholder: 'Web address, e.g. yourplace.com/events', 'aria-label': 'QR code web address', inputmode: 'url', autocomplete: 'off', spellcheck: 'false' });
    qrInput.addEventListener('input', qrCheck);
    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'QR code (optional)' }),
      h('p', { class: 'mhint', text: 'Prints a code that opens a web page when a phone camera points at it: tickets, booking, your menu or Instagram.' }),
      qrInput,
      field(q, 'label', { maxlength: '40', placeholder: 'Line next to it, e.g. Scan to book', 'aria-label': 'Line next to the QR code' }),
      qrTest));
    qrCheck();

    root.append(wrap);
  }

  // ---------- the flyer ----------
  function qrUrl(raw) {
    let u = (raw || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { const x = new URL(u); return /\./.test(x.hostname) && !/\s/.test(u) ? x.href : ''; } catch { return ''; }
  }
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
    svg.setAttribute('class', 'f-qr-code'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `QR code for ${url}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#ffffff');
    const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); path.setAttribute('fill', '#111111');
    svg.append(bg, path);
    return svg;
  }
  // Headline size from its length: short headlines print huge. The fit step below shrinks everything if needed.
  function headSize() {
    const n = (flyer.headline.trim() || 'Your headline').length;
    const base = flyer.size === 'square' ? 0.82 : flyer.size === 'story' ? 0.9 : 1;
    if (flyer.starter === 'review' && POSTS) { // a review reads as a quote: smaller than a headline, still big
      const q = (flyer.headline.trim() || 'x').length;
      return base * (q <= 40 ? 44 : q <= 90 ? 34 : q <= 140 ? 27 : 22);
    }
    const pt = n <= 8 ? 104 : n <= 14 ? 88 : n <= 22 ? 72 : n <= 34 ? 58 : n <= 46 ? 48 : 40;
    return pt * base;
  }
  function makeFlyer() {
    const [, , bg, ink, muted, accent] = paletteOf(flyer.palette);
    const t = (s) => (s || '').trim();
    const page = h('div', { class: ['flyer', 'size-' + flyer.size, 'font-' + flyer.font, 'layout-' + flyer.layout].join(' ') });
    page.style.setProperty('--f-bg', bg); page.style.setProperty('--f-ink', ink);
    page.style.setProperty('--f-muted', muted); page.style.setProperty('--f-accent', accent);
    page.style.setProperty('--f-on', onAccent(accent, ink, bg));
    page.style.setProperty('--hsz', headSize() + 'pt');
    const b = flyer.biz;
    const logo = kit.logo && flyer.showLogo ? h('img', { class: 'f-logo', src: kit.logo, alt: (t(b.name) || 'Business') + ' logo' }) : null;
    const brandKids = [logo ? (flyer.layout === 'block' ? h('span', { class: 'f-logo-tile' }, logo) : logo) : null,
      flyer.showBiz && t(b.name) ? h('span', { class: 'f-bizname', text: t(b.name) }) : null].filter(Boolean);
    const brand = brandKids.length ? h('div', { class: 'f-brand' }, brandKids) : null;
    const quote = POSTS && flyer.starter === 'review';
    if (quote) page.classList.add('is-quote');
    const head = t(flyer.headline);
    const hero = h('div', { class: 'f-hero' },
      t(flyer.kicker) ? h('p', { class: 'f-kicker', text: t(flyer.kicker) }) : null,
      h('h1', { class: 'f-head' + (head ? '' : ' f-empty'), text: head ? (quote ? `\u201C${head}\u201D` : head) : (quote ? 'The review goes here' : 'Your headline') }),
      t(flyer.sub) ? h('p', { class: 'f-sub', text: quote ? `\u2014 ${t(flyer.sub)}` : t(flyer.sub) }) : null);
    const offer = !hidden('offer') && t(flyer.offer) ? h('p', { class: 'f-offer', text: t(flyer.offer) }) : null;
    const rowName = (STARTERS[flyer.starter].rows || {});
    const rows = [[rowName.when || 'When', hidden('when') ? '' : flyer.when], ['Where', hidden('where') ? '' : flyer.where]].filter(([, v]) => t(v));
    const info = rows.length ? h('div', { class: 'f-info' }, rows.map(([l, v]) => h('div', { class: 'f-row' }, h('span', { class: 'f-lab', text: l }), h('span', { class: 'f-val', text: t(v) })))) : null;
    const dets = hidden('details') ? [] : flyer.details.map(t).filter(Boolean);
    const details = dets.length ? h('ul', { class: 'f-details' }, dets.map((d) => h('li', { text: d }))) : null;
    const cta = t(flyer.cta) ? h('p', { class: 'f-cta', text: t(flyer.cta) }) : null;
    const qu = qrUrl(flyer.qr.url);
    const qrEl = qu ? h('div', { class: 'f-qr' }, qrSvg(qu), t(flyer.qr.label) ? h('span', { class: 'f-qr-label', text: t(flyer.qr.label) }) : null) : null;
    const contact = [b.phone, b.website, b.address].map(t).filter(Boolean);
    const footText = [t(flyer.fine) ? h('p', { class: 'f-fine', text: t(flyer.fine) }) : null, ...contact.map((c) => h('p', { text: c }))].filter(Boolean);
    const foot = qrEl || footText.length ? h('footer', { class: 'f-foot' + (qrEl ? ' has-qr' : '') }, qrEl, footText.length ? h('div', { class: 'f-foot-text' }, footText) : null) : null;

    // Top (brand), middle (the message and facts, centred in the free space), bottom (footer).
    const inner = h('div', { class: 'f-inner' });
    const mid = h('div', { class: 'f-mid' });
    const purl = flyer.photo ? photoUrl(flyer.photo) : null;
    const photo = purl ? h('img', { class: 'f-photo', src: purl, alt: photoName(flyer.photo) || t(flyer.headline) || 'Photo' }) : null;
    if (photo) page.classList.add('has-photo');
    if (flyer.layout === 'block') inner.append(h('div', { class: 'f-band' }, brand, hero), photo || '');
    else { if (brand) inner.append(brand); mid.append(...[hero, photo].filter(Boolean)); }
    mid.append(...[offer, info, details, cta].filter(Boolean));
    inner.append(mid);
    if (foot) inner.append(foot);
    if (TRIAL()) inner.append(h('p', { class: 'f-mark', text: SogilexUpgrade.MARK }));
    page.append(inner);
    return page;
  }
  // Shrink everything a step at a time until it fits the page and no word sticks out sideways.
  const STEPS = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58];
  function fits(page) {
    const inner = page.firstChild;
    if (inner.offsetHeight > page.clientHeight + 1) return false;
    for (const el of page.querySelectorAll('.f-head, .f-offer, .f-val')) if (el.scrollWidth > el.clientWidth + 1) return false;
    return true;
  }
  function fit(page) {
    for (const s of STEPS) { page.style.setProperty('--s', String(s)); if (fits(page)) return { ok: true, s }; }
    // A single very long word: let it break rather than stick out, then try again.
    page.classList.add('f-break');
    for (const s of STEPS) { page.style.setProperty('--s', String(s)); if (fits(page)) return { ok: true, s }; }
    return { ok: false };
  }
  function scalePreview() {
    const wrapEl = $('sheet-wrap'); const sheets = $('sheets');
    const avail = wrapEl.clientWidth - 36;
    const sticky = window.matchMedia('(min-width: 901px)').matches;
    const room = sticky ? window.innerHeight - 84 - 80 - 36 : Infinity;
    const scale = Math.min(1, avail / sheets.offsetWidth, room / sheets.offsetHeight);
    sheets.style.transform = `scale(${scale})`;
    wrapEl.style.height = `${sheets.offsetHeight * scale + 36}px`;
  }
  function renderPreview() {
    const sheets = $('sheets');
    const page = makeFlyer();
    sheets.replaceChildren(page);
    sheets.style.transform = 'none';
    const r = fit(page);
    const fitEl = $('fit');
    fitEl.classList.toggle('warn', !r.ok);
    fitEl.textContent = !r.ok ? 'Too much text for this size. Shorten the headline or remove a detail.'
      : r.s < 0.8 ? 'Fits, with smaller type. Fewer words will make it easier to read from a distance.'
        : POSTS ? 'Fits. Use Save image, then post it.'
          : flyer.size === 'square' ? 'Fits. Square is for Instagram and Facebook posts: use Save image.' : 'Fits on one page.';
    $('size').value = flyer.size;
    prepareShare();
    if ($('page-size')) $('page-size').textContent = `@page { size: ${flyer.size === 'a4' ? 'A4' : flyer.size === 'square' ? '8in 8in' : 'letter'}; margin: 0; }`;
    scalePreview();
  }

  // ---------- save image (PNG) ----------
  // Draws the flyer through an SVG <foreignObject>, with its styles and fonts embedded, so the picture matches the
  // preview exactly. Square is 1080 x 1080 (Instagram); Letter and A4 come out at 150 dpi.
  const FONT_FILES = {
    'EB Garamond': [['400', 'normal', 'eb-garamond-latin-400-normal'], ['400', 'italic', 'eb-garamond-latin-400-italic'], ['600', 'normal', 'eb-garamond-latin-600-normal']],
    'Playfair Display': [['600', 'normal', 'playfair-display-latin-600-normal'], ['400', 'italic', 'playfair-display-latin-400-italic']],
    'Bebas Neue': [['400', 'normal', 'bebas-neue-latin-400-normal']],
    Fraunces: [['400', 'normal', 'fraunces-latin-400-normal'], ['400', 'italic', 'fraunces-latin-400-italic'], ['600', 'normal', 'fraunces-latin-600-normal']],
    Inter: [['400', 'normal', 'inter-latin-400-normal'], ['500', 'normal', 'inter-latin-500-normal'], ['600', 'normal', 'inter-latin-600-normal']],
    Anton: [['400', 'normal', 'anton-latin-400-normal']],
    'Alfa Slab One': [['400', 'normal', 'alfa-slab-one-latin-400-normal']],
    Rye: [['400', 'normal', 'rye-latin-400-normal']],
    Lobster: [['400', 'normal', 'lobster-latin-400-normal']],
  };
  const FAMILIES = { classic: ['EB Garamond'], elegant: ['Playfair Display', 'EB Garamond'], modern: ['Inter'], bold: ['Bebas Neue', 'Inter'], warm: ['Fraunces'],
    heavy: ['Anton', 'Inter'], slab: ['Alfa Slab One', 'Inter'], western: ['Rye', 'EB Garamond'], script: ['Lobster', 'Inter'] };
  const fontCache = {};
  const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  async function fontCss() {
    let css = '';
    for (const fam of FAMILIES[flyer.font] || []) {
      for (const [w, st, file] of FONT_FILES[fam]) {
        if (!fontCache[file]) fontCache[file] = await toDataUrl(await (await fetch(`../assets/fonts/${file}.woff2`)).blob());
        css += `@font-face{font-family:'${fam}';font-weight:${w};font-style:${st};src:url(${fontCache[file]}) format('woff2');}`;
      }
    }
    return css;
  }
  let pageCss = null;
  async function flyerCss() {
    if (pageCss === null) {
      const text = await (await fetch('../assets/flyers.css')).text();
      const a = text.indexOf('/* ===== flyer page ===== */'); const b = text.indexOf('/* ===== end flyer page ===== */');
      pageCss = text.slice(a, b);
    }
    return pageCss;
  }
  // Draws the post or flyer as a PNG (the same picture for Save image and Share).
  async function makeImage() {
    renderPreview();
    const live = $('sheets').firstChild;
    const node = live.cloneNode(true);
    const w = live.offsetWidth; const hgt = live.offsetHeight;
    const target = flyer.size === 'square' || flyer.size === 'story' ? 1080 : Math.round(w / 96 * 150);
    const k = target / w;
    const css = (await fontCss()) + (await flyerCss());
    // An image drawn this way can't load anything from elsewhere: put the photo inside it.
    for (const im of node.querySelectorAll('img')) {
      if (/^https?:/.test(im.src)) im.src = await toDataUrl(await (await fetch(im.src)).blob());
    }
    const xhtml = new XMLSerializer().serializeToString(node);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * k}" height="${hgt * k}" viewBox="0 0 ${w} ${hgt}"><foreignObject x="0" y="0" width="${w}" height="${hgt}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css.replace(/</g, '\\3c ')}</style>${xhtml}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    await new Promise((r) => setTimeout(r, 150)); // give embedded fonts a moment
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * k); canvas.height = Math.round(hgt * k);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error('no image'))), 'image/png'));
  }
  const imageName = () => `${(flyer.headline.trim() || NOUN).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || NOUN}-${flyer.size}.png`;
  async function saveImage() {
    if (window.SogilexUpgrade && !SogilexUpgrade.gate('export')) return;
    const btn = $('saveimg');
    btn.disabled = true; const was = btn.textContent; btn.textContent = 'Making image…';
    try {
      const blob = await makeImage();
      const a = h('a', { href: URL.createObjectURL(blob), download: imageName() });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch {
      alert("This browser couldn't make the image. Try Chrome or Edge, or use Print or save PDF instead.");
    } finally { btn.disabled = false; btn.textContent = was; }
  }

  // ---------- Share (Posts, on phones) ----------
  // Opens the phone's share menu with the image, so it goes straight into Instagram, Facebook or a message, and copies
  // the caption first (Instagram and Facebook don't take a caption from another app: it's pasted in).
  // A share menu only opens straight after a tap, so the image is made ahead of time, a moment after each change.
  const canShareFiles = (() => {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' })] })); } catch { return false; }
  })();
  let ready = null; let readyKey = ''; let makingKey = ''; let readyTimer = null;
  const shareKey = () => JSON.stringify([flyer, kit.logo ? kit.logo.length : 0, flyer.photo ? photoUrl(flyer.photo) : '']);
  function prepareShare() {
    if (!canShareFiles || !$('share')) return;
    clearTimeout(readyTimer);
    readyTimer = setTimeout(async () => {
      const key = shareKey();
      if (key === readyKey || key === makingKey) return;
      makingKey = key;
      try { const blob = await makeImage(); if (shareKey() === key) { ready = blob; readyKey = key; } } catch { /* made again on tap */ }
      makingKey = '';
    }, 900);
  }
  async function share() {
    if (window.SogilexUpgrade && !SogilexUpgrade.gate('export')) return;
    const fit = $('fit');
    const caption = (flyer.caption || '').trim();
    const copied = caption && navigator.clipboard ? navigator.clipboard.writeText(caption).then(() => true, () => false) : Promise.resolve(false);
    let blob = shareKey() === readyKey ? ready : null;
    if (!blob) {
      const btn = $('share'); btn.disabled = true; btn.textContent = 'Getting it ready…';
      try { blob = await makeImage(); ready = blob; readyKey = shareKey(); }
      catch { btn.disabled = false; btn.textContent = 'Share'; fit.textContent = "This phone couldn't make the image. Use Save image or Print or save PDF instead."; return; }
      btn.disabled = false; btn.textContent = 'Share';
    }
    try {
      await navigator.share({ files: [new File([blob], imageName(), { type: 'image/png' })], ...(caption ? { text: caption } : {}) });
      fit.textContent = (await copied) ? 'Shared. Your caption is copied: paste it in when you post.' : 'Shared.';
    } catch (e) {
      if (e && e.name === 'AbortError') return; // closed the share menu
      fit.textContent = e && e.name === 'NotAllowedError' ? 'Ready. Tap Share again.' : "Couldn't open sharing here. Use Save image instead.";
    }
  }

  // ---------- saving ----------
  let previewTimer = null; let saveTimer = null; let saving = null;
  function changed(rebuild) {
    if (rebuild) renderEditor();
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 120);
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200);
    if (uid) $('save-state').textContent = 'Unsaved changes';
  }
  async function save() {
    if (!uid) return;
    if (saving) await saving.catch(() => {});
    clearTimeout(saveTimer);
    $('save-state').textContent = 'Saving…';
    saving = (async () => {
      const now = new Date().toISOString();
      if (flyerId) {
        const { error } = await db.from(TABLE).update({ data: flyer, updated_at: now }).eq('id', flyerId).abortSignal(AbortSignal.timeout(10000));
        if (error) throw error;
        const row = list.find((r) => r.id === flyerId); if (row) { row.data = JSON.parse(JSON.stringify(flyer)); row.updated_at = now; }
      } else {
        const { data, error } = await db.from(TABLE).insert({ data: flyer }).select('id, data, updated_at').single().abortSignal(AbortSignal.timeout(10000));
        if (error) throw error;
        flyerId = data.id; list.unshift(data); renderEditor();
        if (window.SogilexUpgrade) SogilexUpgrade.refresh();
      }
    })();
    try { await saving; $('save-state').textContent = 'Saved'; }
    catch (e) {
      const m = (e && e.message) || '';
      const limit = / saved\. Delete|free trial includes|free trial has ended|your plan/i.test(m);
      $('save-state').textContent = limit ? m : "Couldn't save. Check your connection.";
      if (limit) UP(m);
    }
    finally { saving = null; }
  }
  const pending = () => uid && /Unsaved|Saving/.test($('save-state').textContent);
  async function flush() { if (pending()) await save(); }
  async function openFlyer(id) {
    await flush();
    const row = list.find((r) => r.id === id);
    if (!row) return;
    flyerId = id; flyer = normalize(row.data || {});
    renderEditor(); renderPreview();
  }
  async function newFlyer(copy) {
    await flush();
    flyerId = null;
    flyer = copy ? normalize(copy) : { ...blankFlyer(), size: flyer.size, biz: { ...flyer.biz }, qr: { url: '', label: '' }, showLogo: flyer.showLogo, showBiz: flyer.showBiz };
    $('save-state').textContent = '';
    if (copy) { save(); } // a duplicate is saved straight away so it shows in the list
    renderEditor(); renderPreview();
  }
  async function deleteFlyer() {
    if (!flyerId || !confirm(`Delete "${titleOf(flyer)}"? This can't be undone.`)) return;
    clearTimeout(saveTimer);
    try {
      const { error } = await db.from(TABLE).delete().eq('id', flyerId);
      if (error) throw error;
      list = list.filter((r) => r.id !== flyerId);
      if (list.length) await openFlyer(list[0].id); else { flyerId = null; flyer = { ...blankFlyer(), biz: { ...flyer.biz } }; renderEditor(); renderPreview(); }
      $('save-state').textContent = 'Deleted';
    } catch { $('save-state').textContent = "Couldn't delete it. Try again."; }
  }
  window.addEventListener('beforeunload', (e) => { if (pending()) { save(); e.preventDefault(); } });

  // ---------- start ----------
  $('size').addEventListener('change', (e) => { flyer.size = SIZES.includes(e.target.value) ? e.target.value : SIZES[0]; changed(); });
  if ($('print')) $('print').addEventListener('click', () => {
    if (window.SogilexUpgrade && !SogilexUpgrade.gate('export')) return;
    renderPreview();
    $('print-root').replaceChildren($('sheets').firstChild.cloneNode(true));
    window.print();
  });
  $('saveimg').addEventListener('click', saveImage);
  if ($('share')) {
    if (canShareFiles) { $('share').hidden = false; $('share').addEventListener('click', share); }
  }
  window.addEventListener('resize', scalePreview);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(renderPreview);
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
    $('signout').hidden = false; $('pwbtn').hidden = false;
    try {
      const { data, error } = await db.from(TABLE).select('id, data, updated_at').order('updated_at', { ascending: false }).abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      list = data || [];
      // The saved menu: its dishes for "Use a dish from my menu", and its details for a first flyer or post.
      let md = null;
      try { const { data: m } = await db.from('menus').select('data').eq('user_id', uid).maybeSingle(); md = m && m.data; } catch { /* no menu */ }
      menuDishes = dishesOf(md);
      // From the account page: ?open=<id> opens that one instead of the latest.
      const want = new URLSearchParams(location.search).get('open');
      const first = list.find((r) => r.id === want) || list[0];
      if (list.length) { flyerId = first.id; flyer = normalize(first.data || {}); $('save-state').textContent = 'Saved'; }
      else if (md) flyer.biz = { name: md.name || '', phone: (md.footer && md.footer.phone) || '', website: (md.footer && md.footer.website) || '', address: (md.footer && md.footer.address) || '' };
    } catch { $('save-state').textContent = `Couldn't load your ${NOUN}s. Refresh to try again.`; }
    $('editor').hidden = false;
    renderEditor();
    renderPreview();
  })();
})();
