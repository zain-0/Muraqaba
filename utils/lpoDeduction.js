/**
 * Which LPO line a VSR comes off, and taking it off at the GRN (2026-11-10).
 *
 * The creator picks the line when raising the VSR, from candidateLines: any vendor's lines valid
 * today of the kind the service needs, and for repair and maintenance the bus's make. Its amount
 * is booked against the line (utils/lpoBalance.js) until purchasing makes the GRN, which deducts
 * the accepted invoice and replaces the booking. A short LPO never stops the GRN: the work is
 * done, so the overrun is recorded for people to act on.
 *
 * A VSR with no line (raised when there was none, or before 2026-11-10) gets the automatic choice
 * at the GRN: the vendor's lines valid today, earliest ending first, the first with room.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import { Lpo } from '../models/Purchase.js';
import { COUNTED_BY_QUANTITY, balanceOf, balancesFor, reservedAmount, unitsOf } from './lpoBalance.js';
import { brandKey, toAed, toFils } from './reportMaths.js';
import { tyreSizeFits } from './tyreSize.js';
import { uaeDay } from './uaeTime.js';

export { COUNTED_BY_QUANTITY };

// An accident is raised against no line (its vendor may be anyone, 2026-11-11); at the GRN it comes
// off its vendor's repair and maintenance line for the bus's make, if there is one.
export const LINE_FOR_SERVICE = {
  repair: 'repairMaintenance',
  oil: 'repairMaintenance',
  accident: 'repairMaintenance',
  tyre: 'tyre',
  battery: 'battery',
  other: 'other',
};

/** A line with no make covers every make; a line with a make covers only buses of that make, in any letter case. */
export const coversMake = (item, make) => !brandKey(item.make) || brandKey(item.make) === brandKey(make);

/** LPOs valid on a UAE day. Their dates are stored as plain days at midnight UTC, so they compare as days. */
export const validOn = (day) => ({
  validFrom: mongoose.trusted({ $lte: new Date(`${day}T23:59:59.999Z`) }),
  validTo: mongoose.trusted({ $gte: new Date(`${day}T00:00:00.000Z`) }),
});

/** Whether an LPO is valid on a UAE day ('YYYY-MM-DD'). */
export const isInDate = (lpo, day = uaeDay()) => lpo.validFrom.toISOString().slice(0, 10) <= day && lpo.validTo.toISOString().slice(0, 10) >= day;

/** What the creator may raise this job against. Other work has no line of its own any more, and an accident chooses none. */
const raisedAgainst = (serviceType) => (['other', 'accident'].includes(serviceType) ? undefined : LINE_FOR_SERVICE[serviceType]);

/**
 * Whether a line can carry this job when raising: its kind, for repair and maintenance the bus's
 * make exactly, and for tyres the bus's tyre size (2026-11-11). A bus with no size takes every
 * tyre line, and so does an old tyre line with no size.
 */
export const fitsJob = (item, { kind, make, tyreSize }) =>
  item.kind === kind &&
  (kind !== 'repairMaintenance' || (Boolean(brandKey(item.make)) && brandKey(item.make) === brandKey(make))) &&
  (kind !== 'tyre' || !item.size?.trim() || tyreSizeFits(tyreSize, item.size));

/**
 * The lines a job of `serviceType` on `bus` can be raised against, as `{ lpo, item }` with the
 * LPO's vendor populated (_id and name). Tyre lines are only those that fit the bus's tyre size. Any vendor's: the bus's own vendor first, then the
 * soonest ending, then by LPO number.
 */
export const candidateLines = async ({ bus, serviceType }) => {
  const kind = raisedAgainst(serviceType);
  if (!kind) return [];
  const lpos = await Lpo.find({ ...validOn(uaeDay()), 'items.kind': kind }).populate('vendor', 'name');
  const make = bus.make?.trim() ?? null;
  const ownVendor = String(bus.vendor?._id ?? bus.vendor);
  const rank = ({ lpo }) => (String(lpo.vendor?._id ?? lpo.vendor) === ownVendor ? 0 : 1);
  return lpos
    .flatMap((lpo) => lpo.items.filter((item) => fitsJob(item, { kind, make, tyreSize: bus.tyreSize })).map((item) => ({ lpo, item })))
    .sort((a, b) => rank(a) - rank(b) || a.lpo.validTo - b.lpo.validTo || a.lpo.number.localeCompare(b.lpo.number, undefined, { numeric: true }));
};

/** What the screens are told about a job: the line kind, the bus's make, and whether lines exist. */
export const lineStatus = (serviceType, lines) => {
  if (!raisedAgainst(serviceType)) return 'notNeeded';
  return lines.length ? 'found' : 'noLpo';
};

/**
 * The automatic choice among `lpos` already narrowed to one vendor and valid today: lines of
 * `kind` that cover `make`, earliest ending first; the first with room for the amount (and the
 * quantity, for tyres and batteries), or with no room anywhere the first, as an overrun.
 * `available(item)` gives what is left on a line. Reads nothing, so the migration can use it too.
 */
export const chooseFrom = (lpos, { kind, make, amount = 0, quantity = 0, available }) => {
  const lines = [...lpos]
    .sort((a, b) => a.validTo - b.validTo || a.createdAt - b.createdAt)
    .flatMap((lpo) => lpo.items.filter((item) => item.kind === kind && coversMake(item, make)).map((item) => ({ lpo, item })));
  if (!lines.length) return null;
  const roomy = ({ item }) => {
    const left = available(item);
    return toFils(left.amount) >= toFils(amount) && (!COUNTED_BY_QUANTITY.includes(kind) || left.quantity >= quantity);
  };
  const withRoom = lines.find(roomy);
  return { ...(withRoom ?? lines[0]), overrun: !withRoom };
};

/** What is free on each line of `lpos` now, counting the VSRs booked and deducted on it: line id to `{ fils, units }`. */
export const roomOn = (lpos, tickets) =>
  new Map(
    lpos.flatMap((lpo) =>
      lpo.items.map((item) => {
        const { available } = balanceOf(item, tickets);
        return [String(item._id), { fils: toFils(available.amount), units: available.quantity ?? 0 }];
      })
    )
  );

/**
 * The line each of these open VSRs with none would come off at its GRN now, one VSR at a time in
 * the order given, each booking counted against the next. `lpos` are the LPOs valid today, `makeOf`
 * gives a VSR's bus make, and `room` (from roomOn) is used up as lines are given. Used where VSRs
 * from before 2026-11-10 are brought in: the migration and the client seed. Returns
 * `{ ticket, lpo, item, overrun }` for each VSR a line was found for.
 */
export const linesForOpen = (tickets, { lpos, makeOf, room }) =>
  tickets.flatMap((ticket) => {
    const amount = reservedAmount(ticket);
    const units = COUNTED_BY_QUANTITY.includes(ticket.serviceType) ? unitsOf(ticket) : 0;
    const vendor = String(ticket.vendorId?._id ?? ticket.vendorId);
    const mine = lpos.filter((lpo) => String(lpo.vendor?._id ?? lpo.vendor) === vendor);
    const available = (item) => {
      const left = room.get(String(item._id));
      return { amount: toAed(left.fils), quantity: left.units };
    };
    const choice = chooseFrom(mine, { kind: LINE_FOR_SERVICE[ticket.serviceType], make: makeOf(ticket)?.trim() ?? null, amount, quantity: units, available });
    if (!choice) return [];
    const left = room.get(String(choice.item._id));
    left.fils -= toFils(amount);
    if (COUNTED_BY_QUANTITY.includes(choice.item.kind)) left.units -= units;
    return [{ ticket, ...choice }];
  });

/** A ticket's lpoLine for a line of an LPO. */
export const lpoLineOf = ({ lpo, item }) => ({ lpo: lpo._id, lpoNumber: lpo.number, item: item._id, name: item.name, kind: item.kind, unitPrice: item.unitPrice });

/**
 * The automatic choice for this vendor, bus and service, counting every booking and GRN. Returns
 * `{ kind, make, status, lpo, item, overrun }`, where status is found, noLpo, or notNeeded for
 * other work with no line.
 */
export const chooseLpo = async ({ vendorId, bus, serviceType, amount = 0, quantity = 0 }) => {
  const kind = LINE_FOR_SERVICE[serviceType];
  const make = bus?.make?.trim() ?? null;
  const lpos = await Lpo.find({ vendor: vendorId, ...validOn(uaeDay()), 'items.kind': kind });
  const balances = await balancesFor(lpos);
  const choice = chooseFrom(lpos, { kind, make, amount, quantity, available: (item) => balances.get(String(item._id)).available });
  // Only other work with no line of its own is normal; anything else with no LPO needs someone to look.
  if (!choice) return { kind, make, status: kind === 'other' ? 'notNeeded' : 'noLpo', lpo: null, item: null, overrun: false };
  return { kind, make, status: 'found', ...choice };
};

/** Takes `amount` and `quantity` off a line in one step, and says whether that went past its value. */
const takeOff = async (lpoId, itemId, kind, amount, quantity) => {
  const lpo = await Lpo.findOneAndUpdate(
    { _id: lpoId, 'items._id': itemId },
    { $inc: { usedAmount: amount, 'items.$.usedAmount': amount, 'items.$.usedQuantity': quantity } },
    { new: true }
  );
  if (!lpo) return null;
  const item = lpo.items.id(itemId);
  const overrun = toFils(item.usedAmount) > toFils(item.total) || (COUNTED_BY_QUANTITY.includes(kind) && item.usedQuantity > item.quantity);
  return { lpo, item, overrun };
};

/**
 * What the GRN takes off for one VSR, given its accepted invoice amount: off the line it was
 * raised against, or by the automatic choice. Returns what to record as its lpoDeduction, or
 * undefined when there is nothing to record (charged already under the old rule, or other work
 * with no line).
 */
export const deductAtGrn = async (ticket, amount) => {
  if (ticket.lpoDeduction) return undefined;
  const at = new Date();
  if (ticket.lpoLine?.item) {
    const { kind } = ticket.lpoLine;
    const quantity = COUNTED_BY_QUANTITY.includes(kind) ? unitsOf(ticket) : 0;
    const taken = await takeOff(ticket.lpoLine.lpo, ticket.lpoLine.item, kind, amount, quantity);
    if (taken) return { status: 'deducted', lpo: taken.lpo._id, lpoNumber: taken.lpo.number, item: taken.item._id, kind, quantity, amount, overrun: taken.overrun, at };
    // The LPO was taken away since; the job still has to come off something, so it is chosen afresh.
  }
  const quantity = COUNTED_BY_QUANTITY.includes(ticket.serviceType) ? unitsOf(ticket) : 0;
  const bus = await Bus.findById(ticket.busId?._id ?? ticket.busId).select('make');
  const { kind, status, lpo, item } = await chooseLpo({ vendorId: ticket.vendorId?._id ?? ticket.vendorId, bus, serviceType: ticket.serviceType, amount, quantity });
  if (status === 'notNeeded') return undefined;
  if (status === 'noLpo') return { status: 'noLpo', kind, quantity, amount, at };
  const lineQuantity = COUNTED_BY_QUANTITY.includes(kind) ? quantity : 0;
  const taken = await takeOff(lpo._id, item._id, kind, amount, lineQuantity);
  if (!taken) return { status: 'noLpo', kind, quantity, amount, at };
  return { status: 'deducted', lpo: lpo._id, lpoNumber: lpo.number, item: item._id, kind, quantity: lineQuantity, amount, overrun: taken.overrun, at };
};
