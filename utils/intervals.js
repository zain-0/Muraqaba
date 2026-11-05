/**
 * Service intervals on a bus. Oil, transmission and tyres are counted in km, batteries in
 * months. Used when a VSR is raised (what was left or delayed) and to say what is due.
 */
import { BusDailyReading } from '../models/BusDaily.js';

const DUE_SOON = { km: 1000, months: 1 };

/** Whole months from one date to a later one. */
export const monthsBetween = (from, to) => {
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months;
};

/** How far along its interval a service is, given the km reading and the date. */
const measure = (bus, service, km, now) => {
  const interval = bus.intervals?.[service];
  if (!interval) return undefined;
  const unit = service === 'battery' ? 'months' : 'km';
  const every = unit === 'months' ? interval.everyMonths : interval.everyKm;
  const actual = unit === 'months' ? monthsBetween(interval.lastDate, now) : km - interval.lastKm;
  return { unit, interval: every, actual, left: Math.max(every - actual, 0), delayed: Math.max(actual - every, 0) };
};

/** What a VSR stores: how much of the interval was left or delayed when it was raised. */
export const usageWhenRaised = (bus, serviceType, reading, now = new Date()) => measure(bus, serviceType, reading, now);

/** The latest km on the daily sheet for each bus, as a map of bus id to km. */
export const latestKmByBus = async () => {
  const rows = await BusDailyReading.aggregate([{ $sort: { date: -1 } }, { $group: { _id: '$bus', km: { $first: '$km' } } }]);
  return new Map(rows.map((r) => [String(r._id), r.km]));
};

/** Where a bus stands on each interval right now, for the fleet pages and the alerts. */
export const intervalStatus = (bus, latestKm, now = new Date()) => {
  // A bus with nothing on the daily sheet yet is as far as its last recorded service.
  const currentKm = latestKm ?? Math.max(bus.intervals.oil.lastKm, bus.intervals.transmission.lastKm, bus.intervals.tyre.lastKm);
  const status = { currentKm };
  ['oil', 'transmission', 'tyre', 'battery'].forEach((service) => {
    const { unit, interval, actual, left, delayed } = measure(bus, service, currentKm, now);
    const state = left === 0 ? 'overdue' : left <= DUE_SOON[unit] ? 'soon' : 'ok';
    status[service] = { unit, interval, used: Math.max(actual, 0), left, delayed, state };
  });
  return status;
};

export const withIntervalStatus = (bus, km) => ({ ...bus.toJSON(), intervalStatus: intervalStatus(bus, km) });
