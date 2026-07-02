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

const MAX_PAGES = 8;

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
  const mode = body.mode === 'brand' ? 'brand' : 'page';
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
  return json({ html: result.text, usage: result.usage, model: result.model });
});
