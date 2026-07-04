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
import { injectForms } from '../../lib/forminject.js';
import { injectAnalytics } from '../../lib/analytics.js';

const MAX_PAGES = 8;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// If the caller supplied a "notify email", wire the page's contact form(s) to
// that address with a self-contained mailto handler. This needs no server, no
// database, and no third-party service, so the form keeps working after the
// site is downloaded and hosted on the client's own domain.
function wireForms(html, notifyEmail) {
  const email = typeof notifyEmail === 'string' ? notifyEmail.trim() : '';
  if (!email || !EMAIL_RE.test(email)) return html;
  const business = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim().slice(0, 120);
  return injectForms(html, email, business);
}

// Bake the visitor-counter beacon in, pointed at this Forge origin so it keeps
// counting after the site is downloaded to the client's domain.
function wireAnalytics(html, siteId, request) {
  const id = typeof siteId === 'string' ? siteId.trim().slice(0, 64) : '';
  if (!id) return html;
  return injectAnalytics(html, id, new URL(request.url).origin);
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
    let wired = wireForms(result.text, body.notifyEmail);
    wired = wireAnalytics(wired, body.siteId, request);
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
  let wired = wireForms(result.text, body.notifyEmail);
  wired = wireAnalytics(wired, body.siteId, request);
  return json({ html: wired, usage: result.usage, model: result.model });
});
