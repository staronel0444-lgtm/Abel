// GET /api/traffic — the Traffic tab's data: every site's visit count.

import { handle, json } from '../../lib/http.js';

export const onRequestGet = handle(async ({ env }) => {
  if (!env.DB) return json({ sites: [], total: 0 });
  const { results } = await env.DB.prepare(
    `SELECT site_id AS id, label, views, created_at AS createdAt, updated_at AS updatedAt
       FROM site_views
      ORDER BY views DESC, updated_at DESC
      LIMIT 200`
  ).all();
  const sites = results || [];
  const total = sites.reduce((sum, s) => sum + (Number(s.views) || 0), 0);
  return json({ sites, total });
});
