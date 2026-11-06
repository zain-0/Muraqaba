/**
 * Shared by the purchasing report tests: a fixture builder that writes buses, VSRs, invoices and
 * daily-sheet entries straight into the test database (the API stamps everything with today's
 * date, and the reports need history), and the checks every report must pass whatever the data:
 * each total is the sum of its rows, and each report agrees with the ones the plan ties it to.
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api } from './helpers.js';
import { toAed, toFils } from '../utils/reportMaths.js';
import { daysInMonth, uaeDay } from '../utils/uaeTime.js';

export const uae = (local) => new Date(`${local}+04:00`);
export const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const COUNTED = ['ready', 'repair', 'maintenance', 'tyreChange', 'batteryChange', 'accident'];
const STATUSES = [...COUNTED, 'scrapping', 'removed'];
const OFF_ROAD = ['repair', 'maintenance', 'tyreChange', 'batteryChange', 'accident'];

export const connectModels = async () => {
  const { default: connectDB } = await import('../config/db.js');
  await connectDB({ maxAttempts: 2 });
  const [{ default: Bus }, { default: Ticket }, { default: Invoice }, daily] = await Promise.all([
    import('../models/Bus.js'),
    import('../models/Ticket.js'),
    import('../models/Invoice.js'),
    import('../models/BusDaily.js'),
  ]);
  return { Bus, Ticket, Invoice, BusStatusChange: daily.BusStatusChange, BusDailyReading: daily.BusDailyReading };
};

/** Writes test data with the dates given and removes all of it afterwards. */
export const fixture = (models, { prefix, creatorId }) => {
  const { Bus, Ticket, Invoice, BusStatusChange, BusDailyReading } = models;
  const made = { buses: [], tickets: [] };
  let seq = 0;

  const addBus = async (key, { make, created, vendor, brakePads }) => {
    const bus = await Bus.create({
      fleetNumber: `${prefix}-${key}`,
      make,
      model: 'Coach',
      year: 2020,
      expectedLifeYears: 15,
      intervals: {
        oil: { everyKm: 10000, lastKm: 0 },
        transmission: { everyKm: 60000, lastKm: 0 },
        tyre: { everyKm: 40000, lastKm: 0 },
        battery: { everyMonths: 18, lastDate: new Date('2024-01-01') },
        ...(brakePads ? { brakePads } : {}),
      },
      vendor,
      createdAt: created,
    });
    made.buses.push(bus._id);
    return bus;
  };

  const CLOSED = ['completed', 'declined'];
  /**
   * A VSR as it stands now. `invoices` are its invoices in the order submitted; the last is its
   * current one, as the API leaves it after a rejection and a resubmission.
   */
  const addTicket = async ({ bus, vendor, serviceType, repairCategory, created, status = 'completed', approved, invoices = [], vehicle, location, daysToComplete, parent, noChargeReason, quotationTotal, accident, isBreakdown }) => {
    seq += 1;
    const lastAt = vehicle?.returnedAt ?? created;
    const ticket = new Ticket({
      vsrNumber: `${prefix}-${String(seq).padStart(3, '0')}`,
      busId: bus?._id ?? bus,
      parentTicket: parent?._id,
      serviceType,
      repairCategory,
      location,
      accident,
      isBreakdown,
      daysToComplete,
      vendorId: vendor,
      createdBy: creatorId,
      status,
      approvedEstimate: approved,
      noChargeReason,
      breakdown: quotationTotal == null ? undefined : { partsTotal: quotationTotal, quotationTotal },
      vehicle,
      history: [{ status: 'sentToVendor', at: created }, ...(status === 'sentToVendor' ? [] : [{ status, at: lastAt }])],
      completedAt: CLOSED.includes(status) ? lastAt : undefined,
      createdAt: created,
    });
    await ticket.save();
    made.tickets.push(ticket._id);
    for (const { amount, status: invoiceStatus } of invoices) {
      const invoice = await Invoice.create({ ticketId: ticket._id, vendorId: vendor, amount, description: 'Work as estimated', invoiceNumber: `INV-${ticket.vsrNumber}`, status: invoiceStatus });
      ticket.invoice = invoice._id;
    }
    if (invoices.length) await ticket.save();
    return ticket;
  };

  const setStatus = (bus, date, status, source = 'manual') => BusStatusChange.create({ bus: bus._id ?? bus, date, status, source });
  const addReading = (bus, date, km) => BusDailyReading.create({ bus: bus._id ?? bus, date, km });

  const cleanup = async () => {
    const tickets = mongoose.trusted({ $in: made.tickets });
    const buses = mongoose.trusted({ $in: made.buses });
    await Promise.all([
      Invoice.deleteMany({ ticketId: tickets }),
      Ticket.deleteMany({ _id: tickets }),
      BusStatusChange.deleteMany({ bus: buses }),
      BusDailyReading.deleteMany({ bus: buses }),
    ]);
    await Bus.deleteMany({ _id: buses });
  };

  return { addBus, addTicket, setStatus, addReading, cleanup, made };
};

export const report = async (token, path, params = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
  const res = await api('GET', `/reports/${path}${qs ? `?${qs}` : ''}`, { token });
  assert.equal(res.status, 200, `${path}?${qs}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};

/** Money added the way the reports promise to: in fils. */
export const aedSum = (values) => toAed(values.reduce((sum, value) => sum + toFils(value), 0));
export const count = (values) => values.reduce((sum, value) => sum + (value ?? 0), 0);
const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

/** Each total is the sum of its rows, in every report. */
export const assertTotalsAddUp = {
  costs(data) {
    data.rows.forEach((row) => assert.equal(row.totalSpend, aedSum(row.spend), `${row.fleetNumber}: its months add up to its total`));
    MONTHS.forEach((m, i) => assert.equal(data.totals.spend[i], aedSum(data.rows.map((row) => row.spend[i])), `costs month ${m}`));
    assert.equal(data.totals.totalSpend, aedSum(data.rows.map((row) => row.totalSpend)), 'costs grand total');
    assert.equal(data.totals.totalSpend, aedSum(data.totals.spend), 'costs grand total is the month totals added');
    assert.equal(data.totals.committed, aedSum(data.rows.map((row) => row.committed)), 'costs committed');
    assert.equal(data.totals.vsrs, count(data.rows.map((row) => row.vsrs)), 'costs VSRs');
    assert.equal(data.totals.km, count(data.rows.map((row) => row.km)), 'costs km');
  },
  vendors(data) {
    const sums = (rows) => ({
      vsrs: count(rows.map((r) => r.vsrs)),
      noCharge: count(rows.map((r) => r.noCharge)),
      spend: aedSum(rows.map((r) => r.spend)),
      committed: aedSum(rows.map((r) => r.committed)),
      trips: count(rows.map((r) => r.trips)),
      days: count(rows.map((r) => r.days)),
      late: count(rows.map((r) => r.late)),
    });
    const average = ({ days, trips }) => (trips ? Math.round((days * 10) / trips) / 10 : null);
    const check = (total, rows, where) => {
      const expected = sums(rows);
      assert.deepEqual({ ...total, averageDays: undefined }, { ...expected, averageDays: undefined }, where);
      assert.equal(total.averageDays, average(expected), `${where}: average from the sums`);
    };
    data.vendors.forEach((vendor) => {
      vendor.rows.forEach((row) => assert.equal(row.averageDays, average(row), `${vendor.name} ${row.kind} average`));
      check(vendor.subtotal, vendor.rows, `${vendor.name} subtotal`);
    });
    check(data.total, data.vendors.map((vendor) => vendor.subtotal), 'vendors grand total');
  },
  categories(data) {
    const fields = ['vsrs', 'breakdowns', 'noCharge', 'trips', 'days'];
    fields.forEach((field) => assert.equal(data.total[field], count(data.rows.map((row) => row[field])), `categories ${field}`));
    assert.equal(data.total.spend, aedSum(data.rows.map((row) => row.spend)), 'categories spend');
    assert.equal(data.total.committed, aedSum(data.rows.map((row) => row.committed)), 'categories committed');
    [...data.rows, data.total].forEach((row) => assert.equal(row.averageDays, row.trips ? Math.round((row.days * 10) / row.trips) / 10 : null));
  },
  downtime(data) {
    ['counted', 'ready', ...OFF_ROAD, 'offRoad', 'vsrs'].forEach((field) => assert.equal(data.total[field], count(data.rows.map((row) => row[field])), `downtime ${field}`));
    [...data.rows, data.total].forEach((row) => {
      assert.equal(row.offRoad, count(OFF_ROAD.map((s) => row[s])), 'off the road is the five statuses');
      assert.equal(row.counted, row.ready + row.offRoad, 'counted days are ready or off the road');
      assert.equal(row.availability, row.counted ? row.ready / row.counted : null);
    });
    for (let i = 1; i < data.rows.length; i += 1) assert.ok(data.rows[i - 1].offRoad >= data.rows[i].offRoad, 'most days off the road first');
  },
  availability(data) {
    const past = data.days.filter((day) => day.counted !== null);
    data.days.forEach((day) => {
      if (day.counted === null) {
        assert.equal(day.ready, null);
        assert.equal(day.availability, null);
        return;
      }
      assert.equal(day.counted, count(COUNTED.map((s) => day.byStatus[s])), `${day.day}: counted leaves out scrapping and removed`);
      assert.equal(day.ready, day.byStatus.ready);
      assert.equal(day.availability, day.counted ? day.ready / day.counted : null);
    });
    data.months.forEach((month) => {
      const inMonth = past.filter((day) => day.day.startsWith(month.month));
      assert.equal(month.counted, count(inMonth.map((d) => d.counted)), `${month.month} counted`);
      assert.equal(month.ready, count(inMonth.map((d) => d.ready)), `${month.month} ready`);
      STATUSES.forEach((s) => assert.equal(month.byStatus[s], count(inMonth.map((d) => d.byStatus[s])), `${month.month} ${s}`));
      assert.equal(month.availability, month.counted ? month.ready / month.counted : null, 'bus-days, not an average of percentages');
    });
    assert.equal(data.total.counted, count(data.months.map((m) => m.counted)));
    assert.equal(data.total.ready, count(data.months.map((m) => m.ready)));
    assert.equal(data.total.availability, data.total.counted ? data.total.ready / data.total.counted : null);
  },
  km(data) {
    data.rows.forEach((row) => assert.equal(row.total, row.km.every((km) => km === null) ? null : count(row.km), `${row.fleetNumber} year km`));
    data.summary.forEach((month, i) => {
      if (month.fleet === null) return; // a month still to come
      const lastDay = daysInMonth(month.month).at(-1);
      const onFleet = data.rows.filter((row) => row.firstDay <= lastDay);
      assert.equal(month.fleet, onFleet.length, `${month.month}: buses on the fleet`);
      assert.equal(count(month.bands) + month.notOperated + month.noReadings, month.fleet, `${month.month}: bands + not operated + no readings = fleet`);
      assert.equal(month.fleetKm, count(data.rows.map((row) => row.km[i])), `${month.month}: fleet km is the buses' km added`);
      assert.equal(month.noReadings, onFleet.filter((row) => row.km[i] === null).length);
      assert.equal(month.notOperated, onFleet.filter((row) => row.km[i] === 0).length);
    });
    assert.equal(data.total.fleetKm, count(data.summary.map((m) => m.fleetKm)));
  },
  accidents(data) {
    const cells = Object.values(data.matrix).flatMap((row) => Object.values(row));
    assert.equal(count(cells), data.rows.length, 'matrix total is the list length');
    assert.equal(data.totals.count, data.rows.length);
    data.severities.forEach((s) => assert.equal(data.bySeverity[s], count(Object.values(data.matrix[s]))));
    data.faults.forEach((f) => assert.equal(data.byFault[f], count(data.severities.map((s) => data.matrix[s][f]))));
    data.rows.forEach((row) => assert.ok(data.matrix[row.severity ?? 'notRecorded'][row.fault ?? 'notRecorded'] >= 1));
    assert.equal(data.totals.spend, aedSum(data.rows.map((r) => r.spend)));
    assert.equal(data.totals.committed, aedSum(data.rows.map((r) => r.committed)));
  },
  freeWork(data) {
    data.vendors.forEach((vendor) => {
      assert.equal(vendor.total, count(Object.values(vendor.counts)));
      data.reasons.forEach((reason) => assert.equal(vendor.counts[reason], data.rows.filter((r) => r.vendorId === vendor.vendorId && r.reason === reason).length));
    });
    data.reasons.forEach((reason) => assert.equal(data.totals.counts[reason], count(data.vendors.map((v) => v.counts[reason]))));
    assert.equal(data.totals.total, data.rows.length);
    assert.equal(data.totals.recordedValue, aedSum(data.rows.map((r) => r.recordedValue)));
  },
  invoiceCheck(data) {
    data.rows.forEach((row) => assert.equal(toFils(row.difference), toFils(row.invoiced) - toFils(row.approved), `${row.vsrNumber}: difference`));
    assert.equal(data.totals.count, data.rows.length);
    assert.equal(data.totals.approved, aedSum(data.rows.map((r) => r.approved)));
    assert.equal(data.totals.invoiced, aedSum(data.rows.map((r) => r.invoiced)));
    assert.equal(data.totals.difference, aedSum(data.rows.map((r) => r.difference)));
    assert.equal(toFils(data.totals.difference), toFils(data.totals.invoiced) - toFils(data.totals.approved), 'Σdifference = Σinvoiced − Σapproved, exactly');
  },
};

/** Every reconciliation in the plan's table, for one year, plus each report's own totals. */
export const assertReconciles = async (users, year, { brands = [], vendorIds = [], months = MONTHS } = {}) => {
  const token = users.purchasing.token;
  const get = (path, params = {}) => report(token, path, { year, ...params });
  const fils = (aed) => toFils(aed);

  // Cost per bus = Queries, for the same filters.
  const costs = await get('costs');
  assertTotalsAddUp.costs(costs);
  const filterSets = [{}, ...brands.map((brand) => ({ brand })), ...vendorIds.map((vendorId) => ({ vendorId })), ...['repair', 'accident', 'maintenance', 'tyre', 'battery', 'other'].map((type) => ({ type }))];
  if (brands[0] && vendorIds[0]) filterSets.push({ brand: brands[0], vendorId: vendorIds[0], type: 'repair' });
  for (const filters of filterSets) {
    const filtered = await get('costs', filters);
    assertTotalsAddUp.costs(filtered);
    const query = await get('query', filters);
    assert.equal(filtered.totals.totalSpend, query.total.amount, `Cost per bus = Queries for ${JSON.stringify(filters)}`);
    assert.equal(filtered.totals.vsrs, query.total.count, `and the same VSRs for ${JSON.stringify(filters)}`);
  }

  // Km per bus on Cost per bus is the Km report's months added up.
  const km = await get('km');
  assertTotalsAddUp.km(km);
  const kmByBus = new Map(km.rows.map((row) => [row.busId, row.total]));
  costs.rows.forEach((row) => {
    if (row.busId && kmByBus.has(row.busId)) assert.equal(row.km, kmByBus.get(row.busId), `${row.fleetNumber}: km from the Km report`);
    assert.equal(row.spendPerKm, row.km ? Math.round((fils(row.totalSpend) * 100) / row.km) / 10000 : null);
  });

  // Vendors' spend = Cost per bus with no filters, for the year and for each month.
  const vendors = await get('vendors');
  assertTotalsAddUp.vendors(vendors);
  assert.equal(vendors.total.spend, costs.totals.totalSpend, 'Vendors spend = Cost per bus');
  assert.equal(vendors.total.vsrs, costs.totals.vsrs, 'Vendors VSRs = Cost per bus VSRs');
  assert.equal(vendors.total.committed, costs.totals.committed, 'Vendors committed = Cost per bus committed');
  for (const month of months) {
    const one = await get('vendors', { month });
    assertTotalsAddUp.vendors(one);
    assert.equal(one.total.spend, costs.totals.spend[month - 1], `Vendors spend in month ${month} = that month on Cost per bus`);
  }

  // Repair categories = Cost per bus for repairs + for accidents.
  for (const brand of [undefined, ...brands]) {
    const categories = await get('categories', { brand });
    assertTotalsAddUp.categories(categories);
    const [repairs, accidents] = await Promise.all([get('costs', { brand, type: 'repair' }), get('costs', { brand, type: 'accident' })]);
    assert.equal(fils(categories.total.spend), fils(repairs.totals.totalSpend) + fils(accidents.totals.totalSpend), `categories spend = repairs + accidents (${brand ?? 'all brands'})`);
    assert.equal(categories.total.vsrs, repairs.totals.vsrs + accidents.totals.vsrs);
  }

  // Accidents: matrix total = list length = accidents on Queries.
  const accidents = await get('accidents');
  assertTotalsAddUp.accidents(accidents);
  assert.equal(accidents.rows.length, (await get('query', { type: 'accident' })).total.count, 'accidents = Queries accident count');

  const freeWork = await get('free-work');
  assertTotalsAddUp.freeWork(freeWork);

  // Invoice check with every row: invoiced = Cost per bus spend.
  const everyInvoice = await get('invoice-check', { all: 'true' });
  assertTotalsAddUp.invoiceCheck(everyInvoice);
  assert.equal(everyInvoice.totals.invoiced, costs.totals.totalSpend, 'Σinvoiced = Cost per bus grand total');
  const differences = await get('invoice-check');
  assertTotalsAddUp.invoiceCheck(differences);
  assert.ok(differences.rows.every((row) => row.difference !== 0));
  assert.equal(differences.totals.difference, everyInvoice.totals.difference, 'rows with no difference add nothing to it');

  // Downtime = Availability, for the year and each month; Availability = the status sheet, day by day.
  const availability = await get('availability');
  assertTotalsAddUp.availability(availability);
  const downtime = await get('downtime');
  assertTotalsAddUp.downtime(downtime);
  assert.equal(downtime.total.counted, availability.total.counted, 'Downtime Σcounted = Availability');
  assert.equal(downtime.total.ready, availability.total.ready, 'Downtime Σready = Availability');
  for (const month of months) {
    const [oneAvailability, oneDowntime] = await Promise.all([get('availability', { month }), get('downtime', { month })]);
    assertTotalsAddUp.availability(oneAvailability);
    assertTotalsAddUp.downtime(oneDowntime);
    assert.equal(oneDowntime.total.counted, oneAvailability.total.counted, `month ${month}: Downtime counted = Availability`);
    assert.equal(oneDowntime.total.ready, oneAvailability.total.ready, `month ${month}: Downtime ready = Availability`);
    const fromYear = availability.months[month - 1];
    assert.equal(oneAvailability.total.counted, fromYear.counted, `month ${month} alone = that month of the year`);
    assert.equal(oneAvailability.total.ready, fromYear.ready);

    const sheet = await api('GET', `/sheets/status?month=${monthKey(year, month)}`, { token: users.supervisor.token });
    assert.equal(sheet.status, 200, JSON.stringify(sheet.body));
    assertMatchesSheet(oneAvailability, sheet.body.data);
  }
  return { costs, vendors, availability, downtime, km, accidents, freeWork, everyInvoice };
};

/** Availability's days and the status sheet's summary, cell for cell. */
export const assertMatchesSheet = (availability, sheet) => {
  assert.deepEqual(availability.days.map((d) => d.day), sheet.days);
  sheet.days.forEach((day, i) => {
    const figures = availability.days[i];
    if (day > sheet.today) {
      assert.equal(figures.counted, null, `${day} is still to come`);
      STATUSES.forEach((s) => assert.equal(sheet.summary[s][i], null));
      return;
    }
    STATUSES.forEach((s) => assert.equal(figures.byStatus[s], sheet.summary[s][i], `${day} ${s}: Availability = status sheet`));
  });
};

export const todayInUae = () => uaeDay();
