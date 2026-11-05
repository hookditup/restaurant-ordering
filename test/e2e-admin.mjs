// End-to-end checks for the admin, Popular, pairings and delivery on a deployed test restaurant.
// Usage: URL=... KEY=... STAFF_EMAIL=... STAFF_PASSWORD=... node test/e2e-admin.mjs
import assert from 'node:assert/strict';

const { URL: U, KEY, STAFF_EMAIL, STAFF_PASSWORD } = process.env;
const restaurant = 'lupitas-valley';
let n = 0; const ok = (name) => console.log(`ok ${++n} ${name}`);
const fn = (body, token) => fetch(`${U}/functions/v1/ordering`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ restaurant, ...body }) }).then(async (r) => ({ http: r.status, ...(await r.json()) }));
const auth = await fetch(`${U}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD }) }).then((x) => x.json());
const T = auth.access_token; assert.ok(T);
const rpc = (name, args, token = T) => fetch(`${U}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
const get = (name, args, token) => rpc(name, args, token).then((r) => r.json());
const menu = () => fetch(`${U}/rest/v1/rpc/get_menu`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_slug: restaurant }) }).then((x) => x.json());

let m = await menu(); const rid = m.restaurant.id;
for (const [name, args] of [['admin_stats', { p_restaurant: rid, p_days: 30 }], ['admin_menu', { p_restaurant: rid }], ['admin_save_settings', { p_restaurant: rid, p: {} }], ['admin_set_pairs', { p_item: rid, p_pairs: [] }]]) {
  assert.ok((await rpc(name, args, KEY)).status >= 400);
}
ok('admin functions refuse guests');
assert.ok((await rpc('popular_names', { rid }, KEY)).status >= 400); ok('popular_names is not public');

assert.deepEqual([...m.popular].sort(), ['Camarones a la Diabla', 'Chiles Rellenos', 'Enchiladas Catalinas', 'Enchiladas Suizas', 'Mole Micha-Poblano', 'Sopes']); ok('Popular falls back to Featured');
const tradDinner = m.categories.filter((c) => c.name === 'Traditional Dishes')[1];
const tacos = tradDinner.items.find((i) => i.name === 'Tacos');
assert.equal(tacos.pairs.length, 4); ok('menu carries pairings');

const stats = await get('admin_stats', { p_restaurant: rid, p_days: 30 });
assert.ok(stats.orders >= 1); assert.ok(stats.sales_cents > 0); assert.ok(stats.top_items.length > 0); assert.ok(stats.by_hour.length > 0); ok(`stats: ${stats.orders} orders, ${stats.sales_cents} cents`);

// menu editor
const am = await get('admin_menu', { p_restaurant: rid });
const nachos = am.categories.flatMap((c) => c.items).find((i) => i.name === 'Nachos');
assert.equal((await rpc('admin_save_item', { p_item: nachos.id, p: { price_cents: nachos.price_cents + 100, available: true } })).status, 204);
m = await menu(); assert.equal(m.categories.flatMap((c) => c.items).find((i) => i.name === 'Nachos').price_cents, nachos.price_cents + 100); ok('price edit reaches the menu');
await rpc('admin_save_item', { p_item: nachos.id, p: { price_cents: nachos.price_cents, available: false } });
m = await menu(); assert.equal(m.categories.flatMap((c) => c.items).find((i) => i.name === 'Nachos'), undefined); ok('sold out hides the item');
await rpc('admin_save_item', { p_item: nachos.id, p: { available: true } }); ok('item restored');

const group = am.groups.find((g) => g.options.some((o) => o.name === 'Avocado'));
const opt = group.options.find((o) => o.name === 'Avocado');
assert.equal((await rpc('admin_save_option', { p_option: opt.id, p: { price_cents: opt.price_cents + 1 } })).status, 204);
await rpc('admin_save_option', { p_option: opt.id, p: { price_cents: opt.price_cents } }); ok('choice price edit');

const before = tacos.pairs;
assert.equal((await rpc('admin_set_pairs', { p_item: tacos.id, p_pairs: before.slice(0, 2) })).status, 204);
m = await menu();
const both = m.categories.filter((c) => c.name === 'Traditional Dishes').map((c) => c.items.find((i) => i.name === 'Tacos').pairs.length);
assert.deepEqual(both, [2, 2]); ok('pairings apply to lunch and dinner');
await rpc('admin_set_pairs', { p_item: tacos.id, p_pairs: before });

// delivery
const s = await fn({ action: 'slots' });
assert.equal(s.delivery_mode, 'test'); assert.ok(s.delivery_slots.length > 5);
const tz = m.restaurant.timezone;
const local = (iso) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return +p.hour * 60 + +p.minute; };
const dinner = s.delivery_slots.find((x) => local(x) >= 17 * 60);
const pick = (name) => tacos.groups.flatMap((g) => g.options).find((o) => o.name === name).id;
const items = [{ id: tacos.id, qty: 1, options: [pick('Carnitas'), pick('Fries')] }];
const address = { street: '100 N Main St', unit: '', city: 'Heber City', zip: '84032', instructions: 'Leave at door' };
const guest = { first_name: 'Dee', last_name: 'Livery', phone: '4355550111', email: 'test@example.com' };

let q = await fn({ action: 'quote', pickup_at: dinner, items, fulfillment: 'delivery', address, phone: guest.phone });
assert.equal(q.delivery_fee_cents, 599); assert.equal(q.tax_cents, Math.round(q.subtotal_cents * 0.0865)); assert.equal(q.total_cents, q.subtotal_cents + q.tax_cents + 599); ok('delivery fee quoted, not taxed');
q = await fn({ action: 'quote', pickup_at: dinner, items, fulfillment: 'delivery', address: { ...address, zip: '90210' }, phone: guest.phone });
assert.equal(q.ok, false); ok('out-of-area address refused');
const r0 = await fn({ action: 'checkout', pickup_at: dinner, items, guest, fulfillment: 'delivery', address: { ...address, zip: '1' } }); assert.equal(r0.ok, false); ok('bad ZIP refused');
const first = s.slots[0];
if (new Date(first) < new Date(s.delivery_slots[0])) { const r1 = await fn({ action: 'checkout', pickup_at: first, items, guest, fulfillment: 'delivery', address }); assert.equal(r1.ok, false); ok('delivery lead time enforced'); }

const r = await fn({ action: 'checkout', pickup_at: dinner, items, guest, fulfillment: 'delivery', address });
assert.ok(r.ok, JSON.stringify(r));
let st = await fn({ action: 'status', token: r.token }); assert.equal(st.order.fulfillment, 'delivery'); assert.equal(st.order.delivery_fee_cents, 599); assert.equal(st.order.delivery_address.city, 'Heber City'); ok('delivery order saved');
const row = (await (await fetch(`${U}/rest/v1/orders?select=id&token=eq.${r.token}`, { headers: { apikey: KEY, Authorization: `Bearer ${T}` } })).json())[0];
assert.equal((await fn({ action: 'kitchen', order_id: row.id, move: 'accept' }, T)).status, 'accepted');
st = await fn({ action: 'status', token: r.token }); assert.equal(st.order.delivery_status, 'test'); ok('accept sends the test driver');
await fn({ action: 'kitchen', order_id: row.id, move: 'ready' }, T); await fn({ action: 'kitchen', order_id: row.id, move: 'complete' }, T);
const after = await get('admin_stats', { p_restaurant: rid, p_days: 30 });
assert.ok(after.delivery_orders >= 1); assert.ok(after.delivery_fee_cents >= 599); ok('stats count delivery');

const settings = await (await fetch(`${U}/rest/v1/restaurants?select=popular_min_orders,hours&id=eq.${rid}`, { headers: { apikey: KEY, Authorization: `Bearer ${T}` } })).json();
await rpc('admin_save_settings', { p_restaurant: rid, p: { popular_min_orders: 1, hours: settings[0].hours } });
m = await menu(); assert.ok(m.popular.includes('Tacos')); ok('Popular ranks real orders once there are enough');
await rpc('admin_save_settings', { p_restaurant: rid, p: { popular_min_orders: settings[0].popular_min_orders } });

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const path = `menu-images/${rid}/test-heber-city-${Date.now()}.png`;
const up = await fetch(`${U}/storage/v1/object/${path}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${T}`, 'Content-Type': 'image/png' }, body: png });
assert.equal(up.status, 200, await up.text().catch(() => '')); ok('manager can upload a photo');
const no = await fetch(`${U}/storage/v1/object/menu-images/${rid}/x.png`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'image/png' }, body: png });
assert.ok(no.status >= 400); ok('guests cannot upload');
console.log(`all ${n} passed`);
