// GET    /api/previews/:id — the stored site content, for loading a saved
//        site back into the builder to edit it (single: html; multi: pages).
// PUT    /api/previews/:id — replace the content behind an existing link, so
//        the address an owner already has shows the change. Saving used to
//        mint a new link every time, which left the one he was sent showing
//        the old version for ever.
// DELETE /api/previews/:id — remove a preview link (they never expire on
//        their own; this is the manual kill switch).

import { handle, json, readJson, HttpError } from '../../../lib/http.js';
import { readSite, registerSavedSite } from './index.js';

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

export const onRequestPut = handle(async ({ request, env, params }) => {
  const id = validId(params);
  const existing = await env.DB.prepare('SELECT kind FROM previews WHERE preview_id = ?1').bind(id).first();
  if (!existing) throw new HttpError(404, 'Preview not found');

  const site = readSite(await readJson(request));
  // A one-page link and a multi-page link have different addresses
  // (/preview/x and /preview/x/), so one cannot turn into the other.
  if (site.kind !== existing.kind) {
    throw new HttpError(409, 'This link was saved as a different kind of site. Save a new link instead.');
  }
  await env.DB
    .prepare('UPDATE previews SET title = ?1, html_content = ?2 WHERE preview_id = ?3')
    .bind(site.title, site.content, id)
    .run();
  await registerSavedSite(env, site);

  return json({ id, url: site.kind === 'multi' ? `/preview/${id}/` : `/preview/${id}` });
});

export const onRequestDelete = handle(async ({ env, params }) => {
  const id = String(params.id || '');
  if (!/^[a-z0-9]{6,32}$/.test(id)) throw new HttpError(400, 'Invalid preview id');

  const result = await env.DB.prepare('DELETE FROM previews WHERE preview_id = ?1').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Preview not found');
  return json({ ok: true });
});
