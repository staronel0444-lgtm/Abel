// POST   /api/clients/:id/payments — { month? } mark a month's maintenance
//        fee collected (defaults to the current month). The amount is
//        snapshotted from the client's current monthly_fee.
// DELETE /api/clients/:id/payments — { month } unmark (fixes mistakes).
//
// client_payments is the source of truth for both the due-this-month list
// and the Revenue Dashboard's monthly sums; clients.last_paid_month is kept
// in sync as a denormalized convenience.

import { handle, json, readJson, HttpError } from '../../../../lib/http.js';

function parseId(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid client id');
  return id;
}

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

export const onRequestPost = handle(async ({ request, env, params }) => {
  const id = parseId(params);
  const body = await readJson(request).catch(() => ({}));
  const month = parseMonth(body.month);

  const client = await env.DB.prepare('SELECT id, monthly_fee FROM clients WHERE id = ?1').bind(id).first();
  if (!client) throw new HttpError(404, 'Client not found');

  await env.DB
    .prepare(
      `INSERT INTO client_payments (client_id, month, amount) VALUES (?1, ?2, ?3)
       ON CONFLICT(client_id, month) DO NOTHING`
    )
    .bind(id, month, client.monthly_fee)
    .run();
  await syncLastPaidMonth(env, id);

  return json({ ok: true, month, paidMonths: await paidMonths(env, id) });
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
