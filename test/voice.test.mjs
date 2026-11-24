import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDay, parseClock, nearestOpen, dayText, listTimes } from '../supabase/functions/voice/voice.js';

const tz = 'America/Denver';
const mon = new Date('2026-11-23T22:00:00Z'); // Monday Nov 23, 3 PM in Denver

test('spoken days', () => {
  assert.equal(parseDay('tonight', tz, mon), '2026-11-23');
  assert.equal(parseDay('tomorrow', tz, mon), '2026-11-24');
  assert.equal(parseDay('Friday', tz, mon), '2026-11-27');
  assert.equal(parseDay('this friday', tz, mon), '2026-11-27');
  assert.equal(parseDay('Monday', tz, mon), '2026-11-23');
  assert.equal(parseDay('next monday', tz, mon), '2026-11-30');
  assert.equal(parseDay('November 28th', tz, mon), '2026-11-28');
  assert.equal(parseDay('Dec 3', tz, mon), '2026-12-03');
  assert.equal(parseDay('the 5th of january', tz, mon), '2027-01-05');
  assert.equal(parseDay('11/2', tz, mon), '2027-11-02');
  assert.equal(parseDay('2026-12-24', tz, mon), '2026-12-24');
  assert.equal(parseDay('2026-11-01', tz, mon), null);
  assert.equal(parseDay('the 30th', tz, mon), '2026-11-30');
  assert.equal(parseDay('the 2nd', tz, mon), '2026-12-02');
  assert.equal(parseDay('February 30', tz, mon), null);
  assert.equal(parseDay('sometime', tz, mon), null);
});
test('spoken times', () => {
  assert.equal(parseClock('6:30'), 18 * 60 + 30);
  assert.equal(parseClock('6 pm'), 18 * 60);
  assert.equal(parseClock('11:30 am'), 11 * 60 + 30);
  assert.equal(parseClock('noon'), 12 * 60);
  assert.equal(parseClock('10 in the evening'), 22 * 60);
  assert.equal(parseClock('7:00 PM'), 19 * 60);
  assert.equal(parseClock(''), null);
});
test('closest open times', () => {
  const slots = [{ min: 1020, label: '5:00 PM', left: 10 }, { min: 1050, label: '5:30 PM', left: 2 }, { min: 1080, label: '6:00 PM', left: 8 }, { min: 1110, label: '6:30 PM', left: 8 }, { min: 1140, label: '7:00 PM', left: 8 }];
  assert.deepEqual(nearestOpen(slots, 1050, 4, 8).map((s) => s.label), ['5:00 PM', '6:00 PM', '6:30 PM']);
  assert.deepEqual(nearestOpen(slots, null, 4, 8, 2).map((s) => s.label), ['5:00 PM', '6:00 PM']);
  assert.equal(nearestOpen(slots, 1050, 12, 8).length, 3, 'large parties are requests, so any time can be asked for');
  assert.equal(dayText('2026-11-27'), 'Friday, November 27');
  assert.equal(listTimes(['5:00 PM', '6:00 PM', '6:30 PM']), '5:00 PM, 6:00 PM or 6:30 PM');
});
