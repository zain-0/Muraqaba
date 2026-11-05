/**
 * Purchasing's queries, the fleet's month figures and the supervisor's weekly report. Fleets
 * are small, so these load the VSRs of the period and count them here rather than in Mongo.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket from '../models/Ticket.js';
import User from '../models/User.js';
import { asyncHandler } from '../middleware/errorMiddleware.js';
import { intervalStatus, latestKmByBus } from '../utils/intervals.js';
import { USER_FIELDS } from '../utils/query.js';
import { endOfUaeDay, startOfUaeDay, uaeDay, uaeMonth } from '../utils/uaeTime.js';

const MAINTENANCE = ['oil', 'transmission'];
const NOT_DECLINED = mongoose.trusted({ $ne: 'declined' });

/** The figure a VSR counts under: accidents apart from other repairs. */
const kindOf = ({ serviceType, repairCategory }) => (serviceType === 'repair' && repairCategory === 'ACCIDENT' ? 'accident' : serviceType);

const matchesType = (ticket, type) => {
  if (!type) return true;
  const kind = kindOf(ticket);
  return type === 'maintenance' ? MAINTENANCE.includes(kind) : kind === type;
};

const yearRange = (year) => mongoose.trusted({ $gte: startOfUaeDay(`${year}-01-01`), $lte: endOfUaeDay(`${year}-12-31`) });

/** A brand typed as "hino" on one bus and "Hino" on another is one brand. */
const brandKey = (make) => String(make ?? '').trim().toLowerCase();
const sameBrand = (make, brand) => brandKey(make) === brandKey(brand);

// Each brand once, spelt the way most buses spell it.
const brandsOf = async () => {
  const spellings = new Map();
  (await Bus.find().select('make')).forEach(({ make }) => {
    const counts = spellings.get(brandKey(make)) ?? new Map();
    counts.set(make, (counts.get(make) ?? 0) + 1);
    spellings.set(brandKey(make), counts);
  });
  return [...spellings.values()].map((counts) => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]).sort((a, b) => a.localeCompare(b));
};

const money = (value) => Math.round(value * 100) / 100;

const acceptedAmount = (ticket) => (ticket.invoice?.status === 'approved' ? ticket.invoice.amount : 0);

const GROUP_KEYS = {
  brand: (ticket) => ticket.busId?.make ?? '',
  month: (ticket) => uaeMonth(ticket.createdAt),
  bus: (ticket) => ticket.busId?.fleetNumber ?? '',
  vendor: (ticket) => ticket.vendorId?.name ?? '',
  type: kindOf,
};

// GET /api/reports/query?brand=&type=&year=&vendorId=&busId=&isBreakdown=&groupBy=
export const runQuery = asyncHandler(async (req, res) => {
  const { brand, type, year = uaeDay().slice(0, 4), vendorId, busId, isBreakdown, groupBy = 'brand' } = req.query;
  // A declined additional job was never done.
  const filter = { createdAt: yearRange(year), status: NOT_DECLINED };
  if (vendorId) filter.vendorId = vendorId;
  if (busId) filter.busId = busId;
  if (isBreakdown) filter.isBreakdown = isBreakdown === 'true';

  const tickets = await Ticket.find(filter).select('serviceType repairCategory createdAt busId vendorId invoice').populate('busId', 'make fleetNumber').populate('vendorId', 'name').populate('invoice', 'amount status');
  const matching = tickets.filter((ticket) => matchesType(ticket, type) && (!brand || sameBrand(ticket.busId?.make, brand)));

  const groups = new Map();
  matching.forEach((ticket) => {
    const key = GROUP_KEYS[groupBy](ticket);
    const row = groups.get(key) ?? { key, count: 0, amount: 0 };
    row.count += 1;
    row.amount = money(row.amount + acceptedAmount(ticket));
    groups.set(key, row);
  });
  const rows = [...groups.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));

  const [brands, vendors, buses] = await Promise.all([
    brandsOf(),
    User.find({ role: 'vendor' }).select('name').sort({ name: 1 }),
    Bus.find().select('fleetNumber make').sort({ fleetNumber: 1 }),
  ]);
  res.json({
    success: true,
    data: {
      rows,
      total: { count: matching.length, amount: money(rows.reduce((sum, row) => sum + row.amount, 0)) },
      filters: { brands, vendors, buses },
    },
  });
});

const FLEET_KINDS = { repair: 'repair', accident: 'repair', tyre: 'tyre', battery: 'battery', oil: 'maintenance', transmission: 'maintenance' };
const emptyCounts = () => ({ repair: 0, tyre: 0, battery: 0, maintenance: 0 });

// GET /api/reports/fleet?year=&brand=
export const fleetFigures = asyncHandler(async (req, res) => {
  const { year = uaeDay().slice(0, 4), brand } = req.query;
  const tickets = await Ticket.find({ createdAt: yearRange(year), status: NOT_DECLINED }).select('serviceType repairCategory createdAt busId').populate('busId', 'make');

  const months = Array.from({ length: 12 }, (_, i) => ({ month: `${year}-${String(i + 1).padStart(2, '0')}`, ...emptyCounts() }));
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
    months[Number(uaeMonth(ticket.createdAt).slice(5)) - 1][figure] += 1;
    totals[figure] += 1;
  });

  res.json({
    success: true,
    data: { year: Number(year), months, totals, brands: await brandsOf(), byBrand: [...byBrand.values()].sort((a, b) => a.brand.localeCompare(b.brand)) },
  });
});

const REPORTED_SERVICES = ['tyre', 'battery', 'oil', 'transmission'];
const REPORT_DAYS = 7;

/** Tyres, batteries, oil and transmission services that are due soon or overdue, for the report and the alerts. */
export const dueServices = async () => {
  const [buses, latest] = await Promise.all([Bus.find().select('fleetNumber make registrationNumber intervals').sort({ fleetNumber: 1 }), latestKmByBus()]);
  const due = Object.fromEntries(REPORTED_SERVICES.map((service) => [service, []]));
  buses.forEach((bus) => {
    const status = intervalStatus(bus, latest.get(String(bus._id)));
    REPORTED_SERVICES.forEach((service) => {
      const { state, left, delayed, unit, interval } = status[service];
      if (state === 'ok') return;
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
  const tickets = await Ticket.find({ createdAt: mongoose.trusted({ $gte: from, $lte: to }), serviceType: mongoose.trusted({ $in: REPORTED_SERVICES }), status: NOT_DECLINED })
    .select('vsrNumber serviceType status createdAt busId vendorId intervalUsage')
    .sort({ createdAt: -1 })
    .populate('busId', 'fleetNumber make')
    .populate('vendorId', USER_FIELDS);
  const raised = Object.fromEntries(REPORTED_SERVICES.map((service) => [service, []]));
  tickets.forEach((ticket) => {
    raised[ticket.serviceType].push({
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
