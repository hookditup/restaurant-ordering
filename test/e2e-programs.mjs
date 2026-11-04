// End-to-end checks for forms, reservations, rewards and gift cards on a deployed test restaurant.
// Usage: URL=... KEY=... STAFF_EMAIL=... STAFF_PASSWORD=... node test/e2e-programs.mjs
import assert from 'node:assert/strict';

const { URL: U, KEY, STAFF_EMAIL, STAFF_PASSWORD } = process.env;
const restaurant = 'lupitas-valley';
const fn = (body, token) => fetch(`${U}/functions/v1/ordering`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ restaurant, ...body }) }).then(async (r) => ({ http: r.status, ...(await r.json()) }));
let n = 0; const ok = (name) => console.log(`ok ${++n} ${name}`);
const phone = `435555${String(Date.now()).slice(-4)}`;
const nextOpen = () => { const d = new Date(Date.now() + 2 * 86400000); while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const sunday = () => { const d = new Date(Date.now() + 86400000); while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

const auth = await fetch(`${U}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD }) }).then((x) => x.json());
const T = auth.access_token; assert.ok(T);
const staff = (op, x = {}) => fn({ action: 'staff', op, ...x }, T);

// forms
let r = await fn({ action: 'form', form: 'question', page: '/questions', data: { name: 'Test Guest', email: 'test@example.com', message: 'Do you have high chairs?' } });
assert.ok(r.ok); ok('question form accepted');
let m = await staff('messages'); const msg = m.rows.find((x) => x.data.message === 'Do you have high chairs?'); assert.ok(msg); ok('form appears for staff');
assert.ok((await staff('message', { id: msg.id })).ok); ok('message marked done');
assert.equal((await fn({ action: 'staff', op: 'messages' })).http, 401); ok('staff tools refuse guests');
for (const t of ['form_submissions', 'reservations', 'rewards_accounts', 'gift_cards']) {
  const raw = await fetch(`${U}/rest/v1/${t}?select=*`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  assert.ok([401, 403].includes(raw.status) || (await raw.json()).length === 0);
  const asStaff = await fetch(`${U}/rest/v1/${t}?select=*`, { headers: { apikey: KEY, Authorization: `Bearer ${T}` } });
  assert.ok([401, 403].includes(asStaff.status) || (await asStaff.json()).length === 0);
}
ok('tables closed to direct access');

// reservations
r = await fn({ action: 'form', form: 'reservation', data: { name: 'Res Guest', email: 'test@example.com', phone, date: sunday(), time: '6:00 PM', party_size: '3-4' } });
assert.equal(r.ok, false); ok('closed day refused');
r = await fn({ action: 'form', form: 'reservation', data: { name: 'Res Guest', email: 'test@example.com', phone, date: nextOpen(), time: '6:00 PM', party_size: '3-4', requests: 'Booth' } });
assert.ok(r.ok, JSON.stringify(r));
let rows = (await staff('reservations')).rows; const res = rows.find((x) => x.name === 'Res Guest'); assert.equal(res.status, 'requested'); ok('reservation request saved');
assert.equal((await staff('reservation', { id: res.id, move: 'confirm' })).status, 'confirmed'); ok('staff confirm');

// rewards
r = await fn({ action: 'form', form: 'rewards', data: { name: 'Rita Rewards', phone, email: 'test@example.com', sms_consent: 'yes' } });
const code = r.member.code; assert.equal(code.length, 8); ok('rewards join returns a code');
assert.ok((await fn({ action: 'form', form: 'rewards', data: { name: 'Someone', phone } })).existing); ok('second join does not reveal the code');
assert.equal((await fn({ action: 'rewards_check', phone, code })).points, 0);
assert.equal((await fn({ action: 'rewards_check', phone: '4355550199', code })).ok, false); ok('points check needs phone and code');

// gift cards
assert.equal((await fn({ action: 'gift_buy', amount_cents: 500, buyer_name: 'A', buyer_email: 'test@example.com' })).ok, false); ok('gift minimum enforced');
r = await fn({ action: 'gift_buy', amount_cents: 2000, buyer_name: 'Gia Gift', buyer_email: 'test@example.com' });
assert.ok(r.ok, JSON.stringify(r)); const card = (await fn({ action: 'gift_view', token: r.token })).card;
assert.equal(card.balance_cents, 2000); assert.equal(card.status, 'active'); ok('gift card bought');
assert.equal((await fn({ action: 'gift_check', code: card.code })).balance_cents, 2000);
assert.equal((await fn({ action: 'gift_check', code: 'NOPE' })).ok, false); ok('gift balance check');

// checkout with both
const menu = await fetch(`${U}/rest/v1/rpc/get_menu`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_slug: restaurant }) }).then((x) => x.json());
const { slots } = await fn({ action: 'slots' });
const tz = menu.restaurant.timezone;
const localMin = (iso) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return +p.hour * 60 + +p.minute; };
const dinner = slots.find((s) => localMin(s) >= 17 * 60);
const tacos = menu.categories.filter((c) => c.name === 'Traditional Dishes')[1].items.find((i) => i.name === 'Tacos');
const pick = (name) => tacos.groups.flatMap((g) => g.options).find((o) => o.name === name).id;
const items = [{ id: tacos.id, qty: 3, options: [pick('Carnitas'), pick('Fries')] }];
const guest = { first_name: 'Rita', last_name: 'Rewards', phone, email: 'test@example.com' };

r = await fn({ action: 'quote', pickup_at: dinner, items, phone, rewards_code: code });
assert.equal(r.ok, false); assert.match(r.error, /need 100 points/); ok('not enough points refused');
assert.equal((await staff('rewards_adjust', { id: (await staff('rewards_find', { phone })).account.id, points: 150 })).points, 150); ok('manager adds points');

const base = await fn({ action: 'quote', pickup_at: dinner, items });
const q = await fn({ action: 'quote', pickup_at: dinner, items, phone, rewards_code: code, gift_code: card.code });
assert.equal(q.discount_cents, 500); assert.equal(q.subtotal_cents, base.subtotal_cents);
assert.equal(q.tax_cents, Math.round((q.subtotal_cents - 500) * 0.0865)); assert.equal(q.gift_applied_cents, 2000);
assert.equal(q.amount_due_cents, q.total_cents - 2000); ok(`quote with both: total ${q.total_cents}, due ${q.amount_due_cents}`);

assert.equal((await fn({ action: 'quote', pickup_at: dinner, items, phone: '4355550199', rewards_code: code })).ok, false); ok('rewards code tied to phone');

r = await fn({ action: 'checkout', pickup_at: dinner, items, guest, rewards_code: code, gift_code: card.code });
assert.ok(r.ok, JSON.stringify(r)); const t1 = r.token;
assert.equal((await fn({ action: 'rewards_check', phone, code })).points, 50);
assert.equal((await fn({ action: 'gift_check', code: card.code })).balance_cents, 0); ok('order takes points and gift balance');
let s = await fn({ action: 'status', token: t1 }); assert.equal(s.order.gift_applied_cents, 2000); assert.equal(s.order.discount_cents, 500); ok('status shows credits');

const orderId = async (token) => (await (await fetch(`${U}/rest/v1/orders?select=id&token=eq.${token}`, { headers: { apikey: KEY, Authorization: `Bearer ${T}` } })).json())[0].id;
const o1 = await orderId(t1);
assert.equal((await fn({ action: 'kitchen', order_id: o1, move: 'cancel', reason: 'Test' }, T)).status, 'cancelled');
assert.equal((await fn({ action: 'rewards_check', phone, code })).points, 150);
assert.equal((await fn({ action: 'gift_check', code: card.code })).balance_cents, 2000); ok('cancel returns points and gift balance');

// earning
r = await fn({ action: 'checkout', pickup_at: dinner, items, guest });
const o2 = await orderId(r.token);
for (const move of ['accept', 'ready', 'complete']) await fn({ action: 'kitchen', order_id: o2, move }, T);
const earned = Math.floor(base.subtotal_cents / 100);
assert.equal((await fn({ action: 'rewards_check', phone, code })).points, 150 + earned); ok(`picked-up order earned ${earned} points`);

// in store
const found = (await staff('gift_find', { code: card.code })).card;
assert.equal((await staff('gift_redeem', { id: found.id, cents: 750 })).balance_cents, 1250);
assert.equal((await staff('gift_redeem', { id: found.id, cents: 99999 })).ok, false); ok('in-store gift redeem');
const sold = await staff('gift_issue', { cents: 2500, name: 'Walk-in' }); assert.equal(sold.balance_cents, 2500);
assert.equal((await fn({ action: 'gift_check', code: sold.code })).balance_cents, 2500); ok('card sold in store');
const a = (await staff('rewards_find', { phone })).account;
assert.ok((await staff('rewards_adjust', { id: a.id, points: -100 })).ok); ok('in-store points redeem');
assert.equal((await staff('rewards_adjust', { id: a.id, points: -999999 })).ok, false); ok('cannot overdraw points');
console.log(`all ${n} passed`);
