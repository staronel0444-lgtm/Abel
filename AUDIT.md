# Forge audit — 12 November 2026

Every finding below was checked, not assumed. Evidence is a real request, a
real measurement, or a file and line. Severity: **blocker** (do not pitch
until fixed), **high**, **medium**, **low**. Effort: S = under an hour,
M = 1–3 hours, L = more.

## Read this first

**What the live database says** (read-only counts taken from production D1):

| | |
|---|---|
| Clients | **0** |
| Payments logged | **0** |
| Prospects | 5, all still "new — not contacted", all added 26 Aug |
| Lead searches, all time | 14 (25–26 Aug, none since) |
| Demo sites saved | 6, all built 24–26 Aug |
| Visits recorded | 23 across 5 sites, every site last "visited" in the same 2 seconds on 13 Oct |

That last row is the My Sites tab loading its thumbnails. There is no sign
that an owner has ever opened one of the links. Since August Forge has gained ten weeks of features and recorded no pitches. The app is not what is stopping a sale.

**The six demos that are live right now were all built before the two prompt
rewrites** (none carries the concept note the current prompt writes). They are
what an owner would see today, and they are the same website six times —
see section 3.

**Four things could not be checked from this sandbox**, because its network
blocks them. Each is on the to-do list in REPORT.md:

1. Whether the live site has a password set (`abel-6o9.pages.dev` is
   unreachable from here). Ten-second test: open the site in a private window.
   If you see the app instead of a login box, anyone on the internet can use it.
2. A fresh generation with the current prompt (no API key in the sandbox).
3. FormSubmit actually delivering an email (formsubmit.co is blocked).
4. Whether the stock photo links in generated sites still load
   (images.unsplash.com is blocked).

Two things the brief asked about do not exist: there is **no appointments
feature** (the word does not appear in the code; the contact form is the only
thing that emails an owner) and **no pricing** anywhere in the app.

---

## 1. Security

| # | Sev | Finding | Evidence | Effort |
|---|---|---|---|---|
| S1 | **blocker** | The login gate is off unless `FORGE_PASSWORD` is set. Off is the default. | `functions/_middleware.js:68`. With no password: `GET /api/clients` → 200 with names, phones, emails and amounts; `POST /api/generate` → 200; `DELETE /api/clients/1` → `{"ok":true}`; `POST /api/previews` hosted a fake "Sign in to your bank" page at `/preview/7zzq2f49lkv1`. Every preview link you text out reveals the hostname. | S |
| S2 | high | No limit on password guesses. | 60 wrong passwords in 0.51 s, all answered; the 61st (correct) logged in. `functions/api/login.js`. | S |
| S3 | high | Sessions never expire on the server. | A token stamped 1 Jan 2020 → `GET /api/clients` 200. `lib/auth.js:34` checks the signature and nothing else. | S |
| S4 | high | A generated page runs with your login. | Logged in with one client, saved a page whose script lists and deletes clients, then only opened the My Sites tab: clients before 1, after 0. No click needed. `public/app.js:429` (thumbnails), `swapFrame` (builder). Review text from Google goes into the prompt, so this is reachable without touching your computer. | M |
| S5 | high | Nothing caps AI or Google spending. | 25 of 25 `POST /api/generate` accepted in 0.2 s. Each real call may bill up to 64,000 output tokens. The Places counter is display only. | M |
| S6 | high | The visit counter is a public write to the database. | 40 requests in a loop → 40 views. `/api/pv?s=<script>alert(1)</script>` and a made-up id each created a row. `functions/api/pv.js:42`. The free plan allows 100,000 writes a day; a loop can use them all and stop the app saving anything. | S |
| S7 | medium | Admin pages send no security headers. | Only `x-content-type-options` and `referrer-policy`. No `Content-Security-Policy`, no `X-Frame-Options`. | S |
| — | ok | Google data cannot inject script into the app. | A listing with a script payload in every field: results, detail view, basket, History → 0 executions. `escapeHtml` at `public/app.js:15`. | — |
| — | ok | No secrets in the repository. | All 60 commits on all branches scanned for key patterns: 0 matches. Only `.dev.vars.example` was ever committed. | — |

## 2. Data integrity

| # | Sev | Finding | Evidence | Effort |
|---|---|---|---|---|
| D1 | high | Money rows outlive what created them. | Deleted a client: `/api/income` still lists `2026-11-01, 500, "Rays Collision — upfront"`. Marked a month paid, unmarked it, marked it again: income rows 1 → 1 → 2, so $80 logged for one $40 payment. `clients/[id].js:64`, `payments.js:115`. | M |
| D2 | medium | Revenue windows count the wrong days. | One $100 sale per day: "last 24 hours" returned $500 (two calendar days) against a prior period of one day, trend **+440%**. A sale dated June 2027 was counted in "last 24 hours". `functions/api/revenue.js:82`. | S |
| D3 | medium | Editing an upfront amount does not update Money. | Changed 500 → 300: the client shows 300, Money still shows 500. `clients/[id].js:39`. | S |
| D4 | low | Weak validation. | `closeDate: "2026-99-99"` → 201. Email `not an email`, phone `call me maybe` → 201. | S |
| D5 | low | Every client or revenue request runs five failing `ALTER TABLE`s, and every error from them is swallowed. | `lib/migrate.js:10-18`. | S |
| D6 | low | Lists have no limit (`/api/history` returns every row with its JSON). | `functions/api/history.js`. | S |

No client, payment or income rows exist in production yet, so none of this has
corrupted anything real.

## 3. Generated-site quality

### 3a. What is live today — measured on the six real demos

Screenshots: `docs/audit/before-live-demos-desktop.png`,
`docs/audit/before-live-demos-phone.png`.

| Check | Result |
|---|---|
| Do they look different from each other? | **No.** All six: dark hero, uppercase condensed headline with one phrase in red, red call button beside an outlined button, star-rating pill above the headline, square monogram logo. |
| Heading font | Oswald on 5 of 6 (Oswald + Barlow on three). |
| Colour | The same red on near-black on all five auto sites (`#c8102e`, `#c8102e`, `#c8371f`, `#c1272d`, `#d22b2b`). |
| Section order | hero → services → why us → reviews → contact on every one; four add an FAQ or a stats band. |
| Headline | Two competing body shops have the **identical** headline: "Worcester's Trusted Auto Body & Collision Repair Shop". |
| Reviews | **Invented on all five single pages.** "Michael R." praises both Spellane and Audette's in nearly the same words. None of the quotes came from Google. |
| Other invented facts | "30+ years", "35 years", "25 years", "10,000 cars", "licensed & insured", "certified technicians", "we work with all major insurance companies", opening hours. |
| Contact form | **Does nothing on all six.** No handler is attached. |
| Icons | Emoji (📞 🔧 🚗 💈) on every site. |
| Counters | Start at "0 Years" / "0 Cars" and count up; three of the six still showed zeros a second after loading. |
| Footer year | The multi-page demo says © 2024. |
| Phone | Real, click-to-call, visible without scrolling, sticky call bar on phones. Good. |
| Phone layout | No sideways scrolling at 380px. 8–15 tap targets under 40px per site. |
| Placeholder text | None found. |

An owner reading invented praise from invented customers about his own shop
will not trust the rest. **Sev: blocker for pitching these six. Effort: S once
the fixes below are in — regenerate them.**

### 3b. The current prompt — what it will produce next

Captured the exact prompts Forge sends for three HVAC leads and one each for a
plumber, an electrician and a landscaper.

| # | Sev | Finding | Evidence | Effort |
|---|---|---|---|---|
| Q1 | **blocker** | Forge orders page structures that need photos it never has. | 4 of 6 captured leads were told "Gallery-first" or "Before & after" in the same prompt that says "Photos: none supplied". The layout text ends "Follow this structure over any default". The model must fake project photos or ignore the brief. `public/app.js:1208`, `1244`, and six photo-led concepts. | M |
| Q2 | high | Forge's own briefs order invented claims. | "a stamped 24/7 mark" for every plumber (`app.js:1062`), "lead with the fact that somebody answers" (`1124`), "trust band (rating, years, service area)" (`1241`), "reviews, FAQ" (`1277`), "Reviews-led" handed to leads with no reviews. | S |
| Q3 | high | Forge invents the service area. | "Also serves: Worcester, Westborough, Grafton, Northborough, Boylston. Name these towns on the page." comes from a lookup table, not from the business. A barber gets it too. `app.js:1043`. | S |
| Q4 | high | The paste-in prompt builder still writes the old template. | "professional, modern… a strong hero… a services section, a why-choose-us section (local, trusted, reliable)… a testimonials section". `app.js:629-635`. | S |
| Q5 | high | Demo forms are dead. | Batch generation sends `notifyEmail: ''` (`app.js:1938`), so no handler is injected. Pressing Send reloads the page. | S |
| Q6 | medium | Services are guessed silently when you have not typed any. | The facts block has no services line at all unless "Their details" was filled in. | S |
| Q7 | medium | The multi-page builder skips the design rules. | The brand pass has none of them; the live multi-page demo uses Inter, a banned font. One failed page throws away every finished page (`app.js:790`). | M |
| Q8 | medium | Three restyle options are things the rules ban. | Glassmorphism, Neumorphism and a violet dark theme are offered, and the scanner then flags them. `app.js:2885-2890`. | S |
| Q9 | medium | The checker misses what the live demos contain. | It does not catch emoji icons, "0 Years" counters, "25 Years" (it needs a `+`), "why choose us", or a font named in the Google Fonts link only. `app.js:1716-1757`. Batch results are never checked at all. | S |
| Q10 | medium | The default model is from the previous model family. | `lib/anthropic.js:14` — `claude-opus-4-8`. | S |
| Q11 | low | A custom niche with a bracket in it crashes the lead card. | `new RegExp(niche)` at `app.js:1387`. | S |
| Q12 | low | A long pasted description is rejected. | The helper trims to 5,800 characters, then ~1,400 of design direction is added, and the server refuses anything over 6,000 (`generate.js:47`). | S |
| Q13 | unknown | Stock photos are linked from memory. | Every live demo has 3–8 Unsplash links. Any that no longer exist show as broken images. Not checkable here. | S |

## 4. Reliability

What you see when things go wrong, measured with a fake AI server:

| Failure | What Forge shows | Sev |
|---|---|---|
| AI server never answers | Spinner forever. No timeout, no cancel. | high |
| Out of credits | `Anthropic API error (400): 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low…` | high |
| AI overloaded | `Anthropic API error (529): 529 {"type":"error","error":{"type":"overloaded_error"…` | medium |
| Model retired | `Anthropic API error (404): 404 {"type":"error"…` — no fallback | medium |
| No internet (server side) | `Anthropic API error (undefined): Connection error.` | medium |
| No internet (your side) | `Failed to fetch` | medium |
| Cloudflare error page | `Request failed (502)` | medium |
| Page cut off | Retries once with double the budget, then a clear message. Good. | ok |
| Refusal, or prose instead of HTML | Clear messages. Good. | ok |

Other findings:

| # | Sev | Finding | Evidence | Effort |
|---|---|---|---|---|
| R1 | high | A visitor can be told "sent" when nothing was delivered. | `lib/forminject.js:64` treats any HTTP 200 as success. FormSubmit answers 200 with `"success":"false"` until the owner has clicked its activation email. Nothing in Forge sends that first test or checks it. | S |
| R2 | medium | A batch dies if the phone locks. | Live timestamps show about 2½ minutes per site. Five sites is 12 minutes with the screen on. | S |
| R3 | low | The app half-loads if browser storage is blocked. | Unguarded `localStorage` read at the top level, `app.js:3559`. | S |
| R4 | low | A `$&` in a business name would corrupt the injected form script. | `String.replace` with a replacement string, `forminject.js:77`, `analytics.js:35`. | S |

There are no automated tests and no CI.

## 5. The sale flow, step by step

| Step | State | Detail |
|---|---|---|
| Find a lead | works | 239 businesses found in August. |
| Generate their site | works, output not sellable yet | Section 3. |
| Check it before sending | **missing** | Batch results are never scanned. |
| Send a preview link | works | The link is `abel-6o9.pages.dev/preview/<12 random characters>`. It reads like spam from a stranger; a domain of your own would fix that. |
| Track who got which link | **manual** | Demos are not added to Prospects. All five prospects were typed in by hand. |
| Owner asks for a change | **broken** | Every edit saves a *new* link. The link the owner already has shows the old version for ever. |
| They say yes | works | Lead "Yes" or Prospect "Won" creates the client. |
| Agree a price | **missing** | Every price field starts at $0. Nothing stores your plan. |
| Send a proposal or invoice | half | It prints, but has no way-to-pay line, no deposit, no terms. |
| Site goes live on their domain | **manual, 5 steps, outside Forge** | Download the file, create a new Cloudflare project by hand, upload, attach the domain. Repeat all of it for every later edit. |
| Their form reaches their inbox | **untested** | Finding R1. |
| Get paid monthly | manual by design | You chose not to use Stripe. Clients shows who owes what. Marking a month paid works, apart from D1. |
| Show them it is worth $40 a month | weak | The visit count is inflated by your own My Sites tab — probably all 23 of today's views. |

## 6. Performance

Lighthouse, mobile profile, local server. Stock photos could not load in the
sandbox, so the demo numbers are best case.

| Page | Performance | Accessibility | Best practices | SEO |
|---|---|---|---|---|
| Forge app | 96 | 93 | 100 | 90 |
| Demo: Spellane | 95 | 94 | 96 | 100 |
| Demo: Worcester Auto Center | 99 | 96 | 96 | 100 |
| Demo: Joels Barbershop | 99 | 95 | 96 | 100 |

Speed is not a problem. One demo shifts layout as it loads (CLS 0.118) because
no image has a width and height. Nothing here needs work beyond that.

---

## What gets fixed, in order

1. **Security blockers** — S1, S2, S3, S6, S5, S4, S7.
2. **Things that would embarrass you in front of an owner** — Q5 dead demo
   forms, R1 false "sent", D1 and D2 wrong money, the bad error messages.
3. **Generated-site quality** — Q1 to Q4 first, then Q6 to Q12.
4. **Sale-flow gaps** — update a link in place, demos into Prospects, pricing
   and how-to-pay on proposals, go live on their domain from inside Forge.
5. **Everything else** — a small test suite, the low items.

Not being fixed, on purpose: Lighthouse scores (already fine), the Money split,
the Emails tab, the art-style picker beyond removing the banned styles. None of
them is between you and a first client.
