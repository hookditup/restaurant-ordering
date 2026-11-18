import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clover, square, cloudprnt, ticketText, testTicket, PosError } from '../supabase/functions/pos/adapters.js';

const order = {
  id: '11111111-2222-3333-4444-555555555555', order_no: '1070', fulfillment: 'pickup', pickup_at: '2026-11-20T19:30:00Z',
  first_name: 'Ana', last_name: 'Ruiz', phone: '+14355550100', email: 'ana@example.com', note: 'Extra napkins', test_mode: false,
  restaurant: { name: "Lupita's Valley", timezone: 'America/Denver' },
  items: [
    { name: 'Street Tacos', qty: 2, unit_price_cents: 1299, line_total_cents: 2598, options: [{ name: 'Carne Asada' }, { name: 'Corn Tortillas' }], note: 'No onion' },
    { name: 'Horchata', qty: 1, unit_price_cents: 450, line_total_cents: 450, options: [], note: null },
  ],
  subtotal_cents: 3048, discount_cents: 300, guest_fee_cents: 0, delivery_fee_cents: 0, tax_cents: 197, tip_cents: 400, total_cents: 3345,
};
const fake = (responses) => {
  const calls = [];
  const http = async (method, url, init) => { calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers }); const r = responses.shift() ?? { ok: true, status: 200, json: {} }; return r; };
  return { http, calls };
};

test('Clover: creates the order, adds each item at the online price, discount, then prints', async () => {
  const f = fake([{ ok: true, status: 200, json: { id: 'ORD1' } }]);
  const res = await clover.send({ settings: { merchant_id: 'ABC123DEF4', env: 'sandbox', order_type_id: 'OT1' }, token: 't', http: f.http }, order);
  assert.equal(res.external_id, 'ORD1');
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url.replace('https://apisandbox.dev.clover.com/v3/merchants/ABC123DEF4', '')}`),
    ['POST /orders', 'POST /orders/ORD1/bulk_line_items', 'POST /orders/ORD1/discounts', 'POST /print_event']);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer t');
  assert.deepEqual(f.calls[0].body.orderType, { id: 'OT1' });
  assert.match(f.calls[0].body.note, /PAID ONLINE \$33\.45/);
  const items = f.calls[1].body.items;
  assert.equal(items.length, 3); // 2 tacos + 1 horchata
  assert.deepEqual(items[0], { name: 'Street Tacos', price: 1299, note: 'Carne Asada, Corn Tortillas | No onion' });
  assert.equal(f.calls[2].body.amount, -300);
  assert.deepEqual(f.calls[3].body, { orderRef: { id: 'ORD1' } });
});

test('Clover: production URL, and a clear error for a bad merchant id or API failure', async () => {
  const f = fake([{ ok: true, status: 200, json: { name: 'Tacos El Guero' } }]);
  assert.match(await clover.test({ settings: { merchant_id: 'ABC123DEF4' }, token: 't', http: f.http }), /Tacos El Guero/);
  assert.match(f.calls[0].url, /^https:\/\/api\.clover\.com\//);
  await assert.rejects(clover.test({ settings: { merchant_id: 'x' }, token: 't', http: f.http }), PosError);
  const bad = fake([{ ok: false, status: 401, json: { message: 'Unauthorized' } }]);
  await assert.rejects(clover.test({ settings: { merchant_id: 'ABC123DEF4' }, token: 't', http: bad.http }), /401: The token was not accepted/);
});

test('Square: order totals match the online charge, then an external payment with the tip', async () => {
  const f = fake([{ ok: true, status: 200, json: { order: { id: 'SQ1', total_money: { amount: 2945, currency: 'USD' } } } }, { ok: true, status: 200, json: { payment: { id: 'P1' } } }]);
  const res = await square.send({ settings: { location_id: 'L8XYZ123', env: 'sandbox' }, token: 't', http: f.http }, order);
  assert.equal(res.external_id, 'SQ1');
  const [o, pay] = f.calls;
  assert.equal(o.url, 'https://connect.squareupsandbox.com/v2/orders');
  assert.equal(o.body.idempotency_key, `order-${order.id}`);
  assert.deepEqual(o.body.order.line_items[0], { name: 'Street Tacos', quantity: '2', base_price_money: { amount: 1299, currency: 'USD' }, note: 'Carne Asada, Corn Tortillas | No onion' });
  assert.equal(o.body.order.discounts[0].amount_money.amount, 300);
  assert.equal(o.body.order.service_charges[0].amount_money.amount, 197);
  assert.equal(o.body.order.fulfillments[0].pickup_details.recipient.display_name, 'Ana Ruiz');
  assert.equal(pay.body.source_id, 'EXTERNAL');
  assert.equal(pay.body.amount_money.amount, 2945);
  assert.equal(pay.body.tip_money.amount, 400);
  assert.equal(pay.body.order_id, 'SQ1');
});

test('Square: stops before paying if Square adds up differently', async () => {
  const f = fake([{ ok: true, status: 200, json: { order: { id: 'SQ2', total_money: { amount: 2950 } } } }]);
  await assert.rejects(square.send({ settings: { location_id: 'L8XYZ123' }, token: 't', http: f.http }, order), /not marked paid/);
  assert.equal(f.calls.length, 1);
});

test('Square: delivery orders send the address', () => {
  const body = square.orderBody({ settings: { location_id: 'L1' } }, { ...order, fulfillment: 'delivery', delivery_fee_cents: 599, delivery_address: { street: '12 Main St', unit: '', city: 'Heber City', state: 'UT', zip: '84032', instructions: 'Gate code 12' } });
  const d = body.order.fulfillments[0];
  assert.equal(d.type, 'DELIVERY');
  assert.equal(d.delivery_details.recipient.address.postal_code, '84032');
  assert.ok(body.order.service_charges.some((s) => s.name === 'Delivery fee' && s.amount_money.amount === 599));
});

test('Kitchen ticket: fits the paper width and shows everything the cook needs', () => {
  const t = ticketText(order, 32);
  for (const line of t.split('\n')) assert.ok(line.length <= 32, `too wide: "${line}"`);
  for (const s of ['ONLINE ORDER #1070', 'PICKUP', 'Ana Ruiz', '2 x Street Tacos', '+ Carne Asada', 'NOTE: No onion', 'ORDER NOTE: Extra napkins', 'PAID ONLINE']) assert.ok(t.includes(s), s);
  assert.match(t, /TOTAL\s+\$33\.45/);
  assert.match(testTicket('Lupita', 42), /TEST ORDER/);
});

test('Cloud printer: no POS needed; jobs wait for the printer', async () => {
  assert.deepEqual(await cloudprnt.send(), { external_id: null, waitForPrinter: true });
});
