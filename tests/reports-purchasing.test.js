/**
 * Purchasing's nine reports on a small fleet in 2025 whose every figure is worked by hand in the
 * comments. History is written straight into the database (the API dates everything today), and
 * 2025 is in the past, so "days after today" cannot bite; one test at the end covers this month.
 *
 * The fleet
 *   Vendors A and B.
 *   B1 "Hino",  A's, added 2024-12-01. Repair 5–7 March, ready from the 8th.
 *   B2 "hino",  A's, added 2024-12-01. Accident 20–24 March, ready from the 25th. No readings at all.
 *   B3 "Volvo", B's, added 16 March 2025 (mid-month). Tyre change 28–29 March, ready from the 30th.
 *   B4 "Volvo", B's, added 2024-12-01. Scrapping from 10 March 2025 to the end.
 *   A fifth bus has been deleted; one VSR still points at it.
 *
 * The VSRs (all times UAE)
 *   t1    B1 repair ENGINE      A  31 Jan 23:30  approved 1000, invoice 1000.10 accepted. Sent 1 Feb, back 4 Feb: 3 days, promised 2 → late. Breakdown.
 *   tNew  B1 other              A   1 Jan 00:30  (31 Dec 20:30 UTC: still 2025 in the UAE) approved 50, invoice 50 accepted.
 *   tPrev B1 other              A  31 Dec 2024 23:30 approved 111, invoice 111 accepted. Belongs to 2024.
 *   t2    B1 repair ENGINE      A   1 Feb 00:30  (31 Jan in UTC) approved 500. Invoice 600 rejected, then 450 accepted. Sent and back 10 Feb: 0 days.
 *   t2b   B1 repair MECHANICAL  A  additional job on t2, approved 200, invoice 200 accepted. Carries t2's trip dates, which must not count twice.
 *   t2c   B1 repair MECHANICAL  A  additional job on t2, declined. Never counts.
 *   t3    B2 repair ACCIDENT    A  20 Mar  major, other party. Approved 3000, invoice 3100 waiting. Sent 20 Mar, back 25 Mar: 5 days, promised 4 → late.
 *   t4    B2 repair ACCIDENT    B  15 Jun  no details recorded. Waiting for an estimate. Breakdown.
 *   t5    B3 tyre               B  28 Mar  at the depot: work started 28 Mar, back 29 Mar: 1 day, promised 1. Approved 2400, invoice 2400 accepted.
 *   t6    B3 brakePads          B   2 Apr  approved 800, back, no invoice yet. Sent 2 Apr, back 5 Apr: 3 days, promised 2 → late.
 *   t7    B4 oil                B   1 Mar  agreed price 5000, invoice 5000 accepted. Sent and back 2 Mar: 0 days.
 *   t8    B1 repair BODY        A   5 May  no charge (warranty), parts and labour recorded at 450. Sent 6 May, back 8 May: 2 days, promised 3.
 *   t9    B2 repair ACCIDENT    B   1 Jul  minor, our driver. No charge (insurance), nothing recorded. Sent 1 Jul, back 3 Jul: 2 days, promised 1 → late.
 *   e1–e3 B4 repair ELECTRICAL  B  10–12 Aug  approved 33.34, 33.33, 33.33; each invoiced 33.33. No trip dates.
 *   m1,m2 B3 other              A   1–2 Sep  approved and invoiced 0.1 and 0.2.
 *   tGone (deleted bus) repair ENGINE A 10 Oct approved 700, invoice 700 accepted.
 *   t10   B4 battery            B   3 Nov  approved 600. Invoice 650 rejected, not yet sent again.
 *
 * Daily readings: B1 31 Dec 10000, 15 Jan 14000, 31 Jan 18000, 20 Feb 22000, 30 Apr 30000.
 *                 B3 16 Mar 500, 31 Mar 8500, 30 Apr 8500.   B4 31 Jan 60000, 28 Feb 100000, 9 Mar 103000.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api, createBus, estimate, newVendor, run, signInEveryone, toInvoiceAccepted } from './helpers.js';
import { assertMatchesSheet, assertReconciles, assertTotalsAddUp, connectModels, fixture, report, uae } from './reportChecks.js';
import { brandKey } from '../utils/reportMaths.js';
import { daysInMonth, uaeDay, uaeMonth } from '../utils/uaeTime.js';

const YEAR = 2025;
let users;
let A;
let B;
let fx;
const bus = {};
const t = {};

const vehicle = (sent, back) => ({ sentAt: uae(sent), returnedAt: uae(back) });

before(async () => {
  users = await signInEveryone();
  A = await newVendor('rp-a');
  B = await newVendor('rp-b');
  fx = fixture(await connectModels(), { prefix: `RP${run}`, creatorId: users.creator.id });

  bus.b1 = await fx.addBus('B1', { make: 'Hino', created: uae('2024-12-01T09:00:00'), vendor: A.id });
  bus.b2 = await fx.addBus('B2', { make: 'hino', created: uae('2024-12-01T09:00:00'), vendor: A.id });
  bus.b3 = await fx.addBus('B3', { make: 'Volvo', created: uae('2025-03-16T10:00:00'), vendor: B.id });
  bus.b4 = await fx.addBus('B4', { make: 'Volvo', created: uae('2024-12-01T09:00:00'), vendor: B.id });
  const gone = new mongoose.Types.ObjectId();

  await fx.setStatus(bus.b1, '2025-03-05', 'repair', 'vsr');
  await fx.setStatus(bus.b1, '2025-03-08', 'ready');
  await fx.setStatus(bus.b2, '2025-03-20', 'accident', 'vsr');
  await fx.setStatus(bus.b2, '2025-03-25', 'ready');
  await fx.setStatus(bus.b3, '2025-03-28', 'tyreChange', 'vsr');
  await fx.setStatus(bus.b3, '2025-03-30', 'ready');
  await fx.setStatus(bus.b4, '2025-03-10', 'scrapping');

  for (const [day, km] of [['2024-12-31', 10000], ['2025-01-15', 14000], ['2025-01-31', 18000], ['2025-02-20', 22000], ['2025-04-30', 30000]]) await fx.addReading(bus.b1, day, km);
  for (const [day, km] of [['2025-03-16', 500], ['2025-03-31', 8500], ['2025-04-30', 8500]]) await fx.addReading(bus.b3, day, km);
  for (const [day, km] of [['2025-01-31', 60000], ['2025-02-28', 100000], ['2025-03-09', 103000]]) await fx.addReading(bus.b4, day, km);

  const accepted = (amount) => ({ amount, status: 'approved' });
  t.t1 = await fx.addTicket({ bus: bus.b1, vendor: A.id, serviceType: 'repair', repairCategory: 'ENGINE', created: uae('2025-01-31T23:30:00'), approved: 1000, daysToComplete: 2, isBreakdown: true, vehicle: vehicle('2025-02-01T08:00:00', '2025-02-04T18:00:00'), invoices: [accepted(1000.1)] });
  t.tNew = await fx.addTicket({ bus: bus.b1, vendor: A.id, serviceType: 'other', created: uae('2025-01-01T00:30:00'), approved: 50, invoices: [accepted(50)] });
  t.tPrev = await fx.addTicket({ bus: bus.b1, vendor: A.id, serviceType: 'other', created: uae('2024-12-31T23:30:00'), approved: 111, invoices: [accepted(111)] });
  t.t2 = await fx.addTicket({ bus: bus.b1, vendor: A.id, serviceType: 'repair', repairCategory: 'ENGINE', created: uae('2025-02-01T00:30:00'), approved: 500, daysToComplete: 5, vehicle: vehicle('2025-02-10T10:00:00', '2025-02-10T16:00:00'), invoices: [{ amount: 600, status: 'rejected' }, accepted(450)] });
  t.t2b = await fx.addTicket({ bus: bus.b1, vendor: A.id, serviceType: 'repair', repairCategory: 'MECHANICAL', created: uae('2025-02-10T12:00:00'), parent: t.t2, approved: 200, daysToComplete: 1, vehicle: vehicle('2025-02-10T10:00:00', '2025-02-12T16:00:00'), invoices: [accepted(200)] });
  t.t2c = await fx.addTicket({ bus: bus.b1, vendor: A.id, serviceType: 'repair', repairCategory: 'MECHANICAL', created: uae('2025-02-10T13:00:00'), parent: t.t2, status: 'declined' });
  t.t3 = await fx.addTicket({ bus: bus.b2, vendor: A.id, serviceType: 'repair', repairCategory: 'ACCIDENT', created: uae('2025-03-20T09:00:00'), accident: { severity: 'major', fault: 'otherParty' }, approved: 3000, daysToComplete: 4, status: 'invoiceSubmitted', vehicle: vehicle('2025-03-20T12:00:00', '2025-03-25T10:00:00'), invoices: [{ amount: 3100, status: 'invoicePending' }] });
  t.t4 = await fx.addTicket({ bus: bus.b2, vendor: B.id, serviceType: 'repair', repairCategory: 'ACCIDENT', created: uae('2025-06-15T10:00:00'), status: 'sentToVendor', isBreakdown: true });
  t.t5 = await fx.addTicket({ bus: bus.b3, vendor: B.id, serviceType: 'tyre', created: uae('2025-03-28T08:00:00'), location: 'depot', approved: 2400, daysToComplete: 1, vehicle: { workStartedAt: uae('2025-03-28T09:00:00'), returnedAt: uae('2025-03-29T15:00:00') }, invoices: [accepted(2400)] });
  t.t6 = await fx.addTicket({ bus: bus.b3, vendor: B.id, serviceType: 'brakePads', created: uae('2025-04-02T10:00:00'), approved: 800, daysToComplete: 2, status: 'vehicleReturned', vehicle: vehicle('2025-04-02T11:00:00', '2025-04-05T09:00:00') });
  t.t7 = await fx.addTicket({ bus: bus.b4, vendor: B.id, serviceType: 'oil', created: uae('2025-03-01T10:00:00'), approved: 5000, vehicle: vehicle('2025-03-02T08:00:00', '2025-03-02T17:00:00'), invoices: [accepted(5000)] });
  t.t8 = await fx.addTicket({ bus: bus.b1, vendor: A.id, serviceType: 'repair', repairCategory: 'BODY', created: uae('2025-05-05T10:00:00'), approved: 0, noChargeReason: 'warranty', quotationTotal: 450, daysToComplete: 3, vehicle: vehicle('2025-05-06T08:00:00', '2025-05-08T12:00:00') });
  t.t9 = await fx.addTicket({ bus: bus.b2, vendor: B.id, serviceType: 'repair', repairCategory: 'ACCIDENT', created: uae('2025-07-01T10:00:00'), accident: { severity: 'minor', fault: 'ourDriver' }, approved: 0, noChargeReason: 'insurance', daysToComplete: 1, vehicle: vehicle('2025-07-01T11:00:00', '2025-07-03T10:00:00') });
  t.e1 = await fx.addTicket({ bus: bus.b4, vendor: B.id, serviceType: 'repair', repairCategory: 'ELECTRICAL', created: uae('2025-08-10T10:00:00'), approved: 33.34, invoices: [accepted(33.33)] });
  t.e2 = await fx.addTicket({ bus: bus.b4, vendor: B.id, serviceType: 'repair', repairCategory: 'ELECTRICAL', created: uae('2025-08-11T10:00:00'), approved: 33.33, invoices: [accepted(33.33)] });
  t.e3 = await fx.addTicket({ bus: bus.b4, vendor: B.id, serviceType: 'repair', repairCategory: 'ELECTRICAL', created: uae('2025-08-12T10:00:00'), approved: 33.33, invoices: [accepted(33.33)] });
  t.m1 = await fx.addTicket({ bus: bus.b3, vendor: A.id, serviceType: 'other', created: uae('2025-09-01T10:00:00'), approved: 0.1, invoices: [accepted(0.1)] });
  t.m2 = await fx.addTicket({ bus: bus.b3, vendor: A.id, serviceType: 'other', created: uae('2025-09-02T10:00:00'), approved: 0.2, invoices: [accepted(0.2)] });
  t.tGone = await fx.addTicket({ bus: gone, vendor: A.id, serviceType: 'repair', repairCategory: 'ENGINE', created: uae('2025-10-10T10:00:00'), approved: 700, invoices: [accepted(700)] });
  t.t10 = await fx.addTicket({ bus: bus.b4, vendor: B.id, serviceType: 'battery', created: uae('2025-11-03T10:00:00'), approved: 600, status: 'invoiceRejected', invoices: [{ amount: 650, status: 'rejected' }] });
});

after(async () => {
  await fx?.cleanup();
  await mongoose.connection.close();
});

const get = (path, params = {}) => report(users.purchasing.token, path, { year: YEAR, ...params });
const id = (doc) => String(doc._id);

describe('who may open them, and what they accept', () => {
  const PATHS = ['availability', 'downtime', 'costs', 'vendors', 'km', 'categories', 'accidents', 'free-work', 'invoice-check'];

  test('the fixture keeps the dates it was given', () => {
    assert.equal(uaeDay(bus.b3.createdAt), '2025-03-16');
    assert.equal(uaeMonth(t.t1.createdAt), '2025-01', '23:30 UAE on 31 January is January');
    assert.equal(t.t2.createdAt.toISOString().slice(0, 10), '2025-01-31', 'it is still 31 January in UTC');
    assert.equal(uaeMonth(t.t2.createdAt), '2025-02', 'but 1 February in the UAE');
  });

  test('only purchasing opens them; vendors, creators and supervisors are refused', async () => {
    for (const path of PATHS) {
      for (const who of [users.vendor1, users.creator, users.supervisor]) {
        assert.equal((await api('GET', `/reports/${path}?year=${YEAR}`, { token: who.token })).status, 403, `${path} for ${who.email}`);
      }
      assert.equal((await api('GET', `/reports/${path}?year=${YEAR}`)).status, 401, `${path} without signing in`);
      assert.equal((await api('GET', `/reports/${path}?year=${YEAR}`, { token: users.purchasing.token })).status, 200, path);
    }
  });

  test('wrong filters are refused with the field that is wrong', async () => {
    const bad = async (path, qs, field) => {
      const res = await api('GET', `/reports/${path}?${qs}`, { token: users.purchasing.token });
      assert.equal(res.status, 400, `${path}?${qs}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.errors[0].field, field, `${path}?${qs}`);
    };
    for (const path of PATHS) {
      await bad(path, 'year=1999', 'year');
      await bad(path, 'year=abc', 'year');
      await bad(path, 'year=2025&year=2024', 'year');
    }
    for (const path of ['availability', 'downtime', 'vendors']) {
      await bad(path, 'month=13', 'month');
      await bad(path, 'month=0', 'month');
      await bad(path, 'month=1.5', 'month');
    }
    for (const path of ['downtime', 'costs', 'categories']) await bad(path, `brand=${'x'.repeat(121)}`, 'brand');
    await bad('costs', 'type=flying', 'type');
    await bad('costs', 'vendorId=nobody', 'vendorId');
    await bad('invoice-check', 'all=maybe', 'all');
  });

  test('each report says which filters it used and lists the choices for them', async () => {
    const costs = await get('costs', { brand: 'HINO', type: 'repair', vendorId: A.id });
    assert.deepEqual(costs.filters, { year: YEAR, brand: 'HINO', type: 'repair', vendorId: A.id });
    assert.deepEqual((await get('availability', { month: 3 })).filters, { year: YEAR, month: 3 });
    assert.deepEqual((await get('availability')).filters, { year: YEAR, month: null });
    assert.deepEqual((await get('downtime', { brand: 'Volvo' })).filters, { year: YEAR, month: null, brand: 'Volvo' });
    assert.deepEqual((await get('invoice-check')).filters, { year: YEAR, all: false });
    assert.deepEqual((await get('invoice-check', { all: 'true' })).filters, { year: YEAR, all: true });

    for (const path of ['availability', 'downtime', 'costs', 'vendors', 'km', 'categories', 'accidents', 'free-work', 'invoice-check']) {
      const { options } = await get(path);
      assert.equal(options.brands.filter((brand) => brandKey(brand) === 'hino').length, 1, `${path}: "Hino" and "hino" are one brand`);
      assert.ok(options.brands.includes('Volvo'), path);
      assert.ok(options.vendors.some((v) => v._id === A.id && v.name.startsWith('rp-a')), path);
      assert.ok(options.buses.some((b) => b._id === id(bus.b1) && b.fleetNumber === bus.b1.fleetNumber && b.make === 'Hino'), path);
    }
  });

  test('the year defaults to this UAE year', async () => {
    const { filters } = await report(users.purchasing.token, 'costs');
    assert.equal(filters.year, Number(uaeDay().slice(0, 4)));
  });
});

describe('the status sheet', () => {
  // March 2025 by hand. Each run is [first day, status, source of the change on that day].
  const MARCH = daysInMonth('2025-03');
  const cells = (runs, firstDay = 1) =>
    MARCH.map((_, i) => {
      const day = i + 1;
      if (day < firstDay) return null;
      const current = runs.filter(([from]) => from <= day).at(-1);
      const changed = runs.find(([from]) => from === day);
      return { status: current[1], source: changed?.[2] ?? null };
    });
  const expected = () => [
    { bus: bus.b1, cells: cells([[1, 'ready'], [5, 'repair', 'vsr'], [8, 'ready', 'manual']]) },
    { bus: bus.b2, cells: cells([[1, 'ready'], [20, 'accident', 'vsr'], [25, 'ready', 'manual']]) },
    { bus: bus.b3, cells: cells([[16, 'ready'], [28, 'tyreChange', 'vsr'], [30, 'ready', 'manual']], 16) },
    { bus: bus.b4, cells: cells([[1, 'ready'], [10, 'scrapping', 'manual']]) },
  ];

  test('March 2025 reads exactly as worked by hand (it must not change when the days move to a shared helper)', async () => {
    const res = await api('GET', '/sheets/status?month=2025-03', { token: users.supervisor.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sheet = res.body.data;
    assert.equal(sheet.month, '2025-03');
    assert.equal(sheet.today, uaeDay());
    assert.deepEqual(sheet.days, MARCH);
    const rows = expected();
    assert.deepEqual(
      sheet.buses,
      rows.map(({ bus: b, cells: c }) => ({ _id: id(b), fleetNumber: b.fleetNumber, make: b.make, model: 'Coach', cells: c })),
      'B3 starts on the 16th, the day it was added'
    );
    const summary = Object.fromEntries(['ready', 'repair', 'maintenance', 'tyreChange', 'batteryChange', 'accident', 'scrapping', 'removed'].map((s) => [s, MARCH.map((_, i) => rows.filter((r) => r.cells[i]?.status === s).length)]));
    assert.deepEqual(sheet.summary, summary);
    assert.deepEqual(sheet.summary.repair.slice(4, 7), [1, 1, 1]);
    assert.equal(sheet.summary.scrapping[30], 1);
  });

  test('a month before any of these buses has no rows', async () => {
    const sheet = (await api('GET', '/sheets/status?month=2024-11', { token: users.supervisor.token })).body.data;
    assert.ok(!sheet.buses.some((b) => [id(bus.b1), id(bus.b2), id(bus.b3), id(bus.b4)].includes(b._id)));
  });
});

describe('Availability', () => {
  test('March, day by day and in total', async () => {
    const data = await get('availability', { month: 3 });
    assertTotalsAddUp.availability(data);
    assert.equal(data.days.length, 31);
    const day = (n) => data.days[n - 1];
    // 1 March: B1, B2, B4 ready; B3 not added yet.
    assert.deepEqual({ counted: day(1).counted, ready: day(1).ready }, { counted: 3, ready: 3 });
    // 5 March: B1 in repair.
    assert.deepEqual({ counted: day(5).counted, ready: day(5).ready, repair: day(5).byStatus.repair }, { counted: 3, ready: 2, repair: 1 });
    assert.equal(day(5).availability, 2 / 3);
    // 10 March: B4 is scrapping, so it is not counted at all.
    assert.deepEqual({ counted: day(10).counted, ready: day(10).ready, scrapping: day(10).byStatus.scrapping }, { counted: 2, ready: 2, scrapping: 1 });
    // 16 March: B3 joins.
    assert.equal(day(16).counted, 3);
    // 20 March: B2's accident.
    assert.deepEqual({ counted: day(20).counted, ready: day(20).ready, accident: day(20).byStatus.accident }, { counted: 3, ready: 2, accident: 1 });
    // 28 March: B3's tyre change.
    assert.deepEqual({ counted: day(28).counted, ready: day(28).ready, tyreChange: day(28).byStatus.tyreChange }, { counted: 3, ready: 2, tyreChange: 1 });

    // Bus-days counted: B1 31 + B2 31 + B3 16 (16th–31st) + B4 9 (1st–9th) = 87.
    // Ready: B1 28 + B2 26 + B3 14 + B4 9 = 77.
    assert.deepEqual(data.months.map((m) => [m.month, m.counted, m.ready]), [['2025-03', 87, 77]]);
    assert.deepEqual(data.months[0].byStatus, { ready: 77, repair: 3, maintenance: 0, tyreChange: 2, batteryChange: 0, accident: 5, scrapping: 22, removed: 0 });
    assert.deepEqual(data.total, { counted: 87, ready: 77, availability: 77 / 87 });
  });

  test('the year adds bus-days, not daily percentages', async () => {
    const data = await get('availability');
    assertTotalsAddUp.availability(data);
    assert.equal(data.days.length, 365);
    // January 3 buses x 31, February 3 x 28, March as above, April to December B1, B2 and B3 every day.
    const expected = [[93, 93], [84, 84], [87, 77], [90, 90], [93, 93], [90, 90], [93, 93], [93, 93], [90, 90], [93, 93], [90, 90], [93, 93]];
    assert.deepEqual(data.months.map((m) => [m.counted, m.ready]), expected);
    assert.deepEqual(data.total, { counted: 1089, ready: 1079, availability: 1079 / 1089 });
    const averageOfDays = data.days.reduce((sum, d) => sum + d.availability, 0) / data.days.length;
    assert.notEqual(data.total.availability, averageOfDays, 'an average of daily figures would weigh a 2-bus day like a 3-bus day');
  });

  test('a year with no buses has nothing to divide', async () => {
    const data = await get('availability', { year: 2019 });
    assert.deepEqual(data.total, { counted: 0, ready: 0, availability: null });
    assert.ok(data.months.every((m) => m.availability === null && m.counted === 0));
    assert.ok(data.days.every((d) => d.counted === 0 && d.availability === null));
  });
});

describe('Downtime per bus', () => {
  test('the year, most days off the road first', async () => {
    const data = await get('downtime');
    assertTotalsAddUp.downtime(data);
    const pick = (row) => [row.fleetNumber, row.counted, row.ready, row.repair, row.maintenance, row.tyreChange, row.batteryChange, row.accident, row.offRoad, row.vsrs];
    assert.deepEqual(data.rows.map(pick), [
      // B2: 365 days, 5 in accident; VSRs t3, t4, t9.
      [bus.b2.fleetNumber, 365, 360, 0, 0, 0, 0, 5, 5, 3],
      // B1: 365 days, 3 in repair; VSRs t1, tNew, t2, t2b, t8 (t2c was declined, tPrev is 2024).
      [bus.b1.fleetNumber, 365, 362, 3, 0, 0, 0, 0, 3, 5],
      // B3: 16 March to 31 December is 291 days, 2 at the tyre change; VSRs t5, t6, m1, m2.
      [bus.b3.fleetNumber, 291, 289, 0, 0, 2, 0, 0, 2, 4],
      // B4: 1 January to 9 March, 68 days, before scrapping; VSRs t7, e1–e3, t10.
      [bus.b4.fleetNumber, 68, 68, 0, 0, 0, 0, 0, 0, 5],
    ]);
    assert.equal(data.rows[1].availability, 362 / 365);
    assert.equal(data.rows[0].make, 'hino');
    assert.deepEqual(
      { counted: data.total.counted, ready: data.total.ready, offRoad: data.total.offRoad, vsrs: data.total.vsrs, availability: data.total.availability },
      { counted: 1089, ready: 1079, offRoad: 10, vsrs: 17, availability: 1079 / 1089 },
      'the deleted bus has no days, so its VSR has no row here'
    );
  });

  test('one month, and one brand however it is spelt', async () => {
    const march = await get('downtime', { month: 3 });
    assert.deepEqual(march.rows.map((r) => [r.fleetNumber, r.counted, r.ready, r.offRoad, r.vsrs]), [
      [bus.b2.fleetNumber, 31, 26, 5, 1],
      [bus.b1.fleetNumber, 31, 28, 3, 0],
      [bus.b3.fleetNumber, 16, 14, 2, 1],
      [bus.b4.fleetNumber, 9, 9, 0, 1],
    ]);
    assert.deepEqual([march.total.counted, march.total.ready], [87, 77]);

    const hino = await get('downtime', { brand: 'HINO' });
    assert.deepEqual(hino.rows.map((r) => r.fleetNumber), [bus.b2.fleetNumber, bus.b1.fleetNumber]);
    assert.deepEqual([hino.total.counted, hino.total.ready], [730, 722]);

    const june = await get('downtime', { month: 6 });
    assert.ok(!june.rows.some((r) => r.fleetNumber === bus.b4.fleetNumber), 'a scrapped bus with no counted days and no VSRs drops out');
  });
});

describe('Cost per bus', () => {
  test('spend by month, committed and km for each bus', async () => {
    const data = await get('costs');
    assertTotalsAddUp.costs(data);
    assert.deepEqual(data.months, Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`));
    const row = (b) => data.rows.find((r) => r.busId === id(b));
    const months = (values) => Array.from({ length: 12 }, (_, i) => values[i + 1] ?? 0);

    // B1: January t1 1000.10 + tNew 50; February t2 450 (the rejected 600 does not count) + t2b 200.
    // Km 8000 + 4000 + (March unknown) + 8000 = 20000; 1700.10 / 20000 = 0.085005 → 0.085.
    assert.deepEqual(row(bus.b1), { busId: id(bus.b1), fleetNumber: bus.b1.fleetNumber, make: 'Hino', spend: months({ 1: 1050.1, 2: 650 }), totalSpend: 1700.1, committed: 0, vsrs: 5, km: 20000, spendPerKm: 0.085 });
    // B2: nothing accepted; t3's approved 3000 is committed. No readings, so no km.
    assert.deepEqual(row(bus.b2), { busId: id(bus.b2), fleetNumber: bus.b2.fleetNumber, make: 'hino', spend: months({}), totalSpend: 0, committed: 3000, vsrs: 3, km: null, spendPerKm: null });
    // B3: t5 2400 in March, m1 + m2 = 0.3 in September; t6's 800 committed. 8000 km in March, 0 in April.
    assert.deepEqual(row(bus.b3), { busId: id(bus.b3), fleetNumber: bus.b3.fleetNumber, make: 'Volvo', spend: months({ 3: 2400, 9: 0.3 }), totalSpend: 2400.3, committed: 800, vsrs: 4, km: 8000, spendPerKm: 0.3 });
    // B4: t7 5000 in March, 3 x 33.33 = 99.99 in August; t10's 600 committed (its invoice was rejected).
    // Km 0 + 40000 + 3000 = 43000; 5099.99 / 43000 = 0.11860... → 0.1186.
    assert.deepEqual(row(bus.b4), { busId: id(bus.b4), fleetNumber: bus.b4.fleetNumber, make: 'Volvo', spend: months({ 3: 5000, 8: 99.99 }), totalSpend: 5099.99, committed: 600, vsrs: 5, km: 43000, spendPerKm: 0.1186 });
    // The deleted bus still has its 700 in October.
    const gone = data.rows.find((r) => r.busId === String(t.tGone.busId));
    assert.deepEqual(gone, { busId: String(t.tGone.busId), fleetNumber: null, make: null, spend: months({ 10: 700 }), totalSpend: 700, committed: 0, vsrs: 1, km: null, spendPerKm: null });
    assert.equal(data.rows.at(-1), gone, 'a bus no longer on file comes last');

    assert.deepEqual(data.totals, { spend: months({ 1: 1050.1, 2: 650, 3: 7400, 8: 99.99, 9: 0.3, 10: 700 }), totalSpend: 9900.39, committed: 4400, vsrs: 18, km: 71000 });
  });

  test('filters: brand case-blind, kind of work and vendor', async () => {
    const hino = await get('costs', { brand: 'HINO' });
    assert.deepEqual(hino.rows.map((r) => r.fleetNumber), [bus.b1.fleetNumber, bus.b2.fleetNumber]);
    assert.deepEqual([hino.totals.totalSpend, hino.totals.committed, hino.totals.vsrs], [1700.1, 3000, 8]);

    // Repairs that are not accidents: t1, t2, t2b, t8 on B1 (1650.10), e1–e3 on B4 (99.99), tGone (700).
    const repairs = await get('costs', { type: 'repair' });
    assert.deepEqual([repairs.totals.totalSpend, repairs.totals.vsrs], [2450.09, 8]);
    const accidents = await get('costs', { type: 'accident' });
    assert.deepEqual([accidents.totals.totalSpend, accidents.totals.committed, accidents.totals.vsrs], [0, 3000, 3]);
    assert.deepEqual([(await get('costs', { type: 'maintenance' })).totals.totalSpend], [5000]);
    const brakes = await get('costs', { type: 'brakePads' });
    assert.deepEqual([brakes.totals.totalSpend, brakes.totals.committed, brakes.totals.vsrs], [0, 800, 1]);

    assert.equal((await get('costs', { vendorId: A.id })).totals.totalSpend, 2400.4);
    assert.equal((await get('costs', { vendorId: B.id })).totals.totalSpend, 7499.99);
  });

  test('an empty year is all zeros', async () => {
    const data = await get('costs', { year: 2019 });
    assert.deepEqual(data.rows, []);
    assert.deepEqual(data.totals, { spend: Array(12).fill(0), totalSpend: 0, committed: 0, vsrs: 0, km: 0 });
  });
});

describe('Vendors', () => {
  const pick = ({ vsrs, noCharge, spend, committed, trips, days, averageDays, late }) => ({ vsrs, noCharge, spend, committed, trips, days, averageDays, late });

  test('each vendor by kind of work, with subtotals and a grand total', async () => {
    const data = await get('vendors');
    assertTotalsAddUp.vendors(data);
    assert.deepEqual(data.kinds, ['repair', 'accident', 'oil', 'transmission', 'tyre', 'battery', 'brakePads', 'other']);
    const vendor = (v) => data.vendors.find((row) => row.vendorId === v.id);
    const a = vendor(A);
    assert.ok(a.name.startsWith('rp-a'));
    assert.deepEqual(a.rows.map((r) => [r.kind, pick(r)]), [
      // t1 (3 days, late), t2 (0 days), t8 (2 days, no charge); t2b rides in t2's trip, tGone has no trip.
      ['repair', { vsrs: 5, noCharge: 1, spend: 2350.1, committed: 0, trips: 3, days: 5, averageDays: 1.7, late: 1 }],
      ['accident', { vsrs: 1, noCharge: 0, spend: 0, committed: 3000, trips: 1, days: 5, averageDays: 5, late: 1 }],
      ['other', { vsrs: 3, noCharge: 0, spend: 50.3, committed: 0, trips: 0, days: 0, averageDays: null, late: 0 }],
    ]);
    assert.deepEqual(pick(a.subtotal), { vsrs: 9, noCharge: 1, spend: 2400.4, committed: 3000, trips: 4, days: 10, averageDays: 2.5, late: 2 });

    const b = vendor(B);
    assert.deepEqual(b.rows.map((r) => [r.kind, pick(r)]), [
      ['repair', { vsrs: 3, noCharge: 0, spend: 99.99, committed: 0, trips: 0, days: 0, averageDays: null, late: 0 }],
      // t9: 2 days against a promise of 1. t4 never went.
      ['accident', { vsrs: 2, noCharge: 1, spend: 0, committed: 0, trips: 1, days: 2, averageDays: 2, late: 1 }],
      ['oil', { vsrs: 1, noCharge: 0, spend: 5000, committed: 0, trips: 1, days: 0, averageDays: 0, late: 0 }],
      // At the depot: from the day work started, 28 March, to 29 March.
      ['tyre', { vsrs: 1, noCharge: 0, spend: 2400, committed: 0, trips: 1, days: 1, averageDays: 1, late: 0 }],
      ['battery', { vsrs: 1, noCharge: 0, spend: 0, committed: 600, trips: 0, days: 0, averageDays: null, late: 0 }],
      ['brakePads', { vsrs: 1, noCharge: 0, spend: 0, committed: 800, trips: 1, days: 3, averageDays: 3, late: 1 }],
    ]);
    assert.deepEqual(pick(b.subtotal), { vsrs: 9, noCharge: 1, spend: 7499.99, committed: 1400, trips: 4, days: 6, averageDays: 1.5, late: 2 });

    assert.deepEqual(pick(data.total), { vsrs: 18, noCharge: 2, spend: 9900.39, committed: 4400, trips: 8, days: 16, averageDays: 2, late: 4 });
  });

  test('one month: January holds the VSR raised at 23:30 on the 31st, February the one at 00:30 on the 1st', async () => {
    const january = await get('vendors', { month: 1 });
    assert.equal(january.total.spend, 1050.1, 't1 1000.10 + tNew 50');
    assert.equal(january.total.vsrs, 2);
    const february = await get('vendors', { month: 2 });
    assert.equal(february.total.spend, 650, 't2 450 + t2b 200; t2c was declined');
    assert.equal(february.total.vsrs, 2);
    assert.equal(february.total.trips, 1, 'the additional job adds no trip');
    const march = await get('vendors', { month: 3 });
    assert.deepEqual(pick(march.total), { vsrs: 3, noCharge: 0, spend: 7400, committed: 3000, trips: 3, days: 6, averageDays: 2, late: 1 });
    assert.deepEqual((await get('vendors', { month: 12 })).vendors, []);
  });
});

describe('Km and usage', () => {
  test('each bus by month, and the month bands', async () => {
    const data = await get('km');
    assertTotalsAddUp.km(data);
    assert.deepEqual(data.bands, [{ from: 1, to: 5000 }, { from: 5001, to: 10000 }, { from: 10001, to: 15000 }, { from: 15001, to: 20000 }, { from: 20001, to: 25000 }, { from: 25001, to: 30000 }, { from: 30001, to: null }]);
    const row = (b) => data.rows.find((r) => r.busId === id(b));
    const year = (values) => Array.from({ length: 12 }, (_, i) => (i + 1 in values ? values[i + 1] : null));
    assert.deepEqual(row(bus.b1).km, year({ 1: 8000, 2: 4000, 4: 8000 }), 'March has no reading of its own, so it is unknown');
    assert.equal(row(bus.b1).total, 20000);
    assert.equal(row(bus.b1).firstDay, '2024-12-01');
    assert.deepEqual(row(bus.b2).km, year({}));
    assert.equal(row(bus.b2).total, null, 'no readings at all');
    assert.deepEqual(row(bus.b3).km, year({ 3: 8000, 4: 0 }), 'from its first reading on the 16th');
    assert.equal(row(bus.b3).firstDay, '2025-03-16');
    assert.deepEqual(row(bus.b4).km, year({ 1: 0, 2: 40000, 3: 3000 }));
    assert.equal(row(bus.b4).total, 43000);

    const month = (m) => data.summary[m - 1];
    const pick = (s) => [s.fleet, s.bands, s.notOperated, s.noReadings, s.fleetKm];
    // January: B1 8000 (5,001–10,000), B4 0 (not operated), B2 nothing. B3 not on the fleet yet.
    assert.deepEqual(pick(month(1)), [3, [0, 1, 0, 0, 0, 0, 0], 1, 1, 8000]);
    // February: B1 4000 (1–5,000), B4 40000 (over 30,000), B2 nothing.
    assert.deepEqual(pick(month(2)), [3, [1, 0, 0, 0, 0, 0, 1], 0, 1, 44000]);
    // March: B3 8000, B4 3000; B1 and B2 nothing.
    assert.deepEqual(pick(month(3)), [4, [1, 1, 0, 0, 0, 0, 0], 0, 2, 11000]);
    // April: B1 8000, B3 0; B2 and B4 nothing.
    assert.deepEqual(pick(month(4)), [4, [0, 1, 0, 0, 0, 0, 0], 1, 2, 8000]);
    assert.deepEqual(pick(month(12)), [4, [0, 0, 0, 0, 0, 0, 0], 0, 4, 0]);
    assert.equal(data.total.fleetKm, 71000);
  });
});

describe('Repair categories', () => {
  test('every category, accidents included, with a totals row', async () => {
    const data = await get('categories');
    assertTotalsAddUp.categories(data);
    assert.deepEqual(data.rows.map((r) => r.category), ['ELECTRICAL', 'MECHANICAL', 'AC REPAIR', 'ENGINE', 'BODY', 'ACCIDENT', 'DIAGNOSTIC', 'DRIVETRAIN', 'SUSPENSION', 'BRAKES']);
    const row = (category) => {
      const { vsrs, breakdowns, noCharge, spend, committed, trips, days, averageDays } = data.rows.find((r) => r.category === category);
      return { vsrs, breakdowns, noCharge, spend, committed, trips, days, averageDays };
    };
    assert.deepEqual(row('ELECTRICAL'), { vsrs: 3, breakdowns: 0, noCharge: 0, spend: 99.99, committed: 0, trips: 0, days: 0, averageDays: null });
    assert.deepEqual(row('MECHANICAL'), { vsrs: 1, breakdowns: 0, noCharge: 0, spend: 200, committed: 0, trips: 0, days: 0, averageDays: null });
    // t1 1000.10 (3 days), t2 450 (0 days), tGone 700 (no trip).
    assert.deepEqual(row('ENGINE'), { vsrs: 3, breakdowns: 1, noCharge: 0, spend: 2150.1, committed: 0, trips: 2, days: 3, averageDays: 1.5 });
    assert.deepEqual(row('BODY'), { vsrs: 1, breakdowns: 0, noCharge: 1, spend: 0, committed: 0, trips: 1, days: 2, averageDays: 2 });
    // t3 (5 days, 3000 committed), t4 (breakdown, no trip), t9 (no charge, 2 days).
    assert.deepEqual(row('ACCIDENT'), { vsrs: 3, breakdowns: 1, noCharge: 1, spend: 0, committed: 3000, trips: 2, days: 7, averageDays: 3.5 });
    assert.deepEqual(row('BRAKES'), { vsrs: 0, breakdowns: 0, noCharge: 0, spend: 0, committed: 0, trips: 0, days: 0, averageDays: null });
    const { vsrs, breakdowns, noCharge, spend, committed, trips, days, averageDays } = data.total;
    assert.deepEqual({ vsrs, breakdowns, noCharge, spend, committed, trips, days, averageDays }, { vsrs: 11, breakdowns: 2, noCharge: 2, spend: 2450.09, committed: 3000, trips: 5, days: 12, averageDays: 2.4 });
  });

  test('one brand, spelt either way', async () => {
    const data = await get('categories', { brand: 'hino' });
    assert.equal(data.rows.find((r) => r.category === 'ENGINE').spend, 1450.1, 't1 and t2; the deleted bus has no brand');
    assert.equal(data.rows.find((r) => r.category === 'ELECTRICAL').vsrs, 0, 'B4 is a Volvo');
    assert.equal(data.total.spend, 1650.1);
  });
});

describe('Accidents', () => {
  test('severity by fault, and the list', async () => {
    const data = await get('accidents');
    assertTotalsAddUp.accidents(data);
    assert.deepEqual(data.severities, ['minor', 'medium', 'major', 'notRecorded']);
    assert.deepEqual(data.faults, ['ourDriver', 'otherParty', 'unknown', 'notRecorded']);
    assert.equal(data.matrix.major.otherParty, 1);
    assert.equal(data.matrix.minor.ourDriver, 1);
    assert.equal(data.matrix.notRecorded.notRecorded, 1, 't4 has no details yet');
    assert.equal(data.matrix.medium.unknown, 0);
    assert.deepEqual(data.bySeverity, { minor: 1, medium: 0, major: 1, notRecorded: 1 });
    assert.deepEqual(data.byFault, { ourDriver: 1, otherParty: 1, unknown: 0, notRecorded: 1 });
    assert.deepEqual(
      data.rows.map((r) => [r.vsrNumber, r.fleetNumber, r.severity, r.fault, r.vendorId, r.status, r.spend, r.committed, r.noChargeReason]),
      [
        [t.t3.vsrNumber, bus.b2.fleetNumber, 'major', 'otherParty', A.id, 'invoiceSubmitted', 0, 3000, null],
        [t.t4.vsrNumber, bus.b2.fleetNumber, null, null, B.id, 'sentToVendor', 0, 0, null],
        [t.t9.vsrNumber, bus.b2.fleetNumber, 'minor', 'ourDriver', B.id, 'completed', 0, 0, 'insurance'],
      ]
    );
    assert.equal(data.rows[0].createdAt, t.t3.createdAt.toISOString());
    assert.ok(data.rows[0].vendor.startsWith('rp-a'));
    assert.deepEqual(data.totals, { count: 3, spend: 0, committed: 3000 });
  });
});

describe('No-charge work', () => {
  test('reason by vendor, the list and the value recorded', async () => {
    const data = await get('free-work');
    assertTotalsAddUp.freeWork(data);
    assert.deepEqual(data.reasons, ['warranty', 'goodwill', 'insurance', 'freeOfCharge']);
    assert.deepEqual(data.vendors.map((v) => [v.vendorId, v.counts, v.total]), [
      [A.id, { warranty: 1, goodwill: 0, insurance: 0, freeOfCharge: 0 }, 1],
      [B.id, { warranty: 0, goodwill: 0, insurance: 1, freeOfCharge: 0 }, 1],
    ]);
    assert.deepEqual(
      data.rows.map((r) => [r.vsrNumber, r.fleetNumber, r.vendorId, r.kind, r.reason, r.recordedValue]),
      [
        [t.t8.vsrNumber, bus.b1.fleetNumber, A.id, 'repair', 'warranty', 450],
        [t.t9.vsrNumber, bus.b2.fleetNumber, B.id, 'accident', 'insurance', null],
      ]
    );
    assert.deepEqual(data.totals, { counts: { warranty: 1, goodwill: 0, insurance: 1, freeOfCharge: 0 }, total: 2, recordedValue: 450 });
  });
});

describe('Invoice check', () => {
  test('by default only the invoices that differ from the approved amount', async () => {
    const data = await get('invoice-check');
    assertTotalsAddUp.invoiceCheck(data);
    assert.deepEqual(data.rows.map((r) => [r.vsrNumber, r.approved, r.invoiced, r.difference]), [
      [t.t1.vsrNumber, 1000, 1000.1, 0.1],
      [t.t2.vsrNumber, 500, 450, -50], // the accepted 450, not the rejected 600
      [t.e1.vsrNumber, 33.34, 33.33, -0.01],
    ]);
    assert.deepEqual(data.totals, { count: 3, approved: 1533.34, invoiced: 1483.43, difference: -49.91 });
  });

  test('with all=true every accepted invoice, and the invoiced total is the spend', async () => {
    const data = await get('invoice-check', { all: 'true' });
    assertTotalsAddUp.invoiceCheck(data);
    assert.equal(data.rows.length, 12, 'not t3 (waiting), t10 (rejected), t6 (none), the no-charge jobs, t2c or tPrev');
    // 1000 + 50 + 500 + 200 + 2400 + 5000 + 33.34 + 33.33 + 33.33 + 0.1 + 0.2 + 700
    assert.deepEqual(data.totals, { count: 12, approved: 9950.3, invoiced: 9900.39, difference: -49.91 });
    const e = data.rows.find((r) => r.vsrNumber === t.e2.vsrNumber);
    assert.deepEqual([e.approved, e.invoiced, e.difference], [33.33, 33.33, 0]);
  });
});

describe('the reports agree with each other', () => {
  test('every reconciliation in the plan holds for 2025', async () => {
    const { costs } = await assertReconciles(users, YEAR, { brands: ['HINO', 'volvo'], vendorIds: [A.id, B.id] });
    assert.equal(costs.totals.totalSpend, 9900.39);
  });

  test('and for an empty year', async () => {
    await assertReconciles(users, 2019, { months: [1, 12] });
  });
});

describe('brake pads', () => {
  test('the fleet figures count brake pads with repairs', async () => {
    const res = await api('GET', `/reports/fleet?year=${YEAR}`, { token: users.purchasing.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Repairs: t1, t2, t2b, t8, e1–e3, tGone and the accidents t3, t4, t9 = 11, plus t6's brake pads.
    assert.equal(res.body.data.months[3].repair, 1, 'April: t6');
    assert.deepEqual(res.body.data.totals, { repair: 12, tyre: 1, battery: 1, maintenance: 1 });
  });

  test('purchasing reads the weekly report, which lists brake pads raised this week', async () => {
    // Added today, so 2025's figures above are untouched.
    const withPads = await fx.addBus('BP1', { make: 'Hino', created: new Date(), vendor: A.id, brakePads: { everyKm: 40000, lastKm: 0 } });
    const raised = await fx.addTicket({ bus: withPads, vendor: A.id, serviceType: 'brakePads', created: new Date(), status: 'sentToVendor' });
    assert.equal((await api('GET', '/reports/weekly', { token: users.vendor1.token })).status, 403);
    assert.equal((await api('GET', '/reports/weekly', { token: users.creator.token })).status, 403);
    const res = await api('GET', '/reports/weekly', { token: users.purchasing.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.raised.brakePads.some((row) => row._id === id(raised)));
    assert.ok(Array.isArray(res.body.data.due.brakePads));
  });

  test('brake pads due are listed only for buses that have the interval', async () => {
    const today = uaeDay();
    const withPads = await fx.addBus('BP2', { make: 'Hino', created: new Date(), vendor: A.id, brakePads: { everyKm: 40000, lastKm: 0 } });
    const without = await fx.addBus('BP3', { make: 'Hino', created: new Date(), vendor: A.id });
    await fx.addReading(withPads, today, 39500);
    await fx.addReading(without, today, 39500);
    const { due } = (await api('GET', '/reports/weekly', { token: users.supervisor.token })).body.data;
    assert.ok(!due.brakePads.some((row) => row.fleetNumber === without.fleetNumber), 'a bus added before brake pads had an interval is left out');
    const row = due.brakePads.find((r) => r.fleetNumber === withPads.fleetNumber);
    assert.ok(row, 'needs intervalStatus to measure brake pads (utils/intervals.js, backend-flow)');
    assert.deepEqual([row.state, row.left, row.unit, row.interval, row.lastService, row.currentKm], ['soon', 500, 'km', 40000, 0, 39500]);
  });

  test('the repair process sheet follows brake-pad VSRs', async () => {
    const res = await api('GET', '/sheets/repairs?month=2025-04', { token: users.supervisor.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.data.rows.find((r) => r._id === id(t.t6));
    assert.ok(row, 'brake pads are priced by estimate, so they are on the sheet');
    assert.equal(row.serviceType, 'brakePads');
    assert.equal(row.stage, 'received');
  });
});

describe('VSRs made through the API this year', () => {
  test('a no-charge accident at the depot and a paid repair read as the flow wrote them', async () => {
    const vendor = await newVendor('rp-api');
    const brand = `Api${run}`;
    const own = await createBus(users, 'RPAPI', vendor.id, { make: brand, rates: undefined });
    const ok = (res) => {
      assert.ok(res.status < 300, JSON.stringify(res.body));
      return res.body.data;
    };
    const put = (ticketId, path, token, body) => api('PUT', `/tickets/${ticketId}/${path}`, { token, body });
    const raise = async (body) => ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: own._id, currentReading: 500, ...body } }));

    // Raised at the depot, quoted at AED 0 under goodwill, done the same day: completed with no invoice.
    const free = await raise({ serviceType: 'repair', repairCategory: 'ACCIDENT', accident: { severity: 'medium', fault: 'unknown' }, location: 'depot' });
    ok(await estimate(free._id, vendor.token, { amount: '0', noChargeReason: 'goodwill' }));
    ok(await put(free._id, 'escalate', users.creator.token));
    ok(await put(free._id, 'approve', users.supervisor.token));
    ok(await put(free._id, 'acknowledge', vendor.token, { daysToComplete: 2 }));
    ok(await put(free._id, 'work/start', vendor.token, { km: 550 }));
    ok(await put(free._id, 'work/ready', vendor.token));
    assert.equal(ok(await put(free._id, 'vehicle/returned', users.creator.token, { km: 560 })).status, 'completed');

    // Approved at 900 and invoiced at 950.
    const paid = await toInvoiceAccepted(users, await raise({ serviceType: 'repair', repairCategory: 'ENGINE' }), vendor, { invoice: { amount: '950' } });

    const year = Number(uaeDay().slice(0, 4));
    const mine = await report(users.purchasing.token, 'costs', { year, vendorId: vendor.id });
    assert.deepEqual([mine.totals.totalSpend, mine.totals.committed, mine.totals.vsrs], [950, 0, 2]);

    const { vendors } = await report(users.purchasing.token, 'vendors', { year });
    const row = vendors.find((v) => v.vendorId === vendor.id);
    assert.deepEqual(
      { vsrs: row.subtotal.vsrs, noCharge: row.subtotal.noCharge, spend: row.subtotal.spend, trips: row.subtotal.trips, days: row.subtotal.days, late: row.subtotal.late },
      { vsrs: 2, noCharge: 1, spend: 950, trips: 2, days: 0, late: 0 },
      'the depot job is a trip from the day work started'
    );

    const accident = (await report(users.purchasing.token, 'accidents', { year })).rows.find((r) => r._id === free._id);
    assert.deepEqual([accident.severity, accident.fault, accident.noChargeReason, accident.status, accident.spend], ['medium', 'unknown', 'goodwill', 'completed', 0]);
    const freeRow = (await report(users.purchasing.token, 'free-work', { year })).rows.find((r) => r._id === free._id);
    assert.deepEqual([freeRow.reason, freeRow.kind, freeRow.vendorId, freeRow.recordedValue], ['goodwill', 'accident', vendor.id, null]);
    const check = (await report(users.purchasing.token, 'invoice-check', { year })).rows.find((r) => r._id === paid._id);
    assert.deepEqual([check.approved, check.invoiced, check.difference], [900, 950, 50]);

    const categories = await report(users.purchasing.token, 'categories', { year, brand });
    assert.deepEqual(categories.rows.filter((r) => r.vsrs).map((r) => [r.category, r.vsrs, r.noCharge, r.spend]), [['ENGINE', 1, 0, 950], ['ACCIDENT', 1, 1, 0]]);
    const downtime = await report(users.purchasing.token, 'downtime', { year, month: Number(uaeMonth().slice(5)), brand });
    assert.deepEqual(downtime.rows.map((r) => [r.fleetNumber, r.counted, r.vsrs]), [[own.fleetNumber, 1, 2]], 'added today, so one day counted');
  });

  test('everything the other test files made through the API this year reconciles', async () => {
    const year = Number(uaeDay().slice(0, 4));
    await assertReconciles(users, year, { brands: ['Hino'], vendorIds: [users.vendor1.id] });
  });
});

describe('this month', () => {
  test('days still to come count for nothing, and Availability still matches the status sheet', async () => {
    const month = uaeMonth();
    const [year, monthNumber] = month.split('-').map(Number);
    const data = await report(users.purchasing.token, 'availability', { year, month: monthNumber });
    assertTotalsAddUp.availability(data);
    const today = uaeDay();
    data.days.filter((d) => d.day > today).forEach((d) => assert.deepEqual([d.counted, d.ready, d.byStatus, d.availability], [null, null, null, null], d.day));
    const todayFigures = data.days.find((d) => d.day === today);
    assert.ok(todayFigures.counted >= 3, 'B1, B2 and B3 are still on the fleet today; B4 is scrapping');
    const sheet = (await api('GET', `/sheets/status?month=${month}`, { token: users.supervisor.token })).body.data;
    assertMatchesSheet(data, sheet);

    const km = await report(users.purchasing.token, 'km', { year });
    km.summary.slice(monthNumber).forEach((s) => assert.deepEqual([s.fleet, s.bands, s.notOperated, s.noReadings, s.fleetKm], [null, null, null, null, null], `${s.month} is still to come`));
    assert.ok(km.rows.every((r) => r.km.slice(monthNumber).every((k) => k === null)));
    assertTotalsAddUp.km(km);

    const downtime = await report(users.purchasing.token, 'downtime', { year, month: monthNumber });
    assert.equal(downtime.total.counted, data.total.counted);
    assert.equal(downtime.total.ready, data.total.ready);
  });
});
