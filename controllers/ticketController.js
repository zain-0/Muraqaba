import mongoose from 'mongoose';
import Ticket, { PURCHASE_VISIBLE_STATUSES } from '../models/Ticket.js';
import Bus from '../models/Bus.js';
import Invoice from '../models/Invoice.js';
import { nextVsrNumber } from '../models/Counter.js';
import { assertVendorExists } from './busController.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { TICKET_POPULATE, paginate } from '../utils/query.js';
import { sendStored, withStoredAttachments } from '../utils/uploads.js';
import { applyTicketToBusDay } from '../utils/busDay.js';
import { usageWhenRaised } from '../utils/intervals.js';
import { deductFromLpo } from '../utils/lpoDeduction.js';
import { stamp } from '../utils/signatures.js';
import { notifyLpoProblem } from '../utils/notifications.js';
import { assertScanConfigured, scanQuotation, SCANNABLE_TYPES } from '../utils/quotationScan.js';
import { CASE_BLIND } from '../utils/unique.js';

/**
 * Build the Mongo filter a user is allowed to see, combined with optional query filters.
 * Operator objects built here are server-controlled, so they are marked trusted; the global
 * sanitizeFilter setting still neutralises operators smuggled in through user input.
 */
const buildListFilter = (user, q = {}) => {
  const filter = {};
  if (user.role === 'vendor') filter.vendorId = user._id;
  if (user.role === 'purchaseManager') {
    filter.status = mongoose.trusted({ $in: PURCHASE_VISIBLE_STATUSES });
    filter.noChargeReason = mongoose.trusted({ $exists: false }); // closed without an invoice, so nothing for purchasing
  }
  if (q.status) {
    if (user.role === 'purchaseManager' && !PURCHASE_VISIBLE_STATUSES.includes(q.status)) {
      filter.status = mongoose.trusted({ $in: [] }); // outside this role's scope: return nothing rather than leak
    } else {
      filter.status = q.status;
    }
  }
  if (q.busId) filter.busId = q.busId;
  if (q.mine) filter.createdBy = user._id;
  return filter;
};

/** Purchasing works from the invoice on. A job at no charge closes without one, so it never reaches them. */
const visibleToPurchasing = (ticket) => PURCHASE_VISIBLE_STATUSES.includes(ticket.status) && !ticket.noChargeReason;

/** The bus as a vendor may see it: which bus it is, never its rates or intervals. */
const busForVendor = (bus) => {
  if (!bus?.fleetNumber) return bus;
  const { _id, fleetNumber, registrationNumber, chassisNumber, make, model, year } = bus;
  return { _id, fleetNumber, registrationNumber, chassisNumber, make, model, year };
};

const DEPOT_STAMPS = ['grn', 'purchaseInvoice'];
// Once the invoice is accepted a vendor only hears that it was, and later that the VSR closed.
const DEPOT_STEPS = ['invoiceReceived', 'forwardedToPurchase', 'grnCreated'];

/** What a vendor may read of one history entry. */
const historyForVendor = (entry) => {
  // The supervisor's reason for returning, and what the creator wrote to the supervisor, are internal.
  if (entry.status === 'returned' || entry.status === 'pending') return { ...entry, note: undefined };
  if (entry.status === 'completed') return { ...entry, note: undefined, by: undefined, effectiveAt: undefined }; // purchasing closed it
  return entry;
};

/** Internal notes and our own figures stay with the depot, so vendors get them stripped. */
const forViewer = (user, ticket) => {
  const json = ticket.toJSON ? ticket.toJSON() : ticket;
  if (user.role !== 'vendor') return json;
  const { returnReason, intervalUsage, isBreakdown, accident, breakdown, grn, purchaseInvoice, lpoDeduction, forwardedAt, invoiceReceivedAt, ...rest } = json;
  return {
    ...rest,
    busId: busForVendor(json.busId),
    history: (json.history || []).filter((entry) => !DEPOT_STEPS.includes(entry.status)).map(historyForVendor),
    signatures: (json.signatures || []).filter((stamp) => !DEPOT_STAMPS.includes(stamp.step)),
  };
};

export const loadTicket = async (id) => {
  const ticket = await Ticket.findById(id);
  if (!ticket) throw new AppError('VSR not found', 404, 'NOT_FOUND');
  return ticket;
};

export const assertVendorOwns = (ticket, user) => {
  if (!ticket.vendorId.equals(user._id)) {
    throw new AppError('This VSR is assigned to a different vendor', 403, 'FORBIDDEN');
  }
};

export const assertStatus = (ticket, allowed, explanation) => {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(ticket.status)) {
    throw new AppError(explanation, 409, 'INVALID_STATE');
  }
};

export const respond = async (res, ticket, message, status = 200) => {
  await ticket.populate(TICKET_POPULATE);
  res.status(status).json({ success: true, message, data: forViewer(res.req.user, ticket) });
};

/**
 * Oil and transmission services are priced from the rate on the bus, and only for the vendor
 * that rate was agreed with. The vendor charges by the interval whatever the real km were;
 * intervalUsage keeps how much was left or delayed.
 */
const priceFromBusRate = ({ bus, vendor, serviceType }) => {
  const rate = bus.rates?.[serviceType];
  if (!rate || !bus.vendor.equals(vendor._id)) return undefined;
  const km = bus.intervals[serviceType].everyKm;
  return { rate, km, amount: Math.round(rate * km * 100) / 100 };
};

const readingError = (message) => new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'currentReading', message }]);

const assertReadingAfterLastService = (usage) => {
  if (usage?.unit !== 'km' || usage.actual >= 0) return;
  throw readingError('The reading is lower than the last service of this type for this bus');
};

/** An odometer cannot read below any service already recorded at a higher km, whatever the work. */
const assertReadingAfterAnyService = (bus, reading) => {
  const { oil, transmission, tyre, brakePads } = bus.intervals;
  if (reading < Math.max(oil.lastKm, transmission.lastKm, tyre.lastKm, brakePads?.lastKm ?? 0)) throw readingError('The reading is lower than the last service recorded for this bus');
};

/** Buses added before brake pads were tracked have no interval for them, so a brake-pad job could not be measured. */
export const assertBusTracks = (bus, serviceType) => {
  if (serviceType !== 'brakePads' || bus.intervals?.brakePads) return;
  const message = 'This bus has no brake-pad interval. Add it on the bus first.';
  throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'serviceType', message }]);
};

const isAccident = ({ serviceType, repairCategory }) => serviceType === 'repair' && repairCategory === 'ACCIDENT';

// Work is raised only on a bus in operation; a bus on its way out of the fleet says where it is.
const NO_VSR_WHILE = {
  scrapRequested: 'A scrap request for this bus is waiting for the supervisor.',
  scrapped: 'This bus is scrapped. No VSR can be raised on it.',
  sold: 'This bus is sold and archived. No VSR can be raised on it.',
};
const assertInOperation = (bus) => {
  if (NO_VSR_WHILE[bus.lifecycle]) throw new AppError(NO_VSR_WHILE[bus.lifecycle], 409, 'INVALID_STATE');
};

/** The fields the creator fills in, shared by raising a ticket and correcting a returned one. */
const requestFields = async ({ busId, serviceType, repairCategory, description, currentReading, vendorId, isBreakdown, location, accident }, user) => {
  const bus = await Bus.findById(busId);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');
  assertInOperation(bus);
  assertBusTracks(bus, serviceType);
  const vendor = await assertVendorExists(vendorId || bus.vendor);
  const intervalUsage = usageWhenRaised(bus, serviceType, currentReading);
  assertReadingAfterLastService(intervalUsage);
  assertReadingAfterAnyService(bus, currentReading);
  return {
    busId: bus._id,
    serviceType,
    repairCategory: serviceType === 'repair' ? repairCategory : undefined,
    description,
    currentReading,
    isBreakdown: Boolean(isBreakdown),
    // Left out, a new VSR is done at the vendor's workshop and a corrected one stays where it was.
    ...(location ? { location } : {}),
    accident: isAccident({ serviceType, repairCategory }) ? { severity: accident.severity, fault: accident.fault, updatedBy: user._id, updatedAt: new Date() } : undefined,
    vendorId: vendor._id,
    agreedPrice: priceFromBusRate({ bus, vendor, serviceType }),
    intervalUsage,
  };
};

// POST /api/tickets
export const createTicket = asyncHandler(async (req, res) => {
  const fields = await requestFields(req.body, req.user);
  // An agreed price leaves nothing to negotiate, so it goes straight to the supervisor.
  const status = fields.agreedPrice ? 'pending' : 'sentToVendor';
  const ticket = new Ticket({ ...fields, status, createdBy: req.user._id });
  if (fields.agreedPrice) stamp(ticket, req.user, 'escalated');
  ticket.vsrNumber = await nextVsrNumber();
  ticket.history.push({ status, by: req.user._id, note: 'VSR created' });
  await ticket.save();
  // The VSR is real by now, so a problem with the daily sheet must not report it as failed.
  await applyTicketToBusDay(ticket, req.user._id).catch((err) => console.error('Could not update the daily sheet:', err));

  await respond(res, ticket, fields.agreedPrice ? 'VSR created and sent for supervisor approval' : 'VSR created and sent to the vendor', 201);
});

// GET /api/tickets  (role-scoped; supports ?status=&busId=&mine=&page=&limit=)
export const listTickets = asyncHandler(async (req, res) => {
  const result = await paginate(Ticket, buildListFilter(req.user, req.query), {
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort,
    populate: TICKET_POPULATE,
  });
  res.json({ ...result, data: result.data.map((t) => forViewer(req.user, t)) });
});

const listWithStatus = (status) =>
  asyncHandler(async (req, res) => {
    const result = await paginate(Ticket, buildListFilter(req.user, { ...req.query, status }), {
      page: req.query.page,
      limit: req.query.limit,
      sort: req.query.sort,
      populate: TICKET_POPULATE,
    });
    res.json({ ...result, data: result.data.map((t) => forViewer(req.user, t)) });
  });

// GET /api/tickets/pending
export const getAllPendingTickets = listWithStatus('pending');
// GET /api/tickets/completed
export const getCompletedTickets = listWithStatus('completed');

// GET /api/tickets/my-tickets
export const getMyTickets = asyncHandler(async (req, res) => {
  const result = await paginate(Ticket, buildListFilter(req.user, { ...req.query, mine: true }), {
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort,
    populate: TICKET_POPULATE,
  });
  res.json(result);
});

/** Loads a ticket with the same visibility rules for the detail page and its files. */
const loadVisibleTicket = async (req) => {
  // Lists leave the drawings out to stay light; a single VSR shows and prints them.
  const ticket = await Ticket.findById(req.params.id).populate(TICKET_POPULATE).populate({ path: 'signatures.image', select: 'image' });
  if (!ticket) throw new AppError('VSR not found', 404, 'NOT_FOUND');

  const vendorRef = ticket.vendorId?._id || ticket.vendorId;
  if (req.user.role === 'vendor' && !vendorRef.equals(req.user._id)) {
    // Respond as if it does not exist so vendors cannot enumerate other vendors' tickets.
    throw new AppError('VSR not found', 404, 'NOT_FOUND');
  }
  if (req.user.role === 'purchaseManager' && !visibleToPurchasing(ticket)) {
    // Same scope as the list: purchasing only sees tickets that have an invoice.
    throw new AppError('VSR not found', 404, 'NOT_FOUND');
  }
  return ticket;
};

/** The other VSRs in this job's family: a parent and its additional jobs, in number order. */
const linkedTo = async (user, ticket) => {
  const root = ticket.parentTicket ?? ticket._id;
  const linked = await Ticket.find({ _id: mongoose.trusted({ $ne: ticket._id }), $or: [{ _id: root }, { parentTicket: root }] })
    .select('vsrNumber status serviceType noChargeReason')
    .sort({ vsrNumber: 1 });
  return user.role === 'purchaseManager' ? linked.filter(visibleToPurchasing) : linked;
};

/**
 * The vendor's other VSRs whose current invoice carries the same number, in any letter case.
 * One invoice can honestly cover two jobs, so staff are told rather than the vendor refused.
 */
const sameInvoiceNumber = async (ticket) => {
  const number = ticket.invoice?.invoiceNumber;
  if (!number) return [];
  const vendor = ticket.vendorId?._id ?? ticket.vendorId;
  const invoices = await Invoice.find({ vendorId: vendor, invoiceNumber: number, ticketId: mongoose.trusted({ $ne: ticket._id }) }).collation(CASE_BLIND).select('_id');
  if (!invoices.length) return [];
  const tickets = await Ticket.find({ invoice: mongoose.trusted({ $in: invoices.map((invoice) => invoice._id) }) }).select('vsrNumber').sort({ vsrNumber: 1 });
  return tickets.map(({ _id, vsrNumber }) => ({ _id, vsrNumber }));
};

// GET /api/tickets/:id
export const getTicketById = asyncHandler(async (req, res) => {
  const ticket = await loadVisibleTicket(req);

  // Every invoice ever submitted for this ticket, oldest first, so the UI can show rejections and resubmissions.
  const invoices = await Invoice.find({ ticketId: ticket._id }).sort({ createdAt: 1 });
  const duplicateInvoiceNumber = req.user.role === 'vendor' ? undefined : await sameInvoiceNumber(ticket);

  res.json({ success: true, data: { ...forViewer(req.user, ticket), invoices, linkedTickets: await linkedTo(req.user, ticket), duplicateInvoiceNumber } });
});

// PUT /api/tickets/:id/approve  (supervisor)
export const approveTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'pending', `Only pending VSRs can be approved (this one is ${ticket.status})`);
  const latest = ticket.latestEstimate();
  ticket.approvedEstimate = ticket.agreedPrice?.amount ?? latest?.amount;
  // Frozen like the amount: an estimate of AED 0 closes when the bus is back, with no invoice. An agreed
  // price has no vendor estimate, so it can never be at no charge.
  ticket.noChargeReason = latest?.noChargeReason;
  stamp(ticket, req.user, 'approved');
  ticket.transition('approved', req.user._id, req.body?.note);
  // An additional job's bus is already at the vendor, so it has no sending or receiving of its own.
  if (ticket.parentTicket) {
    const { vehicle } = await Ticket.findById(ticket.parentTicket).select('vehicle');
    ticket.vehicle.receivedAt = vehicle.receivedAt;
    ticket.vehicle.receivedKm = vehicle.receivedKm;
    ticket.transition('vehicleReceived', req.user._id, undefined, { effectiveAt: vehicle.receivedAt, km: vehicle.receivedKm });
  }
  await ticket.save();
  await respond(res, ticket, ticket.parentTicket ? 'Additional job approved. The vendor can work on it.' : 'VSR approved. The vendor has been asked to acknowledge it.');
});

// PUT /api/tickets/:id/accident  (creator, supervisor; any stage, and never shown to vendors)
export const updateAccident = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  if (!isAccident(ticket)) throw new AppError('Only an accident repair has accident details.', 409, 'INVALID_STATE');
  const { severity, fault } = req.body;
  ticket.accident = { severity, fault, updatedBy: req.user._id, updatedAt: new Date() };
  await ticket.save();
  await respond(res, ticket, 'Accident details saved');
});

// PUT /api/tickets/:id/return  (supervisor)
export const returnTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'pending', `Only pending VSRs can be returned (this one is ${ticket.status})`);
  ticket.returnReason = req.body.reason;
  ticket.transition('returned', req.user._id, req.body.reason);
  await ticket.save();
  await respond(res, ticket, 'VSR returned to the service creator.');
});

// PUT /api/tickets/:id/decline  (supervisor; additional jobs only, because one left waiting holds up its parent's release)
export const declineTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'pending', `Only pending VSRs can be declined (this one is ${ticket.status})`);
  if (!ticket.parentTicket) throw new AppError('Only an additional job can be declined. Return this VSR to the service creator instead.', 409, 'INVALID_STATE');
  ticket.declineReason = req.body.reason;
  ticket.transition('declined', req.user._id, req.body.reason);
  await ticket.save();
  await respond(res, ticket, 'Additional job declined');
});

// PUT /api/tickets/:id/details  (creator, after a supervisor returned it)
export const correctTicketDetails = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'returned', `Only returned VSRs can be changed (this one is ${ticket.status})`);
  // It travels in its parent's bus, so its bus and kind are not open to change.
  if (ticket.parentTicket) throw new AppError('An additional job cannot be changed. Reply to the vendor or send it for approval again.', 409, 'INVALID_STATE');
  const fields = await requestFields(req.body, req.user);
  // Estimates belong to the vendor who wrote them, and a new vendor must not read a rival's prices.
  if (ticket.negotiation.length && !fields.vendorId.equals(ticket.vendorId)) {
    throw new AppError('The vendor cannot be changed once estimates have started. Raise a new VSR instead.', 409, 'INVALID_STATE');
  }
  // A VSR priced from the bus rate has no estimates to fall back on, and one priced by estimate
  // has a negotiation the rate would silently override, so neither can turn into the other.
  if (Boolean(fields.agreedPrice) !== Boolean(ticket.agreedPrice)) {
    throw new AppError('This change would switch how the VSR is priced, between the bus rate and the vendor\'s estimate. Raise a new VSR instead.', 409, 'INVALID_STATE');
  }
  // The price was set when the VSR was raised. Only another bus or service is priced afresh.
  const samePricing = fields.busId.equals(ticket.busId) && fields.serviceType === ticket.serviceType && fields.vendorId.equals(ticket.vendorId);
  if (samePricing) delete fields.agreedPrice;
  const busChanged = !fields.busId.equals(ticket.busId);
  ticket.set(fields);
  if (busChanged && ticket.breakdown?.labourHours) await repriceLabour(ticket);
  ticket.transition('returned', req.user._id, 'Details corrected');
  await ticket.save();
  await respond(res, ticket, 'VSR details saved');
});

/** Labour is charged at the bus's own rate, so a VSR moved to another bus takes that bus's rate. */
const repriceLabour = async (ticket) => {
  const { labourRate } = await Bus.findById(ticket.busId).select('labourRate');
  const { breakdown } = ticket;
  breakdown.labourRate = labourRate;
  breakdown.labourTotal = money(breakdown.labourHours * (labourRate ?? 0));
  breakdown.quotationTotal = money(breakdown.partsTotal + breakdown.labourTotal + (breakdown.consumables ?? 0));
  compareWithEstimate(ticket);
};

// POST /api/tickets/:id/estimate  (vendor who owns the ticket; multipart, with files)
export const submitEstimate = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, ['sentToVendor', 'estimateCountered'], `An estimate is not needed at this stage (this one is ${ticket.status})`);
  await withStoredAttachments(req.files, async (attachments) => {
    const { amount, quotationNumber, daysToComplete, note, noChargeReason } = req.body;
    const estimateNumber = ticket.negotiation.filter((round) => round.from === 'vendor').length + 1;
    ticket.negotiation.push({ from: 'vendor', by: req.user._id, amount, quotationNumber, daysToComplete, estimateNumber, noChargeReason: noChargeReason || undefined, note, attachments });
    ticket.daysToComplete = daysToComplete;
    ticket.transition('estimateSubmitted', req.user._id, `Estimate ${estimateNumber}`);
    await ticket.save();
  });
  await respond(res, ticket, 'Estimate sent to the service creator', 201);
});

// POST /api/tickets/:id/estimate/reply  (creator; multipart, with files)
export const replyToEstimate = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, ['estimateSubmitted', 'returned'], `There is no estimate to reply to (this one is ${ticket.status})`);
  if (ticket.agreedPrice) {
    throw new AppError('This VSR uses the vendor\'s agreed price, so there is nothing to negotiate.', 409, 'INVALID_STATE');
  }
  const { amount, note } = req.body;
  if (amount === undefined && !note && !req.files?.length) {
    const message = 'Add a counter amount, a note or a file';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'note', message }]);
  }
  await withStoredAttachments(req.files, async (attachments) => {
    ticket.negotiation.push({ from: 'creator', by: req.user._id, amount, note, attachments });
    ticket.transition('estimateCountered', req.user._id, 'Reply sent to the vendor');
    await ticket.save();
  });
  await respond(res, ticket, 'Reply sent to the vendor', 201);
});

const money = (value) => Math.round(value * 100) / 100;

/** The latest estimate may have changed since the breakdown was saved, so this always re-reads it. */
const compareWithEstimate = (ticket) => {
  const estimateAmount = ticket.latestEstimate()?.amount;
  ticket.breakdown.estimateAmount = estimateAmount;
  ticket.breakdown.discount = estimateAmount === undefined ? undefined : money(ticket.breakdown.quotationTotal - estimateAmount);
};

const checkBreakdownAgainstEstimate = (ticket) => {
  const latest = ticket.latestEstimate();
  if (!latest) {
    throw new AppError('The vendor has to send an estimate before this can go to the supervisor.', 409, 'NOT_READY');
  }
  // Work at no charge has no price to check, but parts and labour, once saved, are still compared.
  if (latest.noChargeReason && !ticket.breakdown) return;
  if (!ticket.breakdown) {
    throw new AppError('Fill in the parts and labour before sending this to the supervisor.', 409, 'NOT_READY');
  }
  compareWithEstimate(ticket);
  if (ticket.breakdown.discount < 0) {
    throw new AppError('The parts and labour total is below the vendor\'s estimate. Correct them or reply to the vendor.', 409, 'NOT_READY');
  }
};

// PUT /api/tickets/:id/breakdown  (creator)
export const saveBreakdown = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, ['estimateSubmitted', 'estimateCountered', 'returned'], `Parts and labour can only change while the price is open (this one is ${ticket.status})`);
  if (ticket.agreedPrice) throw new AppError('This VSR uses an agreed price, so it has no parts and labour to fill in.', 409, 'INVALID_STATE');

  const { remarks, unitsFitted } = req.body;
  const parts = req.body.parts ?? [];
  const labourHours = req.body.labourHours ?? 0;
  const consumables = req.body.consumables ?? 0;
  if (!parts.length && !labourHours && !consumables) {
    const message = 'Add at least one part, labour hours or consumables';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'parts', message }]);
  }
  const { labourRate } = await Bus.findById(ticket.busId).select('labourRate');
  if (labourHours && !labourRate) {
    const message = 'This bus has no labour charge. Add it on the bus first.';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'labourHours', message }]);
  }

  const lines = parts.map((part) => ({ ...part, total: money(part.quantity * part.unitPrice) }));
  const partsTotal = money(lines.reduce((sum, line) => sum + line.total, 0));
  const labourTotal = money(labourHours * (labourRate ?? 0));
  ticket.breakdown = {
    parts: lines,
    partsTotal,
    labourHours,
    labourRate,
    labourTotal,
    consumables,
    quotationTotal: money(partsTotal + labourTotal + consumables),
    unitsFitted: unitsFitted ?? undefined,
    remarks,
  };
  compareWithEstimate(ticket);
  await ticket.save();
  await respond(res, ticket, 'Parts and labour saved');
});

// POST /api/tickets/:id/scan-quotation  (creator: returns lines to check, saves nothing)
export const scanQuotationFile = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, ['estimateSubmitted', 'estimateCountered', 'returned'], `A quotation can only be scanned while the price is open (this one is ${ticket.status})`);
  assertScanConfigured();

  const files = [...ticket.negotiation].reverse().filter((round) => round.from === 'vendor').flatMap((round) => round.attachments);
  const { attachmentId } = req.body;
  if (attachmentId && !files.some((file) => file._id.equals(attachmentId))) throw new AppError('File not found', 404, 'NOT_FOUND');
  const refuse = (message) => new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'attachments', message }]);
  if (!files.length) throw refuse('The vendor attached no file to scan.');
  const file = attachmentId ? files.find((candidate) => candidate._id.equals(attachmentId)) : files.find((candidate) => SCANNABLE_TYPES.includes(candidate.mimeType));
  if (!file || !SCANNABLE_TYPES.includes(file.mimeType)) throw refuse('Only a PDF or a photo can be scanned. Fill in the parts by hand.');

  res.json({ success: true, data: await scanQuotation(file) });
});

// PUT /api/tickets/:id/escalate  (creator)
export const escalateTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, ['estimateSubmitted', 'returned'], `Only a VSR with an estimate to review can be sent to the supervisor (this one is ${ticket.status})`);
  if (!ticket.agreedPrice) checkBreakdownAgainstEstimate(ticket);
  stamp(ticket, req.user, 'escalated');
  ticket.returnReason = undefined;
  ticket.transition('pending', req.user._id, req.body?.note || 'Sent to the supervisor for approval');
  await ticket.save();
  await respond(res, ticket, 'VSR sent to the supervisor for approval');
});

// GET /api/tickets/:id/attachments/:attachmentId
export const downloadAttachment = asyncHandler(async (req, res) => {
  const ticket = await loadVisibleTicket(req);
  const invoices = await Invoice.find({ ticketId: ticket._id }).select('attachments');
  // Purchasing's own documents stay with the depot.
  const purchasing = req.user.role === 'vendor' ? [] : [ticket.grn, ticket.purchaseInvoice].filter(Boolean);
  const attachment = [...ticket.negotiation, ...invoices, ...purchasing].flatMap((holder) => holder.attachments).find((a) => a._id.equals(req.params.attachmentId));
  await sendStored(res, attachment);
});

// PUT /api/tickets/:id/acknowledge  (vendor who owns the ticket)
export const acknowledgeTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'approved', `A VSR must be approved before it can be acknowledged (this one is ${ticket.status})`);
  if (req.body?.daysToComplete) ticket.daysToComplete = req.body.daysToComplete;
  if (!ticket.daysToComplete) {
    const message = 'Enter the number of days to complete the work';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'daysToComplete', message }]);
  }
  stamp(ticket, req.user, 'acknowledged');
  ticket.transition('acknowledged', req.user._id, req.body?.note);
  await ticket.save();
  // At the depot the bus is never sent: the vendor comes to it.
  await respond(res, ticket, ticket.location === 'depot' ? 'VSR acknowledged. Start the work at the depot and enter the reading.' : 'VSR acknowledged. The service creator sends the bus.');
});

// POST /api/tickets/:id/invoice  (vendor who owns the ticket)
export const submitInvoice = asyncHandler(async (req, res) => {
  const { amount, description, invoiceNumber } = req.body;
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(
    ticket,
    ['vehicleReturned', 'invoiceRejected'],
    `An invoice can only be submitted after the bus is back or after a rejection (this one is ${ticket.status})`
  );
  if (!req.files?.length) {
    const message = 'Attach the invoice';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'attachments', message }]);
  }

  await withStoredAttachments(req.files, async (attachments) => {
    const invoice = new Invoice({ ticketId: ticket._id, vendorId: req.user._id, amount, description, invoiceNumber, attachments });
    // Save the ticket first: if a concurrent submission already moved it, the version
    // check rejects this one and no orphan invoice is written.
    ticket.invoice = invoice._id;
    ticket.transition('invoiceSubmitted', req.user._id, `Invoice ${invoiceNumber}`);
    await ticket.save();
    await invoice.save();
  });
  await respond(res, ticket, 'Invoice submitted for supervisor review', 201);
});

// PUT /api/tickets/:id/invoice/accept  (supervisor)
export const acceptInvoice = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'invoiceSubmitted', `There is no invoice awaiting review on this VSR (status ${ticket.status})`);
  const invoice = await Invoice.findById(ticket.invoice);
  if (!invoice) throw new AppError('Invoice record is missing', 500, 'INVOICE_MISSING');
  if (invoice.status !== 'invoicePending') throw new AppError('Invoice has already been processed', 409, 'INVALID_STATE');
  stamp(ticket, req.user, 'invoiceAccepted');

  invoice.status = 'approved';
  invoice.approvedAt = new Date();
  invoice.approvedBy = req.user._id;
  await invoice.save();

  ticket.transition('invoiceAccepted', req.user._id, req.body?.note);
  await ticket.save();

  // The invoice stands whatever happens to the LPO, so a failure here must not undo it.
  try {
    ticket.lpoDeduction = await deductFromLpo(ticket, invoice);
    if (ticket.lpoDeduction) await ticket.save();
    if (ticket.lpoDeduction?.status === 'noLpo' || ticket.lpoDeduction?.overrun) await notifyLpoProblem(ticket);
  } catch (err) {
    console.error('Could not update the LPO:', err);
  }
  await respond(res, ticket, 'Invoice accepted. The service creator receives it and forwards it to purchasing.');
});

// PUT /api/tickets/:id/invoice/reject  (supervisor)
export const rejectInvoice = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'invoiceSubmitted', `There is no invoice awaiting review on this VSR (status ${ticket.status})`);
  const invoice = await Invoice.findById(ticket.invoice);
  if (!invoice) throw new AppError('Invoice record is missing', 500, 'INVOICE_MISSING');
  if (invoice.status !== 'invoicePending') throw new AppError('Invoice has already been processed', 409, 'INVALID_STATE');

  invoice.status = 'rejected';
  invoice.rejectedAt = new Date();
  invoice.rejectedBy = req.user._id;
  invoice.rejectionReason = req.body?.reason || undefined;
  await invoice.save();

  ticket.transition('invoiceRejected', req.user._id, req.body?.reason);
  await ticket.save();
  await respond(res, ticket, 'Invoice rejected. The vendor has been asked to resubmit.');
});
