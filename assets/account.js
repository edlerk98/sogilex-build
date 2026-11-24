// Sogilex: your account (build.sogilex.com/account/). One place to see everything saved to the account (websites,
// menu, flyers, posts, quotes and invoices, logo and photos) and open it in its tool (?open=<id>), plus account
// settings. It only reads what the tools already save; nothing new is stored here.
(() => {
  const SUPABASE_URL = 'https://sdltqbctuieyjlujsdhj.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM'; // public by design; RLS protects data
  const $ = (id) => document.getElementById(id);
  const db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: window.SogilexAuth ? window.SogilexAuth.clientOptions() : { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  async function session() { try { const { data } = await within(db.auth.getSession(), 10000); return data.session; } catch { return null; } }

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const decode = (t) => new DOMParser().parseFromString(t || '', 'text/html').body.textContent.trim();
  const money = (c) => { c = Number(c) || 0; const neg = c < 0; c = Math.abs(c); return `${neg ? '−' : ''}$${Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(c % 100).padStart(2, '0')}`; };
  const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const SHOW = 6; // items shown per section before "Show all"
  let uidNow = null;

  // Runs one query; a failure shows in its own section instead of breaking the page.
  async function get(fn) { try { const r = await within(fn(), 12000); if (r.error) throw r.error; return { ok: true, data: r.data }; } catch { return { ok: false, data: null }; } }

  // ---------- sections ----------
  function section(id, title, count, kids, actions) {
    return h('section', { class: 'panel acct-sec', id: `sec-${id}`, 'aria-labelledby': `h-${id}` },
      h('div', { class: 'acct-sec-head' },
        h('h2', { class: 'panel-h', id: `h-${id}` }, title, count !== null ? h('span', { class: 'acct-count', text: String(count) }) : null),
        actions || null),
      kids);
  }
  // A list of rows, the first few shown, the rest behind "Show all".
  function rows(items, empty) {
    if (!items.length) return h('p', { class: 'muted acct-empty', text: empty });
    const ul = h('ul', { class: 'acct-list' }, items.map((it, i) => {
      const li = h('li', { class: 'acct-row' + (i >= SHOW ? ' acct-more' : '') },
        h('div', { class: 'acct-row-main' },
          h('span', { class: 'acct-row-title', text: it.title }),
          h('span', { class: 'acct-row-sub', text: it.sub })),
        it.badge ? h('span', { class: `acct-badge ${it.badgeClass || ''}`, text: it.badge }) : null,
        h('a', { class: 'btn btn-secondary acct-open', href: it.href, 'aria-label': `Open ${it.title}`, text: 'Open' }),
        it.del ? h('button', { type: 'button', class: 'iconbtn danger acct-delbtn', 'aria-label': `Delete ${it.title}`, text: 'Delete', onclick: (e) => removeItem(e.currentTarget, li, it) }) : null);
      return li;
    }));
    const out = [ul];
    if (items.length > SHOW) {
      ul.classList.add('collapsed');
      const btn = h('button', { type: 'button', class: 'linkbtn acct-all', text: `Show all ${items.length}` });
      btn.addEventListener('click', () => { const c = ul.classList.toggle('collapsed'); btn.textContent = c ? `Show all ${items.length}` : 'Show fewer'; });
      out.push(btn);
    }
    return out;
  }
  // Delete one thing, after asking. The row disappears and the counts go down; a refusal is shown as is.
  async function removeItem(btn, li, it) {
    if (!confirm(it.confirm || `Delete "${it.title}"? This can't be undone.`)) return;
    btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      await it.del();
      const sec = li.closest('.acct-sec'); const cnt = sec && sec.querySelector('.acct-count');
      li.remove();
      if (cnt) cnt.textContent = String(Math.max(0, Number(cnt.textContent) - 1));
      const sum = $('acct-load'); const m = /^(\d+)/.exec(sum.textContent);
      if (m) { const n = Number(m[1]) - 1; sum.textContent = n ? `${n} thing${n === 1 ? '' : 's'} saved to your account.` : 'Nothing saved yet. Everything you make in any tool shows up here.'; }
      const ul = sec && sec.querySelector('.acct-list');
      if (ul && !ul.children.length) ul.replaceWith(h('p', { class: 'muted acct-empty', text: 'Nothing here now.' }));
      else if (ul) { [...ul.children].forEach((x, i) => x.classList.toggle('acct-more', i >= SHOW)); }
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Delete';
      alert((e && e.message && !/fetch|network|timeout/i.test(e.message)) ? e.message : "Couldn't delete it. Check your connection and try again.");
    }
  }
  const must = async (p) => { const r = await within(p, 12000); if (r.error) throw r.error; return r; };
  const newBtn = (href, text) => h('a', { class: 'btn btn-secondary acct-new', href, text });

  function websites(builds, site) {
    if (!builds.ok) return section('sites', 'Websites', null, h('p', { class: 'muted', text: "Couldn't load your websites. Refresh to try again." }));
    const list = builds.data || [];
    const items = list.map((b) => ({
      title: decode(b.title) || 'Untitled site',
      sub: `${b.kind === 'edit' || b.kind === 'manual' ? `Changed: ${b.note || 'edited'}` : 'Built'} · ${day(b.created_at)}`,
      badge: b.live ? 'Published' : null, badgeClass: 'b-live',
      href: `../?open=${encodeURIComponent(b.build_id)}`,
      del: b.live ? null : () => must(db.rpc('delete_my_build', { p_id: b.build_id })),
      confirm: `Delete this version of "${decode(b.title) || 'Untitled site'}" from ${day(b.created_at)}? Your other versions stay. This can't be undone.`,
    }));
    const slug = site.ok && site.data && site.data.slug;
    return section('sites', 'Websites', list.length, [
      slug ? h('p', { class: 'acct-note' }, 'Published at ', h('a', { href: `https://${slug}.sogilex.net/`, target: '_blank', rel: 'noopener', text: `${slug}.sogilex.net` }),
        site.data.messages ? ` · ${site.data.messages} message${site.data.messages === 1 ? '' : 's'} from its contact form (read them in Build)` : '') : null,
      list.length ? h('p', { class: 'muted acct-hint', text: 'Every version is kept, newest first. Opening one shows it in Build, where you can change it, download it or publish it. The published version can\'t be deleted until you unpublish it in Build.' }) : null,
      rows(items, 'No websites yet.'),
    ], newBtn('../', 'Build a website'));
  }

  function menu(m, online) {
    if (!m.ok) return section('menu', 'Menu', null, h('p', { class: 'muted', text: "Couldn't load your menu. Refresh to try again." }));
    const d = m.data && m.data.data;
    const dishes = d && Array.isArray(d.sections) ? d.sections.reduce((n, s) => n + ((s.items || []).filter((i) => (i.name || '').trim()).length), 0) : 0;
    const slug = online.ok && online.data && online.data.slug;
    const items = d ? [{ title: (d.name || '').trim() || 'Your menu', sub: `${d.sections.length} section${d.sections.length === 1 ? '' : 's'} · ${dishes} dish${dishes === 1 ? '' : 'es'} · saved ${day(m.data.updated_at)}`, href: '../menus/',
      del: async () => { if (slug) await must(db.rpc('unpublish_menu')); await must(db.from('menus').delete().eq('user_id', m.data.user_id || uidNow)); },
      confirm: `Delete your menu${d.name ? ` "${d.name}"` : ''}? ${slug ? 'Your online menu turns off too, so its QR code will stop working. ' : ''}Printed copies aren't affected. This can't be undone.` }] : [];
    return section('menu', 'Menu', null, [
      slug ? h('p', { class: 'acct-note' }, 'Online menu: ', h('a', { href: `https://${slug}.sogilex.net/menu`, target: '_blank', rel: 'noopener', text: `${slug}.sogilex.net/menu` })) : null,
      rows(items, 'No menu yet.'),
    ], d ? null : newBtn('../menus/', 'Make a menu'));
  }

  function many(id, title, res, noun, path) {
    if (!res.ok) return section(id, title, null, h('p', { class: 'muted', text: `Couldn't load your ${noun}s. Refresh to try again.` }));
    const list = res.data || [];
    const items = list.map((r) => {
      const d = r.data || {};
      const size = { letter: 'Letter', a4: 'A4', square: 'Square', story: 'Story' }[d.size] || '';
      return { title: (d.headline || '').trim() || `Untitled ${noun}`, sub: [size, `saved ${day(r.updated_at)}`].filter(Boolean).join(' · '), href: `../${path}/?open=${encodeURIComponent(r.id)}`,
        del: () => must(db.from(path).delete().eq('id', r.id)) };
    });
    return section(id, title, list.length, rows(items, `No ${noun}s yet.`), newBtn(`../${path}/`, `Make a ${noun}`));
  }

  function invoices(res) {
    if (!res.ok) return section('inv', 'Quotes & invoices', null, h('p', { class: 'muted', text: "Couldn't load your quotes and invoices. Refresh to try again." }));
    const list = res.data || [];
    const today = isoToday();
    const label = (r) => {
      if (r.status === 'draft') return ['Draft', 'b-draft'];
      if (r.kind === 'invoice') {
        if (r.status === 'sent') return r.due_date && r.due_date < today ? ['Overdue', 'b-late'] : ['Unpaid', 'b-open'];
        return r.status === 'paid' ? ['Paid', 'b-paid'] : ['Cancelled', 'b-void'];
      }
      return { sent: ['Sent', 'b-open'], accepted: ['Accepted', 'b-paid'], declined: ['Declined', 'b-void'] }[r.status] || [r.status, ''];
    };
    const num = (r) => (r.number ? `${r.kind === 'invoice' ? 'INV-' : 'Q-'}${String(r.number).padStart(4, '0')}` : 'Draft');
    const items = list.map((r) => {
      const [badge, badgeClass] = label(r);
      const who = r.data && r.data.to && r.data.to.name ? r.data.to.name : 'No customer yet';
      return { title: `${r.kind === 'invoice' ? 'Invoice' : 'Quote'} ${num(r)} · ${who}`, sub: `${money(r.total_cents)} · ${day(r.updated_at)}`, badge, badgeClass, href: `../invoices/?open=${encodeURIComponent(r.id)}`,
        del: r.status === 'draft' ? () => must(db.from('inv_docs').delete().eq('id', r.id).eq('status', 'draft')) : null,
        confirm: `Delete this draft ${r.kind} for ${who}? This can't be undone.` };
    });
    const unpaid = list.filter((r) => r.kind === 'invoice' && r.status === 'sent');
    const owed = unpaid.reduce((a, r) => a + Number(r.total_cents), 0);
    return section('inv', 'Quotes & invoices', list.length, [
      unpaid.length ? h('p', { class: 'acct-note', text: `Unpaid: ${money(owed)} across ${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'}.` }) : null,
      list.length ? h('p', { class: 'muted acct-hint', text: 'Only drafts can be deleted. Sent quotes and invoices stay for your records; to undo an invoice, open it and cancel it.' }) : null,
      rows(items, 'No quotes or invoices yet.'),
    ], newBtn('../invoices/', 'Make an invoice'));
  }

  function brand(kit, photos) {
    const n = photos.ok ? (photos.data || []).length : null;
    return section('brand', 'Logo & photos', null, h('div', { class: 'acct-brand' },
      h('div', { class: 'acct-logo' }, kit && kit.logo ? h('img', { src: kit.logo, alt: 'Your logo' }) : h('span', { class: 'muted', text: 'No logo yet' })),
      h('div', { class: 'stack acct-brand-text' },
        h('p', { class: 'acct-note', text: kit && kit.logo ? 'Your logo is shared by every tool: websites, menus, flyers, posts and invoices.' : 'Add your logo once and every tool uses it.' }),
        h('p', { class: 'acct-note', text: n === null ? "Couldn't count your photos." : `${n} photo${n === 1 ? '' : 's'} in your library (up to 60). Upload or remove them in Build, under "Your photos".` }),
        h('a', { class: 'btn btn-secondary acct-open', href: '../#photos-field', text: 'Manage in Build' }))));
  }

  // ---------- your plan ----------
  const dollars = (c) => (c % 100 ? money(c) : `$${(c / 100).toLocaleString('en-US')}`);
  function priceLine(pl, billing) {
    if (!pl || (!pl.month_cents && !pl.year_cents)) return 'Free';
    const per = billing === 'year' && pl.year_cents ? `${dollars(pl.year_cents)}/year` : `${dollars(pl.month_cents)}/month`;
    return pl.setup_cents ? `${dollars(pl.setup_cents)} setup + ${per}` : per;
  }
  const shortName = (x) => x.name.replace(' (done for you)', '');
  function meter(label, used, allowed) {
    const pct = allowed > 0 ? Math.min(100, Math.round((used / allowed) * 100)) : 100;
    return h('div', { class: 'acct-meter' + (used >= allowed ? ' full' : '') },
      h('div', { class: 'acct-meter-top' }, h('span', { text: label }), h('span', { text: `${used} of ${allowed}` })),
      h('div', { class: 'acct-meter-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(allowed), 'aria-valuenow': String(Math.min(used, allowed)) }, h('i', { style: `width:${pct}%` })));
  }
  function planSection(res, plans) {
    if (!res.ok || !res.data || !res.data.plan) return section('plan', 'Your plan', null, h('p', { class: 'muted', text: "Couldn't load your plan. Refresh to try again." }));
    const d = res.data; const pl = d.plan; const L = pl.limits || {}; const u = d.used || {};
    const when = { today: 'Used today', 'this month': 'Used this month', 'on the free trial': 'Used on your free trial' }[d.when] || 'Used';
    // A plan without websites (Basics) shows no website meters ("0 of 0" would read as used up).
    const meters = [d.builds_allowed ? meter('New websites', u.builds || 0, d.builds_allowed) : null, L.edits ? meter('Website changes', u.edits || 0, L.edits) : null,
      meter('Captions', u.captions || 0, L.captions || 0), meter('Menus read from photos', u.imports || 0, L.imports || 0)].filter(Boolean);
    if (L.window === 'ever') meters.push(meter('Flyers', u.flyers || 0, L.flyers || 0), meter('Posts', u.posts || 0, L.posts || 0), meter('Quotes and invoices', u.docs || 0, L.docs || 0));
    const req = d.requested_plan && plans.find((x) => x.id === d.requested_plan);
    const chooser = h('div', { class: 'acct-chooser', id: 'plan-chooser', hidden: true });
    let billing = 'month';
    function drawChooser() {
      const options = plans.filter((x) => x.public && x.id !== 'trial' && x.id !== pl.id);
      chooser.replaceChildren(
        h('div', { class: 'choices acct-billing', role: 'group', 'aria-label': 'Billing' },
          ['month', 'year'].map((b) => h('button', { type: 'button', class: 'choice', 'aria-pressed': String(billing === b), onclick: () => { billing = b; drawChooser(); } }, b === 'month' ? 'Monthly' : 'Yearly (2 months free)'))),
        h('div', { class: 'acct-plans' }, options.map((x) => h('article', { class: 'acct-plan' },
          h('h3', { text: x.name }),
          h('p', { class: 'acct-plan-price', text: priceLine(x, billing) }),
          h('p', { class: 'muted', text: x.blurb }),
          h('a', { class: 'btn btn-secondary', href: `../checkout/?plan=${encodeURIComponent(x.id)}&billing=${billing}`, text: `Choose ${shortName(x)}` })))));
    }
    drawChooser();
    // Paid through Stripe: Stripe's own page changes the card, switches plan, shows receipts and cancels.
    // Complimentary and Team accounts were given by hand: nothing to change or pay.
    const handGiven = ['comp', 'team'].includes(pl.id);
    let toggle = null;
    if (d.billing_managed) {
      toggle = h('button', { type: 'button', class: 'btn', text: 'Manage billing' });
      toggle.addEventListener('click', () => openPortal(toggle));
    } else if (!handGiven) {
      toggle = h('button', { type: 'button', class: 'btn', text: 'Change plan' });
      toggle.addEventListener('click', () => { chooser.hidden = !chooser.hidden; toggle.textContent = chooser.hidden ? 'Change plan' : 'Hide plans'; });
      if (location.hash === '#sec-plan') { chooser.hidden = false; toggle.textContent = 'Hide plans'; }
    }
    return section('plan', 'Your plan', null, [
      h('div', { class: 'acct-plan-now' },
        h('div', {},
          h('p', { class: 'acct-plan-name', text: pl.name }),
          h('p', { class: 'muted', text: [priceLine(pl, d.billing), d.billing_managed && d.period_end ? `renews ${day(d.period_end)}` : '', d.billing_managed && d.status && d.status !== 'active' ? d.status.replace('_', ' ') : ''].filter(Boolean).join(' · ') }),
          h('p', { class: 'muted acct-hint', text: pl.blurb })),
        toggle),
      d.status === 'past_due' ? h('p', { class: 'acct-note acct-req', text: "Your last payment didn't go through. Use Manage billing to update your card, so your plan doesn't stop." }) : null,
      req && !d.billing_managed ? h('p', { class: 'acct-note acct-req', text: `You asked to switch to ${shortName(req)}${d.requested_billing ? ` (${d.requested_billing === 'year' ? 'yearly' : 'monthly'})` : ''} on ${day(d.requested_at)}. Payments aren't open yet: we'll email you when you can finish.` }) : null,
      h('p', { class: 'acct-hint muted', text: `${when}:` }),
      h('div', { class: 'acct-meters' }, meters),
      h('p', { class: 'muted acct-hint', text: d.can_publish ? 'Publishing your website and online menu: included.' : 'Publishing your website and online menu: not included in this plan.' }),
      d.billing_managed || handGiven ? null : chooser,
    ]);
  }
  async function openPortal(btn) {
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const { data: { session: s } } = await db.auth.getSession();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/billing`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: PUBLISHABLE_KEY },
        body: JSON.stringify({ action: 'portal' }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.url) throw new Error(j.error || "Couldn't open billing. Try again.");
      location.href = j.url;
    } catch (e) { btn.disabled = false; btn.textContent = 'Manage billing'; alert((e && e.message) || "Couldn't open billing. Try again."); }
  }

  function settings(user, mail) {
    const email = user.email || '';
    const m = mail.ok && mail.data;
    const pw = h('button', { type: 'button', class: 'btn btn-secondary', text: 'Change password' });
    pw.addEventListener('click', () => { SogilexAuth.mountPasswordForm($('pw-mount'), { client: db }); $('pwdialog').showModal(); });
    const out = h('button', { type: 'button', class: 'btn btn-secondary', text: 'Sign out' });
    out.addEventListener('click', signOut);
    const del = `mailto:hello@sogilex.com?subject=${encodeURIComponent('Delete my Sogilex account')}&body=${encodeURIComponent(`Please delete my Sogilex account (${email}) and everything in it.\n\nSent from the account email address.`)}`;
    return section('settings', 'Account', null, [
      h('dl', { class: 'acct-dl' },
        h('dt', { text: 'Signed in as' }), h('dd', { text: email }),
        h('dt', { text: 'Member since' }), h('dd', { text: day(user.created_at) }),
        h('dt', { text: 'Contact-form messages go to' }),
        h('dd', { text: m && m.email ? `${m.email}${m.confirmed_at ? '' : ' (waiting for you to confirm it)'}` : 'Only shown in Build (no email set). Set one in Build, under Publish.' })),
      h('div', { class: 'acct-actions' }, pw, out),
      h('div', { class: 'acct-danger' },
        h('h3', { text: 'Delete my account' }),
        h('p', { class: 'muted', text: 'This removes your account and everything in it: websites (including a published one), menu, flyers, posts, quotes, invoices, customers, logo and photos. It can\'t be undone. Download anything you want to keep first.' }),
        h('a', { class: 'btn btn-secondary acct-del', href: del, text: 'Email us to delete it' }),
        h('p', { class: 'muted acct-hint', text: 'Send it from your sign-in email address. We delete everything within 30 days and confirm by email.' })),
    ]);
  }

  async function signOut() { try { await within(db.auth.signOut(), 8000); } catch { /* cleared locally */ } location.reload(); }
  $('signout').addEventListener('click', signOut);
  $('pwbtn').addEventListener('click', () => { SogilexAuth.mountPasswordForm($('pw-mount'), { client: db }); $('pwdialog').showModal(); });

  (async () => {
    const s = await session();
    if (!s) {
      $('signin').hidden = false;
      SogilexAuth.mountSignIn($('signin-mount'), { client: db, redirectTo: location.href.split('#')[0], onSignedIn: () => location.reload() });
      return;
    }
    $('signout').hidden = false; $('pwbtn').hidden = false; $('account').hidden = false;
    const uid = s.user.id; uidNow = uid;
    const [planRes, plansRes, builds, site, m, online, flyers, posts, docs, photos, mail, kit] = await Promise.all([
      get(() => db.rpc('my_plan')),
      get(() => db.from('plans').select('id, name, blurb, month_cents, year_cents, setup_cents, can_publish, public, sort').order('sort')),
      get(() => db.rpc('my_builds')),
      get(() => db.rpc('my_site')),
      get(() => db.from('menus').select('user_id, data, updated_at').eq('user_id', uid).maybeSingle()),
      get(() => db.rpc('my_online_menu')),
      get(() => db.from('flyers').select('id, data, updated_at').order('updated_at', { ascending: false })),
      get(() => db.from('posts').select('id, data, updated_at').order('updated_at', { ascending: false })),
      get(() => db.from('inv_docs').select('id, kind, status, number, data, total_cents, due_date, updated_at').order('updated_at', { ascending: false })),
      get(() => db.from('site_photos').select('id')),
      get(() => db.from('message_emails').select('email, confirmed_at').maybeSingle()),
      window.SogilexBrand ? SogilexBrand.load(db, uid) : Promise.resolve(null),
    ]);
    const total = [builds, flyers, posts, docs].reduce((a, r) => a + (r.ok && r.data ? r.data.length : 0), 0) + (m.ok && m.data ? 1 : 0);
    $('acct-load').textContent = total ? `${total} thing${total === 1 ? '' : 's'} saved to your account.` : 'Nothing saved yet. Everything you make in any tool shows up here.';
    $('acct-body').replaceChildren(h('div', { class: 'acct-grid' },
      planSection(planRes, plansRes.ok ? plansRes.data || [] : []),
      websites(builds, site), menu(m, online),
      many('flyers', 'Flyers', flyers, 'flyer', 'flyers'), many('posts', 'Posts', posts, 'post', 'posts'),
      invoices(docs), brand(kit, photos), settings(s.user, mail)));
  })();
})();
