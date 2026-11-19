// Sogilex Build: "Your photos". The owner's own photos for their website.
// Each photo is redrawn in the browser as a JPEG of at most 2000 px (small enough for the web, and it drops any
// hidden data such as GPS location), plus a 400 px preview that Claude looks at to place it. Both are stored
// privately in Supabase Storage (site-photos/<user>/<id>.jpg and <id>-t.jpg); the list lives in site_photos.
// Generated pages refer to a photo as sogilex:photo:<id>.
window.SogilexPhotos = (() => {
  const BUCKET = 'site-photos';
  const MAX_PHOTOS = 60;
  const MAX_SIDE = 2000;
  const THUMB_SIDE = 400;
  const MAX_INPUT_BYTES = 30 * 1024 * 1024;
  const TAG = /sogilex:photo:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
  const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }
  const path = (uid, id, thumb) => `${uid}/${id}${thumb ? '-t' : ''}.jpg`;

  async function list(db) {
    const { data, error } = await db.from('site_photos').select('id, name, width, height, created_at').order('created_at', { ascending: true }).abortSignal(AbortSignal.timeout(10000));
    if (error) throw error;
    return data || [];
  }

  // Private links (valid for an hour) for the preview. Cached, refreshed when they get old.
  let linkCache = { at: 0, uid: null, map: {} };
  async function links(db, uid, photos, force) {
    if (!photos.length) return {};
    const fresh = Date.now() - linkCache.at < 45 * 60 * 1000 && linkCache.uid === uid;
    const missing = photos.filter((p) => !linkCache.map[p.id]);
    if (!force && fresh && !missing.length) return linkCache.map;
    const ask = fresh && !force ? missing : photos;
    const paths = ask.flatMap((p) => [path(uid, p.id), path(uid, p.id, true)]);
    const { data, error } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
    if (error) throw error;
    const map = fresh && !force ? { ...linkCache.map } : {};
    (data || []).forEach((d, i) => {
      if (!d.signedUrl) return;
      const p = ask[Math.floor(i / 2)];
      if (i % 2 === 0) map[p.id] = d.signedUrl; else map[p.id + ':t'] = d.signedUrl;
    });
    linkCache = { at: fresh && !force ? linkCache.at : Date.now(), uid, map };
    return map;
  }
  // Swap every sogilex:photo:<id> for its link (or a blank image if the photo is gone).
  const fill = (text, map) => text.replace(TAG, (_, id) => map[id] || BLANK);
  const idsIn = (text) => [...new Set([...(text || '').matchAll(TAG)].map((m) => m[1]))];

  // For a downloaded or copied file: the photos go inside it, so it works anywhere.
  async function inline(text, map) {
    const ids = idsIn(text);
    const data = {};
    await Promise.all(ids.map(async (id) => {
      if (!map[id]) return;
      try {
        const blob = await (await fetch(map[id])).blob();
        data[id] = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      } catch { /* leave blank */ }
    }));
    return fill(text, data);
  }

  async function decode(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  function draw(img, side, quality) {
    const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = hgt;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, hgt); // transparent PNGs get a white background
    ctx.drawImage(img, 0, 0, w, hgt);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res({ blob: b, w, h: hgt }) : rej(new Error('encode'))), 'image/jpeg', quality));
  }
  const niceName = (fileName) => {
    const base = String(fileName || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
    return /^(img|dsc|pxl|photo|image)?\s*\d+/i.test(base) ? '' : base.slice(0, 80); // camera numbers say nothing
  };

  async function addOne(db, uid, file) {
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(file.name)) throw new Error(`${file.name} isn't a photo.`);
    if (file.size > MAX_INPUT_BYTES) throw new Error(`${file.name} is too large (over 30 MB).`);
    let img;
    try { img = await decode(file); } catch { throw new Error(`${file.name} couldn't be opened here. Try saving it as a JPG first.`); }
    const big = await draw(img, MAX_SIDE, 0.82);
    const small = await draw(img, THUMB_SIDE, 0.72);
    if (big.blob.size > 3 * 1024 * 1024) throw new Error(`${file.name} is still too large after resizing.`);
    const { data: row, error } = await db.from('site_photos')
      .insert({ name: niceName(file.name), width: big.w, height: big.h, bytes: big.blob.size })
      .select('id, name, width, height, created_at').single();
    if (error) throw new Error(/row-level security|violates/i.test(error.message) ? `You can keep up to ${MAX_PHOTOS} photos. Remove some to add more.` : "Couldn't save that photo. Please try again.");
    const up = (p, blob) => db.storage.from(BUCKET).upload(p, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '3600' });
    const [a, b] = await Promise.all([up(path(uid, row.id), big.blob), up(path(uid, row.id, true), small.blob)]);
    if (a.error || b.error) {
      await db.from('site_photos').delete().eq('id', row.id);
      await db.storage.from(BUCKET).remove([path(uid, row.id), path(uid, row.id, true)]);
      throw new Error(`${file.name} didn't upload. Check your connection and try again.`);
    }
    return row;
  }

  // The "Your photos" box. onChange(photos) runs whenever the list changes.
  function mount(root, { db, uid, onChange, onAdded }) {
    let photos = [];
    let map = {};
    const grid = h('div', { class: 'photo-grid' });
    const count = h('span', { class: 'photo-count', 'aria-live': 'polite' });
    const status = h('p', { class: 'photo-status', role: 'status', 'aria-live': 'polite' });
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: () => { add([...input.files]); input.value = ''; } });
    const drop = h('button', { type: 'button', class: 'photo-drop', onclick: () => input.click() },
      h('strong', { text: 'Add your photos' }),
      h('span', { text: 'Drag them here, or click to choose. Up to 20 at a time.' }));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); add([...(e.dataTransfer.files || [])]); });
    root.replaceChildren(drop, input, count, grid, status,
      h('p', { class: 'photo-hint', text: 'Give each photo a short name (for example "Beach wedding"). Build uses your photos when it designs a new site. To put new photos on a site you already made, use "Change your site". Photos stay private until you publish a site that uses them.' }));

    function setStatus(text, err) { status.textContent = text; status.classList.toggle('err', !!err); }
    function render() {
      count.textContent = photos.length ? `${photos.length} of ${MAX_PHOTOS} photos` : '';
      grid.replaceChildren(...photos.map((p) => {
        const name = h('input', { class: 'input photo-name', type: 'text', maxlength: '80', value: p.name, placeholder: "What's in it?", 'aria-label': 'Photo name' });
        let t = null;
        name.addEventListener('input', () => {
          p.name = name.value;
          clearTimeout(t);
          t = setTimeout(async () => {
            const { error } = await db.from('site_photos').update({ name: p.name.trim().slice(0, 80) }).eq('id', p.id);
            if (error) setStatus("Couldn't save that name. Check your connection.", true);
            else onChange && onChange(photos);
          }, 700);
        });
        return h('figure', { class: 'photo' },
          h('img', { src: map[p.id + ':t'] || map[p.id] || BLANK, alt: p.name || 'Your photo', loading: 'lazy' }),
          h('button', { type: 'button', class: 'photo-x', 'aria-label': `Remove ${p.name || 'this photo'}`, text: '✕', onclick: () => remove(p) }),
          name);
      }));
    }
    async function refresh(force) {
      try {
        photos = await list(db);
        map = await links(db, uid, photos, force);
      } catch { setStatus("Couldn't load your photos. Refresh the page to try again.", true); }
      render();
      onChange && onChange(photos);
    }
    async function add(files) {
      files = files.slice(0, 20);
      if (!files.length) return;
      const room = MAX_PHOTOS - photos.length;
      if (room <= 0) { setStatus(`You can keep up to ${MAX_PHOTOS} photos. Remove some to add more.`, true); return; }
      const todo = files.slice(0, room);
      const problems = [];
      let done = 0;
      const added = [];
      drop.disabled = true;
      for (const f of todo) {
        setStatus(`Adding photo ${done + 1} of ${todo.length}…`);
        try { added.push(await addOne(db, uid, f)); done++; } catch (e) { problems.push(e.message); }
      }
      drop.disabled = false;
      await refresh();
      const skipped = files.length - todo.length;
      const msg = [done ? `Added ${done} ${done === 1 ? 'photo' : 'photos'}.` : '', ...problems, skipped ? `${skipped} skipped: you can keep up to ${MAX_PHOTOS}.` : ''].filter(Boolean).join(' ');
      setStatus(msg, problems.length > 0 || skipped > 0);
      if (added.length && onAdded) onAdded(added);
    }
    async function remove(p) {
      if (!confirm(`Remove ${p.name ? `"${p.name}"` : 'this photo'}? Sites that use it will show an empty space there until you change them. A site that's already live keeps it until you publish again.`)) return;
      const { error } = await db.from('site_photos').delete().eq('id', p.id);
      if (error) { setStatus("Couldn't remove that photo. Please try again.", true); return; }
      await db.storage.from(BUCKET).remove([path(uid, p.id), path(uid, p.id, true)]);
      setStatus('Photo removed.');
      await refresh();
    }
    refresh();
    return { refresh, get photos() { return photos; }, get links() { return map; } };
  }

  return { mount, list, links, fill, inline, idsIn, TAG, BLANK };
})();
