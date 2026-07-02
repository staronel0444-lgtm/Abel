// POST /api/leads/decision — { placeId, decision: "no" | "undecided" }
//
// "no"        → permanently dismiss (filtered from all future searches).
// "undecided" → undo a "no" (used from History to change a decision later).
// "yes" is not handled here — converting a lead to a client goes through
// POST /api/clients, which also writes the 'client' dismissal.

import { handle, json, readJson, requireString, HttpError } from '../../../lib/http.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const placeId = requireString(body, 'placeId', { max: 300 });
  const decision = requireString(body, 'decision', { max: 20 });

  if (decision !== 'no' && decision !== 'undecided') {
    throw new HttpError(400, 'decision must be "no" or "undecided"');
  }

  const existing = await env.DB
    .prepare('SELECT reason FROM dismissed_leads WHERE place_id = ?1')
    .bind(placeId)
    .first();

  if (existing?.reason === 'client') {
    throw new HttpError(409, 'This business is a client. Manage it from the Clients tab instead.');
  }

  if (decision === 'no') {
    await env.DB
      .prepare(
        `INSERT INTO dismissed_leads (place_id, reason) VALUES (?1, 'no')
         ON CONFLICT(place_id) DO UPDATE SET reason = 'no', dismissed_at = datetime('now')`
      )
      .bind(placeId)
      .run();
  } else {
    await env.DB
      .prepare(`DELETE FROM dismissed_leads WHERE place_id = ?1 AND reason = 'no'`)
      .bind(placeId)
      .run();
  }

  return json({ ok: true, placeId, status: decision });
});
