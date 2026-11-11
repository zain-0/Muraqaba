import mongoose from 'mongoose';
import { BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import Ticket from '../models/Ticket.js';
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

// From raising a VSR until the creator confirms the bus is back, the VSR has the bus out (2026-11-11).
export const BUS_OUT_STATUSES = ['sentToVendor', 'estimateSubmitted', 'estimateCountered', 'pending', 'returned', 'approved', 'acknowledged', 'vehicleSent', 'vehicleReceived', 'workInProgress', 'readyForDelivery', 'vehicleReleased'];

const DAY_MS = 24 * 60 * 60 * 1000;
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/**
 * The day a VSR's change of status lands on, with the status in force on `date` before it, or null
 * when it must not land. Scrapping and removed are never overridden. A change made by hand stays the
 * record for its day, so the VSR's status starts the day after, unless that day has a change of its
 * own already. Between two VSR changes on one day, the later one wins.
 */
const landingDay = async (bus, date, status) => {
  const inForce = await BusStatusChange.findOne({ bus, date: mongoose.trusted({ $lte: date }) }).sort({ date: -1 });
  if (inForce && LOCKED_STATUSES.includes(inForce.status)) return null;
  if (inForce?.date !== date || inForce.source !== 'manual') return { day: date, inForce };
  if (inForce.status === status) return null;
  const day = nextDay(date);
  return (await BusStatusChange.exists({ bus, date: day })) ? null : { day, inForce };
};

/** Writes a planned change of status, as the VSR `ticket` gave it. */
export const writeBusDayPlan = ({ bus, day, status, ticket }, userId) =>
  BusStatusChange.updateOne({ bus, date: day }, { $set: { status, source: 'vsr', ticket, by: userId } }, { upsert: true });

/**
 * Raising a VSR picks the bus's status for that day and fills in the day's km reading
 * if the sheet does not have one yet, so the creator does not type it twice.
 */
export const applyTicketToBusDay = async (ticket, userId, date = uaeDay(ticket.createdAt)) => {
  const bus = ticket.busId;
  if (ticket.currentReading !== undefined) {
    await BusDailyReading.updateOne({ bus, date }, { $setOnInsert: { km: ticket.currentReading, by: userId } }, { upsert: true });
  }
  const status = statusForTicket(ticket);
  const landing = await landingDay(bus, date, status);
  if (landing) await writeBusDayPlan({ bus, day: landing.day, status, ticket: ticket._id }, userId);
};

/**
 * The bus's status from `day` once the VSR `root` is back: Ready, or the status of another VSR on
 * the bus raised by then and still out (the latest raised). Additional jobs travel with their parent,
 * so only VSRs of their own count.
 */
export const statusAfterReturn = async (root, day) => {
  const others = await Ticket.find({
    busId: root.busId,
    _id: mongoose.trusted({ $ne: root._id }),
    parentTicket: null,
    status: mongoose.trusted({ $in: BUS_OUT_STATUSES }),
  })
    .select('serviceType repairCategory createdAt')
    .sort({ createdAt: -1 });
  const stillOut = others.find((other) => uaeDay(other.createdAt) <= day);
  return stillOut ? statusForTicket(stillOut) : 'ready';
};

/**
 * What the bus being back on `when` does to its days, without writing it: `{ bus, day, status, ticket }`,
 * or null when nothing changes. `ticket` is the VSR or one of its additional jobs. A return dated
 * before the VSR was raised counts from the day it was raised.
 */
export const planReturnToBusDay = async (ticket, when = new Date()) => {
  const root = ticket.parentTicket ? await Ticket.findById(ticket.parentTicket) : ticket;
  const raised = uaeDay(root.createdAt);
  const back = uaeDay(when);
  const date = back > raised ? back : raised;
  const status = await statusAfterReturn(root, date);
  const landing = await landingDay(root.busId, date, status);
  if (!landing || (landing.inForce?.status ?? 'ready') === status) return null;
  return { bus: root.busId, day: landing.day, status, ticket: root._id };
};

/** The creator confirmed the bus is back (or the depot work done): Ready from that day, or what still has it out. */
export const applyReturnToBusDay = async (ticket, userId, when = new Date()) => {
  const plan = await planReturnToBusDay(ticket, when);
  if (plan) await writeBusDayPlan(plan, userId);
  return plan;
};
