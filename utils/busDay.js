import mongoose from 'mongoose';
import { BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import { uaeDay } from './uaeTime.js';

// A bus marked as leaving the fleet stays that way until someone changes it by hand.
const LOCKED_STATUSES = ['scrapping', 'removed'];

export const statusForTicket = ({ serviceType, repairCategory }) => {
  if (serviceType !== 'repair') return 'maintenance';
  if (repairCategory === 'TYRE REPLACEMENT') return 'tyreChange';
  if (repairCategory === 'BATTERY REPLACEMENT') return 'batteryChange';
  if (repairCategory === 'ACCIDENT') return 'accident';
  return 'repair';
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
