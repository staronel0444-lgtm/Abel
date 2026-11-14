// GET  /api/domains — every client domain and the saved site it shows.
// POST /api/domains — { host, previewId } put a saved site live on a domain.
//
// Recording the domain here is half of going live. The other half is done in
// Cloudflare: the domain has to be added to this Pages project under Custom
// domains, or requests for it never arrive.

import { handle, json, readJson, HttpError } from '../../../lib/http.js';
import { cleanHost, ensureDomains } from '../../../lib/domains.js';
import { isDemoForm } from '../../../lib/forminject.js';

export const onRequestGet = handle(async ({ env }) => {
  await ensureDomains(env.DB);
  const { results } = await env.DB
    .prepare(
      `SELECT d.host, d.preview_id AS previewId, d.created_at AS createdAt, p.title, p.kind
         FROM domains d LEFT JOIN previews p ON p.preview_id = d.preview_id
        ORDER BY d.created_at DESC`
    )
    .all();
  return json({ domains: results || [] });
});

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const host = cleanHost(body.host);
  if (!host) {
    throw new HttpError(400, 'Type the domain on its own, like rayscollision.com. A pages.dev address cannot be used.');
  }
  const previewId = String(body.previewId || '');
  if (!/^[a-z0-9]{6,32}$/.test(previewId)) throw new HttpError(400, 'Pick a saved site first.');

  const site = await env.DB
    .prepare('SELECT kind, html_content FROM previews WHERE preview_id = ?1')
    .bind(previewId)
    .first();
  if (!site) throw new HttpError(404, 'That saved site no longer exists.');

  // A live site whose form only says "this is a preview" loses every enquiry.
  if (isDemoForm(site.html_content) || (site.kind === 'multi' && /forge-forms-start--><script>\(function\(\)\{var TO=\\"\\",/.test(site.html_content))) {
    throw new HttpError(
      409,
      'This site\'s contact form is still in preview mode. Open it with Edit, type the owner\'s email, press Set email, then Update the link — and connect the domain after that.'
    );
  }

  await ensureDomains(env.DB);
  await env.DB
    .prepare(
      `INSERT INTO domains (host, preview_id) VALUES (?1, ?2)
       ON CONFLICT(host) DO UPDATE SET preview_id = excluded.preview_id`
    )
    .bind(host, previewId)
    .run();
  return json({ host, previewId }, 201);
});
