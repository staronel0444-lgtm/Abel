// POST /api/qa-auditor — Stage 4 (Agent 5).
// Body: { html, brief }
// Returns: { ready, summary, issues: [{issue, agent, fix}], meta }

import { handle, json, readJson, requireString, HttpError } from '../../lib/http.js';
import { callClaude, parseJson } from '../../lib/claude.js';
import { QA_AUDITOR } from '../../lib/agents.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const html = requireString(body, 'html', { max: 300000 });
  const brief = requireString(body, 'brief', { max: 20000 });

  const system = `${QA_AUDITOR}

--- OUTPUT CONTRACT FOR THIS API ---
Respond with ONLY a JSON object, no markdown fences or commentary, in exactly this shape:
{
  "ready": true | false,
  "summary": "<one sentence overall verdict>",
  "issues": [
    { "issue": "<what the issue is>", "agent": "Agent 2 | Agent 3 | Agent 4", "fix": "<specific fix needed>" }
  ]
}
Set "ready" to true and "issues" to [] only if the site is ready for client delivery.`;

  const user = `ORIGINAL BUSINESS PROMPT:\n${brief}\n\n---\n\nFINISHED HTML TO REVIEW:\n${html}`;

  const { text, usage, model } = await callClaude(env, { system, user, maxTokens: 6000, retryMaxTokens: 12000 });

  const parsed = parseJson(text);
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues
        .filter((i) => i && typeof i === 'object')
        .map((i) => ({ issue: String(i.issue || ''), agent: String(i.agent || ''), fix: String(i.fix || '') }))
    : [];
  return json({
    ready: parsed.ready === true && issues.length === 0,
    summary: String(parsed.summary || ''),
    issues,
    meta: { model, usage },
  });
});
