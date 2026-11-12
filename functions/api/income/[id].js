// DELETE /api/income/:id — remove one hand-typed income entry (fix a mistake).
// An entry that came from a client payment is removed where it was made — by
// unmarking the month or editing the client — so the Clients tab, Revenue and
// Money can never disagree about it.

import { handle, json, HttpError } from '../../../lib/http.js';
import { ensureIncomeTable } from '../../../lib/income.js';

export const onRequestDelete = handle(async ({ params, env }) => {
  if (!env.DB) throw new HttpError(500, 'Database is not configured.');
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'invalid id');
  await ensureIncomeTable(env.DB);
  const row = await env.DB.prepare('SELECT client_id, kind FROM income WHERE id = ?1').bind(id).first();
  if (row && row.client_id) {
    throw new HttpError(
      409,
      row.kind === 'monthly'
        ? 'This came from a client payment. Unmark that month in the Clients tab instead.'
        : 'This is a client\'s upfront payment. Change the amount on the client in the Clients tab instead.'
    );
  }
  await env.DB.prepare(`DELETE FROM income WHERE id = ?1`).bind(id).run();
  return json({ ok: true });
});
