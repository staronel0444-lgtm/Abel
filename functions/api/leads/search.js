// POST /api/leads/search — { zip, niche }
//
// Calls Google Places (New) Text Search server-side, logs EVERY returned
// business into view_history (dismissed or not), filters dismissed place IDs
// ('no' leads and existing clients) out of the active results, and returns
// shaped lead objects (businesses with no listed website).

import { handle, json, readJson, requireString } from '../../../lib/http.js';
import { searchPlaces } from '../../../lib/places.js';
import { cleanDay, recordSearch, readUsage } from '../../../lib/usage.js';

// Optional lead-quality filters: only reads a number out of a request field
// if it's a finite value within a sane range, otherwise treats it as unset.
function optionalNumber(body, field, { min, max }) {
  const raw = body?.[field];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const zip = requireString(body, 'zip', { max: 120 });
  const niche = requireString(body, 'niche', { max: 80 });
  const minRating = optionalNumber(body, 'minRating', { min: 0, max: 5 });
  const minReviews = optionalNumber(body, 'minReviews', { min: 0, max: 1000000 });

  const places = await searchPlaces(env, { zip, niche });

  // The Google call succeeded, so it counted against the free tier whether or
  // not it found anything. Counting must never break the search itself.
  const day = cleanDay(body.day);
  let usage = null;
  try {
    await recordSearch(env.DB, day);
    usage = await readUsage(env.DB, day);
  } catch {
    // Usage tracking is a convenience, not part of the result.
  }

  if (places.length === 0) {
    return json({ leads: [], stats: { total: 0, withWebsite: 0, dismissed: 0, belowThreshold: 0 }, usage });
  }

  // Log every result to view history. Keep the original first_viewed_at on
  // repeat sightings, but refresh the business data snapshot.
  await env.DB.batch(
    places.map((p) =>
      env.DB
        .prepare(
          `INSERT INTO view_history (place_id, business_name, niche_searched, data_json)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(place_id) DO UPDATE SET
             business_name = excluded.business_name,
             data_json = excluded.data_json`
        )
        .bind(p.placeId, p.name, niche, JSON.stringify(p))
    )
  );

  // Filter out dismissed IDs — both "No" leads and converted clients —
  // regardless of which zip/niche they were originally found under.
  const placeholders = places.map((_, i) => `?${i + 1}`).join(',');
  const dismissedRows = await env.DB
    .prepare(`SELECT place_id FROM dismissed_leads WHERE place_id IN (${placeholders})`)
    .bind(...places.map((p) => p.placeId))
    .all();
  const dismissed = new Set((dismissedRows.results || []).map((r) => r.place_id));

  const withWebsite = places.filter((p) => p.website).length;
  const meetsThreshold = (p) =>
    (minRating === null || (typeof p.rating === 'number' && p.rating >= minRating)) &&
    (minReviews === null || (p.reviewCount || 0) >= minReviews);

  const undecidedNoWebsite = places.filter((p) => !p.website && !dismissed.has(p.placeId));
  const leads = undecidedNoWebsite.filter(meetsThreshold);
  const dismissedCount = places.filter((p) => !p.website && dismissed.has(p.placeId)).length;
  const belowThreshold = undecidedNoWebsite.length - leads.length;

  return json({
    leads,
    stats: { total: places.length, withWebsite, dismissed: dismissedCount, belowThreshold },
    usage,
  });
});
