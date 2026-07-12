const assert = require('assert');
const { buildGoogleMapsDirectionsUrl, isAllowedGoogleMapsDirectionsUrl } = require('../electron/route_policy');

const url = buildGoogleMapsDirectionsUrl({
  origin: '上海博物馆 & 人民广场',
  destination: '上海虹桥站',
  travelMode: 'transit',
});
assert(url);
assert(isAllowedGoogleMapsDirectionsUrl(url));
const parsed = new URL(url);
assert.strictEqual(parsed.searchParams.get('origin'), '上海博物馆 & 人民广场');
assert.strictEqual(parsed.searchParams.get('destination'), '上海虹桥站');
assert.strictEqual(parsed.searchParams.get('travelmode'), 'transit');
assert.strictEqual(buildGoogleMapsDirectionsUrl({ origin: 'A', destination: 'B', travelMode: 'flying' }), null);
assert.strictEqual(buildGoogleMapsDirectionsUrl({ origin: '', destination: 'B' }), null);
assert(!isAllowedGoogleMapsDirectionsUrl('https://evil.example/maps/dir/?api=1&origin=A&destination=B&travelmode=driving'));
assert(!isAllowedGoogleMapsDirectionsUrl(`${url}&unexpected=1`));

console.log('route policy test ok');
