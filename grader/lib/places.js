// Google Places API (New). Needs GOOGLE_PLACES_KEY with "Places API (New)" enabled.
const BASE = 'https://places.googleapis.com/v1';

const DETAIL_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'addressComponents', 'location', 'rating', 'userRatingCount',
  'regularOpeningHours', 'photos', 'websiteUri', 'nationalPhoneNumber', 'businessStatus', 'primaryType',
  'primaryTypeDisplayName', 'types', 'googleMapsUri', 'delivery', 'takeout', 'dineIn', 'reservable',
].join(',');

async function call(path, { method = 'GET', body, fields, key }) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`places ${r.status}: ${data?.error?.message || 'error'}`);
  return data;
}

/** Restaurants matching what the visitor typed, for them to pick from. */
export async function search(query, key) {
  const d = await call('/places:searchText', {
    method: 'POST', key,
    fields: 'places.id,places.displayName,places.formattedAddress',
    body: { textQuery: query, includedType: 'restaurant', pageSize: 6 },
  });
  return (d.places || []).map((p) => ({ id: p.id, name: p.displayName?.text || '', address: p.formattedAddress || '' }));
}

export const details = (id, key) => call(`/places/${encodeURIComponent(id)}`, { key, fields: DETAIL_FIELDS });

/** The top local results for this kind of restaurant near it, in Google's order. */
export async function localResults(query, center, key) {
  const d = await call('/places:searchText', {
    method: 'POST', key,
    fields: 'places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri',
    body: { textQuery: query, pageSize: 20, locationBias: { circle: { center, radius: 8000 } } },
  });
  return (d.places || []).map((p) => ({ id: p.id, name: p.displayName?.text || '', rating: p.rating ?? null, reviews: p.userRatingCount ?? 0, website: p.websiteUri || '' }));
}

export function cityOf(place) {
  const c = (place.addressComponents || []);
  const pick = (t) => c.find((x) => x.types?.includes(t))?.longText;
  return { city: pick('locality') || pick('postal_town') || pick('administrative_area_level_2') || '', state: c.find((x) => x.types?.includes('administrative_area_level_1'))?.shortText || '' };
}
