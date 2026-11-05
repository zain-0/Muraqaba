/**
 * In-app notifications. There is no scheduler: reading them runs the checks, at most every few
 * minutes, and each notice has a dedupe key, so a person never gets the same one twice however
 * often the checks run. Screens word the notice from its type and params, in the viewer's language.
 *
 * Every notice passes through notifyRoles, which is where email would go. See "Adding email" in
 * the README.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { uaeDay, uaeDaysUntil } from './uaeTime.js';
import { dueServices } from '../controllers/reportController.js';

const CHECK_EVERY_MS = Number(process.env.NOTIFICATION_CHECK_MS ?? 5 * 60 * 1000);
const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const notifyRoles = async (roles, { type, params, link, dedupeKey }) => {
  const users = await User.find({ role: mongoose.trusted({ $in: roles }) }).select('_id');
  await Promise.all(
    users.map((user) =>
      // upsertedCount is 1 only the first time, so an email sent from here would go out once.
      Notification.updateOne({ user: user._id, dedupeKey }, { $setOnInsert: { type, params, link } }, { upsert: true })
    )
  );
};

const checkRegistrations = async () => {
  const now = new Date();
  const buses = await Bus.find().select('fleetNumber registrationNumber registrationExpiry');
  // Counted in UAE calendar days, so it reads the same at 01:00 as at 23:00.
  const expiring = buses.filter((bus) => uaeDaysUntil(bus.registrationExpiry, now) <= EXPIRY_WARNING_DAYS);
  await Promise.all(
    expiring.map((bus) =>
      notifyRoles(['serviceCreator'], {
        type: 'registrationExpiring',
        params: {
          fleetNumber: bus.fleetNumber,
          registrationNumber: bus.registrationNumber,
          expiry: bus.registrationExpiry,
          daysLeft: uaeDaysUntil(bus.registrationExpiry, now),
        },
        link: `/buses/${bus._id}`,
        // A renewal is a new date, so it would warn again a year later.
        dedupeKey: `registration:${bus._id}:${uaeDay(bus.registrationExpiry)}`,
      })
    )
  );
};

const checkServicesDue = async () => {
  const due = await dueServices();
  await Promise.all(
    Object.entries(due).flatMap(([service, rows]) =>
      rows.map((row) =>
        notifyRoles(['supervisor'], {
          type: 'serviceDue',
          params: { fleetNumber: row.fleetNumber, make: row.make, service, state: row.state, left: row.left, delayed: row.delayed, unit: row.unit },
          link: `/buses/${row.busId}`,
          // The last service is part of the key, so the next cycle warns again.
          dedupeKey: `due:${row.busId}:${service}:${row.state}:${row.lastService}`,
        })
      )
    )
  );
};

/** Monday of this UAE week, which names the week. */
const weekKey = () => {
  const today = new Date(`${uaeDay()}T00:00:00.000Z`);
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  return new Date(today.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
};

const checkWeeklyReport = () =>
  notifyRoles(['supervisor'], { type: 'weeklyReport', params: { week: weekKey() }, link: '/reports/weekly', dedupeKey: `weekly:${weekKey()}` });

let lastCheck = 0;

export const runChecks = async () => {
  if (Date.now() - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = Date.now();
  await Promise.all([checkRegistrations(), checkServicesDue(), checkWeeklyReport()]);
};

/** Accepting an invoice found the vendor's LPO short or missing. */
export const notifyLpoProblem = (ticket) =>
  notifyRoles(['purchaseManager', 'supervisor'], {
    type: 'lpoProblem',
    params: { vsrNumber: ticket.vsrNumber, problem: ticket.lpoDeduction.status === 'noLpo' ? 'noLpo' : 'short', lpoNumber: ticket.lpoDeduction.lpoNumber, kind: ticket.lpoDeduction.kind },
    link: `/tickets/${ticket._id}`,
    dedupeKey: `lpo:${ticket._id}`,
  });
