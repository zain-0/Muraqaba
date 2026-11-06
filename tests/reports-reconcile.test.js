/**
 * A randomised cross-check of purchasing's reports. Each round writes a few dozen VSRs for 2023
 * with random kinds, vendors, buses, months, amounts and invoice states (rejected, waiting,
 * replaced, accepted, no-charge, declined additional jobs, depot jobs, a deleted bus, times either
 * side of UAE midnight), then checks the headline figures against sums worked here from the data
 * as written, and checks every reconciliation in the plan.
 *
 * The seed is printed in each test name; rerun one with REPORT_SEED=<seed>.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { newVendor, run, signInEveryone } from './helpers.js';
import { assertReconciles, connectModels, fixture, report } from './reportChecks.js';
import { REPAIR_CATEGORIES } from '../models/Ticket.js';

const YEAR = 2023;
const FIRST_SEED = Number(process.env.REPORT_SEED) || (Date.now() % 1000000) + 1;
const SEEDS = process.env.REPORT_SEED ? [FIRST_SEED] : [FIRST_SEED, FIRST_SEED + 1];

/** mulberry32: small, fast and the same on every machine. */
const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pad = (n) => String(n).padStart(2, '0');
const DAY_MS = 24 * 60 * 60 * 1000;
/** A UAE wall-clock time n days and m minutes after a UAE day's midnight, as 'YYYY-MM-DDTHH:MM:00'. */
const uaeLocal = (day, minutes) => {
  const at = new Date(Date.parse(`${day}T00:00:00Z`) + minutes * 60000);
  return `${at.toISOString().slice(0, 16)}:00`;
};
const asDate = (local) => new Date(`${local}+04:00`);
const dayOf = (local) => local.slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysApart = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const fils = (aed) => Math.round(aed * 100);

let users;
let models;
let vendors;

before(async () => {
  users = await signInEveryone();
  models = await connectModels();
  vendors = [await newVendor('rr-a'), await newVendor('rr-b'), await newVendor('rr-c')];
});

after(() => mongoose.connection.close());

/** Writes one random 2023 and returns what the reports should say, worked from the data as written. */
const randomYear = async (seed, fx) => {
  const r = prng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const chance = (p) => r() < p;
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const amount = () => pick([() => int(1, 99) / 100, () => 33.33, () => int(100, 999999) / 100, () => int(1, 20) * 100, () => 0.1, () => 0.2])();
  const randomDay = (from, to) => addDays(from, int(0, daysApart(from, to)));
  const expected = { spend: 0, committed: 0, vsrs: 0, accidents: 0, trips: 0, days: 0, late: 0, noCharge: 0, recorded: 0, approvedOnAccepted: 0, months: Array(12).fill(0) };
  const inYear = (local) => local.startsWith(`${YEAR}-`);

  // Buses: brands spelt different ways, added before or during the year.
  const makes = ['Hino', 'hino', 'Volvo', 'VOLVO', 'King Long', 'Hino'];
  const buses = [];
  for (let i = 0; i < makes.length; i += 1) {
    const created = uaeLocal(randomDay('2022-11-01', '2023-08-31'), int(0, 1439));
    const vendor = pick(vendors);
    const bus = await fx.addBus(`R${i}`, { make: makes[i], created: asDate(created), vendor: vendor.id });
    buses.push({ doc: bus, created: dayOf(created), changes: [], readings: [] });
  }
  const deleted = new mongoose.Types.ObjectId();

  // The daily sheets: status changes on random days of 2023, readings that only go up.
  for (const bus of buses) {
    const days = new Set(Array.from({ length: int(0, 6) }, () => randomDay('2023-01-01', '2023-12-31')));
    for (const day of [...days].sort()) {
      const status = pick(['ready', 'ready', 'repair', 'maintenance', 'tyreChange', 'batteryChange', 'accident', 'scrapping', 'removed']);
      await fx.setStatus(bus.doc, day, status, pick(['manual', 'vsr']));
      bus.changes.push({ day, status });
    }
    let km = int(0, 100000);
    const readingDays = new Set(Array.from({ length: int(0, 25) }, () => randomDay('2022-12-01', '2023-12-31')));
    for (const day of [...readingDays].sort()) {
      km += chance(0.2) ? 0 : int(1, 9000);
      await fx.addReading(bus.doc, day, km);
      bus.readings.push({ day, km });
    }
  }

  // VSRs, some raised within an hour of UAE midnight at a month or year boundary.
  const STATES = ['raised', 'approved', 'noCharge', 'waiting', 'rejected', 'replaced', 'accepted', 'accepted'];
  const created = () => {
    if (chance(0.25)) {
      const month = int(1, 13); // 13 is 1 January 2024
      const boundary = month === 13 ? '2024-01-01' : `${YEAR}-${pad(month)}-01`;
      return uaeLocal(boundary, int(-60, 59));
    }
    return uaeLocal(randomDay('2023-01-01', '2023-12-31'), int(0, 1439));
  };

  const addVsr = async ({ parent, raisedAt, bus, vendor }) => {
    const serviceType = parent ? pick(['repair', 'other']) : pick(['repair', 'repair', 'repair', 'oil', 'transmission', 'tyre', 'battery', 'brakePads', 'other']);
    const repairCategory = serviceType === 'repair' ? (chance(0.3) ? 'ACCIDENT' : pick(REPAIR_CATEGORIES)) : undefined;
    const state = parent && chance(0.3) ? 'declined' : pick(STATES);
    const approved = ['raised', 'declined'].includes(state) ? undefined : state === 'noCharge' ? 0 : amount();
    const invoiceAmount = approved === undefined ? 0 : chance(0.6) ? approved : amount();
    const invoices = {
      waiting: [{ amount: invoiceAmount, status: 'invoicePending' }],
      rejected: [{ amount: invoiceAmount, status: 'rejected' }],
      replaced: [{ amount: amount(), status: 'rejected' }, { amount: invoiceAmount, status: 'approved' }],
      accepted: [{ amount: invoiceAmount, status: 'approved' }],
    }[state] ?? [];
    const status = { raised: 'sentToVendor', declined: 'declined', approved: pick(['approved', 'acknowledged', 'vehicleSent', 'vehicleReturned']), noCharge: 'completed', waiting: 'invoiceSubmitted', rejected: 'invoiceRejected', replaced: pick(['invoiceAccepted', 'completed']), accepted: pick(['invoiceAccepted', 'grnCreated', 'completed']) }[state];
    const back = !['raised', 'declined', 'approved'].includes(state) || status === 'vehicleReturned';
    const location = parent ? parent.location : pick(['vendorWorkshop', 'vendorWorkshop', 'depot', 'thirdParty']);
    let vehicle;
    let trip = null;
    if (parent) {
      vehicle = parent.toObject().vehicle; // an additional job carries its parent's dates; they must not count twice
    } else if (back && chance(0.85)) {
      const start = uaeLocal(addDays(dayOf(raisedAt), int(0, 3)), int(0, 1439));
      const end = uaeLocal(addDays(dayOf(start), int(0, 10)), int(0, 1439));
      vehicle = location === 'depot' ? { workStartedAt: asDate(start), returnedAt: asDate(end) } : { sentAt: asDate(start), returnedAt: asDate(end) };
      trip = Math.max(daysApart(dayOf(start), dayOf(end)), 0);
    }
    const daysToComplete = chance(0.8) ? int(1, 7) : undefined;
    const noChargeReason = state === 'noCharge' ? pick(['warranty', 'goodwill', 'insurance', 'freeOfCharge']) : undefined;
    const quotationTotal = state === 'noCharge' && chance(0.6) ? amount() : undefined;
    const accident = repairCategory === 'ACCIDENT' && chance(0.7) ? { severity: pick(['minor', 'medium', 'major']), fault: pick(['ourDriver', 'otherParty', 'unknown']) } : undefined;
    const ticket = await fx.addTicket({ bus, vendor: vendor.id, serviceType, repairCategory, created: asDate(raisedAt), status, approved, invoices, vehicle, location, daysToComplete, parent, noChargeReason, quotationTotal, accident, isBreakdown: chance(0.3) });

    if (inYear(raisedAt) && state !== 'declined') {
      const current = invoices.at(-1);
      const accepted = current?.status === 'approved';
      expected.vsrs += 1;
      if (accepted) {
        expected.spend += fils(current.amount);
        expected.months[Number(raisedAt.slice(5, 7)) - 1] += fils(current.amount);
        expected.approvedOnAccepted += fils(approved);
      } else if (approved !== undefined) {
        expected.committed += fils(approved);
      }
      if (serviceType === 'repair' && repairCategory === 'ACCIDENT') expected.accidents += 1;
      if (noChargeReason) {
        expected.noCharge += 1;
        expected.recorded += fils(quotationTotal ?? 0);
      }
      if (trip !== null) {
        expected.trips += 1;
        expected.days += trip;
        if (daysToComplete !== undefined && trip > daysToComplete) expected.late += 1;
      }
    }
    return ticket;
  };

  for (let i = 0; i < 40; i += 1) {
    const bus = chance(0.08) ? deleted : pick(buses).doc;
    const parent = await addVsr({ raisedAt: created(), bus, vendor: pick(vendors) });
    if (chance(0.3)) {
      for (let j = 0; j < int(1, 2); j += 1) {
        const parentDay = new Date(parent.createdAt.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);
        const at = uaeLocal(addDays(parentDay, int(0, 4)), int(0, 1439));
        await addVsr({ parent, raisedAt: at, bus: parent.busId, vendor: vendors.find((v) => v.id === String(parent.vendorId)) });
      }
    }
  }

  // Bus-days, worked the plain way: each day of 2023 up to today, from the bus's first day on the fleet.
  const today = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
  let counted = 0;
  let ready = 0;
  for (const bus of buses) {
    const firstDay = [bus.created, ...bus.changes.map((c) => c.day), ...bus.readings.map((rd) => rd.day)].sort()[0];
    for (let day = `${YEAR}-01-01`; day <= `${YEAR}-12-31` && day <= today; day = addDays(day, 1)) {
      if (day < firstDay) continue;
      const status = bus.changes.filter((c) => c.day <= day).at(-1)?.status ?? 'ready';
      if (status === 'scrapping' || status === 'removed') continue;
      counted += 1;
      if (status === 'ready') ready += 1;
    }
  }
  return { ...expected, counted, ready };
};

describe('randomised years reconcile', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: the figures match the data and every report agrees with the others`, async () => {
      const fx = fixture(models, { prefix: `RR${run}s${seed}`, creatorId: users.creator.id });
      try {
        const expected = await randomYear(seed, fx);
        const token = users.purchasing.token;
        const aed = (f) => f / 100;

        const costs = await report(token, 'costs', { year: YEAR });
        assert.equal(costs.totals.totalSpend, aed(expected.spend), 'spend');
        assert.equal(costs.totals.committed, aed(expected.committed), 'committed');
        assert.equal(costs.totals.vsrs, expected.vsrs, 'VSRs, declined jobs and other years left out');
        assert.deepEqual(costs.totals.spend, expected.months.map(aed), 'spend by UAE month raised');

        const vendorsReport = await report(token, 'vendors', { year: YEAR });
        assert.deepEqual(
          [vendorsReport.total.trips, vendorsReport.total.days, vendorsReport.total.late, vendorsReport.total.noCharge],
          [expected.trips, expected.days, expected.late, expected.noCharge],
          'trips, days at the workshop, late trips and no-charge VSRs'
        );

        const accidents = await report(token, 'accidents', { year: YEAR });
        assert.equal(accidents.rows.length, expected.accidents);
        const freeWork = await report(token, 'free-work', { year: YEAR });
        assert.deepEqual([freeWork.totals.total, freeWork.totals.recordedValue], [expected.noCharge, aed(expected.recorded)]);
        const invoices = await report(token, 'invoice-check', { year: YEAR, all: 'true' });
        assert.deepEqual([invoices.totals.approved, invoices.totals.invoiced], [aed(expected.approvedOnAccepted), aed(expected.spend)]);

        const availability = await report(token, 'availability', { year: YEAR });
        assert.deepEqual([availability.total.counted, availability.total.ready], [expected.counted, expected.ready], 'bus-days counted and ready');

        await assertReconciles(users, YEAR, { brands: ['hino', 'VOLVO', 'King Long'], vendorIds: vendors.map((v) => v.id) });
      } finally {
        await fx.cleanup();
      }
    });
  }
});
