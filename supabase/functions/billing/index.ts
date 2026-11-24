// Sogilex billing: Stripe subscriptions for the self-serve plans (Basics, Do it yourself). Supabase Edge Function (Deno).
// Deploy with verify_jwt OFF: it checks the person's sign-in itself, and Stripe's webhook calls carry no sign-in.
// Secret: STRIPE_SECRET_KEY (Supabase -> Edge Functions -> Secrets). Test key now; the live key after the LLC.
//
// Signed-in calls (POST, Authorization: Bearer <the person's token>):
//   { action: "checkout", plan: "basics"|"diy", billing: "month"|"year" } -> { url }  Stripe's payment page
//   { action: "confirm", session_id }                                    -> { plan }  after Stripe sends them back:
//        reads that checkout from Stripe and switches the plan on at once (the webhook does the same, maybe later)
//   { action: "portal" }                                                 -> { url }  Stripe's page to change card,
//        switch between Basics and Do it yourself, see receipts or cancel
// Stripe's webhook (POST with a Stripe-Signature header): the event's id is fetched again from Stripe with the secret
//   key, so only real events count (no webhook signing secret to keep), and the subscription is then read as it is now,
//   so an old or replayed event can't undo a later change. Subscription events set public.subscriptions.
//
// Rules: the plan comes only from the Stripe price's lookup key (basics_month, diy_year, ...), never from the browser.
// Complimentary and Team accounts (rows without a Stripe subscription) are never changed and can't check out.
// A subscription that ends (canceled) leaves the row as 'canceled', so the account falls back to the default plan.
// TEST MODE GUARD: Stripe's test cards (4242...) always "pay", so while the key is a test key only accounts listed in
// app_settings 'billing_testers' (user ids, comma-separated) can check out or get a plan from a test subscription.
// With the live key, test-mode subscriptions are ignored entirely.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://sdltqbctuieyjlujsdhj.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM";
const SITE = "https://build.sogilex.com";
const ALLOWED_ORIGINS = [SITE];
const SELF_SERVE = ["basics", "diy"];
const LOCKED = ["comp", "team"]; // given by hand: never sold over, never changed by Stripe

// deno-lint-ignore no-explicit-any
type Any = any;
function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (body: Record<string, unknown>, status: number, cors: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- Stripe (plain HTTPS; form-encoded, as Stripe's API expects) ----------
function form(obj: Record<string, unknown>, prefix = "", out: URLSearchParams = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<Any> {
  const key = (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
  if (!key) throw Object.assign(new Error("Payments aren't set up yet."), { status: 503 });
  const qs = method === "GET" && params ? "?" + form(params).toString() : "";
  const res = await fetch(`https://api.stripe.com/v1/${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" && params ? form(params).toString() : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Stripe", method, path, res.status, data?.error?.message);
    throw Object.assign(new Error("The payment service didn't respond as expected. Please try again."), { status: 502 });
  }
  return data;
}

// ---------- the database, as the service role (only this function writes subscriptions) ----------
function admin() {
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  try { key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? key; } catch { /* keep */ }
  if (!key) throw Object.assign(new Error("Billing isn't set up correctly."), { status: 503 });
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const STATUS: Record<string, string | null> = {
  active: "active", trialing: "trialing", past_due: "past_due", unpaid: "past_due",
  canceled: "canceled", incomplete_expired: "canceled", paused: "canceled",
  incomplete: null, // the first payment hasn't gone through yet: nothing to switch on
};
const testKey = () => (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim().startsWith("sk_test_");
async function isTester(userId: string): Promise<boolean> {
  const { data } = await admin().from("app_settings").select("value").eq("key", "billing_testers").maybeSingle();
  return String(data?.value ?? "").split(",").map((x) => x.trim()).includes(userId);
}
const iso = (sec: unknown) => (typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null);

// Copies one Stripe subscription onto public.subscriptions. Returns the plan it set, or null when it changed nothing.
async function syncSubscription(sub: Any): Promise<string | null> {
  const userId = String(sub?.metadata?.user_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(userId)) { console.error("subscription without a Sogilex user", sub?.id); return null; }
  const item = sub?.items?.data?.[0];
  const lookup = String(item?.price?.lookup_key ?? "");
  const m = lookup.match(/^(basics|diy)_(month|year)$/);
  if (!m) { console.error("subscription with an unknown price", sub?.id, lookup); return null; }
  const status = STATUS[String(sub.status)];
  if (status === undefined || status === null) return null;
  if (!sub.livemode && (!testKey() || !(await isTester(userId)))) { console.error("ignored a test-mode subscription for a non-tester", sub?.id); return null; }
  const db = admin();
  const { data: row } = await db.from("subscriptions").select("plan_id, status, stripe_subscription_id").eq("user_id", userId).maybeSingle();
  if (row && !row.stripe_subscription_id && LOCKED.includes(row.plan_id)) { console.error("refused to change a", row.plan_id, "account"); return null; }
  // An older subscription ending must not cancel a newer one that is still running.
  if (row && row.stripe_subscription_id && row.stripe_subscription_id !== sub.id && status === "canceled" && row.status !== "canceled") return null;
  const values = {
    user_id: userId, plan_id: m[1], billing: m[2], status,
    // Newer Stripe API versions keep the period on the subscription item.
    current_period_start: iso(item?.current_period_start ?? sub.current_period_start),
    current_period_end: iso(item?.current_period_end ?? sub.current_period_end),
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    stripe_subscription_id: sub.id,
    requested_plan_id: null, requested_billing: null, requested_at: null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from("subscriptions").upsert(values, { onConflict: "user_id" });
  if (error) { console.error("couldn't save the subscription", error.message); throw new Error("Couldn't save the plan."); }
  return m[1];
}

async function webhook(req: Request): Promise<Response> {
  let body: Any;
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const id = String(body?.id ?? "");
  if (!/^evt_[A-Za-z0-9]+$/.test(id)) return json({ error: "bad request" }, 400);
  // Trust nothing in the request body: read the event from Stripe itself.
  let event: Any;
  try { event = await stripe("GET", `events/${id}`); } catch { return json({ error: "unknown event" }, 400); }
  const obj = event?.data?.object;
  try {
    // Always the subscription as it is NOW (an old or replayed event can't bring back a cancelled plan).
    if (event.type.startsWith("customer.subscription.") && obj?.id) await syncSubscription(await stripe("GET", `subscriptions/${obj.id}`));
    else if (event.type === "checkout.session.completed" && obj?.subscription) await syncSubscription(await stripe("GET", `subscriptions/${obj.subscription}`));
    else if ((event.type === "invoice.paid" || event.type === "invoice.payment_failed") && (obj?.subscription || obj?.parent?.subscription_details?.subscription)) {
      const subId = obj.subscription ?? obj.parent.subscription_details.subscription;
      await syncSubscription(await stripe("GET", `subscriptions/${subId}`));
    }
  } catch (e) {
    console.error("webhook", event.type, (e as Error).message);
    return json({ error: "try again" }, 500); // Stripe retries
  }
  return json({ received: true }, 200);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "POST" && req.headers.get("stripe-signature")) return webhook(req);
  const cors = corsHeaders(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, cors);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first." }, 401, cors);
  const supabase = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "Your sign-in has expired. Sign in again." }, 401, cors);
  const user = userData.user;

  let body: Any;
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400, cors); }
  try {
    const db = admin();
    const { data: row } = await db.from("subscriptions").select("plan_id, status, stripe_customer_id, stripe_subscription_id").eq("user_id", user.id).maybeSingle();

    if (body?.action === "checkout") {
      const plan = String(body.plan ?? ""); const billing = body.billing === "year" ? "year" : "month";
      if (testKey() && !(await isTester(user.id))) return json({ error: "Payments aren't open yet. We'll email you when you can choose a plan." }, 403, cors);
      if (!SELF_SERVE.includes(plan)) return json({ error: "That plan can't be bought online. Email hello@sogilex.com and we'll set it up." }, 400, cors);
      if (row && !row.stripe_subscription_id && LOCKED.includes(row.plan_id)) return json({ error: "Your account already has full access. There's nothing to pay." }, 400, cors);
      if (row && row.stripe_subscription_id && ["active", "trialing", "past_due"].includes(row.status)) {
        return json({ error: "You already have a plan. Use Manage billing in Your account to switch plans or update your card." }, 409, cors);
      }
      const prices = await stripe("GET", "prices", { "lookup_keys[]": `${plan}_${billing}`, active: "true" });
      const price = prices?.data?.[0];
      if (!price) return json({ error: "That plan isn't available right now." }, 503, cors);
      const session = await stripe("POST", "checkout/sessions", {
        mode: "subscription",
        line_items: { 0: { price: price.id, quantity: 1 } },
        client_reference_id: user.id,
        ...(row?.stripe_customer_id ? { customer: row.stripe_customer_id } : { customer_email: user.email }),
        metadata: { user_id: user.id, plan_id: plan },
        subscription_data: { metadata: { user_id: user.id, plan_id: plan } },
        success_url: `${SITE}/checkout/?status=success&plan=${plan}&billing=${billing}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE}/checkout/?plan=${plan}&billing=${billing}`,
      });
      return json({ url: session.url }, 200, cors);
    }

    if (body?.action === "confirm") {
      const sid = String(body.session_id ?? "");
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return json({ error: "Bad request." }, 400, cors);
      const session = await stripe("GET", `checkout/sessions/${sid}`);
      if (session.client_reference_id !== user.id) return json({ error: "That payment belongs to another account." }, 403, cors);
      if (session.status !== "complete" || !session.subscription) return json({ plan: null, pending: true }, 200, cors);
      const plan = await syncSubscription(await stripe("GET", `subscriptions/${session.subscription}`));
      return json({ plan, pending: !plan }, 200, cors);
    }

    if (body?.action === "portal") {
      if (!row?.stripe_customer_id) return json({ error: "There's no billing to manage yet." }, 400, cors);
      // Use the Sogilex portal settings (made by the setup script), else Stripe's default.
      const configs = await stripe("GET", "billing_portal/configurations", { active: "true", limit: 20 });
      const mine = (configs?.data ?? []).find((c: Any) => c?.metadata?.sogilex === "1");
      const portal = await stripe("POST", "billing_portal/sessions", {
        customer: row.stripe_customer_id, return_url: `${SITE}/account/#sec-plan`, ...(mine ? { configuration: mine.id } : {}),
      });
      return json({ url: portal.url }, 200, cors);
    }
    return json({ error: "Unknown action." }, 400, cors);
  } catch (e) {
    const err = e as Error & { status?: number };
    return json({ error: err.message || "Something went wrong." }, err.status ?? 500, cors);
  }
});
