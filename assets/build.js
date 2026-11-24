// Sogilex Build: sign-in, the brief form, streaming the generated site into a sandboxed preview, download.
(() => {
  const SUPABASE_URL = 'https://sdltqbctuieyjlujsdhj.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM'; // public by design; RLS protects data
  const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/build-site`;
  const $ = (id) => document.getElementById(id);

  if (!window.supabase) { $('off').hidden = false; return; }
  // One session across all of sogilex.com (see sogilex-auth.js).
  const db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: window.SogilexAuth
      ? window.SogilexAuth.clientOptions()
      : { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  if (window.SogilexUpgrade) { SogilexUpgrade.init(db); SogilexUpgrade.trialBar('builds'); }
  const UP = (m) => !!(window.SogilexUpgrade && window.SogilexUpgrade.offer(m)); // a plan limit opens the upgrade box
  // Auth calls have no abort option, so give them an overall time limit.
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("Couldn't reach the account service. Check your connection.")), ms))]);

  let html = '';
  const adj = { on: false, changes: {}, kinds: {}, sel: null, base: '' }; // the photo adjuster (see "Adjust photos")
  let kit = { logo: null, logo_name: null, colors: [] }; // brand kit: logo + its colours
  const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  // Generated sites refer to the logo as src="sogilex:logo"; swap in the real image wherever the site is shown or saved.
  // Photos are sogilex:photo:<id>; the preview uses private links, a downloaded file gets the photos inside it.
  let photoBox = null;
  const photoLinks = () => (photoBox ? photoBox.links : {});
  const withLogo = (text) => {
    const t = text.split('sogilex:logo').join(kit.logo || BLANK_PNG);
    return window.SogilexPhotos ? SogilexPhotos.fill(t, photoLinks()) : t;
  };
  const forFile = async (text) => {
    const t = text.split('sogilex:logo').join(kit.logo || BLANK_PNG);
    return window.SogilexPhotos ? SogilexPhotos.inline(t, photoLinks()) : t;
  };
  let lastBuildId = null; // set when a build finishes; publishing uses it
  let builtOk = false;
  let siteName = '';

  // ---------- account ----------
  async function session() {
    try { const { data } = await within(db.auth.getSession(), 10000); return data.session; } catch { return null; }
  }
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
  async function showQuota() {
    try {
      const { data, error } = await db.rpc('build_quota').abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      const plan = await getPlan();
      // A plan without websites (Basics): say so up front, with the way to get them.
      if (plan && plan.builds_allowed === 0) {
        const q = $('quota'); q.textContent = `Websites aren't part of ${(plan.plan && plan.plan.name) || 'your plan'}. `;
        const a = document.createElement('a'); a.href = '../account/'; a.textContent = 'See plans'; q.append(a);
        q.classList.add('out'); return 0;
      }
      const w = leftWhen(plan);
      $('quota').textContent = data > 0 ? `${data} ${data === 1 ? 'build' : 'builds'} left ${w}` : `No builds left ${w}`;
      $('quota').classList.toggle('out', data <= 0);
      return data;
    } catch { $('quota').textContent = ''; return null; }
  }

  (async () => {
    const s = await session();
    if (s) { $('brief').hidden = false; $('signout').hidden = false; $('pwbtn').hidden = false; showQuota(); loadSite(); loadMail(); loadHours(); loadKit(s.user.id); loadBuilds(true); showEditQuota(); }
    else {
      $('signin').hidden = false;
      SogilexAuth.mountSignIn($('signin-mount'), {
        client: db,
        redirectTo: new URL('./', location.href).href,
        onSignedIn: () => location.reload(),
      });
    }
  })();

  $('pwbtn').addEventListener('click', () => {
    SogilexAuth.mountPasswordForm($('pw-mount'), { client: db });
    $('pwdialog').showModal();
  });

  $('signout').addEventListener('click', async () => {
    try { await within(db.auth.signOut(), 8000); } catch { /* local session is cleared regardless */ }
    location.reload();
  });


  // ---------- logo ----------
  async function loadKit(uid) {
    if (!window.SogilexBrand) return;
    kit = await SogilexBrand.load(db, uid);
    $('logo-field').hidden = false;
    SogilexBrand.mountLogo($('logo-mount'), { db, uid, kit, onChange: (k) => { kit = k; logoSwatches(); renderQuick(); if (html) paint(true); refreshPublish(); } });
    logoSwatches(); renderQuick();
    loadPhotos(uid);
  }
  function loadPhotos(uid) {
    if (!window.SogilexPhotos) return;
    $('photos-field').hidden = false;
    photoBox = SogilexPhotos.mount($('photos-mount'), {
      db, uid,
      onChange: (photos) => { $('use-photos-row').hidden = !photos.length; if (html) paint(true); refreshPublish(); },
      onAdded: (added) => offerNewPhotos(added),
      isOnSite: (id) => (builtOk && lastBuildId && !building && !editing ? html.includes('sogilex:photo:' + id) : null),
      onAddToSite: (list) => addPhotosToSite(list),
    });
    // Preview links last an hour: renew them before they run out.
    setInterval(() => { if (photoBox) photoBox.refresh(true); }, 40 * 60 * 1000);
  }
  // The logo's colours appear first among the accent presets.
  function logoSwatches() {
    const box = document.querySelector('.swatches');
    box.querySelectorAll('.logo-swatch').forEach((b) => b.remove());
    [...(kit.colors || [])].reverse().forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'logo-swatch'; b.style.setProperty('--c', c); b.dataset.c = c;
      b.setAttribute('aria-label', `Logo colour ${c}`); b.title = `From your logo: ${c}`;
      b.addEventListener('click', () => { $('accent').value = c.toLowerCase(); $('accent-auto').checked = false; });
      box.prepend(b);
    });
  }

  // ---------- the brief ----------
  $('desc').addEventListener('input', () => { $('desc-count').textContent = $('desc').value.length.toLocaleString(); });
  // Pro tip: copy the starter prompt for writing a description with any AI assistant.
  $('protip-copy').addEventListener('click', async () => {
    const btn = $('protip-copy'); const text = $('protip-prompt').textContent.trim();
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch { const r = document.createRange(); r.selectNodeContents($('protip-prompt')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); btn.textContent = 'Selected: press Ctrl+C (or Cmd+C)'; }
    setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2500);
  });
  document.querySelectorAll('.swatches button').forEach((b) => b.addEventListener('click', () => {
    $('accent').value = b.dataset.c; $('accent-auto').checked = false;
  }));
  $('accent').addEventListener('input', () => { $('accent-auto').checked = false; });

  // ---------- business hours (exact facts, sent to build-site apart from the description; 025_hours_and_link_preview.sql) ----------
  // Each day: Not listed (left off the site), Open (one or two time ranges, e.g. lunch and dinner) or Closed.
  // Saved to business_hours as { days: { mon: [["09:00","17:00"]] | "closed" }, note } so other tools can reuse them.
  const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
  const hoursRows = {};
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => { if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v); });
    kids.forEach((k) => k && n.append(k));
    return n;
  }
  function buildHoursRows() {
    const box = $('hours-days');
    DAYS.forEach(([key, label]) => {
      const mode = el('select', { class: 'input hours-mode', id: `h-${key}`, 'aria-label': `${label}: open, closed or not listed` });
      [['', 'Not listed'], ['open', 'Open'], ['closed', 'Closed']].forEach(([v, t]) => mode.append(el('option', { value: v, text: t })));
      const range = (n) => {
        const a = el('input', { class: 'input hours-time', type: 'time', 'aria-label': `${label} opens${n ? ' (second time)' : ''}` });
        const b = el('input', { class: 'input hours-time', type: 'time', 'aria-label': `${label} closes${n ? ' (second time)' : ''}` });
        return { wrap: el('span', { class: 'hours-range' }, a, el('span', { class: 'hours-to', text: 'to' }), b), a, b };
      };
      const r1 = range(0); const r2 = range(1);
      const add = el('button', { class: 'linkish hours-add', type: 'button', text: '+ second time' });
      const drop = el('button', { class: 'linkish hours-add', type: 'button', text: 'remove', 'aria-label': `Remove ${label}'s second time` });
      r2.wrap.append(drop);
      const times = el('div', { class: 'hours-times' }, r1.wrap, r2.wrap, add);
      const row = el('div', { class: 'hours-row' }, el('label', { class: 'hours-day', for: `h-${key}`, text: label }), mode, times);
      const r = { mode, r1, r2, add, times, two: false };
      const sync = () => {
        times.hidden = mode.value !== 'open';
        r2.wrap.hidden = !r.two; add.hidden = r.two;
      };
      r.sync = sync;
      mode.addEventListener('change', () => { if (mode.value === 'open' && !r1.a.value && !r1.b.value) { r1.a.value = '09:00'; r1.b.value = '17:00'; } sync(); hoursChanged(); });
      add.addEventListener('click', () => { r.two = true; sync(); r2.a.focus(); hoursChanged(); });
      drop.addEventListener('click', () => { r.two = false; r2.a.value = ''; r2.b.value = ''; sync(); add.focus(); hoursChanged(); });
      [r1.a, r1.b, r2.a, r2.b].forEach((i) => i.addEventListener('change', hoursChanged));
      hoursRows[key] = r; sync();
      box.append(row);
    });
  }
  // Read the form. Returns { hours, error }; hours is null when nothing was filled in.
  function readHours() {
    const days = {};
    for (const [key, label] of DAYS) {
      const r = hoursRows[key];
      if (r.mode.value === 'closed') days[key] = 'closed';
      else if (r.mode.value === 'open') {
        const ranges = [[r.r1.a.value, r.r1.b.value]];
        if (r.two && (r.r2.a.value || r.r2.b.value)) ranges.push([r.r2.a.value, r.r2.b.value]);
        for (const [a, b] of ranges) {
          if (!a || !b) return { error: `${label}: add both an opening and a closing time, or choose Closed.` };
          if (a === b) return { error: `${label}: the opening and closing times are the same.` };
        }
        days[key] = ranges;
      }
    }
    const note = $('hours-note').value.trim().slice(0, 200);
    const hours = {};
    if (Object.keys(days).length) hours.days = days;
    if (note) hours.note = note;
    return { hours: Object.keys(hours).length ? hours : null };
  }
  function fillHours(h) {
    const days = (h && h.days) || {};
    DAYS.forEach(([key]) => {
      const r = hoursRows[key]; const d = days[key];
      r.mode.value = d === 'closed' ? 'closed' : Array.isArray(d) ? 'open' : '';
      const rs = Array.isArray(d) ? d : [];
      r.r1.a.value = (rs[0] || [])[0] || ''; r.r1.b.value = (rs[0] || [])[1] || '';
      r.r2.a.value = (rs[1] || [])[0] || ''; r.r2.b.value = (rs[1] || [])[1] || '';
      r.two = rs.length > 1; r.sync();
    });
    $('hours-note').value = (h && h.note) || '';
    hoursSummary();
  }
  function hoursSummary() {
    const { hours } = readHours();
    const n = hours && hours.days ? Object.keys(hours.days).length : 0;
    $('hours-sum').textContent = !hours ? 'Not added' : n ? `${n} ${n === 1 ? 'day' : 'days'} set` : 'Note only';
  }
  let hoursTimer = null; let hoursLoaded = false;
  function hoursChanged() {
    hoursSummary();
    const st = $('hours-status'); const { error } = readHours();
    st.className = 'status' + (error ? ' err' : ''); st.textContent = error || '';
    if (error || !hoursLoaded) return;
    clearTimeout(hoursTimer); hoursTimer = setTimeout(saveHours, 900);
  }
  async function saveHours() {
    clearTimeout(hoursTimer); hoursTimer = null;
    const { hours, error } = readHours();
    if (error) return false;
    try {
      const { error: e } = await db.from('business_hours').upsert({ hours: hours || {}, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).abortSignal(AbortSignal.timeout(8000));
      if (e) throw e;
      return true;
    } catch { const st = $('hours-status'); st.className = 'status err'; st.textContent = "Couldn't save your hours to your account. They'll still be used for this build."; return false; }
  }
  async function loadHours() {
    try {
      const { data, error } = await db.from('business_hours').select('hours').maybeSingle().abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      if (data && data.hours) { fillHours(data.hours); if (readHours().hours) $('hours').open = true; }
    } catch { /* starts empty */ }
    hoursLoaded = true;
  }
  buildHoursRows();
  $('hours-note').addEventListener('input', hoursChanged);
  $('hours-copy').addEventListener('click', () => {
    const m = hoursRows.mon;
    if (!m.mode.value) { const st = $('hours-status'); st.className = 'status err'; st.textContent = 'Set Monday first, then copy it.'; m.mode.focus(); return; }
    ['tue', 'wed', 'thu', 'fri'].forEach((k) => {
      const r = hoursRows[k];
      r.mode.value = m.mode.value; r.two = m.two;
      r.r1.a.value = m.r1.a.value; r.r1.b.value = m.r1.b.value; r.r2.a.value = m.r2.a.value; r.r2.b.value = m.r2.b.value;
      r.sync();
    });
    hoursChanged();
  });

  // ---------- publishing (name.sogilex.net) ----------
  const PUBLISH_API = 'https://api.sogilex.net';
  let site = { can_publish: false, slug: null, messages: 0 };
  const slugify = (v) => (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 32);

  async function loadSite() {
    try {
      const { data, error } = await db.rpc('my_site').abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      site = data || site;
    } catch { site = { can_publish: false, slug: null, messages: 0 }; }
    refreshPublish();
    loadOwn();
  }

  // ---------- your own web address (038) ----------
  // www.yourbusiness.com instead of name.sogilex.net: Do it yourself + the $5/month add-on, or included (done-for-you
  // website plans, Team, Complimentary). The customer buys the address anywhere and adds one CNAME record pointing at
  // domains.sogilex.net; the `domains` function asks Cloudflare and keeps the state here. Sogilex doesn't sell domains.
  let own = null; // my_domain()
  async function fnCall(name, body) {
    const s = await session(); if (!s) throw new Error('Your sign-in has expired. Sign in again.');
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: PUBLISHABLE_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `That didn't work (${res.status}).`);
    return j;
  }
  const ownSay = (t, err) => { const m = $('own-status'); m.textContent = t || ''; m.className = 'status' + (err ? ' err' : t ? ' ok' : ''); };
  // The record's "Name": www for www.x.com, shop for shop.x.com, @ for the bare x.com (simple two-part endings only).
  function recordName(host) { const p = host.split('.'); return p.length > 2 ? p.slice(0, -2).join('.') : '@'; }
  async function loadOwn() {
    const box = $('own'); if (!box) return;
    if (!site.can_publish) { box.hidden = true; return; }
    try {
      const { data, error } = await db.rpc('my_domain').abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      own = data || {};
    } catch { box.hidden = true; return; }
    box.hidden = false;
    drawOwn();
    if (own.hostname && own.status === 'pending') checkOwn(true);
  }
  async function checkOwn(quiet) {
    try { const j = await fnCall('domains', { action: 'status' }); Object.assign(own, j); drawOwn(); if (!quiet) ownSay(''); }
    catch (e) { if (!quiet) ownSay(e.message, true); }
  }
  function drawOwn() {
    const body = $('own-body'); const el = (t, a, ...k) => { const n = document.createElement(t); Object.entries(a || {}).forEach(([x, v]) => { if (x === 'text') n.textContent = v; else if (x.startsWith('on')) n.addEventListener(x.slice(2), v); else n.setAttribute(x, v); }); k.forEach((c) => c != null && n.append(c)); return n; };
    const parts = [];
    if (!own.eligible) {
      if (own.plan === 'diy' && own.billing_managed) {
        parts.push(el('p', { text: 'Show your site at www.yourbusiness.com instead of a sogilex.net address. $5 a month, added to your Do it yourself plan (charged now for the rest of this month).' }),
          el('div', { class: 'own-row' }, el('button', { type: 'button', class: 'btn', text: 'Add my own address ($5/month)', onclick: (e) => addon(true, e.target) })));
      } else {
        parts.push(el('p', { text: 'Show your site at www.yourbusiness.com instead of a sogilex.net address. It comes with Do it yourself as a $5/month add-on.' }),
          el('p', {}, el('a', { href: 'account/#sec-plan', text: 'See plans' })));
      }
    } else if (!own.site) {
      parts.push(el('p', { text: 'Publish your site first, then connect your own address to it.' }));
    } else if (!own.hostname) {
      const input = el('input', { class: 'input', id: 'own-host', type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', maxlength: '253', placeholder: 'www.yourbusiness.com', 'aria-label': 'Your web address' });
      parts.push(el('p', { text: 'Buy your address from any domain seller (about $12 a year), then type it here. Use the www version, like www.yourbusiness.com.' }),
        el('form', { class: 'own-row', novalidate: '', onsubmit: (e) => { e.preventDefault(); connect(input.value, e.submitter || e.target.querySelector('button')); } }, input, el('button', { type: 'submit', class: 'btn', text: 'Connect' })));
      if (own.addon && !own.included) parts.push(el('p', { class: 'muted' }, 'Not using it? ', el('button', { type: 'button', class: 'linkish', text: 'Stop the $5 add-on', onclick: (e) => addon(false, e.target) })));
    } else {
      const h = own.hostname; const live = own.status === 'active';
      parts.push(el('p', {}, el('span', { class: 'own-state ' + (live ? 'ok' : own.status === 'failed' ? 'bad' : 'wait'), text: live ? `Live at ${h}` : own.status === 'failed' ? `${h}: didn't work` : `${h}: waiting` })));
      if (live) parts.push(el('p', {}, 'Your site is at ', el('a', { href: `https://${h}/`, target: '_blank', rel: 'noopener', text: `https://${h}` }), `. ${site.slug}.sogilex.net now forwards there.`));
      else {
        parts.push(el('p', { text: own.detail || 'Add this record where you bought your address (its DNS settings):' }),
          el('table', { class: 'own-rec' }, el('thead', {}, el('tr', {}, el('th', { text: 'Type' }), el('th', { text: 'Name' }), el('th', { text: 'Value / target' }))),
            el('tbody', {}, el('tr', {}, el('td', {}, el('code', { text: 'CNAME' })), el('td', {}, el('code', { text: recordName(h) })), el('td', {}, el('code', { text: own.target || 'domains.sogilex.net' }))))),
          el('p', { class: 'muted', text: recordName(h) === 'www' ? `Also set ${h.slice(4)} (without www) to forward to https://${h}: most domain sellers call it "URL forwarding" or "redirect".` : "Most domain sellers can't point the bare address (without www) here. If yours can't, use the www version instead." }),
          el('div', { class: 'own-row' }, el('button', { type: 'button', class: 'ghost', text: 'Check again', onclick: async (e) => { e.target.disabled = true; ownSay('Checking…'); await checkOwn(false); e.target.disabled = false; } })));
      }
      parts.push(el('p', { class: 'muted' }, el('button', { type: 'button', class: 'linkish', text: 'Disconnect this address', onclick: (e) => disconnect(e.target) })));
    }
    body.replaceChildren(...parts);
  }
  async function connect(value, btn) {
    if (btn) btn.disabled = true; ownSay('Connecting…');
    try { const j = await fnCall('domains', { action: 'connect', hostname: value }); Object.assign(own, j); drawOwn(); ownSay('Added. Now add the record above where you bought your address.'); }
    catch (e) { ownSay(e.message, true); if (btn) btn.disabled = false; }
  }
  async function disconnect(btn) {
    if (!confirm(`Disconnect ${own.hostname}? Your site stays at ${site.slug}.sogilex.net.`)) return;
    btn.disabled = true;
    try { await fnCall('domains', { action: 'remove' }); own.hostname = null; own.status = null; drawOwn(); ownSay('Disconnected.'); }
    catch (e) { ownSay(e.message, true); btn.disabled = false; }
  }
  async function addon(on, btn) {
    if (!on && !confirm('Stop the $5 add-on? Your own address will stop working.')) return;
    btn.disabled = true; ownSay(on ? 'Adding it to your plan…' : 'Stopping it…');
    try { await fnCall('billing', { action: 'domain_addon', on }); await loadOwn(); ownSay(on ? 'Added. Now connect your address.' : 'Stopped.'); }
    catch (e) { ownSay(e.message, true); btn.disabled = false; }
  }
  // Plans without publishing (the free trial): say how to get it. Beta includes publishing (024).
  async function showPlanNote() {
    const p = await getPlan();
    let note = $('plan-note');
    const show = !site.can_publish && p && p.plan && p.plan.id !== 'beta';
    if (!show) { if (note) note.hidden = true; return; }
    if (!note) {
      note = document.createElement('p'); note.id = 'plan-note'; note.className = 'status plan-note';
      note.append('Publishing your site at your-name.sogilex.net comes with the Do it yourself plan. ');
      const a = document.createElement('a'); a.href = 'account/#sec-plan'; a.textContent = 'See plans'; note.append(a);
      $('publish').after(note);
    }
    note.hidden = false;
  }
  function refreshPublish() {
    $('publish').hidden = !site.can_publish;
    showPlanNote();
    if (!site.can_publish) return;
    const live = !!site.slug;
    $('pub-live').hidden = !live;
    if (live) {
      const url = `https://${site.slug}.sogilex.net/`;
      $('pub-link').href = url; $('pub-link').textContent = `${site.slug}.sogilex.net`;
      $('pub-count').textContent = String(site.messages || 0);
    }
    if (!$('pub-slug').value) $('pub-slug').value = site.slug || slugify($('name').value);
    const cur = builds.find((b) => b.build_id === lastBuildId);
    const isLive = !!(cur && cur.live);
    renderOg();
    const ogChanged = isLive && ogEffective() !== (site.preview || 'auto');
    $('pub-go').disabled = !(builtOk && lastBuildId) || (isLive && !ogChanged);
    $('pub-go').textContent = ogChanged ? 'Update link preview' : isLive ? 'This version is live' : live ? 'Publish this version' : 'Publish this site';
    showBlanks(isLive);
    $('pub-hint').textContent = !(builtOk && lastBuildId) ? 'Build a site first, then publish it here.'
      : ogChanged ? 'Your site stays the same; only the link preview picture changes.'
        : isLive ? 'What you see here is what visitors see.'
          : live ? `This replaces what's live at ${site.slug}.sogilex.net.` : 'Your site goes live at this address in a few seconds.';
  }

  // ---------- blanks left on the page ([PHONE NUMBER], [PRICE]...) ----------
  // Build leaves a [PLACEHOLDER] for any fact it wasn't given. Published as they are, visitors and Google see them, so
  // the Publish box says how many are left (visible text, phone/email links, the page title and description) and
  // offers Edit words, which has a box for each one. Publishing with blanks asks first.
  const BLANK = /\[[^\]\n]{2,48}\]/g;
  function blanksIn(src) {
    if (!src) return { count: 0, names: [] };
    const d = new DOMParser().parseFromString(src, 'text/html');
    const found = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) found.push(...(c.nodeValue.match(BLANK) || []));
        else if (c.nodeType === 1 && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(c.tagName)) walk(c);
      }
    };
    if (d.body) walk(d.body);
    d.querySelectorAll('a[href^="tel:"], a[href^="mailto:"]').forEach((a) => {
      const inText = (a.textContent.match(BLANK) || []).length;
      if (!inText) found.push(...(decodeURIComponent(a.getAttribute('href')).match(BLANK) || []));
    });
    if (d.title) found.push(...(d.title.match(BLANK) || []));
    const desc = d.querySelector('meta[name="description"]'); if (desc) found.push(...((desc.getAttribute('content') || '').match(BLANK) || []));
    return { count: found.length, names: [...new Set(found)] };
  }
  let blanks = { count: 0, names: [] };
  function showBlanks(isLive) {
    blanks = builtOk && lastBuildId ? blanksIn(html) : { count: 0, names: [] };
    const box = $('pub-blanks');
    box.hidden = !blanks.count;
    if (!blanks.count) return;
    const like = blanks.names.slice(0, 2).join(' and ');
    $('pub-blanks-text').textContent = `${isLive ? 'Your live site still shows' : 'This version still shows'} ${blanks.count} ${blanks.count === 1 ? 'blank' : 'blanks'}, like ${like}. Visitors and Google see ${blanks.count === 1 ? 'it' : 'them'} exactly like that. Fill in your real details${isLive ? ', then publish again' : ' before you publish'}.`;
  }
  // Straight to the fill-in boxes: open Edit words, and once the page is ready, the first blank.
  $('pub-blanks-fix').addEventListener('click', () => {
    startWords();
    const f = $('frame'); const ready = f.onload;
    if (!words.on || !ready) return;
    f.onload = (e) => { ready(e); words.phAt = 0; phNext(false); };
    $('words-bar').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // ---------- link preview picture (Open Graph; the Worker adds the tags when publishing) ----------
  // 'auto' = the first of your photos on the page, else your logo; 'logo'; or one photo's id.
  let ogChoice = 'auto';
  let ogLoaded = false;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  function ogResolve(choice) {
    const photos = photoBox ? photoBox.photos : [];
    if (UUID_RE.test(choice) && photos.some((p) => p.id === choice)) return { kind: 'photo', id: choice };
    if (choice === 'logo') return kit.logo ? { kind: 'logo' } : { kind: 'none' };
    const first = window.SogilexPhotos ? SogilexPhotos.idsIn(html).find((id) => photos.some((p) => p.id === id)) : null;
    if (first) return { kind: 'photo', id: first };
    return kit.logo ? { kind: 'logo' } : { kind: 'none' };
  }
  // A chosen photo that was removed, or a logo that's gone, counts as automatic. (The saved choice itself is kept:
  // the photo list may simply not have loaded yet.)
  function ogEffective() {
    const photos = photoBox ? photoBox.photos : [];
    if (UUID_RE.test(ogChoice) && !photos.some((p) => p.id === ogChoice)) return 'auto';
    if (ogChoice === 'logo' && !kit.logo) return 'auto';
    return ogChoice;
  }
  function renderOg() {
    const box = $('og-choices'); if (!box) return;
    const photos = photoBox ? photoBox.photos : [];
    const links = photoLinks();
    if (!ogLoaded && site.preview) { ogChoice = site.preview; ogLoaded = true; }
    const choice = ogEffective();
    const opts = [{ v: 'auto', label: 'Automatic', sub: 'First photo on your site' }];
    if (kit.logo) opts.push({ v: 'logo', label: 'Your logo', img: kit.logo, logo: true });
    photos.forEach((p, i) => opts.push({ v: p.id, label: (p.name || '').trim() || `Photo ${i + 1}`, img: links[p.id + ':t'] || links[p.id] }));
    box.replaceChildren(...opts.map((o) => {
      const input = el('input', { type: 'radio', name: 'og', value: o.v });
      input.checked = o.v === choice;
      input.addEventListener('change', () => { ogChoice = o.v; refreshPublish(); });
      const pic = o.img ? el('img', { src: o.img, alt: '', class: o.logo ? 'og-logo' : '' }) : el('span', { class: 'og-auto', text: 'Auto' });
      return el('label', { class: 'og-choice', title: o.label }, input, el('span', { class: 'og-tile' }, pic), el('span', { class: 'og-label', text: o.label }));
    }));
    // The card: roughly what a shared link looks like.
    const r = ogResolve(choice);
    const img = $('og-img'); img.replaceChildren(); img.className = 'og-img';
    if (r.kind === 'photo' && (links[r.id] || links[r.id + ':t'])) img.append(el('img', { src: links[r.id] || links[r.id + ':t'], alt: '' }));
    else if (r.kind === 'logo') { img.classList.add('is-logo'); img.append(el('img', { src: kit.logo, alt: '' })); }
    else img.classList.add('is-none');
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    $('og-title').textContent = decode(title) || siteName || 'Your site';
    $('og-host').textContent = `${slugify($('pub-slug').value) || site.slug || 'your-business'}.sogilex.net`;
    $('og-note').textContent = r.kind === 'none'
      ? 'No picture yet: add a photo to your site or a logo, or pick one of your photos above. Shared links will show just the name.'
      : choice === 'auto' && r.kind === 'logo' ? 'This version has none of your photos, so your logo is used.'
        : 'Apps can take a day or so to show a new picture for a link they have seen before.';
  }
  async function publishCall(path, body) {
    const s = await session();
    if (!s) throw new Error('Your sign-in has expired. Sign in again.');
    const res = await fetch(PUBLISH_API + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000),
    });
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error(data.error || `Publishing failed (${res.status}).`);
    return data;
  }
  $('pub-slug').addEventListener('input', () => { const v = slugify($('pub-slug').value); if (v !== $('pub-slug').value) $('pub-slug').value = v; $('og-host').textContent = `${v || 'your-business'}.sogilex.net`; });
  $('pub-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = $('pub-status'); st.className = 'status';
    const slugValue = slugify($('pub-slug').value);
    if (slugValue.length < 3) { st.textContent = 'Choose an address of at least 3 letters or numbers.'; st.classList.add('err'); $('pub-slug').focus(); return; }
    if (blanks.count && !confirm(`This version still shows ${blanks.count} ${blanks.count === 1 ? 'blank' : 'blanks'}, like ${blanks.names[0]}. Visitors will see ${blanks.count === 1 ? 'it' : 'them'} as written. Publish anyway?`)) return;
    $('pub-go').disabled = true; st.textContent = 'Publishing…';
    try {
      let out = await publishCall('/publish', { build_id: lastBuildId, slug: slugValue, preview: ogEffective() });
      // Sites with many new photos are copied in rounds (at most 45 new photos each): keep going until all are there.
      for (let round = 0; out.more && round < 4; round++) {
        st.textContent = 'Copying the rest of your photos…';
        out = await publishCall('/publish', { build_id: lastBuildId, slug: slugValue, preview: ogEffective() });
      }
      st.innerHTML = ''; st.append('Live at ', Object.assign(document.createElement('a'), { href: out.url, target: '_blank', rel: 'noopener', textContent: out.url }), '. It can take a minute to appear the very first time.');
      st.classList.add('ok');
      await loadSite(); loadBuilds(false);
    } catch (err) { st.textContent = err.message; st.classList.add('err'); refreshPublish(); UP(err.message); }
  });
  $('pub-off').addEventListener('click', async () => {
    if (!confirm(`Take ${site.slug}.sogilex.net offline? You can publish again any time.`)) return;
    const st = $('pub-status'); st.className = 'status'; st.textContent = 'Taking it offline…';
    try { await publishCall('/unpublish'); st.textContent = 'Your site is offline.'; st.classList.add('ok'); await loadSite(); loadBuilds(false); }
    catch (err) { st.textContent = err.message; st.classList.add('err'); }
  });
  // ---------- email new messages to the owner (Edge Function message-email) ----------
  const MAIL_URL = `${SUPABASE_URL}/functions/v1/message-email`;
  function mailSay(text, cls) { const el = $('mail-state'); el.textContent = text; el.className = 'hint-line' + (cls ? ' ' + cls : ''); }
  async function loadMail() {
    try {
      const { data, error } = await db.from('message_emails').select('email, confirmed_at').maybeSingle().abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      if (data) {
        $('mail-to').value = data.email;
        if (data.confirmed_at) mailSay(`New messages are emailed to ${data.email}. Clear the box and save to stop.`, 'ok');
        else mailSay(`Waiting for ${data.email} to confirm. Open the email we sent there (check spam too) and press Confirm.`);
      } else {
        const s = await session();
        if (s && s.user && s.user.email && !$('mail-to').value) $('mail-to').value = s.user.email;
      }
    } catch { /* keeps the default hint */ }
  }
  $('mail-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('mail-to').value.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { mailSay("That doesn't look like an email address.", 'err'); $('mail-to').focus(); return; }
    $('mail-go').disabled = true; mailSay('Saving…');
    try {
      const s = await session();
      if (!s) throw new Error('Your sign-in has expired. Sign in again.');
      const res = await fetch(MAIL_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', email }), signal: AbortSignal.timeout(20000),
      });
      let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
      if (!res.ok) throw new Error(data.error || `Couldn't save that (${res.status}).`);
      if (!data.email) mailSay('Turned off. Messages still show up here in Build.', 'ok');
      else if (data.confirmed) mailSay(`Done. New messages are emailed to ${data.email}.`, 'ok');
      else mailSay(`Almost done: we sent a confirmation email to ${data.email}. Open it (check spam too) and press Confirm. Until then, messages only show up here.`);
    } catch (err) { mailSay(err.message || "Couldn't save that. Try again.", 'err'); }
    finally { $('mail-go').disabled = false; }
  });
  $('pub-messages').addEventListener('click', async () => {
    const list = $('msg-list'); list.textContent = 'Loading…';
    $('msgdialog').showModal();
    try {
      const { data, error } = await db.from('site_messages').select('created_at, slug, fields').order('created_at', { ascending: false }).limit(100).abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      list.textContent = '';
      if (!data.length) { list.textContent = 'No messages yet. When someone uses the contact form on your site, it shows up here.'; return; }
      for (const m of data) {
        const box = document.createElement('div'); box.className = 'msg';
        const t = document.createElement('time'); t.dateTime = m.created_at; t.textContent = new Date(m.created_at).toLocaleString() + ' · ' + m.slug + '.sogilex.net';
        const dl = document.createElement('dl');
        for (const [k, v] of Object.entries(m.fields || {})) {
          const dt = document.createElement('dt'); dt.textContent = k;
          const dd = document.createElement('dd'); dd.textContent = v;
          dl.append(dt, dd);
        }
        box.append(t, dl); list.append(box);
      }
    } catch { list.textContent = "Couldn't load messages. Try again in a moment."; }
  });

  // ---------- your sites (every finished build is kept; reopen any of them) ----------
  let builds = [];
  const decode = (t) => new DOMParser().parseFromString(t || '', 'text/html').body.textContent.trim();
  const short = (t) => (t.length > 48 ? t.slice(0, 46).trimEnd() + '…' : t);
  const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  async function loadBuilds(openLatest) {
    try {
      const { data, error } = await db.rpc('my_builds').abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      builds = data || [];
    } catch { return; }
    const sel = $('ver');
    sel.replaceChildren(...builds.map((b) => {
      const o = document.createElement('option');
      o.value = b.build_id;
      const note = b.kind === 'edit' || b.kind === 'manual' ? ` · ${short(b.note || 'edited')}` : '';
      o.textContent = `${decode(b.title) || 'Untitled site'} · ${when(b.created_at)}${note}${b.live ? ' · live' : ''}`;
      return o;
    }));
    $('versions').hidden = !builds.length;
    if (lastBuildId && builds.some((b) => b.build_id === lastBuildId)) sel.value = lastBuildId;
    refreshEdit(); refreshPublish();
    // Coming back to Build: show the latest site straight away, unless a build is already on screen.
    if (openLatest && builds.length && !html) {
      // From the account page: ?open=<build id> opens that version instead of the latest.
      const want = new URLSearchParams(location.search).get('open');
      const pick = builds.find((b) => b.build_id === want);
      if (pick) {
        await openBuild(pick.build_id);
        const st = $('build-status'); st.className = 'status ok';
        st.textContent = `Opened from your account: the version from ${when(pick.created_at)}. To change it, type in "Change your site" above the preview.`;
        return;
      }
      await openBuild(builds[0].build_id);
      const st = $('build-status'); st.className = 'status ok';
      st.textContent = `This is your latest site, from ${when(builds[0].created_at)}. To change it, type in "Change your site" above the preview. You can also pick another version there, or build a new one.`;
    }
  }
  async function openBuild(id, keepChat) {
    const st = $('build-status');
    try {
      const { data, error } = await db.rpc('my_build', { p_build_id: id }).abortSignal(AbortSignal.timeout(15000));
      if (error || !data) throw error || new Error('missing');
      const b = builds.find((x) => x.build_id === id);
      html = data; lastBuildId = id; builtOk = true;
      siteName = decode(b && b.title).split(/\s[|·–—-]\s/)[0] || '';
      $('addr').textContent = `${slug(siteName)}.html`;
      $('ver').value = id;
      paint(true); setDone(true);
      $('pub-status').textContent = ''; $('pub-status').className = 'status';
      refreshPublish();
      st.className = 'status'; st.textContent = '';
      if (!keepChat) { chat = []; renderChat(); }
      refreshEdit();
    } catch {
      st.className = 'status err'; st.textContent = "Couldn't open that site. Check your connection and try again.";
    }
  }
  $('ver').addEventListener('change', (e) => openBuild(e.target.value));

  // ---------- change your site (chat edits; each change is saved as a new version) ----------
  const EDIT_URL = `${SUPABASE_URL}/functions/v1/edit-site`;
  let chat = []; // [{ role: 'owner' | 'sogilex', text, err }] for the site on screen
  let editing = false;
  let building = false;
  function bubble(role, text, cls) {
    const d = document.createElement('div');
    d.className = `bubble ${role}${cls ? ' ' + cls : ''}`;
    d.textContent = text;
    $('chatlog').append(d);
    $('chatlog').scrollTop = $('chatlog').scrollHeight;
    return d;
  }
  function renderChat() { $('chatlog').replaceChildren(); chat.forEach((m) => bubble(m.role, m.text, m.err ? 'err' : '')); }
  function refreshEdit() {
    $('editchat').hidden = !(builtOk && lastBuildId) || building;
    document.body.classList.toggle('has-site', !!(builtOk && lastBuildId));
    const b = builds.find((x) => x.build_id === lastBuildId);
    $('undo').hidden = !(b && b.parent_id && builds.some((x) => x.build_id === b.parent_id)) || editing;
    renderQuick();
  }
  function setEditBusy(on) {
    editing = on;
    $('edit-go').disabled = on; $('edit-msg').disabled = on; $('ver').disabled = on || building;
    $('go').disabled = on || building;
    $('edit-go').textContent = on ? 'Working…' : 'Make this change';
    refreshEdit();
    if (photoBox) photoBox.render();
  }
  // Quick changes: one-click requests sent through the same edit system (each is one edit, saved as a version).
  const KEEP = ' Keep every word, every section, the layout and the images exactly as they are.';
  const QUICK = [
    ['Serif fonts', 'Change the fonts to a classic serif look: a serif for headings (for example Georgia, "Times New Roman", serif) and a very readable body font. System fonts only.' + KEEP],
    ['Sans-serif fonts', 'Change the fonts to a clean modern sans-serif look (for example system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif) for headings and body. System fonts only.' + KEEP],
    ['Darker look', 'Switch the colours to a dark scheme: dark backgrounds, light text, keep the accent colour (adjust its shade only if needed for contrast). Every text must keep WCAG AA contrast.' + KEEP],
    ['Lighter look', 'Switch the colours to a light scheme: light backgrounds, dark text, keep the accent colour (adjust its shade only if needed for contrast). Every text must keep WCAG AA contrast.' + KEEP],
    ['Bigger headline', 'Make the main headline at the top of the page noticeably bigger and bolder, and make sure it still fits on a 360px-wide phone without breaking words.' + KEEP],
    ['More breathing room', 'Add more white space: more space between sections and around headings and paragraphs, so the page feels calmer and easier to read.' + KEEP],
    ['Simpler', 'Make the design simpler and calmer: remove decorative effects such as gradients, shadows, glows, patterns and animations, and use at most two colours plus neutrals.' + KEEP],
    ['Use my logo colours', null],
  ];
  function renderQuick() {
    const box = $('quick-btns');
    if (!box) return;
    box.replaceChildren();
    for (const [label, msg] of QUICK) {
      let text = msg;
      if (!text) {
        const cs = (kit.logo && kit.colors) || [];
        if (!cs.length) continue;
        text = `Rebuild the colour scheme around my logo's colours: ${cs.join(', ')}. Use them for the accent, buttons and highlights; adjust shades only where needed so every text keeps WCAG AA contrast.` + KEEP;
      }
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = label; btn.disabled = editing || building;
      btn.addEventListener('click', () => sendEdit(label, text));
      box.append(btn);
    }
  }
  async function showEditQuota() {
    try {
      const { data, error } = await db.rpc('edit_quota').abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      const w = leftWhen(await getPlan());
      $('edit-quota').textContent = data > 0 ? `${data} ${data === 1 ? 'edit' : 'edits'} left ${w}` : `No edits left ${w}`;
      $('edit-quota').classList.toggle('out', data <= 0);
    } catch { $('edit-quota').textContent = ''; }
  }
  $('edit-msg').addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter makes a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('edit-form').requestSubmit(); }
  });
  $('edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = $('edit-msg').value.trim();
    if (msg.length < 2) { $('edit-msg').focus(); return; }
    sendEdit(msg, msg);
  });
  // Photos added while a site is open: offer to put them on the site with one click.
  function offerNewPhotos(added) {
    if (!(builtOk && lastBuildId) || building) return;
    const names = added.map((p) => (p.name || '').trim()).filter(Boolean);
    const n = added.length;
    const what = n === 1 ? (names[0] ? `"${names[0]}"` : 'your new photo') : `your ${n} new photos`;
    const box = bubble('sogilex', `Saved ${what}. Want ${n === 1 ? 'it' : 'them'} on this site too?`);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn chat-action';
    btn.textContent = n === 1 ? 'Add it to my site' : 'Add them to my site';
    btn.addEventListener('click', () => { btn.remove(); addPhotosToSite(added); });
    box.append(document.createElement('br'), btn);
    $('editchat').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // Put these photos on the open site, as a chat edit that names exactly which photos.
  function addPhotosToSite(added) {
    if (editing || building || !lastBuildId || !added.length) return;
    const n = added.length;
    const one = (added[0].name || '').trim();
    {
      const display = n === 1 ? `Add ${one ? `"${one}"` : 'this photo'} to my site.` : `Add these ${n} photos to my site.`;
      // Name the new photos by tag so Claude can't mix them up; keep the request under the 1,000-character limit.
      const lead = `${display} Put ${n === 1 ? 'it' : 'them'} with my other photos on the page (or wherever ${n === 1 ? 'it fits' : 'they fit'} best). The ${n === 1 ? 'photo is' : 'photos are'}: `;
      let list = added.map((p) => `sogilex:photo:${p.id}${p.name ? ` ("${p.name.replace(/["<>]/g, '').slice(0, 40)}")` : ''}`);
      if ((lead + list.join(', ')).length > 990) list = added.map((p) => `sogilex:photo:${p.id}`);
      while (list.length && (lead + list.join(', ')).length > 990) list.pop();
      sendEdit(display, lead + list.join(', ') + '.');
    }
    $('editchat').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  async function sendEdit(display, msg) {
    if (editing || building || !lastBuildId) return;
    document.querySelectorAll('#chatlog .chat-action').forEach((b) => b.remove()); // old offers would be out of date
    const s = await session();
    if (!s) { bubble('sogilex', 'Your sign-in expired. Reload the page and sign in again.', 'err'); return; }
    const history = chat.filter((m) => !m.err).slice(-8).map(({ role, text }) => ({ role, text }));
    chat.push({ role: 'owner', text: display }); bubble('owner', display);
    $('edit-msg').value = '';
    const wait = bubble('sogilex', 'Working on it. This usually takes under a minute.', 'working');
    setEditBusy(true);
    let result = null; let failed = null;
    try {
      const res = await fetch(EDIT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: PUBLISHABLE_KEY },
        body: JSON.stringify({ build_id: lastBuildId, message: msg, history }),
      });
      if (!res.ok || !res.body) {
        let m = `That change didn't work (${res.status}).`;
        try { const j = await res.json(); if (j.error) m = j.error; } catch { /* not JSON */ }
        throw new Error(m);
      }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const lineText = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!lineText.trim()) continue;
          const m = JSON.parse(lineText);
          if (m.t === 'done') result = m; else if (m.t === 'error') failed = m.message;
        }
      }
      if (!result && !failed) failed = 'The connection dropped before the change was finished. Please try again.';
    } catch (err) { failed = (err && err.message) || 'Something went wrong. Please try again.'; }
    wait.remove();
    if (failed) { chat.push({ role: 'sogilex', text: failed, err: true }); bubble('sogilex', failed, 'err'); UP(failed); }
    else {
      chat.push({ role: 'sogilex', text: result.reply }); bubble('sogilex', result.reply);
      if (result.build_id && result.html) {
        html = result.html; lastBuildId = result.build_id; builtOk = true;
        paint(true); setDone(true);
        $('pub-status').textContent = ''; $('pub-status').className = 'status';
        await loadBuilds(false);
      }
    }
    setEditBusy(false);
    showEditQuota();
    $('edit-msg').focus();
  }
  $('undo').addEventListener('click', async () => {
    const b = builds.find((x) => x.build_id === lastBuildId);
    if (!b || !b.parent_id) return;
    await openBuild(b.parent_id, true);
    const t = 'Went back to the version before that change.';
    chat.push({ role: 'sogilex', text: t }); bubble('sogilex', t);
  });

  // ---------- preview ----------
  let paintTimer = null;
  function paint(final) {
    if (adj.on || words.on) return; // Adjust photos / Edit words own the preview until saved or cancelled
    const doc = withLogo(final ? html : html + '\n</body></html>');
    $('frame').srcdoc = doc;
    $('empty').hidden = html.length > 0;
    $('size').textContent = html ? `${(new Blob([html]).size / 1024).toFixed(1)} KB` : '';
    if (photoBox) photoBox.render();
  }
  function schedulePaint() { if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = null; paint(false); }, 700); }
  const slug = (s) => (s || 'my-site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'my-site';
  function setDone(enabled) {
    ['download', 'copy', 'newtab'].forEach((id) => { $(id).disabled = !enabled; });
    $('adjust').disabled = !(enabled && html.includes('sogilex:photo:'));
    $('words').disabled = !(enabled && lastBuildId);
  }

  // ---------- Edit by hand: Adjust photos and Edit words (no AI) ----------
  // Both save a new version with save_manual_version (022): no AI, so they don't use a change or a build, and Undo goes
  // back. The preview still runs no code: while editing, the frame is sandboxed with allow-same-origin only (no
  // allow-scripts), so Build can reach the page but the page can't run anything.
  // Changes are worked out in the live preview, then applied to a fresh copy of the saved page (matched by position),
  // so the private photo links shown in the preview never end up in the saved page.
  const isPhoto = (im) => /^sogilex:photo:/.test(im.getAttribute('src') || '');
  const photoImgs = (d) => [...d.querySelectorAll('img')].filter(isPhoto);
  const clampPct = (v) => Math.max(0, Math.min(100, v));
  const setAdjMsg = (t, err) => { const m = $('adjust-msg'); m.textContent = t; m.classList.toggle('err', !!err); };
  function serialize(d) { return '<!doctype html>\n' + d.documentElement.outerHTML; }
  const handOn = () => adj.on || words.on;
  function handStart(mode) {
    const f = $('frame');
    f.setAttribute('sandbox', 'allow-same-origin');
    ['download', 'copy', 'newtab', 'adjust', 'words', 'edit-go'].forEach((id) => { if ($(id)) $(id).disabled = true; });
    $(mode + '-bar').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return f;
  }
  function handStop(mode) {
    const f = $('frame'); f.onload = null; f.setAttribute('sandbox', '');
    $(mode + '-bar').hidden = true;
    if ($('edit-go')) $('edit-go').disabled = false;
    paint(true); setDone(builtOk);
  }
  async function saveManual(out, note, okText, onErr) {
    try {
      const { data, error } = await db.rpc('save_manual_version', { p_parent: lastBuildId, p_html: out, p_note: note }).abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      return data;
    } catch (e) {
      onErr((e && e.message && !/fetch|network|timeout|abort/i.test(e.message)) ? e.message : "Couldn't save. Check your connection and try again.");
      return null;
    }
  }
  async function afterManualSave(id, text) {
    await loadBuilds(false);
    await openBuild(id, true);
    const st = $('build-status'); st.className = 'status ok'; st.textContent = text;
  }
  // Animations, hover zooms and transitions are switched off while editing, so what you drag is what stays.
  const CALM = '*{animation:none!important;transition:none!important}';

  // ----- Adjust photos -----
  // Click a photo, choose its frame shape (the site's design often puts every photo in the same wide frame, which cuts
  // off portraits), zoom in to crop it tighter, and drag to choose what part shows. Three kinds of photo:
  //   flow: its own size sets its frame (most gallery photos): the shape goes on the photo, capped at 80% of the screen
  //         height and centred, so a tall photo never becomes a tower;
  //   box:  it fills a box the design sized (e.g. an about photo): the shape goes on that box;
  //   fill: it's a background behind a section (position: absolute): only dragging and "whole photo" make sense.
  const SHAPES = { wide: 16 / 9, land: 3 / 2, square: 1, portrait: 4 / 5, tall: 2 / 3 };
  // Which kind is it? Try a test shape on the photo, then on its box, and measure which one actually takes effect.
  function photoKind(im, win) {
    const cs = win.getComputedStyle(im);
    if (cs.position === 'absolute' || cs.position === 'fixed') return 'fill';
    const par = im.parentElement;
    const T = 0.77; // a test shape no design is likely to use already
    const ratio = () => { const r = im.getBoundingClientRect(); return r.height ? r.width / r.height : 0; };
    const clipped = () => { if (!par) return false; const pr = par.getBoundingClientRect(); const r = im.getBoundingClientRect(); return win.getComputedStyle(par).overflow !== 'visible' && r.bottom > pr.bottom + 2; };
    const imStyle = im.getAttribute('style'); const parStyle = par ? par.getAttribute('style') : null;
    const undo = () => {
      if (imStyle == null) im.removeAttribute('style'); else im.setAttribute('style', imStyle);
      if (par) { if (parStyle == null) par.removeAttribute('style'); else par.setAttribute('style', parStyle); }
    };
    try {
      applyPhoto(im, { shape: 'x', kind: 'flow', ratio: T }, T);
      if (Math.abs(ratio() - T) < 0.03 && !clipped()) return 'flow';
      undo();
      if (par) { applyPhoto(im, { shape: 'x', kind: 'box', ratio: T }, T); if (Math.abs(ratio() - T) < 0.03) return 'box'; }
      return 'fill';
    } finally { undo(); }
  }
  function shapeRatio(c, im) {
    if (c.shape === 'own') return c.ratio || (im && im.naturalWidth ? +(im.naturalWidth / im.naturalHeight).toFixed(4) : null);
    return SHAPES[c.shape] || null;
  }
  // Apply one photo's change to an <img> (in the preview or in the saved copy).
  function applyPhoto(im, c, force) {
    if (!c) return;
    const r = force || shapeRatio(c, im);
    if (c.shape === 'contain') { im.style.objectFit = 'contain'; im.style.removeProperty('object-position'); return; }
    if (r && c.kind === 'flow') {
      Object.assign(im.style, { aspectRatio: String(r), width: `min(100%, calc(80vh * ${r}))`, height: 'auto', maxWidth: '100%', marginLeft: 'auto', marginRight: 'auto', objectFit: 'cover' });
    } else if (r && c.kind === 'box' && im.parentElement) {
      Object.assign(im.parentElement.style, { aspectRatio: String(r), height: 'auto' });
      im.style.objectFit = 'cover';
    }
    if (c.pos) im.style.objectPosition = c.pos;
    applyZoom(im, c);
  }
  // Zoom (crop tighter): the photo is enlarged around its focus point (the same point dragging sets) and clipped back
  // to its own frame, so the layout around it doesn't move. Works the same for every kind of photo, in every browser.
  // A page animation on the photo (e.g. a slow zoom on the hero) would override the enlargement, so it's switched off.
  function applyZoom(im, c) {
    const z = c && c.zoom > 1 ? Math.min(3, c.zoom) : 1;
    if (z === 1) {
      // Back to how the page had it (its own inline values, if any).
      const orig = im.ownerDocument.createElement('i'); orig.setAttribute('style', im.dataset.sxStyle || '');
      ['transform', 'transform-origin', 'clip-path', 'animation'].forEach((p) => { const v = orig.style.getPropertyValue(p); if (v) im.style.setProperty(p, v); else im.style.removeProperty(p); });
      return;
    }
    const [x, y] = (c.pos || '50% 50%').split(' ').map((v) => clampPct(parseFloat(v)));
    const k = 1 - 1 / z; const f = (v) => (v * k).toFixed(2) + '%';
    Object.assign(im.style, { transform: `scale(${z})`, transformOrigin: `${x}% ${y}%`, clipPath: `inset(${f(y)} ${f(100 - x)} ${f(100 - y)} ${f(x)})`, animation: 'none' });
  }
  const zoomOf = (im) => ((adj.changes[idx(im)] || {}).zoom || 1);
  function applyChanges(src, changes) {
    const d = new DOMParser().parseFromString(src, 'text/html');
    photoImgs(d).forEach((im, i) => applyPhoto(im, changes[i]));
    return serialize(d);
  }
  function taggedHtml(src) {
    const d = new DOMParser().parseFromString(src, 'text/html');
    photoImgs(d).forEach((im, i) => im.setAttribute('data-sxi', String(i)));
    return serialize(d);
  }
  // The photo's current position as percentages (the browser may report pixels or keywords).
  function currentPos(im, win) {
    const saved = (adj.changes[idx(im)] || {}).pos;
    if (saved) return saved.split(' ').map((v) => clampPct(parseFloat(v)));
    const parts = win.getComputedStyle(im).objectPosition.split(' ');
    const ov = overflow(im, win);
    const one = (v, o) => {
      if (/%$/.test(v)) return parseFloat(v);
      if (v === 'left' || v === 'top') return 0;
      if (v === 'right' || v === 'bottom') return 100;
      if (v === 'center') return 50;
      if (/px$/.test(v) && o > 0) return clampPct((-parseFloat(v) / o) * 100);
      return 50;
    };
    return [one(parts[0] || '50%', ov.x), one(parts[1] || parts[0] || '50%', ov.y)];
  }
  // How much of the photo is hidden outside its frame (only "cover" photos can be moved).
  function overflow(im, win) {
    const cs = win.getComputedStyle(im);
    if (cs.objectFit !== 'cover' || !im.naturalWidth) return { x: 0, y: 0, movable: false };
    const bw = im.clientWidth; const bh = im.clientHeight;
    const sc = Math.max(bw / im.naturalWidth, bh / im.naturalHeight);
    const x = im.naturalWidth * sc - bw; const y = im.naturalHeight * sc - bh;
    // Zoomed in, dragging also moves the focus point the photo is enlarged around.
    const z = im.hasAttribute('data-sxi') ? zoomOf(im) : 1;
    const zx = x + (z - 1) * bw; const zy = y + (z - 1) * bh;
    return { x: zx, y: zy, movable: zx > 1 || zy > 1 };
  }
  const idx = (im) => Number(im.getAttribute('data-sxi'));
  function restorePhoto(im) {
    im.setAttribute('style', im.dataset.sxStyle || ''); if (!im.dataset.sxStyle) im.removeAttribute('style');
    const par = im.parentElement;
    if (par && 'sxPstyle' in par.dataset) { par.setAttribute('style', par.dataset.sxPstyle); if (!par.dataset.sxPstyle) par.removeAttribute('style'); }
  }
  function photoMsg(im) {
    const win = $('frame').contentDocument.defaultView;
    const c = adj.changes[idx(im)] || {};
    const kind = adj.kinds[idx(im)];
    const ov = overflow(im, win);
    if (c.shape === 'contain') { setAdjMsg(kind === 'fill' ? 'Showing the whole photo, with space around it.' : 'Showing the whole photo inside its frame, with space around it. "Photo\'s own shape" usually looks better.'); return; }
    if (kind === 'fill' && zoomOf(im) === 1) { setAdjMsg('This photo is the background of a section, so the section is its frame. Drag it to choose what shows (or use the arrow keys), or Zoom to crop it tighter. Then save.'); return; }
    if (zoomOf(im) > 1) { setAdjMsg('Zoomed in. Drag the photo (or use the arrow keys) to choose what shows, then save.'); return; }
    setAdjMsg(ov.movable ? 'Drag the photo to choose what shows (or use the arrow keys). Use Zoom to crop it tighter, or change the frame shape if too much is cut off. Then save.'
      : 'The whole photo shows in this frame. Use Zoom to crop it tighter, or pick another frame shape. Then save.');
  }
  function selectPhoto(im) {
    const doc = $('frame').contentDocument;
    doc.querySelectorAll('img.sx-sel').forEach((x) => x.classList.remove('sx-sel'));
    adj.sel = im; im.classList.add('sx-sel');
    const kind = adj.kinds[idx(im)];
    const sel = $('adjust-shape');
    sel.disabled = false; $('adjust-reset').disabled = false;
    [...sel.options].forEach((o) => { o.disabled = kind === 'fill' && !['design', 'contain'].includes(o.value); });
    sel.value = (adj.changes[idx(im)] || {}).shape || 'design';
    syncZoom(im);
    photoMsg(im);
  }
  function setChange(im, patch) {
    const i = idx(im);
    const c = { kind: adj.kinds[i], ...(adj.changes[i] || {}), ...patch };
    if (c.shape === 'own' && !c.ratio && im.naturalWidth) c.ratio = +(im.naturalWidth / im.naturalHeight).toFixed(4);
    adj.changes[i] = c;
    $('adjust-save').disabled = false;
  }
  function moveBy(im, dx, dy) {
    const win = $('frame').contentDocument.defaultView;
    const ov = overflow(im, win); if (!ov.movable) return;
    const [x, y] = currentPos(im, win);
    im.style.objectPosition = `${clampPct(x + dx).toFixed(1)}% ${clampPct(y + dy).toFixed(1)}%`;
    setChange(im, { pos: im.style.objectPosition });
    applyZoom(im, adj.changes[idx(im)]);
  }
  function syncZoom(im) {
    const zs = $('adjust-zoom'); const c = (im && adj.changes[idx(im)]) || {};
    zs.disabled = !im || c.shape === 'contain';
    zs.value = String(Math.round((c.zoom || 1) * 100));
    $('adjust-zoom-v').textContent = zs.value + '%';
  }
  function zoomTo(im, pct) {
    const z = Math.max(1, Math.min(3, pct / 100));
    const i = idx(im);
    if (z === 1 && adj.changes[i]) { delete adj.changes[i].zoom; const c = adj.changes[i]; if ((!c.shape || c.shape === 'design') && !c.pos) delete adj.changes[i]; }
    else setChange(im, { zoom: z, pos: (adj.changes[i] || {}).pos || currentPosPct(im) });
    applyZoom(im, adj.changes[i]);
    syncZoom(im);
    $('adjust-save').disabled = !Object.keys(adj.changes).length;
    photoMsg(im);
  }
  // Where the photo is focused now, as "x% y%" (its saved position, else what the page shows).
  function currentPosPct(im) {
    const [x, y] = currentPos(im, $('frame').contentDocument.defaultView);
    return `${x.toFixed(1)}% ${y.toFixed(1)}%`;
  }
  function wireFrame() {
    const doc = $('frame').contentDocument; if (!doc) return;
    const win = doc.defaultView;
    const st = doc.createElement('style');
    st.textContent = CALM + 'img[data-sxi]{cursor:grab;touch-action:none;user-select:none}'
      + 'img[data-sxi]:hover{outline:2px dashed rgba(255,154,77,.95);outline-offset:-2px}'
      + 'img[data-sxi].sx-sel{outline:3px solid #F2496B;outline-offset:-3px}img[data-sxi].sx-drag{cursor:grabbing}'
      // A zoomed photo is clipped to its frame, which would hide its outline: mark its frame instead.
      + ':has(> img[data-sxi].sx-sel[style*="clip-path"]){outline:3px solid #F2496B;outline-offset:-3px}';
    doc.head.append(st);
    // Links and forms don't work while adjusting (clicks choose photos).
    doc.addEventListener('click', (e) => { if (e.target.closest('a, button, form')) e.preventDefault(); }, true);
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    const imgs = [...doc.querySelectorAll('img[data-sxi]')];
    if (!imgs.length) { setAdjMsg('There are no photos of yours on this version.', true); return; }
    imgs.forEach((im) => {
      im.draggable = false;
      im.dataset.sxStyle = im.getAttribute('style') || '';
      if (im.parentElement && !('sxPstyle' in im.parentElement.dataset)) im.parentElement.dataset.sxPstyle = im.parentElement.getAttribute('style') || '';
      const setKind = () => { adj.kinds[idx(im)] = photoKind(im, win); };
      if (im.complete) setKind(); else im.addEventListener('load', setKind, { once: true });
      im.addEventListener('dragstart', (e) => e.preventDefault());
      im.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!(idx(im) in adj.kinds)) setKind();
        selectPhoto(im);
        const ov = overflow(im, win); if (!ov.movable) return;
        const [sx, sy] = currentPos(im, win);
        const x0 = e.clientX; const y0 = e.clientY;
        im.setPointerCapture(e.pointerId); im.classList.add('sx-drag');
        let moved = false;
        const move = (ev) => {
          // Dragging moves the photo with the pointer, so the hidden part slides into view.
          const nx = ov.x > 1 ? clampPct(sx - ((ev.clientX - x0) / ov.x) * 100) : sx;
          const ny = ov.y > 1 ? clampPct(sy - ((ev.clientY - y0) / ov.y) * 100) : sy;
          im.style.objectPosition = `${nx.toFixed(1)}% ${ny.toFixed(1)}%`; moved = true;
          if (zoomOf(im) > 1) applyZoom(im, { zoom: zoomOf(im), pos: im.style.objectPosition });
        };
        const up = () => { im.removeEventListener('pointermove', move); im.removeEventListener('pointerup', up); im.removeEventListener('pointercancel', up); im.classList.remove('sx-drag'); if (moved) setChange(im, { pos: im.style.objectPosition }); };
        im.addEventListener('pointermove', move); im.addEventListener('pointerup', up); im.addEventListener('pointercancel', up);
      });
    });
    setAdjMsg(`Click a photo (${imgs.length} on this page). Then choose its frame shape, or drag it to choose what shows.`);
  }
  function startAdjust() {
    if (!html || building || editing || !lastBuildId || handOn()) return;
    adj.on = true; adj.changes = {}; adj.kinds = {}; adj.sel = null; adj.base = html;
    $('adjust-bar').hidden = false; $('adjust-save').disabled = true; $('adjust-shape').disabled = true; $('adjust-reset').disabled = true; syncZoom(null);
    const f = handStart('adjust');
    f.onload = wireFrame;
    f.srcdoc = withLogo(taggedHtml(html));
    setAdjMsg('Loading your photos…');
  }
  function stopAdjust() { adj.on = false; adj.sel = null; handStop('adjust'); }
  async function saveAdjust() {
    const n = Object.keys(adj.changes).length;
    if (!n) { stopAdjust(); return; }
    const out = applyChanges(adj.base, adj.changes);
    $('adjust-save').disabled = true; setAdjMsg('Saving…');
    const id = await saveManual(out, n === 1 ? 'Adjusted a photo' : `Adjusted ${n} photos`, null, (m) => { $('adjust-save').disabled = false; setAdjMsg(m, true); });
    if (!id) return;
    stopAdjust();
    await afterManualSave(id, 'Photo changes saved as a new version. Undo goes back. This didn\'t use any of your changes.');
  }
  $('adjust').addEventListener('click', startAdjust);
  $('adjust-cancel').addEventListener('click', stopAdjust);
  $('adjust-save').addEventListener('click', saveAdjust);
  $('adjust-shape').addEventListener('change', (e) => {
    const im = adj.sel; if (!im) return;
    restorePhoto(im);
    const keepPos = e.target.value === 'contain' ? null : (adj.changes[idx(im)] || {}).pos || null;
    const keepZoom = e.target.value === 'contain' ? null : (adj.changes[idx(im)] || {}).zoom || null;
    setChange(im, { shape: e.target.value, pos: keepPos, ratio: null, zoom: keepZoom });
    if (e.target.value === 'design' && !keepPos && !keepZoom) delete adj.changes[idx(im)];
    syncZoom(im);
    applyPhoto(im, adj.changes[idx(im)]);
    $('adjust-save').disabled = !Object.keys(adj.changes).length;
    photoMsg(im);
    im.scrollIntoView({ block: 'nearest' });
  });
  $('adjust-reset').addEventListener('click', () => {
    const im = adj.sel; if (!im) return;
    restorePhoto(im);
    delete adj.changes[idx(im)];
    $('adjust-save').disabled = !Object.keys(adj.changes).length;
    selectPhoto(im);
  });
  $('adjust-zoom').addEventListener('input', (e) => { if (adj.sel) zoomTo(adj.sel, Number(e.target.value)); });
  document.addEventListener('keydown', (e) => {
    if (!adj.on || !adj.sel || !/^Arrow/.test(e.key) || /input|textarea|select/i.test((document.activeElement || {}).tagName || '')) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 2;
    moveBy(adj.sel, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
  });

  // ----- Edit words -----
  // Click any words on the page and type. Every piece of text on the page becomes editable (headings, paragraphs,
  // buttons, links, labels, captions, footer). Enter is blocked (one paragraph stays one paragraph). Phone and email
  // links follow their new text. "Next [placeholder]" jumps to the next [PHONE NUMBER]-style blank Build left, and a
  // placeholder filled in once can be filled in everywhere else it appears.
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'TEXTAREA', 'SELECT', 'OPTION', 'INPUT', 'IFRAME', 'OBJECT', 'CANVAS', 'VIDEO', 'AUDIO', 'MATH']);
  const PH = /\[[^\]\n]{2,48}\]/g;
  // The text pieces of a page, in order. An element whose content is only text and inline formatting (b, em, a, br…)
  // is edited as a whole. Loose text next to anything else (a form box, an image, a block, or inside a button or label,
  // which browsers won't place a cursor in) is wrapped in a temporary <span data-sxw> while editing, and unwrapped
  // when saving. Running this on the same page always gives the same pieces in the same order.
  const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'I', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR']);
  const WRAP_ALWAYS = new Set(['BUTTON', 'LABEL', 'SUMMARY', 'LEGEND', 'OPTION']);
  const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  const pureInline = (el) => [...el.querySelectorAll('*')].every((c) => INLINE.has(c.tagName.toUpperCase()));
  function textEls(d) {
    const out = [];
    const walk = (el) => {
      for (const c of [...el.children]) {
        const tag = c.tagName.toUpperCase();
        if (SKIP.has(tag)) continue;
        if (hasText(c) && !WRAP_ALWAYS.has(tag) && pureInline(c)) { out.push(c); continue; }
        if (hasText(c)) {
          // Wrap each run of loose text (with the inline formatting around it) in its own editable span.
          let run = [];
          const flush = () => {
            if (run.some((n) => (n.nodeType === 3 ? n.nodeValue.trim() : n.textContent.trim()))) {
              const sp = d.createElement('span'); sp.setAttribute('data-sxw', '');
              run[0].before(sp); run.forEach((n) => sp.append(n)); out.push(sp);
            }
            run = [];
          };
          for (const n of [...c.childNodes]) {
            const inline = n.nodeType === 3 || (n.nodeType === 1 && INLINE.has(n.tagName.toUpperCase()) && pureInline(n) && n.tagName.toUpperCase() !== 'BR');
            if (inline) run.push(n); else { flush(); if (n.nodeType === 1 && !SKIP.has(n.tagName.toUpperCase())) walk({ children: [n] }); }
          }
          flush();
          continue;
        }
        walk(c);
      }
    };
    if (d.body) walk(d.body);
    return out;
  }
  const unwrap = (root) => root.querySelectorAll('span[data-sxw]').forEach((sp) => sp.replaceWith(...sp.childNodes));
  const words = { on: false, base: '', dirty: new Set(), start: [], pending: null, phAt: 0 };
  const setWordsMsg = (t, err) => { const m = $('words-msg'); m.textContent = t; m.classList.toggle('err', !!err); };
  // Swap the preview's private photo links and logo back to Build's own tags.
  function unfill(s) {
    const map = photoLinks();
    for (const [k, url] of Object.entries(map)) {
      if (k.includes(':') || !url) continue;
      s = s.split(url).join('sogilex:photo:' + k).split(url.replace(/&/g, '&amp;')).join('sogilex:photo:' + k);
    }
    if (kit.logo) s = s.split(kit.logo).join('sogilex:logo');
    return s.split(BLANK_PNG).join('sogilex:logo');
  }
  const looksPhone = (t) => /^\+?[\d\s().-]{7,20}$/.test(t) && (t.match(/\d/g) || []).length >= 7;
  const looksEmail = (t) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
  // A phone or email link whose words changed: point the link at the new number or address.
  function syncLinks(el) {
    const links = el.matches('a[href]') ? [el] : [...el.querySelectorAll('a[href]')];
    for (const a of links) {
      const href = a.getAttribute('href') || ''; const t = a.textContent.trim();
      if (/^tel:/i.test(href) && looksPhone(t)) a.setAttribute('href', 'tel:' + t.replace(/[^\d+]/g, ''));
      else if (/^mailto:/i.test(href) && looksEmail(t)) a.setAttribute('href', 'mailto:' + t);
    }
  }
  function phList(doc) {
    const hits = [];
    for (const el of doc.querySelectorAll('[data-sxt]')) {
      const tw = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        PH.lastIndex = 0; let m;
        while ((m = PH.exec(n.nodeValue))) hits.push({ el, node: n, at: m.index, text: m[0] });
      }
    }
    return hits;
  }
  function wordsCount() {
    const doc = $('frame').contentDocument; if (!doc) return;
    const n = words.dirty.size; const ph = phList(doc);
    $('words-save').disabled = !n;
    $('words-next').hidden = !ph.length || !$('ph-row').hidden;
    $('words-next').textContent = ph.length ? `Fill in placeholders (${new Set(ph.map((h) => h.text)).size})` : '';
    if (!ph.length) $('ph-row').hidden = true;
    if (!words.pending) setWordsMsg(n ? `${n} ${n === 1 ? 'place' : 'places'} changed. Keep going, or save.` : 'Click any words on the page and type. Press Save when you\'re done.');
  }
  // After a placeholder is filled in: offer the same words in every other place it appears.
  function offerAll(el) {
    const i = Number(el.getAttribute('data-sxt'));
    const before = words.start[i] || ''; const after = el.textContent;
    words.pending = null; $('words-all').hidden = true;
    const ph = (before.match(PH) || []).find((p) => !after.includes(p));
    if (!ph) return;
    const k = before.indexOf(ph); const head = before.slice(0, k); const tail = before.slice(k + ph.length);
    if (!after.startsWith(head) || !after.endsWith(tail)) return;
    const fill = after.slice(head.length, after.length - tail.length).trim();
    if (!fill || fill.length > 120) return;
    const doc = $('frame').contentDocument;
    const others = phList(doc).filter((h) => h.text === ph && h.el !== el);
    const hrefs = [...doc.querySelectorAll('a[href]')].filter((a) => (a.getAttribute('href') || '').includes(ph));
    if (!others.length && !hrefs.length) return;
    words.pending = { ph, fill };
    const places = new Set(others.map((h) => h.el)).size;
    $('words-all').textContent = places ? `Use "${fill.length > 28 ? fill.slice(0, 27) + '…' : fill}" in the other ${places} ${places === 1 ? 'place' : 'places'}` : 'Update the link too';
    $('words-all').hidden = false;
    setWordsMsg(places ? `${ph} also appears in ${places} other ${places === 1 ? 'place' : 'places'} on this page.` : `A link on this page still points to ${ph}.`);
  }
  function fillAll(given) {
    const p = given || words.pending; if (!p) return;
    const doc = $('frame').contentDocument;
    for (const h of phList(doc).filter((x) => x.text === p.ph)) {
      h.node.nodeValue = h.node.nodeValue.split(p.ph).join(p.fill);
      words.dirty.add(Number(h.el.getAttribute('data-sxt'))); syncLinks(h.el);
    }
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || ''; if (!href.includes(p.ph)) continue;
      const v = /^tel:/i.test(href) ? p.fill.replace(/[^\d+]/g, '') : /^mailto:/i.test(href) ? p.fill.trim() : encodeURI(p.fill.trim());
      a.setAttribute('href', href.split(p.ph).join(v));
      const host = a.closest('[data-sxt]') || a; if (host.hasAttribute('data-sxt')) words.dirty.add(Number(host.getAttribute('data-sxt')));
      else { words.hrefOnly = words.hrefOnly || new Set(); words.hrefOnly.add(a); }
    }
    words.pending = null; $('words-all').hidden = true;
    wordsCount();
  }
  function wireWords() {
    const doc = $('frame').contentDocument; if (!doc) return;
    const st = doc.createElement('style');
    st.textContent = CALM + '[data-sxt]{cursor:text;border-radius:3px}[data-sxt]:hover{outline:2px dashed rgba(255,154,77,.9);outline-offset:3px}'
      + '[data-sxt]:focus{outline:3px solid #F2496B;outline-offset:3px;background-color:rgba(242,73,107,.08)}'
      + '.sx-ph{outline:3px solid #FF9A4D!important;outline-offset:3px;background-color:rgba(255,154,77,.15)!important}';
    doc.head.append(st);
    doc.addEventListener('click', (e) => { if (e.target.closest('a, button, label, summary')) e.preventDefault(); }, true);
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    let pt = true;
    const els = [...doc.querySelectorAll('[data-sxt]')];
    words.start = [];
    els.forEach((el) => {
      const i = Number(el.getAttribute('data-sxt'));
      words.start[i] = el.textContent;
      try { el.contentEditable = 'plaintext-only'; if (el.contentEditable !== 'plaintext-only') throw 0; } catch { pt = false; el.contentEditable = 'true'; }
      el.spellcheck = true;
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      el.addEventListener('input', () => { words.dirty.add(i); wordsCount(); });
      el.addEventListener('focusout', () => { if (el.textContent !== words.start[i]) { syncLinks(el); offerAll(el); } wordsCount(); });
      if (!pt) el.addEventListener('paste', (e) => { e.preventDefault(); doc.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ')); });
    });
    wordsCount();
  }
  function startWords() {
    if (!html || building || editing || !lastBuildId || handOn()) return;
    words.on = true; words.base = html; words.dirty = new Set(); words.pending = null; words.phAt = 0; words.hrefOnly = null;
    $('words-bar').hidden = false; $('words-save').disabled = true; $('words-all').hidden = true; $('words-next').hidden = true; $('ph-row').hidden = true;
    const d = new DOMParser().parseFromString(html, 'text/html');
    textEls(d).forEach((el, i) => el.setAttribute('data-sxt', String(i)));
    const f = handStart('words');
    f.onload = wireWords;
    f.srcdoc = withLogo(serialize(d));
    setWordsMsg('Loading your page…');
  }
  function stopWords() { words.on = false; handStop('words'); }
  async function saveWords() {
    const doc = $('frame').contentDocument;
    if (!doc || (!words.dirty.size && !words.hrefOnly)) { stopWords(); return; }
    const d = new DOMParser().parseFromString(words.base, 'text/html');
    const targets = textEls(d);
    const live = new Map([...doc.querySelectorAll('[data-sxt]')].map((el) => [Number(el.getAttribute('data-sxt')), el]));
    let first = '';
    for (const i of words.dirty) {
      const src = live.get(i); const dst = targets[i]; if (!src || !dst) continue;
      syncLinks(src);
      src.classList.remove('sx-ph');
      dst.innerHTML = unfill(src.innerHTML);
      if (src.matches('a[href]')) dst.setAttribute('href', unfill(src.getAttribute('href')));
      if (!first) first = src.textContent.trim();
    }
    if (words.hrefOnly) {
      // Links outside any text (e.g. an icon link) that pointed at a filled-in placeholder: match them by position.
      const liveA = [...doc.querySelectorAll('a[href]')]; const outA = [...d.querySelectorAll('a[href]')];
      for (const a of words.hrefOnly) { const k = liveA.indexOf(a); if (k >= 0 && outA[k]) outA[k].setAttribute('href', unfill(a.getAttribute('href'))); }
    }
    unwrap(d);
    const n = words.dirty.size || 1;
    const note = n === 1 && first ? `Edited words: "${first.length > 40 ? first.slice(0, 39) + '…' : first}"` : `Edited words in ${n} places`;
    $('words-save').disabled = true; setWordsMsg('Saving…');
    const id = await saveManual(serialize(d), note, null, (m) => { $('words-save').disabled = false; setWordsMsg(m, true); });
    if (!id) return;
    stopWords();
    await afterManualSave(id, 'Word changes saved as a new version. Undo goes back. This didn\'t use any of your changes.');
  }
  $('words').addEventListener('click', startWords);
  $('words-cancel').addEventListener('click', () => { if (words.dirty.size && !confirm('Throw away your word changes?')) return; stopWords(); });
  $('words-save').addEventListener('click', saveWords);
  $('words-all').addEventListener('click', () => fillAll());
  // Fill in placeholders: one box per [PLACEHOLDER]; what you type replaces it everywhere on the page, links included.
  function phNext(skip) {
    const doc = $('frame').contentDocument; const ph = phList(doc);
    const kinds = [...new Set(ph.map((h) => h.text))];
    if (!kinds.length) { $('ph-row').hidden = true; wordsCount(); setWordsMsg('All placeholders are filled in. Check the page, then save.'); return; }
    words.phAt = skip ? (words.phAt + 1) % kinds.length : Math.min(words.phAt, kinds.length - 1);
    const cur = kinds[words.phAt];
    const where = ph.filter((h) => h.text === cur);
    $('ph-label').textContent = cur;
    $('ph-input').value = ''; $('ph-input').placeholder = /PHONE/i.test(cur) ? '(314) 555-0100' : /EMAIL/i.test(cur) ? 'you@yourbusiness.com' : 'Type the real words';
    $('ph-row').hidden = false; $('words-next').hidden = true;
    setWordsMsg(`${cur} appears in ${where.length} ${where.length === 1 ? 'place' : 'places'}${kinds.length > 1 ? ` (${words.phAt + 1} of ${kinds.length} placeholders)` : ''}. Type what goes there, or skip it.`);
    doc.querySelectorAll('.sx-ph').forEach((x) => x.classList.remove('sx-ph'));
    where.forEach((h) => h.el.classList.add('sx-ph'));
    where[0].el.scrollIntoView({ block: 'center' });
    $('ph-input').focus();
  }
  $('words-next').addEventListener('click', () => { words.phAt = 0; phNext(false); });
  $('ph-skip').addEventListener('click', () => phNext(true));
  $('ph-done').addEventListener('click', () => { $('ph-row').hidden = true; const d = $('frame').contentDocument; if (d) d.querySelectorAll('.sx-ph').forEach((x) => x.classList.remove('sx-ph')); wordsCount(); });
  $('ph-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('ph-input').value.trim(); if (!v) { $('ph-input').focus(); return; }
    fillAll({ ph: $('ph-label').textContent, fill: v.slice(0, 120) });
    const d = $('frame').contentDocument; if (d) d.querySelectorAll('.sx-ph').forEach((x) => x.classList.remove('sx-ph'));
    phNext(false);
  });

  // Strip anything before <!doctype / <html and after </html>, in case the model adds stray text.
  function clean(text) {
    const start = text.search(/<!doctype html|<html/i);
    let out = start >= 0 ? text.slice(start) : text;
    const end = out.toLowerCase().lastIndexOf('</html>');
    if (end >= 0) out = out.slice(0, end + 7);
    return out;
  }

  $('brief').addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = $('build-status'); st.className = 'status';
    const description = $('desc').value.trim();
    if (description.length < 10) { st.textContent = 'Describe the site in a sentence or two.'; st.classList.add('err'); $('desc').focus(); return; }
    const hr = readHours();
    if (hr.error) { st.textContent = 'Business hours: ' + hr.error; st.classList.add('err'); $('hours').open = true; return; }
    const s = await session();
    if (!s) { st.textContent = 'Your sign-in expired. Reload the page and sign in again.'; st.classList.add('err'); return; }
    if (hoursTimer || hr.hours) saveHours(); // keep them in the account for next time (doesn't hold up the build)

    siteName = $('name').value.trim();
    $('addr').textContent = `${slug(siteName)}.html`;
    html = ''; paint(true); setDone(false);
    builtOk = false; lastBuildId = null; $('pub-status').textContent = ''; $('pub-status').className = 'status'; refreshPublish();
    $('ver').disabled = true;
    building = true; chat = []; renderChat(); refreshEdit();
    const go = $('go'); go.disabled = true; go.classList.add('working'); go.firstChild.textContent = 'Building… ';
    $('frame').closest('.preview').classList.add('building');
    st.textContent = 'Designing your site. This usually takes one to two minutes.';
    if (window.matchMedia('(max-width: 900px)').matches) $('frame').scrollIntoView({ behavior: 'smooth', block: 'start' });

    let failed = null;
    try {
      const res = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: PUBLISHABLE_KEY },
        body: JSON.stringify({
          description, name: siteName,
          style: (document.querySelector('input[name="style"]:checked') || {}).value || 'clean',
          accent: $('accent-auto').checked ? '' : $('accent').value,
          logo: !!kit.logo,
          logo_colors: kit.logo ? (kit.colors || []) : [],
          use_photos: !!(photoBox && photoBox.photos.length && $('use-photos').checked),
          hours: hr.hours,
        }),
      });
      if (!res.ok || !res.body) {
        let msg = `Build failed (${res.status}).`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* not JSON */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = ''; let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const lineText = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!lineText.trim()) continue;
          const msg = JSON.parse(lineText);
          if (msg.t === 'meta') { lastBuildId = msg.build_id || null; }
          else if (msg.t === 'delta') { html += msg.text; schedulePaint(); }
          else if (msg.t === 'done') finished = true;
          else if (msg.t === 'error') failed = msg.message;
        }
      }
      if (!finished && !failed) failed = 'The connection dropped before the site was finished. Please try again.';
    } catch (err) {
      failed = err?.message || 'Something went wrong. Please try again.';
    }

    clearTimeout(paintTimer); paintTimer = null;
    $('frame').closest('.preview').classList.remove('building');
    go.disabled = false; go.classList.remove('working'); go.firstChild.textContent = 'Build another ';
    if (failed) {
      st.textContent = failed; st.classList.add('err'); UP(failed);
      if (html) { html = clean(html); paint(true); }
    } else {
      html = clean(html); paint(true); setDone(true);
      builtOk = true; refreshPublish();
      if (window.SogilexUpgrade) SogilexUpgrade.refresh();
      st.textContent = 'Done. To change anything, type in "Change your site" above the preview.'; st.classList.add('ok');
    }
    $('ver').disabled = false;
    building = false; refreshEdit();
    showQuota();
    loadBuilds(false);
  });

  // ---------- results ----------
  $('download').addEventListener('click', async () => {
    if (window.SogilexUpgrade && !SogilexUpgrade.gate('site')) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([await forFile(html)], { type: 'text/html' }));
    a.download = `${slug(siteName)}.html`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('copy').addEventListener('click', async () => {
    if (window.SogilexUpgrade && !SogilexUpgrade.gate('site')) return;
    try { await navigator.clipboard.writeText(await forFile(html)); $('copy').textContent = 'Copied'; }
    catch { $('copy').textContent = 'Copy failed'; }
    setTimeout(() => { $('copy').textContent = 'Copy code'; }, 1800);
  });
  // Full-size view in a new tab, still sandboxed: no scripts, no access to this site.
  $('newtab').addEventListener('click', () => {
    if (window.SogilexUpgrade && !SogilexUpgrade.gate('site')) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.title = `${slug(siteName)}.html · preview`;
    w.document.body.style.margin = '0';
    const f = w.document.createElement('iframe');
    f.setAttribute('sandbox', '');
    f.style.cssText = 'border:0;width:100vw;height:100vh;display:block';
    f.srcdoc = withLogo(html);
    w.document.body.append(f);
  });
})();
