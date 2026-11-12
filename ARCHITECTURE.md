# Forge — architecture

Forge is one Cloudflare Pages project that does four jobs: it serves the admin
app, runs the API, stores everything in D1, and serves the websites it
generates. There is no build step and no framework.

```
public/            static admin app (served as-is)
  index.html       every tab and modal in one document (12 tabs)
  app.js           all behaviour, one script, no modules
  styles.css
functions/         Cloudflare Pages Functions (file-based routing)
  _middleware.js   runs first on every request: the password gate
  api/**           JSON API (see table below)
  preview/[[path]].js   serves saved sites at /preview/<id>
lib/               shared server modules imported by functions/
schema.sql         D1 schema (every statement is IF NOT EXISTS)
```

## Request lifecycle

1. `functions/_middleware.js` runs before everything.
2. Public paths pass straight through: `/preview/*`, `/api/pv`, `/api/login`,
   `/api/logout`.
3. Everything else needs a valid `forge_auth` cookie. The gate fails closed:
   with no `FORGE_PASSWORD`, or one shorter than 8 characters, every other
   route answers 503 with a setup page. A dev server on localhost is the only
   place the app runs open.
4. The cookie is `v1.<issuedMs>.<HMAC-SHA256>` keyed by the password
   (`lib/auth.js`). Changing the password invalidates every session, and the
   server refuses a token older than 30 days.
5. `/api/*` also needs the **request token** in an `X-Forge-Token` header.
   Generated sites are served from this same address, so the cookie alone
   would let a script inside one call the API as you. The token is derived
   from the session and written only into the app's own page, and only when
   that page is opened as a page (`Sec-Fetch-Dest: document`) — a `fetch()`
   or a frame never receives it. The app page is sent with `no-store`,
   `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin`.
6. Wrong passwords are counted in D1 (`lib/throttle.js`): five from one
   address, or a hundred from anywhere, inside 15 minutes locks that key for
   15 minutes. A locked address is refused before its password is compared.

Route handlers are wrapped in `handle()` (`lib/http.js`), which turns thrown
`HttpError`s into JSON `{ error }` responses and hides stack traces.

Generated pages never run as part of the app. My Sites thumbnails are frames
with scripts switched off (`sandbox=""`), and the builder preview loads the
page from a `data:` address, which gives it an origin of its own.

## API

| Method | Path | File | What it does |
|---|---|---|---|
| POST | `/api/login` | `api/login.js` | Password → session cookie. |
| GET/POST | `/api/logout` | `api/logout.js` | Clears the cookie. |
| POST | `/api/generate` | `api/generate.js` | The only AI route. Modes: `page`, `brand`, `refine`. |
| POST | `/api/rewire` | `api/rewire.js` | Re-wire a page's form + beacon. No AI. |
| POST | `/api/leads/search` | `api/leads/search.js` | One Google Places Text Search. |
| POST | `/api/leads/decision` | `api/leads/decision.js` | Dismiss / un-dismiss a lead. |
| GET | `/api/leads/usage` | `api/leads/usage.js` | Places searches today / this month. |
| GET | `/api/history` | `api/history.js` | Every business ever returned by a search. |
| GET/POST | `/api/prospects` | `api/prospects/index.js` | Manual sales pipeline. |
| PUT/DELETE | `/api/prospects/:id` | `api/prospects/[id].js` | |
| GET/POST | `/api/clients` | `api/clients/index.js` | Clients; creating one logs the upfront as income. |
| PUT/DELETE | `/api/clients/:id` | `api/clients/[id].js` | |
| POST/DELETE | `/api/clients/:id/payments` | `api/clients/[id]/payments.js` | Mark / unmark a maintenance month. |
| GET | `/api/revenue` | `api/revenue.js` | Totals for a window, with trend. |
| GET/POST | `/api/income` | `api/income/index.js` | Money-tab ledger. |
| DELETE | `/api/income/:id` | `api/income/[id].js` | |
| GET/POST | `/api/previews` | `api/previews/index.js` | Save a generated site → `/preview/<id>`. |
| GET/DELETE | `/api/previews/:id` | `api/previews/[id].js` | Load into the builder, or delete. |
| GET | `/api/traffic` | `api/traffic.js` | Visit counts per site. |
| GET | `/api/pv` | `api/pv.js` | **Public.** Visit beacon. Can only add one to a site Forge registered, once per 10 s; never creates rows. |
| GET | `/preview/<id>[/<page>.html]` | `preview/[[path]].js` | **Public.** A saved site. |

## Database (D1 / SQLite)

| Table | Holds |
|---|---|
| `view_history` | Every business a search returned, with a JSON snapshot. |
| `dismissed_leads` | Place IDs hidden from future searches (`no` or `client`). |
| `prospects` | Manual pipeline: new → contacted → follow_up → won / no. |
| `clients` | Paying clients: upfront, monthly fee, status. |
| `client_payments` | One row per paid month per client. |
| `income` | Money-tab ledger (manual entries + rows logged by client payments). |
| `previews` | Saved sites. `kind='single'` → HTML; `kind='multi'` → JSON of pages. |
| `site_views` | Per-site visit counter. Rows are created by Forge when a site is built or saved, never by the public beacon. |
| `places_usage` | Places searches per day (free-tier counter). |
| `login_attempts` | Wrong-password counters for the login throttle. |

Tables and added columns are created on demand (`CREATE TABLE IF NOT EXISTS`,
`lib/migrate.js`), so a deploy never needs a manual migration.

## Generation pipeline

```
browser: facts + concept + layout  ──POST /api/generate──▶  lib/anthropic.js
   (app.js buildLeadPrompt,                                  system prompt = SHARED_RULES
    CONCEPTS, LAYOUTS)                                       one streamed Claude call
                                                             │
        ◀── html ── lib/wire.js: inject form handler + visit beacon ◀── extractHtml
```

- One AI call per page. Multi-page = one `brand` call + one call per page.
- The model is told to write a `<!-- FORGE-CONCEPT … -->` comment before
  `<html>`; the app reads the chosen font back from it to rotate fonts.
- `stop_reason: max_tokens` is retried once at a larger budget, then fails
  loudly — a cut-off page is never returned.
- `lib/forminject.js` wires every `<form>` to FormSubmit when an owner email is
  supplied; `lib/analytics.js` adds the visit beacon.

## User flows

1. **Find** — Lead Finder → one Places search → businesses with no website.
2. **Build** — "Generate site" on a lead, a batch of leads, or a typed prompt.
3. **Pitch** — "Get preview link" → text the `/preview/<id>` URL.
4. **Close** — Lead "Yes" or Prospect "Won" → client record.
5. **Go live** — manual: download the HTML and upload it to a separate
   Cloudflare Pages project with the client's domain.
6. **Get paid** — Clients tab lists what's owed; marking a month paid logs it
   to Money (tax/save split) and Revenue.

## External services

| Service | Used for | Secret |
|---|---|---|
| Anthropic API | generating and editing pages | `ANTHROPIC_API_KEY` |
| Google Places API (New) | Lead Finder | `GOOGLE_PLACES_API_KEY` |
| FormSubmit | emailing form submissions to the owner | none (owner confirms once) |
| Google Fonts | fonts on generated sites and the app | none |

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | |
| `GOOGLE_PLACES_API_KEY` | for Lead Finder | |
| `FORGE_PASSWORD` | yes | At least 8 characters. Unset = locked (open on localhost only). |
| `ANTHROPIC_MODEL` | no | Overrides the default model. |
| `MOCK_ANTHROPIC`, `MOCK_PLACES` | dev only | Canned responses, no spend. |

## Local development

```
npm install
npm run db:schema:local
cp .dev.vars.example .dev.vars
npm run dev                         # http://localhost:8788
```

There is no test suite.
