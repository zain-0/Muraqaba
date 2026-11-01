import mongoose from 'mongoose';
import Ticket from '../models/Ticket.js';
import Bus from '../models/Bus.js';
import Invoice from '../models/Invoice.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { TICKET_POPULATE, paginate } from '../utils/query.js';

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

const loadTicket = async (id) => {
  const ticket = await Ticket.findById(id);
  if (!ticket) throw new AppError('Ticket not found', 404, 'NOT_FOUND');
  return ticket;
};

const assertVendorOwns = (ticket, user) => {
  if (!ticket.vendorId.equals(user._id)) {
    throw new AppError('This ticket is assigned to a different vendor', 403, 'FORBIDDEN');
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
  res.status(status).json({ success: true, message, data: ticket });
};

// POST /api/tickets
export const createTicket = asyncHandler(async (req, res) => {
  const { busId, serviceType, repairCategory, description } = req.body;

  const bus = await Bus.findById(busId);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');

  const ticket = new Ticket({
    busId: bus._id,
    serviceType,
    repairCategory: serviceType === 'repair' ? repairCategory : undefined,
    description,
    vendorId: bus.vendor, // the vendor assigned to the bus does the work
    createdBy: req.user._id,
  });
  ticket.history.push({ status: 'pending', by: req.user._id, note: 'Ticket created' });
  await ticket.save();

  await respond(res, ticket, 'Ticket created and sent for supervisor approval', 201);
});

// GET /api/tickets  (role-scoped; supports ?status=&busId=&mine=&page=&limit=)
export const listTickets = asyncHandler(async (req, res) => {
  const result = await paginate(Ticket, buildListFilter(req.user, req.query), {
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort,
    populate: TICKET_POPULATE,
  });
  res.json(result);
});

const listWithStatus = (status) =>
  asyncHandler(async (req, res) => {
    const result = await paginate(Ticket, buildListFilter(req.user, { ...req.query, status }), {
      page: req.query.page,
      limit: req.query.limit,
      sort: req.query.sort,
      populate: TICKET_POPULATE,
    });
    res.json(result);
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

// GET /api/tickets/:id
export const getTicketById = asyncHandler(async (req, res) => {
  const ticket = await Ticket.findById(req.params.id).populate(TICKET_POPULATE);
  if (!ticket) throw new AppError('Ticket not found', 404, 'NOT_FOUND');

  const vendorRef = ticket.vendorId?._id || ticket.vendorId;
  if (req.user.role === 'vendor' && !vendorRef.equals(req.user._id)) {
    // Respond as if it does not exist so vendors cannot enumerate other vendors' tickets.
    throw new AppError('Ticket not found', 404, 'NOT_FOUND');
  }
  if (req.user.role === 'purchaseManager' && !PURCHASE_MANAGER_STATUSES.includes(ticket.status)) {
    // Same scope as the list: purchasing only sees tickets that have an invoice.
    throw new AppError('Ticket not found', 404, 'NOT_FOUND');
  }

  // Every invoice ever submitted for this ticket, oldest first, so the UI can show rejections and resubmissions.
  const invoices = await Invoice.find({ ticketId: ticket._id }).sort({ createdAt: 1 });

  res.json({ success: true, data: { ...ticket.toJSON(), invoices } });
});

// PUT /api/tickets/:id/approve  (supervisor)
export const approveTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'pending', `Only pending tickets can be approved (this one is ${ticket.status})`);
  ticket.transition('approved', req.user._id, req.body?.note);
  await ticket.save();
  await respond(res, ticket, 'Ticket approved. The vendor has been asked to acknowledge it.');
});

// PUT /api/tickets/:id/acknowledge  (vendor who owns the ticket)
export const acknowledgeTicket = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'approved', `A ticket must be approved before it can be acknowledged (this one is ${ticket.status})`);
  ticket.transition('acknowledged', req.user._id, req.body?.note);
  await ticket.save();
  await respond(res, ticket, 'Ticket acknowledged. Submit an invoice when the work is done.');
});

// POST /api/tickets/:id/invoice  (vendor who owns the ticket)
export const submitInvoice = asyncHandler(async (req, res) => {
  const { amount, description, invoiceNumber } = req.body;
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(
    ticket,
    ['acknowledged', 'invoiceRejected'],
    `An invoice can only be submitted after the ticket is acknowledged or after a rejection (this one is ${ticket.status})`
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
  assertStatus(ticket, 'invoiceSubmitted', `There is no invoice awaiting review on this ticket (status ${ticket.status})`);
  const invoice = await Invoice.findById(ticket.invoice);
  if (!invoice) throw new AppError('Invoice record is missing', 500, 'INVOICE_MISSING');
  if (invoice.status !== 'invoicePending') throw new AppError('Invoice has already been processed', 409, 'INVALID_STATE');

  invoice.status = 'approved';
  invoice.approvedAt = new Date();
  invoice.approvedBy = req.user._id;
  await invoice.save();

  ticket.transition('invoiceAccepted', req.user._id, req.body?.note);
  await ticket.save();
  await respond(res, ticket, 'Invoice accepted. The vendor can now close the ticket.');
});

// PUT /api/tickets/:id/invoice/reject  (supervisor)
export const rejectInvoice = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'invoiceSubmitted', `There is no invoice awaiting review on this ticket (status ${ticket.status})`);
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
  assertStatus(ticket, 'invoiceAccepted', `The invoice must be accepted before the ticket can be closed (this one is ${ticket.status})`);
  ticket.transition('completed', req.user._id, req.body?.note);
  await ticket.save();
  await respond(res, ticket, 'Ticket completed');
});
