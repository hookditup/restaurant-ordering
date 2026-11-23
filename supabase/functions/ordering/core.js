// Pure ordering rules, shared by the edge function and the tests.
// All money is in integer cents. The browser's prices are never trusted.

export class OrderError extends Error {}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Local wall-clock parts of a moment in a restaurant's time zone. */
export function zoned(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: p.weekday.toLowerCase().slice(0, 3), ymd: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}

const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/** Opening windows for a local date: special hours win over the weekly hours. */
export function windowsFor(restaurant, ymd, day) {
  const ex = restaurant.exceptions?.[ymd];
  if (ex) return ex.closed ? [] : ex.ranges ?? [];
  return restaurant.hours?.[day] ?? [];
}

/** hours = {mon:[["10:30","21:00"]]}. End time is exclusive. Special hours (restaurant.exceptions) apply. */
export function isOpenAt(hours, date, tz, exceptions) {
  const z = zoned(date, tz);
  return windowsFor({ hours, exceptions }, z.ymd, z.day).some(([a, b]) => z.minutes >= toMin(a) && z.minutes < toMin(b));
}

/** A category with no hours of its own follows the restaurant. */
export function categoryOpenAt(category, restaurant, date) {
  const tz = restaurant.timezone;
  return isOpenAt(restaurant.hours, date, tz, restaurant.exceptions) && (!category.hours || isOpenAt(category.hours, date, tz));
}

/** Convert a local date and minute-of-day in a time zone to a real instant. */
function instantFor(ymd, minutes, tz) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const z = zoned(new Date(t), tz);
    const [zy, zm, zd] = z.ymd.split('-').map(Number);
    t += guess - Date.UTC(zy, zm - 1, zd, Math.floor(z.minutes / 60), z.minutes % 60);
  }
  return new Date(t);
}

/** Pickup times on 15-minute marks (or `step`), today and the next two days (or `days`): a flat list. */
export function pickupSlots(restaurant, now = new Date(), days = 3, step = 15, limit = 200) {
  const tz = restaurant.timezone;
  const earliest = now.getTime() + restaurant.pickup_lead_minutes * 60000;
  const lastGap = restaurant.last_order_minutes_before_close ?? 0;
  const out = [];
  for (let n = 0; n < days + 1 && out.length < limit; n++) {
    const z = zoned(new Date(now.getTime() + n * 86400000), tz);
    if (n === days) break;
    for (const [a, b] of windowsFor(restaurant, z.ymd, z.day)) {
      for (let m = Math.ceil(toMin(a) / step) * step; m < toMin(b) - lastGap; m += step) {
        const t = instantFor(z.ymd, m, tz);
        if (t.getTime() >= earliest) out.push(t.toISOString());
      }
    }
  }
  return out;
}

/** Is this exact pickup time on offer? Guards against tampered requests. */
export function validPickup(restaurant, iso, now = new Date(), days = 3, step = 15, limit = 200) {
  return pickupSlots(restaurant, now, days, step, limit).includes(new Date(iso).toISOString());
}

export function indexMenu(menu) {
  const items = new Map();
  for (const c of menu.categories) for (const i of c.items) items.set(i.id, { item: i, category: c });
  return items;
}

/**
 * Check one cart line's choices and work out its price.
 * selections: option ids the guest picked. Follow-up groups are checked only
 * when the choice that opens them was picked.
 */
export function priceLine(item, selected) {
  const picked = new Set(selected ?? []);
  const options = [];
  let extras = 0;
  const known = new Set();

  const walk = (groups) => {
    for (const g of groups) {
      const chosen = g.options.filter((o) => picked.has(o.id));
      g.options.forEach((o) => known.add(o.id));
      if (chosen.length < g.min) throw new OrderError(`Please choose ${g.name} for ${item.name}.`);
      if (g.max != null && chosen.length > g.max) throw new OrderError(`Too many choices for ${g.name} on ${item.name}.`);
      for (const o of chosen) {
        extras += o.price_cents;
        options.push({ group: g.name, name: o.name, price_cents: o.price_cents });
        walk(o.groups ?? []);
      }
    }
  };
  walk(item.groups ?? []);

  for (const id of picked) {
    if (!known.has(id)) throw new OrderError(`A choice on ${item.name} isn't available.`);
  }
  return { unit_cents: item.price_cents + extras, options, option_ids: [...picked] };
}

/** Price a whole cart at a pickup time. Unavailable items stop the order. */
export function priceCart(menu, lines, pickupAt) {
  if (!Array.isArray(lines) || !lines.length) throw new OrderError('Your cart is empty.');
  if (lines.length > 60) throw new OrderError('That order is too large to place online. Please call us.');
  const index = indexMenu(menu);
  const when = new Date(pickupAt);
  const out = [];
  for (const l of lines) {
    const hit = index.get(l.id);
    if (!hit) throw new OrderError('An item in your cart is no longer available.');
    if (!categoryOpenAt(hit.category, menu.restaurant, when)) {
      throw new OrderError(`${hit.item.name} isn't available at that pickup time.`);
    }
    const qty = Math.floor(Number(l.qty));
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new OrderError(`Check the quantity for ${hit.item.name}.`);
    const { unit_cents, options, option_ids } = priceLine(hit.item, l.options);
    out.push({
      menu_item_id: hit.item.id, name: hit.item.name, qty, unit_price_cents: unit_cents,
      line_total_cents: unit_cents * qty, options, option_ids, note: String(l.note ?? '').replace(/[<>]/g, '').trim().slice(0, 200) || null,
    });
  }
  return out;
}

export function totals(lines, restaurant, tipCents = 0, discountCents = 0, deliveryCents = 0) {
  const subtotal = lines.reduce((s, l) => s + l.line_total_cents, 0);
  const tip = Math.max(0, Math.min(Math.round(Number(tipCents) || 0), 50000));
  const discount = Math.max(0, Math.min(Math.round(Number(discountCents) || 0), subtotal));
  const taxable = subtotal - discount;
  const guest_fee = Math.round(taxable * restaurant.guest_fee_bps / 10000);
  const tax = Math.round((taxable + guest_fee) * restaurant.tax_rate_bps / 10000);
  const delivery = Math.max(0, Math.round(Number(deliveryCents) || 0));
  return { subtotal_cents: subtotal, discount_cents: discount, guest_fee_cents: guest_fee, tax_cents: tax, tip_cents: tip, delivery_fee_cents: delivery, total_cents: taxable + guest_fee + tax + tip + delivery };
}

/**
 * Discount from a promo code on a subtotal (cents). Returns 0 when the code doesn't apply.
 * promo: { kind: 'percent'|'amount', value, min_subtotal_cents }
 */
export function promoDiscount(promo, subtotalCents) {
  if (!promo || subtotalCents < (promo.min_subtotal_cents ?? 0)) return 0;
  const off = promo.kind === 'percent' ? Math.round(subtotalCents * Math.min(100, promo.value) / 100) : promo.value;
  return Math.max(0, Math.min(off, subtotalCents));
}

/** How much of a total a gift card covers, and what is left to pay. */
export function applyGift(totalCents, balanceCents) {
  const gift_applied_cents = Math.max(0, Math.min(totalCents, balanceCents));
  return { gift_applied_cents, amount_due_cents: totalCents - gift_applied_cents };
}

export function normPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits[0] === '1' ? `+${digits}` : '';
}

/** Codes read easily aloud: no 0, O, 1, I or L. */
const CODE_LETTERS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function makeCode(length, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const out = [];
  while (out.length < length) for (const b of random(length * 2)) if (b < 248 && out.length < length) out.push(CODE_LETTERS[b % CODE_LETTERS.length]);
  return out.join('');
}
export const cleanCode = (value) => String(value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 24);

/** A date a guest may reserve: today or later, within a year, on a day the restaurant is open. */
export function validReservationDate(restaurant, date, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  const wanted = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(wanted.getTime())) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: restaurant.timezone }).format(now);
  if (date < today || wanted.getTime() - now.getTime() > 366 * 86400000) return false;
  const day = wanted.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }).toLowerCase().slice(0, 3);
  return (restaurant.hours?.[day] ?? []).length > 0;
}

/** A delivery address from checkout, ready to save and send to the courier. */
export function cleanAddress(a) {
  const clean = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
  const street = clean(a?.street, 120), unit = clean(a?.unit, 30), city = clean(a?.city, 60), zip = clean(a?.zip, 10);
  if (!street || !city) throw new OrderError('Please enter your street address and city.');
  if (!/^\d{5}$/.test(zip)) throw new OrderError('Please enter a 5-digit ZIP code.');
  return { street, unit, city, state: 'UT', zip, instructions: clean(a?.instructions, 200) };
}
export const addressLine = (a) => `${a.street}${a.unit ? ` ${a.unit}` : ''}, ${a.city}, ${a.state} ${a.zip}`;

export function cleanGuest(g) {
  const clean = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
  const phone = normPhone(g?.phone);
  const email = clean(g?.email, 120).toLowerCase();
  const first_name = clean(g?.first_name, 40), last_name = clean(g?.last_name, 40);
  if (!first_name || !last_name) throw new OrderError('Please enter your first and last name.');
  if (!phone) throw new OrderError('Please enter a 10-digit phone number.');
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) throw new OrderError('Please enter a valid email for your receipt.');
  return { first_name, last_name, phone, email, note: clean(g?.note, 300) || null };
}

// ---------- where guests come from ----------
// Channels, in the order the dashboard lists them.
export const CHANNELS = {
  google_business: 'Google Maps & Business Profile', google_search: 'Google search', google_ads: 'Google Ads',
  search: 'Other search engines', search_ads: 'Other search ads', ai: 'AI assistants (ChatGPT etc.)',
  social: 'Social media', social_ads: 'Social media ads', email: 'Our emails', sms: 'Our texts',
  qr: 'QR codes & print', table_qr: 'Table QR codes', phone: 'Phone (AI)', referral: 'Other websites', campaign: 'Other tagged links', direct: 'Direct / typed in',
};
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|tiktok\.com|t\.co|x\.com|twitter\.com|pinterest\.com|linkedin\.com|lnkd\.in|nextdoor\.com|reddit\.com|youtube\.com|youtu\.be|threads\.net|snapchat\.com)$/;
const SOCIAL_SRC = /^(fb|facebook|ig|instagram|tiktok|tt|twitter|x|pinterest|linkedin|nextdoor|reddit|youtube|threads|snapchat|social)$/;
const AI = /(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|copilot\.microsoft\.com|gemini\.google\.com|you\.com|meta\.ai)$/;
const SEARCH = /(^|\.)(bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org|search\.brave\.com|startpage\.com|aol\.com)$/;
const PAID = /^(cpc|ppc|paid|paid_social|paidsocial|paid-social|ads?|display|sponsored|boost(ed)?)$/;
const VIA = { gbp: 'google_business', google: 'google_business', maps: 'google_business', sms: 'sms', text: 'sms', email: 'email', qr: 'qr', print: 'qr', flyer: 'qr', billboard: 'qr', table: 'table_qr', phone: 'phone', social: 'social', fb: 'social', ig: 'social', ads: 'social_ads' };
const low = (v) => String(v ?? '').trim().toLowerCase().slice(0, 120);

/** Host name of a referrer, whether given as a host (track.js `ref`) or a full URL (attribution script `referrer`). */
const hostOf = (t) => {
  if (t.ref) return low(t.ref).replace(/^www\./, '');
  try { return t.referrer ? new URL(String(t.referrer)).hostname.toLowerCase().replace(/^www\./, '') : ''; } catch { return ''; }
};

/**
 * Sort one visit into a channel, with the source and campaign behind it. A visit comes from the
 * attribution script (utm_source, utm_medium, utm_campaign, gclid, fbclid, referrer…) or from
 * track.js (the same keys); our own short ?via=channel.name tag is understood too.
 */
export function channelOf(t) {
  if (!t || typeof t !== 'object') return { channel: 'direct', source: null, campaign: null };
  const via = low(t.via), source = low(t.utm_source ?? t.source), medium = low(t.utm_medium ?? t.medium), ref = hostOf(t);
  const campaign = String(t.utm_campaign ?? t.campaign ?? '').trim().slice(0, 120) || null;
  if (via) {
    const [head, ...rest] = via.split('.');
    const detail = rest.join('.') || null;
    if (VIA[head]) return { channel: VIA[head], source: head, campaign: detail ?? campaign };
    return { channel: 'campaign', source: head, campaign: detail ?? campaign };
  }
  const paid = PAID.test(medium);
  if (t.gclid || t.gbraid || t.wbraid || (source === 'google' && paid)) return { channel: 'google_ads', source: 'google', campaign };
  if (t.msclkid || ((source === 'bing' || source === 'microsoft') && paid)) return { channel: 'search_ads', source: source || 'bing', campaign };
  if (/^(gbp|gmb|maps|local|business|google_business)$/.test(medium) || (source === 'google' && /^(organic_local|listing)$/.test(medium))) return { channel: 'google_business', source: source || 'google', campaign };
  if (medium === 'email' || source === 'email') return { channel: 'email', source: source || 'email', campaign };
  if (medium === 'sms' || medium === 'text' || source === 'sms') return { channel: 'sms', source: source || 'sms', campaign };
  if (medium === 'qr' || medium === 'print' || medium === 'flyer' || medium === 'billboard') return { channel: 'qr', source: source || medium, campaign };
  if (SOCIAL_SRC.test(source) || medium === 'social' || medium === 'paid_social' || t.fbclid || t.ttclid || SOCIAL.test(ref)) {
    const name = source || (ref ? ref.replace(/\.(com|net|me|co|in|be)$/, '').replace(/^(l|m|lm)\./, '') : t.ttclid ? 'tiktok' : 'facebook');
    return { channel: paid ? 'social_ads' : 'social', source: name, campaign };
  }
  if (medium === 'ai' || AI.test(ref) || /^(chatgpt|openai|perplexity|claude|gemini|copilot)/.test(source)) return { channel: 'ai', source: source || ref, campaign };
  if ((source === 'google' && (!medium || medium === 'organic')) || /(^|\.)google\.[a-z.]+$/.test(ref)) return { channel: 'google_search', source: 'google', campaign };
  if (medium === 'organic' || SEARCH.test(ref)) return { channel: 'search', source: source || ref, campaign };
  if (medium === 'referral' && source) return { channel: 'referral', source, campaign };
  if (source) return { channel: 'campaign', source, campaign };
  if (ref) return { channel: 'referral', source: ref, campaign };
  return { channel: 'direct', source: null, campaign: null };
}

/** The channel credited for an order or booking: the latest tagged visit, else the first. */
export function sourceOf(attr) {
  const last = attr?.lastTouch, first = attr?.firstTouch;
  const real = (x) => x && !x.direct && Object.keys(x).some((k) => !['at', 'landing', 'landing_url', 'referrer', 'short_link_id'].includes(k) || (k === 'referrer' && x.referrer));
  const pick = real(last) ? last : real(first) ? first : last ?? first;
  return channelOf(pick);
}

/** Tag links to the restaurant's own site in a text or email (utm_medium=sms&utm_campaign=winback), so the order is credited to it. */
export function tagLinks(text, siteUrl, channel, campaign) {
  if (!siteUrl || !channel) return text;
  const base = siteUrl.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = `utm_medium=${encodeURIComponent(channel)}${campaign ? `&utm_campaign=${encodeURIComponent(campaign)}` : ''}`;
  return String(text).replace(new RegExp(`${base}(/[^\\s"'<>)]*)?`, 'g'), (whole) => {
    const tail = whole.match(/[.,!?;:]+$/)?.[0] ?? '', url = whole.slice(0, whole.length - tail.length);
    if (/[?&](utm_|via=)/.test(url)) return whole;
    const [path, hash = ''] = url.split('#');
    return `${path}${path.includes('?') ? '&' : '?'}${tag}${hash ? `#${hash}` : ''}${tail}`;
  });
}

// ---------- phone orders (AI voice agent) ----------
// The agent sends the order as text, one dish per part, e.g.
//   "2 carne asada tacos with corn tortillas, no onions; 1 large horchata"
// Each part is matched to a dish and its choices. Anything the caller still has to decide comes
// back as a question for the agent to ask.
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, couple: 2, pair: 2 };
const stem = (w) => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/(s|x|z|ch|sh)es$/, '$1').replace(/([^s])s$/, '$1') : w);
export const words = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean).map(stem);
const FILLER = new Set(['of', 'the', 'with', 'and', 'order', 'please', 'plate', 'side', 'piece', 'pc', 'x']);
/** How well a name matches the spoken words: share of the name's words that were said (0 to 1). */
function fit(name, said) {
  const n = words(name).filter((w) => !FILLER.has(w));
  if (!n.length) return 0;
  return n.filter((w) => said.has(w)).length / n.length;
}

/**
 * at: the pickup time, so only dishes served then are matched (lunch vs. dinner versions).
 * @param {any} menu @param {unknown} text @param {Date|null} [at]
 */
export function parseSpoken(menu, text, at = null) {
  const items = indexMenu(menu);
  const parts = String(text ?? '').split(/[;\n]+|,(?=\s*(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\s)/i).map((p) => p.trim()).filter(Boolean);
  const lines = [], ask = [];
  if (!parts.length) return { lines, ask: ['What would the caller like to order?'] };
  if (parts.length > 40) return { lines, ask: ['That order is too large for the phone. Please ask them to order online or speak with staff.'] };
  for (const part of parts) {
    const m = part.match(/^\s*(\d+|[a-z]+)\s*(?:x\s+|×\s*)?(.*)$/i);
    let qty = 1, rest = part;
    if (m && (/^\d+$/.test(m[1]) || WORDS[m[1].toLowerCase()])) { qty = /^\d+$/.test(m[1]) ? +m[1] : WORDS[m[1].toLowerCase()]; rest = m[2]; }
    const said = new Set(words(rest));
    // Score each dish: share of its name the caller said, then how many of its words they said.
    const score = (name) => { const n = words(name).filter((w) => !FILLER.has(w)); return n.length ? [n.filter((w) => said.has(w)).length / n.length, n.filter((w) => said.has(w)).length] : [0, 0]; };
    const better = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
    let best = [], top = [0, 0], offBest = null, offTop = [0, 0];
    for (const { item, category } of items.values()) {
      const sc = score(item.name);
      if (at && !categoryOpenAt(category, menu.restaurant, at)) { if (better(sc, offTop)) { offTop = sc; offBest = item; } continue; }
      if (better(sc, top)) { top = sc; best = [item]; } else if (sc[0] === top[0] && sc[1] === top[1] && sc[0] > 0) best.push(item);
    }
    if (offBest && offTop[0] >= 0.99 && better(offTop, top)) { ask.push(`${offBest.name} isn't served at that pickup time. Offer another dish or another time.`); continue; }
    if (top[0] < 0.6 || !best.length) { ask.push(`We couldn't find "${rest.trim()}" on the menu. Ask the caller which dish they mean.`); continue; }
    if (best.length > 1) { ask.push(`"${rest.trim()}" could be ${best.slice(0, 4).map((i) => i.name).join(' or ')}. Ask which one.`); continue; }
    const item = best[0];
    const nameWords = new Set(words(item.name));
    const optSaid = new Set([...said].filter((w) => !nameWords.has(w)));
    const picked = [];
    let missing = false;
    const walk = (groups) => {
      for (const g of groups) {
        const scored = g.options.map((o) => ({ o, f: fit(o.name, optSaid) })).filter((x) => x.f >= 0.99);
        let chosen = scored.map((x) => x.o);
        if (g.max != null && chosen.length > g.max) chosen = chosen.slice(0, g.max);
        if (chosen.length < g.min) {
          if (g.min === 1 && g.options.length === 1) chosen = [g.options[0]];
          else { missing = true; ask.push(`For ${item.name}, ask the caller to choose ${g.name}${g.min > 1 ? ` (${g.min})` : ''}: ${g.options.map((o) => o.name + (o.price_cents ? ` (+$${(o.price_cents / 100).toFixed(2)})` : '')).join(', ')}.`); continue; }
        }
        for (const o of chosen) { picked.push(o.id); walk(o.groups ?? []); }
      }
    };
    walk(item.groups ?? []);
    const note = (rest.match(/\b(no|without|extra|light|easy on|on the side|add|sub|allerg\w*)\b.*$/i)?.[0] ?? '').slice(0, 200);
    if (missing) continue;
    if (qty < 1 || qty > 50) { ask.push(`Check the quantity for ${item.name}.`); continue; }
    lines.push({ id: item.id, qty, options: picked, note });
  }
  return { lines, ask };
}

/** The pickup slot for "asap", "6:30 pm", "in 45 minutes" or "tomorrow at noon": the first offered slot at or after it. */
export function pickSlot(slots, spoken, tz, now = new Date()) {
  if (!slots.length) return null;
  const s = String(spoken ?? '').toLowerCase().trim();
  if (!s || /asap|soon|now|earliest|right away|whenever/.test(s)) return slots[0];
  let target;
  const mins = s.match(/in\s+(\d+)\s*(min|minute|hour|hr)/);
  if (mins) target = now.getTime() + +mins[1] * (/h/.test(mins[2]) ? 60 : 1) * 60000;
  else {
    const t = s.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/) ?? (/noon/.test(s) ? [null, '12', '00', 'pm'] : null);
    if (!t) return null;
    let h = +t[1]; const m = +(t[2] ?? 0), mer = t[3] ?? '';
    if (h > 23 || m > 59) return null;
    if (mer.startsWith('p') && h < 12) h += 12;
    else if (mer.startsWith('a') && h === 12) h = 0;
    else if (!mer && h >= 1 && h <= 9) h += 12; // "6:30" means evening at a restaurant
    const z = zoned(now, tz);
    const dayOff = /tomorrow/.test(s) ? 1 : 0;
    const want = h * 60 + m + dayOff * 1440;
    target = now.getTime() + (want - z.minutes) * 60000;
    if (target < now.getTime() - 10 * 60000) return null; // that time already passed today
  }
  return slots.find((x) => Date.parse(x) >= target - 60000) ?? null;
}

/** Allowed kitchen moves. */
export const NEXT = { new: ['accepted', 'cancelled'], accepted: ['ready', 'cancelled'], ready: ['completed', 'cancelled'] };

export { DAYS };
