/**
 * Seeds a development database with one account per role, two vendors, a small fleet, LPOs,
 * and VSRs at every stage of the lifecycle so each dashboard and report has data. One bus has
 * been scrapped and sold, and one waits on a scrap request.
 *
 *   npm run seed          # adds demo data if the demo accounts do not exist yet
 *   npm run seed:reset    # wipes everything first
 *   node scripts/seed.js --reset --client <folder>   # a depot's own records instead (scripts/clientSeed.js)
 *
 * All demo accounts share the password in SEED_PASSWORD (default: Password123!).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import config from '../config/config.js';
import connectDB from '../config/db.js';
import User, { SignatureImage } from '../models/User.js';
import Bus from '../models/Bus.js';
import Ticket from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import Counter, { nextVsrNumber } from '../models/Counter.js';
import Notification from '../models/Notification.js';
import ScrapRequest from '../models/ScrapRequest.js';
import { Grn, Lpo, PurchaseInvoice, lineName } from '../models/Purchase.js';
import { BusDailyReading, BusStatusChange } from '../models/BusDaily.js';
import { applyTicketToBusDay } from '../utils/busDay.js';
import { notifyRoles } from '../utils/notifications.js';
import { intervalServiceOf, usageWhenRaised } from '../utils/intervals.js';
import { outsideVendorNamed } from '../utils/outsideVendors.js';
import { COUNTED_BY_QUANTITY, LINE_FOR_SERVICE, candidateLines, deductAtGrn, lpoLineOf } from '../utils/lpoDeduction.js';
import { stamp } from '../utils/signatures.js';
import { uaeDay } from '../utils/uaeTime.js';
import { UPLOAD_DIR, storedPath } from '../utils/uploads.js';
import { demoPdf, signatureDataUrl } from './demoFiles.js';
import seedClient from './clientSeed.js';

const PASSWORD = process.env.SEED_PASSWORD || 'Password123!';
const reset = process.argv.includes('--reset');
// --client <folder>: load a depot's own records from that folder instead of the made-up demo (see clientSeed.js).
const clientAt = process.argv.indexOf('--client');
const clientFolder = clientAt === -1 ? undefined : process.argv[clientAt + 1];

const ACCOUNTS = [
  { name: 'Sara Ahmed', email: 'creator@muraqaba.dev', role: 'serviceCreator' },
  { name: 'Omar Farooq', email: 'supervisor@muraqaba.dev', role: 'supervisor' },
  { name: 'Hina Raza', email: 'purchasing@muraqaba.dev', role: 'purchaseManager' },
  { name: 'Al Noor Motors', email: 'vendor@muraqaba.dev', role: 'vendor' },
  { name: 'Metro Fleet Services', email: 'vendor2@muraqaba.dev', role: 'vendor' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);
const daysAhead = (n) => new Date(Date.now() + n * DAY_MS);
const money = (value) => Math.round(value * 100) / 100;

// Every step a VSR goes through, in order. Oil with a rate starts at pending.
const ORDER = [
  'sentToVendor',
  'estimateSubmitted',
  'estimateCountered',
  'pending',
  'approved',
  'acknowledged',
  'vehicleSent',
  'vehicleReceived',
  'workInProgress',
  'readyForDelivery',
  'vehicleReleased',
  'vehicleReturned',
  'invoiceSubmitted',
  'invoiceRejected',
  'resubmitted',
  'invoiceAccepted',
  'invoiceReceived',
  'forwardedToPurchase',
];

async function main() {
  if (config.isProduction && !process.env.SEED_ALLOW_PRODUCTION) {
    throw new Error('Refusing to seed a production database. Set SEED_ALLOW_PRODUCTION=1 to override.');
  }
  await connectDB({ maxAttempts: 3 });
  // Clearing keeps the indexes, and older databases have unique ones that a missing chassis or registration number would clash on.
  await Bus.syncIndexes();

  if (reset) {
    await Promise.all([User, SignatureImage, Bus, Ticket, Invoice, Counter, Notification, Grn, PurchaseInvoice, Lpo, BusDailyReading, BusStatusChange, ScrapRequest].map((M) => M.deleteMany({})));
    console.log('Cleared existing data');
  } else if (await User.exists({ email: ACCOUNTS[0].email })) {
    console.log('Demo accounts already exist. Run with --reset to recreate everything.');
    await mongoose.connection.close();
    return;
  }

  if (clientAt !== -1) {
    if (!clientFolder || clientFolder.startsWith('--')) throw new Error('Give the folder after --client, for example --client ../client-data');
    // The same staff accounts as the demo; the vendors come from the client's records.
    await seedClient(clientFolder, { password: PASSWORD, staff: ACCOUNTS.filter((account) => account.role !== 'vendor') });
    await mongoose.connection.close();
    return;
  }

  const hashed = await bcrypt.hash(PASSWORD, config.bcryptRounds);
  const users = {};
  for (const account of ACCOUNTS) {
    const user = await User.create({ ...account, password: hashed });
    const signature = await SignatureImage.create({ user: user._id, image: signatureDataUrl(account.name) });
    user.signatureImage = signature._id;
    await user.save();
    users[account.email] = user;
  }
  const creator = users['creator@muraqaba.dev'];
  const supervisor = users['supervisor@muraqaba.dev'];
  const purchasing = users['purchasing@muraqaba.dev'];
  const vendor1 = users['vendor@muraqaba.dev'];
  const vendor2 = users['vendor2@muraqaba.dev'];
  const vendorOf = (bus) => (String(bus.vendor) === String(vendor1._id) ? vendor1 : vendor2);

  await mkdir(UPLOAD_DIR, { recursive: true });
  const attach = async (name, lines) => {
    const file = demoPdf(lines);
    const attachment = { _id: new mongoose.Types.ObjectId(), name, size: file.length, mimeType: 'application/pdf' };
    await writeFile(storedPath(attachment), file);
    return attachment;
  };

  // Brake pads every 40,000 km, as on the depot's sheet: BUS-102 is due soon and BUS-103 overdue.
  const intervals = (oil, tyre, batteryMonthsAgo, brakePads) => ({
    oil: { everyKm: 10000, lastKm: oil },
    tyre: { everyKm: 40000, lastKm: tyre },
    brakePads: { everyKm: 40000, lastKm: brakePads },
    battery: { everyMonths: 18, lastDate: daysAgo(batteryMonthsAgo * 30.5) },
  });
  // A missing chassis or registration number is left out; a bus not registered yet has no expiry either.
  const makeBus = (fleetNumber, chassisNumber, registrationNumber, make, model, year, expiryDays, life, labourRate, rates, chosenIntervals, vendor, extra = {}) => ({
    fleetNumber, chassisNumber, registrationNumber, make, model, year, registrationExpiry: registrationNumber ? daysAhead(expiryDays) : undefined, expectedLifeYears: life, labourRate, rates, intervals: chosenIntervals, vendor: vendor._id, ...extra,
  });
  const buses = await Bus.create([
    makeBus('BUS-101', 'CH-101-AX', 'DXB-1011', 'Hino', 'Coach', 2019, 400, 15, 70, { oil: 0.12 }, intervals(77000, 46000, 17, 50000), vendor1),
    makeBus('BUS-102', 'CH-102-BX', 'DXB-1022', 'Yutong', 'City bus', 2021, 200, 12, 65, { oil: 0.1 }, intervals(40000, 20000, 6, 12800), vendor1),
    makeBus('BUS-103', 'CH-103-CX', 'DXB-1033', 'Isuzu', 'Mini bus', 2018, 20, 12, 60, { oil: 0.09 }, intervals(90000, 60000, 12, 56000), vendor2),
    makeBus('BUS-104', 'CH-104-DX', 'DXB-1044', 'Hino', 'City bus', 2022, 600, 15, 70, { oil: 0.12 }, intervals(0, 0, 3, 0), vendor2),
    // An old bus the depot's records hold no chassis number for.
    makeBus('BUS-105', undefined, 'DXB-1055', 'Yutong', 'Coach', 2012, 90, 15, 65, { oil: 0.1 }, intervals(235000, 210000, 2, 205000), vendor2),
    // A new bus that arrived three weeks ago and runs on a temporary plate until it is registered.
    makeBus('BUS-106', 'CH-106-FX', undefined, 'Yutong', 'City bus', 2026, undefined, 15, 65, { oil: 0.1 }, intervals(0, 0, 1, 0), vendor1, { createdAt: daysAgo(21) }),
    // Past its service life; the creator has asked for it to be scrapped (below).
    makeBus('BUS-107', 'CH-107-GX', 'DXB-1077', 'Isuzu', 'Mini bus', 2010, 150, 15, 60, { oil: 0.09 }, intervals(404000, 395000, 10, 390000), vendor1),
  ]);
  const [bus101, bus102, bus103, bus104, bus105, bus106, bus107] = buses;

  // Repair and maintenance, one amount per make on its own line, as on the depot's e-LPO; tyres by
  // size with their life in km, and batteries by type, for every make (2026-11-10). Each VSR below
  // is raised against a line and booked on it until its GRN. LPO-2026-002 has one tyre left once
  // the open depot tyre job is counted, so a VSR for two tyres off it is refused.
  const day = (text) => new Date(`${text}T00:00:00.000Z`);
  const THIS_YEAR = { date: day('2026-01-01'), validFrom: day('2026-01-01'), validTo: day('2026-12-31') };
  const repairLine = (make, amount) => ({ kind: 'repairMaintenance', make, name: lineName({ kind: 'repairMaintenance', make }), description: `Repairs, accidents and oil services for ${make} buses`, quantity: 1, unitPrice: amount, total: amount });
  const tyreLine = (size, quantity, unitPrice, lifeKm, description) => ({ kind: 'tyre', size, lifeKm, name: lineName({ kind: 'tyre', size }), description, quantity, unitPrice, total: money(quantity * unitPrice) });
  const batteryLine = (size, quantity, unitPrice) => ({ kind: 'battery', size, name: lineName({ kind: 'battery', size }), quantity, unitPrice, total: money(quantity * unitPrice) });
  const lpoOf = (number, vendor, items, dates = THIS_YEAR) => ({ number, vendor: vendor._id, ...dates, items, grandTotal: money(items.reduce((sum, item) => sum + item.total, 0)), createdBy: purchasing._id });
  await Lpo.create([
    lpoOf('LPO-2026-001', vendor1, [tyreLine('295/80 R22.5', 40, 850, 100000, 'Rear and front axle'), batteryLine('12V 200Ah', 20, 620)]),
    lpoOf('LPO-2026-002', vendor2, [tyreLine('225/75 R17.5', 4, 2200, 80000)]),
    lpoOf('LPO-2026-003', vendor1, [repairLine('Hino', 150000)]),
    lpoOf('LPO-2026-004', vendor1, [repairLine('Yutong', 40000)]),
    lpoOf('LPO-2026-005', vendor2, [repairLine('Isuzu', 60000)]),
    lpoOf('LPO-2026-006', vendor2, [repairLine('Hino', 25000)]),
    lpoOf('LPO-2025-014', vendor1, [tyreLine('295/80 R22.5', 30, 850, 100000, 'Last year')], { date: day('2025-01-01'), validFrom: day('2025-01-01'), validTo: day('2025-12-31') }),
  ]);

  // Odometers that climb by a steady amount each day, so VSRs and the daily sheet agree.
  const TODAY_KM = new Map([[bus101, 86500], [bus102, 52400], [bus103, 98200], [bus104, 9100], [bus105, 241000], [bus106, 3150], [bus107, 412000]]);
  const DAILY_KM = new Map([[bus101, 240], [bus102, 210], [bus103, 260], [bus104, 120], [bus105, 90], [bus106, 150], [bus107, 110]]);
  const readingAgo = (bus, n) => TODAY_KM.get(bus) - DAILY_KM.get(bus) * n;

  /** What the service creator types from the vendor's quotation, adding up a little above the estimate. */
  const breakdownFor = (bus, estimate, parts) => {
    const labourHours = parts ? 0 : 4;
    const labourTotal = labourHours * bus.labourRate;
    const consumables = parts ? 0 : 50;
    const target = money(estimate * 1.05);
    const lines = parts ?? [{ name: 'Parts as quoted', description: 'See the quotation', code: 'GEN', partNumber: 'QUOTE', quantity: 1, unitPrice: money(Math.max(target - labourTotal - consumables, 0)) }];
    const withTotals = lines.map((line) => ({ ...line, total: money(line.quantity * line.unitPrice) }));
    const partsTotal = money(withTotals.reduce((sum, line) => sum + line.total, 0));
    const quotationTotal = money(partsTotal + labourTotal + consumables);
    return {
      parts: withTotals, partsTotal, labourHours, labourRate: bus.labourRate, labourTotal, consumables, quotationTotal,
      estimateAmount: estimate, discount: money(quotationTotal - estimate), remarks: 'Checked against the quotation.',
    };
  };

  /** Create a VSR and replay its lifecycle up to `stage`, with dates spread back from today. */
  // A depot job skips the trip; a job at no charge is quoted at AED 0 and closes when the bus is back.
  // An accident may go to a vendor outside the list (`outside`), whose steps the creator records (2026-11-11).
  const makeTicket = async ({ bus, serviceType, repairCategory, description, stage, createdDaysAgo, amount = 1500, parts, isBreakdown = false, parent, location = 'vendorWorkshop', noChargeReason, accident, outside }) => {
    // The LPO line it comes off, as the creator would choose: the bus's own vendor's first. An
    // additional job takes its parent's line when that is for the same kind of work.
    const line = parent ? undefined : (await candidateLines({ bus, serviceType }))[0];
    const inherited = parent?.lpoLine?.kind === LINE_FOR_SERVICE[serviceType] ? parent.lpoLine.toObject() : undefined;
    const lpoLine = line ? lpoLineOf(line) : inherited;
    const quantity = COUNTED_BY_QUANTITY.includes(serviceType) && parts ? parts.reduce((sum, part) => sum + part.quantity, 0) : undefined;
    const vendor = line ? [vendor1, vendor2].find((v) => v._id.equals(line.lpo.vendor._id)) : (outside ?? vendorOf(bus));
    // The service creator stands in for a vendor outside the list, who cannot sign in.
    const actingVendor = outside ? creator : vendor;
    const created = daysAgo(createdDaysAgo);
    const currentReading = readingAgo(bus, createdDaysAgo);
    const rate = !parent && bus.rates?.[serviceType];
    const depot = location === 'depot';
    const ticket = new Ticket({
      vsrNumber: parent ? `${parent.vsrNumber}${String.fromCharCode(97 + (parent.additionalCount += 1))}` : await nextVsrNumber(),
      parentTicket: parent?._id,
      busId: bus._id,
      serviceType,
      repairCategory,
      description,
      location,
      accident: accident && { ...accident, updatedBy: creator._id, updatedAt: created },
      currentReading,
      isBreakdown,
      intervalUsage: usageWhenRaised(bus, intervalServiceOf({ serviceType, repairCategory }), currentReading, created),
      vendorId: vendor._id,
      lpoLine,
      quantity,
      createdBy: parent ? vendor._id : creator._id,
      createdAt: created,
    });
    let t = createdDaysAgo;
    const when = () => daysAgo(Math.max(t, 0));
    const step = (status, by, note, extras = {}) => {
      t = Math.max(t - 1, 0);
      ticket.transition(status, by._id, note, extras);
      const at = when();
      ticket.history[ticket.history.length - 1].at = at;
      // The status's own date field, which the dashboards show, has to agree with the history.
      const field = { approved: 'approvedAt', acknowledged: 'acknowledgedAt', invoiceSubmitted: 'invoiceSubmittedAt', invoiceRejected: 'invoiceRejectedAt', invoiceAccepted: 'invoiceAcceptedAt', completed: 'completedAt' }[status];
      if (field) ticket[field] = at;
    };
    const sign = (user, name) => stamp(ticket, user, name, when());

    let estimate = noChargeReason ? 0 : amount;
    if (rate) {
      const km = bus.intervals[serviceType].everyKm;
      estimate = money(rate * km);
      ticket.agreedPrice = { basis: 'rate', rate, km, amount: estimate };
    } else if (line && quantity) {
      // Tyres and batteries off a line: so many at the LPO's price, straight to the supervisor.
      estimate = money(quantity * line.item.unitPrice);
      ticket.agreedPrice = { basis: 'lpo', unitPrice: line.item.unitPrice, quantity, amount: estimate };
    } else if (line) {
      ticket.estimatedAmount = amount; // what the creator expects it to cost, booked until approval
    }
    const priced = Boolean(ticket.agreedPrice);
    const first = priced ? 'pending' : parent ? 'estimateSubmitted' : 'sentToVendor';
    ticket.status = first;
    ticket.history.push({ status: first, by: parent ? vendor._id : creator._id, note: parent ? 'Additional job raised by the vendor' : 'VSR created', at: created });
    if (priced) stamp(ticket, creator, 'escalated', created);

    const estimateRound = async (number, roundAmount, note) => {
      const file = await attach(`Quotation ${ticket.vsrNumber} ${number}.pdf`, [`Quotation Q-${ticket.vsrNumber}-${number}`, `Vendor: ${vendor.name}`, `Bus: ${bus.fleetNumber}`, `Amount: AED ${roundAmount}`, note]);
      ticket.negotiation.push({ from: 'vendor', by: actingVendor._id, amount: roundAmount, quotationNumber: `Q-${ticket.vsrNumber}-${number}`, daysToComplete: 2 + number, estimateNumber: number, noChargeReason, note, attachments: [file], at: when() });
      ticket.daysToComplete = 2 + number;
    };

    const target = stage === 'returned' ? ORDER.indexOf('pending') : ORDER.indexOf(stage);
    const reached = (name) => target >= ORDER.indexOf(name);

    if (parent) {
      await estimateRound(1, estimate, 'Found during the work. Needs doing before the bus goes back.');
    } else if (reached('estimateSubmitted') && !priced) {
      await estimateRound(1, noChargeReason ? 0 : Math.round(estimate * 1.15), noChargeReason ? 'No charge for this work.' : 'Parts and labour for the job as described.');
      step('estimateSubmitted', actingVendor, 'Estimate 1');
    }
    // There is nothing to bargain over on a job at no charge.
    if (reached('estimateCountered') && !priced && !parent && !noChargeReason) {
      ticket.negotiation.push({ from: 'creator', by: creator._id, amount: estimate, note: 'Please come down to this amount; we have similar jobs at this price.', at: when() });
      step('estimateCountered', creator, 'Reply sent to the vendor');
    }
    if (reached('pending') && !priced) {
      if (!parent && !noChargeReason) {
        await estimateRound(2, estimate, 'Agreed at this amount.');
        step('estimateSubmitted', actingVendor, 'Estimate 2');
      }
      ticket.breakdown = breakdownFor(bus, estimate, parts);
      sign(creator, 'escalated');
      step('pending', creator, 'Sent to the supervisor for approval');
    }
    if (stage === 'returned') {
      ticket.returnReason = 'The reading looks low for this bus. Please check the odometer and send it again.';
      step('returned', supervisor, ticket.returnReason);
    }
    if (reached('approved')) {
      ticket.approvedEstimate = estimate;
      ticket.noChargeReason = noChargeReason;
      sign(supervisor, 'approved');
      step('approved', supervisor);
      if (parent) {
        ticket.vehicle.receivedAt = parent.vehicle.receivedAt;
        ticket.vehicle.receivedKm = parent.vehicle.receivedKm;
        ticket.transition('vehicleReceived', supervisor._id, undefined, { effectiveAt: parent.vehicle.receivedAt, km: parent.vehicle.receivedKm });
      }
    }
    if (reached('acknowledged') && !parent) {
      ticket.daysToComplete = ticket.daysToComplete ?? 3;
      sign(actingVendor, 'acknowledged');
      step('acknowledged', actingVendor);
    }
    // The step's date is the day it was entered, read once so the history and the Vehicle panel agree.
    const stepWithDate = (status, by, field, extra) => {
      step(status, by, undefined, extra);
      const at = when();
      ticket.history[ticket.history.length - 1].effectiveAt = at;
      ticket.vehicle[field] = at;
    };
    if (reached('vehicleSent') && !parent && !depot) stepWithDate('vehicleSent', creator, 'sentAt');
    if (reached('vehicleReceived') && !parent && !depot) {
      const km = currentReading + DAILY_KM.get(bus);
      stepWithDate('vehicleReceived', actingVendor, 'receivedAt', { km });
      ticket.vehicle.receivedKm = km;
    }
    if (reached('workInProgress') && depot && !parent) {
      // At the depot the vendor gives the reading when starting, which stands in for receiving the bus.
      const km = currentReading + DAILY_KM.get(bus);
      stepWithDate('workInProgress', actingVendor, 'workStartedAt', { km });
      ticket.vehicle.receivedAt = ticket.vehicle.workStartedAt;
      ticket.vehicle.receivedKm = km;
    } else if (reached('workInProgress')) stepWithDate('workInProgress', actingVendor, 'workStartedAt');
    if (reached('readyForDelivery')) stepWithDate('readyForDelivery', actingVendor, 'readyAt');
    if (reached('vehicleReleased') && !depot) {
      sign(actingVendor, 'vehicleReleased');
      stepWithDate('vehicleReleased', actingVendor, 'releasedAt');
    }
    if (reached('vehicleReturned')) {
      const km = currentReading + DAILY_KM.get(bus) * 2;
      stepWithDate('vehicleReturned', creator, 'returnedAt', { km });
      ticket.vehicle.returnedKm = km;
      ticket.vehicle.replacedPartsReceived = true;
      const service = intervalServiceOf({ serviceType, repairCategory });
      if (service === 'battery') bus.intervals.battery.lastDate = when();
      else if (service && bus.intervals[service]) bus.intervals[service].lastKm = km;
      await bus.save();
      if (noChargeReason) {
        // No invoice to wait for: it closes the moment the bus is back.
        const back = ticket.vehicle.returnedAt;
        ticket.transition('completed', creator._id, 'No charge', { effectiveAt: back });
        ticket.history[ticket.history.length - 1].at = back;
        ticket.completedAt = back;
      }
    }
    if (reached('invoiceSubmitted') && !noChargeReason) {
      const invoiceFile = await attach(`Invoice ${ticket.vsrNumber}.pdf`, [`Invoice INV-${ticket.vsrNumber}-1`, `Vendor: ${vendor.name}`, `Bus: ${bus.fleetNumber}`, `Amount: AED ${estimate}`]);
      const inv = await Invoice.create({ ticketId: ticket._id, vendorId: vendor._id, amount: estimate, description: `Work completed on ${bus.fleetNumber}`, invoiceNumber: `INV-${ticket.vsrNumber}-1`, attachments: [invoiceFile], submittedAt: when() });
      ticket.invoice = inv._id;
      step('invoiceSubmitted', actingVendor, `Invoice ${inv.invoiceNumber}`);
      if (reached('invoiceRejected')) {
        inv.status = 'rejected';
        inv.rejectedBy = supervisor._id;
        inv.rejectedAt = when();
        inv.rejectionReason = 'Labour hours look too high for this job. Please itemise.';
        await inv.save();
        step('invoiceRejected', supervisor, inv.rejectionReason);
      }
      if (reached('resubmitted')) {
        const secondFile = await attach(`Invoice ${ticket.vsrNumber} revised.pdf`, [`Invoice INV-${ticket.vsrNumber}-2`, `Vendor: ${vendor.name}`, `Bus: ${bus.fleetNumber}`, `Amount: AED ${money(estimate * 0.95)}`]);
        const inv2 = await Invoice.create({ ticketId: ticket._id, vendorId: vendor._id, amount: money(estimate * 0.95), description: `Itemised invoice for ${bus.fleetNumber}`, invoiceNumber: `INV-${ticket.vsrNumber}-2`, attachments: [secondFile], submittedAt: when() });
        ticket.invoice = inv2._id;
        step('invoiceSubmitted', actingVendor, `Invoice ${inv2.invoiceNumber}`);
      }
      if (reached('invoiceAccepted')) {
        const current = await Invoice.findById(ticket.invoice);
        current.status = 'approved';
        current.approvedBy = supervisor._id;
        current.approvedAt = when();
        await current.save();
        sign(supervisor, 'invoiceAccepted');
        step('invoiceAccepted', supervisor);
      }
      if (reached('invoiceReceived')) {
        ticket.invoiceReceivedAt = when();
        step('invoiceReceived', creator, undefined, { effectiveAt: when() });
      }
      if (reached('forwardedToPurchase')) {
        ticket.forwardedAt = when();
        step('forwardedToPurchase', creator, undefined, { effectiveAt: when() });
      }
    }
    await ticket.save();
    if (!parent) await applyTicketToBusDay(ticket, creator._id, uaeDay(created));
    return ticket;
  };

  /** Purchasing makes one GRN, and optionally one purchase invoice, for a batch of forwarded VSRs. */
  const closeBatch = async (tickets, grnNumber, piNumber) => {
    const invoices = await Invoice.find({ _id: mongoose.trusted({ $in: tickets.map((t) => t.invoice) }) });
    const total = money(invoices.reduce((sum, invoice) => sum + invoice.amount, 0));
    const grn = await Grn.create({
      number: grnNumber, date: daysAgo(2), vendor: tickets[0].vendorId, tickets: tickets.map((t) => t._id), total, createdBy: purchasing._id,
      attachments: [await attach(`${grnNumber}.pdf`, [`Goods Receiving Note ${grnNumber}`, `Covers: ${tickets.map((t) => t.vsrNumber).join(', ')}`, `Total: AED ${total}`])],
    });
    for (const ticket of tickets) {
      ticket.grn = grn._id;
      stamp(ticket, purchasing, 'grn', daysAgo(2));
      ticket.transition('grnCreated', purchasing._id, `GRN ${grnNumber}`, { effectiveAt: daysAgo(2) });
      ticket.history[ticket.history.length - 1].at = daysAgo(2);
      // The GRN takes the accepted invoice off the VSR's LPO line, in place of its booking.
      const deduction = await deductAtGrn(ticket, invoices.find((invoice) => invoice._id.equals(ticket.invoice)).amount);
      if (deduction) ticket.lpoDeduction = { ...deduction, at: daysAgo(2) };
    }
    if (piNumber) {
      const invoice = await PurchaseInvoice.create({
        number: piNumber, date: daysAgo(1), grn: grn._id, vendor: grn.vendor, tickets: grn.tickets, amount: total, createdBy: purchasing._id,
        attachments: [await attach(`${piNumber}.pdf`, [`Purchase Invoice ${piNumber}`, `GRN: ${grnNumber}`, `Amount: AED ${total}`])],
      });
      grn.purchaseInvoice = invoice._id;
      await grn.save();
      for (const ticket of tickets) {
        ticket.purchaseInvoice = invoice._id;
        stamp(ticket, purchasing, 'purchaseInvoice', daysAgo(1));
        ticket.transition('completed', purchasing._id, `Purchase invoice ${piNumber}`, { effectiveAt: daysAgo(1) });
        ticket.history[ticket.history.length - 1].at = daysAgo(1);
        ticket.completedAt = daysAgo(1);
      }
    }
    await Promise.all(tickets.map((ticket) => ticket.save()));
  };

  // Oldest first, so each bus's last service moves on the way it really would.
  const tyres = (count) => [{ name: 'Tyre 295/80 R22.5', description: 'Rear axle', code: 'TYR-295', partNumber: 'BR-29580', quantity: count, unitPrice: 850 }];
  const battery = [{ name: 'Battery 12V 200Ah', code: 'BAT-200', partNumber: 'VB-200', quantity: 1, unitPrice: 620 }];
  const history1 = await makeTicket({ bus: bus104, serviceType: 'oil', description: 'First oil service for new vehicle.', stage: 'forwardedToPurchase', createdDaysAgo: 70 });
  const history2 = await makeTicket({ bus: bus104, serviceType: 'repair', repairCategory: 'ELECTRICAL', description: 'Reverse camera wiring replaced.', stage: 'forwardedToPurchase', createdDaysAgo: 55, amount: 980, isBreakdown: true });
  const history3 = await makeTicket({ bus: bus102, serviceType: 'other', description: 'Interior deep clean and seat repairs after charter.', stage: 'forwardedToPurchase', createdDaysAgo: 40, amount: 750 });
  const history4 = await makeTicket({ bus: bus101, serviceType: 'accident', description: 'Front panel damage after a depot collision.', stage: 'forwardedToPurchase', createdDaysAgo: 38, amount: 4200, accident: { severity: 'medium', fault: 'otherParty' } });
  const batch1 = await makeTicket({ bus: bus103, serviceType: 'tyre', description: 'Replace both rear tyres, tread below legal limit.', stage: 'forwardedToPurchase', createdDaysAgo: 22, amount: 4400, parts: [{ name: 'Tyre 225/75 R17.5', code: 'TYR-225', partNumber: 'BR-22575', quantity: 2, unitPrice: 2200 }] });
  const batch2 = await makeTicket({ bus: bus104, serviceType: 'repair', repairCategory: 'MECHANICAL', description: 'Rear suspension bushes worn on both sides.', stage: 'forwardedToPurchase', createdDaysAgo: 28, amount: 1850 });
  const batch3 = await makeTicket({ bus: bus101, serviceType: 'tyre', description: 'Front tyres worn on the inner edge.', stage: 'forwardedToPurchase', createdDaysAgo: 18, amount: 1700, parts: tyres(2) });
  const batch4 = await makeTicket({ bus: bus102, serviceType: 'repair', repairCategory: 'ENGINE', description: 'Coolant leak at the water pump.', stage: 'forwardedToPurchase', createdDaysAgo: 16, amount: 1300, isBreakdown: true });
  await makeTicket({ bus: bus103, serviceType: 'repair', repairCategory: 'MECHANICAL', description: 'Steering play checked and tie rods replaced.', stage: 'invoiceReceived', createdDaysAgo: 15, amount: 2600 });
  await makeTicket({ bus: bus103, serviceType: 'repair', repairCategory: 'BODY', description: 'Rear bumper bracket welded and repainted.', stage: 'invoiceAccepted', createdDaysAgo: 14, amount: 1100 });
  await makeTicket({ bus: bus104, serviceType: 'repair', repairCategory: 'ELECTRICAL', description: 'Dashboard warning lights flickering intermittently.', stage: 'invoiceRejected', createdDaysAgo: 13, amount: 1200 });
  await makeTicket({ bus: bus101, serviceType: 'repair', repairCategory: 'TRANSMISSION', description: 'Gearbox slipping between second and third gear.', stage: 'invoiceSubmitted', createdDaysAgo: 12 });
  await makeTicket({ bus: bus102, serviceType: 'repair', repairCategory: 'AC REPAIR', description: 'Roof AC compressor seized on the afternoon route.', stage: 'vehicleReturned', createdDaysAgo: 11, amount: 3100 });
  await makeTicket({ bus: bus104, serviceType: 'repair', repairCategory: 'BODY', description: 'Side panel dents from the depot gate.', stage: 'vehicleReleased', createdDaysAgo: 10, amount: 900 });
  await makeTicket({ bus: bus103, serviceType: 'repair', repairCategory: 'AC REPAIR', description: 'Rear AC unit blowing warm air on afternoon routes.', stage: 'readyForDelivery', createdDaysAgo: 9, amount: 1400 });
  const atWork = await makeTicket({ bus: bus101, serviceType: 'repair', repairCategory: 'ENGINE', description: 'Loss of power on hills, turbo hose suspected.', stage: 'workInProgress', createdDaysAgo: 8, amount: 2200, isBreakdown: true });
  await makeTicket({ bus: bus101, parent: atWork, serviceType: 'repair', repairCategory: 'MECHANICAL', description: 'Found a cracked exhaust manifold while fixing the turbo hose.', stage: 'workInProgress', createdDaysAgo: 4, amount: 650 });
  await makeTicket({ bus: bus101, parent: atWork, serviceType: 'battery', description: 'Battery failed the load test while the bus was on the lift.', stage: 'pending', createdDaysAgo: 2, amount: 620, parts: battery });
  await atWork.save();
  await makeTicket({ bus: bus104, serviceType: 'repair', repairCategory: 'BRAKE PADS', description: 'Brake pads worn past the limit.', stage: 'vehicleReceived', createdDaysAgo: 7, amount: 780 });
  await makeTicket({ bus: bus103, serviceType: 'repair', repairCategory: 'ELECTRICAL', description: 'Passenger door sensor faulty.', stage: 'vehicleSent', createdDaysAgo: 6, amount: 480 });
  await makeTicket({ bus: bus102, serviceType: 'repair', repairCategory: 'BODY', description: 'Windscreen chip spreading.', stage: 'acknowledged', createdDaysAgo: 5, amount: 1250 });
  await makeTicket({ bus: bus104, serviceType: 'repair', repairCategory: 'ENGINE', description: 'Oil leak under the engine after the long route.', stage: 'estimateCountered', createdDaysAgo: 4, amount: 480 });
  await makeTicket({ bus: bus102, serviceType: 'oil', description: 'Scheduled oil service, past its interval.', stage: 'approved', createdDaysAgo: 3 });
  await makeTicket({ bus: bus103, serviceType: 'repair', repairCategory: 'BODY', description: 'Front door seal is letting water in.', stage: 'estimateSubmitted', createdDaysAgo: 3, amount: 650 });
  await makeTicket({ bus: bus104, serviceType: 'other', description: 'Replace the cracked mirror on the door side.', stage: 'returned', createdDaysAgo: 2, amount: 320 });
  await makeTicket({ bus: bus101, serviceType: 'battery', description: 'Bus failed to start twice this week; battery not holding charge.', stage: 'pending', createdDaysAgo: 1, amount: 620, parts: battery });
  await makeTicket({ bus: bus102, serviceType: 'repair', repairCategory: 'ELECTRICAL', description: 'Reverse camera screen stays black.', stage: 'sentToVendor', createdDaysAgo: 1 });
  // Added for the owner's answers of 2026-11-06, after the others so their VSR numbers stay as they were.
  await makeTicket({ bus: bus102, serviceType: 'repair', repairCategory: 'ELECTRICAL', description: 'Alternator stopped charging; replaced under the part warranty.', stage: 'vehicleReturned', createdDaysAgo: 20, noChargeReason: 'warranty', parts: [{ name: 'Alternator 24V 150A', code: 'ALT-24', partNumber: 'AL-24150', quantity: 1, unitPrice: 1450 }] });
  await makeTicket({ bus: bus104, serviceType: 'tyre', location: 'depot', description: 'Front left tyre cut on a kerb; changed at the depot.', stage: 'invoiceAccepted', createdDaysAgo: 12, amount: 850, parts: [{ name: 'Tyre 225/75 R17.5', code: 'TYR-225', partNumber: 'BR-22575', quantity: 1, unitPrice: 900 }] });
  await makeTicket({ bus: bus106, serviceType: 'battery', location: 'depot', description: 'Bus would not start in the morning; battery to be changed at the depot.', stage: 'readyForDelivery', createdDaysAgo: 2, amount: 620, parts: battery });
  await makeTicket({ bus: bus103, serviceType: 'accident', description: 'Rear corner hit a bollard while reversing in the depot.', stage: 'estimateSubmitted', createdDaysAgo: 2, amount: 1800, accident: { severity: 'minor', fault: 'ourDriver' } });
  await makeTicket({ bus: bus103, serviceType: 'repair', repairCategory: 'BRAKE PADS', description: 'Brake pads past their interval; squealing when braking.', stage: 'pending', createdDaysAgo: 1, amount: 950, parts: [{ name: 'Brake pad set, front axle', code: 'BRK-F', partNumber: 'BP-2210', quantity: 1, unitPrice: 1000 }] });

  // Added for the owner's testing notes of 2026-11-11: an accident taken to a garage outside the list,
  // whose steps the service creator records.
  const outsideGarage = await outsideVendorNamed('Gulf Star Body Works');
  await makeTicket({ bus: bus102, serviceType: 'accident', outside: outsideGarage, description: 'A truck clipped the front left corner at a junction. The other party\'s insurer sends the bus to its own garage.', stage: 'workInProgress', createdDaysAgo: 4, amount: 3400, accident: { severity: 'medium', fault: 'otherParty' } });

  await closeBatch([history1, batch1, batch2], 'GRN-2026-001', 'PI-2026-001');
  await closeBatch([history2], 'GRN-2026-002', 'PI-2026-002');
  await closeBatch([history3, history4], 'GRN-2026-003');
  // batch3 and batch4 stay forwarded, ready for purchasing to batch.
  void batch3;
  void batch4;

  // The month sheets: statuses set by hand, then a km reading for every past day.
  const manualStatuses = [
    [bus101, 40, 'accident'],
    [bus101, 36, 'ready'],
    [bus104, 26, 'ready'],
    [bus102, 19, 'ready'],
    [bus104, 14, 'ready'],
    [bus103, 13, 'ready'],
  ];
  for (const [bus, n, status] of manualStatuses) {
    await BusStatusChange.updateOne({ bus: bus._id, date: uaeDay(daysAgo(n)) }, { $set: { status, source: 'manual', by: creator._id } }, { upsert: true });
  }

  // Leaving the fleet. BUS-105 cost too much to keep running: scrapped 25 days ago and sold 6 days
  // ago, so it is archived. BUS-107 is past its service life and waits for the supervisor.
  const scrappedOn = uaeDay(daysAgo(25));
  const soldOn = uaeDay(daysAgo(6));
  await ScrapRequest.create({
    bus: bus105._id, reason: 'highRunningCost', status: 'approved', createdBy: creator._id, createdAt: daysAgo(26),
    note: 'Fourteen years old. Repairs this year came to more than half of what the bus is worth.',
    attachments: [await attach('Repair costs BUS-105.pdf', ['Repair costs, BUS-105', 'Suspension, body and brake work this year', 'Total: AED 9,450'])],
    decidedBy: supervisor._id, decidedAt: daysAgo(25), decisionNote: 'Agreed. Sell it for scrap.',
  });
  await Bus.updateOne({ _id: bus105._id }, {
    $set: {
      lifecycle: 'sold', scrappedOn,
      sale: {
        date: soldOn, buyer: 'Desert Line Recyclers', price: 18500, note: 'Sold for scrap with its engine and gearbox. Plates handed back.',
        attachments: [await attach('Sale agreement BUS-105.pdf', ['Sale agreement, BUS-105', 'Buyer: Desert Line Recyclers', 'Price: AED 18,500'])], recordedBy: supervisor._id, recordedAt: daysAgo(6),
      },
    },
  });
  for (const [day, status] of [[scrappedOn, 'scrapping'], [soldOn, 'removed']]) {
    await BusStatusChange.updateOne({ bus: bus105._id, date: day }, { $set: { status, source: 'scrap', by: supervisor._id } }, { upsert: true });
  }
  const waiting = await ScrapRequest.create({
    bus: bus107._id, reason: 'endOfLife', createdBy: creator._id, createdAt: daysAgo(1),
    note: 'Sixteen years old against a 15-year life. Rust under the floor at the rear axle.',
    attachments: [await attach('Inspection BUS-107.pdf', ['Inspection report, BUS-107', 'Model year 2010, expected life 15 years', 'Floor corrosion at the rear axle'])],
  });
  await Bus.updateOne({ _id: bus107._id }, { $set: { lifecycle: 'scrapRequested' } });
  await notifyRoles(['supervisor'], { type: 'scrapRequested', params: { fleetNumber: bus107.fleetNumber, reason: 'endOfLife' }, link: `/buses/${bus107._id}`, dedupeKey: `scrap:${waiting._id}:requested` });
  for (const bus of buses) {
    for (let n = 1; n <= 80; n += 1) {
      if (bus === bus105 && n < 25) continue; // off the road since it went for scrapping
      if (bus === bus106 && n > 20) continue; // not on the fleet yet
      await BusDailyReading.updateOne(
        { bus: bus._id, date: uaeDay(daysAgo(n)) },
        { $setOnInsert: { km: readingAgo(bus, n), by: creator._id } },
        { upsert: true }
      );
    }
  }

  console.log('\nSeed complete. Demo accounts (password: %s):', PASSWORD);
  ACCOUNTS.forEach((a) => console.log(`  ${a.role.padEnd(16)} ${a.email}`));
  console.log(`\nBuses: ${buses.length}, VSRs: ${await Ticket.countDocuments()}, LPOs: ${await Lpo.countDocuments()}, GRNs: ${await Grn.countDocuments()}`);
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
