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
- Logos: Build writes `<img src="sogilex:logo">`; at publish time the Worker copies the owner's logo from
  `brand_kits` (must be a real PNG) to KV as `logo:<name>` and points every logo tag at `/logo.png` (one cached
  file instead of a copy inside the page per tag), or removes the tags if there is none. Logos are stored at most
  480×200 (~100 KB); older, bigger ones are shrunk the next time the owner opens Build or Menus.
- Photos (2026-11-19): Build writes `sogilex:photo:<id>` (in `<img>` or CSS). At publish time the Worker looks the
  ids up in `site_photos` with the owner's own sign-in (so only their own photos), downloads each from the private
  `site-photos` bucket, stores it in KV as `photo:<name>:<id>` (list in `photos:<name>`), and points the page at
  `/photos/<id>.jpg`. Deleted or someone else's photos become a blank image. Republish drops copies no longer used;
  unpublish drops all. At most 40 photos per site (Workers allow 50 fetches per request).
- Online menu photos (2026-11-20): the menu text holds photo ids (`hero`, `sections[].photo`). After a save that
  changes them, the Menus page calls `POST api.sogilex.net/menu-photos` with the owner's sign-in; the Worker reads
  their own `online_menus` row, copies up to 20 of their own photos to KV `mphoto:<name>:<id>` (list
  `mphotos:<name>`), deletes ones no longer used, and serves them at `/menu-photos/<id>.jpg`. The menu page only
  shows ids on that list. Not yet: copies are left behind if the menu is taken offline or renamed.
- Served with a Content-Security-Policy that blocks all scripts and outside loads (images only from the site itself
  or data: URLs), plus a sandbox.
- Contact forms: at most 30 messages per site per hour and 5 per visitor per hour (visitor = hashed IP, per day).

## Online menus
`name.sogilex.net/menu` is built by the Worker from `public_menu(name)` (the owner's menu JSON, logo, logo colours),
every piece of text escaped, served with the same CSP and footer; cached 60 s. Owners publish with `publish_menu`
(closed beta; names shared with websites; refuses unchecked photo-read prices) and remove it with `unpublish_menu`.

## Deploying the Worker
Cloudflare API with the "Sogilex publishing" token (saved on the Sogilex cloud environment). Upload
`worker/sites.js` as module `sites.js` with bindings `SITES` (KV), `SUPABASE_URL`, `SUPABASE_KEY` (publishable).

## Not done yet
- Email notifications for new messages (needs a Resend API key).
- Terms of service and opening publishing to everyone (`can_publish` for all).
- Custom domains (Cloudflare for SaaS).
- Deleting old `build_outputs` (keep 30 days).
