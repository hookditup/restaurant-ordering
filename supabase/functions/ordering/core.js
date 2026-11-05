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

/** hours = {mon:[["10:30","21:00"]]}. End time is exclusive. */
export function isOpenAt(hours, date, tz) {
  const z = zoned(date, tz);
  return (hours?.[z.day] ?? []).some(([a, b]) => z.minutes >= toMin(a) && z.minutes < toMin(b));
}

/** A category with no hours of its own follows the restaurant. */
export function categoryOpenAt(category, restaurant, date) {
  const tz = restaurant.timezone;
  return isOpenAt(restaurant.hours, date, tz) && (!category.hours || isOpenAt(category.hours, date, tz));
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

/** Pickup times on 15-minute marks, today and the next two days, grouped by nothing: a flat list. */
export function pickupSlots(restaurant, now = new Date(), days = 3) {
  const tz = restaurant.timezone;
  const earliest = now.getTime() + restaurant.pickup_lead_minutes * 60000;
  const lastGap = restaurant.last_order_minutes_before_close ?? 0;
  const out = [];
  for (let n = 0; n < days + 1 && out.length < 200; n++) {
    const z = zoned(new Date(now.getTime() + n * 86400000), tz);
    if (n === days) break;
    for (const [a, b] of restaurant.hours?.[z.day] ?? []) {
      for (let m = Math.ceil(toMin(a) / 15) * 15; m < toMin(b) - lastGap; m += 15) {
        const t = instantFor(z.ymd, m, tz);
        if (t.getTime() >= earliest) out.push(t.toISOString());
      }
    }
  }
  return out;
}

/** Is this exact pickup time on offer? Guards against tampered requests. */
export function validPickup(restaurant, iso, now = new Date()) {
  return pickupSlots(restaurant, now).includes(new Date(iso).toISOString());
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
  return { unit_cents: item.price_cents + extras, options };
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
    const { unit_cents, options } = priceLine(hit.item, l.options);
    out.push({
      menu_item_id: hit.item.id, name: hit.item.name, qty, unit_price_cents: unit_cents,
      line_total_cents: unit_cents * qty, options, note: String(l.note ?? '').replace(/[<>]/g, '').trim().slice(0, 200) || null,
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

/** Allowed kitchen moves. */
export const NEXT = { new: ['accepted', 'cancelled'], accepted: ['ready', 'cancelled'], ready: ['completed', 'cancelled'] };

export { DAYS };
