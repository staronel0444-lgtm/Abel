// POST /api/live-call-assistant — Agent 6.
// Body: { context, transcript }  (transcript = the latest client question/comment,
//   optionally with recent lines for context)
// Returns: { suggestion, meta }

import { handle, json, readJson, requireString } from '../../lib/http.js';
import { callClaude } from '../../lib/claude.js';
import { LIVE_CALL_ASSISTANT } from '../../lib/agents.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const context = requireString(body, 'context', { max: 20000 });
  const transcript = requireString(body, 'transcript', { max: 8000 });

  const system = `${LIVE_CALL_ASSISTANT}

--- OUTPUT CONTRACT FOR THIS API ---
Respond with ONLY the 1-2 sentence suggestion the user can say — no labels, no quotes, no commentary.`;

  const user = `CONTEXT ON THE WEBSITE ALREADY BUILT / BUSINESS:\n${context}\n\n---\n\nLIVE TRANSCRIPT (most recent client question/comment last):\n${transcript}\n\nGive the user a short suggestion to say now.`;

  const { text, usage, model } = await callClaude(env, { system, user, maxTokens: 1000, retryMaxTokens: 2000 });
  return json({ suggestion: text.trim(), meta: { model, usage } });
});
