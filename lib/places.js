// Google Places API (New) — Text Search, server-side only.
//
// One request per search (websiteUri is requested in the search call's own
// field mask — never a per-result Place Details call). If websiteUri is
// missing from a result, that business is a lead.
//
// Key setup: Google Cloud Console → enable "Places API (New)" → Credentials
// → create an API key → restrict it to Places API (New). Billing must be
// enabled even for the free monthly allotment. websiteUri sits in the
// Enterprise pricing tier, which is why results are capped at 20 per search
// — one search, one billable call.
//
// Hours and reviews are requested in that SAME call. They are not extra
// requests: a field mask is free to widen, and Enterprise and Enterprise +
// Atmosphere both come with 1,000 free calls a month, so at Forge's volume
// the richer mask costs nothing. They matter because the generator is
// forbidden from inventing testimonials or hours — without real ones it
// leaves those sections out, and the site is weaker for it.

import { HttpError } from './http.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

const BASE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.types',
  'places.primaryTypeDisplayName',
];

// Requested on top of the base set. Split out because Google decides per-SKU
// which of these Text Search will serve, and an unknown entry in a field mask
// makes it reject the whole call with a 400 — which is exactly how Lead Finder
// broke once before. If that happens we drop these and carry on, so a field
// Google won't serve degrades into a thinner site instead of a dead search.
const RICH_FIELDS = [
  'places.regularOpeningHours',
  'places.reviews',
];

// Flips to false for the life of the isolate the first time Google rejects the
// rich mask, so the retry happens once rather than on every search.
let richFieldsOk = true;

function fieldMask(rich) {
  return (rich ? BASE_FIELDS.concat(RICH_FIELDS) : BASE_FIELDS).join(',');
}

function isFieldMaskError(status, body) {
  if (status !== 400) return false;
  return /field\s*mask|unknown field|invalid.*field|cannot be empty/i.test(String(body || ''));
}

// Text Search caps a page at 20 results. `pageSize` replaced the older
// `maxResultCount`, which Google deprecated — an unknown field in the request
// body makes the API reject the whole call with a 400.
const MAX_RESULTS = 20;

export async function searchPlaces(env, { zip, niche }) {
  if (env.MOCK_PLACES === '1') return mockPlaces(zip, niche);

  if (!env.GOOGLE_PLACES_API_KEY) {
    throw new HttpError(500, 'GOOGLE_PLACES_API_KEY is not configured on the server. See README for setup.');
  }

  let res = await callSearch(env, zip, niche, richFieldsOk);

  // A rejected request isn't a billable search, so the one-time fallback below
  // doesn't cost a call against the monthly allotment.
  if (!res.ok && richFieldsOk) {
    const peek = await res.clone().text().catch(() => '');
    if (isFieldMaskError(res.status, peek)) {
      console.warn('Places rejected the rich field mask; falling back to base fields.');
      richFieldsOk = false;
      res = await callSearch(env, zip, niche, false);
    }
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

async function callSearch(env, zip, niche, rich) {
  try {
    return await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': fieldMask(rich),
      },
      body: JSON.stringify({
        textQuery: `${niche} near ${zip}`,
        pageSize: MAX_RESULTS,
      }),
    });
  } catch {
    throw new HttpError(502, 'Could not reach the Google Places API. Try again.');
  }
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
    category: p.primaryTypeDisplayName?.text || humanizeType((p.types || [])[0]),
    types: p.types || [],
    hours: shapeHours(p.regularOpeningHours),
    reviews: shapeReviews(p.reviews),
  };
}

// "Mon: 8:00 AM – 5:00 PM" lines, exactly as Google words them. Passed through
// verbatim so the generated page states real hours or none at all.
function shapeHours(h) {
  const d = h?.weekdayDescriptions;
  return Array.isArray(d) && d.length ? d.map((line) => String(line).slice(0, 120)).slice(0, 7) : [];
}

// Real reviews, trimmed to what a proof section needs: a first name, a rating
// and the review's own words. Anything longer than a short paragraph gets cut
// — a whole review dumped into the prompt crowds out the design instructions.
function shapeReviews(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => {
      const text = (r?.originalText?.text || r?.text?.text || '').trim().replace(/\s+/g, ' ');
      const author = (r?.authorAttribution?.displayName || '').trim();
      return {
        author: firstName(author),
        rating: typeof r?.rating === 'number' ? r.rating : null,
        text: text.length > 320 ? text.slice(0, 317).trimEnd() + '…' : text,
      };
    })
    .filter((r) => r.text && r.author)
    .slice(0, 4);
}

// Google gives a full display name. A local site shows "Mike R." — and a
// surname on someone else's website is more exposure than a review intended.
function firstName(full) {
  const parts = String(full).split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0].slice(0, 20);
  const initial = parts[1] ? ` ${parts[1][0].toUpperCase()}.` : '';
  return first + initial;
}

function humanizeType(type) {
  if (!type) return '';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Dev-only canned results (MOCK_PLACES=1): deterministic set with a mix of
// with-website and no-website businesses so the lead flow can be tested.
const MOCK_TOWNS = ['Worcester', 'Shrewsbury', 'Auburn', 'Millbury', 'Holden', 'Westborough'];

function mockPlaces(zip, niche) {
  const label = niche.replace(/\b\w/g, (c) => c.toUpperCase());
  const mk = (i, website) => ({
    placeId: `mock-${niche.replace(/\W+/g, '-').toLowerCase()}-${zip}-${i}`,
    name: `${['Ace', 'Summit', 'Riverside', 'Golden Hammer', 'Northside', 'Family', 'Rapid', 'Old Town'][i % 8]} ${label} ${i + 1}`,
    address: `${100 + i * 7} ${['Main St', 'Park Ave', 'Grafton St', 'Chandler St', 'Pleasant St'][i % 5]}, ${MOCK_TOWNS[i % MOCK_TOWNS.length]}, MA ${zip}, USA`,
    phone: `(555) 01${i}-${String(2300 + i * 13).padStart(4, '0')}`,
    rating: Math.round((3.4 + (i % 4) * 0.5) * 10) / 10,
    reviewCount: 5 + i * 17,
    website,
    category: label,
    types: [niche.replace(/\W+/g, '_').toLowerCase()],
    hours: i % 4 === 3 ? [] : [
      'Monday: 8:00 AM – 5:00 PM',
      'Tuesday: 8:00 AM – 5:00 PM',
      'Wednesday: 8:00 AM – 5:00 PM',
      'Thursday: 8:00 AM – 5:00 PM',
      'Friday: 8:00 AM – 5:00 PM',
      'Saturday: 8:00 AM – 12:00 PM',
      'Sunday: Closed',
    ],
    reviews: i % 4 === 3 ? [] : [
      { author: 'Mike R.', rating: 5, text: `Called ${label.toLowerCase()} on a Sunday and they actually picked up. Showed up same day and the price was exactly what they quoted.` },
      { author: 'Dana P.', rating: 5, text: 'Cleaned up after themselves, which nobody does any more. Second time I have used them.' },
      { author: 'Luis T.', rating: 4, text: 'Fair price and they explained what was wrong instead of just handing me a bill.' },
    ],
  });
  const out = [];
  for (let i = 0; i < 9; i++) {
    out.push(mk(i, i % 3 === 0 ? `https://example.com/biz-${i}` : null));
  }
  return out;
}
