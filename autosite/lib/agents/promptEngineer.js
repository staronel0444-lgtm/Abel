// Agent 2 — Prompt Engineer for Service Business Websites.
//
// Takes raw business intel (name, phone, address, service type, full review
// text, competitor URLs) and produces ONE comprehensive website-brief prompt
// detailed enough to feed straight into the HTML generator (Agent 3) with no
// clarification needed. Along the way it mines the reviews for the top three
// selling points and studies the competitors' sites for gaps to beat.
//
// The model returns JSON so the pipeline can carry the structured findings
// forward, but `websitePrompt` is the primary deliverable — the paragraph
// the generator actually consumes.

import { callClaude } from '../anthropic.js';
import { analyzeCompetitor } from '../fetchPage.js';
import { HttpError } from '../http.js';

export const AGENT = {
  id: 'prompt-engineer',
  number: 2,
  name: 'Prompt Engineer for Service Business Websites',
};

const MAX_COMPETITORS = 5;
const MAX_REVIEWS_CHARS = 20000;

const SYSTEM = `You are an expert prompt engineer specializing in creating detailed website briefs for local service businesses. Your job is to take raw business information and turn it into a comprehensive, detailed prompt that will be fed directly into an HTML website generator.

You are given: the business name, phone number, address, service type, the full text of the business's Google reviews, and a structural analysis of one or more competitor websites (extracted for you — you cannot browse live, so rely on the analysis provided).

Do all of the following:
1. Read every review and identify the TOP THREE selling points customers mention most often (e.g. speed, quality, price, reliability, friendliness, cleanliness, on-time). Ground each in what reviewers actually say — do not invent praise that isn't there.
2. Study the competitor analyses. Note the sections, design elements, and features they use, and identify what is missing or weak so the new site can beat them.
3. Decide the business's vibe and tone, the key selling points to headline, the recommended sections (at minimum: hero, services, testimonials, call-to-action, contact — add trade-appropriate ones like gallery, pricing, service area, FAQ where useful), a design style (modern, clean, professional, warm, bold — whatever fits the trade), a concrete color-palette suggestion (name the colors), and any unique features the site needs to stand out.
4. Write ONE comprehensive prompt paragraph that captures ALL of the above so specifically that a website generator could build a high-quality, on-brand site directly from it with zero further questions. Reference the real business name, phone, address, and service area. Weave in the three selling points and the concrete testimonials/proof. Be specific about tone, sections, layout, colors, and fonts. Never use placeholder or lorem-ipsum language, and never invent facts (hours, address, awards) that were not provided.

Respond with ONLY a JSON object (no markdown, no commentary) matching exactly this shape:
{
  "sellingPoints": ["<point 1>", "<point 2>", "<point 3>"],
  "reviewEvidence": ["<short quote or paraphrase supporting a point>", "..."],
  "competitorInsights": {
    "commonSections": ["<sections competitors all use>"],
    "gapsToBeat": ["<what competitors are missing or doing weakly>"]
  },
  "recommendation": {
    "vibe": "<2-4 words>",
    "tone": "<2-3 adjectives>",
    "sections": ["hero", "services", "..."],
    "designStyle": "<short phrase>",
    "colorPalette": "<named colors, e.g. 'deep navy + warm copper + off-white'>",
    "uniqueFeatures": ["<feature>", "..."]
  },
  "websitePrompt": "<the one comprehensive paragraph, ready to feed to the generator>"
}`;

// Validate + normalize the raw input into a clean shape.
export function normalizeInput(input) {
  const businessName = str(input.businessName || input.name);
  const serviceType = str(input.serviceType || input.service);
  if (!businessName) throw new HttpError(400, 'businessName is required');
  if (!serviceType) throw new HttpError(400, 'serviceType is required');

  const reviews = coerceReviews(input.reviews).slice(0, MAX_REVIEWS_CHARS);

  let competitors = input.competitors ?? input.competitorUrls ?? [];
  if (typeof competitors === 'string') {
    competitors = competitors.split(/[\n,]+/);
  }
  competitors = (Array.isArray(competitors) ? competitors : [])
    .map((c) => str(c))
    .filter(Boolean)
    .slice(0, MAX_COMPETITORS);

  return {
    businessName,
    serviceType,
    phone: str(input.phone),
    address: str(input.address),
    reviews,
    competitors,
  };
}

export async function runPromptEngineer(env, input) {
  const business = normalizeInput(input);

  // Visit each competitor (best-effort, in parallel).
  const competitors = await Promise.all(business.competitors.map((url) => analyzeCompetitor(url)));

  const user = buildUserMessage(business, competitors);

  const { json, usage, model } = await callClaude(env, {
    system: SYSTEM,
    user,
    expectJson: true,
    maxTokens: 6000,
    retryMaxTokens: 12000,
    mock: () => mockResult(business),
  });

  if (!json || typeof json.websitePrompt !== 'string' || !json.websitePrompt.trim()) {
    throw new HttpError(502, 'Agent 2 did not produce a website prompt. Try again.');
  }

  return {
    agent: AGENT.id,
    input: business,
    websitePrompt: json.websitePrompt.trim(),
    sellingPoints: asArray(json.sellingPoints).slice(0, 3),
    reviewEvidence: asArray(json.reviewEvidence),
    competitorInsights: json.competitorInsights || {},
    recommendation: json.recommendation || {},
    competitorsFetched: competitors.map((c) => ({ url: c.url, ok: c.ok, error: c.error || null })),
    meta: { model, usage },
  };
}

function buildUserMessage(business, competitors) {
  const lines = [];
  lines.push('BUSINESS INFORMATION');
  lines.push(`- Name: ${business.businessName}`);
  lines.push(`- Service type: ${business.serviceType}`);
  if (business.phone) lines.push(`- Phone: ${business.phone}`);
  if (business.address) lines.push(`- Address: ${business.address}`);

  lines.push('\nGOOGLE REVIEWS (full text)');
  lines.push(business.reviews ? business.reviews : '(no reviews provided)');

  lines.push('\nCOMPETITOR WEBSITE ANALYSIS');
  if (competitors.length === 0) {
    lines.push('(no competitor URLs provided)');
  } else {
    competitors.forEach((c, i) => {
      lines.push(`\n[Competitor ${i + 1}] ${c.url}`);
      if (!c.ok) {
        lines.push(`  (could not analyze: ${c.error})`);
        return;
      }
      lines.push(`  Title: ${c.title || '(none)'}`);
      if (c.metaDescription) lines.push(`  Meta description: ${c.metaDescription}`);
      if (c.headings?.h1?.length) lines.push(`  H1: ${c.headings.h1.join(' | ')}`);
      if (c.headings?.h2?.length) lines.push(`  H2 sections: ${c.headings.h2.join(' | ')}`);
      if (c.navLinks?.length) lines.push(`  Nav: ${c.navLinks.join(', ')}`);
      if (c.ctas?.length) lines.push(`  CTAs: ${c.ctas.join(' | ')}`);
      const s = c.structure || {};
      lines.push(
        `  Structure: ${s.sectionCount || 0} sections, ${s.formCount || 0} forms, ${s.imageCount || 0} images` +
          (s.hasVideo ? ', has video' : '') +
          (s.mentions?.length ? `; features: ${s.mentions.join(', ')}` : '')
      );
      if (c.textExcerpt) lines.push(`  Copy excerpt: ${c.textExcerpt.slice(0, 1200)}`);
    });
  }

  lines.push('\nProduce the JSON described in your instructions now.');
  return lines.join('\n');
}

// ---- helpers ----

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function asArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

// Reviews can arrive as a string, an array of strings, or an array of
// {text, rating, author} objects. Flatten any of those into one block.
function coerceReviews(reviews) {
  if (!reviews) return '';
  if (typeof reviews === 'string') return reviews.trim();
  if (Array.isArray(reviews)) {
    return reviews
      .map((r) => {
        if (typeof r === 'string') return r.trim();
        if (r && typeof r === 'object') {
          const rating = r.rating != null ? `${r.rating}★ ` : '';
          const author = r.author ? `${r.author}: ` : '';
          return `${rating}${author}${str(r.text || r.review || r.comment)}`.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

// Dev mock (MOCK_ANTHROPIC=1) — deterministic, no key or spend needed.
function mockResult(business) {
  const site = business.serviceType || 'local service';
  return {
    json: {
      sellingPoints: ['Fast, on-time service', 'High-quality workmanship', 'Fair, transparent pricing'],
      reviewEvidence: ['(mock) "Showed up on time and finished ahead of schedule."'],
      competitorInsights: {
        commonSections: ['hero', 'services', 'contact'],
        gapsToBeat: ['no real testimonials', 'weak mobile layout', 'no clear call-to-action'],
      },
      recommendation: {
        vibe: 'trustworthy local pro',
        tone: 'friendly, confident, professional',
        sections: ['hero', 'services', 'testimonials', 'call-to-action', 'contact'],
        designStyle: 'modern, clean, professional',
        colorPalette: 'deep navy + warm copper + off-white',
        uniqueFeatures: ['click-to-call header', 'trust badges (licensed & insured)'],
      },
      websitePrompt:
        `Build a modern, clean, professional single-page website for ${business.businessName}, a ${site}` +
        `${business.address ? ` serving ${business.address}` : ''}. Vibe: trustworthy local pro. Headline the three ` +
        `selling points customers praise most — fast on-time service, high-quality workmanship, and fair transparent ` +
        `pricing. Sections in order: a bold hero with the business name, a one-line value promise and a prominent ` +
        `click-to-call button${business.phone ? ` (${business.phone})` : ''}; a services grid; a testimonials band using ` +
        `real customer quotes; trust badges (licensed & insured); and a contact section with a quote-request form and ` +
        `map. Palette: deep navy, warm copper accents, off-white background. Confident, friendly, professional tone. ` +
        `Beat competitors by including genuine testimonials, a flawless mobile layout, and an unmistakable call-to-action ` +
        `they lack. (MOCK OUTPUT)`,
    },
    usage: { input: 0, output: 0 },
    model: 'mock',
  };
}
