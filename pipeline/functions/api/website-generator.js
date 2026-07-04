// POST /api/website-generator — Stage 2 (Agent 3).
// Body: { brief, version: "single" | "multi" }
// The two versions are generated as separate calls so each response is
// cleanly parseable (one HTML doc vs a JSON map of files).
// Returns single: { html, meta }   |   multi: { files: {name: html}, meta }

import { handle, json, readJson, requireString, HttpError } from '../../lib/http.js';
import { callClaude, extractHtml, parseJson } from '../../lib/claude.js';
import { WEBSITE_GENERATOR } from '../../lib/agents.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const brief = requireString(body, 'brief', { max: 20000 });
  const version = body.version === 'multi' ? 'multi' : 'single';

  const contract =
    version === 'single'
      ? `--- OUTPUT CONTRACT FOR THIS API ---
Produce ONLY the SINGLE-PAGE version now. Respond with ONE complete, self-contained HTML document and nothing else — no markdown fences, no commentary. It must start with <!DOCTYPE html> and inline all CSS and JS. Include smooth-scroll navigation to the sections.`
      : `--- OUTPUT CONTRACT FOR THIS API ---
Produce ONLY the MULTI-PAGE version now. Respond with ONLY a JSON object mapping each filename to that page's full HTML document, e.g. {"index.html":"<!DOCTYPE html>...","services.html":"...","about.html":"...","testimonials.html":"...","contact.html":"..."}. Every value must be a complete self-contained HTML document, and every page must share an identical nav bar that links the pages by these relative filenames. Output raw JSON only — no markdown fences, no commentary.`;

  const system = `${WEBSITE_GENERATOR}\n\n${contract}`;
  const user = `Detailed business prompt to build from:\n\n${brief}`;

  const { text, usage, model } = await callClaude(env, { system, user, maxTokens: 32000, retryMaxTokens: 64000 });

  if (version === 'single') {
    return json({ html: extractHtml(text), meta: { model, usage } });
  }

  const parsed = parseJson(text);
  const files = {};
  for (const [name, html] of Object.entries(parsed)) {
    if (typeof html === 'string' && /<html/i.test(html)) files[String(name)] = html;
  }
  if (!Object.keys(files).length) throw new HttpError(502, 'The multi-page generator returned no valid HTML files. Try again.');
  return json({ files, meta: { model, usage } });
});
