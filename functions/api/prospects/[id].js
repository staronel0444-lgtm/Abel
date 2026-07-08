// PUT    /api/prospects/:id — update a prospect (status, follow-up date, notes, etc.)
// DELETE /api/prospects/:id — remove a prospect permanently.

import { handle, json, readJson, HttpError } from '../../../lib/http.js';

const STATUSES = new Set(['new', 'contacted', 'follow_up', 'won', 'no']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const onRequestPut = handle(async ({ params, request, env }) => {
  if (!env.DB) throw new HttpError(500, 'Database is not configured.');
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'invalid id');

  const body = await readJson(request);
  const fields = [];
  const values = [];
  let i = 1;

  if (typeof body.businessName === 'string') {
    fields.push(`business_name = ?${i++}`);
    values.push(body.businessName.trim().slice(0, 200));
  }
  if (typeof body.niche === 'string') {
    fields.push(`niche = ?${i++}`);
    values.push(body.niche.trim().slice(0, 100));
  }
  if (typeof body.phone === 'string') {
    fields.push(`phone = ?${i++}`);
    values.push(body.phone.trim().slice(0, 40));
  }
  if (typeof body.notes === 'string') {
    fields.push(`notes = ?${i++}`);
    values.push(body.notes.trim().slice(0, 1000));
  }
  if (typeof body.status === 'string' && STATUSES.has(body.status)) {
    fields.push(`status = ?${i++}`);
    values.push(body.status);
  }
  if (body.followUpDate === null || DATE_RE.test(body.followUpDate || '')) {
    fields.push(`follow_up_date = ?${i++}`);
    values.push(body.followUpDate || null);
  }

  if (!fields.length) throw new HttpError(400, 'Nothing to update');
  fields.push(`updated_at = datetime('now')`);
  values.push(id);

  await env.DB.prepare(`UPDATE prospects SET ${fields.join(', ')} WHERE id = ?${i}`).bind(...values).run();
  return json({ ok: true });
});

export const onRequestDelete = handle(async ({ params, env }) => {
  if (!env.DB) throw new HttpError(500, 'Database is not configured.');
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'invalid id');
  await env.DB.prepare(`DELETE FROM prospects WHERE id = ?1`).bind(id).run();
  return json({ ok: true });
});
