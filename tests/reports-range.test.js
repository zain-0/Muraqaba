/**
 * Custom dates on the reports (`from` and `to`), on a small fleet around New Year 2020 whose every
 * figure is worked by hand here. History is written straight into the database, as in
 * reports-purchasing.test.js; no other test has anything in 2019 or 2020.
 *
 * The fleet
 *   Vendors A and B.
 *   R1 "Hino",  A's, added 1 Nov 2019. Repair 30 Dec 2019 – 2 Jan 2020, ready from 3 Jan.
 *   R2 "Volvo", B's, added 20 Dec 2019. Always ready. No readings at all.
 *
 * The VSRs (all times UAE)
 *   a0  R1 other          A  20 Nov 2019        invoice 10 accepted.
 *   a1  R1 repair ENGINE  A  10 Dec 2019        invoice 100 accepted.
 *   a2  R1 repair ENGINE  A  31 Dec 2019 23:30  invoice 200 accepted. Still December in the UAE.
 *   a3  R1 tyre           A   1 Jan 2020 00:30  (31 Dec in UTC) invoice 300.10 accepted.
 *   a4  R2 oil            B  15 Jan 2020        invoice 50 accepted. Sent 15 Jan, back 17 Jan: 2 days, promised 1 → late.
 *   a5  R2 battery        B  10 Feb 2020        approved 80, no invoice yet.
 *   a6  R1 accident       A   1 Jun 2020        major, our driver. Invoice 1000 accepted.
 *   a7  R1 repair BODY    A   5 Jun 2020        no charge (warranty), recorded at 40.
 *
 * Daily readings, R1: 30 Nov 1000, 15 Dec 2000, 31 Dec 3000, 10 Jan 4500, 1 Feb 6000.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api, newVendor, run, signInEveryone } from './helpers.js';
import { assertTotalsAddUp, connectModels, fixture, report, uae } from './reportChecks.js';

let users;
let A;
let B;
let fx;
const bus = {};

const PERIOD_REPORTS = ['availability', 'downtime', 'costs', 'vendors', 'categories', 'accidents', 'free-work', 'invoice-check', 'query'];
const DECEMBER = { from: '2019-12-05', to: '2019-12-20' };
const NEW_YEAR = { from: '2019-12-15', to: '2020-01-20' };
const ALL_2020 = { from: '2020-01-01', to: '2020-12-31' };

before(async () => {
  users = await signInEveryone();
  A = await newVendor('rr-a');
  B = await newVendor('rr-b');
  fx = fixture(await connectModels(), { prefix: `RR${run}`, creatorId: users.creator.id });

  bus.r1 = await fx.addBus('R1', { make: 'Hino', created: uae('2019-11-01T09:00:00'), vendor: A.id });
  bus.r2 = await fx.addBus('R2', { make: 'Volvo', created: uae('2019-12-20T09:00:00'), vendor: B.id });
  await fx.setStatus(bus.r1, '2019-12-30', 'repair', 'vsr');
  await fx.setStatus(bus.r1, '2020-01-03', 'ready');
  for (const [day, km] of [['2019-11-30', 1000], ['2019-12-15', 2000], ['2019-12-31', 3000], ['2020-01-10', 4500], ['2020-02-01', 6000]]) await fx.addReading(bus.r1, day, km);

  const accepted = (amount) => [{ amount, status: 'approved' }];
  const add = (fields) => fx.addTicket({ vendor: fields.bus === bus.r1 ? A.id : B.id, ...fields });
  await add({ bus: bus.r1, serviceType: 'other', created: uae('2019-11-20T10:00:00'), approved: 10, invoices: accepted(10) });
  await add({ bus: bus.r1, serviceType: 'repair', repairCategory: 'ENGINE', created: uae('2019-12-10T10:00:00'), approved: 100, invoices: accepted(100) });
  await add({ bus: bus.r1, serviceType: 'repair', repairCategory: 'ENGINE', created: uae('2019-12-31T23:30:00'), approved: 200, invoices: accepted(200) });
  await add({ bus: bus.r1, serviceType: 'tyre', created: uae('2020-01-01T00:30:00'), approved: 300.1, invoices: accepted(300.1) });
  await add({ bus: bus.r2, serviceType: 'oil', created: uae('2020-01-15T10:00:00'), approved: 50, daysToComplete: 1, vehicle: { sentAt: uae('2020-01-15T12:00:00'), returnedAt: uae('2020-01-17T12:00:00') }, invoices: accepted(50) });
  await add({ bus: bus.r2, serviceType: 'battery', created: uae('2020-02-10T10:00:00'), approved: 80, status: 'sentToVendor' });
  await add({ bus: bus.r1, serviceType: 'accident', created: uae('2020-06-01T10:00:00'), accident: { severity: 'major', fault: 'ourDriver' }, approved: 1000, invoices: accepted(1000) });
  await add({ bus: bus.r1, serviceType: 'repair', repairCategory: 'BODY', created: uae('2020-06-05T10:00:00'), approved: 0, noChargeReason: 'warranty', quotationTotal: 40 });
});

after(async () => {
  await fx?.cleanup();
  await mongoose.connection.close();
});

const get = (path, params = {}) => report(users.purchasing.token, path, params);
const id = (doc) => String(doc._id);

describe('what the dates must be', () => {
  const bad = async (path, qs, field, message) => {
    const res = await api('GET', `/reports/${path}?${qs}`, { token: users.purchasing.token });
    assert.equal(res.status, 400, `${path}?${qs}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.errors[0].field, field, `${path}?${qs}`);
    if (message) assert.equal(res.body.errors[0].message, message, `${path}?${qs}`);
  };

  test('every report with a period, and the fleet figures, refuse dates that make no range', async () => {
    for (const path of [...PERIOD_REPORTS, 'fleet']) {
      await bad(path, 'from=2020-01-01', 'to', 'Choose an end date as well as a start date');
      await bad(path, 'to=2020-01-31', 'from', 'Choose a start date as well as an end date');
      await bad(path, 'from=2020-02-01&to=2020-01-31', 'to', 'The end date is before the start date');
      // 2019, 2020 (a leap year) and 2021 are 1,096 days, so 5 January 2022 is day 1,101.
      await bad(path, 'from=2019-01-01&to=2022-01-05', 'to', 'Choose dates no more than 1,100 days apart');
      await bad(path, 'from=2020-02-30&to=2020-03-05', 'from', 'Choose a valid start date');
      await bad(path, 'from=2020-01-01&to=31/01/2020', 'to', 'Choose a valid end date');
      await bad(path, 'from=yesterday&to=2020-01-31', 'from');
      await bad(path, 'from=2020-1-1&to=2020-01-31', 'from');
      await bad(path, 'from=1999-12-31&to=2000-01-31', 'from');
      await bad(path, 'from=2020-01-01&from=2020-01-02&to=2020-01-31', 'from');
    }
  });

  test('the longest range, one day, and an end still to come are all taken', async () => {
    for (const path of [...PERIOD_REPORTS, 'fleet']) {
      for (const qs of ['from=2019-01-01&to=2022-01-04', 'from=2020-01-01&to=2020-01-01', 'from=2020-01-01&to=2020-01-01&year=2025&month=3', `from=${new Date().getUTCFullYear()}-01-01&to=${new Date().getUTCFullYear() + 1}-06-30`]) {
        const res = await api('GET', `/reports/${path}?${qs}`, { token: users.purchasing.token });
        assert.equal(res.status, 200, `${path}?${qs}: ${JSON.stringify(res.body)}`);
      }
    }
  });

  test('custom dates change nobody\'s rights', async () => {
    const qs = 'from=2020-01-01&to=2020-01-31';
    for (const path of PERIOD_REPORTS) {
      for (const who of [users.vendor1, users.creator, users.supervisor]) assert.equal((await api('GET', `/reports/${path}?${qs}`, { token: who.token })).status, 403, path);
    }
    assert.equal((await api('GET', `/reports/fleet?${qs}`, { token: users.vendor1.token })).status, 403);
    for (const who of [users.creator, users.supervisor, users.purchasing]) assert.equal((await api('GET', `/reports/fleet?${qs}`, { token: who.token })).status, 200);
  });

  test('a report says which dates it used; with a year it has none', async () => {
    const ranged = await get('downtime', { ...DECEMBER, year: 2025, month: 3, brand: 'Hino' });
    assert.deepEqual(ranged.filters, { year: null, month: null, ...DECEMBER, brand: 'Hino' }, 'the dates win over the year and month');
    assert.deepEqual([ranged.year, ranged.month, ranged.from, ranged.to], [null, null, DECEMBER.from, DECEMBER.to]);
    for (const path of PERIOD_REPORTS) {
      const withDates = await get(path, NEW_YEAR);
      assert.deepEqual([withDates.year, withDates.from, withDates.to], [null, NEW_YEAR.from, NEW_YEAR.to], path);
      const withYear = await get(path, { year: 2020 });
      assert.deepEqual([withYear.year, withYear.from, withYear.to], [2020, null, null], path);
    }
    const fleet = await get('fleet', NEW_YEAR);
    assert.deepEqual([fleet.year, fleet.from, fleet.to], [null, NEW_YEAR.from, NEW_YEAR.to]);
  });
});

describe('dates inside one month: 5 to 20 December 2019', () => {
  test('cost per bus has the one month, and the km run between the two days', async () => {
    const costs = await get('costs', DECEMBER);
    assert.deepEqual(costs.months, ['2019-12']);
    assert.deepEqual(costs.filters, { year: null, ...DECEMBER, brand: null, type: null, vendorId: null });
    assert.equal(costs.rows.length, 1, 'only a1 was raised in these days');
    const [row] = costs.rows;
    assert.equal(row.busId, id(bus.r1));
    assert.deepEqual(row.spend, [100]);
    assert.equal(row.totalSpend, 100);
    assert.equal(row.vsrs, 1);
    assert.equal(row.km, 1000, '2000 on 15 December less 1000 on 30 November, the last reading by the 5th');
    assert.equal(row.spendPerKm, 0.1);
    assert.deepEqual(costs.totals, { spend: [100], totalSpend: 100, committed: 0, vsrs: 1, km: 1000 });
  });

  test('vendors, availability, downtime and the fleet figures count those days alone', async () => {
    const vendors = await get('vendors', DECEMBER);
    assertTotalsAddUp.vendors(vendors);
    assert.equal(vendors.vendors.length, 1);
    assert.equal(vendors.vendors[0].vendorId, A.id);
    assert.deepEqual([vendors.total.vsrs, vendors.total.spend], [1, 100]);

    const availability = await get('availability', DECEMBER);
    assertTotalsAddUp.availability(availability);
    assert.equal(availability.days.length, 16);
    assert.equal(availability.days[0].day, '2019-12-05');
    assert.equal(availability.days.at(-1).day, '2019-12-20');
    assert.deepEqual(availability.months.map((m) => [m.month, m.counted, m.ready]), [['2019-12', 17, 17]], 'R1 for 16 days and R2 for the day it joined');
    assert.equal(availability.total.availability, 1);

    const downtime = await get('downtime', DECEMBER);
    assertTotalsAddUp.downtime(downtime);
    assert.deepEqual([downtime.total.counted, downtime.total.offRoad, downtime.total.vsrs], [17, 0, 1]);

    const fleet = await get('fleet', DECEMBER);
    assert.deepEqual(fleet.months, [{ month: '2019-12', repair: 1, tyre: 0, battery: 0, maintenance: 0 }]);
    assert.deepEqual(fleet.totals, { repair: 1, tyre: 0, battery: 0, maintenance: 0 });
  });
});

describe('dates across New Year: 15 December 2019 to 20 January 2020', () => {
  test('cost per bus has a column for each month the dates touch', async () => {
    const costs = await get('costs', NEW_YEAR);
    assertCostsAddUp(costs);
    assert.deepEqual(costs.months, ['2019-12', '2020-01']);
    const [r1, r2] = [bus.r1, bus.r2].map((b) => costs.rows.find((row) => row.busId === id(b)));
    assert.equal(costs.rows.length, 2);
    assert.deepEqual(r1.spend, [200, 300.1], 'a2 at 23:30 on 31 December is December; a3 at 00:30 on 1 January is January');
    assert.equal(r1.vsrs, 2, 'a1 on 10 December is before the dates');
    assert.equal(r1.km, 2500, '4500 on 10 January less 2000 on 15 December');
    assert.equal(r1.spendPerKm, 0.2);
    assert.deepEqual(r2.spend, [0, 50]);
    assert.equal(r2.km, null, 'no readings');
    assert.equal(r2.spendPerKm, null);
    assert.deepEqual(costs.totals, { spend: [200, 350.1], totalSpend: 550.1, committed: 0, vsrs: 3, km: 2500 });

    const hino = await get('costs', { ...NEW_YEAR, brand: 'hino', type: 'tyre', vendorId: A.id });
    assert.deepEqual(hino.totals.spend, [0, 300.1]);
    assert.equal(hino.totals.vsrs, 1);
  });

  test('the day the year turns belongs to the right side', async () => {
    assert.equal((await get('costs', { from: '2019-12-31', to: '2019-12-31' })).totals.totalSpend, 200);
    const firstDay = await get('costs', { from: '2020-01-01', to: '2020-01-01' });
    assert.deepEqual(firstDay.months, ['2020-01']);
    assert.equal(firstDay.totals.totalSpend, 300.1);
    assert.equal(firstDay.rows[0].km, null, 'no reading on the day itself');
  });

  test('vendors add up the VSRs raised between the dates', async () => {
    const vendors = await get('vendors', NEW_YEAR);
    assertTotalsAddUp.vendors(vendors);
    assert.deepEqual(vendors.filters, { year: null, month: null, ...NEW_YEAR });
    const a = vendors.vendors.find((v) => v.vendorId === A.id);
    const b = vendors.vendors.find((v) => v.vendorId === B.id);
    assert.equal(vendors.vendors.length, 2);
    assert.deepEqual(a.rows.map((row) => [row.kind, row.vsrs, row.spend]), [['repair', 1, 200], ['tyre', 1, 300.1]]);
    assert.deepEqual(b.rows.map((row) => [row.kind, row.vsrs, row.spend, row.trips, row.days, row.late]), [['oil', 1, 50, 1, 2, 1]]);
    assert.deepEqual([vendors.total.vsrs, vendors.total.spend, vendors.total.trips, vendors.total.late], [3, 550.1, 1, 1]);
  });

  test('availability has a line for each month, counting only its days between the dates', async () => {
    const availability = await get('availability', NEW_YEAR);
    assertTotalsAddUp.availability(availability);
    assert.equal(availability.days.length, 37);
    assert.equal(availability.days[0].day, '2019-12-15');
    assert.equal(availability.days.at(-1).day, '2020-01-20');
    // December 15–31: R1 17 days, 2 of them in repair; R2 12 days from the 20th. January 1–20: 20 days each, R1 in repair on the 1st and 2nd.
    assert.deepEqual(availability.months.map((m) => [m.month, m.counted, m.ready, m.byStatus.repair]), [['2019-12', 29, 27, 2], ['2020-01', 40, 38, 2]]);
    assert.deepEqual(availability.total, { counted: 69, ready: 65, availability: 65 / 69 });

    const downtime = await get('downtime', NEW_YEAR);
    assertTotalsAddUp.downtime(downtime);
    assert.deepEqual([downtime.total.counted, downtime.total.ready, downtime.total.repair], [69, 65, 4]);
    assert.deepEqual(downtime.rows.map((row) => [String(row.busId), row.offRoad, row.vsrs]), [[id(bus.r1), 4, 2], [id(bus.r2), 0, 1]]);
  });

  test('the fleet figures list the months between the dates, for all brands or one', async () => {
    const fleet = await get('fleet', NEW_YEAR);
    assert.deepEqual(fleet.months, [
      { month: '2019-12', repair: 1, tyre: 0, battery: 0, maintenance: 0 },
      { month: '2020-01', repair: 0, tyre: 1, battery: 0, maintenance: 1 },
    ]);
    assert.deepEqual(fleet.totals, { repair: 1, tyre: 1, battery: 0, maintenance: 1 });
    assert.deepEqual(fleet.byBrand, [
      { brand: 'Hino', repair: 1, tyre: 1, battery: 0, maintenance: 0 },
      { brand: 'Volvo', repair: 0, tyre: 0, battery: 0, maintenance: 1 },
    ]);
    const hino = await get('fleet', { ...NEW_YEAR, brand: 'Hino' });
    assert.deepEqual(hino.months.map((m) => m.maintenance), [0, 0]);
    assert.deepEqual(hino.totals, { repair: 1, tyre: 1, battery: 0, maintenance: 0 });
  });

  test('queries group by the months between the dates', async () => {
    const byMonth = await get('query', { ...NEW_YEAR, groupBy: 'month' });
    assert.deepEqual(byMonth.rows, [
      { key: '2019-12', count: 1, amount: 200 },
      { key: '2020-01', count: 2, amount: 350.1 },
    ]);
    assert.deepEqual(byMonth.total, { count: 3, amount: 550.1 });
  });
});

describe('the whole of 2020 as dates is the year 2020', () => {
  const same = async (path, fields, params = {}) => {
    const [dates, year] = await Promise.all([get(path, { ...ALL_2020, ...params }), get(path, { year: 2020, ...params })]);
    fields.forEach((field) => assert.deepEqual(dates[field], year[field], `${path} ${field}`));
    return dates;
  };

  test('every report gives the same rows and totals either way', async () => {
    const costs = await same('costs', ['months', 'rows', 'totals']);
    assert.equal(costs.months.length, 12);
    assert.equal(costs.totals.totalSpend, 1350.1, '300.10 + 50 + 1000');
    assert.equal(costs.totals.committed, 80);
    assert.equal(costs.rows.find((row) => row.busId === id(bus.r1)).km, 3000, '6000 on 1 February less 3000 on 31 December, by either rule');
    await same('costs', ['rows', 'totals'], { brand: 'Volvo' });
    const vendors = await same('vendors', ['vendors', 'total']);
    assert.equal(vendors.total.spend, costs.totals.totalSpend);
    await same('availability', ['days', 'months', 'total']);
    await same('downtime', ['rows', 'total']);
    await same('downtime', ['rows', 'total'], { brand: 'Hino' });
    await same('categories', ['rows', 'total']);
    const accidents = await same('accidents', ['matrix', 'rows', 'totals']);
    assert.equal(accidents.totals.count, 1);
    const freeWork = await same('free-work', ['vendors', 'rows', 'totals']);
    assert.deepEqual([freeWork.totals.total, freeWork.totals.recordedValue], [1, 40]);
    await same('invoice-check', ['rows', 'totals'], { all: 'true' });
    await same('fleet', ['months', 'totals', 'byBrand']);
    for (const groupBy of ['brand', 'month', 'bus', 'vendor', 'type']) await same('query', ['rows', 'total'], { groupBy });
  });

  test('one month as dates is that month', async () => {
    const january = { from: '2020-01-01', to: '2020-01-31' };
    for (const [path, fields] of [['vendors', ['vendors', 'total']], ['availability', ['days', 'months', 'total']], ['downtime', ['rows', 'total']]]) {
      const [dates, month] = await Promise.all([get(path, january), get(path, { year: 2020, month: 1 })]);
      fields.forEach((field) => assert.deepEqual(dates[field], month[field], `${path} ${field}`));
    }
  });
});

/** assertTotalsAddUp.costs for any number of months. */
function assertCostsAddUp(data) {
  const fils = (aed) => Math.round(aed * 100);
  const add = (values) => values.reduce((total, value) => total + fils(value), 0) / 100;
  data.rows.forEach((row) => {
    assert.equal(row.spend.length, data.months.length);
    assert.equal(row.totalSpend, add(row.spend));
  });
  data.months.forEach((month, i) => assert.equal(data.totals.spend[i], add(data.rows.map((row) => row.spend[i])), month));
  assert.equal(data.totals.totalSpend, add(data.totals.spend));
}

describe('the statistical report: each bus by kind of work, with its km and cost per km', () => {
  const stats = (params) => report(users.supervisor.token, 'bus-stats', params);
  const rowOf = (data, which) => data.rows.find((row) => row.busId === id(which));

  test('the director and purchasing read it; the service creator and vendors do not', async () => {
    for (const [who, status] of [['supervisor', 200], ['purchasing', 200], ['creator', 403], ['vendor1', 403]]) {
      assert.equal((await api('GET', '/reports/bus-stats?year=2020', { token: users[who].token })).status, status, who);
    }
  });

  test('a year: every bus on the fleet, its costs under their kinds, the year\'s km', async () => {
    const data = await stats({ year: 2020 });
    assert.deepEqual(data.groups, ['repair', 'maintenance', 'tyre', 'battery', 'accident', 'other']);
    const r1 = rowOf(data, bus.r1);
    assert.deepEqual(r1.costs, { repair: 0, maintenance: 0, tyre: 300.1, battery: 0, accident: 1000, other: 0 });
    assert.deepEqual([r1.totalCost, r1.vsrs, r1.accidents, r1.km, r1.costPerKm, r1.make], [1300.1, 3, 1, 3000, 0.4334, 'Hino']);
    const r2 = rowOf(data, bus.r2);
    assert.deepEqual([r2.costs.maintenance, r2.totalCost, r2.committed, r2.vsrs, r2.trips, r2.workshopDays, r2.km, r2.costPerKm], [50, 50, 80, 2, 1, 2, null, null]);
    // The same accepted invoices and km as Cost per bus.
    const costs = await get('costs', { year: 2020 });
    for (const which of [bus.r1, bus.r2]) {
      const cost = costs.rows.find((row) => row.busId === id(which));
      assert.deepEqual([rowOf(data, which).totalCost, rowOf(data, which).km], [cost.totalSpend, cost.km]);
    }
    const fils = (aed) => Math.round(aed * 100);
    assert.equal(fils(data.totals.totalCost), data.rows.reduce((total, row) => total + fils(row.totalCost), 0), 'the total is the sum of its rows');
    assert.equal(data.totals.vsrs, data.rows.reduce((total, row) => total + row.vsrs, 0));
  });

  test('custom dates: the VSRs raised between them, and the km run between them', async () => {
    const data = await stats(NEW_YEAR);
    const r1 = rowOf(data, bus.r1);
    assert.deepEqual([r1.costs.repair, r1.costs.tyre, r1.totalCost, r1.vsrs, r1.km, r1.costPerKm], [200, 300.1, 500.1, 2, 2500, 0.2]);
    assert.deepEqual([data.from, data.to, data.year], [NEW_YEAR.from, NEW_YEAR.to, null]);
    assert.equal(rowOf(data, bus.r2).totalCost, 50);
  });

  test('one brand leaves the others out, and a bus with no VSR in the period still has its line', async () => {
    const hino = await stats({ ...NEW_YEAR, brand: 'hino' });
    assert.ok(rowOf(hino, bus.r1));
    assert.equal(rowOf(hino, bus.r2), undefined);
    const quiet = rowOf(await stats({ from: '2020-03-01', to: '2020-03-31' }), bus.r2);
    assert.deepEqual([quiet.vsrs, quiet.totalCost, quiet.costPerKm], [0, 0, null]);
  });
});
