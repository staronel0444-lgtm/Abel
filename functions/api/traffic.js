// GET /api/traffic — the Traffic tab's data: every site's visit count.

import { handle, json } from '../../lib/http.js';
import { ENSURE_SITE_VIEWS } from '../../lib/analytics.js';


export const onRequestGet = handle(async ({ env }) => {
  if (!env.DB) return json({ sites: [], total: 0 });
  try {
    // Self-provision the table so the feature works with no manual DB step.
    await env.DB.prepare(ENSURE_SITE_VIEWS).run();
    const { results } = await env.DB.prepare(
      `SELECT site_id AS id, label, views, created_at AS createdAt, updated_at AS updatedAt
         FROM site_views
        ORDER BY views DESC, updated_at DESC
        LIMIT 200`
    ).all();
    const sites = results || [];
    const total = sites.reduce((sum, s) => sum + (Number(s.views) || 0), 0);
    return json({ sites, total });
  } catch (err) {
    // Never surface a scary 500 here — worst case, show an empty Traffic tab.
    return json({ sites: [], total: 0 });
  }
});
