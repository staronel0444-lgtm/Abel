// Pure-function tests. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeToken, verifyToken, requestTokenFor, passwordProblem, isLocalDev, SESSION_MS } from '../lib/auth.js';
import { cleanHost, isAppHost } from '../lib/domains.js';
import { wireForms, wireAnalytics } from '../lib/wire.js';
import { isDemoForm, insertBeforeBodyEnd } from '../lib/forminject.js';
import { siteIdFromHtml, SITE_ID_RE } from '../lib/analytics.js';
import { dailyGenerationLimit, placesMonthlyLimit, trustedDay } from '../lib/usage.js';
import { isRealDate, parseEmail, parsePhone } from '../functions/api/clients/index.js';

const PW = 'correct-horse-battery';
const DAY = 24 * 60 * 60 * 1000;
const page = (title = 'Ace') => `<!DOCTYPE html><html><head><title>${title}</title></head><body><form><input name="name"><button>Send</button></form></body></html>`;
const formScript = (html) => /<!--forge-forms-start--><script>([\s\S]*?)<\/script><!--forge-forms-end-->/.exec(html)[1];

test('a missing or short password is a problem; a long one is not', () => {
  assert.equal(passwordProblem(undefined), 'missing');
  assert.equal(passwordProblem(''), 'missing');
  assert.equal(passwordProblem('abc123'), 'short');
  assert.equal(passwordProblem(PW), null);
});

test('only localhost counts as a dev server', () => {
  assert.equal(isLocalDev(new URL('http://localhost:8788/')), true);
  assert.equal(isLocalDev(new URL('http://127.0.0.1:8788/')), true);
  assert.equal(isLocalDev(new URL('https://abel-6o9.pages.dev/')), false);
});

test('a session token works for 30 days and no longer', async () => {
  const now = Date.now();
  assert.equal(await verifyToken(PW, await makeToken(PW, now), now), true);
  assert.equal(await verifyToken(PW, await makeToken(PW, now - SESSION_MS + DAY), now), true);
  assert.equal(await verifyToken(PW, await makeToken(PW, now - SESSION_MS - DAY), now), false);
  assert.equal(await verifyToken(PW, await makeToken(PW, now + 2 * DAY), now), false);
  assert.equal(await verifyToken(PW, await makeToken('another-password', now), now), false);
  assert.equal(await verifyToken(PW, 'v1.notanumber.sig', now), false);
});

test('the request token is bound to the session', async () => {
  const a = await makeToken(PW, 1_700_000_000_000);
  const b = await makeToken(PW, 1_700_000_000_001);
  assert.equal(await requestTokenFor(PW, a), await requestTokenFor(PW, a));
  assert.notEqual(await requestTokenFor(PW, a), await requestTokenFor(PW, b));
});

test('client domains are cleaned, and the app\'s own addresses refused', () => {
  assert.equal(cleanHost('https://www.RaysCollision.com/contact'), 'rayscollision.com');
  assert.equal(cleanHost('shop.rays-collision.co.uk:443'), 'shop.rays-collision.co.uk');
  for (const bad of ['abel-6o9.pages.dev', 'localhost', 'x.workers.dev', 'not a domain', '192.168.1.1', '']) {
    assert.equal(cleanHost(bad), '', bad);
  }
  assert.equal(isAppHost('abel-6o9.pages.dev'), true);
  assert.equal(isAppHost('rayscollision.com'), false);
});

test('a form with no owner email is wired in preview mode, and switches to live', () => {
  const demo = wireForms(page(), '');
  assert.equal(isDemoForm(demo), true);
  const live = wireForms(demo, 'ray@example.com');
  assert.equal(isDemoForm(live), false);
  assert.equal((live.match(/forge-forms-start/g) || []).length, 1);
  assert.match(live, /var TO="ray@example\.com"/);
  assert.equal((live.match(/forge-guard-start/g) || []).length, 1);
});

test('nothing in a business name can break the injected script', () => {
  for (const name of ["A$AP Plumbing $& Heating $' Co", 'Ace </script><script>alert(1)</script>', 'Café Olé — Worcester', 'Quote "Bob" \\ Sons']) {
    const html = wireForms(page(name), 'ray@example.com');
    const js = formScript(html);
    assert.doesNotThrow(() => new Function(js), name);
    assert.equal(/[^\x00-\x7f]/.test(js), false, 'script is plain ASCII');
    assert.equal(js.includes('</script'), false);
  }
});

test('an address that is not an email is not written into a page', () => {
  assert.equal(isDemoForm(wireForms(page(), 'a@b.c</script><script>alert(1)</script>')), true);
  assert.equal(isDemoForm(wireForms(page(), 'not an email')), true);
});

test('blocks go before the real closing body tag', () => {
  const html = '<html><body><script>var s="</body>";</script><p>x</p></body></html>';
  assert.equal(insertBeforeBodyEnd(html, '<!--x-->').endsWith('<!--x--></body></html>'), true);
  assert.equal(insertBeforeBodyEnd('<p>no body tag</p>', '<!--x-->'), '<p>no body tag</p><!--x-->');
});

test('the visit beacon carries only ids Forge issues', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const html = wireAnalytics(page(), id, 'https://forge.example');
  assert.equal(siteIdFromHtml(html), id);
  assert.equal(wireAnalytics(page(), '"><script>', 'https://forge.example').includes('forge-analytics'), false);
  assert.equal(SITE_ID_RE.test('<script>alert(1)</script>'), false);
});

test('spending limits have defaults and ignore nonsense', () => {
  assert.equal(dailyGenerationLimit({}), 40);
  assert.equal(dailyGenerationLimit({ DAILY_GENERATION_LIMIT: '12' }), 12);
  assert.equal(dailyGenerationLimit({ DAILY_GENERATION_LIMIT: 'lots' }), 40);
  assert.equal(placesMonthlyLimit({}), 950);
  assert.equal(placesMonthlyLimit({ PLACES_MONTHLY_LIMIT: '-4' }), 950);
});

test('a caller cannot file a search under a far-off date', () => {
  const now = new Date('2026-11-12T03:00:00Z');
  assert.equal(trustedDay('2026-11-11', now), '2026-11-11');
  assert.equal(trustedDay('2031-01-01', now), '2026-11-12');
  assert.equal(trustedDay('garbage', now), '2026-11-12');
});

test('dates, emails and phone numbers are checked for real', () => {
  assert.equal(isRealDate('2026-11-12'), true);
  assert.equal(isRealDate('2026-99-99'), false);
  assert.equal(isRealDate('2026-02-30'), false);
  assert.equal(parseEmail(' dana@example.com '), 'dana@example.com');
  assert.equal(parseEmail(''), '');
  assert.throws(() => parseEmail('not an email'));
  assert.equal(parsePhone('(508) 555-0142'), '(508) 555-0142');
  assert.throws(() => parsePhone('call me maybe'));
});
