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
  let siteName = '';

  // ---------- account ----------
  async function session() {
    try { const { data } = await within(db.auth.getSession(), 10000); return data.session; } catch { return null; }
  }
  async function showQuota() {
    try {
      const { data, error } = await db.rpc('build_quota').abortSignal(AbortSignal.timeout(8000));
      if (error) throw error;
      $('quota').textContent = data > 0 ? `${data} ${data === 1 ? 'build' : 'builds'} left today` : 'No builds left today';
      $('quota').classList.toggle('out', data <= 0);
      return data;
    } catch { $('quota').textContent = ''; return null; }
  }

  (async () => {
    const s = await session();
    if (s) { $('brief').hidden = false; $('signout').hidden = false; $('pwbtn').hidden = false; showQuota(); }
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


  // ---------- the brief ----------
  $('desc').addEventListener('input', () => { $('desc-count').textContent = $('desc').value.length.toLocaleString(); });
  document.querySelectorAll('.swatches button').forEach((b) => b.addEventListener('click', () => {
    $('accent').value = b.dataset.c; $('accent-auto').checked = false;
  }));
  $('accent').addEventListener('input', () => { $('accent-auto').checked = false; });

  // ---------- preview ----------
  let paintTimer = null;
  function paint(final) {
    const doc = final ? html : html + '\n</body></html>';
    $('frame').srcdoc = doc;
    $('empty').hidden = html.length > 0;
    $('size').textContent = html ? `${(new Blob([html]).size / 1024).toFixed(1)} KB` : '';
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
          if (msg.t === 'delta') { html += msg.text; schedulePaint(); }
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
      st.textContent = 'Done. Download it, or tweak the brief and build again.'; st.classList.add('ok');
    }
    showQuota();
  });

  // ---------- results ----------
  $('download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = `${slug(siteName)}.html`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(html); $('copy').textContent = 'Copied'; }
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
    f.srcdoc = html;
    w.document.body.append(f);
  });
})();
