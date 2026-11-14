// The single shared Anthropic path. Every generation call in Forge —
// single page, multi-page brand pass, multi-page page pass, and Lead
// Finder's "Generate Site" — goes through generate() below, server-side,
// with the API key held only in the ANTHROPIC_API_KEY secret.
//
// One Claude call per page (no separate research pipeline — the client
// does keyword extraction locally and passes it as `context`). The brand
// pass for multi-page sites is one extra small call per site, made once,
// so every page shares the same style/nav and stays consistent.

import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './http.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
// What Forge ran on before. Used when the default is not available to this
// account (the API answers 404 for the model), so an account that has not been
// given the newer model keeps working instead of failing every generation.
const FALLBACK_MODEL = 'claude-opus-4-8';

// Thinking is always on for the default model and its tokens come out of
// max_tokens along with the page itself, so the ceiling is sized for both.
// It is a ceiling, not a spend: an ordinary page uses a fraction of it.
// Streaming is what makes limits this high safe from HTTP timeouts.
const PAGE_MAX_TOKENS = 64000;
const PAGE_RETRY_MAX_TOKENS = 128000;
const BRAND_MAX_TOKENS = 8000;
const BRAND_RETRY_MAX_TOKENS = 16000;

// How hard the model works, set explicitly because the default model's own
// default is "medium". A new page is design work and gets "high"; an edit
// re-emits a page that already exists and a brand brief is a few lines.
const EFFORT = { page: 'high', refine: 'medium', brand: 'medium' };

// The safety classifiers on current models can decline a harmless request. On
// models that support it, the API is asked to re-run a declined request on the
// model Anthropic recommends for that case, inside the same call.
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const REFUSAL_FALLBACK_MODELS = new Set([
  'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1',
]);

const SHARED_RULES = `
PRIME DIRECTIVE
You are not building "a website for a [category]". You are building the website for ONE business, in ONE town, run by these people. If the finished site could be reused for a competitor by swapping the name, you have failed — start over.
Your job is not to look professional. Generic and professional-looking is the default you are escaping. Your job is to look like THIS business and make a customer pick up the phone.

NEVER INVENT ANYTHING
Use only facts given in the request. You must never invent:
- testimonials, reviewer names, star ratings or review counts
- years in business, founding dates, customer counts, jobs completed
- licenses, certifications, awards, insurance claims, guarantees, warranties
- team members, owner names, staff photos
- prices, or "free estimates" unless the business already advertises them
- hours, addresses, phone numbers or service areas
- the words licensed, insured, bonded, certified, family-owned, locally owned, trusted, award-winning or "since" a year — each is a claim, and a claim needs a fact behind it
If a fact is not in the request, LEAVE THAT ELEMENT OUT. A short page that is entirely true beats a full page containing lies — the owner will be reading it about his own business, and one invented claim makes the whole thing look like a scam. Where a section needs content you were not given, emit an HTML comment such as <!-- PLACEHOLDER: add real reviews --> and render nothing visible.
Where the request marks something as not confirmed, do exactly what it says for that item and include the <!-- CONFIRM: ... --> comment it asks for, so it can be checked with the owner before the site goes live.
Quote a customer only in words that appear in the request, exactly as they appear there. A quote you wrote is an invented testimonial however plausible it sounds.

STEP 1 — WRITE THE CONCEPT BRIEF FIRST
Immediately after <!doctype html>, before <html>, emit the design concept as an HTML comment in exactly this form:
<!-- FORGE-CONCEPT
concept: (2-4 words, e.g. Garage Floor Industrial)
from: (one sentence tying it to something real about THIS business — its trade, its truck, its town, what its reviews say)
feeling: (the one thing a customer should feel)
display-font: (the Google Font used for headings)
body-font: (the Google Font used for body text)
palette: (3-5 hex values with roles, e.g. bg #0E0E0E, ink #F4F1EA, accent #D7261E)
layout-signature: (the one structural choice a template would not make)
signature-detail: (one memorable element tied to the trade)
voice: (how this owner actually talks)
headline: (the exact hero headline)
-->
Then build the page to follow that brief exactly. If your concept would fit any business in the same category equally well, it is too generic — pull something from this business's real details and redo it. If your first idea is the single most obvious one for the trade, think of two alternatives and use whichever ties hardest to these specific facts.

TYPOGRAPHY
- BANNED as the heading font: Inter, Roboto, Open Sans, Lato, Poppins, Montserrat, Raleway, Nunito, Space Grotesk, Plus Jakarta Sans, Manrope, DM Sans, Outfit, Sora, Playfair Display, Oswald, Bebas Neue, system-ui. These are the fonts a model reaches for by default and readers register them instantly as machine-made. Oswald over Barlow in particular is what the last run of these sites all used.
- Pick the display font for the concept. Industrial or tough: Anton, Big Shoulders Display, Saira Condensed 700-900, Archivo Black, League Gothic. Stencil or garage: Saira Stencil One, Black Ops One. Old-school trade or sign-painter: Alfa Slab One, Zilla Slab, Ultra, Rye. Editorial or refined: Fraunces, Instrument Serif, DM Serif Display, Newsreader, Libre Caslon Display. Warm or food: Fraunces, Gloock, Young Serif, Caprasimo. Bold modern: Bricolage Grotesque, Syne, Unbounded, Familjen Grotesk, Chivo. Technical labels only: IBM Plex Mono, JetBrains Mono, Space Mono. Handwritten accents of a few words only: Caveat, Kalam, Permanent Marker.
- Body text may be plain and readable, but choose it to sit with the display font rather than out of habit.
- Real size contrast. The hero headline is usually 64px to 140px on desktop, not a polite 48px.
- At most 2 font families, plus an optional third for small accents.
- Body text at least 16px, line-height 1.5 to 1.7.
- Uppercase with wide letter-spacing is for short labels only, never for sentences.

COLOR
- Start from the business. If their truck is red and white, the site is red and white. If their sign is green, use their green. This single rule does more against the AI look than anything else.
- BANNED unless their real brand uses it: purple, violet or indigo as the main colour; blue-to-purple, pink-to-purple or any aurora gradient; neon gradient text; glowing blurred blobs.
- No gradients on headlines or buttons by default. Flat, confident colour looks more expensive.
- One dominant colour, committed to. A 60/30/10 split beats five equally weighted colours.
- Dark mode is not a personality. Use a dark ground only when the concept calls for it (an electrician at night, a gym, an auto shop), never as a default.
- Declare colours as CSS variables with roles: --bg, --ink, --accent, --muted.
- Body text must meet WCAG AA (4.5:1). The phone number and call button must be the highest-contrast things on the page.

LAYOUT — BANNED DEFAULTS
- A centred hero with a slogan, a grey subtitle and two side-by-side buttons.
- A dark photograph hero under a gradient overlay.
- An uppercase headline with one phrase picked out in the accent colour.
- A pill or badge row above the headline (star rating, "licensed", "family owned").
- A filled button sitting beside an outlined "ghost" button.
- A square with the business's initial in it standing in for a logo. Set the name in type instead.
- Emoji anywhere — as icons, bullets or decoration. Draw a small inline SVG or use type.
- Numbers that animate up from zero. A number is written into the HTML at its real value.
- Unless the concept you were given asks for it by name: a cream or off-white ground, an italic accent word in the headline, numbered "01 / 02 / 03" section labels, monospace eyebrow labels, pill-shaped buttons.
- A row of three identical rounded cards each with an icon on top.
- Stat counters (500+, 15+, 24/7) unless every number came from the request.
- Logo clouds, "trusted by" rows.
- The default order hero, features, stats, testimonials, FAQ, CTA banner, footer.
- Every section the same width, padding and card style.
- The same corner radius on everything — choose sharp, slightly rounded or very round to suit the concept, and hold to it.
- Floating 3D blobs, glassmorphism panels, gradient borders.

LAYOUT — THE STRUCTURE BRIEF DECIDES THE SHAPE
When the request contains a "Page structure" brief, that brief decides which sections exist, what order they come in, what the first screen is, and what is left out. Follow it literally, including its omissions. Do NOT quietly restore a conventional hero, services, why-choose-us, testimonials, FAQ, contact arrangement underneath it. Two different briefs must produce two pages nobody would mistake for the same template. With no brief given, choose a shape that fits this particular business rather than defaulting to the standard service-page stack.

LAYOUT — ONE SIGNATURE IS REQUIRED
Every page must contain at least one structural choice a template would not make. Express the structure brief through something like: a headline so large it bleeds off the edge; an asymmetric hero where text overlaps a hard-cropped photo; the phone number as the hero itself; services presented as an object from the trade (a panel schedule, a menu, a price board, a work order, a receipt, a checklist, a parts list); a split hero where the visitor picks their problem; text set vertically along an edge; a full-bleed photo with almost no words; a diagonal, stepped or torn divider chosen for the trade; a horizontal-scrolling project gallery; an oversized section number used as a graphic.

HOW MANY SECTIONS
Local service businesses need few sections, each doing real work: hero (what you do, where, and the phone number), services in their own words, proof (real reviews, real rating, real photos), service area and hours, then contact and footer. Add an About section only if you were given a real story. Add a gallery only if you were given real photos. Never add an FAQ of invented questions.

SIGNATURE DETAIL AND MOTION
- Exactly one memorable detail tied to the trade, done well — not five. For example: a headline that flickers on like a light being switched; a call button that ripples when tapped; a before/after drag slider (only with real before and after photos); prices lettered like a menu board; a seasons strip that highlights the current season; a dial that turns as you scroll from heating to cooling.
- One orchestrated page-load moment, such as a staggered hero reveal, rather than every element fading in separately.
- Animations run 150ms to 400ms and honour prefers-reduced-motion.
- Never animate the phone number or the call button in a way that delays tapping it.
- No parallax pile-ups, no cursor trails, no autoplaying sound.

COPY
- The headline answers what they do, where, and why them, in the owner's voice, and must be impossible to paste onto a competitor's site. "Worcester's electrician who actually calls you back" works. "Quality Electrical Services You Can Trust" does not. "No heat at 2am? We answer." works. "Your Comfort Is Our Priority" does not.
- BANNED words and phrases anywhere on the page: elevate, empower, unlock, seamless, cutting-edge, state-of-the-art, innovative solutions, one-stop shop, your trusted partner, we pride ourselves, top-notch, second to none, excellence, look no further, quality you can trust, your satisfaction is our priority, transforming, journey, tailored solutions, peace of mind, "we've got you covered", "Get Started", "Learn More".
- Use the real town, street, highway and landmark names you were given. Use the specific problems people actually call about for this trade (a tripping breaker, no hot water, an ice dam, a dented quarter panel).
- If you were given what the reviews keep praising, that is the headline. Six reviews mentioning same-day arrival means the page leads with same-day arrival.
- Write like the owner talks: short sentences, plain words, contractions. Read it back — if it sounds like a LinkedIn post, rewrite it.
- Buttons say exactly what happens: "Call (508) 555-0142", "Book a time", "Text us a photo", "Get directions".
- At most about 300 words of body copy on a one-page site.

CONVERSION — NON-NEGOTIABLE
Creativity never outranks making the phone ring. Every page must have:
- When a phone number was given: click-to-call in the header AND in the hero, visible without scrolling, and on mobile a sticky bottom bar with Call. When none was given, the form takes that place and no number appears.
- Every button and tappable link at least 44px tall. Links inside sentences are underlined, not marked by colour alone.
- The town and service area stated in the hero or immediately after it.
- Hours shown clearly, when given.
- Real reviews and the real rating, when given, quoted word for word with the reviewer's first name.
- A working contact form: a real form with fields named "name", "phone", "email" and "message" (a textarea) plus a submit button, and no action attribute. Where it sits and how large it is follows the structure brief; it does not have to be a section near the bottom.
- Mobile first: design for a 380px-wide phone before anything else. The owner will almost certainly see this on a phone, and so will his customers.
- Fast: no heavy libraries, lazy-load photos, keep the whole page under about 1.5MB.

OUTPUT RULES
- Respond with ONE complete HTML document and nothing else. No markdown fences, no commentary before or after.
- The response starts with <!doctype html>, then the FORGE-CONCEPT comment, then <html>.
- All CSS and JavaScript inline. The only external resources allowed are Google Fonts and, where the structure calls for a map and an address was given, one Google Maps embed: <iframe loading="lazy" title="Map" src="https://www.google.com/maps?q=URL-ENCODED-NAME-AND-ADDRESS&output=embed"> at a fixed height with a background colour behind it.
- No stock photographs and no hotlinked images unless the request says photographs may be used. A page drawn in type, colour and inline SVG loads faster, cannot show a broken image, and does not pass a stranger's photo off as this business.
- Working tel: links on every phone number.
- Nothing may be permanently invisible, unreachable or unusable if JavaScript fails. Animate from a visible baseline, or add the hiding class with JS.
- No "made with AI", "powered by", watermark or generator credit anywhere, visible or in comments.

SEO AND METADATA
- The head needs: charset, viewport, a real title ("Electrician in Worcester, MA | Business Name", about 60 characters), and a meta description of about 150 characters naming the business, its main services and its town.
- Open Graph tags: og:title, og:description, og:type ("website"), and og:image when the page uses a hero image.
- A LocalBusiness JSON-LD block using the most specific schema.org type that fits the trade (AutoRepair, AutoBodyShop, Plumber, Electrician, HairSalon, Restaurant, Bakery, RoofingContractor, HVACBusiness, LandscapingBusiness and so on), falling back to LocalBusiness. Include name, description and telephone when given. Include address, geo, openingHours, priceRange or areaServed ONLY when those exact details appear in the request. Never invent them. Omit url unless a domain was given.
- An inline SVG favicon via a data URI, so the browser tab is not blank.
- Exactly one h1, a sensible heading order, descriptive alt text on every image.
- A footer matching the design with the business name, an auto-updating copyright year via a tiny inline script, and a brief privacy line.

STEP 3 — SELF-CHECK BEFORE YOU OUTPUT
Run these and fix anything that fails before returning the HTML:
1. Could this page be reused for a competitor by swapping the name? If yes, it is not specific enough.
2. Is any fact on the page absent from the request? If yes, remove it.
3. Is any banned font, colour, gradient, layout default or phrase present? If yes, replace it.
4. Is the phone number the easiest thing to tap on a 380px screen?
5. Is there at least one thing here a template would never do?
6. Is there an emoji, a number counting up from zero, or a customer quote that is not word for word from the request? If yes, remove it.`;

function buildSystem(mode, { brand, page, pages }) {
  if (mode === 'refine') {
    return `You are an expert web developer editing an existing, complete HTML website document.
You will be given the current HTML and a change request. Apply the requested change (plus only the minimal related adjustments needed for it to look right and stay consistent), and keep everything else — content, copy, layout, styling, and structure — as close to the original as possible. Do NOT redesign the page or rewrite sections that the request doesn't touch.

HOW THE RULES BELOW APPLY TO AN EDIT
- Skip STEP 1. Do not write a new concept brief, and do not change or remove the existing FORGE-CONCEPT comment — carry it through untouched. The page already has a concept; your job is to work inside it.
- Read "could this be reused for a competitor" as a reason to keep this page's specific character, never as a reason to start over. Never start over on an edit.
- The no-invention rule applies in full: do not add a fact, a testimonial, an hour, a price or a credential that is not already in the page or in the change request.
- The banned fonts, colours, layout defaults and phrases apply to anything you add or rewrite. If the existing page already breaks one of them, leave it alone unless the change request is about that.
${SHARED_RULES}`;
  }
  if (mode === 'brand') {
    const pageList = (pages || []).map((p) => `${p.filename} — ${p.title}`).join('; ');
    return `You are a brand designer preparing a shared style guide that several independent page-generation calls will all follow, so the pages come out as one cohesive site.

Given the website request, output a concise brand brief covering:
- Business name, exactly as given. A tagline only if the request supplies one.
- Tone of voice (2-3 adjectives), in the way this owner would actually talk
- Exact colour palette as hex values with roles (background, surface, ink, accent). Start from their real brand colours when the request gives them. Flat colour, no gradients, and no purple, violet or indigo unless it is theirs.
- Typography: one Google Font for headings and one for body text, chosen for this trade and the design concept in the request. Never for headings: Inter, Roboto, Open Sans, Lato, Poppins, Montserrat, Raleway, Nunito, Space Grotesk, Plus Jakarta Sans, Manrope, DM Sans, Outfit, Sora, Playfair Display, Oswald, Bebas Neue.
- Layout and visual style notes (2-3 sentences) that follow the design concept in the request, if there is one
- One signature detail tied to the trade, to appear on every page
- Navigation: the exact nav label to use for each of these pages: ${pageList}

Use only facts stated in the request. Do not invent a tagline, a founding year, a slogan about trust or quality, or any claim about the business.

Output plain text only, under 250 words. No markdown formatting.`;
  }

  let system = `You are an expert web designer and front-end developer. You build complete, polished, production-quality business websites as a single self-contained HTML file.
${SHARED_RULES}`;

  if (page && pages && pages.length > 1) {
    const nav = pages.map((p) => `"${p.title}" -> ${p.filename}`).join(', ');
    system += `

Multi-page site context:
- This page is ONE page of a multi-page site. Generate only the "${page.title}" page (${page.filename}).
- Every page shares an identical navigation bar linking to all pages with exactly these relative hrefs: ${nav}. Mark the current page as active in the nav.
- Follow this shared brand guide EXACTLY (colors, fonts, tone, nav labels) so this page matches the rest of the site:

${brand || '(no brand guide provided — keep styling conservative and consistent)'}`;
  }
  return system;
}

function buildUserMessage(mode, { prompt, context, page, html, instruction }) {
  if (mode === 'refine') {
    return `Here is the current HTML document:\n\n${html}\n\n---\n\nChange request: ${instruction}\n\nReturn the complete, updated HTML document with this change applied.`;
  }
  let msg = `Website request:\n${prompt}`;
  if (context) {
    msg += `\n\nExtracted details (from client-side keyword analysis of the request):\n${context}`;
  }
  if (mode === 'page' && page) {
    msg += `\n\nGenerate the "${page.title}" page (${page.filename}) now.`;
  }
  return msg;
}

// Pull a clean HTML document out of the response text, defensively handling
// stray markdown fences even though the system prompt forbids them.
function extractHtml(text) {
  let out = text.trim();
  const fence = out.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].includes('<html')) out = fence[1].trim();
  const start = out.search(/<!DOCTYPE html/i);
  if (start > 0) out = out.slice(start);
  if (!/<html/i.test(out)) {
    throw new HttpError(502, 'The model did not return a valid HTML page. Try again.');
  }
  return out;
}

// One request to the model. `extras` adds the effort level and, where the model
// supports it, the refusal fallback; without them the request is exactly the
// shape Forge has always sent.
function callModel(client, { model, maxTokens, system, userMessage, mode }, { extras }) {
  const base = {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: userMessage }],
  };
  if (!extras) return client.messages.stream(base).finalMessage();

  const params = { ...base, output_config: { effort: EFFORT[mode] || 'high' } };
  if (REFUSAL_FALLBACK_MODELS.has(model)) {
    return client.beta.messages
      .stream({ ...params, betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' })
      .finalMessage();
  }
  return client.messages.stream(params).finalMessage();
}

// `beforeCall` runs before every request that is billed — including the
// second, larger attempt after a cut-off page — so a spending cap counts what
// is actually charged. It may throw to stop the call.
export async function generate(env, { mode, prompt, context, brand, page, pages, html, instruction }, { beforeCall } = {}) {
  if (env.MOCK_ANTHROPIC === '1') {
    if (beforeCall) await beforeCall();
    return mockGenerate(mode, { prompt, page, html, instruction });
  }

  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'ANTHROPIC_API_KEY is not configured on the server.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  let extras = true;
  const system = buildSystem(mode, { brand, page, pages });
  const userMessage = buildUserMessage(mode, { prompt, context, page, html, instruction });

  let maxTokens = mode === 'brand' ? BRAND_MAX_TOKENS : PAGE_MAX_TOKENS;
  const retryTokens = mode === 'brand' ? BRAND_RETRY_MAX_TOKENS : PAGE_RETRY_MAX_TOKENS;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (beforeCall) await beforeCall();

    // Two things can be wrong with a request that have nothing to do with the
    // page being asked for, and neither is billed: the account may not have
    // the default model, or may not accept one of the optional settings. Each
    // is stepped around once, so a newer model or setting can never be the
    // reason generation stops working.
    let message;
    for (;;) {
      try {
        message = await callModel(client, { model, maxTokens, system, userMessage, mode }, { extras });
        break;
      } catch (err) {
        if (err instanceof Anthropic.NotFoundError && model === DEFAULT_MODEL && !env.ANTHROPIC_MODEL) {
          console.warn(`Model ${DEFAULT_MODEL} is not available to this account; using ${FALLBACK_MODEL}.`);
          model = FALLBACK_MODEL;
          continue;
        }
        if (err instanceof Anthropic.BadRequestError && extras) {
          console.warn('Request rejected with optional settings; retrying without them:', apiMessage(err));
          extras = false;
          continue;
        }
        throw mapAnthropicError(err, model);
      }
    }

    if (message.stop_reason === 'refusal') {
      throw new HttpError(422, 'The model declined to generate this content. Rephrase the request and try again.');
    }

    // Truncation check: never silently return a cut-off page. Retry once
    // with a higher max_tokens, then surface a clear error.
    if (message.stop_reason === 'max_tokens') {
      if (attempt === 0) {
        maxTokens = retryTokens;
        continue;
      }
      throw new HttpError(
        502,
        'Generation ran out of room twice (output truncated even at the maximum size). Simplify the request — e.g. fewer sections — and try again.'
      );
    }

    // Read by type, not position: a response can open with thinking blocks.
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      text: mode === 'brand' ? text.trim() : extractHtml(text),
      usage: {
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
      },
      model: message.model,
    };
  }
  throw new HttpError(500, 'Generation failed unexpectedly.');
}

// The API's own sentence about what went wrong, from the structured error
// body, rather than the SDK's message (which is the raw JSON with a status
// number in front of it).
function apiMessage(err) {
  const text = err?.error?.error?.message;
  return typeof text === 'string' && text ? text : String(err?.message || 'unknown error');
}

function apiErrorType(err) {
  return err?.type || err?.error?.error?.type || '';
}

// Turn an SDK error into something the person at the keyboard can act on.
// Most specific first: in this SDK a connection error is a kind of APIError,
// so it has to be tested before the general case or it is never reached.
function mapAnthropicError(err, model) {
  if (err instanceof HttpError) return err;

  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new HttpError(504, 'Anthropic took too long to answer. Try again in a moment.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, 'Could not reach Anthropic. Try again in a moment.');
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new HttpError(500, 'The Anthropic API key on the server was rejected. Check ANTHROPIC_API_KEY in Cloudflare.');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new HttpError(502, `This Anthropic API key is not allowed to do that: ${apiMessage(err)}`);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new HttpError(
      502,
      `The AI model "${model}" is not available on this Anthropic account. Set ANTHROPIC_MODEL in Cloudflare to one that is.`
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(429, 'Anthropic is rate-limiting this account right now. Wait a minute and try again.');
  }
  if (err instanceof Anthropic.InternalServerError) {
    return apiErrorType(err) === 'overloaded_error'
      ? new HttpError(503, 'Anthropic is overloaded right now. Wait a minute and try again.')
      : new HttpError(503, 'Anthropic had a problem on its side. Wait a minute and try again.');
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402 || apiErrorType(err) === 'billing_error') {
      return new HttpError(
        402,
        'Your Anthropic account is out of credits. Add credits at console.anthropic.com under Plans & Billing, then try again.'
      );
    }
    if (err.status === 413 || apiErrorType(err) === 'request_too_large') {
      return new HttpError(413, 'That was too large to send to the AI. Shorten the description, or use fewer embedded photos.');
    }
    if (err instanceof Anthropic.BadRequestError) {
      return new HttpError(502, `Anthropic did not accept the request: ${apiMessage(err)}`);
    }
    return new HttpError(502, `Anthropic returned an error (${err.status ?? 'no status'}): ${apiMessage(err)}`);
  }
  if (err instanceof Anthropic.AnthropicError) {
    // Raised by the SDK itself, for example when a stream ends early.
    return new HttpError(502, 'The connection to Anthropic dropped part-way through. Try again.');
  }
  return err;
}

// Dev-only canned responses (MOCK_ANTHROPIC=1) so the full pipeline —
// generate → preview link → serve — can be exercised without an API key.
function mockGenerate(mode, { prompt, page, html, instruction }) {
  if (mode === 'refine') {
    const base =
      typeof html === 'string' && /<html/i.test(html)
        ? html
        : '<!DOCTYPE html><html><head><title>Site</title></head><body></body></html>';
    const marker = `<!-- refined (mock): ${String(instruction).replace(/--+/g, '-').slice(0, 120)} -->`;
    const out = base.includes('</body>') ? base.replace('</body>', `${marker}</body>`) : base + marker;
    return { text: out, usage: { inputTokens: 0, outputTokens: 0 }, model: 'mock' };
  }
  if (mode === 'brand') {
    return {
      text: `MockCo — "Quality you can trust". Tone: friendly, professional, local. Palette: background #101418, surface #1A2027, ink #F2F5F8, accent #E8853C. Fonts: "Fraunces" headings, "Karla" body. Style: bold hero, generous whitespace. Nav labels: Home, About, Contact.`,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'mock',
    };
  }
  const title = page ? page.title : 'Home';
  // Echoes back the concept and layout it was asked for, and names a display
  // font from the mood lists, so the parse-read-rotate loop and the banned-list
  // scan can both be exercised without spending a real credit.
  const askedConcept = (String(prompt || '').match(/DESIGN CONCEPT — start from "([^"]+)"/) || [])[1] || 'Mock Concept';
  const askedLayout = (String(prompt || '').match(/Page structure — "([^"]+)"/) || [])[1] || 'Classic service page';
  const MOCK_FONTS = ['Anton', 'Fraunces', 'Bricolage Grotesque', 'Alfa Slab One', 'Big Shoulders Display', 'Instrument Serif', 'Syne', 'Zilla Slab', 'Oswald', 'Young Serif', 'Archivo Black', 'Gloock', 'Unbounded'];
  const mockFont = MOCK_FONTS[Math.floor(Math.random() * MOCK_FONTS.length)];
  const pageHtml = `<!DOCTYPE html>
<!-- FORGE-CONCEPT
concept: ${askedConcept}
from: mock generator echoing the requested direction
feeling: this is a mock page
display-font: ${mockFont}
body-font: Karla
palette: bg #101418, ink #F2F5F8, accent #E8853C
layout-signature: ${askedLayout}
signature-detail: none, this is a mock
voice: plain
headline: Mock page for ${title}
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Mock Site</title>
<style>
  body{font-family:Georgia,serif;background:#101418;color:#F2F5F8;margin:0}
  header{padding:16px 24px;background:#1A2027;display:flex;gap:16px}
  header a{color:#E8853C;text-decoration:none}
  main{padding:48px 24px;max-width:720px;margin:0 auto}
  h1{font-size:2.4rem}
</style>
</head>
<body>
<header><a href="index.html">Home</a><a href="about.html">About</a><a href="contact.html">Contact</a></header>
<main>
<h1>${title} (mock page)</h1>
<p>This is a development mock page (mock generation mode). Prompt received:</p>
<blockquote>${String(prompt).replace(/</g, '&lt;').slice(0, 500)}</blockquote>
</main>
</body>
</html>`;
  return { text: pageHtml, usage: { inputTokens: 0, outputTokens: 0 }, model: 'mock' };
}
