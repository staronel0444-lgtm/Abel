// POST /api/agents/prompt-engineer — Agent 2 (Prompt Engineer).
//
// Body: {
//   businessName, serviceType,          // required
//   phone?, address?,                    // optional business details
//   reviews,                             // string | string[] | {text,rating,author}[]
//   competitors                          // string | string[] of competitor URLs
// }
// Response: {
//   agent, websitePrompt, sellingPoints, reviewEvidence,
//   competitorInsights, recommendation, competitorsFetched, meta
// }

import { handle, json, readJson } from '../../../lib/http.js';
import { runPromptEngineer } from '../../../lib/agents/promptEngineer.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const result = await runPromptEngineer(env, body);
  return json(result);
});
