// Sogilex Quotes & invoices (beta): build.sogilex.com/invoices/
// No AI. Money is whole cents and quantities are hundredths, so every total is exact; the database works the totals
// out again with the same rules (supabase/018_invoices.sql) and its numbers are the ones stored.
// A draft has no number. "Mark as sent" gives it the next number (INV-0001, Q-0001) and locks it; mistakes are
// fixed by cancelling (void) and making a copy, so the numbers never have gaps.
(() => {
  const SUPABASE_URL = 'https://sdltqbctuieyjlujsdhj.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM'; // public by design; RLS protects data
  const $ = (id) => document.getElementById(id);
  const db = window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: window.SogilexAuth ? window.SogilexAuth.clientOptions() : { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });
  if (window.SogilexUpgrade) { SogilexUpgrade.init(db); SogilexUpgrade.trialBar('docs'); }
  const UP = (m) => !!(window.SogilexUpgrade && window.SogilexUpgrade.offer(m)); // a plan limit opens the upgrade box
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  async function session() { try { const { data } = await within(db.auth.getSession(), 10000); return data.session; } catch { return null; } }
  const COLS = 'id, kind, status, number, customer_id, source_id, data, issue_date, due_date, subtotal_cents, tax_cents, total_cents, sent_at, paid_on, updated_at';

  // ---------- money and dates (the same rules as the database) ----------
  // n / d rounded to the nearest whole number, halves away from zero.
  const roundDiv = (n, d) => (n < 0 ? -1 : 1) * Math.floor((Math.abs(n) + d / 2) / d);
  const lineAmount = (l) => roundDiv((l.q || 0) * (l.p || 0), 100);
  // Optional add-ons (l.o, quotes only) are left out of the total, as the database does (026); withAddons counts them.
  function totals(d, withAddons) {
    let sub = 0; let taxable = 0;
    for (const l of d.lines || []) { if (l.o && !withAddons) continue; const a = lineAmount(l); sub += a; if (l.t !== false) taxable += a; }
    const tax = roundDiv(taxable * (d.tax || 0), 100000);
    return { sub, tax, total: sub + tax };
  }
  function money(c) {
    const neg = c < 0; c = Math.abs(c);
    const dollars = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${neg ? '−' : ''}$${dollars}.${String(c % 100).padStart(2, '0')}`;
  }
  // "1,234.5" -> 123450 cents. Returns null if it isn't a plain amount with at most 2 decimals.
  function parseMoney(s) {
    s = String(s || '').replace(/[\s$,]/g, '').replace(/^−/, '-');
    if (s === '' || s === '-') return 0;
    const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(s);
    if (!m || (m[2] === '' && !m[3])) return null;
    const c = Number(m[2] || 0) * 100 + Number((m[3] || '').padEnd(2, '0'));
    if (c > 100000000) return null;
    return m[1] ? -c : c;
  }
  const centsText = (c) => (c < 0 ? '-' : '') + (Math.abs(c) / 100).toFixed(2);
  function parseQty(s) {
    s = String(s || '').replace(/[\s,]/g, '');
    if (s === '') return 0;
    const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
    if (!m || (m[1] === '' && !m[2])) return null;
    const q = Number(m[1] || 0) * 100 + Number((m[2] || '').padEnd(2, '0'));
    return q > 10000000 ? null : q;
  }
  const qtyText = (q) => (q % 100 ? (q / 100).toFixed(2).replace(/0$/, '') : String(q / 100));
  // "8.475" (percent) -> 8475 (thousandths of a percent)
  function parseRate(s) {
    s = String(s || '').replace(/[\s%]/g, '');
    if (s === '') return 0;
    const m = /^(\d{1,2})(?:\.(\d{0,3}))?$/.exec(s);
    if (!m) return null;
    const r = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
    return r > 30000 ? null : r;
  }
  const rateText = (r) => (r / 1000).toFixed(3).replace(/\.?0+$/, '');
  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = () => iso(new Date());
  const parts = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.split('-').map(Number) : null);
  function addDays(s, n) { const p = parts(s) || parts(today()); return iso(new Date(p[0], p[1] - 1, p[2] + n)); }
  function addMonths(s, n) {
    const p = parts(s) || parts(today());
    const last = new Date(p[0], p[1] - 1 + n + 1, 0).getDate(); // keeps the 31st as the last day of a short month
    return iso(new Date(p[0], p[1] - 1 + n, Math.min(p[2], last)));
  }
  function niceDate(s) {
    const p = parts(s); if (!p) return '';
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  }
  const daysBetween = (a, b) => { const x = parts(a); const y = parts(b); return Math.round((Date.UTC(y[0], y[1] - 1, y[2]) - Date.UTC(x[0], x[1] - 1, x[2])) / 86400000); };

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
  function labelled(id, label, input) { input.id = id; return h('div', { class: 'field' }, h('label', { for: id, text: label }), input); }

  // ---------- state ----------
  let uid = null;
  let kit = { logo: null, logo_name: null, colors: [] };
  let profile = {}; // business details: name, address, phone, email, website, pay, terms (days), taxDefault, accent
  let customers = []; // inv_customers rows
  let docs = []; // inv_docs rows, newest first
  let cur = null; // the open document: a row (id null until first saved)
  let filter = 'all';
  const ACCENTS = [['harbor', '#27467F'], ['rust', '#8E3B24'], ['sage', '#3D6B48'], ['berry', '#A8345A'], ['tavern', '#8A1F24'], ['ink', '#141414']];
  const TERMS = [[0, 'On receipt'], [7, '7 days'], [14, '14 days'], [30, '30 days']];
  const VALID = [[14, 'Valid 14 days'], [30, 'Valid 30 days'], [60, 'Valid 60 days']];

  const KIND = { invoice: { noun: 'invoice', Title: 'Invoice', prefix: 'INV-', due: 'Due' }, quote: { noun: 'quote', Title: 'Quote', prefix: 'Q-', due: 'Valid until' } };
  const numText = (r) => (r.number ? KIND[r.kind].prefix + String(r.number).padStart(4, '0') : 'Draft');
  const overdue = (r) => r.kind === 'invoice' && r.status === 'sent' && r.due_date && r.due_date < today();
  function statusText(r) {
    if (r.status === 'draft') return 'Draft';
    if (r.kind === 'invoice') return { sent: overdue(r) ? 'Overdue' : 'Unpaid', paid: 'Paid', void: 'Cancelled' }[r.status];
    return { sent: 'Sent', accepted: 'Accepted', declined: 'Declined' }[r.status];
  }
  const statusClass = (r) => (overdue(r) ? 'st-overdue' : `st-${r.status}`);
  const termsDays = () => (Number.isInteger(profile.terms) ? profile.terms : 14);
  const accentOf = (from) => {
    const id = (from || profile).accent;
    if (id === 'logo' && kit.colors && kit.colors[0] && window.SogilexBrand) return SogilexBrand.readableOnLight(kit.colors[0]);
    return (ACCENTS.find((a) => a[0] === id) || ACCENTS[0])[1];
  };

  function blankDoc(kind) {
    const date = today();
    return { id: null, kind, status: 'draft', number: null, customer_id: null, source_id: null,
      data: { v: 1, date, due: kind === 'quote' ? addDays(date, 30) : addDays(date, termsDays()), to: { name: '', email: '', phone: '', address: '' },
        lines: [{ d: '', q: 100, p: 0 }], tax: Number.isInteger(profile.taxDefault) ? profile.taxDefault : 0, notes: '',
        ...(kind === 'quote' ? { intro: '', showTerms: true, sign: true } : {}) } };
  }
  function normalizeData(d) {
    d = d && typeof d === 'object' ? d : {};
    const to = d.to && typeof d.to === 'object' ? d.to : {};
    return { ...d, v: 1, date: d.date || today(), due: d.due || '',
      to: { name: String(to.name || ''), email: String(to.email || ''), phone: String(to.phone || ''), address: String(to.address || '') },
      lines: Array.isArray(d.lines) ? d.lines.slice(0, 100).map((l) => ({ d: String(l.d || ''), q: Number.isInteger(l.q) ? l.q : 0, p: Number.isInteger(l.p) ? l.p : 0, ...(l.t === false ? { t: false } : {}), ...(l.o === true ? { o: true } : {}) })) : [],
      tax: Number.isInteger(d.tax) ? d.tax : 0, notes: String(d.notes || ''),
      intro: String(d.intro || ''), showTerms: d.showTerms !== false, sign: d.sign !== false };
  }
  const editable = () => cur && cur.status === 'draft';

  // ---------- saving ----------
  let saveTimer = null; let saving = null; let previewTimer = null; let profTimer = null;
  const say = (t) => { $('save-state').textContent = t; };
  function changed(rebuild) {
    if (rebuild) renderEditor();
    refreshNumbers();
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 100);
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 1000);
    say('Unsaved changes');
  }
  const friendly = (e) => {
    const m = (e && e.message) || '';
    if (/fetch|network|timeout|abort/i.test(m) || !m) return "Couldn't save. Check your connection.";
    UP(m);
    return m;
  };
  async function save() {
    if (!uid || !cur || !editable()) return false;
    if (saving) await saving.catch(() => {});
    clearTimeout(saveTimer);
    say('Saving…');
    const body = { data: cur.data, customer_id: cur.customer_id };
    saving = (async () => {
      if (cur.id) {
        const { data, error } = await db.from('inv_docs').update({ ...body, updated_at: new Date().toISOString() }).eq('id', cur.id).select(COLS).single().abortSignal(AbortSignal.timeout(10000));
        if (error) throw error;
        mergeRow(data);
      } else {
        const { data, error } = await db.from('inv_docs').insert({ ...body, kind: cur.kind, source_id: cur.source_id }).select(COLS).single().abortSignal(AbortSignal.timeout(10000));
        if (error) throw error;
        cur.id = data.id; docs.unshift(data); mergeRow(data);
      }
    })();
    try { await saving; say('Saved'); renderList(); return true; }
    catch (e) { say(friendly(e)); return false; }
    finally { saving = null; }
  }
  // Takes the database's copy of a row (its totals, status and number are the ones that count).
  function mergeRow(row) {
    const i = docs.findIndex((r) => r.id === row.id);
    if (i >= 0) docs[i] = row; else docs.unshift(row);
    if (cur && cur.id === row.id) { const keep = cur.data; cur = { ...row, data: cur.status === 'draft' && row.status === 'draft' ? keep : normalizeData(row.data) }; }
  }
  const pending = () => uid && /Unsaved|Saving/.test($('save-state').textContent);
  async function flush() { if (pending()) await save(); }

  function saveProfile() {
    clearTimeout(profTimer);
    say('Unsaved changes');
    profTimer = setTimeout(async () => {
      say('Saving…');
      try {
        const { error } = await db.from('inv_profile').upsert({ user_id: uid, data: profile, updated_at: new Date().toISOString() }).abortSignal(AbortSignal.timeout(10000));
        if (error) throw error;
        say('Saved');
      } catch (e) { say(friendly(e)); }
    }, 900);
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 100);
  }

  // ---------- actions ----------
  async function openDoc(id) {
    await flush();
    const row = docs.find((r) => r.id === id);
    if (!row) return;
    cur = { ...row, data: normalizeData(row.data) };
    say(row.status === 'draft' ? 'Saved' : '');
    renderAll();
  }
  async function newDoc(kind, from) {
    await flush();
    cur = blankDoc(kind);
    if (from) Object.assign(cur, from);
    say('');
    renderAll();
    if (from) save(); // a copy is saved straight away so it shows in the list
  }
  // A copy of any quote or invoice as a new draft (same customer, lines, tax and notes).
  function copyData(src, date, due) {
    const d = normalizeData(src.data);
    const out = { v: 1, date, due, to: { ...d.to }, lines: d.lines.map((l) => ({ ...l })), tax: d.tax, notes: d.notes };
    if (src.kind === 'quote') Object.assign(out, { intro: d.intro, showTerms: d.showTerms, sign: d.sign });
    return out;
  }
  function makeCopy() {
    const date = today();
    const due = cur.kind === 'quote' ? addDays(date, 30) : addDays(date, termsDays());
    newDoc(cur.kind, { customer_id: cur.customer_id, data: copyData(cur, date, due) });
  }
  function billAgain() {
    // Same invoice, dates moved on one month (the 31st becomes the last day of a shorter month).
    const d = normalizeData(cur.data);
    const date = addMonths(d.date, 1);
    const due = d.due ? addMonths(d.due, 1) : addDays(date, termsDays());
    newDoc('invoice', { customer_id: cur.customer_id, data: copyData(cur, date, due) });
  }
  // Started the wrong one? A draft can switch between quote and invoice: same customer, lines, tax and notes.
  async function switchKind() {
    if (!editable()) return;
    const to = cur.kind === 'quote' ? 'invoice' : 'quote';
    const adds = cur.data.lines.filter((l) => l.o).length;
    if (to === 'invoice' && adds && !confirm(`Invoices bill every line, so the ${adds} optional add-on${adds === 1 ? '' : 's'} will become ordinary line${adds === 1 ? '' : 's'}. Remove any the customer didn't choose afterwards.\n\nSwitch to an invoice?`)) return;
    await flush();
    const old = cur;
    const date = old.data.date || today();
    const data = { ...normalizeData(old.data), due: to === 'quote' ? addDays(date, 30) : addDays(date, termsDays()) };
    data.lines = data.lines.map(({ o, ...l }) => (to === 'invoice' ? l : { ...l, ...(o ? { o } : {}) }));
    if (to === 'quote') Object.assign(data, { intro: data.intro || '', showTerms: true, sign: true });
    try {
      const { data: row, error } = await db.from('inv_docs').insert({ kind: to, data, customer_id: old.customer_id, source_id: old.source_id }).select(COLS).single().abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      if (old.id) { await db.from('inv_docs').delete().eq('id', old.id); docs = docs.filter((r) => r.id !== old.id); }
      docs.unshift(row);
      cur = { ...row, data: normalizeData(row.data) };
      say(`Now a ${to} draft.`);
      renderAll();
    } catch (e) { say(friendly(e)); }
  }
  async function deleteDraft() {
    if (!cur) return;
    const label = cur.data.to.name ? `this draft for ${cur.data.to.name}` : 'this draft';
    if (!confirm(`Delete ${label}? This can't be undone.`)) return;
    clearTimeout(saveTimer);
    if (cur.id) {
      const { error } = await db.from('inv_docs').delete().eq('id', cur.id);
      if (error) { say("Couldn't delete it. Try again."); return; }
      docs = docs.filter((r) => r.id !== cur.id);
    }
    cur = null; say('Deleted');
    if (docs.length) openDoc(docs[0].id); else renderAll();
  }
  async function rpc(name, args, okText) {
    try {
      const { data, error } = await db.rpc(name, args).abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      mergeRow(row);
      say(okText || 'Saved');
      return row;
    } catch (e) { say(friendly(e)); return null; }
  }
  const nextNumber = (kind) => KIND[kind].prefix + String(1 + Math.max(0, ...docs.filter((r) => r.kind === kind && r.number).map((r) => r.number))).padStart(4, '0');
  async function markSent() {
    if (unreadable()) return;
    const k = KIND[cur.kind];
    // Blank lines (no words and no price) are left off.
    const kept = cur.data.lines.filter((l) => l.d.trim() || l.p);
    if (!cur.data.to.name.trim()) { say(`Add who the ${k.noun} is for first.`); $('to-name') && $('to-name').focus(); return; }
    if (!kept.length) { say('Add at least one line first.'); return; }
    if (cur.kind === 'quote' && !kept.some((l) => !l.o)) { say('Add at least one line that isn\'t an optional add-on first.'); return; }
    if (!confirm(`Mark this ${k.noun} as sent?\n\nIt gets the number ${nextNumber(cur.kind)} and can't be changed after that. (To fix a mistake later, cancel it and make a copy.)`)) return;
    if (kept.length !== cur.data.lines.length) cur.data.lines = kept;
    if (!(await save()) || !cur.id) return;
    const row = await rpc('inv_send', { p_id: cur.id });
    if (row) { say(`Sent: ${numText(row)}`); customers = await loadCustomers(); renderAll(); }
  }
  async function setStatus(status, paidOn) {
    const row = await rpc('inv_set_status', { p_id: cur.id, p_status: status, p_paid_on: paidOn || null });
    if (row) renderAll();
  }
  async function voidIt() {
    if (!confirm(`Cancel ${numText(cur)}?\n\nIt stays on your list marked "Cancelled", with its number, so your records have no gaps. This can't be undone.`)) return;
    setStatus('void');
  }
  // Which optional add-ons did the customer choose? (Their positions in the quote's lines.)
  function chooseAddons() {
    const adds = cur.data.lines.map((l, i) => ({ l, i })).filter((x) => x.l.o);
    if (!adds.length) return Promise.resolve([]);
    return new Promise((resolve) => {
      const dlg = h('dialog', { class: 'pwdialog inv-dialog', 'aria-labelledby': 'addons-h' });
      const boxes = adds.map((x) => h('label', { class: 'inv-addon-pick' }, h('input', { type: 'checkbox', value: String(x.i) }),
        h('span', { text: x.l.d || 'Add-on' }), h('strong', { text: `+${money(lineAmount(x.l))}` })));
      const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.append(h('form', { method: 'dialog', class: 'stack', onsubmit: (e) => { e.preventDefault(); done(boxes.map((b) => b.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.value))); } },
        h('h2', { class: 'panel-h', id: 'addons-h', text: 'Which add-ons did they choose?' }),
        h('p', { class: 'mhint', text: 'Ticked add-ons go on the invoice as ordinary lines. The rest are left off.' }),
        ...boxes,
        h('div', { class: 'inv-new' }, h('button', { type: 'submit', class: 'btn', text: 'Make the invoice' }), h('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => done(null) }))));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
      document.body.append(dlg); dlg.showModal();
    });
  }
  async function quoteToInvoice() {
    const date = today();
    const addons = await chooseAddons();
    if (addons === null) return;
    try {
      const { data, error } = await db.rpc('inv_quote_to_invoice', { p_id: cur.id, p_date: date, p_due: addDays(date, termsDays()), p_addons: addons }).abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      const inv = Array.isArray(data) ? data[0] : data;
      docs = await loadDocs();
      cur = { ...inv, data: normalizeData(inv.data) };
      say('Invoice made from the quote. Check it, then mark it as sent.');
      renderAll();
    } catch (e) { say(friendly(e)); }
  }

  // ---------- the editor ----------
  const lineRefs = []; // amount cells, updated as you type
  let totalsEl = null;
  function refreshNumbers() {
    if (!cur) return;
    cur.data.lines.forEach((l, i) => { if (lineRefs[i]) lineRefs[i].textContent = money(lineAmount(l)); });
    if (totalsEl) {
      const t = totals(cur.data);
      const anyAdd = cur.data.lines.some((l) => l.o);
      totalsEl.replaceChildren(...[ // (replaceChildren would print a null as the word "null")
        h('span', { text: `Subtotal ${money(t.sub)}` }),
        cur.data.tax ? h('span', { text: `Tax ${money(t.tax)}` }) : null,
        h('strong', { text: `Total ${money(t.total)}` }),
        anyAdd ? h('span', { class: 'inv-withadd', text: `With all add-ons ${money(totals(cur.data, true).total)}` }) : null].filter(Boolean));
    }
  }

  function listGroup() {
    const unpaid = docs.filter((r) => r.kind === 'invoice' && r.status === 'sent');
    const late = unpaid.filter(overdue);
    const sum = (rs) => rs.reduce((a, r) => a + Number(r.total_cents), 0);
    const chips = [['all', 'All'], ['invoice', 'Invoices'], ['quote', 'Quotes'], ['unpaid', 'Unpaid']];
    return h('div', { class: 'mgroup' },
      h('div', { class: 'inv-pick', role: 'group', 'aria-label': 'Start something new' },
        h('button', { type: 'button', class: 'inv-pick-card', onclick: () => newDoc('quote') },
          h('strong', { text: '+ New quote' }), h('span', { text: 'A price before the job. They say yes, then you turn it into an invoice.' })),
        h('button', { type: 'button', class: 'inv-pick-card', onclick: () => newDoc('invoice') },
          h('strong', { text: '+ New invoice' }), h('span', { text: 'A bill for work you\'ve done. They pay it.' }))),
      unpaid.length ? h('p', { class: 'inv-owed' },
        h('span', { text: `Unpaid: ${money(sum(unpaid))} (${unpaid.length})` }),
        late.length ? h('span', { class: 'late', text: `Overdue: ${money(sum(late))} (${late.length})` }) : null) : null,
      docs.length ? h('div', { class: 'choices', role: 'group', 'aria-label': 'Show' }, chips.map(([id, label]) => h('button', {
        type: 'button', class: 'choice', 'aria-pressed': String(filter === id), onclick: () => { filter = id; renderList(); } }, label))) : null,
      docs.length ? h('ul', { class: 'inv-list', id: 'inv-list' }) : h('p', { class: 'mhint', text: 'Nothing here yet. Start with "+ New quote" or "+ New invoice".' }));
  }
  function renderList() {
    const ul = $('inv-list');
    if (!ul) { if (docs.length) renderEditor(); return; }
    const shown = docs.filter((r) => filter === 'all' || (filter === 'unpaid' ? r.kind === 'invoice' && r.status === 'sent' : r.kind === filter));
    ul.replaceChildren(...(shown.length ? shown.map((r) => {
      const d = cur && cur.id === r.id ? cur.data : r.data || {};
      const tot = cur && cur.id === r.id && editable() ? totals(cur.data).total : Number(r.total_cents);
      return h('li', {}, h('button', { type: 'button', class: 'inv-row', 'aria-current': cur && cur.id === r.id ? 'true' : null, onclick: () => openDoc(r.id) },
        h('span', { class: 'inv-row-num', text: `${KIND[r.kind].Title} · ${numText(r)}` }),
        h('span', { class: 'inv-row-who', text: (d.to && d.to.name) || 'No customer yet' }),
        h('span', { class: 'inv-row-amt', text: money(tot) }),
        h('span', { class: `inv-badge ${statusClass(r)}`, text: statusText(r) })));
    }) : [h('li', { class: 'mhint', text: 'Nothing in this list.' })]));
    ul.parentElement.querySelectorAll('.choices .choice').forEach((b, i) => b.setAttribute('aria-pressed', String(['all', 'invoice', 'quote', 'unpaid'][i] === filter)));
  }

  function businessGroup() {
    const set = (k) => (e) => { profile[k] = e.target.value; saveProfile(); };
    const pf = (id, label, k, attrs) => labelled(id, label, h('input', { class: 'input', type: 'text', value: profile[k] || '', oninput: set(k), ...attrs }));
    const logoBox = h('div', {});
    if (window.SogilexBrand) SogilexBrand.mountLogo(logoBox, { db, uid, kit, onChange: (k) => { kit = { ...kit, ...k }; renderAll(); } });
    const taxIn = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: profile.taxDefault ? rateText(profile.taxDefault) : '', placeholder: '0',
      oninput: (e) => { const r = parseRate(e.target.value); e.target.classList.toggle('bad', r === null); if (r !== null) { profile.taxDefault = r; saveProfile(); } } });
    const accents = [...ACCENTS, ...(kit.colors && kit.colors[0] ? [['logo', SogilexBrand.readableOnLight(kit.colors[0])]] : [])];
    return h('details', { class: 'mgroup inv-biz', open: profile.name ? null : true },
      h('summary', {}, h('h3', { text: 'Your business details' }), h('span', { class: 'mhint', text: profile.name ? profile.name : 'Fill these in once' })),
      h('p', { class: 'mhint', text: 'Shown at the top of every quote and invoice. A sent one keeps the details it was sent with.' }),
      logoBox,
      pf('b-name', 'Business name', 'name', { maxlength: '120', placeholder: 'Your business name' }),
      labelled('b-address', 'Address', h('textarea', { class: 'input mtext', rows: '2', maxlength: '300', oninput: set('address'), placeholder: 'Street\nCity, State ZIP' }, profile.address || '')),
      h('div', { class: 'inv-two' }, pf('b-phone', 'Phone', 'phone', { maxlength: '40', inputmode: 'tel' }), pf('b-email', 'Email', 'email', { maxlength: '120', inputmode: 'email' })),
      pf('b-web', 'Website (optional)', 'website', { maxlength: '120' }),
      labelled('b-pay', 'How to pay you (printed on invoices)', h('textarea', { class: 'input mtext', rows: '3', maxlength: '600', oninput: set('pay'),
        placeholder: 'e.g. Checks payable to Your Business LLC. Zelle: you@example.com' }, profile.pay || '')),
      h('div', { class: 'inv-two' },
        labelled('b-terms', 'Usual payment terms', h('select', { class: 'mselect', onchange: (e) => { profile.terms = Number(e.target.value); saveProfile(); } },
          TERMS.map(([n, t]) => h('option', { value: String(n), selected: termsDays() === n ? true : null, text: t })))),
        labelled('b-tax', 'Usual tax rate % (optional)', taxIn)),
      h('div', { class: 'choice-label', text: 'Colour' }),
      h('div', { class: 'choices' }, accents.map(([id, hex]) => h('button', { type: 'button', class: 'choice inv-swatch', 'aria-pressed': String((profile.accent || 'harbor') === id),
        'aria-label': id === 'logo' ? 'From my logo' : id, title: id === 'logo' ? 'From my logo' : id, onclick: () => { profile.accent = id; saveProfile(); renderEditor(); } },
      h('i', { style: `background:${hex}` }), id === 'logo' ? ' Logo' : null))));
  }

  function customerGroup() {
    const k = KIND[cur.kind];
    const to = cur.data.to;
    const tf = (id, label, key, attrs) => labelled(id, label, h('input', { class: 'input', type: 'text', value: to[key], ...attrs, oninput: (e) => { to[key] = e.target.value; changed(); renderListSoon(); } }));
    const pick = h('select', { class: 'mselect', 'aria-label': 'Choose a saved customer', onchange: (e) => {
      const c = customers.find((x) => x.id === e.target.value);
      if (c) { cur.customer_id = c.id; cur.data.to = { name: c.name, email: c.email, phone: c.phone, address: c.address }; }
      else { cur.customer_id = null; cur.data.to = { name: '', email: '', phone: '', address: '' }; }
      changed(true);
    } },
    h('option', { value: '', text: customers.length ? 'Choose a saved customer…' : 'No saved customers yet' }),
    customers.map((c) => h('option', { value: c.id, selected: cur.customer_id === c.id ? true : null, text: c.name })));
    return h('div', { class: 'mgroup' },
      h('h3', { text: `Who it's for` }),
      h('div', { class: 'mrow' }, pick,
        cur.customer_id ? h('button', { type: 'button', class: 'iconbtn danger', text: 'Remove from saved', onclick: removeCustomer }) : null),
      tf('to-name', 'Name or business', 'name', { maxlength: '120', placeholder: 'Customer name' }),
      h('div', { class: 'inv-two' }, tf('to-email', 'Email (optional)', 'email', { maxlength: '200', inputmode: 'email' }), tf('to-phone', 'Phone (optional)', 'phone', { maxlength: '60', inputmode: 'tel' })),
      labelled('to-address', 'Address (optional)', h('textarea', { class: 'input mtext', rows: '2', maxlength: '400', oninput: (e) => { to.address = e.target.value; changed(); } }, to.address)),
      h('p', { class: 'mhint', text: `New customers are saved to your list when you mark the ${k.noun} as sent.` }));
  }
  let listSoon = null;
  const renderListSoon = () => { clearTimeout(listSoon); listSoon = setTimeout(renderList, 300); };
  async function removeCustomer() {
    const c = customers.find((x) => x.id === cur.customer_id);
    if (!c || !confirm(`Remove ${c.name} from your saved customers? Quotes and invoices already made keep their details.`)) return;
    const { error } = await db.from('inv_customers').delete().eq('id', c.id);
    if (error) { say("Couldn't remove them. Try again."); return; }
    customers = customers.filter((x) => x.id !== c.id);
    cur.customer_id = null; changed(true);
  }

  function datesGroup() {
    const d = cur.data;
    const isInv = cur.kind === 'invoice';
    const dateIn = h('input', { class: 'input', type: 'date', value: d.date, onchange: (e) => {
      const gap = parts(d.due) && parts(d.date) ? daysBetween(d.date, d.due) : null;
      d.date = e.target.value || today();
      if (gap !== null) d.due = addDays(d.date, gap); // keep the same terms
      changed(true);
    } });
    const dueIn = h('input', { class: 'input', type: 'date', value: d.due, min: d.date, onchange: (e) => { d.due = e.target.value; changed(true); } });
    const gap = parts(d.due) && parts(d.date) ? daysBetween(d.date, d.due) : null;
    return h('div', { class: 'mgroup' },
      h('h3', { text: 'Dates' }),
      h('div', { class: 'inv-two' }, labelled('d-date', 'Date', dateIn), labelled('d-due', KIND[cur.kind].due, dueIn)),
      h('div', { class: 'choices', role: 'group', 'aria-label': isInv ? 'Payment terms' : 'Quote valid for' }, (isInv ? TERMS : VALID).map(([n, t]) => h('button', {
        type: 'button', class: 'choice', 'aria-pressed': String(gap === n), onclick: () => { d.due = addDays(d.date, n); changed(true); } }, t))));
  }

  function linesGroup() {
    const d = cur.data;
    lineRefs.length = 0;
    const box = h('div', { class: 'inv-lines' });
    d.lines.forEach((l, i) => {
      const lineCls = l.o ? 'inv-line is-addon' : 'inv-line';
      // Something that can't be read as a number stays in the box (red, with a message) instead of quietly
      // switching back to the old number, which looked like "my change didn't take".
      const warn = h('p', { class: 'inv-badnum', role: 'alert', hidden: true });
      const check = () => {
        const msgs = [];
        if (qty.classList.contains('bad')) msgs.push(`Couldn't read "${qty.value.trim()}" as a quantity. Use a plain number, like 2 or 1.5.`);
        if (price.classList.contains('bad')) msgs.push(`Couldn't read "${price.value.trim()}" as a price. Use dollars and cents, like 1500 or 1,499.99. The invoice still shows ${money(l.p)}.`);
        warn.textContent = msgs.join(' '); warn.hidden = !msgs.length;
      };
      // Clicking into a number selects it, so typing replaces the old number instead of adding to its end
      // ("699.00" + "$899" = "699.00$899", which can't be read).
      // (The mouse-up that ends the click would put the cursor back, so that one mouse-up is ignored.)
      const pick = (e) => { const el = e.target; el.select(); el.addEventListener('mouseup', (m) => m.preventDefault(), { once: true }); };
      const qty = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: qtyText(l.q), 'aria-label': `Line ${i + 1} quantity`, onfocus: pick,
        oninput: (e) => { const q = parseQty(e.target.value); e.target.classList.toggle('bad', q === null); if (q !== null) { l.q = q; changed(); } if (q !== null) check(); },
        onblur: (e) => { if (!e.target.classList.contains('bad')) e.target.value = qtyText(l.q); check(); } });
      const price = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: l.p ? centsText(l.p) : '', placeholder: '0.00', 'aria-label': `Line ${i + 1} price each`, onfocus: pick,
        oninput: (e) => { const p = parseMoney(e.target.value); e.target.classList.toggle('bad', p === null); if (p !== null) { l.p = p; changed(); } if (p !== null) check(); },
        onblur: (e) => { if (!e.target.classList.contains('bad')) e.target.value = l.p ? centsText(l.p) : ''; check(); } });
      const amt = h('span', { class: 'inv-amt', text: money(lineAmount(l)) });
      lineRefs[i] = amt;
      box.append(h('div', { class: lineCls },
        h('div', { class: 'mrow' },
          h('input', { class: 'input', type: 'text', value: l.d, maxlength: '500', placeholder: i ? 'Another item or service' : 'What it\'s for, e.g. Menu design and setup', 'aria-label': `Line ${i + 1} description`,
            oninput: (e) => { l.d = e.target.value; changed(); } }),
          d.lines.length > 1 ? h('button', { type: 'button', class: 'iconbtn danger', 'aria-label': `Remove line ${i + 1}`, text: '✕', onclick: () => { d.lines.splice(i, 1); changed(true); } }) : null),
        h('div', { class: 'inv-nums' },
          h('label', { class: 'inv-num' }, h('span', { text: 'Qty' }), qty),
          h('label', { class: 'inv-num' }, h('span', { text: 'Price each' }), price),
          d.tax ? h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: l.t !== false, onchange: (e) => { if (e.target.checked) delete l.t; else l.t = false; changed(); } }), 'Taxed') : null,
          cur.kind === 'quote' ? h('label', { class: 'mini', title: 'Listed apart on the quote and not in its total. You pick which ones they chose when you turn it into an invoice.' },
            h('input', { type: 'checkbox', checked: !!l.o, onchange: (e) => { if (e.target.checked) l.o = true; else delete l.o; changed(true); } }), 'Optional add-on') : null,
          amt),
        warn));
    });
    const taxIn = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: d.tax ? rateText(d.tax) : '', placeholder: '0',
      oninput: (e) => { const r = parseRate(e.target.value); e.target.classList.toggle('bad', r === null); if (r !== null) { const had = !!d.tax; d.tax = r; changed(had !== !!r); } } });
    totalsEl = h('p', { class: 'inv-totals', 'aria-live': 'polite' });
    return h('div', { class: 'mgroup' },
      h('h3', { text: 'Lines' }),
      box,
      d.lines.length < 100 ? h('button', { type: 'button', class: 'addbtn', text: '+ Add a line', onclick: () => { d.lines.push({ d: '', q: 100, p: 0 }); changed(true); } }) : null,
      h('p', { class: 'mhint', text: cur.kind === 'quote' ? 'Use a minus price for a discount, e.g. -25.00. Tick "Optional add-on" for extras they can choose: they\'re listed apart and not in the total.' : 'Use a minus price for a discount, e.g. -25.00.' }),
      h('div', { class: 'inv-taxrow' }, labelled('d-tax', 'Sales tax %', taxIn), h('p', { class: 'mhint', text: 'Leave blank for no tax. Untick "Taxed" on lines that aren\'t taxed.' })),
      totalsEl);
  }

  function quoteGroup() {
    const d = cur.data;
    return h('div', { class: 'mgroup' },
      h('h3', { text: 'Quote extras' }),
      labelled('q-intro', 'Opening message (optional)', h('textarea', { class: 'input mtext', rows: '3', maxlength: '1000',
        placeholder: 'e.g. Thanks for the chance to quote. Here\'s what we talked about, ready to start as soon as you say yes.',
        oninput: (e) => { d.intro = e.target.value; changed(); } }, d.intro)),
      labelled('q-terms', 'Your terms (saved for all your quotes)', h('textarea', { class: 'input mtext', rows: '4', maxlength: '3000',
        placeholder: 'e.g. 50% deposit to start, the rest on completion. Prices valid until the date above. Includes one round of changes.',
        oninput: (e) => { profile.quoteTerms = e.target.value; saveProfile(); } }, profile.quoteTerms || '')),
      h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: d.showTerms, onchange: (e) => { d.showTerms = e.target.checked; changed(); } }), 'Print my terms on this quote'),
      h('label', { class: 'mini' }, h('input', { type: 'checkbox', checked: d.sign, onchange: (e) => { d.sign = e.target.checked; changed(); } }), 'Add an "Accepted by" line for their signature'));
  }
  function notesGroup() {
    return h('div', { class: 'mgroup' },
      h('h3', { text: 'Notes (optional)' }),
      h('textarea', { class: 'input mtext', rows: '3', maxlength: '1000', 'aria-label': 'Notes', placeholder: cur.kind === 'quote' ? 'e.g. Price includes one round of changes.' : 'e.g. Thank you for your business!',
        oninput: (e) => { cur.data.notes = e.target.value; changed(); } }, cur.data.notes));
  }

  function draftActions() {
    const k = KIND[cur.kind];
    return h('div', { class: 'mgroup inv-actions' },
      h('h3', { text: 'When it\'s ready' }),
      h('button', { type: 'button', class: 'btn', text: `Mark as sent (gives it number ${nextNumber(cur.kind)})`, onclick: markSent }),
      h('p', { class: 'mhint', text: `Do this when you send or hand the ${k.noun} to your customer. After that it can't be changed, so your records stay honest.` }),
      h('button', { type: 'button', class: 'linkbtn inv-del', text: 'Delete this draft', onclick: deleteDraft }));
  }

  function sentPanel() {
    const k = KIND[cur.kind];
    const r = cur;
    const d = cur.data;
    const madeInvoice = cur.kind === 'quote' ? docs.find((x) => x.kind === 'invoice' && x.source_id === cur.id) : null;
    const from = cur.source_id ? docs.find((x) => x.id === cur.source_id) : null;
    const lines = [];
    if (r.kind === 'invoice' && r.status === 'sent') {
      const paidOn = h('input', { class: 'input', type: 'date', value: today(), max: today(), 'aria-label': 'Date paid' });
      lines.push(h('div', { class: 'mrow' }, h('button', { type: 'button', class: 'btn', text: 'Mark paid', onclick: () => setStatus('paid', paidOn.value || today()) }), h('span', { class: 'mhint', text: 'on' }), paidOn));
      lines.push(h('button', { type: 'button', class: 'linkbtn inv-del', text: 'Cancel this invoice (void)', onclick: voidIt }));
    }
    if (r.status === 'paid') lines.push(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Undo: mark as not paid', onclick: () => setStatus('sent') }));
    if (r.kind === 'quote' && (r.status === 'sent' || r.status === 'accepted')) {
      lines.push(madeInvoice ? h('button', { type: 'button', class: 'btn', text: `Open its invoice (${numText(madeInvoice)})`, onclick: () => openDoc(madeInvoice.id) })
        : h('button', { type: 'button', class: 'btn', text: 'Turn into an invoice', onclick: quoteToInvoice }));
    }
    if (r.kind === 'quote' && r.status === 'sent') lines.push(h('button', { type: 'button', class: 'btn btn-secondary', text: 'Mark declined', onclick: () => setStatus('declined') }));
    if (r.kind === 'quote' && r.status !== 'sent') lines.push(h('button', { type: 'button', class: 'btn btn-secondary', text: `Undo: mark as sent again`, onclick: () => setStatus('sent') }));
    const sentOn = r.sent_at ? niceDate(iso(new Date(r.sent_at))) : '';
    return h('div', { class: 'mgroup inv-actions' },
      h('p', { class: 'inv-summary' },
        h('span', { class: `inv-badge ${statusClass(r)}`, text: statusText(r) }),
        h('span', { text: ` ${d.to.name} · ${money(Number(r.total_cents))}` })),
      h('p', { class: 'mhint', text: [sentOn ? `Sent ${sentOn}.` : '', r.status === 'paid' && r.paid_on ? `Paid ${niceDate(r.paid_on)}.` : '',
        overdue(r) ? `Was due ${niceDate(r.due_date)}.` : '', from ? `Made from ${KIND[from.kind].noun} ${numText(from)}.` : '',
        r.status === 'void' ? 'Cancelled: kept on your list with its number.' : ''].filter(Boolean).join(' ') }),
      ...lines,
      h('div', { class: 'inv-new' },
        h('button', { type: 'button', class: 'btn btn-secondary', text: 'Make a copy', onclick: makeCopy }),
        r.kind === 'invoice' && r.status !== 'void' ? h('button', { type: 'button', class: 'btn btn-secondary', text: 'Bill this again next month', onclick: billAgain }) : null),
      h('p', { class: 'mhint', text: r.status === 'void' || r.kind === 'quote' ? 'A copy is a new draft with the same customer and lines.'
        : 'Need to fix something? Cancel it and make a copy. "Bill this again" makes a new draft dated one month later (handy for monthly plans).' }));
  }

  function renderEditor() {
    const root = $('fields');
    const wrap = h('div', { class: 'mfields' });
    wrap.append(listGroup());
    if (cur) {
      wrap.append(h('div', { class: 'inv-open' },
        h('span', { class: `inv-kind kind-${cur.kind}`, text: KIND[cur.kind].Title }),
        h('h3', { class: 'inv-open-h', text: cur.status === 'draft' ? 'Draft' : numText(cur) }),
        editable() ? h('button', { type: 'button', class: 'linkbtn inv-switch', text: `Switch to ${cur.kind === 'quote' ? 'an invoice' : 'a quote'}`, onclick: switchKind }) : null));
      if (editable()) wrap.append(...[customerGroup(), datesGroup(), linesGroup(), cur.kind === 'quote' ? quoteGroup() : null, notesGroup(), draftActions()].filter(Boolean));
      else wrap.append(sentPanel());
    }
    wrap.append(businessGroup());
    root.replaceChildren(wrap);
    renderList();
    refreshNumbers();
  }

  // ---------- the printed page ----------
  function makePage() {
    if (!cur) {
      return h('article', { class: 'inv-page inv-empty' }, h('p', { text: 'Your quote or invoice shows here.' }));
    }
    const d = cur.data;
    const k = KIND[cur.kind];
    const from = cur.status === 'draft' ? profile : { ...profile, ...(d.from || {}) };
    const accent = accentOf(from);
    const t = editable() ? totals(d) : { sub: Number(cur.subtotal_cents), tax: Number(cur.tax_cents), total: Number(cur.total_cents) };
    const stamp = cur.status === 'draft' ? 'Draft' : cur.status === 'paid' ? 'Paid' : cur.status === 'void' ? 'Cancelled' : null;
    const all = d.lines.filter((l) => l.d.trim() || l.p || editable());
    const isQuote = cur.kind === 'quote';
    const lines = isQuote ? all.filter((l) => !l.o) : all;
    const addons = isQuote ? all.filter((l) => l.o) : [];
    const terms = isQuote && d.showTerms && String(from.quoteTerms || '').trim();
    const anyTaxFree = d.tax && lines.some((l) => l.t === false);
    const blockLines = (arr) => arr.filter((x) => x && String(x).trim()).map((x) => h('span', { text: x }));
    const page = h('article', { class: 'inv-page', style: `--i-accent:${accent}` },
      h('header', { class: 'inv-head' },
        h('div', { class: 'inv-from' },
          kit.logo ? h('img', { class: 'inv-logo', src: kit.logo, alt: `${from.name || 'Business'} logo` }) : null,
          from.name ? h('strong', { class: 'inv-fromname', text: from.name }) : h('strong', { class: 'inv-fromname inv-missing', text: '[Your business name]' }),
          h('span', { class: 'inv-addr', text: from.address || '' }),
          ...blockLines([from.phone, from.email, from.website])),
        h('div', { class: 'inv-title' },
          h('h1', { text: k.Title }),
          h('p', { class: 'inv-no', text: cur.number ? numText(cur) : 'Draft · number given when sent' }),
          stamp ? h('span', { class: `inv-stamp stamp-${cur.status}`, text: stamp }) : null)),
      h('section', { class: 'inv-meta' },
        h('div', { class: 'inv-to' },
          h('span', { class: 'inv-lab', text: cur.kind === 'quote' ? 'Prepared for' : 'Bill to' }),
          d.to.name ? h('strong', { text: d.to.name }) : h('strong', { class: 'inv-missing', text: '[Customer name]' }),
          h('span', { class: 'inv-addr', text: d.to.address }),
          ...blockLines([d.to.phone, d.to.email])),
        h('dl', { class: 'inv-dates' },
          h('dt', { text: 'Date' }), h('dd', { text: niceDate(d.date) }),
          d.due ? h('dt', { text: k.due }) : null, d.due ? h('dd', { text: niceDate(d.due) }) : null,
          cur.status === 'paid' && cur.paid_on ? h('dt', { text: 'Paid' }) : null, cur.status === 'paid' && cur.paid_on ? h('dd', { text: niceDate(cur.paid_on) }) : null)),
      isQuote && d.intro.trim() ? h('p', { class: 'inv-intro', text: d.intro }) : null,
      h('table', { class: 'inv-table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Description' }), h('th', { class: 'n', text: 'Qty' }), h('th', { class: 'n', text: 'Price' }), h('th', { class: 'n', text: 'Amount' }))),
        h('tbody', {}, lines.map((l) => h('tr', {},
          h('td', { text: (l.d || '') + (anyTaxFree && l.t === false ? ' (not taxed)' : '') }),
          h('td', { class: 'n', text: qtyText(l.q) }),
          h('td', { class: 'n', text: money(l.p) }),
          h('td', { class: 'n', text: money(lineAmount(l)) }))))),
      h('div', { class: 'inv-sum' },
        h('dl', {},
          h('dt', { text: 'Subtotal' }), h('dd', { text: money(t.sub) }),
          d.tax ? h('dt', { text: `Tax (${rateText(d.tax)}%)` }) : null, d.tax ? h('dd', { text: money(t.tax) }) : null,
          h('dt', { class: 'inv-total', text: cur.kind === 'quote' ? 'Total' : cur.status === 'paid' ? 'Total paid' : 'Total due' }), h('dd', { class: 'inv-total', text: money(t.total) }))),
      addons.length ? h('section', { class: 'inv-addons' },
        h('span', { class: 'inv-lab', text: 'Optional add-ons · not included in the total' }),
        h('table', { class: 'inv-table' }, h('tbody', {}, addons.map((l) => h('tr', {},
          h('td', { text: (d.sign ? '☐  ' : '') + (l.d || '') }),
          h('td', { class: 'n', text: l.q !== 100 ? `${qtyText(l.q)} × ${money(l.p)}` : '' }),
          h('td', { class: 'n', text: `+${money(lineAmount(l))}` }))))),
        h('p', { class: 'inv-addon-sum', text: `Total with all add-ons: ${money(totals(d, true).total)}` })) : null,
      d.notes.trim() ? h('section', { class: 'inv-notes' }, h('span', { class: 'inv-lab', text: 'Notes' }), h('p', { text: d.notes })) : null,
      cur.kind === 'invoice' && from.pay && from.pay.trim() && cur.status !== 'void' ? h('section', { class: 'inv-notes' }, h('span', { class: 'inv-lab', text: 'How to pay' }), h('p', { text: from.pay })) : null,
      terms ? h('section', { class: 'inv-notes inv-terms' }, h('span', { class: 'inv-lab', text: 'Terms' }), h('p', { text: terms })) : null,
      isQuote && d.sign ? h('section', { class: 'inv-sign' },
        h('span', { class: 'inv-lab', text: addons.length ? 'Accepted by · tick any add-ons above' : 'Accepted by' }),
        h('div', { class: 'inv-sign-row' },
          h('div', {}, h('i'), h('span', { text: 'Name' })),
          h('div', {}, h('i'), h('span', { text: 'Signature' })),
          h('div', { class: 'inv-sign-date' }, h('i'), h('span', { text: 'Date' })))) : null);
    return page;
  }
  function scalePreview() {
    const wrapEl = $('sheet-wrap'); const sheets = $('sheets');
    const avail = wrapEl.clientWidth - 36;
    const scale = Math.min(1, avail / sheets.offsetWidth);
    sheets.style.transform = `scale(${scale})`;
    sheets.style.height = '';
    wrapEl.style.height = `${sheets.offsetHeight * scale + 36}px`;
  }
  function renderPreview() {
    const sheets = $('sheets');
    sheets.replaceChildren(makePage());
    sheets.style.transform = 'none';
    const fit = $('fit');
    if (!cur) fit.textContent = '';
    else {
      const pages = Math.max(1, Math.ceil(($('sheets').firstChild.offsetHeight - 2) / (96 * 11)));
      fit.textContent = cur.status === 'draft' ? `Draft${pages > 1 ? ` · about ${pages} pages` : ''}. It prints marked "Draft" until you mark it as sent.` : `${numText(cur)}${pages > 1 ? ` · about ${pages} pages` : ''}. Ready to print or save as PDF.`;
    }
    $('print').disabled = !cur;
    scalePreview();
  }
  function renderAll() { renderEditor(); renderPreview(); }

  // ---------- start ----------
  // A red number box means what's typed there isn't on the page yet: say so instead of printing the old number.
  function unreadable() {
    const bad = document.querySelector('#fields .input.bad');
    if (!bad) return false;
    say('One of the numbers couldn\'t be read (it\'s outlined in red). Fix it first, so the page shows what you typed.');
    bad.focus(); bad.scrollIntoView({ block: 'center' });
    return true;
  }
  $('print').addEventListener('click', () => {
    if (!cur || unreadable()) return;
    renderPreview();
    $('print-root').replaceChildren(makePage());
    // The PDF's suggested file name: "INV-0003 Poor Richard's".
    const title = document.title;
    document.title = `${cur.number ? numText(cur) : `${KIND[cur.kind].Title} draft`}${cur.data.to.name ? ` ${cur.data.to.name}` : ''}`.replace(/[\\/:*?"<>|]/g, '');
    window.addEventListener('afterprint', () => { document.title = title; }, { once: true });
    window.print();
    setTimeout(() => { document.title = title; }, 1500);
  });
  window.addEventListener('resize', scalePreview);
  window.addEventListener('beforeunload', (e) => { if (pending()) { save(); e.preventDefault(); } });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scalePreview);

  $('signout').addEventListener('click', async () => { try { await within(db.auth.signOut(), 8000); } catch { /* cleared locally */ } location.reload(); });
  $('pwbtn').addEventListener('click', () => { SogilexAuth.mountPasswordForm($('pw-mount'), { client: db }); $('pwdialog').showModal(); });

  async function loadDocs() {
    const { data, error } = await db.from('inv_docs').select(COLS).order('updated_at', { ascending: false }).abortSignal(AbortSignal.timeout(10000));
    if (error) throw error;
    return data || [];
  }
  async function loadCustomers() {
    try {
      const { data, error } = await db.from('inv_customers').select('id, name, email, phone, address').order('name').abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      return data || [];
    } catch { return customers; }
  }

  (async () => {
    const s = await session();
    if (!s) {
      $('signin').hidden = false;
      SogilexAuth.mountSignIn($('signin-mount'), { client: db, redirectTo: location.href.split('#')[0], onSignedIn: () => location.reload() });
      renderPreview();
      return;
    }
    uid = s.user.id;
    $('signout').hidden = false; $('pwbtn').hidden = false;
    if (window.SogilexBrand) kit = await SogilexBrand.load(db, uid);
    try {
      const [p, c, d] = await Promise.all([
        db.from('inv_profile').select('data').eq('user_id', uid).maybeSingle().abortSignal(AbortSignal.timeout(10000)),
        loadCustomers(),
        loadDocs(),
      ]);
      if (p.error) throw p.error;
      profile = (p.data && p.data.data) || {};
      customers = c; docs = d;
      // First visit: start the business details from the saved menu, if there is one.
      if (!p.data) {
        try {
          const { data: m } = await db.from('menus').select('data').eq('user_id', uid).maybeSingle();
          const md = m && m.data;
          if (md) profile = { name: md.name || '', phone: (md.footer && md.footer.phone) || '', website: (md.footer && md.footer.website) || '', address: (md.footer && md.footer.address) || '' };
        } catch { /* no menu */ }
      }
      // From the account page: ?open=<id> opens that one instead of the latest.
      const want = new URLSearchParams(location.search).get('open');
      const first = docs.find((r) => r.id === want) || docs[0];
      if (first) cur = { ...first, data: normalizeData(first.data) };
      say(cur && cur.status === 'draft' ? 'Saved' : '');
    } catch { say("Couldn't load your invoices. Refresh to try again."); }
    $('editor').hidden = false;
    renderAll();
  })();
})();
