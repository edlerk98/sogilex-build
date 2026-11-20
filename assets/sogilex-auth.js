// Sogilex sign-in, shared by every *.sogilex.com app (keep this file identical in each repo).
//
// 1. One session for all of sogilex.com: the Supabase session lives in a cookie scoped to
//    .sogilex.com (split into chunks, since a session can exceed one cookie's 4 KB), so signing in
//    in one Sogilex tool also signs you in on the others. Customer sites live on sogilex.net, so they never see it.
// 2. Two ways in: a password, or a 6-digit code sent by email (the email's link still works too).
//    "Forgot password" is just: sign in with a code, then set a new password.
//
// Use: const client = supabase.createClient(url, key, { auth: SogilexAuth.clientOptions() });
//      SogilexAuth.mountSignIn(el, { client, redirectTo, onSignedIn });
//      SogilexAuth.mountPasswordForm(el, { client });
// 3. Bot check: when TURNSTILE_SITE_KEY is set, every sign-in form shows a Cloudflare Turnstile check and sends its
//    answer (captchaToken) with the request. Set the key and put this live BEFORE switching CAPTCHA on in Supabase
//    (Authentication > Attack Protection): with CAPTCHA on and no answer sent, every sign-in fails.
window.SogilexAuth = (() => {
  const TURNSTILE_SITE_KEY = window.SOGILEX_TURNSTILE_SITE_KEY || ''; // public key from Cloudflare > Turnstile
  const STORAGE_KEY = 'sb-sogilex-auth';
  const LEGACY_KEY = 'sb-sdltqbctuieyjlujsdhj-auth-token'; // per-site localStorage, before shared sign-in
  const MODE_KEY = 'sogilex:auth-mode';
  const CHUNK = 3000;
  const MAX_CHUNKS = 12;
  const onSogilex = /(^|\.)sogilex\.com$/.test(location.hostname);
  const cookieTail = '; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '') + (onSogilex ? '; Domain=.sogilex.com' : '');

  // ---------- cookie storage (falls back to localStorage if cookies are blocked) ----------
  function readCookies() {
    const out = {};
    for (const part of document.cookie ? document.cookie.split('; ') : []) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
    }
    return out;
  }
  function cookiesWork() {
    try {
      document.cookie = 'sx-test=1' + cookieTail;
      const ok = readCookies()['sx-test'] === '1';
      document.cookie = 'sx-test=; Max-Age=0' + cookieTail;
      return ok;
    } catch { return false; }
  }
  const useCookies = cookiesWork();

  const cookieStorage = {
    getItem(key) {
      if (!useCookies) { try { return localStorage.getItem(key); } catch { return null; } }
      const jar = readCookies();
      if (jar[key + '.0'] === undefined) return null;
      let out = '';
      for (let i = 0; i < MAX_CHUNKS && jar[key + '.' + i] !== undefined; i++) out += jar[key + '.' + i];
      try { return decodeURIComponent(out); } catch { return null; }
    },
    setItem(key, value) {
      if (!useCookies) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } return; }
      const enc = encodeURIComponent(value);
      const parts = [];
      for (let i = 0; i < enc.length; i += CHUNK) parts.push(enc.slice(i, i + CHUNK));
      parts.forEach((p, i) => { document.cookie = key + '.' + i + '=' + p + '; Max-Age=34560000' + cookieTail; });
      for (let i = parts.length; i < MAX_CHUNKS; i++) document.cookie = key + '.' + i + '=; Max-Age=0' + cookieTail;
    },
    removeItem(key) {
      if (!useCookies) { try { localStorage.removeItem(key); } catch { /* storage blocked */ } return; }
      for (let i = 0; i < MAX_CHUNKS; i++) document.cookie = key + '.' + i + '=; Max-Age=0' + cookieTail;
    },
  };

  // Someone signed in before shared sign-in existed keeps their session: move it into the cookie.
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      if (!cookieStorage.getItem(STORAGE_KEY)) cookieStorage.setItem(STORAGE_KEY, legacy);
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch { /* storage blocked */ }

  function clientOptions() {
    return {
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit',
      storage: cookieStorage, storageKey: STORAGE_KEY,
    };
  }

  // ---------- helpers ----------
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("Couldn't reach the account service. Check your connection and try again.")), ms))]);
  const getMode = () => { try { return localStorage.getItem(MODE_KEY) || 'code'; } catch { return 'code'; } };
  const setMode = (m) => { try { localStorage.setItem(MODE_KEY, m); } catch { /* fine */ } };
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined) n.append(c);
    return n;
  }
  function friendly(err, fallback) {
    const m = String((err && err.message) || err || '');
    if (/invalid login credentials/i.test(m)) return "That email and password don't match. Never set a password? Sign in with a code instead.";
    if (/rate|seconds|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    if (/token has expired|is invalid|otp/i.test(m)) return "That code didn't work or has expired. Send a new one.";
    if (/email not confirmed/i.test(m)) return 'This email is not confirmed yet. Sign in with a code instead.';
    if (/should be different/i.test(m)) return 'That is already your password. Choose a new one.';
    if (/weak|pwned|leaked|known to be/i.test(m)) return 'That password is too easy to guess or has appeared in a data breach. Choose another.';
    return fallback + (m ? ' ' + m : '');
  }
  let styled = false;
  function addStyles() {
    if (styled) return;
    styled = true;
    document.head.append(h('style', { text: [
      '.sx-auth{display:flex;flex-direction:column;gap:14px}',
      '.sx-auth .sx-links{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px}',
      '.sx-auth .sx-link{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer;min-height:32px}',
      '.sx-auth .sx-code{letter-spacing:.3em;font-variant-numeric:tabular-nums;font-size:20px}',
      '.sx-auth .sx-note{margin:0;font-size:14px;opacity:.8}',
      '.sx-auth .sx-captcha{min-height:65px}',
    ].join('\n') }));
  }
  // ---------- bot check (Cloudflare Turnstile) ----------
  let turnstileLoad = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!turnstileLoad) {
      turnstileLoad = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        sc.async = true;
        sc.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile')));
        sc.onerror = () => { turnstileLoad = null; reject(new Error('blocked')); };
        document.head.append(sc);
      });
    }
    return turnstileLoad;
  }
  // One check per form. token() is '' until the check passes; reset() gives a fresh one (each answer works once).
  function botCheck() {
    if (!TURNSTILE_SITE_KEY) return { el: null, token: () => undefined, reset() {}, ready: () => true };
    let token = ''; let wid = null; let failed = false;
    const el = h('div', { class: 'sx-captcha' });
    loadTurnstile().then((ts) => {
      wid = ts.render(el, {
        sitekey: TURNSTILE_SITE_KEY, theme: 'dark', size: 'flexible', action: 'sign-in',
        callback: (t) => { token = t; },
        'expired-callback': () => { token = ''; },
        'error-callback': () => { token = ''; },
      });
    }).catch(() => { failed = true; });
    return {
      el,
      token: () => token || undefined,
      ready: () => !!token,
      failed: () => failed,
      reset() { token = ''; if (wid !== null && window.turnstile) window.turnstile.reset(wid); },
    };
  }
  function needCheck(check, status) {
    if (check.ready()) return false;
    setStatus(status, check.failed && check.failed() ? "The security check didn't load. Check your connection and refresh the page." : 'One moment: finish the security check above the button.', 'err');
    return true;
  }

  function setStatus(el, text, kind) { el.textContent = text; el.className = 'status' + (kind ? ' ' + kind : ''); }

  // ---------- sign-in panel ----------
  // opts: { client, redirectTo, onSignedIn(session), buttonClass }
  function mountSignIn(root, opts) {
    addStyles();
    const { client } = opts;
    const btnClass = opts.buttonClass || 'btn';
    const state = { mode: getMode(), email: '' };
    let uid = 0;
    const id = (s) => 'sx-' + s + '-' + (++uid);

    function emailField(value) {
      const fid = id('email');
      const input = h('input', { class: 'input', id: fid, type: 'email', name: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com', value: value || state.email });
      return { input, el: h('div', { class: 'field' }, h('label', { for: fid, text: 'Email' }), input) };
    }
    function link(text, fn) { return h('button', { type: 'button', class: 'sx-link', text, onclick: fn }); }
    function go(mode) { state.mode = mode; render(); }
    function done(session) { if (opts.onSignedIn) opts.onSignedIn(session); }

    function render() {
      root.replaceChildren();
      const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
      let form;

      if (state.mode === 'password') {
        const email = emailField();
        const pid = id('pw');
        const pw = h('input', { class: 'input', id: pid, type: 'password', name: 'password', autocomplete: 'current-password', required: true });
        const btn = h('button', { class: btnClass, type: 'submit', text: 'Sign in' });
        const check = botCheck();
        form = h('form', { class: 'sx-auth', novalidate: true },
          email.el,
          h('div', { class: 'field' }, h('label', { for: pid, text: 'Password' }), pw),
          check.el, btn, status,
          h('div', { class: 'sx-links' },
            link('Email me a code instead', () => { state.email = email.input.value.trim(); setMode('code'); go('code'); }),
            link('Forgot your password?', () => { state.email = email.input.value.trim(); go('code'); })));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!email.input.checkValidity()) { setStatus(status, 'Enter a valid email address.', 'err'); email.input.focus(); return; }
          if (!pw.value) { setStatus(status, 'Enter your password.', 'err'); pw.focus(); return; }
          if (needCheck(check, status)) return;
          btn.disabled = true; setStatus(status, 'Signing in…');
          try {
            const { data, error } = await within(client.auth.signInWithPassword({ email: email.input.value.trim(), password: pw.value, options: { captchaToken: check.token() } }), 15000);
            if (error) throw error;
            setMode('password');
            done(data.session);
          } catch (err) { setStatus(status, friendly(err, "Couldn't sign in."), 'err'); btn.disabled = false; check.reset(); }
        });
      } else if (state.mode === 'code') {
        const email = emailField();
        const btn = h('button', { class: btnClass, type: 'submit', text: 'Email me a sign-in code' });
        const check = botCheck();
        form = h('form', { class: 'sx-auth', novalidate: true },
          email.el, check.el, btn, status,
          h('p', { class: 'sx-note', text: 'New here? The same code creates your Sogilex account.' }),
          h('div', { class: 'sx-links' }, link('Sign in with a password', () => { state.email = email.input.value.trim(); go('password'); })));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!email.input.checkValidity()) { setStatus(status, 'Enter a valid email address.', 'err'); email.input.focus(); return; }
          if (needCheck(check, status)) return;
          btn.disabled = true; setStatus(status, 'Sending…');
          try {
            const { error } = await within(client.auth.signInWithOtp({
              email: email.input.value.trim(),
              options: { emailRedirectTo: opts.redirectTo || location.href.split('#')[0], shouldCreateUser: true, captchaToken: check.token() },
            }), 15000);
            if (error) throw error;
            state.email = email.input.value.trim();
            go('verify');
          } catch (err) { setStatus(status, friendly(err, "Couldn't send the code."), 'err'); btn.disabled = false; check.reset(); }
        });
      } else {
        const cid = id('code');
        const code = h('input', { class: 'input sx-code', id: cid, name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6,10}', maxlength: '10', required: true });
        const btn = h('button', { class: btnClass, type: 'submit', text: 'Sign in' });
        const check = botCheck();
        form = h('form', { class: 'sx-auth', novalidate: true },
          h('p', { class: 'sx-note' }, 'We sent a code to ', h('strong', { text: state.email }), '. Enter it here, or click the link in the email.'),
          h('div', { class: 'field' }, h('label', { for: cid, text: 'Sign-in code' }), code),
          check.el, btn, status,
          h('div', { class: 'sx-links' },
            link('Send a new code', () => go('code')),
            link('Use a different email', () => { state.email = ''; go('code'); })));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const token = code.value.replace(/\D/g, '');
          if (token.length < 6) { setStatus(status, 'Enter the code from the email.', 'err'); code.focus(); return; }
          if (needCheck(check, status)) return;
          btn.disabled = true; setStatus(status, 'Checking…');
          try {
            const { data, error } = await within(client.auth.verifyOtp({ email: state.email, token, type: 'email', options: { captchaToken: check.token() } }), 15000);
            if (error) throw error;
            done(data.session);
          } catch (err) { setStatus(status, friendly(err, "Couldn't sign in."), 'err'); btn.disabled = false; check.reset(); }
        });
        setTimeout(() => code.focus(), 0);
      }
      form.append(h('p', { class: 'sx-note sx-legal' }, 'By signing in you agree to the ',
        h('a', { href: 'https://sogilex.com/terms/', target: '_blank', rel: 'noopener', text: 'Terms' }), ' and ',
        h('a', { href: 'https://sogilex.com/privacy/', target: '_blank', rel: 'noopener', text: 'Privacy policy' }), '.'));
      root.append(form);
    }
    render();
  }

  // ---------- set or change a password (signed in) ----------
  function mountPasswordForm(root, opts) {
    addStyles();
    const { client } = opts;
    const n = Math.random().toString(36).slice(2, 7);
    const pw = h('input', { class: 'input', id: 'sx-new-' + n, type: 'password', autocomplete: 'new-password', minlength: '8', required: true });
    const pw2 = h('input', { class: 'input', id: 'sx-again-' + n, type: 'password', autocomplete: 'new-password', minlength: '8', required: true });
    const btn = h('button', { class: opts.buttonClass || 'btn', type: 'submit', text: 'Save password' });
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const form = h('form', { class: 'sx-auth', novalidate: true },
      h('p', { class: 'sx-note', text: 'Set a password to sign in without waiting for an email. You can always sign in with a code instead.' }),
      h('div', { class: 'field' }, h('label', { for: pw.id, text: 'New password (at least 8 characters)' }), pw),
      h('div', { class: 'field' }, h('label', { for: pw2.id, text: 'Type it again' }), pw2),
      btn, status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (pw.value.length < 8) { setStatus(status, 'Use at least 8 characters.', 'err'); pw.focus(); return; }
      if (pw.value !== pw2.value) { setStatus(status, "The two passwords don't match.", 'err'); pw2.focus(); return; }
      btn.disabled = true; setStatus(status, 'Saving…');
      try {
        const { error } = await within(client.auth.updateUser({ password: pw.value }), 15000);
        if (error) throw error;
        setMode('password');
        pw.value = ''; pw2.value = '';
        setStatus(status, 'Saved. Next time, sign in with your email and this password.', 'ok');
      } catch (err) { setStatus(status, friendly(err, "Couldn't save the password."), 'err'); }
      btn.disabled = false;
    });
    root.replaceChildren(form);
  }

  return { clientOptions, cookieStorage, mountSignIn, mountPasswordForm, STORAGE_KEY };
})();
