// Sogilex Menus (milestone 1): a form for the menu, a live print preview that fits itself to the page, and
// autosave to the person's Sogilex account. No AI: every word and price on the menu is exactly what was typed.
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
  const blankItem = () => ({ name: '', desc: '', prices: [{ label: '', amount: '' }], tags: [] });
  const blankSection = () => ({ name: '', note: '', items: [blankItem()] });
  const blankMenu = () => ({
    v: 1, name: '', tagline: '', showTagline: true, currency: '$', showCurrency: true, paper: 'letter', showLogo: true, logoColor: false,
    sections: [blankSection()], footer: { address: '', phone: '', hours: '', website: '' },
  });

  let menu = blankMenu();
  let uid = null;
  let kit = { logo: null, logo_name: null, colors: [] };

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
    return h('input', { class: 'input', type: 'text', value: obj[key] || '', ...attrs, oninput: (e) => { obj[key] = e.target.value; changed(); } });
  }
  function move(list, i, d) { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; changed(true); }

  // ---------- the form ----------
  function renderEditor() {
    const root = $('fields');
    root.replaceChildren();
    const wrap = h('div', { class: 'mfields' });

    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Restaurant' }),
      h('div', { class: 'field' }, h('label', { for: 'm-name', text: 'Name' }), field(menu, 'name', { id: 'm-name', maxlength: '60', placeholder: 'Ninth & Pine' })),
      h('div', { class: 'field' }, h('label', { for: 'm-tag', text: 'Line under the name (optional)' }), field(menu, 'tagline', { id: 'm-tag', maxlength: '80', placeholder: 'Neighbourhood kitchen' })),
      h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: menu.showTagline, onchange: (e) => { menu.showTagline = e.target.checked; changed(); } }), 'Show this line on the menu')));

    const logoBox = h('div');
    wrap.append(h('div', { class: 'mgroup' },
      h('h3', { text: 'Logo' }),
      logoBox,
      kit.logo ? h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: menu.showLogo, onchange: (e) => { menu.showLogo = e.target.checked; changed(); } }), 'Show my logo at the top of the menu') : null,
      kit.colors && kit.colors.length ? h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: menu.logoColor, onchange: (e) => { menu.logoColor = e.target.checked; changed(); } }), 'Use my logo\'s colour for section headings') : null));
    if (uid && window.SogilexBrand) SogilexBrand.mountLogo(logoBox, { db, uid, kit, onChange: (k) => { kit = k; renderEditor(); renderPreview(); } });

    menu.sections.forEach((sec, si) => {
      const items = h('div', { class: 'mitems' });
      sec.items.forEach((it, ii) => {
        const prices = it.prices.map((p, pi) => h('div', { class: 'mprice' },
          field(p, 'label', { class: 'input plabel', maxlength: '20', placeholder: it.prices.length > 1 ? 'Size' : 'Size (opt.)', 'aria-label': `Price ${pi + 1} label` }),
          field(p, 'amount', { class: 'input pamount', maxlength: '16', placeholder: '12.50', inputmode: 'decimal', 'aria-label': `Price ${pi + 1}` }),
          it.prices.length > 1 ? h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove this price', text: '✕', onclick: () => { it.prices.splice(pi, 1); changed(true); } }) : null));
        items.append(h('div', { class: 'mitem' },
          h('div', { class: 'mrow' },
            field(it, 'name', { maxlength: '60', placeholder: 'Dish name', 'aria-label': `Dish ${ii + 1} in section ${si + 1}` }),
            h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move dish up', text: '↑', onclick: () => move(sec.items, ii, -1) }),
            h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move dish down', text: '↓', onclick: () => move(sec.items, ii, 1) }),
            h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove dish', text: '✕', onclick: () => { sec.items.splice(ii, 1); changed(true); } })),
          field(it, 'desc', { maxlength: '160', placeholder: 'Short description (optional)', 'aria-label': 'Description' }),
          ...prices,
          h('div', { class: 'mrow' },
            it.prices.length < 4 ? h('button', { type: 'button', class: 'iconbtn', text: '+ another size', onclick: () => { it.prices.push({ label: '', amount: '' }); changed(true); } }) : null,
            h('div', { class: 'tags', role: 'group', 'aria-label': 'Dietary tags' }, TAGS.map(([code, label]) =>
              h('label', { class: 'mini', title: label }, h('input', { type: 'checkbox', checked: it.tags.includes(code), onchange: (e) => {
                it.tags = e.target.checked ? [...new Set([...it.tags, code])] : it.tags.filter((t) => t !== code); changed();
              } }), code))))));
      });
      wrap.append(h('div', { class: 'msec' },
        h('div', { class: 'mrow msec-head' },
          field(sec, 'name', { maxlength: '40', placeholder: 'Section, e.g. Starters', 'aria-label': `Section ${si + 1} name` }),
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move section up', text: '↑', onclick: () => move(menu.sections, si, -1) }),
          h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Move section down', text: '↓', onclick: () => move(menu.sections, si, 1) }),
          h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': 'Remove section', text: '✕', onclick: () => {
            if (sec.items.some((i) => i.name) && !confirm(`Remove the section "${sec.name || 'untitled'}" and its dishes?`)) return;
            menu.sections.splice(si, 1); changed(true);
          } })),
        field(sec, 'note', { maxlength: '100', placeholder: 'Note under the section (optional), e.g. Served with rice', 'aria-label': 'Section note' }),
        items,
        h('button', { type: 'button', class: 'addbtn', text: '+ Add a dish', onclick: () => { sec.items.push(blankItem()); changed(true); } })));
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
      field(f, 'address', { maxlength: '100', placeholder: 'Address', 'aria-label': 'Address' }),
      field(f, 'phone', { maxlength: '40', placeholder: 'Phone', 'aria-label': 'Phone' }),
      field(f, 'hours', { maxlength: '100', placeholder: 'Hours, e.g. Tue–Sun 11–9', 'aria-label': 'Hours' }),
      field(f, 'website', { maxlength: '80', placeholder: 'Website', 'aria-label': 'Website' }),
      h('p', { class: 'mhint', text: 'Anything left blank is simply left off the menu.' })));

    root.append(wrap);
  }

  // ---------- the menu page ----------
  function priceText(amount) {
    const a = (amount || '').trim();
    if (!a) return '';
    return menu.showCurrency && menu.currency && /^\d/.test(a) ? menu.currency + a : a;
  }
  function renderMenu(target) {
    target.replaceChildren();
    target.className = 'menu-page' + (menu.paper === 'a4' ? ' a4' : '');
    target.style.setProperty('--m-accent', menu.logoColor && kit.colors && kit.colors[0] ? SogilexBrand.readableOnLight(kit.colors[0]) : '#8E3B24');
    const head = h('header', { class: 'm-head' },
      kit.logo && menu.showLogo ? h('img', { class: 'm-logo', src: kit.logo, alt: (menu.name.trim() || 'Restaurant') + ' logo' }) : null,
      h('h1', { class: 'm-name', text: menu.name.trim() || 'Your restaurant' }),
      menu.showTagline && menu.tagline.trim() ? h('p', { class: 'm-tagline', text: menu.tagline.trim() }) : null,
      h('div', { class: 'm-rule' }));
    const body = h('div', { class: 'm-body' });
    const used = new Set();
    for (const sec of menu.sections) {
      const items = sec.items.filter((it) => it.name.trim());
      if (!items.length && !sec.name.trim()) continue;
      const box = h('section', { class: 'm-sec' },
        sec.name.trim() ? h('h2', { text: sec.name.trim() }) : null,
        sec.note.trim() ? h('p', { class: 'm-note', text: sec.note.trim() }) : null);
      for (const it of items) {
        it.tags.forEach((t) => used.add(t));
        const prices = it.prices.filter((p) => p.amount.trim());
        const priceEl = h('span', { class: 'm-price' });
        prices.forEach((p, i) => {
          if (i) priceEl.append(' · ');
          if (p.label.trim()) priceEl.append(h('small', { text: p.label.trim() + ' ' }));
          priceEl.append(priceText(p.amount));
        });
        box.append(h('div', { class: 'm-item' },
          h('span', { class: 'm-iname' }, it.name.trim(), it.tags.length ? h('span', { class: 'm-itags', text: it.tags.join(' · ') }) : null),
          priceEl,
          it.desc.trim() ? h('span', { class: 'm-desc', text: it.desc.trim() }) : null));
      }
      body.append(box);
    }
    if (!body.childNodes.length) body.append(h('p', { class: 'm-empty', text: 'Add a section and some dishes, and your menu appears here.' }));
    const f = menu.footer;
    const contact = [f.address, f.phone, f.website].map((x) => (x || '').trim()).filter(Boolean).join(' · ');
    const legend = TAGS.filter(([code]) => used.has(code)).map(([code, label]) => `${code} ${label}`).join(' · ');
    const foot = (contact || (f.hours || '').trim() || legend) ? h('footer', { class: 'm-foot' },
      legend ? h('p', { text: legend }) : null,
      (f.hours || '').trim() ? h('p', { text: f.hours.trim() }) : null,
      contact ? h('p', { text: contact }) : null) : null;
    target.append(head, body);
    if (foot) target.append(foot);
    return body;
  }

  // Shrink the type (never below ~10 pt) and switch to two columns until the menu fits on one page.
  const STEPS = [[1, 1], [1, 0.96], [1, 0.92], [2, 1], [2, 0.96], [2, 0.92], [2, 0.88], [2, 0.84], [2, 0.8]];
  function fit(page, body) {
    const over = () => body.scrollHeight > body.clientHeight + 1 || body.scrollWidth > body.clientWidth + 1;
    for (const [cols, s] of STEPS) {
      body.classList.toggle('two', cols === 2);
      page.style.setProperty('--s', String(s));
      if (!over()) return { ok: true, cols, s };
    }
    return { ok: false };
  }
  function scalePreview() {
    const wrapEl = $('sheet-wrap'); const page = $('sheet');
    const avail = wrapEl.clientWidth - 36;
    // On wide screens the preview stays on screen while you edit, so fit it to the window height too.
    const sticky = window.matchMedia('(min-width: 901px)').matches;
    const room = sticky ? window.innerHeight - 84 - 80 - 36 : Infinity;
    const scale = Math.min(1, avail / page.offsetWidth, room / page.offsetHeight);
    page.style.transform = `scale(${scale})`;
    wrapEl.style.height = `${page.offsetHeight * scale + 36}px`;
  }
  function renderPreview() {
    const page = $('sheet');
    const body = renderMenu(page);
    const r = fit(page, body);
    const fitEl = $('fit');
    fitEl.classList.toggle('warn', !r.ok);
    fitEl.textContent = r.ok
      ? (r.cols === 2 || r.s < 1 ? `Fits on one page${r.cols === 2 ? ', in two columns' : ''}${r.s < 1 ? `, type at ${Math.round(r.s * 100)}%` : ''}.` : 'Fits on one page.')
      : 'Too long for one page. Remove a few dishes or shorten descriptions.';
    $('paper').value = menu.paper;
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
    } catch { $('save-state').textContent = "Couldn't save. Check your connection."; }
  }
  window.addEventListener('beforeunload', (e) => { if ($('save-state').textContent !== 'Saved' && uid && $('save-state').textContent) { save(); e.preventDefault(); } });

  // ---------- start ----------
  $('paper').addEventListener('change', (e) => { menu.paper = e.target.value === 'a4' ? 'a4' : 'letter'; changed(); });
  $('print').addEventListener('click', () => {
    // Print a copy of the preview, which has already been fitted to the page (a hidden copy can't measure itself).
    renderPreview();
    const copy = $('sheet').cloneNode(true);
    copy.removeAttribute('id');
    copy.style.transform = 'none';
    $('print-root').replaceChildren(copy);
    window.print();
  });
  window.addEventListener('resize', scalePreview);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(renderPreview);

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
    $('signout').hidden = false; $('pwbtn').hidden = false;
    try {
      const { data, error } = await db.from('menus').select('data').eq('user_id', uid).maybeSingle().abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      if (data && data.data && Array.isArray(data.data.sections)) menu = { ...blankMenu(), ...data.data, footer: { ...blankMenu().footer, ...(data.data.footer || {}) } };
      $('save-state').textContent = data ? 'Saved' : '';
    } catch { $('save-state').textContent = "Couldn't load your menu. Refresh to try again."; }
    $('editor').hidden = false;
    renderEditor();
    renderPreview();
  })();
})();
