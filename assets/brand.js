// Sogilex brand kit: "Add your logo here". Shared by Build (websites) and Menus.
// Any upload (PNG, JPG, WebP or SVG) is redrawn in the browser as a PNG of at most 600×300, so it's small, and an
// SVG's scripts or links never survive. The logo's main colours are picked out for one-click palettes.
// Stored in the brand_kits table (one row per person).
window.SogilexBrand = (() => {
  const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  const MAX_BYTES = 5 * 1024 * 1024;

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }

  async function load(db, uid) {
    try {
      const { data, error } = await db.from('brand_kits').select('logo, logo_name, colors').eq('user_id', uid).maybeSingle().abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      return await shrinkSaved(db, uid, data || { logo: null, logo_name: null, colors: [] });
    } catch { return { logo: null, logo_name: null, colors: [], failed: true }; }
  }
  async function save(db, uid, kit) {
    const { error } = await db.from('brand_kits').upsert({ user_id: uid, logo: kit.logo, logo_name: kit.logo_name, colors: kit.colors || [], updated_at: new Date().toISOString() }).abortSignal(AbortSignal.timeout(15000));
    if (error) throw error;
  }

  // ---------- turning a file into a small PNG ----------
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ img, url }); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file couldn't be opened as an image. Try saving your logo as a PNG.")); };
      img.src = url;
    });
  }
  function draw(img, maxW, maxH) {
    let w = img.naturalWidth || 600; let hgt = img.naturalHeight || 300;
    const scale = Math.min(maxW / w, maxH / hgt, img.naturalWidth ? 4 : 1); // small SVGs may scale up; photos don't blow up past 4×
    w = Math.max(1, Math.round(w * scale)); hgt = Math.max(1, Math.round(hgt * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = hgt;
    c.getContext('2d').drawImage(img, 0, 0, w, hgt);
    return c;
  }
  const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  function colorsOf(canvas) {
    const { width, height } = canvas;
    const px = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const buckets = new Map();
    const step = Math.max(1, Math.floor((width * height) / 40000));
    for (let i = 0; i < width * height; i += step) {
      const o = i * 4;
      if (px[o + 3] < 200) continue; // transparent
      const r = px[o], g = px[o + 1], b = px[o + 2];
      if (r > 238 && g > 238 && b > 238) continue; // white background
      const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
      const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b; buckets.set(key, e);
    }
    // Ignore colours covering under 3% of the logo: mostly blended edge pixels, not real brand colours.
    const total = [...buckets.values()].reduce((t, e) => t + e.n, 0);
    const sorted = [...buckets.values()].filter((e) => e.n >= total * 0.03).sort((a, b) => b.n - a.n).map((e) => [e.r / e.n, e.g / e.n, e.b / e.n].map(Math.round));
    const picked = [];
    for (const c of sorted) {
      if (picked.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > 70)) picked.push(c);
      if (picked.length === 4) break;
    }
    return picked.map((c) => hex(...c));
  }
  async function fileToKit(file) {
    const name = (file.name || 'logo').slice(0, 120);
    if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
      throw new Error('PDFs can\'t go on a web page directly. Open the PDF, then save or export it as a PNG (or JPG) and add that here.');
    }
    if (!OK_TYPES.includes(file.type)) throw new Error('Please use a PNG, JPG or SVG file for your logo.');
    if (file.size > MAX_BYTES) throw new Error('That file is over 5 MB. Please use a smaller version of your logo.');
    const { img, url } = await readImage(file);
    try {
      const { canvas, data } = smallest(img);
      if (data.length > 380000) throw new Error('That logo is very detailed. Please use a simpler or smaller version.');
      return { logo: data, logo_name: name, colors: colorsOf(canvas) };
    } finally { URL.revokeObjectURL(url); }
  }
  // Logos show at most about 90 px tall (and under an inch tall in print), so 480×200 is plenty, even on sharp
  // screens. Step down further until the file is light: it's loaded on every page of the owner's site.
  const SIZES = [[480, 200], [400, 168], [320, 136]];
  const LIGHT = 100000; // characters of data URL, about 75 KB of file
  function smallest(img) {
    let best = null;
    for (const [w, hgt] of SIZES) {
      const canvas = draw(img, w, hgt);
      const data = canvas.toDataURL('image/png');
      if (!best || data.length < best.data.length) best = { canvas, data };
      if (data.length <= LIGHT) break;
    }
    return best;
  }
  // Logos saved before this change can be several times bigger: shrink them once, quietly, keeping the colours.
  async function shrinkSaved(db, uid, kit) {
    if (!kit || !kit.logo || kit.logo.length <= LIGHT * 1.4) return kit;
    try {
      const img = new Image();
      img.src = kit.logo;
      await img.decode();
      const { data } = smallest(img);
      if (data.length >= kit.logo.length * 0.8) return kit;
      const next = { ...kit, logo: data };
      await save(db, uid, next);
      return next;
    } catch { return kit; }
  }

  // ---------- the "Add your logo here" box ----------
  // opts: { db, uid, kit, onChange(kit) }
  function mountLogo(root, opts) {
    let kit = opts.kit || { logo: null, logo_name: null, colors: [] };
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,.pdf', hidden: true });
    const status = h('p', { class: 'status logo-status', role: 'status', 'aria-live': 'polite' });

    async function useFile(file) {
      if (!file) return;
      status.className = 'status logo-status'; status.textContent = 'Adding your logo…';
      try {
        const next = await fileToKit(file);
        await save(opts.db, opts.uid, next);
        kit = next; render(); status.textContent = 'Logo saved. It\'s used on your website and menu.'; status.classList.add('ok');
        if (opts.onChange) opts.onChange(kit);
      } catch (err) {
        status.textContent = err.message || "Couldn't add that logo."; status.classList.add('err');
      }
    }
    input.addEventListener('change', () => { useFile(input.files[0]); input.value = ''; });

    function render() {
      root.replaceChildren();
      if (!kit.logo) {
        const zone = h('div', { class: 'logo-drop', role: 'button', tabindex: '0', 'aria-label': 'Add your logo: choose a file' },
          h('strong', { text: 'Add your logo here' }),
          h('span', { text: 'Drag a file here, or click to choose. PNG, JPG or SVG.' }));
        zone.addEventListener('click', () => input.click());
        zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('over'));
        zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); useFile(e.dataTransfer.files[0]); });
        root.append(zone, input, status);
        return;
      }
      root.append(h('div', { class: 'logo-have' },
        h('div', { class: 'logo-thumb' }, h('img', { src: kit.logo, alt: 'Your logo' })),
        h('div', { class: 'logo-meta' },
          h('span', { class: 'logo-name', text: kit.logo_name || 'Your logo' }),
          kit.colors && kit.colors.length ? h('span', { class: 'logo-colors' }, 'Its colours:', kit.colors.map((c) => h('i', { style: `background:${c}`, title: c, 'aria-label': c }))) : null,
          h('span', { class: 'logo-actions' },
            h('button', { type: 'button', class: 'linkish', text: 'Replace', onclick: () => input.click() }),
            h('button', { type: 'button', class: 'linkish', text: 'Remove', onclick: async () => {
              if (!confirm('Remove your logo from Sogilex? It will no longer appear on new builds and your menu.')) return;
              try { const none = { logo: null, logo_name: null, colors: [] }; await save(opts.db, opts.uid, none); kit = none; render(); if (opts.onChange) opts.onChange(kit); }
              catch { status.textContent = "Couldn't remove it. Try again."; status.className = 'status logo-status err'; }
            } })))), input, status);
    }
    render();
    return { get kit() { return kit; } };
  }

  // Darken a colour until it reads on a light background (WCAG contrast ≥ 4.5 against #FBF8F2).
  function readableOnLight(hexColor) {
    let [r, g, b] = [1, 3, 5].map((i) => parseInt(hexColor.slice(i, i + 2), 16));
    const lum = (x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const L = () => 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
    const bg = 0.94;
    for (let i = 0; i < 20 && (bg + 0.05) / (L() + 0.05) < 4.5; i++) { r = Math.round(r * 0.85); g = Math.round(g * 0.85); b = Math.round(b * 0.85); }
    return hex(r, g, b);
  }

  return { load, save, mountLogo, fileToKit, readableOnLight };
})();
