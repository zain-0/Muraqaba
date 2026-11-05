/**
 * When the supervisor accepts an invoice, tyre and battery VSRs take quantity and amount off
 * the vendor's current LPO and repairs take the amount only. A short LPO never stops the
 * invoice: the work is already done, so the overrun is recorded for people to act on.
 */
import mongoose from 'mongoose';
import { Lpo } from '../models/Purchase.js';
import { uaeDay } from './uaeTime.js';

const LPO_SERVICES = ['tyre', 'battery', 'repair'];

const hasRoom = (item, quantity, amount) => item.total - item.usedAmount >= amount && (item.kind === 'repair' || item.quantity - item.usedQuantity >= quantity);

/** Returns what to record on the ticket, or undefined when this service uses no LPO. */
export const deductFromLpo = async (ticket, invoice) => {
  const kind = ticket.serviceType;
  if (!LPO_SERVICES.includes(kind)) return undefined;
  const amount = invoice.amount;
  const quantity = kind === 'repair' ? 0 : (ticket.breakdown?.parts ?? []).reduce((sum, part) => sum + part.quantity, 0);

  const startOfToday = new Date(`${uaeDay()}T00:00:00.000Z`);
  const lpos = await Lpo.find({
    vendor: ticket.vendorId,
    validFrom: mongoose.trusted({ $lte: new Date() }),
    validTo: mongoose.trusted({ $gte: startOfToday }),
    'items.kind': kind,
  }).sort({ validTo: 1, createdAt: 1 });
  if (!lpos.length) return { status: 'noLpo', kind, quantity, amount, at: new Date() };

  const lineOf = (lpo, fits) => lpo.items.find((item) => item.kind === kind && fits(item));
  const withRoom = lpos.find((lpo) => lineOf(lpo, (item) => hasRoom(item, quantity, amount)));
  const lpo = withRoom ?? lpos[0];
  const item = withRoom ? lineOf(lpo, (line) => hasRoom(line, quantity, amount)) : lineOf(lpo, () => true);

  await Lpo.updateOne(
    { _id: lpo._id, 'items._id': item._id },
    { $inc: { usedAmount: amount, 'items.$.usedAmount': amount, 'items.$.usedQuantity': quantity } }
  );
  return { status: 'deducted', lpo: lpo._id, lpoNumber: lpo.number, item: item._id, kind, quantity, amount, overrun: !withRoom, at: new Date() };
};
