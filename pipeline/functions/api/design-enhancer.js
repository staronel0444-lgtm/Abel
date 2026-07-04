// POST /api/design-enhancer — Stage 3 (Agent 4).
// Body: { html }
// Returns: { html, meta }  — the same page enhanced in place.

import { handle, json, readJson, requireString, HttpError } from '../../lib/http.js';
import { callClaude, extractHtml } from '../../lib/claude.js';
import { DESIGN_ENHANCER } from '../../lib/agents.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const html = requireString(body, 'html', { max: 300000 });
  if (!/<html/i.test(html)) throw new HttpError(400, 'html must be a complete HTML document');

  const system = `${DESIGN_ENHANCER}

--- OUTPUT CONTRACT FOR THIS API ---
Respond with ONLY the enhanced complete HTML document — it must start with <!DOCTYPE html> and contain all CSS/JS inline. No markdown fences, no commentary. Preserve all existing business content, text, and page structure exactly; only enhance look, feel, and performance.`;

  const { text, usage, model } = await callClaude(env, {
    system,
    user: `Here is the complete HTML document to enhance in place:\n\n${html}`,
    maxTokens: 32000,
    retryMaxTokens: 64000,
  });

  return json({ html: extractHtml(text), meta: { model, usage } });
});
