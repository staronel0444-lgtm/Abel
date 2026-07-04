// Offline smoke test — no API key, no network. Verifies the pure helpers and
// that every function module imports cleanly (catches syntax/wiring errors
// before deploy). Run: `npm test` from the pipeline/ directory.

import assert from 'node:assert';
import { extractSummary, normalizeUrl } from '../lib/fetchPage.js';
import { extractHtml, parseJson } from '../lib/claude.js';
import * as agents from '../lib/agents.js';

let n = 0;
const ok = (name) => { console.log('  ✓', name); n++; };

// fetchPage
const s = extractSummary(`<html><head><title>Acme</title><meta name="description" content="Fast plumbing"></head>
<body><nav><a href="/">Home</a><a href="/svc">Services</a></nav><h1>Fast Plumbers</h1>
<button>Call Now</button><form><input name="email"></form></body></html>`);
assert.strictEqual(s.title, 'Acme');
assert.strictEqual(s.metaDescription, 'Fast plumbing');
assert.deepStrictEqual(s.headings.h1, ['Fast Plumbers']);
assert.strictEqual(s.structure.formCount, 1);
ok('extractSummary pulls title/meta/h1/form');
assert.strictEqual(normalizeUrl('acme.com'), 'https://acme.com/');
assert.strictEqual(normalizeUrl('javascript:x'), null);
ok('normalizeUrl adds scheme, rejects non-http');

// claude helpers
assert.ok(extractHtml('```html\n<!DOCTYPE html><html><body>hi</body></html>\n```').startsWith('<!DOCTYPE html>'));
ok('extractHtml strips fences');
assert.deepStrictEqual(parseJson('noise {"ready":true,"issues":[]} tail'), { ready: true, issues: [] });
ok('parseJson tolerates surrounding prose');

// agents are non-empty verbatim prompts
for (const k of ['PROMPT_ENGINEER', 'WEBSITE_GENERATOR', 'DESIGN_ENHANCER', 'QA_AUDITOR', 'LIVE_CALL_ASSISTANT']) {
  assert.ok(typeof agents[k] === 'string' && agents[k].length > 200, `${k} present`);
}
ok('all 5 agent prompts present');

// every function endpoint imports without error
for (const f of ['prompt-engineer', 'website-generator', 'design-enhancer', 'qa-auditor', 'live-call-assistant']) {
  const mod = await import(`../functions/api/${f}.js`);
  assert.strictEqual(typeof mod.onRequestPost, 'function', `${f} exports onRequestPost`);
}
ok('all 5 endpoints import and export onRequestPost');

console.log(`\n${n} checks passed.`);
