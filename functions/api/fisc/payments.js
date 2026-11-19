// GET /api/fisc/payments?since=YYYY-MM-DD — client payments for Fisc, Abel's
// personal money app. Read-only: it never writes to the database.
//
// Answers [{ id, client_name, amount_cents, paid_on }] for every client upfront
// fee and monthly maintenance payment dated on or after `since`. Money typed in
// by hand on the Money tab is left out. amount_cents is what Forge actually got:
// the amount minus the processing fee.
//
// Fisc has no Forge login, so the middleware lets exactly GET on this path
// through, and this route checks its own secret instead: the X-Fisc-Token
// header must match the FISC_TOKEN secret (set in both projects). Missing or
// wrong token → 401. FISC_TOKEN not set → 503, so it never opens up.
//
// Ids are built from things that don't change, because income.id does: a month
// that is unmarked and marked again gets a new income row.
//   upfront-<client id>              the client's one upfront fee
//   monthly-<client id>-<YYYY-MM>    one month of maintenance

import { timingSafeEqual } from '../../../lib/auth.js';
import { isRealDate } from '../clients/index.js';

const MIN_TOKEN_LENGTH = 32;

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function sha256(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Hashing both sides first makes them the same length, so the comparison
// gives nothing away about the token's length either.
async function tokenMatches(given, expected) {
  return timingSafeEqual(await sha256(given), await sha256(expected));
}

export const onRequestGet = async ({ request, env }) => {
  const expected = env.FISC_TOKEN;
  if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) {
    return reply({ error: 'FISC_TOKEN is not set in Forge.' }, 503);
  }
  const given = request.headers.get('X-Fisc-Token') || '';
  if (!given || !(await tokenMatches(given, expected))) {
    return reply({ error: 'Wrong or missing X-Fisc-Token.' }, 401);
  }
  if (!env.DB) return reply({ error: 'Database is not configured.' }, 500);

  const since = new URL(request.url).searchParams.get('since') || '';
  if (!isRealDate(since)) return reply({ error: 'since must be a real date (YYYY-MM-DD).' }, 400);

  let rows;
  try {
    ({ results: rows } = await env.DB
      .prepare(
        `SELECT i.client_id, i.kind, i.month, i.date, i.amount, i.fee, c.company_name
         FROM income i JOIN clients c ON c.id = i.client_id
         WHERE i.kind IN ('upfront', 'monthly') AND i.date >= ?1
         ORDER BY i.date ASC, i.id ASC`
      )
      .bind(since)
      .all());
  } catch (err) {
    // A database that has never logged a client payment may not have these
    // tables or columns yet. That means no payments, not an error.
    if (/no such (table|column)/i.test(String(err && err.message))) return reply([]);
    console.error('fisc payments failed:', err && err.stack ? err.stack : err);
    return reply({ error: 'Something went wrong on the server. Try again.' }, 500);
  }

  const out = new Map();
  for (const r of rows || []) {
    if (r.kind === 'monthly' && !/^\d{4}-\d{2}$/.test(r.month || '')) continue;
    const id = r.kind === 'upfront' ? `upfront-${r.client_id}` : `monthly-${r.client_id}-${r.month}`;
    const cents = Math.round(((Number(r.amount) || 0) - (Number(r.fee) || 0)) * 100);
    if (cents <= 0 || out.has(id)) continue;
    out.set(id, { id, client_name: r.company_name, amount_cents: cents, paid_on: r.date });
  }
  return reply([...out.values()]);
};
