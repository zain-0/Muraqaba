import { extname } from 'node:path';
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket, { CLOSED_STATUSES } from '../models/Ticket.js';
import { BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { fleetBuses, fleetDays, statusSummary } from '../utils/fleetDays.js';
import { kmInRange } from '../utils/reportMaths.js';
import { USER_FIELDS } from '../utils/query.js';
import { planReadingImport } from '../utils/readingImport.js';
import { READING_MESSAGES, readingProblem } from '../utils/readingRules.js';
import { daysInMonth, endOfUaeDay, startOfUaeDay, uaeDay, uaeMonth } from '../utils/uaeTime.js';

// scrappedOn tells the sheet which days are locked: from it on, only the scrap request and the sale change a bus's status.
const busSummary = ({ _id, fleetNumber, registrationNumber, make, model, scrappedOn, sale }) => ({ _id, fleetNumber, registrationNumber, make, model, scrappedOn: scrappedOn ?? sale?.date });

const assertDayCanChange = async (busId, date) => {
  if (date > uaeDay()) throw new AppError('A day in the future cannot be changed', 400, 'VALIDATION_ERROR', [{ field: 'date', message: 'A day in the future cannot be changed' }]);
  if (!(await Bus.exists({ _id: busId }))) throw new AppError('Bus not found', 404, 'NOT_FOUND');
};

const readingError = (message) => new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'km', message }]);

/** An odometer only goes up, and only as far as a bus can drive between two readings. */
const assertReadingFits = async (busId, date, km) => {
  const [earlier, later] = await Promise.all([
    BusDailyReading.findOne({ bus: busId, date: mongoose.trusted({ $lt: date }) }).sort({ date: -1 }),
    BusDailyReading.findOne({ bus: busId, date: mongoose.trusted({ $gt: date }) }).sort({ date: 1 }),
  ]);
  const problem = readingProblem(date, km, earlier, later);
  if (problem) throw readingError(READING_MESSAGES[problem]);
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

// GET /api/sheets/readings/report?from=&to=&busIds=  (owner's testing notes, 2026-11-11)
export const getKmReport = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (to < from) throw new AppError('The end date is before the start date', 400, 'VALIDATION_ERROR', [{ field: 'to', message: 'The end date is before the start date' }]);
  const chosen = req.query.busIds ? new Set(req.query.busIds.split(',')) : null;
  const fleet = await fleetBuses(to, from);
  const buses = chosen ? fleet.filter((bus) => chosen.has(String(bus._id))) : fleet;
  const readings = await BusDailyReading.find({ bus: mongoose.trusted({ $in: buses.map((bus) => bus._id) }), date: mongoose.trusted({ $lte: to }) })
    .select('bus date km')
    .lean();
  const byBus = new Map();
  readings.forEach((reading) => {
    const key = String(reading.bus);
    if (!byBus.has(key)) byBus.set(key, []);
    byBus.get(key).push(reading);
  });
  const rows = buses.map((bus) => ({
    busId: String(bus._id),
    fleetNumber: bus.fleetNumber,
    make: bus.make,
    model: bus.model,
    ...kmInRange(byBus.get(String(bus._id)) ?? [], from, to),
  }));
  const counted = rows.filter((row) => row.km !== null);
  res.json({
    success: true,
    data: {
      from,
      to,
      today: uaeDay(),
      rows,
      total: { km: counted.reduce((sum, row) => sum + row.km, 0), buses: rows.length, withReadings: counted.length },
      buses: fleet.map(({ _id, fleetNumber, registrationNumber, make, model }) => ({ _id, fleetNumber, registrationNumber, make, model })),
    },
  });
});

/** The one .xlsx a creator chose, read into what importing it would do. */
const planFromUpload = async (req) => {
  const files = req.files ?? [];
  const fileError = (message) => new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'attachments', message }]);
  if (!files.length) throw fileError('Choose an Excel file (.xlsx) to import');
  if (files.length > 1) throw fileError('Choose one Excel file at a time');
  if (extname(files[0].originalname).toLowerCase() !== '.xlsx') throw fileError('Choose an Excel file (.xlsx). Save an older .xls file as .xlsx first.');
  return planReadingImport(files[0].buffer, { month: req.body.month || undefined, today: uaeDay() });
};

// POST /api/sheets/readings/import/preview  (multipart: one .xlsx, optional month YYYY-MM) - writes nothing
export const previewReadingImport = asyncHandler(async (req, res) => {
  const { toSave, ...preview } = await planFromUpload(req);
  res.json({ success: true, data: preview });
});

// POST /api/sheets/readings/import  (the same form) - saves the new and changed readings
export const importReadings = asyncHandler(async (req, res) => {
  const { toSave, ...result } = await planFromUpload(req);
  if (toSave.length) {
    await BusDailyReading.bulkWrite(toSave.map(({ bus, date, km }) => ({ updateOne: { filter: { bus, date }, update: { $set: { km, by: req.user._id } }, upsert: true } })), { ordered: false });
  }
  res.json({ success: true, message: 'Readings imported', data: { ...result, saved: toSave.length } });
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
  res.json({ success: true, message: 'Status saved. VSRs still change it when the bus goes out or comes back.' });
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
  // Oil services use an agreed price, so they never enter this process.
  const tickets = await Ticket.find({
    serviceType: mongoose.trusted({ $in: ['repair', 'accident', 'tyre', 'battery', 'other'] }),
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
