# Pipeline

A deployable app that runs your **5-agent website-building pipeline** from a
single form — so you don't have to come back to Claude Code to build a site.
Separate project from Forge; nothing here touches Forge.

Fill in a business once and press **Build the website**. The agents run in
order and the finished, polished site previews right in the page:

```
Business info ─▶ ① Prompt Engineer ─▶ ② Website Generator ─▶ ③ Design Enhancer ─▶ ④ QA Auditor ─▶ preview + download
                (reads reviews,        (single-page + multi-    (hover/scroll         (checks the site
                 visits competitors,    page HTML from the        animations, perf,     against the brief,
                 writes the brief)      brief)                    accessibility)        lists any issues)
```

Then the **Live Call Assist** tab (⑤ Live Call Assistant) sits beside you on a
sales call: type or speak what the client says and it silently suggests a short
reply, using the site you just built as context.

## Same agents as `.claude/agents/`

The five agent prompts live in `lib/agents.js`, copied **verbatim** from the
`.claude/agents/*.md` subagent definitions at the repo root. The subagents are
for building/testing agents inside Claude Code; this app is the hosted version
that runs them via the Anthropic API so it works as a standalone website. If you
edit a prompt in one place, mirror it in the other (there's a note at the top of
`lib/agents.js`).

## Architecture

```
public/            static frontend, no build step
  index.html         Build tab + Live Call Assist tab
  app.js             orchestrates the pipeline (one fetch per stage) + UI
  styles.css
functions/api/      Cloudflare Pages Functions — the server-side agent proxy
  prompt-engineer.js      Agent 2  (fetches competitor pages server-side)
  website-generator.js    Agent 3  (single + multi versions, separate calls)
  design-enhancer.js      Agent 4
  qa-auditor.js           Agent 5  (returns a structured issue list)
  live-call-assistant.js  Agent 6
lib/                shared server code (Claude caller, competitor analyzer, agent prompts)
```

The browser drives the sequence — one HTTP request per stage — so no single
request runs long enough to time out, and you watch each step complete live.
The Anthropic API key is held server-side only (never sent to the browser).

## Setup & deploy

```sh
npm install
npx wrangler pages secret put ANTHROPIC_API_KEY   # your Anthropic key
npm run deploy                                     # deploy to Cloudflare Pages
```

## Local development

```sh
cp .dev.vars.example .dev.vars   # add your ANTHROPIC_API_KEY
npm run dev                      # http://localhost:8788
npm test                         # offline smoke test (no key, no network)
```

## Notes / v1 scope

- **No database.** Each build lives in the browser session (kept in
  `localStorage` so a refresh doesn't lose it). Sites are downloaded or opened
  in a new tab. Shareable saved preview links (like Forge's) would be the
  natural next add-on — it needs a D1 binding.
- **Design Enhancer** runs on the single-page version (the primary preview /
  hand-off). The multi-page files are generated and downloadable; enhancing all
  of them too is a small extension of the same loop.
- **QA feedback loop:** if the auditor flags issues, a **Regenerate with fixes**
  button feeds them back through the generator + enhancer and re-runs QA once.
- **Live Call Assist voice** uses the browser's built-in speech recognition
  (Chrome/Edge). Where that's unavailable, type what the client says instead.
- **Env vars:** `ANTHROPIC_API_KEY` (required), `ANTHROPIC_MODEL` (optional,
  defaults to `claude-opus-4-8`).
```
