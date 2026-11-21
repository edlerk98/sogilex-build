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
  // Auth calls have no abort option, so give them an overall time limit.
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("Couldn't reach the account service. Check your connection.")), ms))]);

  let html = '';
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
      const w = leftWhen(await getPlan());
      $('quota').textContent = data > 0 ? `${data} ${data === 1 ? 'build' : 'builds'} left ${w}` : `No builds left ${w}`;
      $('quota').classList.toggle('out', data <= 0);
      return data;
    } catch { $('quota').textContent = ''; return null; }
  }

  (async () => {
    const s = await session();
    if (s) { $('brief').hidden = false; $('signout').hidden = false; $('pwbtn').hidden = false; showQuota(); loadSite(); loadMail(); loadKit(s.user.id); loadBuilds(true); showEditQuota(); }
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
    SogilexBrand.mountLogo($('logo-mount'), { db, uid, kit, onChange: (k) => { kit = k; logoSwatches(); renderQuick(); if (html) paint(true); } });
    logoSwatches(); renderQuick();
    loadPhotos(uid);
  }
  function loadPhotos(uid) {
    if (!window.SogilexPhotos) return;
    $('photos-field').hidden = false;
    photoBox = SogilexPhotos.mount($('photos-mount'), {
      db, uid,
      onChange: (photos) => { $('use-photos-row').hidden = !photos.length; if (html) paint(true); },
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
  }
  // Plans without publishing (not Beta, which is invite-only as before): say how to get it.
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
    $('pub-go').disabled = !(builtOk && lastBuildId) || isLive;
    $('pub-go').textContent = isLive ? 'This version is live' : live ? 'Publish this version' : 'Publish this site';
    $('pub-hint').textContent = !(builtOk && lastBuildId) ? 'Build a site first, then publish it here.'
      : isLive ? 'What you see here is what visitors see.'
        : live ? `This replaces what's live at ${site.slug}.sogilex.net.` : 'Your site goes live at this address in a few seconds.';
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
  $('pub-slug').addEventListener('input', () => { const v = slugify($('pub-slug').value); if (v !== $('pub-slug').value) $('pub-slug').value = v; });
  $('pub-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = $('pub-status'); st.className = 'status';
    const slugValue = slugify($('pub-slug').value);
    if (slugValue.length < 3) { st.textContent = 'Choose an address of at least 3 letters or numbers.'; st.classList.add('err'); $('pub-slug').focus(); return; }
    $('pub-go').disabled = true; st.textContent = 'Publishing…';
    try {
      const out = await publishCall('/publish', { build_id: lastBuildId, slug: slugValue });
      st.innerHTML = ''; st.append('Live at ', Object.assign(document.createElement('a'), { href: out.url, target: '_blank', rel: 'noopener', textContent: out.url }), '. It can take a minute to appear the very first time.');
      st.classList.add('ok');
      await loadSite(); loadBuilds(false);
    } catch (err) { st.textContent = err.message; st.classList.add('err'); refreshPublish(); }
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
      const note = b.kind === 'edit' ? ` · ${short(b.note || 'edited')}` : '';
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
    if (failed) { chat.push({ role: 'sogilex', text: failed, err: true }); bubble('sogilex', failed, 'err'); }
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
    const doc = withLogo(final ? html : html + '\n</body></html>');
    $('frame').srcdoc = doc;
    $('empty').hidden = html.length > 0;
    $('size').textContent = html ? `${(new Blob([html]).size / 1024).toFixed(1)} KB` : '';
    if (photoBox) photoBox.render();
  }
  function schedulePaint() { if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = null; paint(false); }, 700); }
  const slug = (s) => (s || 'my-site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'my-site';
  function setDone(enabled) { ['download', 'copy', 'newtab'].forEach((id) => { $(id).disabled = !enabled; }); }

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
    const s = await session();
    if (!s) { st.textContent = 'Your sign-in expired. Reload the page and sign in again.'; st.classList.add('err'); return; }

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
      st.textContent = failed; st.classList.add('err');
      if (html) { html = clean(html); paint(true); }
    } else {
      html = clean(html); paint(true); setDone(true);
      builtOk = true; refreshPublish();
      st.textContent = 'Done. To change anything, type in "Change your site" above the preview.'; st.classList.add('ok');
    }
    $('ver').disabled = false;
    building = false; refreshEdit();
    showQuota();
    loadBuilds(false);
  });

  // ---------- results ----------
  $('download').addEventListener('click', async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([await forFile(html)], { type: 'text/html' }));
    a.download = `${slug(siteName)}.html`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(await forFile(html)); $('copy').textContent = 'Copied'; }
    catch { $('copy').textContent = 'Copy failed'; }
    setTimeout(() => { $('copy').textContent = 'Copy code'; }, 1800);
  });
  // Full-size view in a new tab, still sandboxed: no scripts, no access to this site.
  $('newtab').addEventListener('click', () => {
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
