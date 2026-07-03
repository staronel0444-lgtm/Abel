// POST /api/generate — the shared Anthropic proxy route.
//
// The client never sees or sends an API key; the server holds it and also
// owns the system prompts, so this endpoint can only produce websites and
// brand briefs — it is not a general-purpose completion proxy.
//
// Body:
//   { mode: "page",  prompt, context?, brand?, page?: {filename,title}, pages?: [{filename,title}] }
//   { mode: "brand", prompt, pages: [{filename,title}] }
// Response: { html | brand, usage, model }

import { handle, json, readJson, requireString, HttpError } from '../../lib/http.js';
import { generate } from '../../lib/anthropic.js';
import { signToken } from '../../lib/token.js';
import { injectForms } from '../../lib/forminject.js';

const MAX_PAGES = 8;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// If the caller supplied a "notify email", wire the page's contact form(s) to
// Forge by injecting the handler script with a signed token. If email isn't
// configured on the server (no signing secret), leave the page untouched.
async function wireForms(env, request, html, notifyEmail) {
  const email = typeof notifyEmail === 'string' ? notifyEmail.trim() : '';
  if (!email || !EMAIL_RE.test(email)) return html;
  const secret = env.FORM_SIGNING_SECRET || env.RESEND_API_KEY;
  if (!secret) return html;
  const business = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim().slice(0, 120);
  const token = await signToken(secret, { e: email, b: business });
  const origin = new URL(request.url).origin;
  return injectForms(html, token, `${origin}/api/contact`);
}

function validatePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES) {
    throw new HttpError(400, `pages must be an array of 1-${MAX_PAGES} entries`);
  }
  return pages.map((p) => {
    const filename = String(p?.filename || '').trim();
    const title = String(p?.title || '').trim();
    if (!/^[a-z0-9-]+\.html$/i.test(filename) || !title) {
      throw new HttpError(400, 'Each page needs a title and a filename like "about.html"');
    }
    return { filename, title };
  });
}

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const mode = body.mode === 'brand' ? 'brand' : body.mode === 'refine' ? 'refine' : 'page';

  // Refine: edit an existing page from a plain-language instruction.
  if (mode === 'refine') {
    const html = requireString(body, 'html', { max: 300000 });
    if (!/<html/i.test(html)) throw new HttpError(400, 'html must be a complete HTML document');
    const instruction = requireString(body, 'instruction', { max: 2000 });
    const result = await generate(env, { mode, html, instruction });
    const wired = await wireForms(env, request, result.text, body.notifyEmail);
    return json({ html: wired, usage: result.usage, model: result.model });
  }

  const prompt = requireString(body, 'prompt', { max: 6000 });
  const context = typeof body.context === 'string' ? body.context.slice(0, 2000) : '';

  if (mode === 'brand') {
    const pages = validatePages(body.pages);
    const result = await generate(env, { mode, prompt, pages });
    return json({ brand: result.text, usage: result.usage, model: result.model });
  }

  let page = null;
  let pages = null;
  if (body.page || body.pages) {
    pages = validatePages(body.pages);
    const filename = String(body.page?.filename || '');
    page = pages.find((p) => p.filename === filename);
    if (!page) throw new HttpError(400, 'page.filename must be one of pages[]');
  }
  const brand = typeof body.brand === 'string' ? body.brand.slice(0, 4000) : '';

  const result = await generate(env, { mode, prompt, context, brand, page, pages });
  const wired = await wireForms(env, request, result.text, body.notifyEmail);
  return json({ html: wired, usage: result.usage, model: result.model });
});
