// Competitor-page analyzer for Agent 2 (prompt-engineer). A serverless
// function can't run a browser, so we fetch each competitor's raw HTML and
// distill it into a compact structural summary the model can reason over.

const MAX_BYTES = 600_000;
const MAX_EXCERPT = 3500;
const FETCH_TIMEOUT_MS = 9000;

export function extractSummary(html) {
  const src = String(html);
  const title = firstMatch(src, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription =
    attr(src, /<meta[^>]+name=["']description["'][^>]*>/i, 'content') ||
    attr(src, /<meta[^>]+property=["']og:description["'][^>]*>/i, 'content');
  const headings = {
    h1: tagTexts(src, 'h1').slice(0, 8),
    h2: tagTexts(src, 'h2').slice(0, 15),
    h3: tagTexts(src, 'h3').slice(0, 15),
  };
  const navBlock = firstMatch(src, /<nav[^>]*>([\s\S]*?)<\/nav>/i, true);
  const navLinks = unique(navBlock ? anchorTexts(navBlock) : anchorTexts(src).slice(0, 12)).slice(0, 15);
  const ctas = unique([
    ...tagTexts(src, 'button'),
    ...anchorTexts(src).filter((t) => /\b(call|book|quote|contact|get|schedule|free|estimate|request|buy|order|start|sign)\b/i.test(t)),
  ]).slice(0, 12);
  const structure = {
    formCount: countTag(src, 'form'),
    imageCount: countTag(src, 'img'),
    hasVideo: /<video[\s>]|youtube\.com|vimeo\.com/i.test(src),
    sectionCount: countTag(src, 'section'),
    mentions: keywordHits(src, {
      testimonials: /testimonial|review|★|⭐|stars?\b/i,
      pricing: /pricing|\$\d|per month|\/mo\b/i,
      gallery: /gallery|portfolio|our work|before (?:and|&) after/i,
      faq: /\bfaq\b|frequently asked/i,
      booking: /book (?:now|online|an appointment)|schedule online/i,
      chat: /live chat|chat with us|messenger/i,
      map: /google\.com\/maps|<iframe[^>]+maps/i,
      socialProof: /as seen|award|certified|licensed|insured|years? (?:of )?experience/i,
    }),
  };
  const text = visibleText(src);
  return {
    title,
    metaDescription,
    headings,
    navLinks,
    ctas,
    structure,
    textExcerpt: text.slice(0, MAX_EXCERPT),
    wordCount: text ? text.split(/\s+/).length : 0,
  };
}

// Fetch one competitor URL and return its summary, or a structured failure.
// Never throws — a dead link must not abort the agent.
export async function analyzeCompetitor(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { url: String(rawUrl), ok: false, error: 'invalid URL' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PipelineBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { url, ok: false, error: `HTTP ${res.status}` };
    const ct = res.headers.get('content-type') || '';
    if (ct && !/html/i.test(ct)) return { url, ok: false, error: `not HTML (${ct})` };
    const html = (await res.text()).slice(0, MAX_BYTES);
    return { url, ok: true, ...extractSummary(html) };
  } catch (err) {
    const error = err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err);
    return { url, ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// ---- regex helpers (no DOM) ----
function stripNoise(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}
function visibleText(html) {
  return decodeEntities(stripNoise(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}
function firstMatch(html, re, keepInner = false) {
  const m = re.exec(html);
  if (!m) return '';
  return keepInner ? m[1] : clean(m[1]);
}
function attr(html, tagRe, name) {
  const tag = tagRe.exec(html);
  if (!tag) return '';
  const m = new RegExp(name + '=["\']([^"\']*)["\']', 'i').exec(tag[0]);
  return m ? clean(m[1]) : '';
}
function tagTexts(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const t = clean(m[1].replace(/<[^>]+>/g, ' '));
    if (t) out.push(t);
  }
  return out;
}
function anchorTexts(html) {
  return tagTexts(html, 'a').filter((t) => t.length > 1 && t.length < 40);
}
function countTag(html, tag) {
  const m = html.match(new RegExp(`<${tag}[\\s>]`, 'gi'));
  return m ? m.length : 0;
}
function keywordHits(html, map) {
  const hits = [];
  for (const [feature, re] of Object.entries(map)) if (re.test(html)) hits.push(feature);
  return hits;
}
function clean(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function unique(arr) {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}
