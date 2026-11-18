# Sogilex publishing (beta)

Published sites live at `name.sogilex.net` (never on sogilex.com: customer pages must not share an origin
with Sogilex sign-in).

## Pieces
- **Supabase** (`supabase/004_publishing.sql`): `build_outputs` (each finished build's HTML, saved by
  `build-site`), `sites` (one per person in beta), `site_messages` (contact-form messages), and the functions
  `publish_site`, `unpublish_site`, `my_site`, `submit_site_message`. `build_limits.can_publish` is the beta switch.
- **Cloudflare Worker** `sogilex-sites` (`worker/sites.js`) on routes `*.sogilex.net/*` and `sogilex.net/*`,
  KV namespace `sogilex-sites` (key `site:<name>`). DNS: `AAAA sogilex.net` and `AAAA *.sogilex.net` to `100::`,
  proxied. No secrets: the Worker uses the public Supabase key and forwards the person's own sign-in token.
- **Build page**: the Publish panel calls `https://api.sogilex.net/publish` and `/unpublish`.

## Safety
- Only HTML that Build generated can be published (looked up by build id and owner), never an upload.
- At publish time the Worker strips scripts, frames, objects, `<base>`, meta refresh, external stylesheets,
  event handlers, `javascript:` links, password fields and comments; points every form at `/__form`; adds a
  honeypot field and the "Made with Sogilex · Report this site" footer.
- Logos: Build writes `<img src="sogilex:logo">`; at publish time the Worker swaps in the owner's logo from
  `brand_kits` (a PNG data URL), or removes the tag if there is none.
- Served with a Content-Security-Policy that blocks all scripts and outside loads, plus a sandbox.
- Contact forms: at most 30 messages per site per hour and 5 per visitor per hour (visitor = hashed IP, per day).

## Deploying the Worker
Cloudflare API with the "Sogilex publishing" token (saved on the Sogilex cloud environment). Upload
`worker/sites.js` as module `sites.js` with bindings `SITES` (KV), `SUPABASE_URL`, `SUPABASE_KEY` (publishable).

## Not done yet
- Email notifications for new messages (needs a Resend API key).
- Terms of service and opening publishing to everyone (`can_publish` for all).
- Custom domains (Cloudflare for SaaS).
- Deleting old `build_outputs` (keep 30 days).
