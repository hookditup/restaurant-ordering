// POS connectors. Every connector takes the same order shape and does the same jobs:
//   test(ctx)          check the connection works; returns a short description
//   send(ctx, order)   put a paid online order into the POS / printer; returns { external_id }
// ctx = { settings, token, http } where http(method, url, { headers, body }) -> { ok, status, json }.
// Adding a POS = adding one object here. Prices are sent exactly as charged online,
// so the POS shows what the guest paid even when its own menu prices differ.

export class PosError extends Error {}

const money = (c) => `$${(c / 100).toFixed(2)}`;
const optText = (l) => (l.options || []).map((o) => o.name).join(', ');
const lineNote = (l) => [optText(l), l.note].filter(Boolean).join(' | ').slice(0, 255);
const guestName = (o) => `${o.first_name} ${o.last_name}`.trim();
const when = (iso, tz) => new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

async function call(ctx, method, url, body, headers) {
  const r = await ctx.http(method, url, { headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    const j = r.json || {};
    if (r.status === 401 || r.status === 403) throw new PosError(`${r.status}: The token was not accepted. Check it belongs to this account, and that Live or Sandbox matches the token.`);
    if (r.status === 404) throw new PosError('404: Not found. Check the ID (Merchant ID or Location ID), and that Live or Sandbox matches.');
    const msg = j.message || j.errors?.[0]?.detail || j.errors?.[0]?.code || j.error || `HTTP ${r.status}`;
    throw new PosError(`${r.status}: ${String(msg).slice(0, 200)}`);
  }
  return r.json || {};
}

// ---------- kitchen ticket (CloudPRNT text, and the order note elsewhere) ----------
export function ticketText(o, width = 42) {
  const w = Math.max(24, Math.min(64, width | 0 || 42));
  const line = '-'.repeat(w);
  const center = (s) => { s = String(s).slice(0, w); const pad = Math.floor((w - s.length) / 2); return ' '.repeat(pad) + s; };
  const wrap = (s, indent = '') => {
    const out = []; let cur = '';
    for (const word of String(s).split(/\s+/).filter(Boolean)) {
      if ((cur + ' ' + word).trim().length > w - indent.length) { out.push(indent + cur.trim()); cur = word; } else cur += ' ' + word;
    }
    if (cur.trim()) out.push(indent + cur.trim());
    return out;
  };
  const lr = (a, b) => { a = String(a); b = String(b); const room = w - b.length - 1; return (a.length > room ? a.slice(0, room) : a.padEnd(room)) + ' ' + b; };
  const rows = [
    center(o.restaurant.name), center(`ONLINE ORDER #${o.order_no}`), line,
    `${o.fulfillment === 'delivery' ? 'DELIVERY' : 'PICKUP'}: ${when(o.pickup_at, o.restaurant.timezone)}`,
    guestName(o), o.phone || '',
  ];
  if (o.fulfillment === 'delivery' && o.delivery_address) {
    const a = o.delivery_address;
    rows.push(...wrap(`${a.street}${a.unit ? ` ${a.unit}` : ''}, ${a.city} ${a.zip}`));
    if (a.instructions) rows.push(...wrap(`Note: ${a.instructions}`));
  }
  if (o.test_mode) rows.push(center('*** TEST ORDER ***'));
  rows.push(line);
  for (const l of o.items) {
    rows.push(...wrap(`${l.qty} x ${l.name}`));
    for (const opt of l.options || []) rows.push(...wrap(`+ ${opt.name}`, '    '));
    if (l.note) rows.push(...wrap(`NOTE: ${l.note}`, '    '));
  }
  if (o.note) { rows.push(line); rows.push(...wrap(`ORDER NOTE: ${o.note}`)); }
  rows.push(line, lr('Subtotal', money(o.subtotal_cents)));
  if (o.discount_cents) rows.push(lr('Discounts', `-${money(o.discount_cents)}`));
  if (o.delivery_fee_cents) rows.push(lr('Delivery', money(o.delivery_fee_cents)));
  if (o.guest_fee_cents) rows.push(lr('Service fee', money(o.guest_fee_cents)));
  rows.push(lr('Tax', money(o.tax_cents)));
  if (o.tip_cents) rows.push(lr('Tip', money(o.tip_cents)));
  rows.push(lr('TOTAL', money(o.total_cents)), center('PAID ONLINE'), '', '', '');
  return rows.join('\n') + '\n';
}

export const testTicket = (name, width = 42) => ticketText({
  restaurant: { name, timezone: 'America/Denver' }, order_no: 'TEST', fulfillment: 'pickup', pickup_at: new Date().toISOString(), first_name: 'Printer', last_name: 'Test', phone: '',
  test_mode: true, items: [{ qty: 1, name: 'Test ticket', options: [{ name: 'If you can read this, printing works' }] }], subtotal_cents: 0, tax_cents: 0, total_cents: 0,
}, width);

// ---------- Clover ----------
// REST: https://docs.clover.com (orders, line items, print_event). Token: a merchant API token or OAuth access token.
// Custom line items carry the exact online price; options and notes go on each line.
const cloverBase = (s) => (s.env === 'sandbox' ? 'https://apisandbox.dev.clover.com' : 'https://api.clover.com');
export const clover = {
  label: 'Clover',
  fields: ['merchant_id', 'env', 'order_type_id'],
  check(s, token) {
    if (!/^[A-Z0-9]{8,20}$/i.test(s.merchant_id || '')) throw new PosError('Enter the Clover Merchant ID (letters and numbers, found in your Clover web dashboard URL).');
    if (!token) throw new PosError('Add the Clover API token.');
  },
  async test(ctx) {
    clover.check(ctx.settings, ctx.token);
    const m = await call(ctx, 'GET', `${cloverBase(ctx.settings)}/v3/merchants/${ctx.settings.merchant_id}`, null, { Authorization: `Bearer ${ctx.token}` });
    return `Connected to ${m.name || 'Clover merchant'}${ctx.settings.env === 'sandbox' ? ' (sandbox)' : ''}.`;
  },
  async send(ctx, o) {
    clover.check(ctx.settings, ctx.token);
    const base = `${cloverBase(ctx.settings)}/v3/merchants/${ctx.settings.merchant_id}`, auth = { Authorization: `Bearer ${ctx.token}` };
    const note = `${o.fulfillment === 'delivery' ? 'DELIVERY' : 'PICKUP'} ${when(o.pickup_at, o.restaurant.timezone)} · ${guestName(o)} ${o.phone || ''} · PAID ONLINE ${money(o.total_cents)} (incl. tax${o.tip_cents ? `, ${money(o.tip_cents)} tip` : ''})${o.note ? ` · ${o.note}` : ''}`;
    const created = await call(ctx, 'POST', `${base}/orders`, {
      state: 'open', title: `Online #${o.order_no} ${guestName(o)}`.slice(0, 127), note: note.slice(0, 255),
      ...(ctx.settings.order_type_id ? { orderType: { id: ctx.settings.order_type_id } } : {}),
    }, auth);
    const items = [];
    for (const l of o.items) for (let i = 0; i < l.qty; i++) items.push({ name: l.name.slice(0, 127), price: l.unit_price_cents, ...(lineNote(l) ? { note: lineNote(l) } : {}) });
    await call(ctx, 'POST', `${base}/orders/${created.id}/bulk_line_items`, { items }, auth);
    if (o.discount_cents) await call(ctx, 'POST', `${base}/orders/${created.id}/discounts`, { name: 'Online discount', amount: -o.discount_cents }, auth);
    if (ctx.settings.print !== false) await call(ctx, 'POST', `${base}/print_event`, { orderRef: { id: created.id } }, auth);
    return { external_id: created.id };
  },
};

// Clover menu: every item and modifier with its sold-out flag (`available: false` = sold out).
// Pages of 100 until a short page; deleted items are skipped.
clover.catalog = async (ctx) => {
  clover.check(ctx.settings, ctx.token);
  const base = `${cloverBase(ctx.settings)}/v3/merchants/${ctx.settings.merchant_id}`, auth = { Authorization: `Bearer ${ctx.token}` };
  const all = async (path) => {
    const out = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = (await call(ctx, 'GET', `${base}${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`, null, auth)).elements || [];
      out.push(...page);
      if (page.length < 100) break;
    }
    return out.filter((x) => !x.deleted);
  };
  const items = (await all('/items')).map((i) => ({ id: i.id, name: i.name || '', available: i.available !== false }));
  const options = [];
  for (const g of await all('/modifier_groups?expand=modifiers')) {
    for (const m of g.modifiers?.elements || []) if (!m.deleted) options.push({ id: m.id, name: m.name || '', available: m.available !== false });
  }
  return { items, options };
};

// ---------- menu sync (any POS that has catalog()) ----------
// Names are compared loosely: case, accents, punctuation, "(3)" counts and extra spaces don't matter.
export const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\(\s*\d+\s*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// local: { items: [{id, name, available}], options: [{id, name, available}] }
// links: [{item_id, pos_id, auto, last_pos_available}]; optionStates: { normName: lastSeenAvailable }
// Returns what to write. A dish or choice only changes when the POS changes, so a sold-out set
// by hand in our admin isn't undone every 5 minutes.
export function planSync(local, catalog, links, optionStates = {}) {
  const posById = new Map(catalog.items.map((i) => [i.id, i]));
  const posByName = new Map();
  for (const i of catalog.items) { const k = normName(i.name); posByName.set(k, posByName.has(k) ? null : i); } // null = name used twice
  const localNames = new Map();
  for (const i of local.items) { const k = normName(i.name); localNames.set(k, (localNames.get(k) || 0) + 1); }
  const linkOf = new Map(links.map((l) => [l.item_id, l]));
  const out = { links: [], items: [], options: [], optionStates: {}, matched: 0, unmatched: [], missing: [] };
  for (const it of local.items) {
    let l = linkOf.get(it.id);
    if (!l || (l.auto && l.pos_id && !posById.has(l.pos_id))) {
      const k = normName(it.name), hit = localNames.get(k) === 1 ? posByName.get(k) : null;
      if (l && !hit) { out.links.push({ item_id: it.id, pos_id: null, auto: true, last_pos_available: null, drop: true }); l = null; }
      if (hit) { l = { item_id: it.id, pos_id: hit.id, auto: true, last_pos_available: null }; out.links.push({ ...l }); }
    }
    if (!l) { out.unmatched.push(it.name); continue; }
    if (!l.pos_id) continue; // staff said it isn't on the POS
    const p = posById.get(l.pos_id);
    if (!p) { out.missing.push(it.name); continue; }
    out.matched++;
    if (l.last_pos_available !== p.available) {
      const prev = out.links.find((x) => x.item_id === it.id);
      if (prev) prev.last_pos_available = p.available; else out.links.push({ item_id: it.id, pos_id: l.pos_id, auto: l.auto, last_pos_available: p.available });
      if (it.available !== p.available && (l.last_pos_available !== null || !p.available)) out.items.push({ id: it.id, name: it.name, available: p.available });
    }
  }
  // Choices by name: "Asada" sold out on the POS → every "Asada" choice here is sold out.
  const optAvail = new Map();
  for (const o of catalog.options) { const k = normName(o.name); optAvail.set(k, (optAvail.get(k) ?? true) && o.available); }
  for (const [k, avail] of optAvail) {
    out.optionStates[k] = avail;
    const before = optionStates[k];
    if (before === avail || (before === undefined && avail)) continue;
    for (const o of local.options) if (normName(o.name) === k && o.available !== avail) out.options.push({ id: o.id, name: o.name, available: avail });
  }
  return out;
}

// ---------- Square ----------
// Orders API + an EXTERNAL payment so the order appears in Square's order manager as paid.
// Note: Square bills the developer about 1% of external payment amounts.
const squareBase = (s) => (s.env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com');
const usd = (c) => ({ amount: c, currency: 'USD' });
export const square = {
  label: 'Square',
  fields: ['location_id', 'env'],
  check(s, token) {
    if (!/^[A-Z0-9]{6,40}$/i.test(s.location_id || '')) throw new PosError('Enter the Square Location ID (Square Dashboard > Account & Settings > Locations).');
    if (!token) throw new PosError('Add the Square access token.');
  },
  async test(ctx) {
    square.check(ctx.settings, ctx.token);
    const r = await call(ctx, 'GET', `${squareBase(ctx.settings)}/v2/locations/${ctx.settings.location_id}`, null, { Authorization: `Bearer ${ctx.token}` });
    return `Connected to ${r.location?.name || 'Square location'}${ctx.settings.env === 'sandbox' ? ' (sandbox)' : ''}.`;
  },
  orderBody(ctx, o) {
    const recipient = { display_name: guestName(o).slice(0, 255), ...(o.phone ? { phone_number: o.phone } : {}), ...(o.email ? { email_address: o.email } : {}) };
    const charges = [['Sales tax', o.tax_cents], ['Service fee', o.guest_fee_cents], ['Delivery fee', o.delivery_fee_cents]]
      .filter(([, c]) => c > 0).map(([name, c], i) => ({ uid: `sc${i}`, name, amount_money: usd(c), calculation_phase: 'SUBTOTAL_PHASE', taxable: false }));
    const a = o.delivery_address;
    const fulfillment = o.fulfillment === 'delivery'
      ? { type: 'DELIVERY', state: 'PROPOSED', delivery_details: { recipient: { ...recipient, ...(a ? { address: { address_line_1: a.street, address_line_2: a.unit || undefined, locality: a.city, administrative_district_level_1: a.state, postal_code: a.zip, country: 'US' } } : {}) }, deliver_at: o.pickup_at, note: a?.instructions || undefined } }
      : { type: 'PICKUP', state: 'PROPOSED', pickup_details: { recipient, pickup_at: o.pickup_at, note: o.note || undefined } };
    return {
      idempotency_key: `order-${o.id}`,
      order: {
        location_id: ctx.settings.location_id, reference_id: String(o.order_no), source: { name: 'Online ordering' },
        line_items: o.items.map((l) => ({ name: l.name.slice(0, 512), quantity: String(l.qty), base_price_money: usd(l.unit_price_cents), ...(lineNote(l) ? { note: lineNote(l) } : {}) })),
        ...(o.discount_cents ? { discounts: [{ uid: 'disc', name: 'Online discount', amount_money: usd(o.discount_cents), scope: 'ORDER' }] } : {}),
        ...(charges.length ? { service_charges: charges } : {}),
        fulfillments: [fulfillment],
      },
    };
  },
  async send(ctx, o) {
    square.check(ctx.settings, ctx.token);
    const base = squareBase(ctx.settings), auth = { Authorization: `Bearer ${ctx.token}` };
    const { order } = await call(ctx, 'POST', `${base}/v2/orders`, square.orderBody(ctx, o), auth);
    const expected = o.total_cents - o.tip_cents;
    if (order.total_money?.amount !== expected) throw new PosError(`Square totaled ${money(order.total_money?.amount ?? 0)}, online total was ${money(expected)}. Order ${order.id} was created but not marked paid.`);
    await call(ctx, 'POST', `${base}/v2/payments`, {
      idempotency_key: `pay-${o.id}`, source_id: 'EXTERNAL', external_details: { type: 'OTHER', source: 'Online ordering' },
      amount_money: usd(expected), ...(o.tip_cents ? { tip_money: usd(o.tip_cents) } : {}), order_id: order.id, location_id: ctx.settings.location_id,
      reference_id: String(o.order_no), note: `Online order #${o.order_no}`,
    }, auth);
    return { external_id: order.id };
  },
};

// ---------- Star CloudPRNT (any POS, or none) ----------
// The printer polls our URL; send() just leaves the job waiting. See the pos function for the protocol.
export const cloudprnt = {
  label: 'Cloud kitchen printer (Star CloudPRNT)',
  fields: ['width', 'copies'],
  check() {},
  async test() { return 'The printer picks up a test ticket on its next check-in (usually within a few seconds).'; },
  async send() { return { external_id: null, waitForPrinter: true }; },
};

export const PROVIDERS = { clover, square, cloudprnt };
