/**
 * The arithmetic behind purchasing's reports, checked on its own without the API. tests/run.mjs
 * runs every *.test.js, so this file must not need a server or a database; it imports only
 * pure helpers. Run it alone with: node --test tests/report-maths.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BANDS,
  averageDays,
  bandIndex,
  brandKey,
  committedFils,
  daysBetween,
  daysOfYear,
  isLate,
  kindOf,
  kmInMonth,
  ratio,
  spendFils,
  spendPerKm,
  toAed,
  toFils,
  workshopDays,
} from '../utils/reportMaths.js';

const at = (iso) => new Date(iso);

describe('money in fils', () => {
  test('0.1 + 0.2 is 0.3 once added in fils', () => {
    assert.notEqual(0.1 + 0.2, 0.3, 'the floating-point trap this guards against');
    assert.equal(toAed(toFils(0.1) + toFils(0.2)), 0.3);
  });

  test('three times 33.33 is 99.99, never 100 and never 99.98999', () => {
    const fils = toFils(33.33) + toFils(33.33) + toFils(33.33);
    assert.equal(fils, 9999);
    assert.equal(toAed(fils), 99.99);
  });

  test('amounts whose x100 lands just off a whole fils still round to it', () => {
    assert.equal(0.57 * 100, 56.99999999999999, 'the raw product a plain Math.floor or cast would truncate');
    assert.equal(toFils(0.57), 57);
    assert.equal(toFils(1.13), 113);
    assert.equal(toFils(1.1), 110, '1.1 * 100 is 110.00000000000001');
    assert.equal(toAed(toFils(0.57) + toFils(0.29)), 0.86, '0.57 + 0.29 is 0.8599999999999999 in floats');
    assert.equal(toAed(toFils(1000.1) + toFils(0.57)), 1000.67, 'and 1000.6700000000001');
    assert.equal(toFils(0), 0);
    assert.equal(toFils(undefined), 0);
    assert.equal(toFils(null), 0);
  });
});

describe('spend and committed for one VSR', () => {
  const accepted = (amount) => ({ status: 'approved', amount });
  test('spend is the current invoice only when it was accepted', () => {
    assert.equal(spendFils({ status: 'completed', invoice: accepted(1000.1) }), 100010);
    assert.equal(spendFils({ status: 'invoiceSubmitted', invoice: { status: 'invoicePending', amount: 900 } }), 0);
    assert.equal(spendFils({ status: 'invoiceRejected', invoice: { status: 'rejected', amount: 900 } }), 0);
    assert.equal(spendFils({ status: 'vehicleReturned' }), 0);
    assert.equal(spendFils({ status: 'vehicleReturned', invoice: null }), 0);
  });

  test('a declined job spends and commits nothing, whatever it carries', () => {
    const declined = { status: 'declined', approvedEstimate: 300, invoice: accepted(300) };
    assert.equal(spendFils(declined), 0);
    assert.equal(committedFils(declined), 0);
  });

  test('committed is the approved estimate until an invoice is accepted', () => {
    assert.equal(committedFils({ status: 'approved', approvedEstimate: 500 }), 50000);
    assert.equal(committedFils({ status: 'invoiceSubmitted', approvedEstimate: 500, invoice: { status: 'invoicePending', amount: 450 } }), 50000);
    assert.equal(committedFils({ status: 'invoiceRejected', approvedEstimate: 500, invoice: { status: 'rejected', amount: 650 } }), 50000);
    assert.equal(committedFils({ status: 'completed', approvedEstimate: 500, invoice: accepted(450) }), 0, 'once accepted it is spend, not committed');
  });

  test('nothing is committed before approval, and a no-charge job commits 0', () => {
    assert.equal(committedFils({ status: 'estimateSubmitted' }), 0);
    assert.equal(committedFils({ status: 'completed', approvedEstimate: 0, noChargeReason: 'warranty' }), 0);
  });
});

describe('days', () => {
  test('whole calendar days between two UAE days, across months and leap years', () => {
    assert.equal(daysBetween('2025-02-01', '2025-02-04'), 3);
    assert.equal(daysBetween('2025-02-10', '2025-02-10'), 0);
    assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, '2024 is a leap year');
    assert.equal(daysBetween('2025-02-28', '2025-03-01'), 1);
    assert.equal(daysBetween('2024-12-31', '2025-01-01'), 1);
  });

  test('a year has every one of its days, leap years included', () => {
    assert.equal(daysOfYear(2025).length, 365);
    assert.equal(daysOfYear(2024).length, 366);
    assert.equal(daysOfYear(2025)[0], '2025-01-01');
    assert.equal(daysOfYear(2025).at(-1), '2025-12-31');
    assert.equal(daysOfYear(2024)[59], '2024-02-29');
  });

  test('days at the workshop run from sent to back, in UAE days', () => {
    const trip = { vehicle: { sentAt: at('2025-02-01T08:00:00+04:00'), returnedAt: at('2025-02-04T18:00:00+04:00') } };
    assert.equal(workshopDays(trip), 3);
    const sameDay = { vehicle: { sentAt: at('2025-02-10T10:00:00+04:00'), returnedAt: at('2025-02-10T16:00:00+04:00') } };
    assert.equal(workshopDays(sameDay), 0);
  });

  test('just before and just after UAE midnight are two days, though UTC calls them one', () => {
    // 23:30 UAE is 19:30 UTC and 00:30 UAE the next day is 20:30 UTC: one UTC date, two UAE days.
    const trip = { vehicle: { sentAt: at('2025-02-01T23:30:00+04:00'), returnedAt: at('2025-02-02T00:30:00+04:00') } };
    assert.equal(trip.vehicle.sentAt.toISOString().slice(0, 10), trip.vehicle.returnedAt.toISOString().slice(0, 10));
    assert.equal(workshopDays(trip), 1);
  });

  test('a depot job counts from the day work started', () => {
    const depot = { location: 'depot', vehicle: { workStartedAt: at('2025-03-28T09:00:00+04:00'), returnedAt: at('2025-03-29T15:00:00+04:00') } };
    assert.equal(workshopDays(depot), 1);
    assert.equal(workshopDays({ ...depot, vehicle: { ...depot.vehicle, sentAt: at('2025-03-01T09:00:00+04:00') } }), 1, 'a stray sent date is ignored');
  });

  test('an additional job rides in its parent\'s trip, so it has no days of its own', () => {
    const job = { parentTicket: 'p', vehicle: { sentAt: at('2025-02-10T10:00:00+04:00'), returnedAt: at('2025-02-12T10:00:00+04:00') } };
    assert.equal(workshopDays(job), null);
  });

  test('a bus not back yet, or with no start date, has no trip to count', () => {
    assert.equal(workshopDays({ vehicle: { sentAt: at('2025-02-01T08:00:00+04:00') } }), null);
    assert.equal(workshopDays({ vehicle: { returnedAt: at('2025-02-01T08:00:00+04:00') } }), null);
    assert.equal(workshopDays({ location: 'depot', vehicle: { sentAt: at('2025-02-01T08:00:00+04:00'), returnedAt: at('2025-02-02T08:00:00+04:00') } }), null);
    assert.equal(workshopDays({}), null);
  });

  test('a return dated before the start counts as 0 days, never negative', () => {
    assert.equal(workshopDays({ vehicle: { sentAt: at('2025-02-05T08:00:00+04:00'), returnedAt: at('2025-02-04T08:00:00+04:00') } }), 0);
  });

  test('late means more days at the workshop than the vendor promised', () => {
    assert.equal(isLate({ daysToComplete: 2 }, 3), true);
    assert.equal(isLate({ daysToComplete: 3 }, 3), false);
    assert.equal(isLate({ daysToComplete: 3 }, null), false, 'no trip');
    assert.equal(isLate({}, 9), false, 'no promise to break');
  });

  test('average days has one decimal and is worked from the sums', () => {
    assert.equal(averageDays(5, 3), 1.7);
    assert.equal(averageDays(10, 4), 2.5);
    assert.equal(averageDays(1, 4), 0.3, '0.25 rounds half up');
    assert.equal(averageDays(0, 2), 0);
    assert.equal(averageDays(0, 0), null, 'no trips, no average');
  });
});

describe('ratios', () => {
  test('availability is ready over counted, and nothing when nothing was counted', () => {
    assert.equal(ratio(77, 87), 77 / 87);
    assert.equal(ratio(0, 5), 0);
    assert.equal(ratio(0, 0), null);
  });

  test('spend per km has four decimals and needs some km', () => {
    assert.equal(spendPerKm(170010, 20000), 0.085);
    assert.equal(spendPerKm(509999, 43000), 0.1186);
    assert.equal(spendPerKm(1000, 0), null);
    assert.equal(spendPerKm(1000, null), null);
    assert.equal(spendPerKm(0, 5000), 0);
  });
});

describe('km per month from the daily readings', () => {
  const readings = [
    { date: '2024-12-31', km: 10000 },
    { date: '2025-01-15', km: 14000 },
    { date: '2025-01-31', km: 18000 },
    { date: '2025-02-20', km: 22000 },
    { date: '2025-04-30', km: 30000 },
  ];

  test('the month\'s last reading less the last one before the month', () => {
    assert.equal(kmInMonth(readings, '2025-01'), 8000, '18000 - 10000 from 31 December');
    assert.equal(kmInMonth(readings, '2025-02'), 4000, '22000 - 18000');
    assert.equal(kmInMonth(readings, '2025-04'), 8000, '30000 - 22000: April carries the gap left by March');
  });

  test('a month with no reading of its own is unknown, not 0', () => {
    assert.equal(kmInMonth(readings, '2025-03'), null);
    assert.equal(kmInMonth(readings, '2025-05'), null);
    assert.equal(kmInMonth([], '2025-01'), null);
  });

  test('with nothing before the month it starts from the month\'s first reading', () => {
    assert.equal(kmInMonth([{ date: '2025-03-16', km: 500 }, { date: '2025-03-31', km: 8500 }], '2025-03'), 8000);
    assert.equal(kmInMonth([{ date: '2025-01-31', km: 60000 }], '2025-01'), 0, 'one reading alone: not operated');
  });

  test('the order the readings come in does not matter', () => {
    assert.equal(kmInMonth([...readings].reverse(), '2025-01'), 8000);
  });

  test('a reading lower than the one before (a slip) gives 0, never negative km', () => {
    assert.equal(kmInMonth([{ date: '2025-01-31', km: 5000 }, { date: '2025-02-10', km: 4000 }], '2025-02'), 0);
  });

  test('the bands are 5,000 km wide up to 30,000 and 0 km is not operated', () => {
    assert.equal(BANDS.length, 7);
    assert.deepEqual(BANDS[0], { from: 1, to: 5000 });
    assert.deepEqual(BANDS[6], { from: 30001, to: null });
    assert.equal(bandIndex(0), -1);
    assert.equal(bandIndex(1), 0);
    assert.equal(bandIndex(5000), 0);
    assert.equal(bandIndex(5001), 1);
    assert.equal(bandIndex(10000), 1);
    assert.equal(bandIndex(25001), 5);
    assert.equal(bandIndex(30000), 5);
    assert.equal(bandIndex(30001), 6);
    assert.equal(bandIndex(1e6), 6);
  });
});

describe('grouping', () => {
  test('an accident is its own kind of work, and brake pads and transmission are repairs', () => {
    assert.equal(kindOf({ serviceType: 'accident' }), 'accident');
    assert.equal(kindOf({ serviceType: 'repair', repairCategory: 'ENGINE' }), 'repair');
    assert.equal(kindOf({ serviceType: 'repair', repairCategory: 'BRAKE PADS' }), 'repair');
    assert.equal(kindOf({ serviceType: 'repair', repairCategory: 'TRANSMISSION' }), 'repair');
    assert.equal(kindOf({ serviceType: 'oil' }), 'oil');
    assert.equal(kindOf({ serviceType: 'repair', repairCategory: 'ACCIDENT' }), 'accident', 'a record not yet migrated');
  });

  test('brands match case-blind and ignore stray spaces', () => {
    assert.equal(brandKey('Hino'), brandKey('hino'));
    assert.equal(brandKey(' HINO '), 'hino');
    assert.equal(brandKey(undefined), '');
  });
});
