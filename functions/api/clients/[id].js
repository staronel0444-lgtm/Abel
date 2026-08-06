// PUT    /api/clients/:id — edit any client field (fees change, contacts change).
// DELETE /api/clients/:id — remove the record entirely (deal fell through).
//   Deleting also removes the 'client' dismissal, so the business can show
//   up in Lead Finder searches again.

import { handle, json, readJson, HttpError } from '../../../lib/http.js';
import { ensureClientColumns } from '../../../lib/migrate.js';
import { shapeClient, parseMoney, parseCloseDate } from './index.js';

const STATUSES = new Set(['active', 'ended']);

function parseId(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid client id');
  return id;
}

async function getClient(env, id) {
  const row = await env.DB.prepare('SELECT * FROM clients WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'Client not found');
  return row;
}

export const onRequestPut = handle(async ({ request, env, params }) => {
  const id = parseId(params);
  await ensureClientColumns(env.DB);
  await getClient(env, id);
  const body = await readJson(request);

  const updates = {};
  const strFields = { companyName: 'company_name', ownerName: 'owner_name', phone: 'phone', email: 'email', address: 'address' };
  for (const [field, column] of Object.entries(strFields)) {
    if (body[field] !== undefined) {
      const v = String(body[field]).trim().slice(0, 300);
      if (field === 'companyName' && !v) throw new HttpError(400, 'companyName cannot be empty');
      updates[column] = v;
    }
  }
  if (body.amountPaid !== undefined) updates.amount_paid = parseMoney(body.amountPaid, 'amountPaid');
  if (body.monthlyFee !== undefined) updates.monthly_fee = parseMoney(body.monthlyFee, 'monthlyFee');
  if (body.closeDate !== undefined) updates.close_date = parseCloseDate(body.closeDate);
  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) throw new HttpError(400, 'status must be "active" or "ended"');
    updates.status = body.status;
  }

  const columns = Object.keys(updates);
  if (columns.length === 0) throw new HttpError(400, 'No fields to update');

  const setClause = columns.map((c, i) => `${c} = ?${i + 1}`).join(', ');
  await env.DB
    .prepare(`UPDATE clients SET ${setClause} WHERE id = ?${columns.length + 1}`)
    .bind(...columns.map((c) => updates[c]), id)
    .run();

  const row = await getClient(env, id);
  const payments = await env.DB
    .prepare('SELECT month FROM client_payments WHERE client_id = ?1 ORDER BY month ASC')
    .bind(id)
    .all();
  return json({ client: shapeClient(row, (payments.results || []).map((p) => p.month)) });
});

export const onRequestDelete = handle(async ({ env, params }) => {
  const id = parseId(params);
  const row = await getClient(env, id);

  const stmts = [
    env.DB.prepare('DELETE FROM client_payments WHERE client_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM clients WHERE id = ?1').bind(id),
  ];
  if (row.place_id) {
    stmts.push(
      env.DB
        .prepare(`DELETE FROM dismissed_leads WHERE place_id = ?1 AND reason = 'client'`)
        .bind(row.place_id)
    );
  }
  await env.DB.batch(stmts);

  return json({ ok: true });
});
