// GET /api/revenue?window=24h|week|month|6months|year|all
//
// Total revenue for the window plus a breakdown:
//   upfront — clients.amount_paid, counted once per client, included when
//             close_date falls inside the window.
//   monthly — client_payments.amount summed once per (client, month) marked
//             paid, included when the payment was collected (paid_at) inside
//             the window. Using the collected timestamp keeps short windows
//             (24h/week) meaningful.
// Also returns the prior equivalent period for the trend indicator.

import { handle, json, HttpError } from '../../lib/http.js';
import { ensureClientColumns } from '../../lib/migrate.js';

const WINDOW_DAYS = {
  '24h': 1,
  week: 7,
  month: 30,
  '6months': 182,
  year: 365,
  all: null,
};

async function sums(env, { fromIso, toIso, fromDate, toDate }) {
  // Upfront: close_date is a YYYY-MM-DD string, compared against date bounds.
  let upfrontSql = 'SELECT COALESCE(SUM(amount_paid), 0) AS total, COALESCE(SUM(fee), 0) AS fees FROM clients';
  const upfrontBinds = [];
  const upfrontConds = [];
  if (fromDate) { upfrontConds.push(`close_date >= ?${upfrontBinds.length + 1}`); upfrontBinds.push(fromDate); }
  if (toDate) { upfrontConds.push(`close_date < ?${upfrontBinds.length + 1}`); upfrontBinds.push(toDate); }
  if (upfrontConds.length) upfrontSql += ' WHERE ' + upfrontConds.join(' AND ');

  // Monthly: paid_at is a full datetime.
  let monthlySql = 'SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(fee), 0) AS fees FROM client_payments';
  const monthlyBinds = [];
  const monthlyConds = [];
  if (fromIso) { monthlyConds.push(`paid_at >= ?${monthlyBinds.length + 1}`); monthlyBinds.push(fromIso); }
  if (toIso) { monthlyConds.push(`paid_at < ?${monthlyBinds.length + 1}`); monthlyBinds.push(toIso); }
  if (monthlyConds.length) monthlySql += ' WHERE ' + monthlyConds.join(' AND ');

  const [upfrontRow, monthlyRow] = await env.DB.batch([
    env.DB.prepare(upfrontSql).bind(...upfrontBinds),
    env.DB.prepare(monthlySql).bind(...monthlyBinds),
  ]);

  const upfront = upfrontRow.results?.[0]?.total || 0;
  const monthly = monthlyRow.results?.[0]?.total || 0;
  const fees = (upfrontRow.results?.[0]?.fees || 0) + (monthlyRow.results?.[0]?.fees || 0);
  const total = upfront + monthly;
  // `total` stays the sticker price so the trend compares like with like;
  // `net` is what actually reached the bank after processing fees.
  return { upfront, monthly, total, fees, net: total - fees };
}

// D1's datetime('now') default stores "YYYY-MM-DD HH:MM:SS" (space, no Z);
// format our bounds the same way so string comparison is correct.
function sqlDatetime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export const onRequestGet = handle(async ({ request, env }) => {
  const url = new URL(request.url);
  const window = url.searchParams.get('window') || 'month';
  if (!(window in WINDOW_DAYS)) {
    throw new HttpError(400, `window must be one of: ${Object.keys(WINDOW_DAYS).join(', ')}`);
  }

  await ensureClientColumns(env.DB);
  const days = WINDOW_DAYS[window];

  if (days === null) {
    const current = await sums(env, {});
    return json({ window, ...current, prior: null, trendPct: null });
  }

  const now = new Date();
  const start = new Date(now.getTime() - days * 86400000);
  const priorStart = new Date(now.getTime() - 2 * days * 86400000);

  const current = await sums(env, {
    fromIso: sqlDatetime(start),
    fromDate: start.toISOString().slice(0, 10),
  });
  const prior = await sums(env, {
    fromIso: sqlDatetime(priorStart),
    toIso: sqlDatetime(start),
    fromDate: priorStart.toISOString().slice(0, 10),
    toDate: start.toISOString().slice(0, 10),
  });

  const trendPct =
    prior.total > 0 ? Math.round(((current.total - prior.total) / prior.total) * 100) : null;

  return json({ window, ...current, prior, trendPct });
});
