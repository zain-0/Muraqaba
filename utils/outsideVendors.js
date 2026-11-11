/**
 * Vendors outside our list (owner's testing notes, 2026-11-11): an accident can go to any garage,
 * named when the VSR is raised. Each is a vendor User marked `outside`, kept once per name in any
 * letter case. Nobody can sign in as one, so the service creator records that vendor's steps.
 * They are never listed with our vendors, only offered as names for the next accident.
 */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { CASE_BLIND } from './unique.js';

// An address that can never reach anyone (RFC 2606) and a password no hash can match.
const NO_ADDRESS = 'outside-vendors.muraqaba.invalid';
const NO_PASSWORD = '!outside vendor: nobody signs in';

/** The outside vendor of this name, made the first time it is used. */
export const outsideVendorNamed = async (typed) => {
  const name = typed.trim().replace(/\s+/g, ' ');
  const known = await User.findOne({ role: 'vendor', outside: true, name }).collation(CASE_BLIND);
  if (known) return known;
  return User.create({ name, email: `${randomUUID()}@${NO_ADDRESS}`, password: NO_PASSWORD, role: 'vendor', outside: true });
};

/** Listed vendors only: what every vendor picker and the Vendors page show. A fresh filter each time, server-made so trusted. */
export const listed = () => ({ outside: mongoose.trusted({ $ne: true }) });
