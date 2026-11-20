// Sogilex checkout (build.sogilex.com/checkout/?plan=diy&billing=month).
// Shows the order for a plan from public.plans and where Stripe plugs in. Payments aren't switched on yet, so
// "Continue to secure payment" saves the choice as a request (request_plan_change); the owner sees it in the
// subscriptions table and nothing about the account changes.
//
// When Stripe is set up (see PROGRESS.md, "Launch plan for self-serve"):
//   1. An Edge Function `create-checkout` takes { plan, billing }, checks the plan, creates a Stripe Checkout Session
//      (the plan's Stripe price ids, plus the setup fee as a one-time line for done-for-you plans), with
//      success_url = https://build.sogilex.com/checkout/?status=success&plan=<id> and cancel_url = this page.
//   2. startPayment() below calls it and sends the browser to the session's url (Stripe's own page takes the card).
//   3. A `stripe-webhook` Edge Function (service role) sets public.subscriptions.plan_id, billing, status and the
//      period dates when Stripe confirms the payment. The account never changes plan from the browser.
(() => {
  const SUPABASE_URL = 'https://sdltqbctuieyjlujsdhj.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM'; // public by design; RLS protects data
  const PAYMENTS_ON = false; // flip once create-checkout and stripe-webhook are deployed
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
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  }
  const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  const day = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const params = new URLSearchParams(location.search);
  let plan = null; let billing = params.get('billing') === 'year' ? 'year' : 'month';
  const shortName = (x) => x.name.replace(' (done for you)', '');
  const doneForYou = (x) => x.id.startsWith('dfy_');

  function render() {
    const recurring = billing === 'year' ? plan.year_cents : plan.month_cents;
    const today = (plan.setup_cents || 0) + (recurring || 0);
    const next = new Date(); if (billing === 'year') next.setFullYear(next.getFullYear() + 1); else next.setMonth(next.getMonth() + 1);
    $('co-billing').replaceChildren(...['month', 'year'].filter((b) => (b === 'year' ? plan.year_cents : plan.month_cents)).map((b) => h('button', {
      type: 'button', class: 'choice', 'aria-pressed': String(billing === b),
      onclick: () => { billing = b; history.replaceState(null, '', `?plan=${plan.id}&billing=${b}`); render(); },
    }, b === 'month' ? `Monthly · ${money(plan.month_cents)}/month` : `Yearly · ${money(plan.year_cents)}/year (2 months free)`)));
    $('co-plan').replaceChildren(...[
      h('p', { class: 'co-plan-name', text: plan.name }),
      h('p', { class: 'muted', text: plan.blurb }),
      plan.can_publish ? h('p', { class: 'co-inc', text: 'Includes publishing your website and online menu.' }) : null,
      doneForYou(plan) ? h('p', { class: 'co-inc', text: 'After you pay, we contact you within one business day to get started.' }) : null].filter(Boolean));
    const lines = [];
    if (plan.setup_cents) lines.push(['Setup (one time)', money(plan.setup_cents)]);
    lines.push([billing === 'year' ? `${shortName(plan)}, first year` : `${shortName(plan)}, first month`, money(recurring)]);
    $('co-lines').replaceChildren(...lines.flatMap(([a, b]) => [h('dt', { text: a }), h('dd', { text: b })]),
      h('dt', { class: 'co-total', text: 'Due today' }), h('dd', { class: 'co-total', text: money(today) }));
    $('co-fine').textContent = `Then ${money(recurring)} every ${billing === 'year' ? 'year' : 'month'}, starting ${day(next)}, until you cancel. Sales tax, if any, is added at payment. No contracts: cancel any time in Your account.`;
  }

  // Sends the browser to Stripe once payments exist; until then, saves the choice.
  async function startPayment() {
    const st = $('co-status');
    if (!$('co-agree').checked) { st.className = 'status err'; st.textContent = 'Tick the box to agree to the Terms first.'; return; }
    const btn = $('co-pay'); btn.disabled = true; st.className = 'status'; st.textContent = PAYMENTS_ON ? 'Opening secure payment…' : 'Saving your choice…';
    try {
      if (PAYMENTS_ON) {
        const { data, error } = await db.functions.invoke('create-checkout', { body: { plan: plan.id, billing } });
        if (error || !data || !data.url) throw error || new Error("Couldn't start the payment.");
        location.href = data.url; return;
      }
      const { error } = await within(db.rpc('request_plan_change', { p_plan: plan.id, p_billing: billing }), 12000);
      if (error) throw error;
      showDone(false);
    } catch (e) {
      btn.disabled = false; st.className = 'status err';
      st.textContent = (e && e.message && !/fetch|network|timeout/i.test(e.message)) ? e.message : "Couldn't save it. Check your connection and try again.";
    }
  }
  function showDone(paid) {
    $('checkout').hidden = true; $('co-h').hidden = true; $('done').hidden = false;
    $('done-h').textContent = paid ? `You're on ${shortName(plan)}.` : 'Your choice is saved.';
    $('done-text').textContent = paid
      ? `Thank you. Your plan is active now${plan.can_publish ? ', including publishing' : ''}. A receipt is on its way to your email.${doneForYou(plan) ? ' We\'ll contact you within one business day to get started.' : ''}`
      : `You asked for ${shortName(plan)}, billed ${billing === 'year' ? 'yearly' : 'monthly'}. Payments aren't open yet, so nothing has been charged and your plan hasn't changed. We'll email you when you can finish.`;
  }

  $('co-pay').addEventListener('click', startPayment);
  $('signout').addEventListener('click', async () => { try { await within(db.auth.signOut(), 8000); } catch { /* cleared */ } location.reload(); });
  $('pwbtn').addEventListener('click', () => { SogilexAuth.mountPasswordForm($('pw-mount'), { client: db }); $('pwdialog').showModal(); });

  (async () => {
    const s = await session();
    if (!s) {
      $('signin').hidden = false;
      SogilexAuth.mountSignIn($('signin-mount'), { client: db, redirectTo: location.href.split('#')[0], onSignedIn: () => location.reload() });
      return;
    }
    $('signout').hidden = false; $('pwbtn').hidden = false;
    $('co-email').textContent = s.user.email || '';
    try {
      const { data, error } = await within(db.from('plans').select('id, name, blurb, month_cents, year_cents, setup_cents, can_publish, public').eq('id', params.get('plan') || '').eq('public', true).maybeSingle(), 10000);
      if (error) throw error;
      plan = data;
    } catch { plan = null; }
    if (!plan || (!plan.month_cents && !plan.year_cents)) {
      $('co-h').textContent = 'That plan isn\'t available';
      $('checkout').hidden = true;
      $('done').hidden = false; $('done-h').textContent = 'Choose a plan from your account.'; $('done-text').textContent = 'The link may be old. Your account shows the plans you can switch to.';
      return;
    }
    if (billing === 'year' && !plan.year_cents) billing = 'month';
    if (params.get('status') === 'success') { showDone(true); return; }
    $('checkout').hidden = false;
    render();
  })();
})();
