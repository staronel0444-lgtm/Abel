// POST   /api/clients/:id/payments — { month?, method?, fee?, date? } mark a
//        month's maintenance fee collected (defaults to the current month).
//        The amount is snapshotted from the client's current monthly_fee.
// DELETE /api/clients/:id/payments — { month } unmark (fixes mistakes).
//
// client_payments is the source of truth for both the due list and the Revenue
// Dashboard's monthly sums; clients.last_paid_month is kept in sync as a
// denormalized convenience.
//
// Marking a month paid ALSO writes the money to the Money tab's income log, so
// the Taxes/Forge/Save/You split accounts for recurring revenue. Before this,
// maintenance fees were invisible to the tax set-aside — with 20 clients that
// was $1,000/month the tax bucket never saw.

import { handle, json, readJson, HttpError } from '../../../../lib/http.js';
import { ensureClientColumns } from '../../../../lib/migrate.js';
import { logIncome, cleanMethod, cleanFee } from '../../../../lib/income.js';

function parseId(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid client id');
  return id;
}

// UTC is fine as a fallback only — the app sends the month it means, worked
// out in the user's own timezone, so this is never what decides the answer.
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function parseMonth(value) {
  if (value === undefined || value === null || value === '') return currentMonth();
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new HttpError(400, 'month must be formatted YYYY-MM');
  }
  return value;
}

function parseDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date().toISOString().slice(0, 10);
}

async function syncLastPaidMonth(env, id) {
  await env.DB
    .prepare(
      `UPDATE clients
       SET last_paid_month = (SELECT MAX(month) FROM client_payments WHERE client_id = ?1)
       WHERE id = ?1`
    )
    .bind(id)
    .run();
}

async function paidMonths(env, id) {
  const rows = await env.DB
    .prepare('SELECT month FROM client_payments WHERE client_id = ?1 ORDER BY month ASC')
    .bind(id)
    .all();
  return (rows.results || []).map((r) => r.month);
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[m - 1]} ${y}`;
}

export const onRequestPost = handle(async ({ request, env, params }) => {
  const id = parseId(params);
  await ensureClientColumns(env.DB);

  const body = await readJson(request).catch(() => ({}));
  const month = parseMonth(body.month);

  const client = await env.DB
    .prepare('SELECT id, company_name, monthly_fee FROM clients WHERE id = ?1')
    .bind(id)
    .first();
  if (!client) throw new HttpError(404, 'Client not found');

  const amount = client.monthly_fee;
  const method = cleanMethod(body.method);
  const fee = cleanFee(body.fee, amount);

  const res = await env.DB
    .prepare(
      `INSERT INTO client_payments (client_id, month, amount, payment_method, fee)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(client_id, month) DO NOTHING`
    )
    .bind(id, month, amount, method, fee)
    .run();

  // Only log income when the payment is genuinely new — re-marking an already
  // paid month must not double up the Money calendar.
  const isNew = (res.meta?.changes ?? 0) > 0;
  if (isNew && amount > 0) {
    await logIncome(env.DB, {
      date: parseDate(body.date),
      amount,
      note: `${client.company_name} — ${monthLabel(month)} maintenance`,
      method,
      fee,
    });
  }

  await syncLastPaidMonth(env, id);

  return json({ ok: true, month, logged: isNew, paidMonths: await paidMonths(env, id) });
});

export const onRequestDelete = handle(async ({ request, env, params }) => {
  const id = parseId(params);
  const body = await readJson(request);
  const month = parseMonth(body.month);

  await env.DB
    .prepare('DELETE FROM client_payments WHERE client_id = ?1 AND month = ?2')
    .bind(id, month)
    .run();
  await syncLastPaidMonth(env, id);

  return json({ ok: true, month, paidMonths: await paidMonths(env, id) });
});
