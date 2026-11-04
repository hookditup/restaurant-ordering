import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { categoryOpenAt, cleanGuest, isOpenAt, OrderError, pickupSlots, priceCart, priceLine, totals, validPickup, zoned } from '../supabase/functions/ordering/core.js';

const hours = { mon: [['10:30', '21:00']], tue: [['10:30', '21:00']], wed: [['10:30', '21:00']], thu: [['10:30', '21:00']], fri: [['10:30', '22:00']], sat: [['10:30', '22:00']] };
const r = { timezone: 'America/Denver', hours, tax_rate_bps: 865, guest_fee_bps: 0, pickup_lead_minutes: 20, last_order_minutes_before_close: 0, accepting_orders: true };
const protein = { id: 'g1', name: 'Protein', min: 1, max: 1, options: [{ id: 'chk', name: 'Chicken', price_cents: 0 }, { id: 'stk', name: 'Steak', price_cents: 449 }] };
const side = { id: 'g2', name: 'Side', min: 1, max: 2, options: [{ id: 'rice', name: 'Rice', price_cents: 0 }, { id: 'salad', name: 'Salad', price_cents: 0, groups: [{ id: 'g3', name: 'Dressing', min: 1, max: 1, options: [{ id: 'ranch', name: 'Ranch', price_cents: 0 }] }] }] };
const custom = { id: 'g4', name: 'Customize', min: 0, max: null, options: [{ id: 'noon', name: 'No Onion', price_cents: 0 }, { id: 'nocil', name: 'No Cilantro', price_cents: 0 }] };
const tacos = { id: 'lunch', name: 'Tacos', price_cents: 899, groups: [protein, custom] };
const dinner = { id: 'din', name: 'Tacos', price_cents: 1299, groups: [protein, side, custom] };
const lunchHours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['10:30', '16:00']]]));
const dinnerHours = { ...Object.fromEntries(['mon', 'tue', 'wed', 'thu'].map((d) => [d, [['16:00', '21:00']]])), fri: [['16:00', '22:00']], sat: [['16:00', '22:00']] };
const menu = { restaurant: r, categories: [{ name: 'Trad', hours: lunchHours, items: [tacos] }, { name: 'Trad', hours: dinnerHours, items: [dinner] }] };
// Wed 2026-11-04. Denver is UTC-7 in November.
const noon = '2026-11-04T19:00:00Z', six = '2026-11-05T01:00:00Z', sunday = '2026-11-08T19:00:00Z';

test('time zone: 6pm Denver Wednesday is Thursday in UTC but stays Wednesday locally', () => {
  assert.equal(zoned(new Date(six), r.timezone).day, 'wed');
  assert.equal(zoned(new Date(six), r.timezone).minutes, 18 * 60);
});
test('open and closed', () => {
  assert.ok(isOpenAt(hours, new Date(noon), r.timezone));
  assert.ok(!isOpenAt(hours, new Date(sunday), r.timezone));
  assert.ok(!isOpenAt(hours, new Date('2026-11-05T04:00:00Z'), r.timezone), 'closing time itself is closed');
});
test('lunch category only at lunch, dinner only at dinner', () => {
  assert.ok(categoryOpenAt(menu.categories[0], r, new Date(noon)));
  assert.ok(!categoryOpenAt(menu.categories[1], r, new Date(noon)));
  assert.ok(categoryOpenAt(menu.categories[1], r, new Date(six)));
  assert.ok(!categoryOpenAt(menu.categories[0], r, new Date(six)));
});
test('price adds paid choices', () => {
  assert.equal(priceLine(tacos, ['stk', 'noon']).unit_cents, 899 + 449);
});
test('required choice is enforced', () => {
  assert.throws(() => priceLine(tacos, []), OrderError);
  assert.throws(() => priceLine(tacos, ['chk', 'stk']), /Too many/);
});
test('a choice from another item is rejected', () => {
  assert.throws(() => priceLine(tacos, ['chk', 'rice']), /isn't available/);
});
test('follow-up group is required only when opened', () => {
  assert.throws(() => priceLine(dinner, ['chk', 'salad']), /Dressing/);
  assert.equal(priceLine(dinner, ['chk', 'salad', 'ranch']).unit_cents, 1299);
  assert.equal(priceLine(dinner, ['chk', 'rice']).unit_cents, 1299);
});
test('no limit group accepts many', () => {
  assert.equal(priceLine(tacos, ['chk', 'noon', 'nocil']).options.length, 3);
});
test('cart: server price wins and the lunch item fails at dinner time', () => {
  const lines = priceCart(menu, [{ id: 'lunch', qty: 2, options: ['stk'], price_cents: 1 }], noon);
  assert.equal(lines[0].line_total_cents, (899 + 449) * 2);
  assert.throws(() => priceCart(menu, [{ id: 'lunch', qty: 1, options: ['chk'] }], six), /isn't available at that pickup/);
});
test('bad quantities are rejected', () => {
  for (const qty of [0, -1, 51, 'x']) assert.throws(() => priceCart(menu, [{ id: 'lunch', qty, options: ['chk'] }], noon), OrderError);
});
test('totals', () => {
  const t = totals([{ line_total_cents: 2000 }], r, 300);
  assert.deepEqual(t, { subtotal_cents: 2000, guest_fee_cents: 0, tax_cents: 173, tip_cents: 300, total_cents: 2473 });
  assert.equal(totals([{ line_total_cents: 2000 }], { ...r, guest_fee_bps: 300 }, 0).guest_fee_cents, 60);
  assert.equal(totals([{ line_total_cents: 1000 }], r, -500).tip_cents, 0);
});
test('pickup slots respect lead time, closing and Sunday', () => {
  const s = pickupSlots(r, new Date(noon));
  assert.equal(s[0], '2026-11-04T19:30:00.000Z');
  assert.ok(s.every((x) => zoned(new Date(x), r.timezone).day !== 'sun'));
  assert.ok(s.every((x) => isOpenAt(hours, new Date(x), r.timezone) || zoned(new Date(x), r.timezone).minutes % 15 === 0));
  assert.ok(validPickup(r, s[3], new Date(noon)));
  assert.ok(!validPickup(r, '2026-11-08T19:00:00Z', new Date(noon)));
});
test('saturday night offers Monday, not Sunday', () => {
  const s = pickupSlots(r, new Date('2026-11-08T05:30:00Z'));
  assert.equal(zoned(new Date(s[0]), r.timezone).day, 'mon');
});
test('guest details', () => {
  assert.equal(cleanGuest({ first_name: 'A', last_name: 'B', phone: '(435) 555-1212', email: 'a@b.co' }).phone, '+14355551212');
  assert.throws(() => cleanGuest({ first_name: 'A', last_name: 'B', phone: '123', email: 'a@b.co' }), OrderError);
  assert.throws(() => cleanGuest({ first_name: 'A', last_name: 'B', phone: '4355551212', email: 'nope' }), OrderError);
});
test('real menu: every required group can be satisfied and prices are sane', () => {
  const seed = JSON.parse(readFileSync(new URL('../seed/lupitas/lupitas-seed.json', import.meta.url)));
  const groups = new Map(seed.groups.map((g) => [g.id, g]));
  let n = 0;
  for (const c of seed.categories) for (const i of c.items) {
    n++;
    assert.ok(i.price_cents > 0, i.name);
    for (const g of i.groups) {
      const def = groups.get(g);
      assert.ok(def, `${i.name} group ${g}`);
      assert.ok(def.options.length >= def.min, `${i.name} / ${def.name} cannot be satisfied`);
    }
  }
  assert.equal(n, 86);
});
