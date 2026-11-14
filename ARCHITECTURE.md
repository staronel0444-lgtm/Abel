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
   A request arriving on a **client's own domain** (any hostname that is not
   localhost or `*.pages.dev` and is listed in `domains`) is answered with
   that client's saved site and nothing else — no app, no API, no previews;
   only the visit beacon passes. Everything below is for the app's own address.
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
| POST | `/api/generate` | `api/generate.js` | The only AI route. Modes: `page`, `brand`, `refine`. Refuses with 429 past the daily cap. |
| POST | `/api/rewire` | `api/rewire.js` | Re-wire a page's form + beacon. No AI. |
| POST | `/api/leads/search` | `api/leads/search.js` | One Google Places Text Search. Refuses with 429 past the monthly cap. |
| POST | `/api/leads/decision` | `api/leads/decision.js` | Dismiss / un-dismiss a lead. |
| GET | `/api/leads/usage` | `api/leads/usage.js` | Places searches today / this month. |
| GET | `/api/history` | `api/history.js` | Every business ever returned by a search. |
| GET/POST | `/api/prospects` | `api/prospects/index.js` | Sales pipeline. A generated demo files itself here with its link (one row per business). |
| PUT/DELETE | `/api/prospects/:id` | `api/prospects/[id].js` | |
| GET/POST | `/api/clients` | `api/clients/index.js` | Clients; creating one logs the upfront as income. |
| PUT/DELETE | `/api/clients/:id` | `api/clients/[id].js` | Edits keep the client's upfront Money row in step; delete removes their payments and Money rows too. |
| POST/DELETE | `/api/clients/:id/payments` | `api/clients/[id]/payments.js` | Mark / unmark a maintenance month. |
| GET | `/api/revenue` | `api/revenue.js` | Totals for a window of whole local days (`today`, `tz`), with trend against the same number of days before. |
| GET/POST | `/api/income` | `api/income/index.js` | Money-tab ledger. |
| DELETE | `/api/income/:id` | `api/income/[id].js` | Hand-typed entries only; a client's row is changed from Clients. |
| GET/POST | `/api/previews` | `api/previews/index.js` | Save a generated site → `/preview/<id>`. |
| GET/PUT/DELETE | `/api/previews/:id` | `api/previews/[id].js` | Load into the builder, replace the content behind the same link, or delete. |
| GET | `/api/traffic` | `api/traffic.js` | Visit counts per site. |
| GET/POST | `/api/domains` | `api/domains/index.js` | Client domains and the saved site each one shows. Refuses a site whose form is still a preview. |
| DELETE | `/api/domains/:host` | `api/domains/[host].js` | Disconnect a domain. |
| GET | `/api/pv` | `api/pv.js` | **Public.** Visit beacon. Can only add one to a site Forge registered, once per 10 s; never creates rows. |
| GET | `/preview/<id>[/<page>.html]` | `preview/[[path]].js` | **Public.** A saved site. |

## Database (D1 / SQLite)

| Table | Holds |
|---|---|
| `view_history` | Every business a search returned, with a JSON snapshot. |
| `dismissed_leads` | Place IDs hidden from future searches (`no` or `client`). |
| `prospects` | Pipeline: new → contacted → follow_up → won / no. `place_id` and `preview_url` tie a row to its demo. |
| `clients` | Paying clients: upfront, monthly fee, status. |
| `client_payments` | One row per paid month per client. |
| `income` | Money-tab ledger. Rows logged by a client payment carry `client_id`, `kind` and `month`, and are updated or removed with it. |
| `previews` | Saved sites. `kind='single'` → HTML; `kind='multi'` → JSON of pages. |
| `site_views` | Per-site visit counter. Rows are created by Forge when a site is built or saved, never by the public beacon. |
| `places_usage` | Places searches per day (free-tier counter). |
| `login_attempts` | Wrong-password counters for the login throttle. |
| `ai_usage` | AI calls per UTC day, for the daily cap. |
| `domains` | Client domain → saved site. |

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
- The default model is `claude-opus-5-5` with adaptive thinking and an
  explicit effort level (`high` for a new page, `medium` for an edit or a
  brand brief). If the account does not have that model the call falls back
  to `claude-opus-4-8`; if the API rejects the optional settings the request
  is re-sent without them. Neither retry is billed.
- `stop_reason: max_tokens` is retried once at a larger budget, then fails
  loudly — a cut-off page is never returned.
- `lib/forminject.js` gives every `<form>` a handler: live (FormSubmit, with a
  confirmed-delivery check and a mailto fallback) when an owner email is
  known, preview mode when it is not. `lib/analytics.js` adds the visit
  beacon and `lib/guard.js` hides any image that fails to load.

## User flows

1. **Find** — Lead Finder → one Places search → businesses with no website.
2. **Build** — "Generate site" on a lead, a batch of leads, or a typed prompt.
   Each lead gets a concept and a layout it can actually fill, and a facts
   block that states what is known and what is not.
3. **Check** — every result is set against its facts (`checkSite` in
   `public/app.js`): invented quotes, a wrong phone number, unbacked claims.
4. **Pitch** — the demo is saved as `/preview/<id>` and filed under Prospects
   with that link. Editing it later updates the same link.
5. **Close** — Lead "Yes" or Prospect "Won" → client record, pre-filled with
   your saved prices. Proposal / Invoice shows the deposit and how to pay.
6. **Go live** — My Sites → Go live: add the domain to this Pages project in
   Cloudflare, record it in Forge, and the domain shows that saved site.
7. **Get paid** — Clients lists what's owed; marking a month paid logs it to
   Money (tax/save split) and Revenue.

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
| `DAILY_GENERATION_LIMIT` | no | AI calls allowed per UTC day. Default 40. |
| `PLACES_MONTHLY_LIMIT` | no | Google searches allowed per month. Default 950 (1,000 are free). |
| `MOCK_ANTHROPIC`, `MOCK_PLACES` | dev only | Canned responses, no spend. |

## Local development

```
npm install
npm run db:schema:local
cp .dev.vars.example .dev.vars
npm run dev                         # http://localhost:8788
```

There is no test suite.
