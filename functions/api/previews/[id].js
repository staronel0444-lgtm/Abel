// GET    /api/previews/:id — the stored site content, for loading a saved
//        site back into the builder to edit it (single: html; multi: pages).
// DELETE /api/previews/:id — remove a preview link (they never expire on
//        their own; this is the manual kill switch).

import { handle, json, HttpError } from '../../../lib/http.js';

function validId(params) {
  const id = String(params.id || '');
  if (!/^[a-z0-9]{6,32}$/.test(id)) throw new HttpError(400, 'Invalid preview id');
  return id;
}

export const onRequestGet = handle(async ({ env, params }) => {
  const id = validId(params);
  const row = await env.DB
    .prepare('SELECT kind, title, html_content FROM previews WHERE preview_id = ?1')
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, 'Preview not found');

  if (row.kind === 'multi') {
    let pages;
    try {
      pages = JSON.parse(row.html_content);
    } catch {
      pages = {};
    }
    return json({ kind: 'multi', title: row.title, pages });
  }
  return json({ kind: 'single', title: row.title, html: row.html_content });
});

export const onRequestDelete = handle(async ({ env, params }) => {
  const id = String(params.id || '');
  if (!/^[a-z0-9]{6,32}$/.test(id)) throw new HttpError(400, 'Invalid preview id');

  const result = await env.DB.prepare('DELETE FROM previews WHERE preview_id = ?1').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Preview not found');
  return json({ ok: true });
});
