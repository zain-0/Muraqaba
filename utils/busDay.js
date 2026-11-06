import mongoose from 'mongoose';
import { BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import { uaeDay } from './uaeTime.js';

// A bus marked as leaving the fleet stays that way until someone changes it by hand.
const LOCKED_STATUSES = ['scrapping', 'removed'];

/**
 * Buses whose status on `day` is scrapping or removed: off the fleet, so no service or
 * registration is due on them. The status holds from its date until the next change.
 */
export const offFleetBusIds = async (day = uaeDay()) => {
  const latest = await BusStatusChange.aggregate([
    { $match: { date: mongoose.trusted({ $lte: day }) } },
    { $sort: { date: -1 } },
    { $group: { _id: '$bus', status: { $first: '$status' } } },
  ]);
  return new Set(latest.filter((row) => LOCKED_STATUSES.includes(row.status)).map((row) => String(row._id)));
};

export const statusForTicket = ({ serviceType, repairCategory }) => {
  if (serviceType === 'tyre') return 'tyreChange';
  if (serviceType === 'battery') return 'batteryChange';
  if (serviceType === 'brakePads') return 'repair';
  if (serviceType !== 'repair') return 'maintenance';
  return repairCategory === 'ACCIDENT' ? 'accident' : 'repair';
};

/**
 * Raising a VSR picks the bus's status for that day and fills in the day's km reading
 * if the sheet does not have one yet, so the creator does not type it twice.
 */
export const applyTicketToBusDay = async (ticket, userId, date = uaeDay(ticket.createdAt)) => {
  const bus = ticket.busId;
  if (ticket.currentReading !== undefined) {
    await BusDailyReading.updateOne({ bus, date }, { $setOnInsert: { km: ticket.currentReading, by: userId } }, { upsert: true });
  }
  const current = await BusStatusChange.findOne({ bus, date: mongoose.trusted({ $lte: date }) }).sort({ date: -1 });
  if (current && LOCKED_STATUSES.includes(current.status)) return;
  await BusStatusChange.updateOne(
    { bus, date },
    { $set: { status: statusForTicket(ticket), source: 'vsr', ticket: ticket._id, by: userId } },
    { upsert: true }
  );
};
