import mongoose from 'mongoose';
import Ticket from '../models/Ticket.js';
import Bus from '../models/Bus.js';
import Invoice from '../models/Invoice.js';
import { assertVendorExists } from './busController.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { TICKET_POPULATE, paginate } from '../utils/query.js';
import { UPLOAD_DIR, storedPath, withStoredAttachments } from '../utils/uploads.js';
import { applyTicketToBusDay } from '../utils/busDay.js';

// Statuses the purchase manager is concerned with (anything that has an invoice).
const PURCHASE_MANAGER_STATUSES = ['invoiceSubmitted', 'invoiceAccepted', 'invoiceRejected', 'completed'];

/**
 * Build the Mongo filter a user is allowed to see, combined with optional query filters.
 * Operator objects built here are server-controlled, so they are marked trusted; the global
 * sanitizeFilter setting still neutralises operators smuggled in through user input.
 */
const buildListFilter = (user, q = {}) => {
  const filter = {};
  if (user.role === 'vendor') filter.vendorId = user._id;
  if (user.role === 'purchaseManager') filter.status = mongoose.trusted({ $in: PURCHASE_MANAGER_STATUSES });
  if (q.status) {
    if (user.role === 'purchaseManager' && !PURCHASE_MANAGER_STATUSES.includes(q.status)) {
      filter.status = mongoose.trusted({ $in: [] }); // outside this role's scope: return nothing rather than leak
    } else {
      filter.status = q.status;
    }
  }
  if (q.busId) filter.busId = q.busId;
  if (q.mine) filter.createdBy = user._id;
  return filter;
};

/** A supervisor's reason for returning a ticket is an internal note, so vendors get it stripped. */
const forViewer = (user, ticket) => {
  const json = ticket.toJSON ? ticket.toJSON() : ticket;
  if (user.role !== 'vendor') return json;
  const { returnReason, ...rest } = json;
  return { ...rest, history: (json.history || []).map((h) => (h.status === 'returned' ? { ...h, note: undefined } : h)) };
};

const loadTicket = async (id) => {
  const ticket = await Ticket.findById(id);
  if (!ticket) throw new AppError('VSR not found', 404, 'NOT_FOUND');
  return ticket;
};

const assertVendorOwns = (ticket, user) => {
  if (!ticket.vendorId.equals(user._id)) {
    throw new AppError('This VSR is assigned to a different vendor', 403, 'FORBIDDEN');
  }
};

const assertStatus = (ticket, allowed, explanation) => {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(ticket.status)) {
    throw new AppError(explanation, 409, 'INVALID_STATE');
  }
};

const respond = async (res, ticket, message, status = 200) => {
  await ticket.populate(TICKET_POPULATE);
  res.status(status).json({ success: true, message, data: forViewer(res.req.user, ticket) });
};

/**
 * Minor and major services are priced from the vendor's agreed rate: rate times the km since
 * the bus's last ticket of that type, or its whole reading when it has had none.
 */
const priceFromVendorRate = async ({ vendor, bus, serviceType, currentReading, ticketId }) => {
  const rate = vendor.serviceRates?.[serviceType];
  if (!rate) return undefined;
  const last = await Ticket.findOne({
    busId: bus._id,
    serviceType,
    currentReading: mongoose.trusted({ $exists: true }),
    ...(ticketId ? { _id: mongoose.trusted({ $ne: ticketId }) } : {}),
  })
    .sort({ createdAt: -1 })
    .select('currentReading');
  const km = currentReading - (last?.currentReading ?? 0);
  if (km < 0) {
    const message = 'The reading is lower than the last VSR of this type for this bus';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'currentReading', message }]);
  }
  return { rate, km, amount: Math.round(rate * km * 100) / 100 };
};

/** The fields the creator fills in, shared by raising a ticket and correcting a returned one. */
const requestFields = async ({ busId, serviceType, repairCategory, description, currentReading, vendorId }, ticketId) => {
  const bus = await Bus.findById(busId);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');
  const vendor = await assertVendorExists(vendorId || bus.vendor);
  const agreedPrice = await priceFromVendorRate({ vendor, bus, serviceType, currentReading, ticketId });
  return {
    busId: bus._id,
    serviceType,
    repairCategory: serviceType === 'repair' ? repairCategory : undefined,
    description,
    currentReading,
    vendorId: vendor._id,
    agreedPrice,
  };
};

// POST /api/tickets
export const createTicket = asyncHandler(async (req, res) => {
  const fields = await requestFields(req.body);
  // An agreed price leaves nothing to negotiate, so it goes straight to the supervisor.
  const status = fields.agreedPrice ? 'pending' : 'sentToVendor';
  const ticket = new Ticket({ ...fields, status, createdBy: req.user._id });
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
  const ticket = await Ticket.findById(req.params.id).populate(TICKET_POPULATE);
  if (!ticket) throw new AppError('VSR not found', 404, 'NOT_FOUND');

  const vendorRef = ticket.vendorId?._id || ticket.vendorId;
  if (req.user.role === 'vendor' && !vendorRef.equals(req.user._id)) {
    // Respond as if it does not exist so vendors cannot enumerate other vendors' tickets.
    throw new AppError('VSR not found', 404, 'NOT_FOUND');
  }
  if (req.user.role === 'purchaseManager' && !PURCHASE_MANAGER_STATUSES.includes(ticket.status)) {
    // Same scope as the list: purchasing only sees tickets that have an invoice.
    throw new AppError('VSR not found', 404, 'NOT_FOUND');
  }
  return ticket;
};

// GET /api/tickets/:id
export const getTicketById = asyncHandler(async (req, res) => {
  const ticket = await loadVisibleTicket(req);

  // Every invoice ever submitted for this ticket, oldest first, so the UI can show rejections and resubmissions.
  const invoices = await Invoice.find({ ticketId: ticket._id }).sort({ createdAt: 1 });

  res.json({ success: true, data: { ...forViewer(req.user, ticket), invoices } });
});

// PUT /api/tickets/:id/approve  (supervisor)
export const approveTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'pending', `Only pending VSRs can be approved (this one is ${ticket.status})`);
  ticket.approvedEstimate = ticket.agreedPrice?.amount ?? ticket.latestEstimate()?.amount;
  ticket.transition('approved', req.user._id, req.body?.note);
  await ticket.save();
  await respond(res, ticket, 'VSR approved. The vendor has been asked to acknowledge it.');
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

// PUT /api/tickets/:id/details  (creator, after a supervisor returned it)
export const correctTicketDetails = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'returned', `Only returned VSRs can be changed (this one is ${ticket.status})`);
  const fields = await requestFields(req.body, ticket._id);
  // Estimates belong to the vendor who wrote them, and a new vendor must not read a rival's prices.
  if (ticket.negotiation.length && !fields.vendorId.equals(ticket.vendorId)) {
    throw new AppError('The vendor cannot be changed once estimates have started. Raise a new VSR instead.', 409, 'INVALID_STATE');
  }
  ticket.set(fields);
  ticket.transition('returned', req.user._id, 'Details corrected');
  await ticket.save();
  await respond(res, ticket, 'VSR details saved');
});

// POST /api/tickets/:id/estimate  (vendor who owns the ticket; multipart, with files)
export const submitEstimate = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, ['sentToVendor', 'estimateCountered'], `An estimate is not needed at this stage (this one is ${ticket.status})`);
  await withStoredAttachments(req.files, async (attachments) => {
    ticket.negotiation.push({ from: 'vendor', by: req.user._id, amount: req.body.amount, note: req.body.note, attachments });
    ticket.transition('estimateSubmitted', req.user._id, 'Estimate sent');
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

// PUT /api/tickets/:id/escalate  (creator)
export const escalateTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, ['estimateSubmitted', 'returned'], `Only a VSR with an estimate to review can be sent to the supervisor (this one is ${ticket.status})`);
  if (!ticket.agreedPrice && !ticket.latestEstimate()) {
    throw new AppError('The vendor has to send an estimate before this can go to the supervisor.', 409, 'INVALID_STATE');
  }
  ticket.returnReason = undefined;
  ticket.transition('pending', req.user._id, req.body?.note || 'Sent to the supervisor for approval');
  await ticket.save();
  await respond(res, ticket, 'VSR sent to the supervisor for approval');
});

// GET /api/tickets/:id/attachments/:attachmentId
export const downloadAttachment = asyncHandler(async (req, res) => {
  const ticket = await loadVisibleTicket(req);
  const attachment = ticket.negotiation.flatMap((round) => round.attachments).find((a) => a._id.equals(req.params.attachmentId));
  if (!attachment) throw new AppError('File not found', 404, 'NOT_FOUND');
  res.attachment(attachment.name);
  res.type(attachment.mimeType);
  await new Promise((resolve, reject) => {
    res.sendFile(storedPath(attachment).slice(UPLOAD_DIR.length + 1), { root: UPLOAD_DIR }, (err) => (err ? reject(new AppError('File not found', 404, 'NOT_FOUND')) : resolve()));
  });
});

// PUT /api/tickets/:id/acknowledge  (vendor who owns the ticket)
export const acknowledgeTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'approved', `A VSR must be approved before it can be acknowledged (this one is ${ticket.status})`);
  ticket.transition('acknowledged', req.user._id, req.body?.note);
  await ticket.save();
  await respond(res, ticket, 'VSR acknowledged. Submit an invoice when the work is done.');
});

// POST /api/tickets/:id/invoice  (vendor who owns the ticket)
export const submitInvoice = asyncHandler(async (req, res) => {
  const { amount, description, invoiceNumber } = req.body;
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(
    ticket,
    ['acknowledged', 'invoiceRejected'],
    `An invoice can only be submitted after the VSR is acknowledged or after a rejection (this one is ${ticket.status})`
  );

  const invoice = new Invoice({
    ticketId: ticket._id,
    vendorId: req.user._id,
    amount,
    description,
    invoiceNumber: invoiceNumber || undefined,
  });

  // Save the ticket first: if a concurrent submission already moved it, the version
  // check rejects this one and no orphan invoice is written.
  ticket.invoice = invoice._id;
  ticket.transition('invoiceSubmitted', req.user._id, invoiceNumber ? `Invoice ${invoiceNumber}` : undefined);
  await ticket.save();
  await invoice.save();
  await respond(res, ticket, 'Invoice submitted for supervisor review', 201);
});

// PUT /api/tickets/:id/invoice/accept  (supervisor)
export const acceptInvoice = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'invoiceSubmitted', `There is no invoice awaiting review on this VSR (status ${ticket.status})`);
  const invoice = await Invoice.findById(ticket.invoice);
  if (!invoice) throw new AppError('Invoice record is missing', 500, 'INVOICE_MISSING');
  if (invoice.status !== 'invoicePending') throw new AppError('Invoice has already been processed', 409, 'INVALID_STATE');

  invoice.status = 'approved';
  invoice.approvedAt = new Date();
  invoice.approvedBy = req.user._id;
  await invoice.save();

  ticket.transition('invoiceAccepted', req.user._id, req.body?.note);
  await ticket.save();
  await respond(res, ticket, 'Invoice accepted. The vendor can now close the VSR.');
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

// PUT /api/tickets/:id/complete  (vendor who owns the ticket)
export const completeTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'invoiceAccepted', `The invoice must be accepted before the VSR can be closed (this one is ${ticket.status})`);
  ticket.transition('completed', req.user._id, req.body?.note);
  await ticket.save();
  await respond(res, ticket, 'VSR completed');
});
