// Turns the facts into checks and a score out of 100. Checks that couldn't be measured
// are left out of the math instead of counting as failures.

export const CATEGORIES = [
  ['google', 'Google listing'],
  ['website', 'Website'],
  ['ordering', 'Online ordering'],
  ['competition', 'Local competition'],
];

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function grade({ place, city, site, siteError, speed, local, localQuery }) {
  const checks = [];
  const add = (category, id, label, max, got, detail, fix) =>
    checks.push({ category, id, label, max, points: got == null ? null : Math.max(0, Math.min(max, got)), detail, fix: got === max ? '' : fix });

  // Google listing
  const rating = place.rating ?? null;
  add('google', 'rating', 'Star rating', 10, rating == null ? 0 : rating >= 4.6 ? 10 : rating >= 4.3 ? 7 : rating >= 4.0 ? 4 : 0,
    rating == null ? 'No rating yet.' : `${rating.toFixed(1)} stars on Google.`,
    'Ask every happy guest for a review, and reply to every review, good or bad.');
  const others = local.filter((p) => p.id !== place.id).slice(0, 10).map((p) => p.reviews);
  const mid = median(others);
  const count = place.userRatingCount || 0;
  const reviewPts = others.length ? (count >= mid * 1.5 ? 8 : count >= mid ? 6 : count >= mid * 0.5 ? 3 : 0) : (count >= 500 ? 8 : count >= 200 ? 6 : count >= 50 ? 3 : 0);
  add('google', 'reviews', 'Number of reviews', 8, reviewPts,
    others.length ? `${count.toLocaleString()} reviews. Nearby competitors have about ${mid.toLocaleString()}.` : `${count.toLocaleString()} reviews.`,
    'Text or email a review link after each visit or order so the count keeps growing.');
  add('google', 'hours', 'Hours listed', 5, place.regularOpeningHours?.periods?.length ? 5 : 0,
    place.regularOpeningHours?.periods?.length ? 'Hours are on the listing.' : 'No hours on the listing.',
    'Add your regular hours, plus holiday hours, in Google Business Profile.');
  add('google', 'website_link', 'Website linked', 4, place.websiteUri ? 4 : 0,
    place.websiteUri ? 'The listing links to a website.' : 'The listing has no website.',
    'Add your website to the Google listing so searchers can find your menu and order.');
  add('google', 'phone', 'Phone number', 3, place.nationalPhoneNumber ? 3 : 0,
    place.nationalPhoneNumber ? `Phone: ${place.nationalPhoneNumber}.` : 'No phone number on the listing.', 'Add your phone number to the listing.');
  const photos = place.photos?.length || 0;
  add('google', 'photos', 'Photos', 5, photos >= 10 ? 5 : photos >= 5 ? 3 : 0,
    photos >= 10 ? 'At least 10 photos on the listing.' : `${photos} photos on the listing.`,
    'Add fresh photos of your food, inside and outside every month.');

  // Website
  if (!site) {
    add('website', 'site', 'Website loads', 35, 0, siteError || 'No website to check.', 'A fast, mobile-friendly website with your menu is the base for everything else.');
  } else {
    add('website', 'https', 'Secure (https)', 3, site.https ? 3 : 0, site.https ? 'The site uses https.' : 'The site is not secure (no https).', 'Turn on an SSL certificate so browsers don\'t warn visitors.');
    add('website', 'mobile', 'Built for phones', 3, site.viewport ? 3 : 0, site.viewport ? 'The site is set up for phone screens.' : 'The site isn\'t set up for phone screens.', 'Most restaurant searches happen on phones. The site needs a mobile layout.');
    const perf = speed?.performance;
    add('website', 'speed', 'Speed on phones', 8, perf == null ? null : perf >= 90 ? 8 : perf >= 70 ? 6 : perf >= 50 ? 3 : 0,
      perf == null ? 'Speed couldn\'t be measured this time.' : `Google rates phone speed ${perf} out of 100${speed.lcp ? ` (main content shows in ${speed.lcp})` : ''}.`,
      'Compress photos, remove heavy plugins and pop-ups, and use fast hosting.');
    add('website', 'title', 'Page title names your city', 3, site.title ? (site.titleHasCity ? 3 : 1) : 0,
      site.title ? `Title: "${site.title.slice(0, 90)}"` : 'The page has no title.', `Put your food and city in the title, for example "Mexican Restaurant in ${city || 'your city'}".`);
    add('website', 'description', 'Search description', 3, site.description ? 3 : 0, site.description ? 'The page has a search description.' : 'No search description, so Google picks its own text.', 'Write a one or two sentence description with your food, city and a reason to visit.');
    add('website', 'h1', 'Main heading', 2, site.h1Count === 1 ? 2 : site.h1Count > 1 ? 1 : 0, site.h1Count ? `${site.h1Count} main heading${site.h1Count > 1 ? 's' : ''}.` : 'No main heading.', 'Use one main heading that says what you serve and where.');
    add('website', 'schema', 'Restaurant details for Google', 4, site.schema ? 4 : 0, site.schema ? 'The site tells Google it\'s a restaurant (schema markup).' : 'No restaurant schema markup found.', 'Add restaurant schema with your hours, address, menu link and price range.');
    add('website', 'menu', 'Menu on the site', 3, site.menuLink ? (site.menuPdfOnly ? 1 : 3) : 0, site.menuLink ? (site.menuPdfOnly ? 'The menu is only a PDF.' : 'There\'s a menu link.') : 'No menu link found.', 'Put the menu on a real web page. Google can\'t read PDF menus well, and they\'re hard to use on phones.');
    add('website', 'call', 'Tap to call', 2, site.telLink ? 2 : 0, site.telLink ? 'Phone number is tap-to-call.' : 'No tap-to-call phone link.', 'Make the phone number a link so guests can tap to call.');
    add('website', 'alt', 'Image descriptions', 2, site.images ? (site.imagesMissingAlt === 0 ? 2 : site.imagesMissingAlt / site.images < 0.25 ? 1 : 0) : null,
      site.images ? `${site.imagesMissingAlt} of ${site.images} images have no description.` : 'No images found on the home page.', 'Describe every food photo (alt text). It helps screen readers and image search.');
    add('website', 'share', 'Share preview image', 2, site.ogImage ? 2 : 0, site.ogImage ? 'Links shared on Facebook and texts show a preview image.' : 'Shared links show no preview image.', 'Add a share image so links look good on Facebook and in texts.');
    add('website', 'seo_audit', 'Google\'s search checklist', 2, speed?.seo == null ? null : speed.seo >= 90 ? 2 : speed.seo >= 75 ? 1 : 0,
      speed?.seo == null ? 'Not measured this time.' : `Google's search checklist score: ${speed.seo} out of 100.`, 'Fix the items Google\'s PageSpeed search checklist flags.');
  }

  // Online ordering
  const o = site?.ordering || { marketplaces: [], direct: [], own: false };
  const hasOrdering = o.own || o.direct.length || o.marketplaces.length;
  add('ordering', 'order_link', 'Order online from the site', 6, site ? (hasOrdering ? 6 : 0) : null,
    hasOrdering ? 'Guests can order online from the site.' : 'No online ordering link found.', 'Add an "Order online" button to every page.');
  const direct = o.own || o.direct.length;
  add('ordering', 'commission', 'Ordering without commissions', 10, site ? (direct ? 10 : 0) : null,
    direct ? `Direct ordering${o.direct.length ? ` through ${o.direct.join(', ')}` : ' on your own site'}.` : o.marketplaces.length ? `Online orders go through ${o.marketplaces.join(', ')}, which typically take a commission on each order.` : 'No direct online ordering found.',
    'Take orders on your own site so you keep the full order and the guest\'s contact information.');
  add('ordering', 'rewards', 'Rewards program', 2, site ? (site.rewards ? 2 : 0) : null, site?.rewards ? 'The site mentions rewards or loyalty.' : 'No rewards program mentioned.', 'A points program brings guests back and builds your own customer list.');
  add('ordering', 'gift', 'Gift cards online', 2, site ? (site.giftCards ? 2 : 0) : null, site?.giftCards ? 'The site mentions gift cards.' : 'No gift cards mentioned.', 'Sell gift cards online. They sell all year and spike in December.');

  // Local competition
  const rank = local.findIndex((p) => p.id === place.id) + 1;
  add('competition', 'rank', 'Where you show up locally', 10, rank === 0 ? 0 : rank <= 3 ? 10 : rank <= 5 ? 6 : rank <= 10 ? 3 : 1,
    rank ? `#${rank} on Google Maps for "${localQuery}".` : `Not in the top 20 on Google Maps for "${localQuery}".`,
    'More reviews, more photos, regular posts and a strong website move you up the map.');

  const byCat = Object.fromEntries(CATEGORIES.map(([k, name]) => {
    const cs = checks.filter((c) => c.category === k && c.points != null);
    const max = cs.reduce((s, c) => s + c.max, 0), got = cs.reduce((s, c) => s + c.points, 0);
    return [k, { name, got, max, pct: max ? Math.round((got / max) * 100) : null }];
  }));
  const counted = checks.filter((c) => c.points != null);
  const total = Math.round((counted.reduce((s, c) => s + c.points, 0) / counted.reduce((s, c) => s + c.max, 0)) * 100);
  const top = checks.filter((c) => c.points != null && c.points < c.max).sort((a, b) => (b.max - b.points) - (a.max - a.points)).slice(0, 3).map((c) => c.label);
  return { score: total, categories: byCat, checks, topIssues: top, rank: rank || null };
}
