# Sogilex Menus: spec v0.1

Status: draft, 2026-11-18. Lives in Build as a second tab ("Menu"), same account, same Supabase project.

## Who it's for

Local restaurants, cafés, bakeries and food trucks. Their menus today are made in Word, Canva templates or ChatGPT, and the AI ones show it. Prices and seasonal dishes change several times a year, so a menu gets remade over and over. That repeat use is the business case.

## The one rule everything follows

**Claude designs the look. Code places the content.**

The model never writes out a dish name or a price. The app builds the menu's HTML itself from what the owner typed, and Claude writes only the styling for that fixed structure. So:

- A price can't be changed, rounded or invented by the model.
- Editing a dish or a price later is instant and free: no AI call, just a re-render.
- A design costs far fewer tokens than a website (styling only, roughly 3-6k tokens instead of 10-16k), so it's faster (about 30-60 s) and cheaper (about $0.06-0.12 at Opus 5.5 rates). Estimates; measure in milestone 2.

## What the owner enters

| Field | Notes |
|---|---|
| Restaurant name | Required. |
| A line about the place | Optional, e.g. "Neighbourhood taqueria, family recipes." Feeds the design's tone, never printed unless they tick "show as tagline". |
| Sections | Name (required), optional note ("Served with rice"). Reorder by drag. |
| Items | Name (required), description (optional), one or more prices with an optional label each ("Small 9 / Large 13"), dietary tags from a fixed set (V, VG, GF, spicy, contains nuts). |
| Footer | Address, phone, hours, website. Each optional. **Left out if blank**: placeholders look wrong on a printed menu. |
| Currency | Symbol and whether to show it. |
| Paper | US Letter or A4. One page or two. |
| Style + accent colour | Same picker as Build. |

Prices are stored **exactly as typed, as text** ("12", "12.50", "Market price"), never converted to numbers, so what prints is character-for-character what they entered.

## How a menu is made

1. **Render (code).** The app turns the data into fixed markup:
   `.menu > .menu-header`, `.section > .section-title / .section-note`, `.item > .item-name / .item-desc / .item-prices / .item-tags`, `.menu-footer`. Same structure every time.
2. **Design (Claude, Edge Function `design-menu`).** Input: style, accent, restaurant name, the "line about the place", section names, item count per section, longest item name, whether descriptions exist, paper size. Output (JSON):
   - `css`: styles for the classes above, plus `@page` rules.
   - `fonts`: two choices from our self-hosted list (below).
   - `ornament`: optional inline SVG for the header or section dividers (sanitized).
   The model sees a few dish names for tone, but nothing it returns is printed as content.
3. **Check (code).** Strip anything unsafe from the CSS and SVG (no `url()` to other domains, no `@import`, no scripts). Cap the size.
4. **Fit (code, in the browser).** Render at the paper size and measure. If it overflows, step a `--menu-scale` variable down until it fits, with a floor of 10 pt body text. Still too long: tell the owner to switch to two pages or trim. No second AI call.
5. **Output.** "Download PDF" opens the browser's print dialog with the page already sized (Save as PDF). Also "Download HTML". Server-side PDF is a later step if the print dialog proves confusing for owners.

## Fonts: a big quality lever

Build's websites must use system fonts because they're downloaded and opened anywhere. Menus render on our own page, so we can self-host a curated set of open-license fonts (about 8-10 families: a few serifs, a few sans, one or two display faces) and let Claude pick a pairing. System fonts are a large part of why generated documents look generic.

## Design rules for the menu prompt

On top of Sogilex's four rules (one message, two typefaces, nothing generated to fake it, only your facts):

- Item name is the strongest element; price is clearly tied to its item and easy to scan. Prices aligned consistently.
- Descriptions are quieter: smaller, lighter or italic, never competing with names.
- Section titles create the structure; generous space between sections beats lines and boxes.
- Dot leaders only if the style calls for it (Classic or Elegant).
- No clip-art food, no stock textures, no fake chalkboard.
- Must print well in black and white: hierarchy can't depend on colour alone.

## Saving and editing

New table `menus`: `id`, `user_id`, `name`, `data` (jsonb: everything the owner entered), `design` (jsonb: css, fonts, ornament), `created_at`, `updated_at`. Row-level security: owners see only their own.

- Edit items and prices any time: free and unlimited.
- "New design" keeps the content and asks Claude for a new look: counts toward a daily limit (proposed: 5 per person per day, separate from website builds, same failure rules).
- This means Sogilex stores menu content, unlike website briefs. The Build privacy policy must say so before launch.

## Out of scope for v1

Photos, multiple languages, tri-folds and table tents, QR codes, online ordering, nutrition info, importing an existing menu from a photo.

**Strong v2 candidate:** snap a photo of your current menu and Claude fills in the form. Huge time saver, but then prices *do* pass through the model, so the owner must review every price before saving, with each one highlighted for confirmation.

## Milestones

**1c (done 2026-11-19): read a menu from photos + QR code.** "Already have a menu? Read it from a photo": up to
4 photos (redrawn ≤2000 px JPEG) or a PDF go to the `read-menu` Edge Function (Opus 5.5, structured JSON, effort
medium, not stored); it copies sections, dishes, descriptions, prices exactly as printed (leading currency symbol
moved to the currency setting), sizes, add-ons, specials/set kinds, dietary tags only where printed, and contact
details (fills blanks only). Unreadable bits become "[?]" and are listed. Every price read is highlighted until the
owner clicks it (or confirms "I've checked every price"); printing warns while any are unchecked. Limits: 10 imports
a day (failed ones don't count), 200/day overall (`010_menu_import.sql`). Live test on a tilted photo of a 24-price
bar menu: all prices exact, tags right, 23 s, ~7 cents; an ambiguous section was flagged, not guessed.
QR code: optional web address + line ("Scan to order online"), printed dark-on-white on the last page (0.9 in),
generated in the browser (`assets/vendor/qrcode.js`, MIT); https:// added if missing; non-addresses print nothing.

**1b (done 2026-11-19): structure for different kinds of restaurant.** One page or front and back (the menu
flows onto page 2; a section that breaks is headed "Name, continued"); add-ons per dish or per section with a lead
word ("Add bacon +2", "Choice of fries or salad"); section kinds: regular, specials box, set price (prix fixe /
tasting: one price on the heading, dishes unpriced, wine pairing as a section add-on); starters for Bar & grill,
Fine dining, Café & bakery, Pizzeria, Taqueria & food truck that set section headings and a look, never dishes or
prices. Saved menus from before load unchanged (missing fields are filled in).


1. **No-AI menu.** Form, saved data, fixed markup, one hand-written house style, fit check, print. Already useful, costs nothing to run, and tests the hardest part (fitting and printing) first.
2. **Claude designs.** `design-menu` function, style picker, font list, sanitizer, limits, `finished_at` and `stop_reason` tracking like Build.
3. **Polish and launch.** Menu tab in the new Sogilex look, "Menus" card on sogilex.com goes live, privacy policy updated.

## How we'll know it works

- An owner enters a 25-item menu in under 10 minutes.
- A design arrives in under 60 s, for under $0.15.
- Up to about 30 items fit one Letter page at 10 pt or larger.
- **Zero price mismatches**, checked automatically: the rendered page contains every price string exactly as stored.

## Open questions

1. Free, or paid? (A natural line: designs free, saving more than one menu or removing a small "Made with Sogilex" footer is paid.)
2. Is Letter/A4 enough, or do some owners need tabloid or half-letter?
3. Should the menu also exist as a web page with a link and QR code? Restaurants increasingly need both.
4. Style list for menus: reuse Build's six, or menu-specific ones (Bistro, Diner, Café, Modern, Elegant, Futuristic)?
