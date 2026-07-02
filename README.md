# Forge

Prompt-to-website builder for closing local business clients. One Cloudflare
Pages project hosts everything: the app, the serverless API proxy, the D1
database, and the shareable site previews.

## What's inside

| Section | Where | What it does |
|---|---|---|
| **Single Page Builder** | Build tab | One prompt → one complete HTML page. Exactly **one Claude call per page** (client-side keyword extraction replaced the old research pipeline). Truncation is detected via `stop_reason` and retried once at a higher `max_tokens` before surfacing a clear error — a cut-off page is never returned silently. |
| **Multi-Page Builder** | Multi-page tab | Same prompt → several linked pages. A **shared brand pass** runs once per site, and every page's generation call receives that brand brief, so styling/tone/nav stay consistent across pages. |
| **Lead Finder** | Lead Finder tab | ZIP/address + niche → nearby businesses via **Google Places API (New)** Text Search (one API call per search, `websiteUri` in the search field mask — no per-result Details calls, capped at 20 results). Businesses with no `websiteUri` become lead cards: info → auto-generated prompt → Generate Site → Yes/No. **No** dismisses the Place ID forever; **Yes** opens a short form and creates a client. |
| **View History** | History tab | Every business ever returned by a search, with its current status (Yes / No / undecided). Click an entry to reopen the full card and make or change a decision. Never auto-clears. |
| **Client Dashboard** | Clients tab | One card per client with a **due-this-month** list on top (this visible list *is* the v1 reminder system) and a one-tap "mark this month paid" action. Edit any field; delete a record if a deal falls through (the business becomes searchable again). |
| **Revenue Dashboard** | Revenue tab | Total revenue for a selected window (24h / week / month / 6 months / year / all-time): upfront fees (by close date) + monthly maintenance collected (by when each month was marked paid), with a breakdown and an up/down trend vs the prior equivalent period. |
| **Preview Links** | "Get preview link" on any result | Generated sites are stored in D1 and served view-only at `/preview/<id>` (multi-page: `/preview/<id>/about.html` etc.) on the same domain. No AI branding, no expiration — links live until deleted from the My Sites tab. |
| **Refine** | box under a generated single-page site | Edit an existing page from a plain-language instruction (e.g. "make the red deeper, add a financing section") instead of regenerating from scratch — the model is told to change only what's asked and keep the rest. One Claude call per refine, same `stop_reason` truncation handling. |
| **Mobile preview** | Desktop / Mobile toggle above any result | Constrains the preview to phone width so you can check the mobile view before sending — most local-business traffic is on phones. |
| **My Sites** | My Sites tab | A visual gallery of every saved site (backed by the previews table) with live thumbnails: open a single-page site back into the builder to keep editing, copy its link, or delete it. |
| **Proposal / Invoice** | Invoice tab | A no-AI, instant, client-side generator: fill a short form (optionally pre-filled from a client) and get a clean printable proposal or invoice to Print-to-PDF or download. Remembers your own business name/contact in the browser. |

## Architecture

```
public/            static frontend (no build step)
functions/         Cloudflare Pages Functions — THE one shared serverless proxy
  api/generate.js         Anthropic Messages API (server-side key, stop_reason checks)
  api/leads/search.js     Google Places Text Search (server-side key, history log, dismissed filter)
  api/leads/decision.js   yes/no/undo decisions
  api/history.js          view history
  api/clients/…           client CRUD + monthly payment marking
  api/revenue.js          windowed revenue sums
  api/previews/…          create/list/delete preview links
  preview/[[path]].js     serves stored sites at clean URLs
lib/               shared server code (Anthropic client, Places client, helpers)
schema.sql         D1 schema (view_history, dismissed_leads, clients, client_payments, previews)
```

All outbound API calls (Anthropic **and** Google Places) go through these
Functions with server-side keys — nothing sensitive ever reaches the browser.

**Host note:** this must run on **Cloudflare Pages** (or another host with
Functions + D1). GitHub Pages is static-only — it can't run the proxy or bind
a database, so Sections 3–6 (and the Anthropic proxy itself) won't work there.

## Setup

### 1. Prerequisites

- Node 18+, a Cloudflare account
- An Anthropic API key (platform.claude.com)
- A Google Places API key: **Google Cloud Console → enable "Places API (New)"
  → Credentials → create API key → restrict it to Places API (New).**
  Billing must be enabled on the project even to use the free monthly tier.
  Note: the `websiteUri` field puts Text Search in the Enterprise pricing tier
  (~$20 per 1,000 requests at low volume) — searches are capped at 20 results
  and one API call each to keep cost predictable.

### 2. Create the database

```sh
npm install
npx wrangler d1 create forge-db          # copy the database_id into wrangler.toml
npx wrangler d1 execute forge-db --remote --file=schema.sql
```

### 3. Set secrets

```sh
npx wrangler pages secret put ANTHROPIC_API_KEY
npx wrangler pages secret put GOOGLE_PLACES_API_KEY
```

### 4. Deploy

```sh
npm run deploy
```

## Local development

```sh
cp .dev.vars.example .dev.vars           # add real keys, or enable the mocks
npm run db:schema:local                  # apply schema to the local D1
npm run dev                              # http://localhost:8788
```

`MOCK_PLACES=1` / `MOCK_ANTHROPIC=1` in `.dev.vars` return canned data so the
whole flow can be exercised without keys or spend. **Never set these in
production.**

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | server-side only, via `wrangler pages secret` |
| `GOOGLE_PLACES_API_KEY` | yes | server-side only |
| `ANTHROPIC_MODEL` | no | defaults to `claude-opus-4-8` |
| `MOCK_PLACES`, `MOCK_ANTHROPIC` | no | dev-only canned responses |

## Deliberate scope decisions (v1)

- **No auto-dialing / bulk SMS / bulk email** — outreach stays one-to-one and manual.
- **No Yelp integration** — Yelp Fusion can't expose a business's real website
  (only its Yelp listing URL), excludes zero-review businesses, and has no
  meaningful free tier. Revisit only if extra review data becomes worth it.
- **No push notifications** — the due-this-month list shown on the Clients tab
  is the whole reminder system for this pass. Real push (alerts with the app
  closed) needs a service worker, push subscriptions, and a monthly scheduled
  job — a meaningfully bigger build; flagged as a separate follow-up.
- **No preview expiration / passwords / comments** — previews are view-only
  and live until manually deleted.
- **Previews stored directly in D1** — generated pages are far below D1's
  per-row limits; revisit only if single sites start exceeding a few hundred KB.

## Data notes

- `client_payments` is the source of truth for collected maintenance months
  (a running list per client, not just the latest) so revenue windows further
  back than the current month add up correctly. Each row snapshots the fee at
  the moment it was marked paid, so later fee edits don't rewrite history.
  `clients.last_paid_month` is kept in sync as a convenience.
- A client is "due" for month M when M is after the close month, M isn't in
  their paid months, and their monthly fee is > 0 (the first maintenance cycle
  starts the month after close — the upfront fee covers the build).
- Deleting a client also removes its `'client'` dismissal, so the business can
  reappear in Lead Finder searches. Deleting a "No" happens by reopening the
  business from History and clicking the highlighted No again.
