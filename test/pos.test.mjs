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

// ---------- menu sync ----------
import { planSync, normName } from '../supabase/functions/pos/adapters.js';
const local = {
  items: [{ id: 'a', name: 'Taco', available: true }, { id: 'b', name: '(3) Quesabirria Tacos with Consome', available: true }, { id: 'c', name: 'Horchata', available: false }, { id: 'd', name: 'Mystery Plate', available: true }],
  options: [{ id: 'o1', name: 'Asada', available: true }, { id: 'o2', name: 'Asada', available: true }, { id: 'o3', name: 'Pastor', available: true }],
};
const cat = (over = {}) => ({
  items: [{ id: 'P1', name: 'TACO', available: over.taco ?? true }, { id: 'P2', name: 'Quesabirria Tacos with Consomé', available: true }, { id: 'P3', name: 'Horchata', available: over.horchata ?? true }],
  options: [{ id: 'M1', name: 'asada', available: over.asada ?? true }, { id: 'M2', name: 'Asada', available: true }, { id: 'M3', name: 'Pastor', available: true }],
});

test('Menu sync: names match loosely; unknown dishes are listed, not guessed', () => {
  assert.equal(normName('(3) Quesabirria Tacos with Consome'), normName('Quesabirria Tacos with Consomé'));
  const p = planSync(local, cat(), []);
  assert.deepEqual(p.links.map((l) => [l.item_id, l.pos_id]), [['a', 'P1'], ['b', 'P2'], ['c', 'P3']]);
  assert.deepEqual(p.unmatched, ['Mystery Plate']);
  assert.equal(p.matched, 3);
});

test('Menu sync: first run does not undo a sold-out set by hand, but does apply POS sold-outs', () => {
  const p = planSync(local, cat({ taco: false }), []);
  assert.deepEqual(p.items, [{ id: 'a', name: 'Taco', available: false }]); // Horchata stays sold out here even though Clover says available
});

test('Menu sync: only acts when the POS changes', () => {
  const links = [{ item_id: 'a', pos_id: 'P1', auto: true, last_pos_available: true }, { item_id: 'c', pos_id: 'P3', auto: true, last_pos_available: true }];
  assert.deepEqual(planSync(local, cat(), links).items, []); // nothing changed on Clover → leave our admin's choice alone
  assert.deepEqual(planSync(local, cat({ taco: false }), links).items, [{ id: 'a', name: 'Taco', available: false }]);
  const back = planSync({ ...local, items: local.items.map((i) => (i.id === 'a' ? { ...i, available: false } : i)) }, cat(), [{ ...links[0], last_pos_available: false }]);
  assert.deepEqual(back.items, [{ id: 'a', name: 'Taco', available: true }]);
});

test('Menu sync: staff links win; "not on the POS" is never auto-matched', () => {
  const p = planSync(local, cat({ taco: false }), [{ item_id: 'a', pos_id: null, auto: false, last_pos_available: null }, { item_id: 'd', pos_id: 'P3', auto: false, last_pos_available: true }]);
  assert.ok(!p.items.some((i) => i.id === 'a'));
  assert.ok(!p.links.some((l) => l.item_id === 'a' || l.item_id === 'd'));
  assert.equal(p.unmatched.includes('Mystery Plate'), false);
});

test('Menu sync: a choice is sold out if any POS modifier with that name is', () => {
  const p = planSync(local, cat({ asada: false }), [], { asada: true, pastor: true });
  assert.deepEqual(p.options.map((o) => [o.id, o.available]), [['o1', false], ['o2', false]]);
  assert.equal(p.optionStates.asada, false);
  assert.deepEqual(planSync(local, cat(), [], { asada: true }).options, []); // no change
});

test('Clover catalog: pages through items and modifier groups, skips deleted', async () => {
  const page = (n, start) => Array.from({ length: n }, (_, k) => ({ id: `I${start + k}`, name: `Item ${start + k}`, available: k !== 0 }));
  const f = fake([
    { ok: true, status: 200, json: { elements: page(100, 0) } }, { ok: true, status: 200, json: { elements: [...page(2, 100), { id: 'X', name: 'Gone', deleted: true }] } },
    { ok: true, status: 200, json: { elements: [{ id: 'G1', modifiers: { elements: [{ id: 'M1', name: 'Asada', available: false }, { id: 'M2', name: 'Old', deleted: true }] } }] } },
  ]);
  const c = await clover.catalog({ settings: { merchant_id: 'ABC123DEF4', env: 'sandbox' }, token: 't', http: f.http });
  assert.equal(c.items.length, 102);
  assert.equal(c.items[0].available, false);
  assert.deepEqual(c.options, [{ id: 'M1', name: 'Asada', available: false }]);
  assert.match(f.calls[0].url, /\/items\?limit=100&offset=0$/);
  assert.match(f.calls[1].url, /offset=100$/);
  assert.match(f.calls[2].url, /\/modifier_groups\?expand=modifiers&limit=100&offset=0$/);
});

// ---------- Toast ----------
import { toast } from '../supabase/functions/pos/adapters.js';
const G = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const toastSettings = { api_host: 'ws-sandbox-api.example.com', restaurant_guid: G(1), client_id: 'cid', dining_option_guid: G(2), payment_type_guid: G(3) };
const toastMenuJson = {
  menus: [{ guid: G(10), menuGroups: [{ guid: G(11), menuItems: [{ guid: G(20), name: 'Street Tacos', modifierGroupReferences: [1] }],
    menuGroups: [{ guid: G(12), menuItems: [{ guid: G(21), name: 'Horchata', modifierGroupReferences: [] }] }] }] }],
  modifierGroupReferences: { 1: { guid: G(30), name: 'Meat', modifierOptionReferences: [5, 6] } },
  modifierOptionReferences: { 5: { guid: G(40), name: 'Carne Asada' }, 6: { guid: G(41), name: 'Pastor' } },
};
const toastOrder = { ...order, items: [{ ...order.items[0], menu_item_id: 'L1', options: [{ name: 'Carne Asada' }, { name: 'Corn Tortillas' }] }, { ...order.items[1], menu_item_id: 'L2' }] };
const toastCalls = (priceCents) => [
  { ok: true, status: 200, json: { token: { accessToken: 'JWT' } } },
  { ok: true, status: 200, json: toastMenuJson },
  { ok: true, status: 200, json: [{ guid: G(21), status: 'OUT_OF_STOCK' }] },
  { ok: true, status: 200, json: { checks: [{ totalAmount: priceCents / 100 }] } },
  { ok: true, status: 200, json: { guid: 'TOAST-ORDER-1' } },
];

test('Toast: logs in, prices the order, then sends it with an Other payment and the tip', async () => {
  const f = fake(toastCalls(2945));
  const links = new Map([['L1', G(20)], ['L2', G(21)]]);
  const res = await toast.send({ settings: toastSettings, token: 'secret', http: f.http, links }, toastOrder);
  assert.equal(res.external_id, 'TOAST-ORDER-1');
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url.replace('https://ws-sandbox-api.example.com', '')}`),
    ['POST /authentication/v1/authentication/login', 'GET /menus/v2/menus', 'GET /stock/v1/inventory', 'POST /orders/v2/prices', 'POST /orders/v2/orders']);
  assert.deepEqual(f.calls[0].body, { clientId: 'cid', clientSecret: 'secret', userAccessType: 'TOAST_MACHINE_CLIENT' });
  assert.equal(f.calls[1].headers.Authorization, 'Bearer JWT');
  assert.equal(f.calls[1].headers['Toast-Restaurant-External-ID'], G(1));
  const sent = f.calls[4].body, chk = sent.checks[0], [tacos, drink] = chk.selections;
  assert.equal(sent.diningOption.guid, G(2));
  assert.equal(sent.externalId, `online-${order.id}`);
  assert.deepEqual(chk.customer, { entityType: 'Customer', firstName: 'Ana', lastName: 'Ruiz', phone: '4355550100', email: 'ana@example.com' });
  assert.deepEqual([tacos.item.guid, tacos.itemGroup.guid, tacos.quantity], [G(20), G(11), 2]);
  assert.deepEqual(tacos.modifiers[0], { entityType: 'MenuItemSelection', item: { guid: G(40) }, optionGroup: { guid: G(30) }, quantity: 1 });
  assert.deepEqual(tacos.modifiers[1], { entityType: 'MenuItemSelection', selectionType: 'SPECIAL_REQUEST', displayName: 'Corn Tortillas | No onion' }); // unmatched choice + note reach the kitchen
  assert.equal(drink.itemGroup.guid, G(12)); // nested menu group
  assert.equal(f.calls[3].body.checks[0].payments, undefined); // priced before paying
  assert.deepEqual(chk.payments, [{ type: 'OTHER', otherPayment: { guid: G(3) }, amount: 29.45, tipAmount: 4, amountTendered: 29.45 }]);
});

test('Toast: refuses when Toast prices differ, and names unmatched dishes', async () => {
  const f = fake(toastCalls(2999));
  const links = new Map([['L1', G(20)], ['L2', G(21)]]);
  await assert.rejects(toast.send({ settings: toastSettings, token: 's', http: f.http, links }, toastOrder), /Toast prices this order at \$29\.99; the guest paid \$29\.45/);
  assert.equal(f.calls.length, 4); // never posted the order
  const g = fake(toastCalls(2945));
  await assert.rejects(toast.send({ settings: toastSettings, token: 's', http: g.http, links: new Map([['L1', G(20)]]) }, toastOrder), /"Horchata" isn't matched to a Toast item/);
  await assert.rejects(toast.send({ settings: { ...toastSettings, payment_type_guid: '' }, token: 's', http: g.http }, toastOrder), /payment type/);
});

test('Toast: catalog for menu sync reads sold-out from the stock API', async () => {
  const f = fake(toastCalls(0));
  const c = await toast.catalog({ settings: toastSettings, token: 's', http: f.http });
  assert.deepEqual(c.items.map((i) => [i.name, i.available]), [['Street Tacos', true], ['Horchata', false]]);
  assert.deepEqual(c.options.map((o) => o.name), ['Carne Asada', 'Pastor']);
});
