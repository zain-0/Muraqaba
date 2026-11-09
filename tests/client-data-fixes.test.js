/**
 * What loading the client's own records showed (2026-11-07): their contract rates per km need
 * four decimals, and a scrapped or removed bus must not keep raising service and registration alerts.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, busBody, createBus, scrapBus, signInEveryone } from './helpers.js';
import { uaeDay } from '../utils/uaeTime.js';

let users;
let counter = 0;
const suffix = (name) => `${name}${(counter += 1)}`;

before(async () => {
  users = await signInEveryone();
});

describe('rates per km', () => {
  test('a contract price of 3,300 for a 40,000 km service is 0.0825 a km, and prices back to 3,300', async () => {
    const bus = await createBus(users, suffix('RATE'), users.vendor1.id, { rates: { oil: 0.0825 }, intervals: { ...busBody('x', users.vendor1.id).intervals, oil: { everyKm: 40000, lastKm: 0 } } });
    assert.equal(bus.rates.oil, 0.0825);
    const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'oil', currentReading: 39000, vendorId: users.vendor1.id } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.agreedPrice.amount, 3300);
  });

  test('a fifth decimal is refused with its own message', async () => {
    const res = await api('POST', '/buses', { token: users.creator.token, body: busBody(suffix('RATE'), users.vendor1.id, { rates: { oil: 0.08251 } }) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.errors[0], { field: 'rates.oil', message: 'Use at most 4 decimals' });
  });

  test('money still takes two decimals', async () => {
    const res = await api('POST', '/buses', { token: users.creator.token, body: busBody(suffix('RATE'), users.vendor1.id, { labourRate: 50.125 }) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.errors[0], { field: 'labourRate', message: 'Use at most 2 decimals' });
  });
});

describe('buses off the fleet', () => {
  test('a scrapped bus drops out of the services due and the dashboard count', async () => {
    // Its oil service was due 1,000 km after 0, and the reading is far past that.
    const intervals = { ...busBody('x', users.vendor1.id).intervals, oil: { everyKm: 1000, lastKm: 0 } };
    const bus = await createBus(users, suffix('OFF'), users.vendor1.id, { intervals });
    const today = uaeDay();
    assert.equal((await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: bus._id, date: today, km: 5000 } })).status, 200);

    const dueOil = async () => (await api('GET', '/reports/weekly', { token: users.supervisor.token })).body.data.due.oil.map((row) => String(row.busId));
    const needing = async () => (await api('GET', '/users/dashboard', { token: users.creator.token })).body.data.fleet.busesNeedingService;
    assert.ok((await dueOil()).includes(bus._id), 'overdue while on the fleet');
    const before = await needing();

    // Scrapped through a scrap request since 2026-11-09; approving it writes Scrapping on the sheet.
    await scrapBus(users, bus._id);
    assert.ok(!(await dueOil()).includes(bus._id), 'nothing is due on a scrapped bus');
    assert.equal(await needing(), before - 1);

    // And the sheet cannot put it back on the road.
    const back = await api('PUT', '/sheets/status', { token: users.creator.token, body: { busId: bus._id, date: today, status: 'ready' } });
    assert.equal(back.status, 409);
    assert.ok(!(await dueOil()).includes(bus._id));
  });
});
