import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket from '../models/Ticket.js';
import { BUS_DAY_STATUSES, BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { USER_FIELDS } from '../utils/query.js';
import { daysInMonth, endOfUaeDay, startOfUaeDay, uaeDay, uaeMonth } from '../utils/uaeTime.js';

const sheetBuses = () => Bus.find().sort({ fleetNumber: 1 }).select('fleetNumber registrationNumber make model');

const busSummary = ({ _id, fleetNumber, registrationNumber, make, model }) => ({ _id, fleetNumber, registrationNumber, make, model });

const assertDayCanChange = async (busId, date) => {
  if (date > uaeDay()) throw new AppError('A day in the future cannot be changed', 400, 'VALIDATION_ERROR', [{ field: 'date', message: 'A day in the future cannot be changed' }]);
  if (!(await Bus.exists({ _id: busId }))) throw new AppError('Bus not found', 404, 'NOT_FOUND');
};

// GET /api/sheets/readings?month=YYYY-MM
export const getReadingSheet = asyncHandler(async (req, res) => {
  const month = req.query.month || uaeMonth();
  const days = daysInMonth(month);
  const [buses, readings] = await Promise.all([
    sheetBuses(),
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
  await BusDailyReading.updateOne({ bus: busId, date }, { $set: { km, by: req.user._id } }, { upsert: true, runValidators: true });
  return res.json({ success: true, message: 'Reading saved' });
});

// GET /api/sheets/status?month=YYYY-MM
export const getStatusSheet = asyncHandler(async (req, res) => {
  const month = req.query.month || uaeMonth();
  const days = daysInMonth(month);
  const today = uaeDay();
  const [buses, changes] = await Promise.all([
    sheetBuses(),
    BusStatusChange.find({ date: mongoose.trusted({ $lte: days.at(-1) }) }).sort({ date: 1 }),
  ]);
  const byBus = new Map();
  changes.forEach((c) => {
    const key = String(c.bus);
    if (!byBus.has(key)) byBus.set(key, []);
    byBus.get(key).push(c);
  });

  const summary = Object.fromEntries(BUS_DAY_STATUSES.map((s) => [s, days.map((day) => (day > today ? null : 0))]));
  const rows = buses.map((bus) => {
    const list = byBus.get(String(bus._id)) || [];
    let next = 0;
    let status = 'ready';
    const cells = days.map((day, index) => {
      if (day > today) return null;
      let changedToday = null;
      while (next < list.length && list[next].date <= day) {
        status = list[next].status;
        if (list[next].date === day) changedToday = list[next];
        next += 1;
      }
      summary[status][index] += 1;
      return { status, source: changedToday?.source ?? null };
    });
    return { ...busSummary(bus), cells };
  });

  res.json({ success: true, data: { month, today, days, buses: rows, summary } });
});

// PUT /api/sheets/status
export const setBusStatus = asyncHandler(async (req, res) => {
  const { busId, date, status } = req.body;
  await assertDayCanChange(busId, date);
  await BusStatusChange.updateOne(
    { bus: busId, date },
    { $set: { status, source: 'manual', by: req.user._id }, $unset: { ticket: 1 } },
    { upsert: true, runValidators: true }
  );
  res.json({ success: true, message: 'Status saved. It stays until someone changes it.' });
});

export const REPAIR_STAGES = ['waitingEstimate', 'negotiation', 'waitingApproval', 'estimateApproved', 'goneForRepair', 'invoicing', 'received'];

const STAGE_OF_STATUS = {
  sentToVendor: 'waitingEstimate',
  estimateSubmitted: 'negotiation',
  estimateCountered: 'negotiation',
  returned: 'negotiation',
  pending: 'waitingApproval',
  approved: 'estimateApproved',
  acknowledged: 'goneForRepair',
  invoiceSubmitted: 'invoicing',
  invoiceRejected: 'invoicing',
  invoiceAccepted: 'invoicing',
  completed: 'received',
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
    serviceType: mongoose.trusted({ $in: ['repair', 'tyre', 'battery', 'other'] }),
    createdAt: mongoose.trusted({ $lte: endOfUaeDay(days.at(-1)) }),
  })
    .sort({ createdAt: -1 })
    .populate('busId', 'fleetNumber make model')
    .populate('vendorId', USER_FIELDS);

  const completedOn = (ticket) => {
    const entry = ticket.history.find((h) => h.status === 'completed');
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

  // How many buses sat in each stage on each day. "Received" counts the day it happened, not every day after.
  const summary = Object.fromEntries(REPAIR_STAGES.map((s) => [s, days.map(() => null)]));
  days.forEach((day, index) => {
    if (day > today) return;
    const buses = Object.fromEntries(REPAIR_STAGES.map((s) => [s, new Set()]));
    const moment = endOfUaeDay(day);
    tickets.forEach((t) => {
      const stage = stageAt(t, moment);
      if (!stage || (stage === 'received' && completedOn(t) !== day)) return;
      buses[stage].add(String(t.busId?._id ?? t.busId));
    });
    REPAIR_STAGES.forEach((s) => {
      summary[s][index] = buses[s].size;
    });
  });

  res.json({ success: true, data: { month, today, days, rows, summary } });
});
