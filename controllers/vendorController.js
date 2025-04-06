    import Ticket from '../models/Ticket.js';
    import Invoice from '../models/Invoice.js';
    import RepairRequest from '../models/RepairRequest.js';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';

    // Controller to get all tickets related to the vendor
const getVendorTickets = async (req, res) => {
    try {
        // Fetch all tickets where the vendorId matches the logged-in vendor's ID
        const vendorTickets = await Ticket.find({ vendorId: req.user._id }).populate('busId').exec();

        if (vendorTickets.length === 0) {
             return res.status(404).json({ message: 'No tickets found for this vendor.' });
            }

        return res.status(200).json(vendorTickets);
    } catch (error) {
            console.error(error);
            return res.status(500).json({ message: 'Server error, please try again later.' });
        }
    };

    // Controller to acknowledge a ticket (change status to 'acknowledged')
const acknowledgeTicket = async (req, res) => {
    try {
        const { id } = req.params;

        // Find the ticket by its ID
        const ticket = await Ticket.findById(id);

        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found.' });
        }

        // Check if the ticket is already acknowledged or not
        if (ticket.status === 'acknowledged') {
            return res.status(400).json({ message: 'Ticket is already acknowledged.' });
        }

        // Change the ticket status to 'acknowledged'
        ticket.status = 'acknowledged';
        ticket.acknowledgedAt = Date.now(); // Set the acknowledged timestamp
        ticket.acknowledgedBy = req.user._id; // Assuming the user acknowledging the ticket is the one making the request
        ticket.statusUpdated= Date.now(); // Update the status updated timestamp
        await ticket.save();

        return res.status(200).json({ message: 'Ticket acknowledged successfully.', ticket });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error, please try again later.' });
    }
};

    // Controller to submit an invoice (after ticket is acknowledged)
const submitInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, description } = req.body;

        // Find the ticket by its ID
        const ticket = await Ticket.findById(id);

        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found.' });
        }

            // Check if the ticket is acknowledged before submitting an invoice
            // if (ticket.status !== 'acknowledged') {
            //     return res.status(400).json({ message: 'Ticket must be acknowledged before submitting an invoice.' });
            // }

        if(!(ticket.status === 'invoice-submitted' || ticket.status === 'acknowledged')){
            return res.status(400).json({ message: 'You cannot Submit an Invoice right now' });
        }

        // Create the invoice for this ticket
        const newInvoice = new Invoice({
            ticketId: ticket._id,
            amount,
            description,
            status: 'invoice-Pending', // Default status is 'pending'
            createdBy: req.user._id, 
            vendorId: req.user._id// Logged-in user (vendor)
        });

            // Save the invoice
        await newInvoice.save();

        // Update the ticket with the invoice reference
        ticket.invoice = newInvoice._id;
        ticket.status = 'invoice-submitted'; // Change the ticket status to 'invoice-submitted'
        await ticket.save();

        return res.status(201).json({ message: 'Invoice submitted successfully.', invoice: newInvoice });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error, please try again later.' });
        }
};

    // Controller to submit a repair request (after ticket is acknowledged)
const submitRepairRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { description, repairCategory } = req.body;

        // Find the ticket by its ID
        const ticket = await Ticket.findById(id);

        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found.' });
        }

        // Check if the ticket is acknowledged before submitting a repair request
        if (ticket.status !== 'acknowledged') {
            return res.status(400).json({ message: 'Ticket must be acknowledged before submitting a repair request.' });
        }

        // Create the repair request
        const newRepairRequest = new RepairRequest({
            busId: ticket.busId, // The bus ID is from the ticket
            vendorId: req.user._id, // The vendor is the logged-in user
            description,
            repairCategory,
        });

            // Save the repair request
        await newRepairRequest.save();

        return res.status(201).json({ message: 'Repair request submitted successfully.', request: newRepairRequest });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error, please try again later.' });
    }
};


export const createVendor = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validate input
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'All fields are required: name, email, password.' });
    }

    // Check if user with same email exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: 'Email already exists.' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user with role: 'vendor'
    const newVendor = new User({
      name,
      email,
      password: hashedPassword,
      role: 'vendor',
    });

    await newVendor.save();

    res.status(201).json({
      message: 'Vendor created successfully',
      vendor: {
        _id: newVendor._id,
        name: newVendor.name,
        email: newVendor.email,
        role: newVendor.role,
      },
    });
  } catch (error) {
    console.error('Error creating vendor:', error);
    res.status(500).json({ message: 'Server error while creating vendor.' });
  }
};

export const completeTicket = async (req, res) => {
    try {
        const { id } = req.params;

        // Find the ticket by its ID
        const ticket = await Ticket.findById(id);

        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found.' });
        }

        // Check if the ticket is already completed or not
        if (ticket.status === 'completed') {
            return res.status(400).json({ message: 'Ticket is already completed.' });
        }

        if (!(ticket.status === 'invoice-accepted')) {
            return res.status(400).json({ message: 'You cannot complete the ticket right now.' });
        }

        // Change the ticket status to 'completed'
        ticket.status = 'completed';
        ticket.completedAt = Date.now(); // Set the completed timestamp
        ticket.statusUpdated= Date.now(); // Update the status updated timestamp
        await ticket.save();

        return res.status(200).json({ message: 'Ticket completed successfully.', ticket });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error, please try again later.' });
    }
};


    export default {
        createVendor,
        getVendorTickets,
        acknowledgeTicket,
        submitInvoice,
        submitRepairRequest,
        completeTicket
    };
