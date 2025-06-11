import Ticket from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import RepairRequest from '../models/RepairRequest.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

// Create a new ticket
export const createTicket = asyncHandler(async (req, res) => {
    const { busId, serviceType, vendorId, description, repairCategory } = req.body;
    const createdBy = req.user._id;
    
    // Validate repair category is provided for repair tickets
    if (serviceType === 'repair' && !repairCategory) {
        throw new AppError('Repair category is required for repair tickets', 400);
    }

    const newTicket = new Ticket({
        busId,
        serviceType,
        vendorId,
        createdBy,
        description: serviceType === 'repair' ? description : undefined,
        repairCategory: serviceType === 'repair' ? repairCategory : undefined,
    });

    await newTicket.save();
    await newTicket.populate(['busId', 'vendorId', 'createdBy']);
  
    res.status(201).json({ 
        success: true,
        message: 'Ticket created successfully', 
        data: newTicket 
    });
});

export const getAllPendingTickets = asyncHandler(async (req, res) => {
    const pendingTickets = await Ticket.find({ status: 'pending' })
        .populate('busId')
        .populate('vendorId', 'name email') 
        .populate('createdBy', 'name email')
        .populate('initialApprovedBy', 'name email');

    res.status(200).json({
        success: true,
        count: pendingTickets.length,
        data: pendingTickets
    });
});

// Update the status of the ticket
export const updateTicketStatus = asyncHandler(async (req, res) => {
    const ticketId = req.params.id;
    const { status } = req.body;
    
    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check permissions
    if (!['serviceCreator', 'supervisor', 'vendor'].includes(req.user.role)) {
        throw new AppError('You do not have permission to update this ticket', 403);
    }

    ticket.status = status;
    ticket.statusUpdated = Date.now();
    await ticket.save();

    res.status(200).json({ 
        success: true,
        message: 'Ticket status updated successfully', 
        data: ticket 
    });
});

// Approve a ticket
export const approveTicket = asyncHandler(async (req, res) => {
    const ticketId = req.params.id;
    const ticket = await Ticket.findById(ticketId);

    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check if ticket is in correct status for approval
    if (ticket.status !== 'pending') {
        throw new AppError('Only pending tickets can be approved', 400);
    }

    ticket.status = 'approved';
    ticket.initialApprovedBy = req.user._id;
    ticket.approvedAt = Date.now();
    ticket.statusUpdated = Date.now();
    await ticket.save();

    await ticket.populate(['busId', 'vendorId', 'createdBy', 'initialApprovedBy']);

    res.status(200).json({ 
        success: true,
        message: 'Ticket approved successfully', 
        data: ticket 
    });
});

// Submit an invoice
export const submitInvoice = asyncHandler(async (req, res) => {
    const ticketId = req.params.id;
    const { amount, description } = req.body;

    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check if ticket status allows invoice submission
    if (!(ticket.status === 'acknowledged' || ticket.status === 'invoiceRejected')) {
        throw new AppError('Ticket must be acknowledged or previously rejected before submitting an invoice', 400);
    }

    const invoice = new Invoice({
        ticketId,
        vendorId: ticket.vendorId,
        amount,
        description,
    });

    await invoice.save();

    ticket.status = 'invoiceSubmitted';
    ticket.invoice = invoice._id;
    ticket.invoiceSubmittedAt = Date.now();
    ticket.statusUpdated = Date.now();
    await ticket.save();

    res.status(200).json({ 
        success: true,
        message: 'Invoice submitted successfully', 
        data: invoice 
    });
});

// Submit a repair request
export const submitRepairRequest = asyncHandler(async (req, res) => {
    const ticketId = req.params.id;
    const { description, repairCategory } = req.body;

    const ticket = await Ticket.findById(ticketId);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    if (ticket.status !== 'acknowledged') {
        throw new AppError('Ticket must be acknowledged before submitting a repair request', 400);
    }

    const repairRequest = new RepairRequest({
        ticketId,
        vendorId: ticket.vendorId,
        description,
        repairCategory,
    });

    await repairRequest.save();

    ticket.status = 'repair-requested';
    ticket.repairRequest = repairRequest._id;
    ticket.statusUpdated = Date.now();
    await ticket.save();

    res.status(200).json({ 
        success: true,
        message: 'Repair request submitted successfully', 
        data: repairRequest 
    });
});

// Accept the invoice
export const acceptInvoice = asyncHandler(async (req, res) => {
    const invoiceId = req.params.id;
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) {
        throw new AppError('Invoice not found', 404);
    }

    const ticket = await Ticket.findById(invoice.ticketId);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check if invoice is in correct status
    if (invoice.status !== 'invoicePending') {
        throw new AppError('Invoice has already been processed', 400);
    }

    invoice.status = 'approved';
    invoice.approvedAt = Date.now();
    invoice.approvedBy = req.user._id;
    await invoice.save();

    // Update the ticket status
    ticket.status = 'invoiceAccepted';
    ticket.invoiceAcceptedAt = Date.now();
    ticket.invoiceApprovedBy = req.user._id;
    ticket.invoice = invoice._id;
    ticket.statusUpdated = Date.now();
    await ticket.save();

    res.status(200).json({ 
        success: true,
        message: 'Invoice accepted and ticket updated', 
        data: { ticket, invoice } 
    });
});


// Reject the invoice
export const rejectInvoice = asyncHandler(async (req, res) => {
    const invoiceId = req.params.id;
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) {
        throw new AppError('Invoice not found', 404);
    }

    const ticket = await Ticket.findById(invoice.ticketId);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check if invoice is in correct status
    if (invoice.status !== 'invoicePending') {
        throw new AppError('Invoice has already been processed', 400);
    }

    invoice.status = 'rejected';
    invoice.rejectedAt = Date.now();
    invoice.rejectedBy = req.user._id;
    await invoice.save();

    ticket.status = 'invoiceRejected';
    ticket.invoiceRejectedBy = req.user._id;
    ticket.invoiceRejectedAt = Date.now();
    ticket.statusUpdated = Date.now();
    await ticket.save();

    res.status(200).json({ 
        success: true,
        message: 'Invoice rejected', 
        data: { ticket, invoice } 
    });
});


// Get all tickets
export const getAllTickets = asyncHandler(async (req, res) => {
    const tickets = await Ticket.find()
        .populate('busId')
        .populate('vendorId', 'name email')
        .populate('createdBy', 'name email')
        .populate('initialApprovedBy', 'name email')
        .populate('invoiceApprovedBy', 'name email');
    
    res.status(200).json({
        success: true,
        count: tickets.length,
        data: tickets
    });
});

// Get a specific ticket by ID
export const getTicketById = asyncHandler(async (req, res) => {
    const ticketId = req.params.id;
    const ticket = await Ticket.findById(ticketId)
        .populate('busId')
        .populate('vendorId', 'name email')
        .populate('createdBy', 'name email')
        .populate('initialApprovedBy', 'name email')
        .populate('acknowledgedBy', 'name email')
        .populate('invoiceApprovedBy', 'name email')
        .populate('invoice');

    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    res.status(200).json({
        success: true,
        data: ticket
    });
});

// Get "my tickets"
export const getMyTickets = asyncHandler(async (req, res) => {
    const myTickets = await Ticket.find({ createdBy: req.user._id })
        .populate('busId')
        .populate('vendorId', 'name email')
        .populate('initialApprovedBy', 'name email');
    
    res.status(200).json({
        success: true,
        count: myTickets.length,
        data: myTickets
    });
});

// Get completed tickets
export const getCompletedTickets = asyncHandler(async (req, res) => {
    const completedTickets = await Ticket.find({ status: 'completed' })
        .populate('busId')
        .populate('vendorId', 'name email')
        .populate('createdBy', 'name email')
        .populate('invoice');
    
    res.status(200).json({
        success: true,
        count: completedTickets.length,
        data: completedTickets
    });
});
