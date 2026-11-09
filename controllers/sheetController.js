import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket, { CLOSED_STATUSES } from '../models/Ticket.js';
import { BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { fleetBuses, fleetDays, statusSummary } from '../utils/fleetDays.js';
import { USER_FIELDS } from '../utils/query.js';
import { daysInMonth, endOfUaeDay, startOfUaeDay, uaeDay, uaeMonth } from '../utils/uaeTime.js';

// scrappedOn tells the sheet which days are locked: from it on, only the scrap request and the sale change a bus's status.
const busSummary = ({ _id, fleetNumber, registrationNumber, make, model, scrappedOn, sale }) => ({ _id, fleetNumber, registrationNumber, make, model, scrappedOn: scrappedOn ?? sale?.date });

const assertDayCanChange = async (busId, date) => {
  if (date > uaeDay()) throw new AppError('A day in the future cannot be changed', 400, 'VALIDATION_ERROR', [{ field: 'date', message: 'A day in the future cannot be changed' }]);
  if (!(await Bus.exists({ _id: busId }))) throw new AppError('Bus not found', 404, 'NOT_FOUND');
};

// A bus covers far less than this in a day; more than it between two readings is a typing slip.
const MOST_KM_A_DAY = 2000;
const READING_MARGIN_KM = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;

const readingError = (message) => new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'km', message }]);

/** An odometer only goes up, and only as far as a bus can drive between two readings. */
const assertReadingFits = async (busId, date, km) => {
  const [earlier, later] = await Promise.all([
    BusDailyReading.findOne({ bus: busId, date: mongoose.trusted({ $lt: date }) }).sort({ date: -1 }),
    BusDailyReading.findOne({ bus: busId, date: mongoose.trusted({ $gt: date }) }).sort({ date: 1 }),
  ]);
  if (earlier && km < earlier.km) throw readingError('This is lower than the reading on an earlier day');
  if (later && km > later.km) throw readingError('This is higher than the reading on a later day');
  if (earlier) {
    const days = (Date.parse(date) - Date.parse(earlier.date)) / DAY_MS;
    if (km - earlier.km > Math.max(READING_MARGIN_KM, days * MOST_KM_A_DAY)) throw readingError('This is far above the earlier reading. Check it.');
  }
};

// GET /api/sheets/readings?month=YYYY-MM
export const getReadingSheet = asyncHandler(async (req, res) => {
  const month = req.query.month || uaeMonth();
  const days = daysInMonth(month);
  const [buses, readings] = await Promise.all([
    fleetBuses(days.at(-1), days[0]),
    BusDailyReading.find({ date: mongoose.trusted({ $gte: days[0], $lte: days.at(-1) }) }),
  ]);
  const byBus = new Map();
  readings.forEach((r) => {
    const key = String(r.bus);
    if (!byBus.has(key)) byBus.set(key, {});
    byBus.get(key)[r.date] = r.km;
  });
  res.json({
    success: true,
    data: { month, today: uaeDay(), days, buses: buses.map((b) => ({ ...busSummary(b), readings: byBus.get(String(b._id)) || {} })) },
  });
});

// PUT /api/sheets/readings  (km: null clears the day)
export const setReading = asyncHandler(async (req, res) => {
  const { busId, date, km } = req.body;
  await assertDayCanChange(busId, date);
  if (km === null || km === undefined) {
    await BusDailyReading.deleteOne({ bus: busId, date });
    return res.json({ success: true, message: 'Reading removed' });
  }
  await assertReadingFits(busId, date, km);
  await BusDailyReading.updateOne({ bus: busId, date }, { $set: { km, by: req.user._id } }, { upsert: true, runValidators: true });
  return res.json({ success: true, message: 'Reading saved' });
});

// GET /api/sheets/status?month=YYYY-MM
export const getStatusSheet = asyncHandler(async (req, res) => {
  const month = req.query.month || uaeMonth();
  const days = daysInMonth(month);
  const today = uaeDay();
  const rows = await fleetDays(days, today);
  res.json({
    success: true,
    data: { month, today, days, buses: rows.map(({ bus, cells }) => ({ ...busSummary(bus), cells })), summary: statusSummary(rows, days, today) },
  });
});

/** From the day a bus is scrapped its days belong to the scrap request and the sale. Days before can still be corrected. */
const assertNotScrapped = async (busId, date) => {
  const bus = await Bus.findById(busId).select('lifecycle scrappedOn sale.date');
  if (!['scrapped', 'sold'].includes(bus?.lifecycle)) return;
  const from = bus.scrappedOn ?? bus.sale?.date;
  if (from && date >= from) throw new AppError(`This bus is scrapped from ${from}.`, 409, 'INVALID_STATE');
};

// PUT /api/sheets/status
export const setBusStatus = asyncHandler(async (req, res) => {
  const { busId, date, status } = req.body;
  await assertDayCanChange(busId, date);
  await assertNotScrapped(busId, date);
  await BusStatusChange.updateOne(
    { bus: busId, date },
    { $set: { status, source: 'manual', by: req.user._id }, $unset: { ticket: 1 } },
    { upsert: true, runValidators: true }
  );
  res.json({ success: true, message: 'Status saved. It stays until someone changes it.' });
});

export const REPAIR_STAGES = ['waitingEstimate', 'negotiation', 'waitingApproval', 'estimateApproved', 'goneForRepair', 'received', 'invoicing', 'closed'];

const STAGE_OF_STATUS = {
  sentToVendor: 'waitingEstimate',
  estimateSubmitted: 'negotiation',
  estimateCountered: 'negotiation',
  returned: 'negotiation',
  pending: 'waitingApproval',
  approved: 'estimateApproved',
  acknowledged: 'estimateApproved',
  vehicleSent: 'goneForRepair',
  vehicleReceived: 'goneForRepair',
  workInProgress: 'goneForRepair',
  readyForDelivery: 'goneForRepair',
  vehicleReleased: 'goneForRepair',
  vehicleReturned: 'received',
  invoiceSubmitted: 'invoicing',
  invoiceRejected: 'invoicing',
  invoiceAccepted: 'invoicing',
  invoiceReceived: 'invoicing',
  forwardedToPurchase: 'invoicing',
  grnCreated: 'invoicing',
  completed: 'closed',
  declined: 'closed',
};

/** The ticket's stage at a moment, read back from its history; null if it did not exist yet. */
const stageAt = (ticket, moment) => {
  if (ticket.createdAt > moment) return null;
  let status = null;
  ticket.history.forEach((entry) => {
    if (entry.at <= moment) status = entry.status;
  });
  return STAGE_OF_STATUS[status ?? ticket.history[0]?.status ?? ticket.status];
};

// GET /api/sheets/repairs?month=YYYY-MM
export const getRepairSheet = asyncHandler(async (req, res) => {
  const month = req.query.month || uaeMonth();
  const days = daysInMonth(month);
  const today = uaeDay();
  // Oil and transmission services use an agreed price, so they never enter this process.
  const tickets = await Ticket.find({
    serviceType: mongoose.trusted({ $in: ['repair', 'tyre', 'battery', 'brakePads', 'other'] }),
    createdAt: mongoose.trusted({ $lte: endOfUaeDay(days.at(-1)) }),
  })
    .sort({ createdAt: -1 })
    .populate('busId', 'fleetNumber make model')
    .populate('vendorId', USER_FIELDS);

  const completedOn = (ticket) => {
    const entry = ticket.history.find((h) => CLOSED_STATUSES.includes(h.status));
    return entry ? uaeDay(entry.at) : null;
  };
  const monthStart = startOfUaeDay(days[0]);
  const inMonth = tickets.filter((t) => !t.completedAt || t.completedAt >= monthStart);
  const asOf = endOfUaeDay(today < days.at(-1) ? today : days.at(-1));

  const rows = inMonth
    .map((t) => {
      const stage = stageAt(t, asOf);
      if (!stage) return null;
      const since = [...t.history].reverse().find((h) => h.at <= asOf && STAGE_OF_STATUS[h.status] !== stage);
      const entered = since ? t.history.find((h) => h.at >= since.at && STAGE_OF_STATUS[h.status] === stage) : t.history[0];
      return {
        _id: t._id,
        vsrNumber: t.vsrNumber,
        fleetNumber: t.busId?.fleetNumber,
        make: t.busId?.make,
        model: t.busId?.model,
        vendor: t.vendorId?.name,
        serviceType: t.serviceType,
        repairCategory: t.repairCategory,
        stage,
        estimate: t.approvedEstimate ?? t.latestEstimate()?.amount,
        createdAt: t.createdAt,
        stageSince: entered?.at ?? t.createdAt,
      };
    })
    .filter(Boolean);

  // How many buses sat in each stage on each day. "Closed" counts the day it happened, not every day after.
  const summary = Object.fromEntries(REPAIR_STAGES.map((s) => [s, days.map(() => null)]));
  days.forEach((day, index) => {
    if (day > today) return;
    const buses = Object.fromEntries(REPAIR_STAGES.map((s) => [s, new Set()]));
    const moment = endOfUaeDay(day);
    tickets.forEach((t) => {
      const stage = stageAt(t, moment);
      if (!stage || (stage === 'closed' && completedOn(t) !== day)) return;
      buses[stage].add(String(t.busId?._id ?? t.busId));
    });
    REPAIR_STAGES.forEach((s) => {
      summary[s][index] = buses[s].size;
    });
  });

  res.json({ success: true, data: { month, today, days, rows, summary } });
});
