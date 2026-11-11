/**
 * The arithmetic purchasing's reports share, kept apart from the database so it can be tested
 * on its own. Money is added in whole fils and turned back into AED once, at the end, so a
 * total is always exactly the sum of its rows (0.1 + 0.2 is 0.3 here, not 0.30000000000000004).
 */
import { daysInMonth, uaeDay } from './uaeTime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** AED to whole fils. Rounding absorbs the float error of x100 (33.33 * 100 is 3332.9999999999995). */
export const toFils = (aed) => Math.round(Number(aed ?? 0) * 100);

/** Whole fils back to AED; an integer divided by 100 is the nearest double to the 2-decimal amount. */
export const toAed = (fils) => fils / 100;

/** The figure a VSR counts under: accidents apart from other repairs. */
export const kindOf = ({ serviceType, repairCategory }) => (serviceType === 'repair' && repairCategory === 'ACCIDENT' ? 'accident' : serviceType);

/** A brand typed as "hino" on one bus and "Hino" on another is one brand. */
export const brandKey = (make) => String(make ?? '').trim().toLowerCase();

const acceptedInvoice = (ticket) => ticket.status !== 'declined' && ticket.invoice?.status === 'approved';

/** What the VSR cost: its current invoice once accepted, otherwise nothing. `invoice` must be populated. */
export const spendFils = (ticket) => (acceptedInvoice(ticket) ? toFils(ticket.invoice.amount) : 0);

/** What is promised but not yet invoiced: the approved estimate until an invoice is accepted. A no-charge job commits 0. */
export const committedFils = (ticket) => {
  if (ticket.status === 'declined' || acceptedInvoice(ticket) || ticket.approvedEstimate == null) return 0;
  return toFils(ticket.approvedEstimate);
};

/** Whole days from one 'YYYY-MM-DD' day to another. Both parse as UTC midnight, so the gap is exact. */
export const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** Every day of a year as 'YYYY-MM-DD'. */
export const daysOfYear = (year) => Array.from({ length: 12 }, (_, i) => daysInMonth(`${year}-${String(i + 1).padStart(2, '0')}`)).flat();

/**
 * UAE days the bus spent away on this VSR: from sent (or, at the depot, from the day work started)
 * to back. Null for an additional job, which rides in its parent's trip, and for a bus not back yet.
 */
export const workshopDays = (ticket) => {
  if (ticket.parentTicket) return null;
  const vehicle = ticket.vehicle ?? {};
  const start = ticket.location === 'depot' ? vehicle.workStartedAt : vehicle.sentAt;
  if (!start || !vehicle.returnedAt) return null;
  return Math.max(daysBetween(uaeDay(start), uaeDay(vehicle.returnedAt)), 0);
};

/** Late: more days at the workshop than the vendor's latest promise. */
export const isLate = (ticket, days) => days != null && ticket.daysToComplete != null && days > ticket.daysToComplete;

/** Average days with one decimal, worked from the sums (never an average of averages). */
export const averageDays = (days, trips) => (trips ? Math.round((days * 10) / trips) / 10 : null);

/** part / whole, or null when there is nothing to divide by. */
export const ratio = (part, whole) => (whole ? part / whole : null);

/** AED per km with four decimals, or null when the km are 0 or unknown. */
export const spendPerKm = (fils, km) => (km ? Math.round((fils * 100) / km) / 10000 : null);

/**
 * Km a bus drove in a 'YYYY-MM' month: its latest reading in the month less its latest reading
 * before the month (or, with none, its first reading in the month). Null with no reading in the
 * month. An odometer slip that goes backwards gives 0, never negative km.
 */
export const kmInMonth = (readings, month) => {
  const days = daysInMonth(month);
  const sorted = [...readings].sort((a, b) => a.date.localeCompare(b.date));
  const inMonth = sorted.filter((r) => r.date >= days[0] && r.date <= days.at(-1));
  if (!inMonth.length) return null;
  const before = sorted.filter((r) => r.date < days[0]).at(-1) ?? inMonth[0];
  return Math.max(inMonth.at(-1).km - before.km, 0);
};

/**
 * A bus's km between two days (owner's testing notes, 2026-11-11): its last reading on or before
 * `to`, less its last reading on or before `from`; with none by `from`, its first reading in the
 * range (`startsLater`). Null km when it has no reading in the range. Never negative.
 */
export const kmInRange = (readings, from, to) => {
  const sorted = [...readings].sort((a, b) => a.date.localeCompare(b.date)).map(({ date, km }) => ({ date, km }));
  const upTo = (day) => sorted.filter((r) => r.date <= day).at(-1) ?? null;
  const inRange = sorted.filter((r) => r.date >= from && r.date <= to);
  const before = upTo(from);
  const end = upTo(to);
  if (!inRange.length) return { start: before, end, km: null, startsLater: false };
  const start = before ?? inRange[0];
  return { start, end, km: Math.max(end.km - start.km, 0), startsLater: !before };
};

/** Km bands for a month's driving; 0 km is "not operated" and sits outside them. */
export const BANDS = [
  { from: 1, to: 5000 },
  { from: 5001, to: 10000 },
  { from: 10001, to: 15000 },
  { from: 15001, to: 20000 },
  { from: 20001, to: 25000 },
  { from: 25001, to: 30000 },
  { from: 30001, to: null },
];

/** Which band a month's km fall in: -1 for not operated, else the index in BANDS. */
export const bandIndex = (km) => (km <= 0 ? -1 : BANDS.findIndex((band) => band.to === null || km <= band.to));
