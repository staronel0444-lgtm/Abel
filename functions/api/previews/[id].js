// DELETE /api/previews/:id — remove a preview link (they never expire on
// their own; this is the manual kill switch).

import { handle, json, HttpError } from '../../../lib/http.js';

export const onRequestDelete = handle(async ({ env, params }) => {
  const id = String(params.id || '');
  if (!/^[a-z0-9]{6,32}$/.test(id)) throw new HttpError(400, 'Invalid preview id');

  const result = await env.DB.prepare('DELETE FROM previews WHERE preview_id = ?1').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Preview not found');
  return json({ ok: true });
});
