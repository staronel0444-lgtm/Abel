// POST /api/prompt-engineer — Stage 1 (Agent 2).
// Body: { businessName, serviceType, phone?, address?, reviews, competitors[] }
// Returns: { brief, competitorsFetched, meta }

import { handle, json, readJson, HttpError } from '../../lib/http.js';
import { callClaude } from '../../lib/claude.js';
import { analyzeCompetitor } from '../../lib/fetchPage.js';
import { PROMPT_ENGINEER } from '../../lib/agents.js';

const MAX_COMPETITORS = 5;

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const businessName = str(body.businessName);
  const serviceType = str(body.serviceType);
  if (!businessName) throw new HttpError(400, 'businessName is required');
  if (!serviceType) throw new HttpError(400, 'serviceType is required');

  let competitors = body.competitors;
  if (typeof competitors === 'string') competitors = competitors.split(/[\n,]+/);
  competitors = (Array.isArray(competitors) ? competitors : []).map(str).filter(Boolean).slice(0, MAX_COMPETITORS);

  const fetched = await Promise.all(competitors.map((u) => analyzeCompetitor(u)));

  const lines = ['BUSINESS INFORMATION', `- Name: ${businessName}`, `- Service type: ${serviceType}`];
  if (str(body.phone)) lines.push(`- Phone: ${str(body.phone)}`);
  if (str(body.address)) lines.push(`- Address: ${str(body.address)}`);
  lines.push('\nGOOGLE REVIEWS (full text)', str(body.reviews) || '(no reviews provided)');
  lines.push('\nCOMPETITOR WEBSITE ANALYSIS (extracted for you — you cannot browse live, rely on this)');
  if (!fetched.length) lines.push('(no competitor URLs provided)');
  fetched.forEach((c, i) => {
    lines.push(`\n[Competitor ${i + 1}] ${c.url}`);
    if (!c.ok) return lines.push(`  (could not analyze: ${c.error})`);
    lines.push(`  Title: ${c.title || '(none)'}`);
    if (c.metaDescription) lines.push(`  Meta: ${c.metaDescription}`);
    if (c.headings?.h1?.length) lines.push(`  H1: ${c.headings.h1.join(' | ')}`);
    if (c.headings?.h2?.length) lines.push(`  H2: ${c.headings.h2.join(' | ')}`);
    if (c.navLinks?.length) lines.push(`  Nav: ${c.navLinks.join(', ')}`);
    if (c.ctas?.length) lines.push(`  CTAs: ${c.ctas.join(' | ')}`);
    const s = c.structure || {};
    lines.push(`  Structure: ${s.sectionCount || 0} sections, ${s.formCount || 0} forms, ${s.imageCount || 0} images${s.mentions?.length ? `; features: ${s.mentions.join(', ')}` : ''}`);
    if (c.textExcerpt) lines.push(`  Copy excerpt: ${c.textExcerpt.slice(0, 1200)}`);
  });

  const system = `${PROMPT_ENGINEER}

--- OUTPUT CONTRACT FOR THIS API ---
Respond with ONLY the one comprehensive prompt paragraph — no preamble, no headings, no commentary before or after.`;

  const { text, usage, model } = await callClaude(env, {
    system,
    user: lines.join('\n'),
    maxTokens: 4000,
    retryMaxTokens: 8000,
  });

  return json({
    brief: text.trim(),
    competitorsFetched: fetched.map((c) => ({ url: c.url, ok: c.ok, error: c.error || null })),
    meta: { model, usage },
  });
});

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
