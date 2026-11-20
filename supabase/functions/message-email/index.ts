// Sogilex Build: email contact-form messages to the site owner. Supabase Edge Function (Deno), verify_jwt off:
// it checks the caller itself per action. Needs the secret RESEND_API_KEY (sends from mail.sogilex.com).
//
// POST {action:"set", email}     signed-in owner (Authorization: Bearer <access token>). Empty email turns it off.
//                                Their own sign-in address is confirmed at once; any other gets a confirmation email.
// POST {action:"confirm", token} from the page at build.sogilex.com/email/ (the link in the confirmation email).
// POST {action:"stop", token}    from the same page (the link at the bottom of every message email).
// POST {action:"message", id}    from the database trigger right after a message is saved. Only sends a message
//                                that is under 15 minutes old and not emailed yet, so calling it again does nothing.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://sdltqbctuieyjlujsdhj.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUBLISHABLE_KEY = "sb_publishable_SLyXLfw7hZQTL_xEpofo8g_XgKZZStM";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = "Sogilex <messages@mail.sogilex.com>";
const PAGE = "https://build.sogilex.com/email/";
const ALLOWED_ORIGINS = ["https://build.sogilex.com"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function send(to: string, subject: string, text: string, html: string, extra: Record<string, unknown> = {}) {
  if (!RESEND_KEY) throw new Error("Email sending isn't set up yet.");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, html, ...extra }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Email service error ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

const wrap = (inner: string) => `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c1022;max-width:560px">${inner}</div>`;

async function setEmail(req: Request, body: Record<string, unknown>) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const userClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { data: u, error } = await userClient.auth.getUser(jwt);
  if (error || !u?.user) return json(req, { error: "Your sign-in has expired. Sign in again." }, 401);
  const user = u.user;
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) {
    await admin.from("message_emails").delete().eq("user_id", user.id);
    return json(req, { email: null, confirmed: false });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) return json(req, { error: "That doesn't look like an email address." }, 400);

  const own = (user.email ?? "").toLowerCase() === email;
  const { data: cur } = await admin.from("message_emails").select("*").eq("user_id", user.id).maybeSingle();
  if (cur && cur.email === email && cur.confirmed_at) return json(req, { email, confirmed: true });
  const now = new Date();
  let count = cur ? cur.sent_count : 0;
  let windowStart = cur ? new Date(cur.sent_window) : now;
  if (now.getTime() - windowStart.getTime() > 3600_000) { count = 0; windowStart = now; }
  if (!own && count >= 3) return json(req, { error: "Too many confirmation emails in the last hour. Try again later." }, 429);

  const token = crypto.randomUUID();
  const row = {
    user_id: user.id, email, token, confirmed_at: own ? now.toISOString() : null,
    sent_count: own ? count : count + 1, sent_window: windowStart.toISOString(), updated_at: now.toISOString(),
  };
  const { error: upErr } = await admin.from("message_emails").upsert(row);
  if (upErr) return json(req, { error: "Couldn't save that. Try again." }, 500);
  if (own) return json(req, { email, confirmed: true });

  const link = `${PAGE}?confirm=${token}`;
  try {
    await send(email, "Confirm: get website messages at this address",
      `Someone using Sogilex (${user.email ?? "a Sogilex account"}) asked for messages from their website's contact form to be emailed to this address.\n\nTo start getting them, open this link and press the button:\n${link}\n\nIf you weren't expecting this, ignore this email. Nothing will be sent to you.`,
      wrap(`<p>Someone using Sogilex (<b>${esc(user.email ?? "a Sogilex account")}</b>) asked for messages from their website's contact form to be emailed to this address.</p><p><a href="${link}" style="display:inline-block;background:#B0185F;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Confirm this address</a></p><p style="color:#5e4d63;font-size:13px">If you weren't expecting this, ignore this email. Nothing will be sent to you.</p>`));
  } catch (e) {
    console.error("confirmation email failed", (e as Error).message);
    return json(req, { error: (e as Error).message.startsWith("Email sending") ? (e as Error).message : "Couldn't send the confirmation email. Try again in a few minutes." }, 502);
  }
  return json(req, { email, confirmed: false });
}

async function confirm(req: Request, token: string) {
  if (!UUID_RE.test(token)) return json(req, { error: "That link isn't valid." }, 400);
  const { data } = await admin.from("message_emails").select("email, confirmed_at, updated_at").eq("token", token).maybeSingle();
  if (!data) return json(req, { error: "That link has expired or was replaced by a newer one." }, 404);
  if (!data.confirmed_at) {
    if (Date.now() - new Date(data.updated_at).getTime() > 7 * 86400_000) return json(req, { error: "That link has expired. Ask for a new one in Sogilex Build." }, 410);
    await admin.from("message_emails").update({ confirmed_at: new Date().toISOString() }).eq("token", token);
  }
  return json(req, { email: data.email, confirmed: true });
}

async function stop(req: Request, token: string) {
  if (!UUID_RE.test(token)) return json(req, { error: "That link isn't valid." }, 400);
  const { data } = await admin.from("message_emails").delete().eq("token", token).select("email");
  return json(req, { email: data && data[0] ? data[0].email : null, stopped: true });
}

function replyAddress(fields: Record<string, unknown>) {
  const entries = Object.entries(fields).map(([k, v]) => [k, String(v ?? "").trim()] as const);
  const byKey = entries.find(([k, v]) => /e-?mail/i.test(k) && EMAIL_RE.test(v));
  const any = byKey ?? entries.find(([, v]) => EMAIL_RE.test(v) && v.length <= 254);
  return any ? any[1] : null;
}

async function message(req: Request, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return json(req, { error: "bad id" }, 400);
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  // Claim it first, so two calls can never send the same message twice.
  const { data: claimed } = await admin.from("site_messages").update({ emailed_at: new Date().toISOString() })
    .eq("id", id).is("emailed_at", null).gt("created_at", since).select("user_id, slug, fields, created_at");
  const m = claimed && claimed[0];
  if (!m) return json(req, { sent: false });
  const { data: to } = await admin.from("message_emails").select("email, token, confirmed_at").eq("user_id", m.user_id).maybeSingle();
  if (!to || !to.confirmed_at) return json(req, { sent: false });

  const fields = (m.fields && typeof m.fields === "object" ? m.fields : {}) as Record<string, unknown>;
  const rows = Object.entries(fields).filter(([, v]) => String(v ?? "").trim()).slice(0, 30)
    .map(([k, v]) => [k.slice(0, 60), String(v).slice(0, 5000)] as const);
  const site = `${m.slug}.sogilex.net`;
  const reply = replyAddress(fields);
  const nameRow = rows.find(([k]) => /name/i.test(k));
  const who = nameRow ? nameRow[1].replace(/\s+/g, " ").slice(0, 60) : "";
  const stopLink = `${PAGE}?stop=${to.token}`;
  const text = `New message from your website, ${site}:\n\n${rows.map(([k, v]) => `${k}:\n${v}`).join("\n\n")}\n\n` +
    (reply ? `Reply to this email to answer them at ${reply}.\n` : "") +
    `\nAll your messages: https://build.sogilex.com/ (Publish > Messages)\nStop these emails: ${stopLink}\n`;
  const html = wrap(`<p style="color:#5e4d63">New message from your website, <b>${esc(site)}</b></p>` +
    rows.map(([k, v]) => `<p style="margin:0 0 12px"><span style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5e4d63">${esc(k)}</span><br>${esc(v).replace(/\n/g, "<br>")}</p>`).join("") +
    (reply ? `<p><b>Reply to this email</b> to answer them at ${esc(reply)}.</p>` : "") +
    `<p style="color:#5e4d63;font-size:13px;border-top:1px solid #e3d6dd;padding-top:10px">Sent by Sogilex because this address gets messages from ${esc(site)}. All your messages are also in <a href="https://build.sogilex.com/">Sogilex Build</a>. <a href="${stopLink}">Stop these emails</a>.</p>`);
  try {
    await send(to.email, who ? `New message from ${who} (${site})` : `New message from your website (${site})`, text, html, {
      ...(reply ? { reply_to: reply } : {}),
      headers: { "List-Unsubscribe": `<${stopLink}>` },
    });
  } catch (e) {
    console.error("message email failed", id, (e as Error).message);
    await admin.from("site_messages").update({ emailed_at: null }).eq("id", id); // still in Build either way
    return json(req, { sent: false }, 502);
  }
  return json(req, { sent: true });
}

// A "free sample menu" request from the sogilex.com homepage: emailed to Sogilex itself, Reply-To the restaurant.
const SAMPLE_TO = "hello@sogilex.com";
async function sample(req: Request, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return json(req, { error: "bad id" }, 400);
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: claimed } = await admin.from("sample_requests").update({ emailed_at: new Date().toISOString() })
    .eq("id", id).is("emailed_at", null).gt("created_at", since).select("restaurant, name, email, phone, note");
  const r = claimed && claimed[0];
  if (!r) return json(req, { sent: false });
  const rows: [string, string][] = [["Restaurant", r.restaurant], ["Name", r.name], ["Email", r.email], ["Phone", r.phone ?? ""], ["Note", r.note ?? ""]];
  const filled = rows.filter(([, v]) => String(v).trim());
  const text = `New free sample request from sogilex.com:\n\n${filled.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nReply to this email to answer ${r.name}.\n`;
  const html = wrap(`<p style="color:#5e4d63">New free sample request from <b>sogilex.com</b></p>` +
    filled.map(([k, v]) => `<p style="margin:0 0 10px"><span style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5e4d63">${esc(k)}</span><br>${esc(String(v)).replace(/\n/g, "<br>")}</p>`).join("") +
    `<p><b>Reply to this email</b> to answer ${esc(r.name)}.</p>`);
  try {
    await send(SAMPLE_TO, `Free sample request: ${String(r.restaurant).slice(0, 80)}`, text, html, EMAIL_RE.test(r.email) ? { reply_to: r.email } : {});
  } catch (e) {
    console.error("sample email failed", id, (e as Error).message);
    await admin.from("sample_requests").update({ emailed_at: null }).eq("id", id);
    return json(req, { sent: false }, 502);
  }
  return json(req, { sent: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json(req, { error: "Bad request" }, 400); }
  try {
    switch (body.action) {
      case "set": return await setEmail(req, body);
      case "confirm": return await confirm(req, String(body.token ?? ""));
      case "stop": return await stop(req, String(body.token ?? ""));
      case "message": return await message(req, Number(body.id));
      case "sample": return await sample(req, Number(body.id));
      default: return json(req, { error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error("message-email", (e as Error).message);
    return json(req, { error: "Something went wrong. Try again." }, 500);
  }
});
