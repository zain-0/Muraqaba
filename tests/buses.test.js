/**
 * Items 4 and 13: rates and intervals live on the bus, and the vendor charges by interval
 * while we keep how much of the interval was left or delayed.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, busBody, createBus, signInEveryone, PASSWORD, run } from './helpers.js';

let users;
const raise = (busId, body, token = users.creator.token) => api('POST', '/tickets', { token, body: { busId, ...body } });

describe('buses', () => {
  before(async () => {
    users = await signInEveryone();
  });

  test('adding a bus records the new fields and refuses a form without them', async () => {
    const bus = await createBus(users, 'NEW', users.vendor1.id);
    assert.equal(bus.registrationExpiry.slice(0, 10), '2030-06-30');
    assert.equal(bus.expectedLifeYears, 15);
    assert.equal(bus.labourRate, 50);
    assert.deepEqual(bus.rates, { oil: 0.5, transmission: 1 });
    assert.equal(bus.intervals.oil.everyKm, 10000);
    assert.equal(bus.intervals.battery.everyMonths, 18);

    for (const [field, change] of [
      ['registrationExpiry', { registrationExpiry: 'soon' }],
      ['expectedLifeYears', { expectedLifeYears: 0 }],
      ['intervals.oil.everyKm', { intervals: { ...busBody('X', users.vendor1.id).intervals, oil: { everyKm: 0, lastKm: 0 } } }],
      ['intervals.battery.everyMonths', { intervals: { ...busBody('X', users.vendor1.id).intervals, battery: { everyMonths: 0, lastDate: '2026-01-01' } } }],
      ['rates.oil', { rates: { oil: -1 } }],
      ['labourRate', { labourRate: -1 }],
    ]) {
      const res = await api('POST', '/buses', { token: users.creator.token, body: busBody(`BAD${field}`, users.vendor1.id, change) });
      assert.equal(res.status, 400, field);
      assert.ok(res.body.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(res.body.errors)}`);
    }
  });

  test('rates and labour charge are optional, so a bus can start without them', async () => {
    const bus = await createBus(users, 'NORATE', users.vendor1.id, { rates: undefined, labourRate: undefined });
    assert.equal(bus.labourRate, undefined);
    const oil = await raise(bus._id, { serviceType: 'oil', currentReading: 9000 });
    assert.equal(oil.status, 201, JSON.stringify(oil.body));
    assert.equal(oil.body.data.status, 'sentToVendor', 'no rate on the bus falls back to the estimate flow');
    assert.equal(oil.body.data.agreedPrice, undefined);
  });

  test('vendors carry no rate any more', async () => {
    const created = await api('POST', '/vendors', {
      token: users.creator.token,
      body: { name: 'Old Way Motors', email: `old-way-${run}@test.muraqaba.dev`, password: PASSWORD, serviceRates: { minor: 1, major: 2 } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.serviceRates, undefined);
    const rates = await api('PUT', `/vendors/${created.body.data._id}/rates`, { token: users.creator.token, body: { minor: 1, major: 2 } });
    assert.equal(rates.status, 404);
  });

  test('oil and transmission charge rate times interval and store what was left or delayed', async () => {
    const bus = await createBus(users, 'PRICE', users.vendor1.id);

    const early = await raise(bus._id, { serviceType: 'oil', currentReading: 9700 });
    assert.equal(early.status, 201, JSON.stringify(early.body));
    assert.equal(early.body.data.status, 'pending');
    assert.deepEqual(early.body.data.agreedPrice, { basis: 'rate', rate: 0.5, km: 10000, amount: 5000 });
    assert.deepEqual(early.body.data.intervalUsage, { unit: 'km', interval: 10000, actual: 9700, left: 300, delayed: 0 });

    const late = await raise(bus._id, { serviceType: 'oil', currentReading: 10400 });
    assert.deepEqual(late.body.data.agreedPrice, { basis: 'rate', rate: 0.5, km: 10000, amount: 5000 });
    assert.deepEqual(late.body.data.intervalUsage, { unit: 'km', interval: 10000, actual: 10400, left: 0, delayed: 400 });

    const transmission = await raise(bus._id, { serviceType: 'transmission', currentReading: 61000 });
    assert.deepEqual(transmission.body.data.agreedPrice, { basis: 'rate', rate: 1, km: 60000, amount: 60000 });
    assert.equal(transmission.body.data.intervalUsage.delayed, 1000);

    const repair = await raise(bus._id, { serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 61000 });
    assert.equal(repair.body.data.status, 'sentToVendor');
    assert.equal(repair.body.data.agreedPrice, undefined);
    assert.equal(repair.body.data.intervalUsage, undefined);
  });

  test('a reading below the last service is refused', async () => {
    const bus = await createBus(users, 'LOWER', users.vendor1.id, {
      intervals: { ...busBody('X', users.vendor1.id).intervals, oil: { everyKm: 10000, lastKm: 50000 } },
    });
    const res = await raise(bus._id, { serviceType: 'oil', currentReading: 49000 });
    assert.equal(res.status, 400);
    assert.equal(res.body.errors[0].field, 'currentReading');
    const after = await raise(bus._id, { serviceType: 'oil', currentReading: 59000 });
    assert.deepEqual(after.body.data.intervalUsage, { unit: 'km', interval: 10000, actual: 9000, left: 1000, delayed: 0 });
  });

  test('tyre and battery keep the interval usage but still go through estimates', async () => {
    const bus = await createBus(users, 'TB', users.vendor1.id);
    const tyre = await raise(bus._id, { serviceType: 'tyre', currentReading: 41500 });
    assert.equal(tyre.body.data.status, 'sentToVendor');
    assert.equal(tyre.body.data.agreedPrice, undefined);
    assert.deepEqual(tyre.body.data.intervalUsage, { unit: 'km', interval: 40000, actual: 41500, left: 0, delayed: 1500 });

    const lastDate = new Date();
    lastDate.setUTCMonth(lastDate.getUTCMonth() - 20);
    const old = await createBus(users, 'BAT', users.vendor1.id, {
      intervals: { ...busBody('X', users.vendor1.id).intervals, battery: { everyMonths: 18, lastDate: lastDate.toISOString().slice(0, 10) } },
    });
    const battery = await raise(old._id, { serviceType: 'battery', currentReading: 100 });
    assert.equal(battery.body.data.status, 'sentToVendor');
    assert.deepEqual(battery.body.data.intervalUsage, { unit: 'months', interval: 18, actual: 20, left: 0, delayed: 2 });
  });

  test('another vendor than the bus vendor gets no rate, so it goes through estimates', async () => {
    const bus = await createBus(users, 'OTHER', users.vendor1.id);
    const res = await raise(bus._id, { serviceType: 'oil', currentReading: 9000, vendorId: users.vendor2.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'sentToVendor');
    assert.equal(res.body.data.agreedPrice, undefined);
    assert.equal(res.body.data.intervalUsage.left, 1000);
  });

  test('old service types are refused', async () => {
    const bus = await createBus(users, 'OLD', users.vendor1.id);
    assert.equal((await raise(bus._id, { serviceType: 'minor', currentReading: 1 })).status, 400);
    assert.equal((await raise(bus._id, { serviceType: 'repair', repairCategory: 'TYRE REPLACEMENT', currentReading: 1 })).status, 400);
  });

  test('a vendor reading a VSR gets the bus identity but never its rates or intervals', async () => {
    const bus = await createBus(users, 'LEAK', users.vendor1.id);
    const ticket = await raise(bus._id, { serviceType: 'oil', currentReading: 9700 });
    const seen = await api('GET', `/tickets/${ticket.body.data._id}`, { token: users.vendor1.token });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.data.busId.fleetNumber, bus.fleetNumber);
    assert.equal(seen.body.data.busId.rates, undefined);
    assert.equal(seen.body.data.busId.labourRate, undefined);
    assert.equal(seen.body.data.busId.intervals, undefined);
    assert.equal(seen.body.data.intervalUsage, undefined);
    assert.equal(seen.body.data.agreedPrice.amount, 5000, 'the vendor still sees the price it is working for');

    const list = await api('GET', '/tickets?limit=200', { token: users.vendor1.token });
    const row = list.body.data.find((t) => t._id === ticket.body.data._id);
    assert.equal(row.busId.rates, undefined);
    assert.equal(row.intervalUsage, undefined);
  });

  test('intervalStatus reads the latest km and says what is due', async () => {
    const bus = await createBus(users, 'DUE', users.vendor1.id);
    const sheet = await api('GET', '/sheets/readings', { token: users.creator.token });
    const { today } = sheet.body.data;
    await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: bus._id, date: today, km: 9500 } });

    const detail = await api('GET', `/buses/${bus._id}`, { token: users.creator.token });
    const { intervalStatus } = detail.body.data;
    assert.equal(intervalStatus.currentKm, 9500);
    assert.deepEqual(intervalStatus.oil, { unit: 'km', interval: 10000, used: 9500, left: 500, delayed: 0, state: 'soon' });
    assert.equal(intervalStatus.transmission.state, 'ok');
    assert.equal(intervalStatus.battery.unit, 'months');

    await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: bus._id, date: today, km: 10300 } });
    const list = await api('GET', '/buses', { token: users.supervisor.token });
    const row = list.body.data.find((b) => b._id === bus._id);
    assert.deepEqual(row.intervalStatus.oil, { unit: 'km', interval: 10000, used: 10300, left: 0, delayed: 300, state: 'overdue' });
  });

  test('a service creator can edit a bus; old VSRs keep their price and the vendor stays', async () => {
    const bus = await createBus(users, 'EDIT', users.vendor1.id);
    const before = await raise(bus._id, { serviceType: 'oil', currentReading: 9000 });

    const body = busBody('EDIT', users.vendor2.id, { registrationExpiry: '2031-01-15', labourRate: 75, rates: { oil: 2, transmission: 3 } });
    assert.equal((await api('PUT', `/buses/${bus._id}`, { token: users.supervisor.token, body })).status, 403);
    assert.equal((await api('PUT', `/buses/${bus._id}`, { token: users.vendor1.token, body })).status, 403);
    assert.equal((await api('PUT', `/buses/${bus._id}`, { token: users.creator.token, body: { ...body, expectedLifeYears: 0 } })).status, 400);

    const saved = await api('PUT', `/buses/${bus._id}`, { token: users.creator.token, body });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.registrationExpiry.slice(0, 10), '2031-01-15');
    assert.equal(saved.body.data.labourRate, 75);
    assert.equal(saved.body.data.vendor._id, users.vendor1.id, 'reassigning the vendor stays removed');

    const old = await api('GET', `/tickets/${before.body.data._id}`, { token: users.creator.token });
    assert.equal(old.body.data.agreedPrice.rate, 0.5);
    const fresh = await raise(bus._id, { serviceType: 'oil', currentReading: 9100 });
    assert.equal(fresh.body.data.agreedPrice.rate, 2);

    const taken = await createBus(users, 'TAKEN', users.vendor1.id);
    const duplicate = await api('PUT', `/buses/${bus._id}`, { token: users.creator.token, body: { ...body, fleetNumber: taken.fleetNumber } });
    assert.equal(duplicate.status, 409);
    const missing = await api('PUT', '/buses/64b000000000000000000000', { token: users.creator.token, body });
    assert.equal(missing.status, 404);
  });
});
