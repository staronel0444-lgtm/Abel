// End-to-end checks against a running dev server. They need mock mode and a
// password, and they write to the local database:
//
//   .dev.vars:  MOCK_ANTHROPIC=1  MOCK_PLACES=1  FORGE_PASSWORD=correct-horse-battery
//   npm run db:schema:local && npm run dev        (in one terminal)
//   npm run test:api                              (in another)
//
// Never point BASE at production.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = new URL(process.env.BASE || 'http://127.0.0.1:8788');
const PASSWORD = process.env.FORGE_PASSWORD || 'correct-horse-battery';
const PUBLIC_HOST = 'forge.example.com'; // stands in for the real address

if (!['127.0.0.1', 'localhost'].includes(BASE.hostname)) {
  throw new Error('tests/api.test.mjs only runs against a local dev server');
}

// node:http rather than fetch, because these tests need to set the Host header.
function req(method, path, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      hostname: BASE.hostname, port: BASE.port, path, method,
      headers: {
        ...(host ? { Host: host } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let cookie = '';
let token = '';
const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
const authed = (extra = {}) => ({ Cookie: cookie, 'X-Forge-Token': token, ...extra });
const api = (method, path, body) => req(method, path, { body, headers: authed() });

test('sign in', async () => {
  const res = await req('POST', '/api/login', { body: { password: PASSWORD }, headers: { 'CF-Connecting-IP': ip } });
  assert.equal(res.status, 200, 'is the dev server running with FORGE_PASSWORD set?');
  cookie = String(res.headers['set-cookie'][0]).split(';')[0];
  const app = await req('GET', '/', { headers: { Cookie: cookie, 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' } });
  token = /name="forge-token" content="([^"]+)"/.exec(app.text)?.[1] || '';
  assert.ok(token, 'the app page carries a request token');
});

test('nothing but previews and the beacon is reachable without signing in', async () => {
  assert.equal((await req('GET', '/', { host: PUBLIC_HOST })).status, 401);
  assert.equal((await req('GET', '/api/clients', { host: PUBLIC_HOST })).status, 401);
  assert.equal((await req('POST', '/api/generate', { host: PUBLIC_HOST, body: { mode: 'page', prompt: 'x' } })).status, 401);
  assert.equal((await req('POST', '/api/leads/search', { host: PUBLIC_HOST, body: { zip: '01604', niche: 'plumber' } })).status, 401);
  assert.equal((await req('POST', '/api/previews', { host: PUBLIC_HOST, body: { kind: 'single', html: '<html></html>' } })).status, 401);
  assert.equal((await req('GET', '/api/pv?s=x', { host: PUBLIC_HOST })).status, 200);
  assert.equal((await req('GET', '/preview/zzzzzzzz', { host: PUBLIC_HOST })).status, 404);
});

test('the cookie alone is not enough for the API', async () => {
  assert.equal((await req('GET', '/api/clients', { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await api('GET', '/api/clients')).status, 200);
});

test('the request token is only handed to a page opened as a page', async () => {
  const asScript = await req('GET', '/', { headers: { Cookie: cookie, 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors' } });
  const asFrame = await req('GET', '/', { headers: { Cookie: cookie, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate' } });
  assert.equal(asScript.text.includes('forge-token'), false);
  assert.equal(asFrame.text.includes('forge-token'), false);
  assert.equal(asFrame.headers['x-frame-options'], 'DENY');
  assert.equal(asFrame.headers['cross-origin-opener-policy'], 'same-origin');
});

test('five wrong passwords lock that address out, even for the right one', async () => {
  const attacker = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const tryPw = (password) => req('POST', '/api/login', { body: { password }, headers: { 'CF-Connecting-IP': attacker } });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await tryPw(`wrong-${i}`)).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429, 429]);
  const locked = await tryPw(PASSWORD);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);
});

test('the visit counter cannot be made to write by a stranger', async () => {
  const before = (await api('GET', '/api/traffic')).json.sites.length;
  for (let i = 0; i < 10; i++) await req('GET', `/api/pv?s=made-up-site-${Date.now()}-${i}`);
  await req('GET', '/api/pv?s=%3Cscript%3Ealert(1)%3C/script%3E');
  assert.equal((await api('GET', '/api/traffic')).json.sites.length, before);
});

test('a site Forge built is counted once however fast it is hit, and not for the owner', async () => {
  const siteId = crypto.randomUUID();
  const gen = await api('POST', '/api/generate', { mode: 'page', prompt: 'A plumber in Worcester MA', siteId });
  assert.equal(gen.status, 200, gen.text.slice(0, 200));
  const views = async () => (await api('GET', '/api/traffic')).json.sites.find((s) => s.id === siteId)?.views;
  assert.equal(await views(), 0);
  for (let i = 0; i < 20; i++) await req('GET', `/api/pv?s=${siteId}&t=HACKED`);
  assert.equal(await views(), 1);
  await req('GET', `/api/pv?s=${siteId}`, { headers: { Cookie: cookie } });
  assert.equal(await views(), 1);
});

test('every generated page has a form handler, in preview mode until an email is set', async () => {
  const gen = await api('POST', '/api/generate', { mode: 'page', prompt: 'A plumber in Worcester MA' });
  assert.match(gen.json.html, /forge-forms-start--><script>\(function\(\)\{var TO="",/);
  const wired = await api('POST', '/api/rewire', { html: gen.json.html, notifyEmail: 'owner@example.com' });
  assert.match(wired.json.html, /var TO="owner@example\.com"/);
  assert.equal((wired.json.html.match(/forge-forms-start/g) || []).length, 1);
});

test('money follows the client it came from', async () => {
  const name = `Test Client ${Date.now()}`;
  const income = async () => (await api('GET', '/api/income')).json.entries.filter((e) => e.note.includes(name));
  const created = await api('POST', '/api/clients', { companyName: name, amountPaid: 500, monthlyFee: 40, closeDate: '2026-11-01', paymentMethod: 'cash' });
  const id = created.json.client.id;
  assert.equal((await income()).length, 1);

  await api('POST', `/api/clients/${id}/payments`, { month: '2026-11', method: 'cash', date: '2026-11-05' });
  await api('DELETE', `/api/clients/${id}/payments`, { month: '2026-11' });
  await api('POST', `/api/clients/${id}/payments`, { month: '2026-11', method: 'cash', date: '2026-11-05' });
  assert.equal((await income()).filter((e) => e.kind === 'monthly').length, 1, 'mark, unmark, mark logs one payment');

  await api('PUT', `/api/clients/${id}`, { amountPaid: 300 });
  assert.equal((await income()).find((e) => e.kind === 'upfront').amount, 300);

  const upfrontRow = (await income()).find((e) => e.kind === 'upfront');
  assert.equal((await api('DELETE', `/api/income/${upfrontRow.id}`)).status, 409);

  await api('DELETE', `/api/clients/${id}`);
  assert.equal((await income()).length, 0, 'deleting the client removes their money');
});

test('bad client details are refused', async () => {
  const post = (extra) => api('POST', '/api/clients', { companyName: 'Bad Co', closeDate: '2026-11-12', ...extra });
  assert.equal((await post({ closeDate: '2026-99-99' })).status, 400);
  assert.equal((await post({ email: 'not an email' })).status, 400);
  assert.equal((await post({ phone: 'call me maybe' })).status, 400);
});

test('"today" in revenue is one day, and tomorrow\'s sale is not in it', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const res = await api('GET', `/api/revenue?window=24h&today=${today}&tz=0`);
  assert.equal(res.json.from, today);
  assert.equal(res.json.to, today);
});

test('a saved link is updated in place, and a client domain shows it and nothing else', async () => {
  const gen = await api('POST', '/api/generate', { mode: 'page', prompt: 'Rays Collision in Millbury MA', siteId: crypto.randomUUID() });
  const saved = await api('POST', '/api/previews', { kind: 'single', html: gen.json.html });
  const id = saved.json.id;
  const host = `client-${Date.now()}.example.org`;

  assert.equal((await api('POST', '/api/domains', { host, previewId: id })).status, 409, 'a preview-mode form cannot go live');

  const wired = await api('POST', '/api/rewire', { html: gen.json.html, notifyEmail: 'ray@example.com' });
  const edited = wired.json.html.replace('</body>', '<p id="edit">now open Saturdays</p></body>');
  const put = await api('PUT', `/api/previews/${id}`, { kind: 'single', html: edited });
  assert.equal(put.json.url, saved.json.url, 'same address');
  assert.equal((await api('POST', '/api/domains', { host: `https://www.${host}/`, previewId: id })).status, 201);

  const live = await req('GET', '/', { host: `www.${host}` });
  assert.equal(live.status, 200);
  assert.match(live.text, /now open Saturdays/);
  assert.equal(live.headers['x-robots-tag'], undefined, 'a live site may be indexed');
  assert.equal((await req('GET', '/api/clients', { host })).status, 404);
  assert.equal((await req('GET', '/app.js', { host })).status, 404);
  assert.equal((await req('POST', '/api/login', { host, body: { password: PASSWORD } })).status, 405);

  await api('DELETE', `/api/domains/${host}`);
  await api('DELETE', `/api/previews/${id}`);
});

test('a demo files itself under Prospects once per business', async () => {
  const placeId = `ChIJtest${Date.now()}`;
  const first = await api('POST', '/api/prospects', { businessName: 'Tatnuck Heating', placeId, previewUrl: '/preview/aaaaaaaaaaaa' });
  const again = await api('POST', '/api/prospects', { businessName: 'Tatnuck Heating', placeId, previewUrl: '/preview/bbbbbbbbbbbb' });
  assert.equal(first.status, 201);
  assert.equal(again.json.existed, true);
  const mine = (await api('GET', '/api/prospects')).json.prospects.filter((p) => p.placeId === placeId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].previewUrl, '/preview/bbbbbbbbbbbb');
  await api('DELETE', `/api/prospects/${mine[0].id}`);
});
