# Sogilex Build

Describe a website, get a single-file site you can download. Served at https://build.sogilex.com/ (GitHub Pages), with the AI step in a Supabase Edge Function that calls Claude.

- `index.html`, `assets/` - the static site (no build step). Fonts self-hosted (SIL OFL); Supabase client vendored (MIT).
- `supabase/003_build.sql` - daily limits: 3 builds per person (failed builds don't count, up to 5 failures), 50 across everyone (edit the numbers in `claim_build_slot()` and `build_quota()` to change them). Also records each build's finish time, stop reason and tokens; a query for build time and cost is at the bottom.
- `supabase/functions/build-site/index.ts` - the Edge Function. Model: `claude-opus-5-5`, effort `medium`, `max_tokens` 24,000, server-side refusal fallback on. Streams the page back as newline-delimited JSON.

Setup (once): run the SQL; deploy the function as `build-site` with JWT verification off (it verifies the user itself); add the `ANTHROPIC_API_KEY` secret; add `https://build.sogilex.com/**` to Supabase Auth redirect URLs; point the `build` CNAME at GitHub Pages.

Cost: roughly $0.20-0.30 per generated site at Opus 5.5 rates. Set a monthly spend limit in the Anthropic Console.

Generated sites run in a sandboxed iframe with scripts disabled. Descriptions are sent to Anthropic and not stored by Sogilex; only build timestamps and token counts are kept.
