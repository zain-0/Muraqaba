/**
 * The fleet day by day: which buses were on it, and each one's status on each day. The daily
 * status sheet and purchasing's Availability and Downtime reports all read it from here, so they
 * cannot disagree.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import { BUS_DAY_STATUSES, BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import { uaeDay } from './uaeTime.js';

/** A bus scrapping or removed is on the sheet but leaves the fleet's counts. */
export const NOT_COUNTED = ['scrapping', 'removed'];
export const COUNTED = BUS_DAY_STATUSES.filter((status) => !NOT_COUNTED.includes(status));

/**
 * The buses on the fleet by `lastDay`, each with the first day it was on the fleet: the day it
 * was added, or an earlier day the sheets already hold for it (history entered for a bus added later).
 */
export const fleetBuses = async (lastDay) => {
  const [buses, firstReading, firstStatus] = await Promise.all([
    Bus.find().sort({ fleetNumber: 1 }).select('fleetNumber registrationNumber make model createdAt'),
    BusDailyReading.aggregate([{ $group: { _id: '$bus', first: { $min: '$date' } } }]),
    BusStatusChange.aggregate([{ $group: { _id: '$bus', first: { $min: '$date' } } }]),
  ]);
  const earliest = new Map();
  [...firstReading, ...firstStatus].forEach(({ _id, first }) => {
    const key = String(_id);
    if (!earliest.has(key) || first < earliest.get(key)) earliest.set(key, first);
  });
  return buses
    .map((bus) => {
      const added = uaeDay(bus.createdAt ?? new Date());
      const sheet = earliest.get(String(bus._id));
      return Object.assign(bus, { firstDay: sheet && sheet < added ? sheet : added });
    })
    .filter((bus) => bus.firstDay <= lastDay);
};

/**
 * Each bus's status on each of `days` ('YYYY-MM-DD', consecutive, oldest first), as
 * `{ bus, cells }`. A cell is `{ status, source }` from the day the bus joined the fleet up to
 * today, and null before it joined and after today. A status holds until the bus's next change;
 * `source` says who changed it, on the day it changed.
 */
export const fleetDays = async (days, today = uaeDay()) => {
  const [buses, changes] = await Promise.all([
    fleetBuses(days.at(-1)),
    BusStatusChange.find({ date: mongoose.trusted({ $lte: days.at(-1) }) }).sort({ date: 1 }),
  ]);
  const byBus = new Map();
  changes.forEach((c) => {
    const key = String(c.bus);
    if (!byBus.has(key)) byBus.set(key, []);
    byBus.get(key).push(c);
  });

  return buses.map((bus) => {
    const list = byBus.get(String(bus._id)) || [];
    let next = 0;
    let status = 'ready';
    const cells = days.map((day) => {
      if (day > today || day < bus.firstDay) return null; // a bus is counted only once it is on the fleet
      let changedToday = null;
      while (next < list.length && list[next].date <= day) {
        status = list[next].status;
        if (list[next].date === day) changedToday = list[next];
        next += 1;
      }
      return { status, source: changedToday?.source ?? null };
    });
    return { bus, cells };
  });
};

/** How many buses had each status on each day; null on days after today. */
export const statusSummary = (rows, days, today = uaeDay()) => {
  const summary = Object.fromEntries(BUS_DAY_STATUSES.map((s) => [s, days.map((day) => (day > today ? null : 0))]));
  rows.forEach(({ cells }) =>
    cells.forEach((cell, index) => {
      if (cell) summary[cell.status][index] += 1;
    })
  );
  return summary;
};
