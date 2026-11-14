// GET  /api/previews — list saved previews (for copy-link / manual delete).
// POST /api/previews — save a generated site and mint a shareable URL.
//   Single page: { kind: "single", html, placeId? }            → /preview/<id>
//   Multi page:  { kind: "multi", pages: {"index.html": html, ...}, placeId? } → /preview/<id>/
//
// HTML is stored directly in D1 (pages are small; well under per-row limits).
// Links have no expiration — they stay live until deleted manually.

import { handle, json, readJson, HttpError } from '../../../lib/http.js';
import { randomId } from '../../../lib/id.js';
import { registerSite, siteIdFromHtml } from '../../../lib/analytics.js';

// Keep comfortably under D1's ~2MB per-value limit.
const MAX_CONTENT_BYTES = 1_800_000;

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? m[1].trim().slice(0, 200) : '';
}

export const onRequestGet = handle(async ({ env }) => {
  const rows = await env.DB
    .prepare(
      `SELECT preview_id, place_id, kind, title, created_at, LENGTH(html_content) AS size
       FROM previews ORDER BY created_at DESC, preview_id DESC LIMIT 200`
    )
    .all();

  const previews = (rows.results || []).map((r) => ({
    id: r.preview_id,
    placeId: r.place_id,
    kind: r.kind,
    title: r.title,
    createdAt: r.created_at,
    size: r.size,
    url: r.kind === 'multi' ? `/preview/${r.preview_id}/` : `/preview/${r.preview_id}`,
  }));
  return json({ previews });
});

// Validate a site sent for saving and turn it into what is stored. Shared by
// POST (a new link) and PUT /api/previews/:id (the same link, new content).
export function readSite(body) {
  const kind = body?.kind === 'multi' ? 'multi' : 'single';
  let content;
  let title;
  let home;

  if (kind === 'single') {
    if (typeof body.html !== 'string' || !/<html/i.test(body.html)) {
      throw new HttpError(400, 'html must be a complete HTML document');
    }
    content = body.html;
    home = body.html;
    title = extractTitle(body.html);
  } else {
    const pages = body.pages;
    if (!pages || typeof pages !== 'object' || Array.isArray(pages)) {
      throw new HttpError(400, 'pages must be an object of {"filename.html": html}');
    }
    const entries = Object.entries(pages);
    if (entries.length === 0 || entries.length > 12) {
      throw new HttpError(400, 'pages must contain 1-12 pages');
    }
    if (!pages['index.html']) {
      throw new HttpError(400, 'Multi-page previews need an index.html page');
    }
    for (const [filename, html] of entries) {
      if (!/^[a-z0-9-]+\.html$/i.test(filename) || typeof html !== 'string' || !/<html/i.test(html)) {
        throw new HttpError(400, `Invalid page: ${filename}`);
      }
    }
    content = JSON.stringify(pages);
    home = pages['index.html'];
    title = extractTitle(home);
  }

  // The limit is on bytes, and a page with accents or symbols has more bytes
  // than characters.
  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) {
    throw new HttpError(413, 'This site is too large to save as a link. Use fewer or smaller photos.');
  }
  return { kind, content, title, home };
}

// A saved site is one that is about to be sent to somebody, so make sure its
// visits can be counted — this also covers pages built before ids were
// registered at generation time.
export async function registerSavedSite(env, site) {
  try {
    await registerSite(env.DB, siteIdFromHtml(site.home), site.title);
  } catch {
    // Counting is a convenience; the link is what matters.
  }
}

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const placeId = typeof body.placeId === 'string' && body.placeId.trim() ? body.placeId.trim() : null;
  const site = readSite(body);

  const id = randomId(12);
  await env.DB
    .prepare(
      `INSERT INTO previews (preview_id, place_id, kind, title, html_content)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(id, placeId, site.kind, site.title, site.content)
    .run();
  await registerSavedSite(env, site);

  return json({ id, url: site.kind === 'multi' ? `/preview/${id}/` : `/preview/${id}` }, 201);
});
