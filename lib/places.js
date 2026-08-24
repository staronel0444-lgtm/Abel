// Google Places API (New) — Text Search, server-side only.
//
// One request per search (websiteUri is requested in the search call's own
// field mask — never a per-result Place Details call). If websiteUri is
// missing from a result, that business is a lead.
//
// Key setup: Google Cloud Console → enable "Places API (New)" → Credentials
// → create an API key → restrict it to Places API (New). Billing must be
// enabled even for the free monthly allotment. websiteUri sits in the
// Enterprise pricing tier (~$20 per 1,000 requests at low volume), which is
// why results are capped at 20 per search — one search, one billable call.

import { HttpError } from './http.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.types',
].join(',');

// Text Search caps a page at 20 results. `pageSize` replaced the older
// `maxResultCount`, which Google deprecated — an unknown field in the request
// body makes the API reject the whole call with a 400.
const MAX_RESULTS = 20;

export async function searchPlaces(env, { zip, niche }) {
  if (env.MOCK_PLACES === '1') return mockPlaces(zip, niche);

  if (!env.GOOGLE_PLACES_API_KEY) {
    throw new HttpError(500, 'GOOGLE_PLACES_API_KEY is not configured on the server. See README for setup.');
  }

  let res;
  try {
    res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: `${niche} near ${zip}`,
        pageSize: MAX_RESULTS,
      }),
    });
  } catch {
    throw new HttpError(502, 'Could not reach the Google Places API. Try again.');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Places API ${res.status}: ${body.slice(0, 500)}`);
    if (res.status === 403 || res.status === 401) {
      throw new HttpError(502, 'Google Places rejected the API key (check that "Places API (New)" is enabled and billing is on).');
    }
    // Google explains exactly what it disliked; passing that through turns an
    // opaque status code into something actually fixable.
    throw new HttpError(502, `Google Places API error (${res.status}): ${googleErrorMessage(body)}`);
  }

  const data = await res.json();
  return (data.places || []).slice(0, MAX_RESULTS).map(shapePlace);
}

// Google returns { error: { message, status, details } } on failure. Pull the
// human-readable line out of it, falling back to the raw body if the shape is
// something unexpected.
function googleErrorMessage(body) {
  try {
    const msg = JSON.parse(body)?.error?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 300);
  } catch {
    // Not JSON — fall through to the raw text.
  }
  const raw = String(body || '').trim();
  return raw ? raw.slice(0, 200) : 'no details returned. Try again.';
}

function shapePlace(p) {
  return {
    placeId: p.id,
    name: p.displayName?.text || 'Unknown business',
    address: p.formattedAddress || '',
    phone: p.nationalPhoneNumber || '',
    rating: typeof p.rating === 'number' ? p.rating : null,
    reviewCount: p.userRatingCount || 0,
    website: p.websiteUri || null,
    category: humanizeType((p.types || [])[0]),
    types: p.types || [],
  };
}

function humanizeType(type) {
  if (!type) return '';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Dev-only canned results (MOCK_PLACES=1): deterministic set with a mix of
// with-website and no-website businesses so the lead flow can be tested.
function mockPlaces(zip, niche) {
  const label = niche.replace(/\b\w/g, (c) => c.toUpperCase());
  const mk = (i, website) => ({
    placeId: `mock-${niche.replace(/\W+/g, '-').toLowerCase()}-${zip}-${i}`,
    name: `${['Ace', 'Summit', 'Riverside', 'Golden Hammer', 'Northside', 'Family', 'Rapid', 'Old Town'][i % 8]} ${label} ${i + 1}`,
    address: `${100 + i * 7} Main St, Springfield, ${zip}`,
    phone: `(555) 01${i}-${String(2300 + i * 13).padStart(4, '0')}`,
    rating: Math.round((3.4 + (i % 4) * 0.5) * 10) / 10,
    reviewCount: 5 + i * 17,
    website,
    category: label,
    types: [niche.replace(/\W+/g, '_').toLowerCase()],
  });
  const out = [];
  for (let i = 0; i < 9; i++) {
    out.push(mk(i, i % 3 === 0 ? `https://example.com/biz-${i}` : null));
  }
  return out;
}
