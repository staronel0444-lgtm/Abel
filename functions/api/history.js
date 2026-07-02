// GET /api/history — every business ever seen in Lead Finder, newest first,
// with its current status: 'client' | 'no' | 'undecided'. Never auto-clears.

import { handle, json } from '../../lib/http.js';

export const onRequestGet = handle(async ({ env }) => {
  const rows = await env.DB
    .prepare(
      `SELECT v.place_id, v.business_name, v.niche_searched, v.first_viewed_at,
              v.data_json, d.reason
       FROM view_history v
       LEFT JOIN dismissed_leads d ON d.place_id = v.place_id
       ORDER BY v.first_viewed_at DESC, v.business_name ASC`
    )
    .all();

  const entries = (rows.results || []).map((r) => {
    let lead = null;
    try {
      lead = JSON.parse(r.data_json);
    } catch {
      lead = null;
    }
    return {
      placeId: r.place_id,
      name: r.business_name,
      niche: r.niche_searched,
      firstViewedAt: r.first_viewed_at,
      status: r.reason === 'client' ? 'client' : r.reason === 'no' ? 'no' : 'undecided',
      lead,
    };
  });

  return json({ entries });
});
