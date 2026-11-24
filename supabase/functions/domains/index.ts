// Sogilex own web addresses (038): connect www.yourbusiness.com to your published site. Supabase Edge Function (Deno).
// Deploy with verify_jwt OFF (it checks the person's sign-in itself).
// Secret: CF_DOMAINS_TOKEN = a Cloudflare API token limited to the sogilex.net zone with "SSL and Certificates: Edit"
// (Cloudflare for SaaS custom hostnames). The customer points their address (a CNAME) at domains.sogilex.net; Cloudflare
// checks it and issues the certificate; the Worker then serves their site there (domain_site / site_domain).
//
// POST, Authorization: Bearer <the person's token>:
//   { action: "status" }                -> the panel's state; asks Cloudflare again while the address is pending
//   { action: "connect", hostname }     -> adds (or replaces) the address
//   { action: "remove" }                -> disconnects it (the site stays at name.sogilex.net)
// Only this function writes public.custom_domains (service role), after Cloudflare has answered.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://sdltqbctuieyjlujsdhj.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM";
const ZONE = "3ac0f44b851d59ca3b2ce6b5f73e5536"; // sogilex.net (not a secret)
const TARGET = "domains.sogilex.net";
const ALLOWED_ORIGINS = ["https://build.sogilex.com"];
// deno-lint-ignore no-explicit-any
type Any = any;
const cors = (origin: string) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
});
const json = (b: Record<string, unknown>, s: number, h: Record<string, string>) => new Response(JSON.stringify(b), { status: s, headers: { ...h, "Content-Type": "application/json" } });
class Shown extends Error { constructor(m: string, public status = 400) { super(m); } }

function admin() {
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  try { key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? key; } catch { /* keep */ }
  if (!key) throw new Shown("Own web addresses aren't set up correctly yet.", 503);
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function cf(method: string, path: string, body?: unknown): Promise<Any> {
  const token = (Deno.env.get("CF_DOMAINS_TOKEN") ?? "").trim();
  if (!token) throw new Shown("Own web addresses aren't switched on yet.", 503);
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE}/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const d = await res.json().catch(() => ({}));
  return { ok: res.ok && d.success !== false, status: res.status, result: d.result, errors: d.errors ?? [] };
}

// "https://WWW.Rosies.com/menu" -> "www.rosies.com"
export function cleanHost(input: unknown): string | null {
  let h = String(input ?? "").trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "").split(/[\/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (h.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return null;
  if (h === "sogilex.net" || h.endsWith(".sogilex.net") || h === "sogilex.com" || h.endsWith(".sogilex.com")) return null;
  return h;
}

// Cloudflare's view -> what the owner sees.
function explain(r: Any, host: string): { status: string; detail: string } {
  const ssl = r?.ssl?.status ?? "";
  if (r?.status === "active" && ssl === "active") return { status: "active", detail: `Live at https://${host}` };
  if (["blocked", "moved", "deleted"].includes(r?.status)) return { status: "failed", detail: "Cloudflare couldn't use this address. Remove it and try again, or email hello@sogilex.com." };
  const errs = [...(r?.verification_errors ?? []), ...((r?.ssl?.validation_errors ?? []).map((e: Any) => e?.message))].filter(Boolean).join(" ");
  if (/cname/i.test(errs) || r?.status === "pending") return { status: "pending", detail: `Waiting for your record: ${host} doesn't point to ${TARGET} yet. After you add it, this usually takes 5 to 30 minutes.` };
  return { status: "pending", detail: "Your record was found. Securing your address (the padlock): usually a few minutes." };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const h = cors(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, h);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first." }, 401, h);
  const user = (await createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false } }).auth.getUser(token)).data?.user;
  if (!user) return json({ error: "Your sign-in has expired. Sign in again." }, 401, h);
  let body: Any; try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400, h); }
  try {
    const db = admin();
    const { data: row } = await db.from("custom_domains").select("hostname, cf_id, status, detail").eq("user_id", user.id).maybeSingle();
    const save = async (v: Record<string, unknown>) => {
      const { error } = await db.from("custom_domains").upsert({ user_id: user.id, ...v, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) throw new Shown(/duplicate|unique/i.test(error.message) ? "That address is already connected to another Sogilex site." : "Couldn't save the address.", 409);
    };

    if (body?.action === "status") {
      if (row?.cf_id && row.status !== "active") {
        const r = await cf("GET", `custom_hostnames/${row.cf_id}`);
        if (r.ok) { const e = explain(r.result, row.hostname); await save({ hostname: row.hostname, cf_id: row.cf_id, ...e }); return json({ hostname: row.hostname, target: TARGET, ...e }, 200, h); }
      }
      return json({ hostname: row?.hostname ?? null, status: row?.status ?? null, detail: row?.detail ?? null, target: TARGET }, 200, h);
    }

    if (body?.action === "remove") {
      if (row?.cf_id) await cf("DELETE", `custom_hostnames/${row.cf_id}`);
      await db.from("custom_domains").delete().eq("user_id", user.id);
      return json({ hostname: null, status: null, target: TARGET }, 200, h);
    }

    if (body?.action === "connect") {
      const host = cleanHost(body.hostname);
      if (!host) throw new Shown("Type your address like www.yourbusiness.com (no https://, and not a sogilex address).");
      const { data: can } = await db.rpc("can_own_domain", { p_user: user.id });
      if (!can) throw new Shown("Your own web address comes with Do it yourself as a $5/month add-on.", 403);
      const { data: site } = await db.from("sites").select("slug").eq("user_id", user.id).maybeSingle();
      if (!site) throw new Shown("Publish your site first, then connect your own address to it.");
      if (row?.hostname === host && row.cf_id) return json({ hostname: host, status: row.status, detail: row.detail, target: TARGET }, 200, h);
      const { data: taken } = await db.from("custom_domains").select("user_id").eq("hostname", host).maybeSingle();
      if (taken && taken.user_id !== user.id) throw new Shown("That address is already connected to another Sogilex site.", 409);
      if (row?.cf_id) await cf("DELETE", `custom_hostnames/${row.cf_id}`); // switching addresses: drop the old one
      let r = await cf("POST", "custom_hostnames", { hostname: host, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } });
      if (!r.ok && r.errors.some((e: Any) => /duplicate|already exists/i.test(e?.message ?? ""))) {
        // Left over from an earlier try with nobody's row on it: reuse it.
        const f = await cf("GET", `custom_hostnames?hostname=${encodeURIComponent(host)}`);
        const found = f.ok && Array.isArray(f.result) ? f.result.find((x: Any) => x.hostname === host) : null;
        r = found ? { ok: true, status: 200, result: found, errors: [] } : r;
      }
      if (!r.ok) { console.error("cloudflare", r.status, JSON.stringify(r.errors)); throw new Shown("Cloudflare didn't accept that address. Check the spelling, or email hello@sogilex.com.", 502); }
      const e = explain(r.result, host);
      await save({ hostname: host, cf_id: r.result.id, ...e });
      return json({ hostname: host, target: TARGET, ...e }, 200, h);
    }
    return json({ error: "Unknown action." }, 400, h);
  } catch (e) {
    const err = e as Shown;
    if (!(err instanceof Shown)) console.error("domains", (e as Error).message);
    return json({ error: err instanceof Shown ? err.message : "Something went wrong. Please try again." }, err instanceof Shown ? err.status : 500, h);
  }
});
