const ALLOWED_TRAVEL_MODES = new Set(['driving', 'walking', 'bicycling', 'transit']);
const MAX_LOCATION_LENGTH = 240;
const MAX_URL_LENGTH = 2048;

function normalizeLocation(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_LOCATION_LENGTH) return null;
  return text;
}

function buildGoogleMapsDirectionsUrl(payload = {}) {
  const origin = normalizeLocation(payload.origin);
  const destination = normalizeLocation(payload.destination);
  const travelMode = String(payload.travelMode || 'driving');
  if (!origin || !destination || !ALLOWED_TRAVEL_MODES.has(travelMode)) return null;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  url.searchParams.set('travelmode', travelMode);
  return url.toString().length <= MAX_URL_LENGTH ? url.toString() : null;
}

function isAllowedGoogleMapsDirectionsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const keys = [...url.searchParams.keys()];
    return url.protocol === 'https:'
      && url.hostname === 'www.google.com'
      && url.pathname === '/maps/dir/'
      && url.searchParams.get('api') === '1'
      && Boolean(normalizeLocation(url.searchParams.get('origin')))
      && Boolean(normalizeLocation(url.searchParams.get('destination')))
      && ALLOWED_TRAVEL_MODES.has(url.searchParams.get('travelmode'))
      && keys.every((key) => ['api', 'origin', 'destination', 'travelmode'].includes(key))
      && url.toString().length <= MAX_URL_LENGTH;
  } catch (_) {
    return false;
  }
}

module.exports = { buildGoogleMapsDirectionsUrl, isAllowedGoogleMapsDirectionsUrl, normalizeLocation };
