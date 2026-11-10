/**
 * What is left on an LPO line, the one way every screen and check works it out (client's
 * document, 2026-11-10). For each line:
 *
 * - value: what purchasing wrote, the total and (tyres and batteries) the quantity
 * - grn: what GRNs have taken off, stored on the line as usedAmount and usedQuantity
 * - booked: what open VSRs on the line reserve until their GRN deducts it
 * - available = value - booked - grn, the limit for the next VSR
 * - afterGrn = value - grn
 * - vsrs: VSRs on the line, every status but declined
 *
 * What a VSR reserves is read off the VSR each time and never stored, so it cannot drift from it.
 * Money is added in whole fils, as in the reports.
 */
import mongoose from 'mongoose';
import Ticket, { CLOSED_STATUSES } from '../models/Ticket.js';
import { toAed, toFils } from './reportMaths.js';

export const COUNTED_BY_QUANTITY = ['tyre', 'battery'];

// A VSR has no cancelled status yet; one would count like declined.
const NOT_COUNTED = ['declined', 'cancelled'];
// Finished, turned down or at no charge: nothing more can come off the line for it.
const NOT_BOOKED = [...CLOSED_STATUSES, 'cancelled'];

const latestVendorAmount = (ticket) => [...(ticket.negotiation ?? [])].reverse().find((round) => round.from === 'vendor')?.amount;

/** What a VSR holds on its line: the approved amount, else the agreed price, the creator's estimate, or the vendor's latest estimate. */
export const reservedAmount = (ticket) => ticket.approvedEstimate ?? ticket.agreedPrice?.amount ?? ticket.estimatedAmount ?? latestVendorAmount(ticket) ?? 0;

/** Tyres or batteries the job takes: what the creator says was fitted, else what was raised, else every part listed. */
export const unitsOf = (ticket) => ticket.breakdown?.unitsFitted ?? ticket.quantity ?? (ticket.breakdown?.parts ?? []).reduce((sum, part) => sum + part.quantity, 0);

/** The line a VSR is on: the one chosen when it was raised, or for an older VSR the one it was charged to. */
export const lineIdOf = (ticket) => ticket.lpoLine?.item ?? (ticket.lpoDeduction?.status === 'deducted' ? ticket.lpoDeduction.item : undefined);

/** Open and not yet on a GRN, so its amount is booked. A VSR charged under the old rule has nothing booked. */
export const isBooked = (ticket) => Boolean(ticket.lpoLine?.item) && !NOT_BOOKED.includes(ticket.status) && !ticket.lpoDeduction;

const BALANCE_FIELDS = 'vsrNumber busId status serviceType lpoLine lpoDeduction approvedEstimate agreedPrice estimatedAmount negotiation.from negotiation.amount quantity breakdown.unitsFitted breakdown.parts.quantity grn';

/** The VSRs on these lines, declined ones left out. */
export const ticketsOnLines = (itemIds) =>
  Ticket.find({ status: mongoose.trusted({ $nin: NOT_COUNTED }), $or: [{ 'lpoLine.item': mongoose.trusted({ $in: itemIds }) }, { 'lpoDeduction.item': mongoose.trusted({ $in: itemIds }) }] })
    .select(BALANCE_FIELDS)
    .lean();

const sum = (values) => values.reduce((total, value) => total + value, 0);

/**
 * One line's figures from the VSRs on it. `exclude` leaves one VSR's booking out, so a VSR being
 * corrected is checked against what is left without itself. Quantities are null for repair and
 * maintenance (and other) lines.
 */
export const balanceOf = (item, tickets, { exclude } = {}) => {
  const counted = COUNTED_BY_QUANTITY.includes(item.kind);
  const onLine = tickets.filter((ticket) => String(lineIdOf(ticket)) === String(item._id) && !NOT_COUNTED.includes(ticket.status));
  const booked = onLine.filter((ticket) => isBooked(ticket) && !(exclude && String(ticket._id) === String(exclude)));
  const figure = (fils, units) => ({ amount: toAed(fils), quantity: counted ? units : null });
  const value = [toFils(item.total), item.quantity ?? 0];
  const grn = [toFils(item.usedAmount), item.usedQuantity ?? 0];
  const held = [sum(booked.map((ticket) => toFils(reservedAmount(ticket)))), sum(booked.map(unitsOf))];
  return {
    value: figure(...value),
    booked: figure(...held),
    grn: figure(...grn),
    available: figure(value[0] - held[0] - grn[0], value[1] - held[1] - grn[1]),
    afterGrn: figure(value[0] - grn[0], value[1] - grn[1]),
    vsrs: onLine.length,
  };
};

/** Every line of these LPOs with its figures, by line id, from one read of the VSRs. */
export const balancesFor = async (lpos, options) => {
  const items = lpos.flatMap((lpo) => lpo.items);
  const tickets = items.length ? await ticketsOnLines(items.map((item) => item._id)) : [];
  return new Map(items.map((item) => [String(item._id), balanceOf(item, tickets, options)]));
};

/** Past its value once everything booked and deducted is counted, in amount or (tyres and batteries) quantity. */
export const isOverdrawn = (balance) => balance.available.amount < 0 || (balance.available.quantity ?? 0) < 0;

/** Amount totals of several lines' figures, for an LPO or a report total. Quantities of different lines do not add up. */
export const amountTotals = (balances) => {
  const total = (pick) => toAed(sum(balances.map((balance) => toFils(pick(balance)))));
  return {
    value: total((b) => b.value.amount),
    booked: total((b) => b.booked.amount),
    grn: total((b) => b.grn.amount),
    available: total((b) => b.available.amount),
    afterGrn: total((b) => b.afterGrn.amount),
    vsrs: sum(balances.map((b) => b.vsrs)),
  };
};
