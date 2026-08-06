// GET  /api/income — list every income entry (for the Money calendar).
// POST /api/income — add an entry { date: "YYYY-MM-DD", amount, note?, method?, fee? }.
//
// The `income` table is created on demand so the feature works with no manual
// database setup.
//
// `amount` is the sticker price and `fee` is what the payment platform took
// off it. The client works the fee out from `method` and sends both, so the
// stored row keeps the fee that was actually charged even if a platform
// changes its rates later.

import { handle, json, readJson, HttpError } from '../../../lib/http.js';
import { ensureIncomeTable, logIncome, cleanMethod, cleanFee } from '../../../lib/income.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const onRequestGet = handle(async ({ env }) => {
  if (!env.DB) return json({ entries: [] });
  await ensureIncomeTable(env.DB);
  const { results } = await env.DB
    .prepare(
      `SELECT id, date, amount, note, method, fee, created_at AS createdAt
       FROM income ORDER BY date ASC, id ASC`
    )
    .all();
  return json({ entries: results || [] });
});

export const onRequestPost = handle(async ({ request, env }) => {
  if (!env.DB) throw new HttpError(500, 'Database is not configured.');

  const body = await readJson(request);
  const date = String(body.date || '').trim();
  if (!DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'amount must be a positive number');

  const note = String(body.note || '').trim().slice(0, 200);
  const method = cleanMethod(body.method);
  const fee = cleanFee(body.fee, amount);

  const id = await logIncome(env.DB, { date, amount, note, method, fee });
  return json({ entry: { id, date, amount, note, method, fee } }, 201);
});
