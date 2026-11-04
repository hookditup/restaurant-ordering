// End-to-end API checks against a deployed test restaurant.
// Usage: URL=... KEY=... STAFF_EMAIL=... STAFF_PASSWORD=... node test/e2e-api.mjs
import assert from 'node:assert/strict';

const { URL: U, KEY, STAFF_EMAIL, STAFF_PASSWORD } = process.env;
const slug = 'lupitas-valley';
const fn = (body, token) => fetch(`${U}/functions/v1/ordering`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ http: r.status, ...(await r.json()) }));
const rest = (path, token = KEY, init = {}) => fetch(`${U}/rest/v1/${path}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
let n = 0; const ok = (name) => console.log(`ok ${++n} ${name}`);

const menu = await fetch(`${U}/rest/v1/rpc/get_menu`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_slug: slug }) }).then((r) => r.json());
assert.equal(menu.categories.reduce((s, c) => s + c.items.length, 0), 86); ok('menu loads with 86 items');

const { slots } = await fn({ action: 'slots', restaurant: slug });
assert.ok(slots.length > 20); ok(`slots: ${slots.length}`);
const tz = menu.restaurant.timezone;
const localMin = (iso) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return +p.hour * 60 + +p.minute; };
const lunch = slots.find((s) => localMin(s) >= 11 * 60 && localMin(s) < 14 * 60);
const dinner = slots.find((s) => localMin(s) >= 17 * 60);
const trad = menu.categories.filter((c) => c.name === 'Traditional Dishes');
const lunchTacos = trad[0].items.find((i) => i.name === 'Tacos'), dinnerTacos = trad[1].items.find((i) => i.name === 'Tacos');
const pick = (i, name) => i.groups.flatMap((g) => g.options).find((o) => o.name === name).id;
const lunchLine = { id: lunchTacos.id, qty: 2, options: [pick(lunchTacos, 'Steak'), pick(lunchTacos, 'Fries')], price_cents: 1 };

let q = await fn({ action: 'quote', restaurant: slug, pickup_at: lunch, items: [lunchLine], tip_cents: 300 });
assert.equal(q.subtotal_cents, (899 + 449) * 2); assert.equal(q.tax_cents, Math.round(q.subtotal_cents * 0.0865)); assert.equal(q.total_cents, q.subtotal_cents + q.tax_cents + 300);
ok(`server price ignores tampered price: ${q.total_cents}`);

q = await fn({ action: 'quote', restaurant: slug, pickup_at: dinner, items: [lunchLine] });
assert.equal(q.ok, false); assert.match(q.error, /isn't available at that pickup/); ok('lunch item refused at dinner');

q = await fn({ action: 'quote', restaurant: slug, pickup_at: lunch, items: [{ id: lunchTacos.id, qty: 1, options: [] }] });
assert.equal(q.ok, false); assert.match(q.error, /Please choose/); ok('required choice enforced by server');

const guest = { first_name: 'Test', last_name: 'Guest', phone: '4355550100', email: 'test@example.com' };
let r = await fn({ action: 'checkout', restaurant: slug, pickup_at: '2026-11-08T19:00:00Z', items: [lunchLine], guest });
assert.equal(r.ok, false); assert.match(r.error, /no longer available/); ok('Sunday pickup refused');

r = await fn({ action: 'checkout', restaurant: slug, pickup_at: lunch, items: [lunchLine], guest: { ...guest, phone: '12' } });
assert.equal(r.ok, false); ok('bad phone refused');

r = await fn({ action: 'checkout', restaurant: slug, pickup_at: lunch, items: [lunchLine], tip_cents: 300, guest });
assert.ok(r.ok, JSON.stringify(r)); assert.ok(r.test); const token = r.token; ok(`test order placed #${r.order_no}`);

let s = await fn({ action: 'status', token });
assert.equal(s.order.status, 'new'); assert.equal(s.order.payment_status, 'test_paid'); assert.equal(s.order.items[0].options[0].name, 'Steak'); assert.ok(!('phone' in s.order)); ok('status page shows order without phone');

assert.equal((await fn({ action: 'status', token: 'deadbeef' })).ok, false); ok('wrong token refused');

// Anonymous visitors must not read or change anything.
let raw = await rest('orders?select=*'); assert.ok([401, 403].includes(raw.status) || (await raw.json()).length === 0); ok('anon cannot read orders');
raw = await rest('order_items?select=*'); assert.ok([401, 403].includes(raw.status) || (await raw.json()).length === 0); ok('anon cannot read order items');
raw = await rest('restaurants?select=*'); assert.ok([401, 403].includes(raw.status) || (await raw.json()).length === 0); ok('anon cannot read restaurant settings');
raw = await rest('orders', KEY, { method: 'POST', body: JSON.stringify({ first_name: 'x' }) }); assert.ok(raw.status >= 400); ok('anon cannot insert orders');
raw = await fetch(`${U}/rest/v1/rpc/import_menu`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{"p":{}}' }); assert.ok(raw.status >= 400); ok('anon cannot import menus');

const orderRow = async (t) => (await (await rest(`orders?select=id,status&token=eq.${token}`, t)).json())[0];
assert.equal((await fn({ action: 'kitchen', order_id: '00000000-0000-0000-0000-000000000000', move: 'accept' })).ok, false); ok('kitchen needs a real order');

const auth = await fetch(`${U}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD }) }).then((x) => x.json());
assert.ok(auth.access_token, JSON.stringify(auth).slice(0, 200)); ok('staff sign in');
const o = await orderRow(auth.access_token); assert.equal(o.status, 'new'); ok('staff can read orders');

const noAuth = await fn({ action: 'kitchen', order_id: o.id, move: 'accept' }); assert.equal(noAuth.http, 401); ok('kitchen action refused without sign-in');
assert.equal((await fn({ action: 'kitchen', order_id: o.id, move: 'complete' }, auth.access_token)).ok, false); ok('cannot skip steps');
for (const [move, want] of [['accept', 'accepted'], ['ready', 'ready'], ['complete', 'completed']]) {
  const k = await fn({ action: 'kitchen', order_id: o.id, move }, auth.access_token);
  assert.equal(k.status, want, JSON.stringify(k));
  assert.equal((await fn({ action: 'status', token })).order.status, want);
}
ok('accept, ready, complete');

r = await fn({ action: 'checkout', restaurant: slug, pickup_at: dinner, items: [{ id: dinnerTacos.id, qty: 1, options: [pick(dinnerTacos, 'Carnitas'), pick(dinnerTacos, 'Fries')], note: 'extra lime' }], guest });
assert.ok(r.ok, JSON.stringify(r)); const t2 = r.token;
const o2 = (await (await rest(`orders?select=id&token=eq.${t2}`, auth.access_token)).json())[0];
const c = await fn({ action: 'kitchen', order_id: o2.id, move: 'cancel', reason: 'Out of carnitas' }, auth.access_token);
assert.equal(c.status, 'cancelled'); s = await fn({ action: 'status', token: t2 }); assert.equal(s.order.cancel_reason, 'Out of carnitas'); ok('dinner order and cancel');

assert.equal((await fn({ action: 'pause', restaurant: slug, accepting: false }, auth.access_token)).accepting, false);
r = await fn({ action: 'checkout', restaurant: slug, pickup_at: lunch, items: [lunchLine], guest }); assert.equal(r.ok, false); assert.match(r.error, /paused/);
assert.equal((await fn({ action: 'pause', restaurant: slug, accepting: true }, auth.access_token)).accepting, true); ok('pause stops orders, resume restores');

console.log(`all ${n} passed`);
