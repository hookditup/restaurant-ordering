// Restaurant Grader — grader.hookditup.com
// Env: GOOGLE_PLACES_KEY (required), PAGESPEED_KEY (optional, defaults to the Places key),
//      GHL_TOKEN + GHL_LOCATION_ID (lead delivery), DATA_DIR (report storage; a Railway volume), PORT,
//      PUBLIC_URL (default https://grader.hookditup.com).
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as places from './lib/places.js';
import { fetchPage, readPage, pageSpeed } from './lib/website.js';
import { grade } from './lib/score.js';
import { sendLead } from './lib/ghl.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, 'public');
const DATA = process.env.DATA_DIR || path.join(HERE, 'data');
const KEY = process.env.GOOGLE_PLACES_KEY || '';
const PSI_KEY = process.env.PAGESPEED_KEY || KEY;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://grader.hookditup.com').replace(/\/$/, '');
const DAY = 86400000;
await fs.mkdir(path.join(DATA, 'reports'), { recursive: true });
await fs.mkdir(path.join(DATA, 'leads'), { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
};
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

// Simple per-address limits so nobody runs up the Google bill.
const hits = new Map();
function limited(req, name, max, windowMs) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = `${name}:${ip}`, now = Date.now();
  const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(k, list);
  return list.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.every((t) => now - t > DAY)) hits.delete(k); }, 3600000).unref();

async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 20000) throw new Error('too large'); }
  return JSON.parse(s || '{}');
}
const clean = (v, n = 200) => (typeof v === 'string' ? v.replace(/[<>]/g, '').trim().slice(0, n) : '');
const reportFile = (id) => path.join(DATA, 'reports', `${id.replace(/[^a-f0-9]/g, '')}.json`);
const readReport = async (id) => JSON.parse(await fs.readFile(reportFile(id), 'utf8'));

/** What anyone sees before giving contact details: the score, category scores and top issues. */
const preview = (r) => ({ id: r.id, restaurant: r.restaurant, score: r.score, categories: r.categories, topIssues: r.topIssues, checkCount: r.checks.length });

async function runGrade(placeId) {
  const cacheKey = crypto.createHash('sha256').update(placeId).digest('hex').slice(0, 24);
  try {
    const cached = await readReport(cacheKey);
    if (Date.now() - cached.createdAt < DAY) return cached;
  } catch { /* none yet */ }

  const place = await places.details(placeId, KEY);
  const { city, state } = places.cityOf(place);
  const kind = (place.primaryTypeDisplayName?.text || 'Restaurant').replace(/^Restaurant$/, 'Restaurants');
  const localQuery = `${kind} in ${[city, state].filter(Boolean).join(', ')}`.trim();
  const [local, siteResult, speed] = await Promise.all([
    places.localResults(localQuery, place.location, KEY).catch(() => []),
    place.websiteUri ? fetchPage(place.websiteUri).then((p) => (p.status >= 400 ? { error: `The website returned an error (${p.status}).` } : { site: readPage(p.html, p.url, city) })).catch(() => ({ error: 'The website didn\'t load for us.' })) : Promise.resolve({ error: 'The Google listing has no website.' }),
    place.websiteUri ? pageSpeed(place.websiteUri, PSI_KEY).catch(() => null) : Promise.resolve(null),
  ]);
  const g = grade({ place, city, site: siteResult.site, siteError: siteResult.error, speed, local, localQuery });
  const report = {
    id: cacheKey, token: crypto.randomBytes(12).toString('hex'), createdAt: Date.now(),
    restaurant: place.displayName?.text || '', address: place.formattedAddress || '', mapsUrl: place.googleMapsUri || '', website: place.websiteUri || '',
    rating: place.rating ?? null, reviews: place.userRatingCount || 0, platform: siteResult.site?.platform || '', speed,
    competitors: local.slice(0, 5).map((p, i) => ({ rank: i + 1, name: p.name, rating: p.rating, reviews: p.reviews, you: p.id === placeId })),
    localQuery, ...g,
  };
  await fs.writeFile(reportFile(cacheKey), JSON.stringify(report));
  return report;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/search') {
      if (!KEY) return send(res, 503, { ok: false, error: 'The grader isn\'t connected to Google yet.' });
      if (limited(req, 'search', 40, 3600000)) return send(res, 429, { ok: false, error: 'Too many searches. Please try again in a bit.' });
      const q = clean((await body(req)).q, 120);
      if (q.length < 3) return send(res, 400, { ok: false, error: 'Enter your restaurant\'s name and city.' });
      return send(res, 200, { ok: true, results: await places.search(q, KEY) });
    }
    if (req.method === 'POST' && url.pathname === '/api/grade') {
      if (!KEY) return send(res, 503, { ok: false, error: 'The grader isn\'t connected to Google yet.' });
      if (limited(req, 'grade', 8, 3600000)) return send(res, 429, { ok: false, error: 'You\'ve run several reports. Please try again in an hour.' });
      const id = clean((await body(req)).placeId, 300);
      if (!/^[\w-]{10,300}$/.test(id)) return send(res, 400, { ok: false, error: 'Pick your restaurant from the list.' });
      return send(res, 200, { ok: true, report: preview(await runGrade(id)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/unlock') {
      if (limited(req, 'unlock', 10, 3600000)) return send(res, 429, { ok: false, error: 'Too many tries. Please try again later.' });
      const b = await body(req);
      if (b.company) return send(res, 200, { ok: true }); // hidden field only bots fill in
      const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), phone = clean(b.phone, 30).replace(/[^\d+]/g, '');
      if (!name) return send(res, 400, { ok: false, error: 'Please enter your name.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return send(res, 400, { ok: false, error: 'Please enter a valid email.' });
      if (phone && phone.replace(/\D/g, '').length < 10) return send(res, 400, { ok: false, error: 'Please check your phone number.' });
      let r;
      try { r = await readReport(clean(b.id, 40)); } catch { return send(res, 404, { ok: false, error: 'Please run the report again.' }); }
      const reportUrl = `${PUBLIC_URL}/r/${r.id}?t=${r.token}`;
      const lead = { name, email, phone, smsConsent: b.smsConsent === true, restaurant: r.restaurant, website: r.website, score: r.score, reportUrl, at: new Date().toISOString() };
      const ghl = await sendLead(lead).catch((e) => ({ ok: false, error: String(e) }));
      await fs.writeFile(path.join(DATA, 'leads', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`), JSON.stringify({ ...lead, ghl }));
      if (!ghl.ok) console.error('lead not sent to GHL', ghl);
      const { token, ...full } = r;
      return send(res, 200, { ok: true, report: full, reportUrl });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/report/')) {
      try {
        const r = await readReport(url.pathname.split('/').pop());
        if (url.searchParams.get('t') !== r.token) return send(res, 403, { ok: false, error: 'This report link isn\'t valid.' });
        const { token, ...full } = r;
        return send(res, 200, { ok: true, report: full });
      } catch { return send(res, 404, { ok: false, error: 'Report not found.' }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false });
    let file = url.pathname === '/' || url.pathname.startsWith('/r/') ? 'index.html' : url.pathname.slice(1);
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUB, file);
    if (!full.startsWith(PUB) || !existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': file === 'index.html' ? 'no-cache' : 'public, max-age=3600', ...SECURITY });
    createReadStream(full).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: 'Something went wrong. Please try again.' });
  }
});
server.listen(process.env.PORT || 3000, () => console.log(`grader listening on ${process.env.PORT || 3000}`));
