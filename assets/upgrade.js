// Sogilex upgrade prompts, shared by every tool (Build, Menus, Flyers, Posts, Invoices).
//
//   SogilexUpgrade.init(db)            once per page, with the page's Supabase client (reads the plans and your plan).
//   SogilexUpgrade.offer(message)      call with any error message: when it's a plan limit, shows the upgrade box
//                                      (what you hit, and the plans that would give you more, each with a Choose
//                                      button to checkout) and returns true. Any other message returns false.
//   SogilexUpgrade.trialBar(kind)      on the free trial, a line above the tool: "Free trial: 0 of 1 flyer used · See
//                                      plans". kind: 'builds' | 'flyers' | 'posts' | 'docs' | 'menu'.
//   SogilexUpgrade.refresh()           re-reads your plan (after saving something that counts).
//   SogilexUpgrade.isTrial()           true on the free trial (once the plan has loaded); ready() resolves when it has.
//   SogilexUpgrade.gate(kind)          before a download/print: 'export' (flyers, posts, menus, invoices) is refused once
//                                      the free trial has ended; 'site' (download/copy/open a website) needs a plan with
//                                      publishing (the trial is preview only). Refused = the upgrade box opens, returns false.
//   SogilexUpgrade.MARK                the line free-trial downloads carry (Flyers, Posts, Menus, Invoices): any paid
//                                      plan drops it. It's in the preview too, so what you see is what you get.
//
// The limits themselves are enforced by the database (021 plans); this only explains them and shows the way up.
// Prices and plan names come from the plans table, so a price change needs no change here.
window.SogilexUpgrade = (() => {
  let db = null; let plans = null; let mine = null; let loading = null;
  // The database's limit messages (plan_full, plan_item_cap, publish_site, publish_menu). Daily limits on Beta/Team
  // ("for today") aren't offers: nothing to buy.
  const LIMIT = /free trial has ended|Downloading or copying your website|The free trial includes|aren't part of the .* plan|for this month\. They reset|the most your plan allows|isn't included in your plan|aren't included in your plan/i;
  // Things only plans with publishing and websites include, so Basics would not help.
  const NEEDS_SITE = /website|publish|online menu/i;

  function init(client) { db = client; load(); }
  function load(force) {
    if (!db) return Promise.resolve();
    if (loading && !force) return loading;
    loading = (async () => {
      try {
        const [p, m] = await Promise.all([
          db.from('plans').select('id, name, blurb, month_cents, year_cents, can_publish, public, sort, limits').order('sort'),
          db.rpc('my_plan'),
        ]);
        if (!p.error) plans = p.data || [];
        if (!m.error) mine = m.data || null;
      } catch { /* offline: the box still opens, without prices */ }
    })();
    return loading;
  }
  const refresh = () => load(true).then(() => drawBars());

  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v);
    }
    kids.flat().forEach((c) => { if (c != null) n.append(c); });
    return n;
  };
  const dollars = (c) => '$' + (c % 100 ? (c / 100).toFixed(2) : String(c / 100));

  // Which plans would help: self-serve plans above the current one, without Basics when the limit is about websites,
  // publishing or the online menu.
  function options(message) {
    const cur = mine && mine.plan ? mine.plan : null;
    const curPrice = cur ? (cur.month_cents || 0) : 0;
    const list = (plans || []).filter((p) => p.public && ['basics', 'diy'].includes(p.id));
    return list.filter((p) => (!cur || p.id !== cur.id) && (p.month_cents || 0) > curPrice && !(p.id === 'basics' && NEEDS_SITE.test(message)));
  }
  function title(message) {
    if (/free trial has ended/i.test(message)) return 'Your free trial has ended';
    if (/Downloading or copying your website/i.test(message)) return 'Download your site with Do it yourself';
    if (/free trial/i.test(message)) return "You've used the free trial for this";
    if (/aren't part of|isn't included|aren't included/i.test(message)) return 'Not included in your plan';
    if (/this month/i.test(message)) return "You've used this month's allowance";
    return 'Your plan is full';
  }

  let dlg = null;
  function box() {
    if (dlg) return dlg;
    dlg = el('dialog', { class: 'up-dlg', 'aria-labelledby': 'up-title' });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click outside closes
    document.body.append(dlg);
    return dlg;
  }
  let lastMsg = ''; let lastAt = 0;
  function offer(message) {
    const msg = String(message || '');
    if (!LIMIT.test(msg)) return false;
    // Autosave can hit the same limit on every keystroke: open the box once, then stay quiet for a minute.
    if (msg === lastMsg && Date.now() - lastAt < 60000) return true;
    lastMsg = msg; lastAt = Date.now();
    const opts = options(msg);
    if (plans && !opts.length) return false; // already on the top self-serve plan: the plain message says it all
    const d = box();
    const cards = (plans ? opts : []).map((p) => el('div', { class: 'up-plan' + (p.id === 'diy' ? ' up-best' : '') },
      el('div', { class: 'up-plan-top' }, el('strong', { text: p.name }), el('span', { class: 'up-price', text: p.month_cents ? `${dollars(p.month_cents)}/month` : '' })),
      el('p', { text: p.blurb || '' }),
      el('a', { class: p.id === 'diy' ? 'btn' : 'ghost up-choose', href: `/checkout/?plan=${encodeURIComponent(p.id)}&billing=month`, text: `Choose ${p.name}` })));
    d.replaceChildren(
      el('h2', { id: 'up-title', text: title(msg) }),
      el('p', { class: 'up-msg', text: msg.replace(/\s*Choose a plan[^.]*\.?$/i, '').trim() }),
      cards.length ? el('div', { class: 'up-plans' }, cards) : el('p', { class: 'up-msg' }, el('a', { href: '/account/#sec-plan', text: 'See the plans' })),
      el('div', { class: 'up-foot' },
        el('a', { class: 'linkbtn', href: '/account/#sec-plan', text: 'Compare all plans' }),
        el('button', { type: 'button', class: 'ghost', text: 'Not now', onclick: () => d.close() })));
    if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
    const first = d.querySelector('.up-plans a, .up-foot button'); if (first) first.focus();
    return true;
  }

  // ----- the free-trial line above a tool -----
  const KIND = {
    menu: null, // Menus: days left only (one menu per account)
    builds: ['website', 'websites', (m) => [m.used.builds || 0, m.builds_allowed]],
    flyers: ['flyer', 'flyers', (m) => [m.used.flyers || 0, m.plan.limits.flyers]],
    posts: ['post', 'posts', (m) => [m.used.posts || 0, m.plan.limits.posts]],
    docs: ['quote or invoice', 'quotes and invoices', (m) => [m.used.docs || 0, m.plan.limits.docs]],
  };
  const bars = [];
  function trialBar(kind) {
    const lede = document.querySelector('main .lede');
    if (!lede || !(kind in KIND)) return;
    const bar = el('p', { class: 'up-bar', hidden: '' });
    lede.before(bar);
    bars.push([bar, kind]);
    load().then(drawBars);
  }
  function drawBars() {
    for (const [bar, kind] of bars) {
      const m = mine;
      if (!m || !m.plan || !m.plan.limits || m.plan.limits.window !== 'ever') { bar.hidden = true; continue; }
      if (m.plan.id === 'expired') {
        bar.replaceChildren(el('span', { class: 'up-tag', text: 'Trial ended' }), 'Your free trial has ended. Your work is saved: choose a plan to keep editing and downloading. ',
          el('a', { href: '/account/#sec-plan', text: 'See plans' }));
        bar.classList.add('up-full'); bar.hidden = false; continue;
      }
      const days = m.trial_ends ? Math.max(1, Math.ceil((new Date(m.trial_ends) - Date.now()) / 86400000)) : null;
      const parts = [el('span', { class: 'up-tag', text: 'Free trial' }), days ? `${days} ${days === 1 ? 'day' : 'days'} left. ` : ''];
      let full = false;
      if (KIND[kind]) {
        const [one, many, count] = KIND[kind];
        const [used, allowed] = count(m);
        full = used >= allowed;
        parts.push(`${Math.min(used, allowed)} of ${allowed} ${allowed === 1 ? one : many} used. `);
      }
      parts.push(el('a', { href: '/account/#sec-plan', text: full ? 'Upgrade to make more' : 'See plans' }));
      bar.replaceChildren(...parts);
      bar.classList.toggle('up-full', full);
      bar.hidden = false;
    }
  }
  const isExpired = () => !!(mine && mine.plan && mine.plan.id === 'expired');
  // Unknown plan (still loading or offline): let it through; the database still enforces what matters.
  function gate(kind) {
    if (!mine) return true;
    if (kind === 'site' && !mine.can_publish) return !offer('Downloading or copying your website comes with Do it yourself, along with publishing it at your-name.sogilex.net. On the free trial you can preview it here.');
    if (isExpired()) return !offer('Your free trial has ended. Your work is saved: choose a plan to keep editing, downloading and printing.');
    return true;
  }
  const isTrial = () => !!(mine && mine.plan && mine.plan.limits && mine.plan.limits.window === 'ever');
  const ready = () => load();
  return { init, offer, trialBar, refresh, isTrial, isExpired, gate, ready, MARK: 'Made with Sogilex · sogilex.com' };
})();
