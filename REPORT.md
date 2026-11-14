# Forge — what was done, and whether it is ready

14 November 2026. Read with `AUDIT.md`, which has the findings and evidence
this report refers to.

## The answer first

**Is Forge ready to pitch to real businesses tomorrow? Not yet — but it is
three things away, and all three are yours to do, not more building.**

1. **Set the password.** The work was pushed on 14 November with your
   go-ahead, and your default branch deploys straight to production. I cannot
   see your live site from here, so I have not confirmed the deploy finished.
   If `FORGE_PASSWORD` is missing or shorter than 8 characters, Forge now
   shows a "Forge is locked" page until you set it.
2. **No real site has been generated with the new rules.** This sandbox has no
   AI key and cannot reach your live site. Everything that could be tested
   without the model was tested. What the model now produces has not been
   seen by anyone. You have to generate three and look at them.
3. **The six demos you would be pitching with are not fit to send.** They are
   the same page six times, and five of them quote customers who do not exist
   (AUDIT.md section 3a). Delete them and regenerate after deploying.

Once those are done — password set, demos regenerated, each one read — yes,
pitch.

**The blunt part.** Production has 0 clients, 0 payments, and 5 prospects that
have sat at "new — not contacted" since 26 August. The visit counter's 23
views were almost certainly all you. Forge did not stop a sale; no sale was
attempted. The Money split, the Emails tab and the 29-style restyle picker
were all built for a business that does not have its first customer. The next useful thing is five phone calls.

## 1. What was fixed, ranked by impact

| # | Change | Why it matters |
|---|---|---|
| 1 | **The app locks itself when no password is set** (`cd5391f`) | It used to run wide open by default: client list readable, AI credits spendable, by anyone holding a preview link. |
| 2 | **Sites are built only from what is known** (`a4047f0`, `babe1b4`, `358ed30`) | Forge itself was ordering fake project galleries, a "24/7" stamp, a made-up service area and one-star reviews onto pages. The briefs no longer contain claims, unknowns are stated as unknown, and the patterns your six demos share are banned by name. |
| 3 | **Every page is checked against its facts before you send it** (`358aedf`) | Finds invented quotes, a wrong phone number, unbacked claims, emoji icons, stock photos. Run on your live demos it finds six invented quotes on each. |
| 4 | **The contact form tells the truth** (`9cb5f3d`) | Demo forms did nothing. Live forms could say "sent" when nothing was delivered. |
| 5 | **A generated page can no longer act as you** (`ea2dceb`) | Opening My Sites with a hostile page saved was enough to delete a client. |
| 6 | **Login guessing is throttled; sessions end** (`98f7ac5`, `a1fa027`) | 60 guesses took half a second. A cookie from 2020 still worked. |
| 7 | **Spending is capped** (`f81210d`) | 40 AI calls a day, 950 Google searches a month, both adjustable. |
| 8 | **The visit counter cannot be written to by strangers** (`ce5f5c4`) | It was a public way to fill your database, and your own My Sites tab was most of the count. |
| 9 | **Money stays consistent** (`58bdc61`, `d143e40`, `945e571`) | Deleted clients left income behind, re-marking a month double-counted it, and "last 24 hours" counted two days. |
| 10 | **Go live on the client's domain from inside Forge** (`82d181b`) | Was five manual steps in a separate Cloudflare project, repeated for every edit. |
| 11 | **A link updates in place** (`4e01b02`) | Every edit used to mint a new address, leaving the owner looking at the old page. |
| 12 | **Demos file themselves under Prospects** (`f6a91e0`) | With the link, and copy-pitch on the card. |
| 13 | **Prices, deposit and how-to-pay on proposals** (`efe9876`) | Every price field used to start at $0. |
| 14 | **Failures say what happened** (`9d85805`, `be79833`, `9040b5c`) | Raw JSON errors, an endless spinner with no cancel, and a half-loaded app in private windows. |
| 15 | **Newer AI model, with a way back** (`2741583`) | `claude-opus-5-5`, cheaper per token, falling back to the old model if your account does not have it. |
| 16 | **Multi-page keeps finished pages** (`ebb82d9`); six contradictory restyles removed (`b3f8295`); broken images hidden (`eaf6493`) | |
| 17 | **Tests** (`a70c6d4`) | 13 unit tests, 13 end-to-end. There were none. |

## 2. Before and after

All measured on a local server with real requests. "After" was re-run by
`npm run test:api`.

| Check | Before | After |
|---|---|---|
| No password set: `GET /api/clients` | 200, full client list | 503, setup page |
| No password set: `POST /api/generate` | 200 | 503 |
| 60 wrong passwords | 60 answered in 0.51 s | 5 answered, 55 refused; right password refused for 15 min |
| Session token dated 2020 | accepted | refused |
| Cookie but no request token | n/a | 403 |
| Hostile saved page, operator opens My Sites | clients 1 → 0 | clients 1 → 1 (also in its own tab, and in the builder) |
| 25 generate calls at once | 25 accepted | refused past the daily cap (tested at 3: 200, 200, 200, 429, 429) |
| 40 beacon hits on a made-up id | 40 views, row created | 0 rows |
| 40 beacon hits on a real site | 40 views | 1 view |
| Delete a client | income rows stay | income rows removed |
| Mark, unmark, re-mark a month | $80 logged for $40 | $40 |
| Edit upfront 500 → 300 | Money still 500 | Money 300 |
| "Last 24 hours", one $100 sale a day | $500 vs $100, +440% | $100 vs $100, 0% |
| Close date `2026-99-99` | accepted | refused |
| Demo form, press Send | page reloads | "This is a preview, so nothing was sent…" |
| Live form, address not activated | "✅ Thanks! Your message has been sent" | falls back to the visitor's email app |
| AI overloaded | `Anthropic API error (529): 529 {"type":"error"…` | "Anthropic is overloaded right now. Wait a minute and try again." |
| Server never answers | spinner for ever | clock, Stop waiting button, 12-minute limit |
| Photo-led layout given to a business with no photos | 4 of 6 prompts | 0 of 30 |
| One-star review passed to the model | yes | no |
| Service area invented for a barber | yes | no |
| Edit a saved site | new link every time | same link |
| Checker on the live Spellane demo | not run on batch results at all | 6 kinds of problem to fix (one of them: 6 invented quotes), plus a list of unbacked claims |
| Lighthouse, Forge app | 96 / 93 / 100 / 90 | 96 / 93 / 100 / 90 (not worked on) |

Lighthouse for generated sites has no "after": there are no new sites yet.

## 3. What is still broken or risky

**Not verified, because it could not be from here**

- **What the new prompt produces.** The rules are tighter and the
  contradictions are gone, but a page designed without stock photos may come
  out plainer than you want. That is a judgement only looking at real output
  can make. If it is too bare, tick "I have their real photos" for leads where
  you do.
- **The model change against the real API.** Tested against a simulated one.
  If your account rejects the new model or its settings, Forge steps back to
  what it sent before, so the worst case is the old behaviour.
- **Whether production has a password today.**
- **FormSubmit actually delivering.** The handler now refuses to say "sent"
  without confirmation, but delivery itself is a free third-party service
  nobody has tested end to end. The owner's email is visible in the page
  source.
- **A real domain on Cloudflare.** The routing was tested by sending the
  hostname to a local server. A bare domain (no `www`) only works if its DNS
  is on Cloudflare.
- **Stock photo links** in older pages. New pages do not use them.

**Known and accepted**

- Every live client site will depend on this one Cloudflare project and its
  database. If it is down, they are all down. There are no database backups.
- One shared password, no second factor.
- Your prices and "how to pay" are remembered per device, not per account.
- Review quotes come from Google's Places API, whose terms restrict how that
  content is stored and shown. Treat quotes on a demo as a preview, and have
  the owner confirm the ones he wants before going live.
- Multi-page sites got less attention than single pages. Sell single pages.
- Lighthouse accessibility is 93 on the app. Left alone on purpose.

**What deploying changes**

- If production has no `FORGE_PASSWORD` of at least 8 characters, the app
  shows a "Forge is locked" page with the steps. Preview links keep working.
- Any Forge tab already open must be reloaded once.
- Five additive database changes happen by themselves on first use: tables
  `login_attempts`, `ai_usage`, `domains`; columns on `income` and
  `prospects`. Nothing is deleted or rewritten.

## 4. What you need to do

In this order.

- [ ] **10 seconds:** open `abel-6o9.pages.dev` in a private window. You
      should see a login box, or the "Forge is locked" page. If the app itself
      appears, the deploy did not go through — tell me.
- [x] **Deploy.** Pushed 14 November. Check Cloudflare → Workers & Pages → the
      project → Deployments shows it succeeded.
- [ ] **Set `FORGE_PASSWORD`** in Cloudflare → Workers & Pages → the project →
      Settings → Variables and Secrets. Four random words. Then retry the
      deployment so it takes effect.
- [ ] **Check your Anthropic credit balance.** A site is one call; the cap is
      40 a day.
- [ ] **Delete the six old demos** in My Sites. Do not send those links.
- [ ] **For each of your five prospects, fill in "Their details" first** —
      colours off their sign or truck (Google Street View), the owner's first
      name if you know it. This moves a site further from generic than
      anything in the code.
- [ ] **Generate three, and read every word** on your phone. Use the "to fix"
      line. If something invented got through, tell me what.
- [ ] **Set your price** once in Proposal / Invoice: setup, monthly, deposit,
      how to pay.
- [ ] **Test the form for real, once:** build any site with your own email,
      send a message, click FormSubmit's activation email, send another.
- [ ] **With your dad:** decide how a client pays and who signs. You are 14;
      an adult has to be the one taking the money and buying domains.
- [ ] **Rehearse going live once** on a cheap domain before a client's.
- [ ] **Call the five.**

Optional, and worth about $10 a year: a domain of your own for Forge. A link
that reads `yourname.com/preview/…` gets opened; `abel-6o9.pages.dev/preview/…`
from a stranger reads like spam.

## 5. What was not done

- **Phase 3's demo site.** "The best thing Forge can make" has to be made by
  Forge, and that needs the AI key. Writing it by hand and calling it Forge's
  would have been a fake.
- **Three same-niche and three different-niche fresh sites.** Same reason. The
  six real ones in production were audited instead.
- **An appointments feature.** There isn't one; the contact form is the only
  thing that emails an owner.

With an AI key and network access to your site, the remaining checks take
about an hour: the real lineup, the HVAC demo, production's login state,
FormSubmit, and Lighthouse on real output.
