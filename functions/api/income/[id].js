// DELETE /api/income/:id — remove one income entry (fix a mistake).

import { handle, json, HttpError } from '../../../lib/http.js';

export const onRequestDelete = handle(async ({ params, env }) => {
  if (!env.DB) throw new HttpError(500, 'Database is not configured.');
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'invalid id');
  await env.DB.prepare(`DELETE FROM income WHERE id = ?1`).bind(id).run();
  return json({ ok: true });
});
