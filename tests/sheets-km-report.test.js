/**
 * Owner's testing notes, 2026-11-11: "A report section where it shows how much kms have been ran on
 * this bus, whole, some selected, from xyz date to xyz date". Reached from the daily km sheet by the
 * service creator and the supervisor. A bus's km between two days is its last reading on or before
 * the last day, less its last reading on or before the first day; with no reading by the first day,
 * it starts from its first reading in the range.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, signInEveryone } from './helpers.js';

let users;
let a;
let b;
let c;
const report = (query, token = users.supervisor.token) => api('GET', `/sheets/readings/report${query}`, { token });
const rowOf = (res, bus) => res.body.data.rows.find((row) => row.busId === bus._id);
const setReading = async (bus, date, km) => {
  const res = await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: bus._id, date, km } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

describe('km run between two days', () => {
  before(async () => {
    users = await signInEveryone();
    [a, b, c] = await Promise.all(['KMA', 'KMB', 'KMC'].map((suffix) => createBus(users, suffix, users.vendor1.id)));
    for (const [date, km] of [['2026-06-28', 1000], ['2026-07-01', 1200], ['2026-07-15', 3000], ['2026-07-31', 5000], ['2026-08-02', 5400]]) await setReading(a, date, km);
    for (const [date, km] of [['2026-07-10', 700], ['2026-07-20', 1700]]) await setReading(b, date, km);
    await setReading(c, '2026-06-01', 100);
  });

  test('the creator and the supervisor read it; nobody else does, and the dates are checked', async () => {
    assert.equal((await report('?from=2026-07-01&to=2026-07-31', users.creator.token)).status, 200);
    assert.equal((await report('?from=2026-07-01&to=2026-07-31', users.purchasing.token)).status, 403);
    assert.equal((await report('?from=2026-07-01&to=2026-07-31', users.vendor1.token)).status, 403);
    assert.equal((await report('?to=2026-07-31')).body.errors[0].field, 'from');
    assert.equal((await report('?from=2026-07-01&to=2026-02-31')).body.errors[0].field, 'to');
    const backwards = await report('?from=2026-07-31&to=2026-07-01');
    assert.equal(backwards.status, 400);
    assert.deepEqual(backwards.body.errors[0], { field: 'to', message: 'The end date is before the start date' });
    const badBus = await report('?from=2026-07-01&to=2026-07-31&busIds=nope');
    assert.deepEqual(badBus.body.errors[0], { field: 'busIds', message: 'Choose buses from the list' });
  });

  test('per bus: the reading at the start, at the end, and the km run', async () => {
    const res = await report(`?from=2026-07-01&to=2026-07-31&busIds=${a._id},${b._id},${c._id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.data.from, res.body.data.to], ['2026-07-01', '2026-07-31']);
    assert.deepEqual(rowOf(res, a), {
      busId: a._id,
      fleetNumber: a.fleetNumber,
      make: 'Hino',
      model: 'Coach',
      start: { date: '2026-07-01', km: 1200 },
      end: { date: '2026-07-31', km: 5000 },
      km: 3800,
      startsLater: false,
    });
    const late = rowOf(res, b);
    assert.deepEqual([late.start, late.end, late.km, late.startsLater], [{ date: '2026-07-10', km: 700 }, { date: '2026-07-20', km: 1700 }, 1000, true], 'no reading by the first day: from its first reading in the range');
    const none = rowOf(res, c);
    assert.deepEqual([none.start, none.end, none.km], [{ date: '2026-06-01', km: 100 }, { date: '2026-06-01', km: 100 }, null], 'no reading in the range: not known');
    assert.deepEqual(res.body.data.total, { km: 4800, buses: 3, withReadings: 2 });

    const earlier = await report(`?from=2026-06-30&to=2026-07-14&busIds=${a._id}`);
    assert.deepEqual([rowOf(earlier, a).start, rowOf(earlier, a).end, rowOf(earlier, a).km], [{ date: '2026-06-28', km: 1000 }, { date: '2026-07-01', km: 1200 }, 200], 'the last reading on or before each day');
  });

  test('the buses chosen, or the whole fleet, with every bus to choose from', async () => {
    const chosen = await report(`?from=2026-07-01&to=2026-07-31&busIds=${a._id},${b._id}`);
    assert.deepEqual(chosen.body.data.rows.map((row) => row.busId).sort(), [a._id, b._id].sort());
    assert.equal(chosen.body.data.total.km, 4800);
    assert.ok(chosen.body.data.buses.some((bus) => bus._id === c._id), 'the list to choose from has every bus');

    const fleet = await report('?from=2026-07-01&to=2026-07-31');
    const ids = fleet.body.data.rows.map((row) => row.busId);
    assert.ok([a, b, c].every((bus) => ids.includes(bus._id)));
    assert.equal(fleet.body.data.total.km, fleet.body.data.rows.reduce((sum, row) => sum + (row.km ?? 0), 0));
    assert.equal(fleet.body.data.total.buses, fleet.body.data.rows.length);
  });
});
