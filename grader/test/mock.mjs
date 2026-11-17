// Fake Google + a fake restaurant site so the grader can run without keys or network.
const real = globalThis.fetch;
const site = `<!doctype html><html><head><title>Tacos Test | Mexican Food in Heber City</title><meta name="viewport" content="width=device-width"><meta name="description" content="Tacos"><meta property="og:image" content="/x.jpg"><script type="application/ld+json">{"@type":"Restaurant"}</script></head><body><h1>Tacos</h1><a href="/menu">Menu</a><a href="https://www.doordash.com/store/x">Order</a><a href="tel:4355550100">Call</a><img src="a.jpg"><img src="b.jpg" alt="tacos"><p>Gift cards available</p></body></html>`;
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('places:searchText')) {
    const b = JSON.parse(opts.body);
    if (b.includedType) return json({ places: [{ id: 'PLACE_ME_123456', displayName: { text: 'Tacos Test' }, formattedAddress: '1 Main St, Heber City, UT' }] });
    return json({ places: [5, 1, 2, 3, 4].map((n) => (n === 5 ? { id: 'COMP_5', displayName: { text: 'Big Taco' }, rating: 4.7, userRatingCount: 900 } : { id: n === 4 ? 'PLACE_ME_123456' : `COMP_${n}`, displayName: { text: n === 4 ? 'Tacos Test' : `Comp ${n}` }, rating: 4.4, userRatingCount: n * 100 })) });
  }
  if (u.includes('places.googleapis.com/v1/places/')) return json({ id: 'PLACE_ME_123456', displayName: { text: 'Tacos Test' }, formattedAddress: '1 Main St, Heber City, UT 84032', addressComponents: [{ longText: 'Heber City', types: ['locality'] }, { shortText: 'UT', types: ['administrative_area_level_1'] }], location: { latitude: 40.5, longitude: -111.4 }, rating: 4.5, userRatingCount: 250, regularOpeningHours: { periods: [{}] }, photos: Array(10).fill({}), websiteUri: 'https://example.com/', nationalPhoneNumber: '(435) 555-0100', primaryTypeDisplayName: { text: 'Mexican Restaurant' }, googleMapsUri: 'https://maps.google.com/?cid=1' });
  if (u.includes('pagespeedonline')) return json({ lighthouseResult: { categories: { performance: { score: 0.62 }, seo: { score: 0.92 }, accessibility: { score: 0.8 } }, audits: { 'largest-contentful-paint': { displayValue: '4.1 s' } } } });
  if (u.startsWith('https://example.com')) return new Response(site, { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.includes('leadconnectorhq')) { globalThis.__ghl = JSON.parse(opts.body); return json({ contact: { id: 'c1' } }); }
  return real(url, opts);
};
