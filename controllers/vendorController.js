    import Ticket from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import RepairRequest from '../models/RepairRequest.js';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

// Controller to get all tickets related to the vendor
export const getVendorTickets = asyncHandler(async (req, res) => {
    // Fetch all tickets where the vendorId matches the logged-in vendor's ID
    const vendorTickets = await Ticket.find({ vendorId: req.user._id })
        .populate('busId')
        .populate('createdBy', 'name email')
        .populate('initialApprovedBy', 'name email');

    res.status(200).json({
        success: true,
        count: vendorTickets.length,
        data: vendorTickets
    });
});

// Controller to acknowledge a ticket (change status to 'acknowledged')
export const acknowledgeTicket = asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Find the ticket by its ID
    const ticket = await Ticket.findById(id);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check if the ticket is in correct status for acknowledgment
    if (ticket.status !== 'approved') {
        throw new AppError('Ticket must be approved before it can be acknowledged', 400);
    }

    // Check if the ticket is already acknowledged
    if (ticket.status === 'acknowledged') {
        throw new AppError('Ticket is already acknowledged', 400);
    }

    // Change the ticket status to 'acknowledged'
    ticket.status = 'acknowledged';
    ticket.acknowledgedAt = Date.now();
    ticket.acknowledgedBy = req.user._id;
    ticket.statusUpdated = Date.now();
    await ticket.save();    await ticket.populate(['busId', 'createdBy', 'acknowledgedBy']);

    res.status(200).json({ 
        success: true,
        message: 'Ticket acknowledged successfully', 
        data: ticket 
    });
});

// Controller to submit an invoice (after ticket is acknowledged)
export const submitInvoice = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, description } = req.body;

    // Find the ticket by its ID
    const ticket = await Ticket.findById(id);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check if the ticket status allows invoice submission
    if (!(ticket.status === 'acknowledged' || ticket.status === 'invoiceRejected')) {
        throw new AppError('You cannot submit an invoice right now. Ticket must be acknowledged or previously rejected', 400);
    }

    // Create the invoice for this ticket
    const newInvoice = new Invoice({
        ticketId: ticket._id,
        amount,
        description,
        vendorId: req.user._id
    });

    // Save the invoice
    await newInvoice.save();

    // Update the ticket with the invoice reference
    ticket.invoice = newInvoice._id;
    ticket.status = 'invoiceSubmitted';
    ticket.invoiceSubmittedAt = Date.now();
    ticket.statusUpdated = Date.now();
    await ticket.save();    res.status(201).json({ 
        success: true,
        message: 'Invoice submitted successfully', 
        data: newInvoice 
    });
});

// Controller to submit a repair request (after ticket is acknowledged)
export const submitRepairRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { description, repairCategory } = req.body;

    // Find the ticket by its ID
    const ticket = await Ticket.findById(id);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check if the ticket is acknowledged before submitting a repair request
    if (ticket.status !== 'acknowledged') {
        throw new AppError('Ticket must be acknowledged before submitting a repair request', 400);
    }

    // Create the repair request
    const newRepairRequest = new RepairRequest({
        busId: ticket.busId,
        vendorId: req.user._id,
        description,
        repairCategory,
    });

    // Save the repair request
    await newRepairRequest.save();
    await newRepairRequest.populate(['busId', 'vendorId']);

    res.status(201).json({ 
        success: true,
        message: 'Repair request submitted successfully', 
        data: newRepairRequest 
    });
});


export const createVendor = asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;

    // Check if user with same email exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        throw new AppError('Email already exists', 409);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create new user with role: 'vendor'
    const newVendor = new User({
        name,
        email,
        password: hashedPassword,
        role: 'vendor',
    });

    await newVendor.save();

    res.status(201).json({
        success: true,
        message: 'Vendor created successfully',
        data: {
            _id: newVendor._id,
            name: newVendor.name,
            email: newVendor.email,
            role: newVendor.role,
        },
    });
});

export const completeTicket = asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Find the ticket by its ID
    const ticket = await Ticket.findById(id);
    if (!ticket) {
        throw new AppError('Ticket not found', 404);
    }

    // Check if the ticket is already completed
    if (ticket.status === 'completed') {
        throw new AppError('Ticket is already completed', 400);
    }

    // Check if the ticket status allows completion
    if (ticket.status !== 'invoiceAccepted') {
        throw new AppError('You cannot complete the ticket right now. Invoice must be accepted first', 400);
    }

    // Change the ticket status to 'completed'
    ticket.status = 'completed';
    ticket.completedAt = Date.now();
    ticket.statusUpdated = Date.now();
    await ticket.save();    await ticket.populate(['busId', 'createdBy', 'acknowledgedBy']);

    res.status(200).json({ 
        success: true,
        message: 'Ticket completed successfully', 
        data: ticket 
    });
});
