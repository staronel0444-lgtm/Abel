// GET  /api/clients — all clients with their paid months.
// POST /api/clients — create a client (the Lead Finder "Yes" flow, or manual).
//   Body: { placeId?, companyName, ownerName?, phone?, email?, address?,
//           amountPaid?, monthlyFee?, closeDate }
//   Creating from a lead also writes a 'client' dismissal so the business
//   stops appearing in searches.

import { handle, json, readJson, requireString, HttpError } from '../../../lib/http.js';
import { ensureClientColumns } from '../../../lib/migrate.js';
import { logIncome, cleanMethod, cleanFee } from '../../../lib/income.js';

export function shapeClient(row, paidMonths = []) {
  return {
    id: row.id,
    placeId: row.place_id,
    companyName: row.company_name,
    ownerName: row.owner_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    amountPaid: row.amount_paid,
    monthlyFee: row.monthly_fee,
    closeDate: row.close_date,
    lastPaidMonth: row.last_paid_month,
    paymentMethod: row.payment_method || 'other',
    fee: row.fee || 0,
    status: row.status || 'active',
    createdAt: row.created_at,
    paidMonths,
  };
}

export function parseMoney(value, field) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) {
    throw new HttpError(400, `${field} must be a non-negative number`);
  }
  return Math.round(n * 100) / 100;
}

export function parseCloseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, 'closeDate must be a YYYY-MM-DD date');
  }
  return value;
}

export const onRequestGet = handle(async ({ env }) => {
  await ensureClientColumns(env.DB);
  const [clientRows, paymentRows] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM clients ORDER BY close_date DESC, id DESC'),
    env.DB.prepare('SELECT client_id, month FROM client_payments ORDER BY month ASC'),
  ]);

  const paymentsByClient = new Map();
  for (const p of paymentRows.results || []) {
    if (!paymentsByClient.has(p.client_id)) paymentsByClient.set(p.client_id, []);
    paymentsByClient.get(p.client_id).push(p.month);
  }

  const clients = (clientRows.results || []).map((row) =>
    shapeClient(row, paymentsByClient.get(row.id) || [])
  );
  return json({ clients });
});

export const onRequestPost = handle(async ({ request, env }) => {
  await ensureClientColumns(env.DB);

  const body = await readJson(request);
  const companyName = requireString(body, 'companyName', { max: 200 });
  const closeDate = parseCloseDate(body.closeDate);
  const amountPaid = parseMoney(body.amountPaid, 'amountPaid');
  const monthlyFee = parseMoney(body.monthlyFee, 'monthlyFee');
  const placeId = typeof body.placeId === 'string' && body.placeId.trim() ? body.placeId.trim() : null;
  const opt = (f, max = 300) => (typeof body[f] === 'string' ? body[f].trim().slice(0, max) : '');

  const paymentMethod = cleanMethod(body.paymentMethod);
  const upfrontFee = cleanFee(body.fee, amountPaid);

  const result = await env.DB
    .prepare(
      `INSERT INTO clients (place_id, company_name, owner_name, phone, email, address,
                            amount_paid, monthly_fee, close_date, payment_method, fee)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    )
    .bind(placeId, companyName, opt('ownerName'), opt('phone'), opt('email'), opt('address'),
      amountPaid, monthlyFee, closeDate, paymentMethod, upfrontFee)
    .run();

  const id = result.meta.last_row_id;

  // The upfront fee is real income too — log it so the tax split sees it.
  if (amountPaid > 0) {
    await logIncome(env.DB, {
      date: closeDate,
      amount: amountPaid,
      note: `${companyName} — upfront`,
      method: paymentMethod,
      fee: upfrontFee,
    });
  }

  if (placeId) {
    await env.DB
      .prepare(
        `INSERT INTO dismissed_leads (place_id, reason) VALUES (?1, 'client')
         ON CONFLICT(place_id) DO UPDATE SET reason = 'client', dismissed_at = datetime('now')`
      )
      .bind(placeId)
      .run();
  }

  const row = await env.DB.prepare('SELECT * FROM clients WHERE id = ?1').bind(id).first();
  return json({ client: shapeClient(row) }, 201);
});
