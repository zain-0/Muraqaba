/**
 * Loads a depot's own records into an empty database, so the demo shows its real fleet: vendors,
 * buses, LPOs, the daily km and status sheets, and every VSR replayed to the stage its records
 * show, with invoices, GRNs and purchase invoices for the finished ones.
 *
 *   node scripts/seed.js --reset --client <folder holding client-data.json>
 *
 * The JSON is prepared outside this repository from the depot's own files. Nothing about the depot
 * is written here: every name, number and price comes from that file.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import config from '../config/config.js';
import User, { SignatureImage } from '../models/User.js';
import Bus from '../models/Bus.js';
import Ticket, { CLOSED_STATUSES } from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import Counter from '../models/Counter.js';
import { Grn, Lpo, PurchaseInvoice, lineName } from '../models/Purchase.js';
import { BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import { COUNTED_BY_QUANTITY, LINE_FOR_SERVICE, isInDate, linesForOpen, lpoLineOf, roomOn } from '../utils/lpoDeduction.js';
import { unitsOf } from '../utils/lpoBalance.js';
import { uaeDay } from '../utils/uaeTime.js';
import { applyBusLifecycleChanges, busLifecycleChanges, mergeRepairMaintenance, mostCommonMake } from '../utils/fleetLifecycle.js';
import { UPLOAD_DIR, storedPath } from '../utils/uploads.js';
import { demoPdf, signatureDataUrl } from './demoFiles.js';

const { ObjectId } = mongoose.Types;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const money = (value) => Math.round(value * 100) / 100;

/** A time on a UAE calendar day ('YYYY-MM-DD', 'HH:MM'). */
const uaeTime = (day, clock) => new Date(`${day}T${clock}:00+04:00`);
const addDays = (date, days) => new Date(date.getTime() + days * DAY);

// The stages in the order a VSR passes them. A rejected invoice is a detour, reached only when asked for.
const STAGES = [
  'sentToVendor', 'estimateSubmitted', 'pending', 'approved', 'acknowledged', 'vehicleSent', 'vehicleReceived', 'workInProgress',
  'readyForDelivery', 'vehicleReleased', 'vehicleReturned', 'invoiceSubmitted', 'invoiceRejected', 'invoiceAccepted', 'invoiceReceived',
  'forwardedToPurchase', 'grnCreated', 'completed',
];
const DATE_FIELD = { approved: 'approvedAt', acknowledged: 'acknowledgedAt', invoiceSubmitted: 'invoiceSubmittedAt', invoiceRejected: 'invoiceRejectedAt', invoiceAccepted: 'invoiceAcceptedAt', completed: 'completedAt' };

/**
 * The kind of work as the app has it since the owner's testing notes of 2026-11-11: transmission
 * and brake pads are repair categories, and an accident is a service type of its own. The records
 * may still use the older shapes, which come in as the migration (migrate-owner-testing.js) leaves them.
 */
export const workOf = ({ serviceType, repairCategory, isBreakdown }) => {
  const moved = {
    transmission: { serviceType: 'repair', repairCategory: 'TRANSMISSION' },
    brakePads: { serviceType: 'repair', repairCategory: 'BRAKE PADS' },
  }[serviceType];
  const work = moved ?? (serviceType === 'repair' && repairCategory === 'ACCIDENT' ? { serviceType: 'accident' } : { serviceType, repairCategory: serviceType === 'repair' ? repairCategory : undefined });
  // Breaking down on the road goes with repairs only.
  return { ...work, isBreakdown: work.serviceType === 'repair' && Boolean(isBreakdown) };
};

/**
 * @param {string} folder  where client-data.json is
 * @param {{ password: string, staff: Array<{name: string, email: string, role: string}> }} options
 */
export default async function seedClient(folder, { password, staff }) {
  const data = JSON.parse(await readFile(join(folder, 'client-data.json'), 'utf8'));
  const now = new Date();
  const latest = new Date(now.getTime() - 5 * MINUTE); // nothing is dated in the future

  // --- People ---------------------------------------------------------------------------------
  const hashed = await bcrypt.hash(password, config.bcryptRounds);
  const accounts = [...staff, ...data.vendors.map((v) => ({ name: v.name, email: v.email, role: 'vendor', key: v.key }))];
  const users = {};
  for (const account of accounts) {
    const user = new User({ name: account.name, email: account.email, role: account.role, password: hashed });
    const signature = await SignatureImage.create({ user: user._id, image: signatureDataUrl(account.name) });
    user.signatureImage = signature._id;
    await user.save();
    users[account.key ?? account.role] = user;
  }
  const creator = users.serviceCreator;
  const supervisor = users.supervisor;
  const purchasing = users.purchaseManager;
  const vendorOf = (key) => {
    if (!users[key]) throw new Error(`Vendor "${key}" is used but not listed`);
    return users[key];
  };

  // --- Buses ----------------------------------------------------------------------------------
  const busDocs = data.buses.map((b) => {
    // A transmission interval or rate is no longer kept (2026-11-11).
    const { transmission: _interval, ...intervals } = b.intervals;
    const { transmission: _rate, ...rates } = b.rates ?? {};
    const doc = {
      _id: new ObjectId(),
      fleetNumber: b.fleetNumber,
      make: b.make,
      model: b.model,
      year: b.year,
      expectedLifeYears: b.expectedLifeYears,
      intervals: { ...intervals, battery: { everyMonths: intervals.battery.everyMonths, lastDate: uaeTime(intervals.battery.lastDate, '12:00') } },
      vendor: vendorOf(b.vendor)._id,
      createdAt: uaeTime(b.createdAt, '07:00'),
    };
    // A missing number is left out, never stored empty, so the unique sparse indexes ignore it.
    if (b.registrationNumber) Object.assign(doc, { registrationNumber: b.registrationNumber, registrationExpiry: uaeTime(b.registrationExpiry, '12:00') });
    if (b.chassisNumber) doc.chassisNumber = b.chassisNumber;
    if (b.labourRate) doc.labourRate = b.labourRate;
    if (Object.keys(rates).length) doc.rates = rates;
    return doc;
  });
  await Bus.insertMany(busDocs);
  const busOf = new Map(busDocs.map((b) => [b.fleetNumber, b]));

  // --- LPOs: each VSR is raised against a line of one, and its GRN takes it off -----------------
  // Repair and maintenance are one amount for one make (2026-11-09), held on the line (2026-11-10).
  // The records name no make, so it is the make most of the LPO's vendor's buses have, as the
  // migration does. Tyre and battery lines may give a size and a life in km; older ones have neither.
  const makesOf = (vendorId) => busDocs.filter((b) => b.vendor.equals(vendorId)).map((b) => b.make);
  const given = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== ''));
  const lpos = new Map(
    data.lpos.map((l) => {
      const vendor = vendorOf(l.vendor)._id;
      const { items: merged } = mergeRepairMaintenance(
        l.items.map(({ size, lifeKm, ...item }) => ({ ...item, ...given({ size, lifeKm }), _id: new ObjectId(), usedAmount: 0, usedQuantity: 0 }))
      );
      const make = merged.some((item) => item.kind === 'repairMaintenance') ? mostCommonMake(makesOf(vendor)) : undefined;
      const items = merged.map((item) => {
        const line = item.kind === 'repairMaintenance' && make ? { ...item, make } : item;
        return { ...line, name: lineName(line) };
      });
      return [
        l.number,
        {
          _id: new ObjectId(),
          number: l.number,
          date: new Date(`${l.validFrom}T00:00:00.000Z`),
          vendor,
          validFrom: new Date(`${l.validFrom}T00:00:00.000Z`),
          validTo: new Date(`${l.validTo}T00:00:00.000Z`),
          items,
          grandTotal: money(items.reduce((sum, item) => sum + item.total, 0)),
          usedAmount: 0,
          createdBy: purchasing._id,
          createdAt: new Date(`${l.validFrom}T06:00:00.000Z`),
        },
      ];
    })
  );

  /** The line of the LPO the records charged this VSR to: of its kind, for tyres the one at the job's unit price, else the first. */
  const lineFor = (vsr) => {
    const lpo = vsr.lpo && lpos.get(vsr.lpo);
    const lines = lpo ? lpo.items.filter((item) => item.kind === LINE_FOR_SERVICE[workOf(vsr).serviceType]) : [];
    if (!lines.length) return undefined;
    return { lpo, item: lines.find((line) => line.unitPrice === vsr.parts?.unitPrice) ?? lines[0] };
  };
  const lineAt = new Map([...lpos.values()].flatMap((lpo) => lpo.items.map((item) => [String(item._id), { lpo, item }])));

  /** What the GRN takes off for this VSR, worked out as the app does it: off its line, or with none, noLpo. */
  const deduct = (ticket, amount, at) => {
    const kind = LINE_FOR_SERVICE[ticket.serviceType];
    const quantity = COUNTED_BY_QUANTITY.includes(kind) ? unitsOf(ticket) : 0;
    const line = ticket.lpoLine && lineAt.get(String(ticket.lpoLine.item));
    if (!line) return kind === 'other' ? undefined : { status: 'noLpo', kind, quantity, amount, at };
    const { lpo, item } = line;
    item.usedAmount = money(item.usedAmount + amount);
    item.usedQuantity += quantity;
    lpo.usedAmount = money(lpo.usedAmount + amount);
    const overrun = item.usedAmount > item.total || (COUNTED_BY_QUANTITY.includes(kind) && item.usedQuantity > item.quantity);
    return { status: 'deducted', lpo: lpo._id, lpoNumber: lpo.number, item: item._id, kind, quantity, amount, overrun, at };
  };

  // --- Files --------------------------------------------------------------------------------------
  // Only the VSRs still in progress, and purchasing's documents, get a file, to keep the upload folder small.
  await mkdir(UPLOAD_DIR, { recursive: true });
  const files = [];
  const attach = (name, lines) => {
    const file = demoPdf(lines);
    const attachment = { _id: new ObjectId(), name, size: file.length, mimeType: 'application/pdf' };
    files.push([storedPath(attachment), file]);
    return attachment;
  };

  // --- VSRs ---------------------------------------------------------------------------------------
  const tickets = [];
  const invoices = [];
  const ticketOf = new Map();
  const stamp = (ticket, user, step, at) => ticket.signatures.push({ step, by: user._id, name: user.name, role: user.role, image: user.signatureImage, at });

  for (const vsr of data.vsrs) {
    const bus = busOf.get(vsr.bus);
    if (!bus) throw new Error(`${vsr.vsrNumber}: bus ${vsr.bus} is not in the bus list`);
    const vendor = vendorOf(vsr.vendor);
    const target = STAGES.indexOf(vsr.stage);
    if (target < 0) throw new Error(`${vsr.vsrNumber}: unknown stage ${vsr.stage}`);
    const reached = (stage) => (stage === 'invoiceRejected' ? vsr.stage === stage : target >= STAGES.indexOf(stage));
    const depot = vsr.location === 'depot';
    const active = vsr.stage !== 'completed';
    const raised = uaeTime(vsr.raisedOn, '07:30');
    const minutesIn = (minutes) => new Date(raised.getTime() + minutes * MINUTE);
    const sameDay = (clock) => uaeTime(vsr.raisedOn, clock);
    const backDay = (clock) => uaeTime(vsr.backOn ?? vsr.raisedOn, clock);
    // A job at the workshop that is not back yet finishes the day after it was raised.
    const doneDay = (clock) => (vsr.backOn ? backDay(clock) : addDays(sameDay(clock), 1));

    const work = workOf(vsr);
    const ticket = {
      _id: new ObjectId(),
      vsrNumber: vsr.vsrNumber,
      busId: bus._id,
      serviceType: work.serviceType,
      repairCategory: work.repairCategory ?? undefined,
      description: vsr.description,
      location: vsr.location,
      accident: vsr.accident && work.serviceType === 'accident' ? { ...vsr.accident, updatedBy: creator._id, updatedAt: raised } : undefined,
      currentReading: vsr.kmOut ?? undefined,
      isBreakdown: work.isBreakdown,
      intervalUsage: vsr.intervalUsage ?? undefined,
      vendorId: vendor._id,
      createdBy: creator._id,
      negotiation: [],
      history: [],
      signatures: [],
      vehicle: {},
      createdAt: raised,
    };
    if (vsr.agreedPrice) ticket.agreedPrice = vsr.agreedPrice;
    // The LPO it comes off, chosen as the creator does now; open VSRs are booked against it.
    const line = lineFor(vsr);
    if (line) ticket.lpoLine = lpoLineOf(line);
    if (COUNTED_BY_QUANTITY.includes(work.serviceType) && vsr.parts?.quantity) ticket.quantity = vsr.parts.quantity;

    // Each step with the time it is wanted; later the times are pulled back so none is in the future.
    const plan = [];
    const step = (status, by, at, extra = {}) => plan.push({ status, by, at, ...extra });
    const first = vsr.agreedPrice ? 'pending' : 'sentToVendor';
    step(first, creator, raised, { note: 'VSR created', sign: vsr.agreedPrice && 'escalated' });

    if (!vsr.agreedPrice && reached('estimateSubmitted')) {
      // The vendor's estimates; a lower last one after the depot replied is a negotiated price.
      vsr.estimates.forEach((estimate, i) => {
        if (i > 0) step('estimateCountered', creator, minutesIn(20 + i * 10), { note: 'Reply sent to the vendor', counter: vsr.estimates.at(-1).amount });
        step('estimateSubmitted', vendor, minutesIn(25 + i * 10), { note: `Estimate ${i + 1}`, estimate: { ...estimate, number: i + 1 } });
      });
    }
    if (!vsr.agreedPrice && reached('pending') && vsr.estimates.length) step('pending', creator, sameDay('09:00'), { note: 'Sent to the supervisor for approval', sign: 'escalated', breakdown: true });
    if (reached('approved')) step('approved', supervisor, sameDay('09:30'), { sign: 'approved', approve: true });
    if (reached('acknowledged')) step('acknowledged', vendor, sameDay('10:00'), { sign: 'acknowledged' });
    if (depot) {
      if (reached('workInProgress')) step('workInProgress', vendor, sameDay('10:30'), { km: vsr.kmOut, field: ['workStartedAt', 'receivedAt'], receivedKm: vsr.kmOut });
    } else {
      if (reached('vehicleSent')) step('vehicleSent', creator, sameDay('10:30'), { field: ['sentAt'] });
      if (reached('vehicleReceived')) step('vehicleReceived', vendor, sameDay('11:30'), { km: vsr.kmOut, field: ['receivedAt'], receivedKm: vsr.kmOut });
      if (reached('workInProgress')) step('workInProgress', vendor, sameDay('12:00'), { field: ['workStartedAt'] });
    }
    if (reached('readyForDelivery')) step('readyForDelivery', vendor, doneDay('14:00'), { field: ['readyAt'] });
    if (reached('vehicleReleased') && !depot) step('vehicleReleased', vendor, doneDay('14:30'), { field: ['releasedAt'], sign: 'vehicleReleased' });
    if (reached('vehicleReturned')) step('vehicleReturned', creator, backDay('15:00'), { km: vsr.kmIn ?? vsr.kmOut, field: ['returnedAt'], returnedKm: vsr.kmIn ?? vsr.kmOut });
    if (reached('vehicleReturned') && vsr.noChargeReason) step('completed', creator, backDay('15:00'), { note: 'No charge', effective: true });
    if (!vsr.noChargeReason) {
      const billed = addDays(backDay('10:00'), 2);
      if (reached('invoiceSubmitted')) step('invoiceSubmitted', vendor, billed, { invoice: 'submit' });
      if (reached('invoiceRejected')) step('invoiceRejected', supervisor, addDays(billed, 1), { invoice: 'reject' });
      if (reached('invoiceAccepted')) step('invoiceAccepted', supervisor, addDays(billed, 1), { invoice: 'accept', sign: 'invoiceAccepted' });
      if (reached('invoiceReceived')) step('invoiceReceived', creator, addDays(billed, 2), { effective: true, dateField: 'invoiceReceivedAt' });
      if (reached('forwardedToPurchase')) step('forwardedToPurchase', creator, addDays(billed, 2), { effective: true, dateField: 'forwardedAt' });
    }

    // Pull back anything that would land after now, keeping the order.
    let limit = latest;
    for (let i = plan.length - 1; i >= 0; i -= 1) {
      if (plan[i].at > limit) plan[i].at = limit;
      limit = new Date(plan[i].at.getTime() - MINUTE);
    }
    ticket.createdAt = plan[0].at;

    let invoice;
    for (const entry of plan) {
      const { status, by, at } = entry;
      if (entry.estimate) {
        const { amount, noChargeReason, number } = entry.estimate;
        const quotationNumber = `Q-${vsr.vsrNumber.replace(/^VSR-/, '')}-${number}`;
        ticket.negotiation.push({
          from: 'vendor', by: vendor._id, amount, quotationNumber, daysToComplete: vsr.daysToComplete, estimateNumber: number, noChargeReason,
          note: noChargeReason ? 'No charge for this work.' : 'Estimate for the work as described.', at,
          attachments: active ? [attach(`Quotation ${quotationNumber}.pdf`, [`Quotation ${quotationNumber}`, `Vendor: ${vendor.name}`, `Bus: ${vsr.bus}`, `Amount: AED ${amount}`])] : [],
        });
        ticket.daysToComplete = vsr.daysToComplete;
      }
      if (entry.counter !== undefined) ticket.negotiation.push({ from: 'creator', by: creator._id, amount: entry.counter, note: 'Please come down to this amount.', at });
      if (entry.breakdown) {
        if (vsr.parts) {
          const total = money(vsr.parts.quantity * vsr.parts.unitPrice);
          const estimateAmount = vsr.estimates.at(-1).amount;
          ticket.breakdown = {
            parts: [{ name: vsr.parts.name, quantity: vsr.parts.quantity, unitPrice: vsr.parts.unitPrice, total }],
            partsTotal: total, labourHours: 0, labourTotal: 0, consumables: 0, quotationTotal: total, estimateAmount, discount: money(total - estimateAmount), unitsFitted: vsr.parts.quantity,
          };
        } else if (vsr.quotationValue) {
          // What the work was worth, though it cost the depot nothing.
          const value = vsr.quotationValue;
          ticket.breakdown = { parts: [{ name: 'Work as quoted', quantity: 1, unitPrice: value, total: value }], partsTotal: value, labourHours: 0, labourTotal: 0, consumables: 0, quotationTotal: value, estimateAmount: 0, discount: value, remarks: 'The vendor quoted this value; the job was done at no charge.' };
        }
      }
      if (entry.approve) {
        ticket.approvedEstimate = vsr.approvedAmount ?? undefined;
        ticket.noChargeReason = vsr.noChargeReason ?? undefined;
        ticket.initialApprovedBy = supervisor._id;
      }
      if (status === 'acknowledged') {
        ticket.acknowledgedBy = vendor._id;
        ticket.daysToComplete = ticket.daysToComplete ?? vsr.daysToComplete;
      }
      if (entry.invoice === 'submit') {
        const number = `INV-${vsr.vsrNumber.replace(/^VSR-/, '')}`;
        // A rejected invoice is the vendor billing above the approved price.
        const amount = vsr.stage === 'invoiceRejected' ? money((vsr.approvedAmount ?? vsr.invoiceAmount) * 1.1) : vsr.invoiceAmount;
        invoice = {
          _id: new ObjectId(), ticketId: ticket._id, vendorId: vendor._id, invoiceNumber: number, amount, status: 'invoicePending', submittedAt: at, createdAt: at,
          description: `Work completed on bus ${vsr.bus}, ${vsr.description}`.slice(0, 1000),
          attachments: active ? [attach(`Invoice ${number}.pdf`, [`Invoice ${number}`, `Vendor: ${vendor.name}`, `Bus: ${vsr.bus}`, `Amount: AED ${amount}`])] : [],
        };
        invoices.push(invoice);
        ticket.invoice = invoice._id;
      }
      if (entry.invoice === 'reject') Object.assign(invoice, { status: 'rejected', rejectedAt: at, rejectedBy: supervisor._id, rejectionReason: 'The invoice is above the approved amount. Please send it for the approved amount.' });
      if (entry.invoice === 'accept') {
        Object.assign(invoice, { status: 'approved', approvedAt: at, approvedBy: supervisor._id });
        ticket.invoiceApprovedBy = supervisor._id;
      }
      if (status === 'invoiceRejected') ticket.invoiceRejectedBy = supervisor._id;
      if (entry.sign) stamp(ticket, by, entry.sign, at);
      for (const field of entry.field ?? []) ticket.vehicle[field] = at;
      if (entry.receivedKm !== undefined) ticket.vehicle.receivedKm = entry.receivedKm;
      if (entry.returnedKm !== undefined) {
        ticket.vehicle.returnedKm = entry.returnedKm;
        ticket.vehicle.replacedPartsReceived = true;
      }
      if (DATE_FIELD[status]) ticket[DATE_FIELD[status]] = at;
      if (entry.dateField) ticket[entry.dateField] = at;
      // Steps that carry a date the person gave keep it, as the app does for the trip and the paperwork.
      const effectiveAt = entry.field || entry.effective ? at : undefined;
      ticket.history.push({ status, at, effectiveAt, km: entry.km, by: by._id, note: entry.note });
      ticket.status = status;
      ticket.statusUpdated = at;
    }
    tickets.push(ticket);
    ticketOf.set(vsr.vsrNumber, { ticket, vsr, vendor });
  }

  // --- GRNs and purchase invoices: one per vendor per month the buses came back ------------------
  const batches = new Map();
  for (const { ticket, vsr, vendor } of ticketOf.values()) {
    if (!['grnCreated', 'completed'].includes(vsr.stage) || vsr.noChargeReason) continue;
    const key = `${vendor._id}|${vsr.backOn.slice(0, 7)}|${vsr.stage}`;
    if (!batches.has(key)) batches.set(key, { vendor, month: vsr.backOn.slice(0, 7), withInvoice: vsr.stage === 'completed', members: [] });
    batches.get(key).members.push(ticket);
  }
  const grns = [];
  const purchaseInvoices = [];
  const ordered = [...batches.values()]
    .map((batch) => {
      const [year, month] = batch.month.split('-').map(Number);
      const nextMonth = uaeTime(`${month === 12 ? year + 1 : year}-${String((month % 12) + 1).padStart(2, '0')}-03`, '10:00');
      const forwarded = Math.max(...batch.members.map((t) => t.forwardedAt.getTime()));
      let grnAt = new Date(Math.max(nextMonth.getTime(), forwarded + 60 * MINUTE));
      if (grnAt > latest) grnAt = new Date(latest.getTime() - 60 * MINUTE);
      let piAt = addDays(grnAt, 2);
      if (piAt > latest) piAt = new Date(Math.max(latest.getTime() - 30 * MINUTE, grnAt.getTime() + MINUTE));
      return { ...batch, grnAt, piAt };
    })
    .sort((a, b) => a.grnAt - b.grnAt || String(a.vendor.name).localeCompare(b.vendor.name));
  const serial = {};
  const nextNumber = (prefix, at) => {
    const year = at.getUTCFullYear();
    serial[`${prefix}${year}`] = (serial[`${prefix}${year}`] ?? 0) + 1;
    return `${prefix}-${year}-${String(serial[`${prefix}${year}`]).padStart(3, '0')}`;
  };
  const invoiceOf = new Map(invoices.map((inv) => [String(inv._id), inv]));
  for (const batch of ordered) {
    const total = money(batch.members.reduce((sum, t) => sum + invoiceOf.get(String(t.invoice)).amount, 0));
    const grnNumber = nextNumber('GRN', batch.grnAt);
    const grn = {
      _id: new ObjectId(), number: grnNumber, date: batch.grnAt, vendor: batch.vendor._id, tickets: batch.members.map((t) => t._id), total, createdBy: purchasing._id, createdAt: batch.grnAt,
      attachments: [attach(`${grnNumber}.pdf`, [`Goods Receiving Note ${grnNumber}`, `Vendor: ${batch.vendor.name}`, `Covers: ${batch.members.length} VSRs`, `Total: AED ${total}`])],
    };
    grns.push(grn);
    for (const ticket of batch.members) {
      ticket.grn = grn._id;
      ticket.lpoDeduction = deduct(ticket, invoiceOf.get(String(ticket.invoice)).amount, batch.grnAt);
      stamp(ticket, purchasing, 'grn', batch.grnAt);
      ticket.history.push({ status: 'grnCreated', at: batch.grnAt, effectiveAt: batch.grnAt, by: purchasing._id, note: `GRN ${grnNumber}` });
      Object.assign(ticket, { status: 'grnCreated', statusUpdated: batch.grnAt });
    }
    if (!batch.withInvoice) continue;
    const piNumber = nextNumber('PI', batch.piAt);
    const pi = {
      _id: new ObjectId(), number: piNumber, date: batch.piAt, grn: grn._id, vendor: batch.vendor._id, tickets: grn.tickets, amount: total, createdBy: purchasing._id, createdAt: batch.piAt,
      attachments: [attach(`${piNumber}.pdf`, [`Purchase Invoice ${piNumber}`, `GRN: ${grnNumber}`, `Amount: AED ${total}`])],
    };
    purchaseInvoices.push(pi);
    grn.purchaseInvoice = pi._id;
    for (const ticket of batch.members) {
      ticket.purchaseInvoice = pi._id;
      stamp(ticket, purchasing, 'purchaseInvoice', batch.piAt);
      ticket.history.push({ status: 'completed', at: batch.piAt, effectiveAt: batch.piAt, by: purchasing._id, note: `Purchase invoice ${piNumber}` });
      Object.assign(ticket, { status: 'completed', statusUpdated: batch.piAt, completedAt: batch.piAt });
    }
  }

  // --- Open VSRs the records charge to no LPO yet ------------------------------------------------
  // They are booked on the line their GRN would take them off now, as the migration books them: their
  // vendor's line valid today for the bus's make and the kind, with room, oldest VSR first. An accident
  // is raised against no line (2026-11-11), so its GRN chooses one, as the app does.
  const inDate = [...lpos.values()].filter((lpo) => isInDate(lpo, uaeDay()));
  const unbooked = tickets
    .filter((t) => t.serviceType !== 'accident' && !t.lpoLine && !t.lpoDeduction && !t.grn && !CLOSED_STATUSES.includes(t.status))
    .sort((a, b) => a.createdAt - b.createdAt || a.vsrNumber.localeCompare(b.vsrNumber));
  const busById = new Map(busDocs.map((b) => [String(b._id), b]));
  for (const { ticket, ...line } of linesForOpen(unbooked, { lpos: inDate, makeOf: (t) => busById.get(String(t.busId)).make, room: roomOn(inDate, tickets) })) {
    ticket.lpoLine = lpoLineOf(line);
  }

  // --- Save -----------------------------------------------------------------------------------------
  for (const [path, file] of files) await writeFile(path, file);
  await Lpo.insertMany([...lpos.values()]);
  for (let i = 0; i < tickets.length; i += 500) await Ticket.insertMany(tickets.slice(i, i + 500));
  await Invoice.insertMany(invoices);
  await Grn.insertMany(grns);
  await PurchaseInvoice.insertMany(purchaseInvoices);

  const readings = Object.entries(data.readings).flatMap(([fleetNumber, days]) => {
    const bus = busOf.get(fleetNumber);
    if (!bus) throw new Error(`Readings for bus ${fleetNumber}, which is not in the bus list`);
    return days.map(([date, km]) => ({ bus: bus._id, date, km, by: creator._id }));
  });
  for (let i = 0; i < readings.length; i += 5000) await BusDailyReading.insertMany(readings.slice(i, i + 5000));
  await BusStatusChange.insertMany(
    data.statusChanges.map((change) => ({
      bus: busOf.get(change.bus)._id,
      date: change.date,
      status: change.status,
      source: change.source,
      ticket: change.vsr ? ticketOf.get(change.vsr).ticket._id : undefined,
      by: creator._id,
    }))
  );
  // The records mark Scrapping and Removed on the status sheet, so each bus's lifecycle is read from it.
  const lifecycles = await busLifecycleChanges();
  await applyBusLifecycleChanges(lifecycles);
  // New VSRs carry on from the depot's own numbering.
  await Counter.findByIdAndUpdate('vsr', { seq: data.meta.lastVsrNumber }, { upsert: true });

  const byStage = tickets.reduce((counts, t) => ({ ...counts, [t.status]: (counts[t.status] ?? 0) + 1 }), {});
  console.log('\nClient data loaded from %s', folder);
  console.log(`  Vendors: ${data.vendors.length}, buses: ${busDocs.length}, km readings: ${readings.length}, status changes: ${data.statusChanges.length}`);
  const leaving = (to) => lifecycles.filter((change) => change.to === to).length;
  console.log(`  Buses scrapped: ${leaving('scrapped')}, sold: ${leaving('sold')}, in operation: ${busDocs.length - leaving('scrapped') - leaving('sold')}`);
  console.log(`  VSRs: ${tickets.length}, invoices: ${invoices.length}, GRNs: ${grns.length}, purchase invoices: ${purchaseInvoices.length}, LPOs: ${lpos.size}`);
  console.log(`  VSRs by status: ${Object.entries(byStage).map(([s, n]) => `${s} ${n}`).join(', ')}`);
  const overruns = tickets.filter((t) => t.lpoDeduction?.overrun || t.lpoDeduction?.status === 'noLpo').length;
  if (overruns) console.log(`  GRN deductions over or without an LPO: ${overruns}`);
  const booked = tickets.filter((t) => t.lpoLine && !t.lpoDeduction && !['completed', 'declined'].includes(t.status)).length;
  console.log(`  Open VSRs booked on an LPO line: ${booked}`);
  console.log('\nLogins (password: %s):', password);
  accounts.forEach((a) => console.log(`  ${a.role.padEnd(16)} ${a.email}${a.role === 'vendor' ? `  (${a.name})` : ''}`));
}
