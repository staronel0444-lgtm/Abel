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

const DEFAULT_MODEL = 'claude-opus-4-8';

// Streaming avoids HTTP timeouts at these sizes; thinking tokens share the
// budget with the page output.
const PAGE_MAX_TOKENS = 32000;
const PAGE_RETRY_MAX_TOKENS = 64000;
const BRAND_MAX_TOKENS = 2000;
const BRAND_RETRY_MAX_TOKENS = 4000;

const SHARED_RULES = `
Output rules:
- Respond with ONE complete HTML document and nothing else. No markdown fences, no commentary before or after the document.
- The response must start with <!DOCTYPE html>.
- All CSS and JavaScript live inline in the document (<style>/<script>). The only allowed external resources are Google Fonts and royalty-free stock images (e.g. https://images.unsplash.com/...).
- Responsive and accessible; must look professional on both mobile and desktop.
- Write realistic, specific copy grounded in the business details provided — never lorem ipsum, never placeholder text like [Your Name].
- Include working tel: links for any phone number provided.
- Do NOT include any "made with AI", "powered by", watermark, generator credit, or similar branding anywhere in the page — visible or in comments.

Design rules:
- NEVER use generic AI-generated aesthetics: overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white or dark backgrounds), predictable layouts, or cookie-cutter design that lacks context-specific character.
- Use distinctive fonts, a cohesive palette that fits the trade/industry, and tasteful micro-interactions.`;

function buildSystem(mode, { brand, page, pages }) {
  if (mode === 'brand') {
    const pageList = (pages || []).map((p) => `${p.filename} — ${p.title}`).join('; ');
    return `You are a brand designer preparing a shared style guide that several independent page-generation calls will all follow, so the pages come out as one cohesive site.

Given the website request, output a concise brand brief covering:
- Business name and one-line tagline
- Tone of voice (2-3 adjectives)
- Exact color palette as hex values (background, surface, ink, accent)
- Typography: specific Google Fonts for headings and body
- Layout and visual style notes (2-3 sentences)
- Navigation: the exact nav label to use for each of these pages: ${pageList}

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

function buildUserMessage(mode, { prompt, context, page }) {
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

export async function generate(env, { mode, prompt, context, brand, page, pages }) {
  if (env.MOCK_ANTHROPIC === '1') return mockGenerate(mode, { prompt, page });

  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'ANTHROPIC_API_KEY is not configured on the server.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const system = buildSystem(mode, { brand, page, pages });
  const userMessage = buildUserMessage(mode, { prompt, context, page });

  let maxTokens = mode === 'brand' ? BRAND_MAX_TOKENS : PAGE_MAX_TOKENS;
  const retryTokens = mode === 'brand' ? BRAND_RETRY_MAX_TOKENS : PAGE_RETRY_MAX_TOKENS;

  for (let attempt = 0; attempt < 2; attempt++) {
    let message;
    try {
      message = await client.messages
        .stream({
          model,
          max_tokens: maxTokens,
          thinking: { type: 'adaptive' },
          system,
          messages: [{ role: 'user', content: userMessage }],
        })
        .finalMessage();
    } catch (err) {
      throw mapAnthropicError(err);
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

function mapAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new HttpError(500, 'The server\'s Anthropic API key was rejected. Check ANTHROPIC_API_KEY.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(429, 'Rate limited by the Anthropic API. Wait a moment and try again.');
  }
  if (err instanceof Anthropic.APIError) {
    return new HttpError(502, `Anthropic API error (${err.status}): ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, 'Could not reach the Anthropic API. Try again.');
  }
  return err;
}

// Dev-only canned responses (MOCK_ANTHROPIC=1) so the full pipeline —
// generate → preview link → serve — can be exercised without an API key.
function mockGenerate(mode, { prompt, page }) {
  if (mode === 'brand') {
    return {
      text: `MockCo — "Quality you can trust". Tone: friendly, professional, local. Palette: background #101418, surface #1A2027, ink #F2F5F8, accent #E8853C. Fonts: "Fraunces" headings, "Karla" body. Style: bold hero, generous whitespace. Nav labels: Home, About, Contact.`,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'mock',
    };
  }
  const title = page ? page.title : 'Home';
  const html = `<!DOCTYPE html>
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
  return { text: html, usage: { inputTokens: 0, outputTokens: 0 }, model: 'mock' };
}
