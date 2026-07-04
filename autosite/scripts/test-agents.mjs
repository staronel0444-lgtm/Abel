// Offline smoke test for the AutoSite agents. No API key, no network:
// runs Agent 2 in mock mode and exercises the competitor HTML parser on a
// fixed HTML string. Run: `npm test` (from the autosite/ directory).

import assert from 'node:assert';
import { extractSummary, normalizeUrl } from '../lib/fetchPage.js';
import { runPromptEngineer, normalizeInput } from '../lib/agents/promptEngineer.js';

let passed = 0;
const ok = (name) => { console.log('  ✓', name); passed++; };

// --- fetchPage.extractSummary ---
const SAMPLE = `<!DOCTYPE html><html><head>
  <title>Acme Plumbing ATX</title>
  <meta name="description" content="24/7 plumbing in Austin">
  <style>.x{color:red}</style><script>var a=1;</script>
</head><body>
  <nav><a href="/">Home</a><a href="/services">Services</a><a href="/contact">Contact</a></nav>
  <h1>Austin's Fastest Plumbers</h1>
  <section><h2>Our Services</h2><p>Drain cleaning, water heaters &amp; more.</p></section>
  <section><h2>Reviews</h2><p>5 stars from 200 customers</p></section>
  <button>Call Now</button>
  <a href="/quote">Get a Free Quote</a>
  <form><input name="email"></form>
</body></html>`;

const s = extractSummary(SAMPLE);
assert.strictEqual(s.title, 'Acme Plumbing ATX');
ok('extracts <title>');
assert.strictEqual(s.metaDescription, '24/7 plumbing in Austin');
ok('extracts meta description');
assert.deepStrictEqual(s.headings.h1, ["Austin's Fastest Plumbers"]);
ok('extracts h1');
assert.ok(s.navLinks.includes('Services'));
ok('extracts nav links');
assert.ok(s.ctas.some((c) => /Free Quote|Call Now/.test(c)));
ok('detects CTAs');
assert.strictEqual(s.structure.formCount, 1);
ok('counts forms');
assert.ok(s.structure.mentions.includes('testimonials'));
ok('sniffs testimonial feature');
assert.ok(!/var a=1|color:red/.test(s.textExcerpt));
ok('strips script/style from text');

assert.strictEqual(normalizeUrl('acme.com'), 'https://acme.com/');
assert.strictEqual(normalizeUrl('not a url ok'), 'https://not%20a%20url%20ok/');
assert.strictEqual(normalizeUrl('javascript:alert(1)'), null);
ok('normalizeUrl adds scheme and rejects non-http');

// --- normalizeInput ---
const n = normalizeInput({
  name: '  Rivera Plumbing ',
  service: 'Plumbing',
  reviews: [{ rating: 5, author: 'Tom', text: 'Fast and clean' }, 'Great price'],
  competitors: 'a.com\nb.com, c.com',
});
assert.strictEqual(n.businessName, 'Rivera Plumbing');
assert.ok(n.reviews.includes('5★ Tom: Fast and clean') && n.reviews.includes('Great price'));
ok('normalizeInput flattens object + string reviews');
assert.deepStrictEqual(n.competitors, ['a.com', 'b.com', 'c.com']);
ok('normalizeInput splits competitor string on newlines/commas');
assert.throws(() => normalizeInput({ service: 'x' }), /businessName is required/);
ok('normalizeInput requires businessName');

// --- runPromptEngineer (mock mode, no competitors → no network) ---
const env = { MOCK_ANTHROPIC: '1' };
const result = await runPromptEngineer(env, {
  businessName: 'Rivera & Sons Plumbing',
  serviceType: 'Emergency plumbing',
  phone: '(512) 555-0142',
  address: 'Austin, TX',
  reviews: '5★ Maria: Showed up in 30 minutes and fixed it fast. Fair price too.',
  competitors: [],
});
assert.ok(result.websitePrompt.includes('Rivera & Sons Plumbing'));
ok('runPromptEngineer returns a website prompt naming the business');
assert.strictEqual(result.sellingPoints.length, 3);
ok('runPromptEngineer returns 3 selling points');
assert.strictEqual(result.recommendation.sections[0], 'hero');
ok('runPromptEngineer returns recommended sections');

console.log(`\n${passed} checks passed.`);
