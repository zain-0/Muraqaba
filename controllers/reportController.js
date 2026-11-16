/**
 * Purchasing's reports, the fleet's month figures and the weekly report. Fleets are small, so
 * these load the VSRs of the period and count them here rather than in Mongo.
 *
 * The rules every purchasing report follows (and tests/reports-purchasing.test.js checks):
 * - A VSR belongs to the UAE month it was raised in. Declined additional jobs never count.
 * - Spend is the VSR's current invoice once accepted; committed is the approved estimate until
 *   then. Money is added in whole fils, so every total is exactly the sum of its rows.
 * - Days are UAE days and days after today never count. Bus days come from utils/fleetDays.js,
 *   the same function the daily status sheet uses.
 * - A trip is a main VSR whose bus is back; additional jobs ride in their parent's trip.
 * - A period is a year, one month of it, or custom dates (`from` and `to`, UAE days, which win over
 *   the year and month). Month tables then have one entry for each month the dates touch, and a
 *   month cut short by them counts only its days in range.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket, { ACCIDENT_FAULTS, ACCIDENT_SEVERITIES, NO_CHARGE_REASONS, REPAIR_CATEGORIES } from '../models/Ticket.js';
import User from '../models/User.js';
import { Lpo, LPO_KINDS } from '../models/Purchase.js';
import { BUS_DAY_STATUSES, BusDailyReading } from '../models/BusDaily.js';
import { asyncHandler } from '../middleware/errorMiddleware.js';
import { COUNTED, fleetBuses, fleetDays, statusSummary } from '../utils/fleetDays.js';
import { intervalServiceOf, intervalStatus, latestKmByBus } from '../utils/intervals.js';
import { offFleetBusIds } from '../utils/busDay.js';
import { USER_FIELDS } from '../utils/query.js';
import { amountTotals, balancesFor } from '../utils/lpoBalance.js';
import { isInDate } from '../utils/lpoDeduction.js';
import { BANDS, averageDays, bandIndex, brandKey, committedFils, daysInRange, daysOfYear, isLate, kindOf, kmInMonth, kmInRange, ratio, spendFils, spendPerKm, toAed, toFils, workshopDays } from '../utils/reportMaths.js';
import { daysInMonth, endOfUaeDay, startOfUaeDay, uaeDay, uaeMonth } from '../utils/uaeTime.js';

// Maintenance is the oil service alone since 2026-11-11, when transmission became a repair category.
const MAINTENANCE = ['oil'];
const NOT_DECLINED = mongoose.trusted({ $ne: 'declined' });
// The kinds of work in the order the reports list them.
const WORK_KINDS = ['repair', 'accident', 'oil', 'tyre', 'battery', 'other'];

const matchesType = (ticket, type) => {
  if (!type) return true;
  const kind = kindOf(ticket);
  return type === 'maintenance' ? MAINTENANCE.includes(kind) : kind === type;
};

const sameBrand = (make, brand) => brandKey(make) === brandKey(brand);

const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
const monthsOf = (year) => Array.from({ length: 12 }, (_, i) => monthKey(year, i + 1));

/** The UAE days of a year, or of one month of it. */
const periodDays = (year, month) => (month ? daysInMonth(monthKey(year, month)) : daysOfYear(year));

/**
 * The checked query's period: `days` are the UAE days it covers and `months` the 'YYYY-MM' months
 * they fall in. Custom dates (`from` and `to`) win, and then year and month are null; otherwise it
 * is the year (this UAE year if left out) and month (null for the whole year), with no from or to.
 */
const periodOf = (query) => {
  if (query.from && query.to) {
    const days = daysInRange(query.from, query.to);
    return { year: null, month: null, from: query.from, to: query.to, days, months: [...new Set(days.map((day) => day.slice(0, 7)))] };
  }
  const year = query.year ? Number(query.year) : Number(uaeDay().slice(0, 4));
  const month = query.month ? Number(query.month) : null;
  return { year, month, from: null, to: null, days: periodDays(year, month), months: month ? [monthKey(year, month)] : monthsOf(year) };
};

/** What a report says of custom dates among its filters: nothing at all for a year or a month. */
const rangeOf = ({ from, to }) => (from ? { from, to } : {});

/** createdAt within the period's UAE days: 00:30 UAE on 1 February is February, though UTC still says 31 January. */
const raisedIn = ({ days }) => mongoose.trusted({ $gte: startOfUaeDay(days[0]), $lte: endOfUaeDay(days.at(-1)) });

/** Where a VSR's month sits among the period's months. */
const monthPosition = (period, when) => period.months.indexOf(uaeMonth(when));

// Each brand once, spelt the way most buses spell it.
export const brandsFrom = (buses) => {
  const spellings = new Map();
  buses.forEach(({ make }) => {
    const counts = spellings.get(brandKey(make)) ?? new Map();
    counts.set(make, (counts.get(make) ?? 0) + 1);
    spellings.set(brandKey(make), counts);
  });
  return [...spellings.values()].map((counts) => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]).sort((a, b) => a.localeCompare(b));
};

/** The lists the report filters choose from. */
const filterOptions = async () => {
  const [buses, vendors] = await Promise.all([Bus.find().select('fleetNumber make').sort({ fleetNumber: 1 }), User.find({ role: 'vendor' }).select('name').sort({ name: 1 })]);
  return { brands: brandsFrom(buses), vendors, buses };
};

const REPORT_FIELDS = 'vsrNumber busId vendorId parentTicket serviceType repairCategory location accident isBreakdown daysToComplete status approvedEstimate noChargeReason breakdown.quotationTotal vehicle createdAt invoice';

/** The VSRs raised in the period, oldest first, declined additional jobs left out, each with its current invoice. */
const ticketsRaised = (period, extra = {}) =>
  Ticket.find({ createdAt: raisedIn(period), status: NOT_DECLINED, ...extra })
    .select(REPORT_FIELDS)
    .sort({ createdAt: 1, _id: 1 })
    .populate('invoice', 'amount status invoiceNumber');

// Buses are looked up rather than populated, so a VSR whose bus was deleted keeps its bus id.
const busLookup = async () => new Map((await Bus.find().select('fleetNumber make')).map((bus) => [String(bus._id), bus]));

const vendorNames = async (tickets) => {
  const ids = [...new Set(tickets.map((ticket) => String(ticket.vendorId)))];
  const users = await User.find({ _id: mongoose.trusted({ $in: ids }) }).select('name');
  return new Map(users.map((user) => [String(user._id), user.name]));
};

/** The columns every VSR list starts with. */
const identity = (ticket, buses, vendors) => {
  const bus = buses.get(String(ticket.busId));
  return {
    _id: ticket._id,
    vsrNumber: ticket.vsrNumber,
    busId: ticket.busId,
    fleetNumber: bus?.fleetNumber ?? null,
    make: bus?.make ?? null,
    vendorId: ticket.vendorId,
    vendor: vendors.get(String(ticket.vendorId)) ?? null,
    createdAt: ticket.createdAt,
  };
};

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
/** By side number; a bus no longer on file last. */
const byFleetNumber = (a, b) => (a.fleetNumber === null) - (b.fleetNumber === null) || String(a.fleetNumber ?? '').localeCompare(String(b.fleetNumber ?? ''), undefined, { numeric: true });
const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);

// VSRs, money (in fils) and trips, added up for a group of VSRs.
const TALLY_FIELDS = ['vsrs', 'noCharge', 'breakdowns', 'spend', 'committed', 'trips', 'days', 'late'];
const emptyTally = () => Object.fromEntries(TALLY_FIELDS.map((field) => [field, 0]));
const addToTally = (tally, ticket) => {
  tally.vsrs += 1;
  if (ticket.noChargeReason) tally.noCharge += 1;
  if (ticket.isBreakdown) tally.breakdowns += 1;
  tally.spend += spendFils(ticket);
  tally.committed += committedFils(ticket);
  const days = workshopDays(ticket);
  if (days !== null) {
    tally.trips += 1;
    tally.days += days;
    if (isLate(ticket, days)) tally.late += 1;
  }
  return tally;
};
const mergeTallies = (tallies) => Object.fromEntries(TALLY_FIELDS.map((field) => [field, sum(tallies.map((tally) => tally[field]))]));

const vendorFigures = ({ vsrs, noCharge, spend, committed, trips, days, late }) => ({ vsrs, noCharge, spend: toAed(spend), committed: toAed(committed), trips, days, averageDays: averageDays(days, trips), late });
const categoryFigures = ({ vsrs, breakdowns, noCharge, spend, committed, trips, days }) => ({ vsrs, breakdowns, noCharge, spend: toAed(spend), committed: toAed(committed), trips, days, averageDays: averageDays(days, trips) });

const GROUP_KEYS = {
  brand: (ticket) => ticket.busId?.make ?? '',
  month: (ticket) => uaeMonth(ticket.createdAt),
  bus: (ticket) => ticket.busId?.fleetNumber ?? '',
  vendor: (ticket) => ticket.vendorId?.name ?? '',
  type: kindOf,
};

// GET /api/reports/query?brand=&type=&year=&from=&to=&vendorId=&busId=&isBreakdown=&groupBy=
export const runQuery = asyncHandler(async (req, res) => {
  const { brand, type, vendorId, busId, isBreakdown, groupBy = 'brand' } = req.query;
  const period = periodOf(req.query);
  // A declined additional job was never done.
  const filter = { createdAt: raisedIn(period), status: NOT_DECLINED };
  if (vendorId) filter.vendorId = vendorId;
  if (busId) filter.busId = busId;
  if (isBreakdown) filter.isBreakdown = isBreakdown === 'true';

  const tickets = await Ticket.find(filter).select('serviceType repairCategory createdAt busId vendorId invoice status').populate('busId', 'make fleetNumber').populate('vendorId', 'name').populate('invoice', 'amount status');
  const matching = tickets.filter((ticket) => matchesType(ticket, type) && (!brand || sameBrand(ticket.busId?.make, brand)));

  const groups = new Map();
  matching.forEach((ticket) => {
    const key = GROUP_KEYS[groupBy](ticket);
    const row = groups.get(key) ?? { key, count: 0, fils: 0 };
    row.count += 1;
    row.fils += spendFils(ticket);
    groups.set(key, row);
  });
  const rows = [...groups.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));

  const [vendors, buses] = await Promise.all([User.find({ role: 'vendor' }).select('name').sort({ name: 1 }), Bus.find().select('fleetNumber make').sort({ fleetNumber: 1 })]);
  res.json({
    success: true,
    data: {
      rows: rows.map(({ key, count, fils }) => ({ key, count, amount: toAed(fils) })),
      total: { count: matching.length, amount: toAed(sum(rows.map((row) => row.fils))) },
      filters: { brands: brandsFrom(buses), vendors, buses },
      year: period.year,
      from: period.from,
      to: period.to,
    },
  });
});

// Accidents count with repairs in the fleet's figures; maintenance is the oil service.
const FLEET_KINDS = { repair: 'repair', accident: 'repair', tyre: 'tyre', battery: 'battery', oil: 'maintenance' };
const emptyCounts = () => ({ repair: 0, tyre: 0, battery: 0, maintenance: 0 });

// GET /api/reports/fleet?year=&from=&to=&brand=
export const fleetFigures = asyncHandler(async (req, res) => {
  const { brand } = req.query;
  const period = periodOf(req.query);
  const tickets = await Ticket.find({ createdAt: raisedIn(period), status: NOT_DECLINED }).select('serviceType repairCategory createdAt busId').populate('busId', 'make');

  const months = period.months.map((month) => ({ month, ...emptyCounts() }));
  const totals = emptyCounts();
  const byBrand = new Map();
  tickets.forEach((ticket) => {
    const figure = FLEET_KINDS[kindOf(ticket)];
    if (!figure) return;
    const make = ticket.busId?.make ?? '';
    const row = byBrand.get(brandKey(make)) ?? { brand: make, ...emptyCounts() };
    row[figure] += 1;
    byBrand.set(brandKey(make), row);
    if (brand && !sameBrand(make, brand)) return;
    months[monthPosition(period, ticket.createdAt)][figure] += 1;
    totals[figure] += 1;
  });

  res.json({
    success: true,
    data: { year: period.year, from: period.from, to: period.to, months, totals, brands: brandsFrom(await Bus.find().select('make')), byBrand: [...byBrand.values()].sort((a, b) => a.brand.localeCompare(b.brand)) },
  });
});

// GET /api/reports/availability?year=&month=&from=&to=
export const availabilityReport = asyncHandler(async (req, res) => {
  const period = periodOf(req.query);
  const { year, month, from, to, days } = period;
  const today = uaeDay();
  const [fleet, options] = await Promise.all([fleetDays(days, today), filterOptions()]);
  const summary = statusSummary(fleet, days, today);

  const dayFigures = days.map((day, i) => {
    if (summary.ready[i] === null) return { day, counted: null, ready: null, byStatus: null, availability: null };
    const byStatus = Object.fromEntries(BUS_DAY_STATUSES.map((status) => [status, summary[status][i]]));
    const counted = sum(COUNTED.map((status) => byStatus[status]));
    return { day, counted, ready: byStatus.ready, byStatus, availability: ratio(byStatus.ready, counted) };
  });
  // Bus-days added up, so a day with two buses weighs less than a day with ten.
  const months = period.months.map((key) => {
    const inMonth = dayFigures.filter((figures) => figures.counted !== null && figures.day.startsWith(key));
    const byStatus = Object.fromEntries(BUS_DAY_STATUSES.map((status) => [status, sum(inMonth.map((figures) => figures.byStatus[status]))]));
    const counted = sum(inMonth.map((figures) => figures.counted));
    return { month: key, counted, ready: byStatus.ready, availability: ratio(byStatus.ready, counted), byStatus };
  });
  const counted = sum(months.map((m) => m.counted));
  const ready = sum(months.map((m) => m.ready));

  res.json({
    success: true,
    data: { year, month, from, to, today, statuses: BUS_DAY_STATUSES, days: dayFigures, months, total: { counted, ready, availability: ratio(ready, counted) }, filters: { year, month, ...rangeOf(period) }, options },
  });
});

const OFF_ROAD = COUNTED.filter((status) => status !== 'ready');
const downtimeRow = (bus, days, vsrs) => {
  const offRoad = sum(OFF_ROAD.map((status) => days[status]));
  const counted = days.ready + offRoad;
  return { ...bus, counted, ready: days.ready, ...Object.fromEntries(OFF_ROAD.map((status) => [status, days[status]])), offRoad, availability: ratio(days.ready, counted), vsrs };
};

// GET /api/reports/downtime?year=&month=&from=&to=&brand=
export const downtimeReport = asyncHandler(async (req, res) => {
  const period = periodOf(req.query);
  const { year, month, from, to, days } = period;
  const brand = req.query.brand || null;
  const today = uaeDay();
  const [fleet, tickets, options] = await Promise.all([fleetDays(days, today), Ticket.find({ createdAt: raisedIn(period), status: NOT_DECLINED }).select('busId'), filterOptions()]);
  const vsrs = new Map();
  tickets.forEach(({ busId }) => vsrs.set(String(busId), (vsrs.get(String(busId)) ?? 0) + 1));

  const rows = fleet
    .filter(({ bus }) => !brand || sameBrand(bus.make, brand))
    .map(({ bus, cells }) => {
      const daysIn = Object.fromEntries(BUS_DAY_STATUSES.map((status) => [status, 0]));
      cells.forEach((cell) => {
        if (cell) daysIn[cell.status] += 1;
      });
      return downtimeRow({ busId: bus._id, fleetNumber: bus.fleetNumber, make: bus.make }, daysIn, vsrs.get(String(bus._id)) ?? 0);
    })
    // A bus scrapped all period with nothing raised has nothing to show.
    .filter((row) => row.counted > 0 || row.vsrs > 0)
    .sort((a, b) => b.offRoad - a.offRoad || byFleetNumber(a, b));
  const totalDays = Object.fromEntries(['ready', ...OFF_ROAD].map((status) => [status, sum(rows.map((row) => row[status]))]));

  res.json({ success: true, data: { year, month, from, to, today, rows, total: downtimeRow({}, totalDays, sum(rows.map((row) => row.vsrs))), filters: { year, month, ...rangeOf(period), brand }, options } });
});

/**
 * Each bus on the fleet in the year with its km for each month (null with no reading that month,
 * before it joined the fleet and for months still to come) and the year's known km added up.
 */
const kmRows = async (year, today) => {
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  const [buses, inYear, before] = await Promise.all([
    fleetBuses(last, first),
    BusDailyReading.find({ date: mongoose.trusted({ $gte: first, $lte: last }) }).select('bus date km'),
    // A bus's last reading before the year starts its January.
    BusDailyReading.aggregate([{ $match: { date: { $lt: first } } }, { $sort: { date: -1 } }, { $group: { _id: '$bus', date: { $first: '$date' }, km: { $first: '$km' } } }]),
  ]);
  const readings = new Map();
  const add = (bus, { date, km }) => {
    const key = String(bus);
    if (!readings.has(key)) readings.set(key, []);
    readings.get(key).push({ date, km });
  };
  before.forEach((reading) => add(reading._id, reading));
  inYear.forEach((reading) => add(reading.bus, reading));

  return buses.map((bus) => {
    const own = readings.get(String(bus._id)) ?? [];
    const km = monthsOf(year).map((month) => {
      const days = daysInMonth(month);
      if (days[0] > today || days.at(-1) < bus.firstDay) return null;
      return kmInMonth(own, month);
    });
    const known = km.filter((value) => value !== null);
    return { busId: String(bus._id), fleetNumber: bus.fleetNumber, make: bus.make, firstDay: bus.firstDay, km, total: known.length ? sum(known) : null };
  });
};

// GET /api/reports/km?year=
export const kmReport = asyncHandler(async (req, res) => {
  const { year } = periodOf(req.query);
  const today = uaeDay();
  const [rows, options] = await Promise.all([kmRows(year, today), filterOptions()]);
  const summary = monthsOf(year).map((month, i) => {
    const days = daysInMonth(month);
    if (days[0] > today) return { month, fleet: null, bands: null, notOperated: null, noReadings: null, fleetKm: null };
    const onFleet = rows.filter((row) => row.firstDay <= days.at(-1));
    const bands = BANDS.map(() => 0);
    let notOperated = 0;
    let noReadings = 0;
    onFleet.forEach(({ km }) => {
      if (km[i] === null) noReadings += 1;
      else if (bandIndex(km[i]) < 0) notOperated += 1;
      else bands[bandIndex(km[i])] += 1;
    });
    return { month, fleet: onFleet.length, bands, notOperated, noReadings, fleetKm: sum(onFleet.map(({ km }) => km[i])) };
  });

  res.json({ success: true, data: { year, months: monthsOf(year), bands: BANDS, rows, summary, total: { fleetKm: sum(summary.map((m) => m.fleetKm)) }, filters: { year }, options } });
});

/**
 * Km each of these buses ran between two days, by the rule of the daily sheet's km report
 * (kmInRange): null for a bus with no reading in the range. Only the readings the rule needs are
 * loaded: each bus's last one by `from` and those from then to `to`.
 */
const kmBetween = async (busIds, from, to) => {
  const [before, inRange] = await Promise.all([
    BusDailyReading.aggregate([{ $match: { bus: { $in: busIds }, date: { $lte: from } } }, { $sort: { date: -1 } }, { $group: { _id: '$bus', date: { $first: '$date' }, km: { $first: '$km' } } }]),
    BusDailyReading.find({ bus: mongoose.trusted({ $in: busIds }), date: mongoose.trusted({ $gte: from, $lte: to }) }).select('bus date km').lean(),
  ]);
  const readings = new Map(busIds.map((id) => [String(id), []]));
  before.forEach(({ _id, date, km }) => readings.get(String(_id)).push({ date, km }));
  inRange.forEach(({ bus, date, km }) => readings.get(String(bus)).push({ date, km }));
  return new Map([...readings.entries()].map(([id, own]) => [id, kmInRange(own, from, to).km]));
};

// GET /api/reports/costs?year=&from=&to=&brand=&type=&vendorId=
export const costsReport = asyncHandler(async (req, res) => {
  const period = periodOf(req.query);
  const { year, from, to, months } = period;
  const brand = req.query.brand || null;
  const type = req.query.type || null;
  const vendorId = req.query.vendorId || null;
  const [tickets, buses, km, options] = await Promise.all([ticketsRaised(period, vendorId ? { vendorId } : {}), busLookup(), from ? [] : kmRows(year, uaeDay()), filterOptions()]);
  // A year adds up the Km report's months; custom dates take the km run between the two days.
  const kmByBus = from ? await kmBetween([...new Map(tickets.map((ticket) => [String(ticket.busId), ticket.busId])).values()], from, to) : new Map(km.map((row) => [row.busId, row.total]));

  const byBus = new Map();
  tickets
    .filter((ticket) => matchesType(ticket, type) && (!brand || sameBrand(buses.get(String(ticket.busId))?.make, brand)))
    .forEach((ticket) => {
      const key = String(ticket.busId);
      const row = byBus.get(key) ?? { key, spend: months.map(() => 0), committed: 0, vsrs: 0 };
      row.spend[monthPosition(period, ticket.createdAt)] += spendFils(ticket);
      row.committed += committedFils(ticket);
      row.vsrs += 1;
      byBus.set(key, row);
    });
  const groups = [...byBus.values()];
  const rows = groups
    .map(({ key, spend, committed, vsrs }) => {
      const bus = buses.get(key);
      const busKm = kmByBus.get(key) ?? null;
      return { busId: key, fleetNumber: bus?.fleetNumber ?? null, make: bus?.make ?? null, spend: spend.map(toAed), totalSpend: toAed(sum(spend)), committed: toAed(committed), vsrs, km: busKm, spendPerKm: spendPerKm(sum(spend), busKm) };
    })
    .sort(byFleetNumber);
  const monthFils = months.map((_, i) => sum(groups.map((group) => group.spend[i])));
  const totals = { spend: monthFils.map(toAed), totalSpend: toAed(sum(monthFils)), committed: toAed(sum(groups.map((group) => group.committed))), vsrs: sum(groups.map((group) => group.vsrs)), km: sum(rows.map((row) => row.km)) };

  res.json({ success: true, data: { year, from, to, months, rows, totals, filters: { year, ...rangeOf(period), brand, type, vendorId }, options } });
});

const kindOrder = (kind) => (WORK_KINDS.includes(kind) ? WORK_KINDS.indexOf(kind) : WORK_KINDS.length);

// GET /api/reports/vendors?year=&month=&from=&to=
export const vendorsReport = asyncHandler(async (req, res) => {
  const period = periodOf(req.query);
  const { year, month, from, to } = period;
  const [tickets, options] = await Promise.all([ticketsRaised(period), filterOptions()]);
  const names = await vendorNames(tickets);
  const byVendor = new Map();
  tickets.forEach((ticket) => {
    const key = String(ticket.vendorId);
    const kinds = byVendor.get(key) ?? new Map();
    kinds.set(kindOf(ticket), addToTally(kinds.get(kindOf(ticket)) ?? emptyTally(), ticket));
    byVendor.set(key, kinds);
  });
  const tallies = [];
  const vendors = [...byVendor.entries()]
    .map(([vendorId, kinds]) => {
      const ordered = [...kinds.entries()].sort((a, b) => kindOrder(a[0]) - kindOrder(b[0]));
      const subtotal = mergeTallies(ordered.map(([, tally]) => tally));
      tallies.push(subtotal);
      return { vendorId, name: names.get(vendorId) ?? null, rows: ordered.map(([kind, tally]) => ({ kind, ...vendorFigures(tally) })), subtotal: vendorFigures(subtotal) };
    })
    .sort(byName);

  res.json({ success: true, data: { year, month, from, to, kinds: WORK_KINDS, vendors, total: vendorFigures(mergeTallies(tallies)), filters: { year, month, ...rangeOf(period) }, options } });
});

// GET /api/reports/categories?year=&from=&to=&brand=  (repairs only; an accident is a service type of its own since 2026-11-11)
export const categoriesReport = asyncHandler(async (req, res) => {
  const period = periodOf(req.query);
  const { year, from, to } = period;
  const brand = req.query.brand || null;
  const [tickets, buses, options] = await Promise.all([ticketsRaised(period, { serviceType: 'repair' }), busLookup(), filterOptions()]);
  const tallies = new Map(REPAIR_CATEGORIES.map((category) => [category, emptyTally()]));
  tickets
    .filter((ticket) => !brand || sameBrand(buses.get(String(ticket.busId))?.make, brand))
    .forEach((ticket) => {
      // A repair from before categories were required still counts, under no category.
      const category = ticket.repairCategory ?? null;
      tallies.set(category, addToTally(tallies.get(category) ?? emptyTally(), ticket));
    });
  const rows = [...tallies.entries()].map(([category, tally]) => ({ category, ...categoryFigures(tally) }));

  res.json({ success: true, data: { year, from, to, rows, total: categoryFigures(mergeTallies([...tallies.values()])), filters: { year, ...rangeOf(period), brand }, options } });
});

// GET /api/reports/accidents?year=&from=&to=
export const accidentsReport = asyncHandler(async (req, res) => {
  const period = periodOf(req.query);
  const { year, from, to } = period;
  const [tickets, buses, options] = await Promise.all([ticketsRaised(period, { serviceType: 'accident' }), busLookup(), filterOptions()]);
  const names = await vendorNames(tickets);
  const severities = [...ACCIDENT_SEVERITIES, 'notRecorded'];
  const faults = [...ACCIDENT_FAULTS, 'notRecorded'];
  const matrix = Object.fromEntries(severities.map((severity) => [severity, Object.fromEntries(faults.map((fault) => [fault, 0]))]));
  let spend = 0;
  let committed = 0;
  const rows = tickets.map((ticket) => {
    const severity = ticket.accident?.severity ?? null;
    const fault = ticket.accident?.fault ?? null;
    matrix[severity ?? 'notRecorded'][fault ?? 'notRecorded'] += 1;
    spend += spendFils(ticket);
    committed += committedFils(ticket);
    return { ...identity(ticket, buses, names), severity, fault, status: ticket.status, spend: toAed(spendFils(ticket)), committed: toAed(committedFils(ticket)), noChargeReason: ticket.noChargeReason ?? null };
  });
  const bySeverity = Object.fromEntries(severities.map((severity) => [severity, sum(Object.values(matrix[severity]))]));
  const byFault = Object.fromEntries(faults.map((fault) => [fault, sum(severities.map((severity) => matrix[severity][fault]))]));

  res.json({
    success: true,
    data: { year, from, to, severities, faults, matrix, bySeverity, byFault, rows, totals: { count: rows.length, spend: toAed(spend), committed: toAed(committed) }, filters: { year, ...rangeOf(period) }, options },
  });
});

// GET /api/reports/free-work?year=&from=&to=
export const freeWorkReport = asyncHandler(async (req, res) => {
  const period = periodOf(req.query);
  const { year, from, to } = period;
  const [tickets, buses, options] = await Promise.all([ticketsRaised(period, { noChargeReason: mongoose.trusted({ $in: NO_CHARGE_REASONS }) }), busLookup(), filterOptions()]);
  const names = await vendorNames(tickets);
  const emptyReasons = () => Object.fromEntries(NO_CHARGE_REASONS.map((reason) => [reason, 0]));
  const byVendor = new Map();
  let recorded = 0;
  const rows = tickets.map((ticket) => {
    const vendorId = String(ticket.vendorId);
    const counts = byVendor.get(vendorId) ?? emptyReasons();
    counts[ticket.noChargeReason] += 1;
    byVendor.set(vendorId, counts);
    // What the parts and labour came to on the quotation, when the creator entered them.
    const recordedValue = ticket.breakdown?.quotationTotal ?? null;
    recorded += toFils(recordedValue);
    return { ...identity(ticket, buses, names), kind: kindOf(ticket), reason: ticket.noChargeReason, recordedValue };
  });
  const vendors = [...byVendor.entries()].map(([vendorId, counts]) => ({ vendorId, name: names.get(vendorId) ?? null, counts, total: sum(Object.values(counts)) })).sort(byName);
  const counts = Object.fromEntries(NO_CHARGE_REASONS.map((reason) => [reason, sum(vendors.map((vendor) => vendor.counts[reason]))]));

  res.json({ success: true, data: { year, from, to, reasons: NO_CHARGE_REASONS, vendors, rows, totals: { counts, total: rows.length, recordedValue: toAed(recorded) }, filters: { year, ...rangeOf(period) }, options } });
});

// GET /api/reports/invoice-check?year=&from=&to=&all=
export const invoiceCheckReport = asyncHandler(async (req, res) => {
  const period = periodOf(req.query);
  const { year, from, to } = period;
  const all = req.query.all === 'true';
  const [tickets, buses, options] = await Promise.all([ticketsRaised(period), busLookup(), filterOptions()]);
  const names = await vendorNames(tickets);
  const checked = tickets
    .filter((ticket) => ticket.invoice?.status === 'approved')
    .map((ticket) => ({ ticket, approved: toFils(ticket.approvedEstimate), invoiced: spendFils(ticket) }))
    .filter(({ approved, invoiced }) => all || invoiced !== approved);
  const rows = checked.map(({ ticket, approved, invoiced }) => ({
    ...identity(ticket, buses, names),
    kind: kindOf(ticket),
    invoiceNumber: ticket.invoice.invoiceNumber ?? null,
    approved: toAed(approved),
    invoiced: toAed(invoiced),
    difference: toAed(invoiced - approved),
  }));
  const approved = sum(checked.map((row) => row.approved));
  const invoiced = sum(checked.map((row) => row.invoiced));

  res.json({ success: true, data: { year, from, to, rows, totals: { count: rows.length, approved: toAed(approved), invoiced: toAed(invoiced), difference: toAed(invoiced - approved) }, filters: { year, ...rangeOf(period), all }, options } });
});

// The bus's intervals. Brake pads are a repair category since 2026-11-11 but keep their interval.
const REPORTED_SERVICES = ['tyre', 'battery', 'oil', 'brakePads'];
const REPORT_DAYS = 7;

/** Services that are due soon or overdue, for the weekly report and the alerts. */
export const dueServices = async () => {
  const [buses, latest, offFleet] = await Promise.all([Bus.find().select('fleetNumber make registrationNumber intervals').sort({ fleetNumber: 1 }), latestKmByBus(), offFleetBusIds()]);
  const due = Object.fromEntries(REPORTED_SERVICES.map((service) => [service, []]));
  buses.forEach((bus) => {
    // A scrapped or removed bus is not serviced any more.
    if (offFleet.has(String(bus._id))) return;
    const status = intervalStatus(bus, latest.get(String(bus._id)));
    REPORTED_SERVICES.forEach((service) => {
      // A bus added before brake pads had an interval has none, so nothing can be due.
      if (!status[service]) return;
      const { state, left, delayed, unit, interval } = status[service];
      if (!state || state === 'ok') return; // only oil and tyres are ever due (2026-11-16)
      const lastService = service === 'battery' ? uaeDay(bus.intervals.battery.lastDate) : bus.intervals[service].lastKm;
      due[service].push({ busId: bus._id, fleetNumber: bus.fleetNumber, make: bus.make, registrationNumber: bus.registrationNumber, currentKm: status.currentKm, state, left, delayed, unit, interval, lastService });
    });
  });
  return due;
};

// GET /api/reports/weekly  (the last seven days, and what is due now)
export const weeklyReport = asyncHandler(async (req, res) => {
  const to = new Date();
  // Seven whole UAE days, today being the last of them.
  const from = startOfUaeDay(uaeDay(new Date(to.getTime() - (REPORT_DAYS - 1) * 24 * 60 * 60 * 1000)));
  const measured = [{ serviceType: mongoose.trusted({ $in: ['tyre', 'battery', 'oil'] }) }, { serviceType: 'repair', repairCategory: 'BRAKE PADS' }];
  const tickets = await Ticket.find({ createdAt: mongoose.trusted({ $gte: from, $lte: to }), $or: measured, status: NOT_DECLINED })
    .select('vsrNumber serviceType repairCategory status createdAt busId vendorId intervalUsage')
    .sort({ createdAt: -1 })
    .populate('busId', 'fleetNumber make')
    .populate('vendorId', USER_FIELDS);
  const raised = Object.fromEntries(REPORTED_SERVICES.map((service) => [service, []]));
  tickets.forEach((ticket) => {
    raised[intervalServiceOf(ticket)].push({
      _id: ticket._id,
      vsrNumber: ticket.vsrNumber,
      fleetNumber: ticket.busId?.fleetNumber,
      make: ticket.busId?.make,
      vendor: ticket.vendorId?.name,
      status: ticket.status,
      createdAt: ticket.createdAt,
      intervalUsage: ticket.intervalUsage,
    });
  });
  res.json({ success: true, data: { from, to, raised, due: await dueServices() } });
});

/**
 * GET /api/reports/lpo-balances?vendorId=&kind=&inDate=  (depot)
 * The client's LPO sheet (2026-11-10): for each LPO line its value, booked by open VSRs not yet on
 * a GRN, GRN, limit available for the next VSR (value - booked - GRN), remaining after GRN
 * (value - GRN) and VSRs issued, with amount subtotals per LPO and for the whole report. inDate
 * true or false keeps LPOs valid today or not; left out, every LPO.
 */
export const lpoBalancesReport = asyncHandler(async (req, res) => {
  const { vendorId, kind } = req.query;
  const inDate = req.query.inDate ? req.query.inDate === 'true' : null;
  const lpos = await Lpo.find().populate('vendor', 'name');
  const today = uaeDay();
  const vendorOf = (lpo) => ({ _id: lpo.vendor?._id ?? lpo.vendor, name: lpo.vendor?.name ?? null });
  const dateOf = (lpo) => lpo.date ?? lpo.validFrom;
  const shown = lpos
    .filter((lpo) => (!vendorId || String(lpo.vendor?._id ?? lpo.vendor) === vendorId) && (inDate === null || isInDate(lpo, today) === inDate))
    .sort((a, b) => dateOf(a) - dateOf(b) || a.number.localeCompare(b.number, undefined, { numeric: true }));
  const balances = await balancesFor(shown);

  const rows = shown.flatMap((lpo) =>
    lpo.items
      .filter((item) => !kind || item.kind === kind)
      .map((item) => ({
        lpoId: lpo._id,
        lpoNumber: lpo.number,
        date: dateOf(lpo),
        validFrom: lpo.validFrom,
        validTo: lpo.validTo,
        inDate: isInDate(lpo, today),
        vendor: vendorOf(lpo),
        itemId: item._id,
        item: item.name,
        kind: item.kind,
        unitPrice: item.unitPrice,
        lifeKm: item.lifeKm ?? null,
        ...balances.get(String(item._id)),
      }))
  );
  const subtotals = shown
    .map((lpo) => ({ lpo, lines: rows.filter((row) => String(row.lpoId) === String(lpo._id)) }))
    .filter(({ lines }) => lines.length)
    .map(({ lpo, lines }) => ({ lpoId: lpo._id, lpoNumber: lpo.number, vendor: vendorOf(lpo), ...amountTotals(lines) }));

  // What the filters choose from: every vendor with an LPO and every kind of line there is.
  const vendors = [...new Map(lpos.map((lpo) => [String(lpo.vendor?._id ?? lpo.vendor), vendorOf(lpo)])).values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const kinds = LPO_KINDS.filter((line) => lpos.some((lpo) => lpo.items.some((item) => item.kind === line)));
  res.json({ success: true, data: { today, rows, lpos: subtotals, total: amountTotals(rows), filters: { vendors, kinds } } });
});
