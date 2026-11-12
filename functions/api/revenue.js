// GET /api/revenue?window=24h|week|month|6months|year|all&today=YYYY-MM-DD&tz=<minutes>
//
// Total revenue for the window plus a breakdown:
//   upfront — clients.amount_paid, counted once per client, on its close date.
//   monthly — client_payments.amount, once per (client, month) marked paid, on
//             the day it was marked.
// Also returns the prior equivalent period for the trend indicator.
//
// Windows are whole calendar days in the user's own timezone. `today` is the
// browser's local date and `tz` its offset from UTC in minutes (-300 for
// Eastern Standard Time). A window of N days is today and the N-1 days before
// it, and the prior period is the N days before that, so the two are always
// the same length. The earlier version compared "date >= 24 hours ago", which
// counted two calendar days against one and reported a trend that was not
// there, and had no upper bound, so a sale dated next year counted as today's.

import { handle, json, HttpError } from '../../lib/http.js';
import { ensureClientColumns } from '../../lib/migrate.js';
import { trustedDay } from '../../lib/usage.js';

const WINDOW_DAYS = {
  '24h': 1,
  week: 7,
  month: 30,
  '6months': 182,
  year: 365,
  all: null,
};

// Both bounds are inclusive YYYY-MM-DD dates; either may be omitted.
async function sums(env, { from, to, tzModifier }) {
  const conds = (column) => {
    const parts = [];
    const binds = [];
    if (from) { parts.push(`${column} >= ?${binds.length + 1}`); binds.push(from); }
    if (to) { parts.push(`${column} <= ?${binds.length + 1}`); binds.push(to); }
    return { where: parts.length ? ' WHERE ' + parts.join(' AND ') : '', binds };
  };

  // close_date is already a local calendar date. paid_at is a UTC timestamp,
  // so it is shifted into the user's timezone before its date is taken.
  const upfront = conds('close_date');
  const paidLocal = `date(paid_at, '${tzModifier}')`;
  const monthly = conds(paidLocal);

  const [upfrontRow, monthlyRow] = await env.DB.batch([
    env.DB
      .prepare('SELECT COALESCE(SUM(amount_paid), 0) AS total, COALESCE(SUM(fee), 0) AS fees FROM clients' + upfront.where)
      .bind(...upfront.binds),
    env.DB
      .prepare('SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(fee), 0) AS fees FROM client_payments' + monthly.where)
      .bind(...monthly.binds),
  ]);

  const up = upfrontRow.results?.[0]?.total || 0;
  const mo = monthlyRow.results?.[0]?.total || 0;
  const fees = (upfrontRow.results?.[0]?.fees || 0) + (monthlyRow.results?.[0]?.fees || 0);
  const total = up + mo;
  // `total` stays the sticker price so the trend compares like with like;
  // `net` is what actually reached the bank after processing fees.
  return { upfront: up, monthly: mo, total, fees, net: total - fees };
}

function shiftDay(day, delta) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export const onRequestGet = handle(async ({ request, env }) => {
  const url = new URL(request.url);
  const window = url.searchParams.get('window') || 'month';
  if (!(window in WINDOW_DAYS)) {
    throw new HttpError(400, `window must be one of: ${Object.keys(WINDOW_DAYS).join(', ')}`);
  }

  // The offset becomes part of the SQL text, so it is forced to a plain whole
  // number of minutes inside the range real timezones occupy.
  const tzRaw = Number.parseInt(url.searchParams.get('tz') || '0', 10);
  const tz = Number.isFinite(tzRaw) && tzRaw >= -840 && tzRaw <= 840 ? tzRaw : 0;
  const tzModifier = `${tz >= 0 ? '+' : '-'}${Math.abs(tz)} minutes`;
  const today = trustedDay(url.searchParams.get('today'));

  await ensureClientColumns(env.DB);
  const days = WINDOW_DAYS[window];

  if (days === null) {
    const current = await sums(env, { to: today, tzModifier });
    return json({ window, ...current, prior: null, trendPct: null, from: null, to: today });
  }

  const from = shiftDay(today, -(days - 1));
  const current = await sums(env, { from, to: today, tzModifier });
  const prior = await sums(env, { from: shiftDay(from, -days), to: shiftDay(from, -1), tzModifier });

  const trendPct =
    prior.total > 0 ? Math.round(((current.total - prior.total) / prior.total) * 100) : null;

  return json({ window, ...current, prior, trendPct, from, to: today });
});
