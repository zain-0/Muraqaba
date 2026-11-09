/**
 * Which LPO a VSR comes off, and taking it off when the supervisor accepts the invoice. Tyre and
 * battery VSRs take quantity and amount; repairs, brake pads, oil, transmission and other work
 * take the amount only. A short LPO never stops the invoice: the work is already done, so the
 * overrun is recorded for people to act on.
 *
 * chooseLpo only reads. The new VSR form's preview and the charge both use it, so what the
 * creator is shown is what the invoice comes off.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import { Lpo } from '../models/Purchase.js';
import { brandKey } from './reportMaths.js';
import { uaeDay } from './uaeTime.js';

export const LINE_FOR_SERVICE = {
  repair: 'repairMaintenance',
  brakePads: 'repairMaintenance',
  oil: 'repairMaintenance',
  transmission: 'repairMaintenance',
  tyre: 'tyre',
  battery: 'battery',
  other: 'other',
};
export const COUNTED_BY_QUANTITY = ['tyre', 'battery'];

const hasRoom = (item, quantity, amount) => item.total - item.usedAmount >= amount && (!COUNTED_BY_QUANTITY.includes(item.kind) || item.quantity - item.usedQuantity >= quantity);

/** An LPO with no make covers every make; one with a make covers only buses of that make, in any letter case. */
export const coversMake = (lpo, make) => !brandKey(lpo.make) || brandKey(lpo.make) === brandKey(make);

/**
 * The LPO a job of `serviceType` on `bus` for this vendor comes off: the vendor's LPOs valid today
 * (UAE day) with a line of that kind and the bus's make or none, earliest ending first. The first
 * with room for the amount (and the quantity, for tyres and batteries) wins; with no room anywhere,
 * the first, as an overrun. Returns `{ kind, make, status, lpo, item, overrun }`, where status is
 * found, noLpo, or notNeeded for other work with no line of its own.
 */
export const chooseLpo = async ({ vendorId, bus, serviceType, amount = 0, quantity = 0 }) => {
  const kind = LINE_FOR_SERVICE[serviceType];
  const make = bus?.make?.trim() ?? null;
  // LPO dates are stored as plain days at midnight UTC, so compare them as days.
  const today = uaeDay();
  const candidates = await Lpo.find({
    vendor: vendorId,
    validFrom: mongoose.trusted({ $lte: new Date(`${today}T23:59:59.999Z`) }),
    validTo: mongoose.trusted({ $gte: new Date(`${today}T00:00:00.000Z`) }),
    'items.kind': kind,
  }).sort({ validTo: 1, createdAt: 1 });
  const lpos = candidates.filter((lpo) => coversMake(lpo, make));
  // Only other work with no line of its own is normal; anything else with no LPO needs someone to look.
  if (!lpos.length) return { kind, make, status: kind === 'other' ? 'notNeeded' : 'noLpo', lpo: null, item: null, overrun: false };

  const lineOf = (lpo, fits) => lpo.items.find((item) => item.kind === kind && fits(item));
  const roomy = (item) => hasRoom(item, quantity, amount);
  const withRoom = lpos.find((lpo) => lineOf(lpo, roomy));
  const lpo = withRoom ?? lpos[0];
  const item = withRoom ? lineOf(lpo, roomy) : lineOf(lpo, () => true);
  return { kind, make, status: 'found', lpo, item, overrun: !withRoom };
};

/** How many came off the line: what the creator said was fitted, or every part listed if they did not say. */
const quantityOf = (ticket) => {
  if (!COUNTED_BY_QUANTITY.includes(ticket.serviceType)) return 0;
  return ticket.breakdown?.unitsFitted ?? (ticket.breakdown?.parts ?? []).reduce((sum, part) => sum + part.quantity, 0);
};

/** Takes the accepted invoice off the LPO. Returns what to record on the ticket, or undefined when there is nothing worth recording. */
export const deductFromLpo = async (ticket, invoice) => {
  const amount = invoice.amount;
  const quantity = quantityOf(ticket);
  const bus = await Bus.findById(ticket.busId).select('make');
  const { kind, status, lpo, item, overrun } = await chooseLpo({ vendorId: ticket.vendorId, bus, serviceType: ticket.serviceType, amount, quantity });
  if (status === 'notNeeded') return undefined;
  if (status === 'noLpo') return { status: 'noLpo', kind, quantity, amount, at: new Date() };

  await Lpo.updateOne(
    { _id: lpo._id, 'items._id': item._id },
    { $inc: { usedAmount: amount, 'items.$.usedAmount': amount, 'items.$.usedQuantity': quantity } }
  );
  return { status: 'deducted', lpo: lpo._id, lpoNumber: lpo.number, item: item._id, kind, quantity, amount, overrun, at: new Date() };
};
