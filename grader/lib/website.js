// Fetches a restaurant's home page and reads what search engines and guests see.
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 2_000_000;

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && privateAddress(v.slice(7));
}

/** Only public web addresses: this server must not be used to reach private networks. */
async function safeUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || (u.port && !['80', '443'].includes(u.port))) throw new Error('blocked url');
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error('blocked host');
  return u;
}

export async function fetchPage(start) {
  let url = start;
  for (let hop = 0; hop < 6; hop++) {
    const u = await safeUrl(url);
    const r = await fetch(u, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HookdItUpGrader/1.0; +https://grader.hookditup.com)', Accept: 'text/html' },
      signal: AbortSignal.timeout(12000),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).href; continue; }
    const reader = r.body?.getReader();
    const chunks = []; let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; chunks.push(value);
      if (size > MAX_BYTES) { reader.cancel(); break; }
    }
    return { status: r.status, url: u.href, html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
  }
  throw new Error('too many redirects');
}

const MARKETPLACES = [['doordash.com', 'DoorDash'], ['ubereats.com', 'Uber Eats'], ['grubhub.com', 'Grubhub'], ['postmates.com', 'Postmates'], ['seamless.com', 'Seamless'], ['eatstreet.com', 'EatStreet'], ['slicelife.com', 'Slice']];
const DIRECT = [['order.online', 'DoorDash Storefront'], ['toasttab.com', 'Toast'], ['chownow.com', 'ChowNow'], ['square.site', 'Square'], ['clover.com', 'Clover'], ['menufy.com', 'Menufy'], ['beyondmenu.com', 'BeyondMenu'], ['olo.com', 'Olo'], ['popmenu.com', 'Popmenu'], ['bentobox', 'BentoBox'], ['spoton.com', 'SpotOn'], ['owner.com', 'Owner'], ['ordersave.com', 'Owner'], ['gloriafood', 'GloriaFood'], ['fbgcdn.com', 'GloriaFood'], ['restolabs', 'Restolabs'], ['hungerrush', 'HungerRush']];

const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Facts about the page. Nothing here is a score yet. */
export function readPage(html, pageUrl, city) {
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  const head = html.slice(0, 200000);
  const meta = (name) => (head.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i'))?.[0].match(/content=["']([^"']*)/i) || [])[1] || '';
  const title = strip((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => strip(m[1])).filter(Boolean);
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1], text: strip(m[2]).toLowerCase() }));
  const abs = (h) => { try { return new URL(h, pageUrl); } catch { return null; } };
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join(' ');
  const text = strip(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')).toLowerCase();

  const ordering = { marketplaces: new Set(), direct: new Set(), own: false };
  for (const l of links) {
    const u = abs(l.href); if (!u || !/^https?:/.test(u.protocol)) continue;
    const h = u.hostname.toLowerCase();
    for (const [d, n] of MARKETPLACES) if (h.endsWith(d)) ordering.marketplaces.add(n);
    for (const [d, n] of DIRECT) if (h.includes(d)) ordering.direct.add(n);
    if (h.replace(/^www\./, '').endsWith(host) && /order/.test(u.pathname + ' ' + l.text) && !/catering/.test(u.pathname)) ordering.own = true;
  }
  const menuLinks = links.filter((l) => /menu/.test(l.text) || /menu/i.test(l.href));
  const platform = [['wix.com', 'Wix'], ['squarespace', 'Squarespace'], ['wp-content', 'WordPress'], ['owner.com', 'Owner'], ['bentobox', 'BentoBox'], ['popmenu', 'Popmenu'], ['godaddy', 'GoDaddy'], ['webflow', 'Webflow'], ['duda', 'Duda'], ['toasttab', 'Toast']].find(([s]) => html.includes(s))?.[1] || '';

  return {
    url: pageUrl,
    https: pageUrl.startsWith('https://'),
    title,
    titleHasCity: !!city && title.toLowerCase().includes(city.toLowerCase()),
    description: meta('description'),
    viewport: /<meta[^>]+name=["']viewport["']/i.test(head),
    h1Count: h1s.length,
    h1: h1s[0] || '',
    schema: /"@type"\s*:\s*"(Restaurant|FoodEstablishment|CafeOrCoffeeShop|BarOrPub|FastFoodRestaurant|Bakery)"/i.test(ld),
    menuLink: menuLinks.length > 0,
    menuPdfOnly: menuLinks.length > 0 && menuLinks.every((l) => /\.pdf(\?|$)/i.test(l.href)),
    telLink: links.some((l) => l.href.startsWith('tel:')),
    ogImage: !!meta('og:image'),
    images: imgs.length,
    imagesMissingAlt: imgs.filter((i) => !/\balt=["'][^"']+["']/i.test(i)).length,
    ordering: { marketplaces: [...ordering.marketplaces], direct: [...ordering.direct], own: ordering.own },
    rewards: /rewards|loyalty|points/.test(text),
    giftCards: /gift ?card/.test(text),
    platform,
  };
}

/** Google PageSpeed Insights, phone view. Slow (often 10 to 30 seconds), so it runs alongside everything else. */
export async function pageSpeed(url, key) {
  const q = new URLSearchParams({ url, strategy: 'mobile' });
  for (const c of ['performance', 'seo', 'accessibility']) q.append('category', c);
  if (key) q.set('key', key);
  const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(60000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`pagespeed ${r.status}: ${d?.error?.message || 'error'}`);
  const cat = d.lighthouseResult?.categories || {};
  const pct = (c) => (c?.score == null ? null : Math.round(c.score * 100));
  const a = d.lighthouseResult?.audits || {};
  return { performance: pct(cat.performance), seo: pct(cat.seo), accessibility: pct(cat.accessibility), lcp: a['largest-contentful-paint']?.displayValue || '' };
}
