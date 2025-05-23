import Ticket from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import RepairRequest from '../models/RepairRequest.js';

// Create a new ticket
export const createTicket = async (req, res) => {
  try {
    const { busId, serviceType, vendorId, description, repairCategory } = req.body;
    const createdBy = req.user._id;
    

    const newTicket = new Ticket({
      busId,
      serviceType,
      vendorId,
      createdBy,
      description: serviceType === 'repair' ? description : undefined,
      repairCategory: serviceType === 'repair' ? repairCategory : undefined,
      
    });

    await newTicket.save();
  
    res.status(201).json({ message: 'Ticket created successfully', ticket: newTicket });
  } catch (err) {
    res.status(500).json({ message: 'Error creating ticket', error: err });
  }
};

export const getAllPendingTickets = async (req, res) => {
  try {
    const pendingTickets = await Ticket.find({ status: 'pending' })
      .populate('busId')
      .populate('vendorId') 
      .populate('createdBy')
      .populate('initialApprovedBy')

      if (!pendingTickets) {
        return res.status(404).json({ message: 'No pending tickets found' });
      }
    res.status(200).json(pendingTickets);
  } catch (error) { 
    res.status(500).json({ message: 'Error fetching pending tickets', error: error });
  }
};

// Update the status of the ticket
export const updateTicketStatus = async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { status } = req.body;
    const ticket = await Ticket.findById(ticketId);

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    if (!['serviceCreator', 'supervisor', 'vendor'].includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to update this ticket' });
    }

    ticket.status = status;
    ticket.updatedAt = Date.now();
    await ticket.save();

    res.status(200).json({ message: 'Ticket status updated successfully', ticket });
  } catch (err) {
    res.status(500).json({ message: 'Error updating ticket status', error: err });
  }
};

// Approve a ticket
export const approveTicket = async (req, res) => {
  try {
    const ticketId = req.params.id;
    const ticket = await Ticket.findById(ticketId);

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    ticket.status = 'approved';
    // approvedByUser = await User.findById(req.user._id);
    ticket.initialApprovedBy = req.user._id;;
    // console.log(ticket.initialApprovedBy);
    // console.log('user:' + req.user._id);
    ticket.approvedAt = Date.now();
    ticket.updatedAt = Date.now();
    ticket.statusUpdated = Date.now(); // Update the status updated timestamp
    await ticket.save();

    res.status(200).json({ message: 'Ticket approved successfully', ticket });
  } catch (err) {
    res.status(500).json({ message: 'Error approving ticket', error: err });
  }
};

// Submit an invoice
export const submitInvoice = async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { amount, description } = req.body;

    const ticket = await Ticket.findById(ticketId);

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    if ((ticket.status == 'acknowledged' || ticket.status == 'invoiceRejected')) {

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
    ticket.invoiceApprovedBy = req.user._id; // Assuming the user submitting the invoice is the one making the request
    ticket.updatedAt = Date.now();
    await ticket.save();

    res.status(200).json({ message: 'Invoice submitted successfully', invoice });
  } else {
    return res.status(400).json({ message: 'Ticket must be acknowledged before submitting an invoice or wait for the invoice to be accepted or rejected' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Error submitting invoice', error: err });
  }
};

// Submit a repair request
export const submitRepairRequest = async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { description, repairCategory } = req.body;

    const ticket = await Ticket.findById(ticketId);

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    if (ticket.status !== 'acknowledged') {
      return res.status(400).json({ message: 'Ticket must be acknowledged before submitting a repair request' });
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
    ticket.updatedAt = Date.now();
    await ticket.save();

    res.status(200).json({ message: 'Repair request submitted successfully', repairRequest });
  } catch (err) {
    res.status(500).json({ message: 'Error submitting repair request', error: err });
  }
};

// Accept the invoice
// export const acceptInvoice = async (req, res) => {
//   try {
//     const invoiceId  = req.params.id;
//     const invoice = await Invoice.findById(invoiceId);

//     if (!invoice) {
//       return res.status(400).json({ message: 'No invoice attached to this ticket' });
//     }

//     ticket=invoice.ticketId;
//     if (!ticket) {
//       return res.status(404).json({ message: 'Ticket not found' });
//     }

//     invoice.status = 'approved';
//     invoice.approvedAt = Date.now();
//     invoice.approvedBy = req.user._id; // Assuming the user accepting the invoice is the one making the request
//     ticket.invoiceAcceptedAt = Date.now(); // optional timestamp
//     ticket.invoiceApprovedBy = req.user._id; // Assuming the user accepting the invoice is the one making the request
//     await invoice.save();

//     ticket.status = 'invoice-accepted';
//     ticket.invoiceAcceptedAt = Date.now();
//     ticket.invoiceApprovedBy = req.user._id; // Assuming the user accepting the invoice is the one making the request
//     ticket.invoiceApprovedBy = req.user._id; // Assuming the user accepting the invoice is the one making the request
//     ticket.updatedAt = Date.now();
//     await ticket.save();

//     res.status(200).json({ message: 'Invoice accepted and ticket completed', ticket, invoice });
//   } catch (err) {
//     res.status(500).json({ message: 'Error accepting invoice', error: err });
//   }
// };
export const acceptInvoice = async (req, res) => {
  try {
    const invoiceId = req.params.id;
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) {
      return res.status(400).json({ message: 'Invoice not found' });
    }

    const ticket = await Ticket.findById(invoice.ticketId); // Ensure you fetch the ticket by ID

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    invoice.status = 'approved';
    invoice.approvedAt = Date.now();
    invoice.approvedBy = req.user._id;

    // Save the updated invoice
    await invoice.save();

    // Update the ticket status, assign invoice to ticket, and set invoice approval details
    ticket.status = 'invoiceAccepted';
    ticket.invoiceAcceptedAt = Date.now();
    ticket.invoiceApprovedBy = req.user._id;
    ticket.invoice = invoice._id; // Attach the invoice to the ticket
    ticket.updatedAt = Date.now();

    // Save the updated ticket
    await ticket.save();

    // Send response
    res.status(200).json({ message: 'Invoice accepted and ticket updated', ticket, invoice });
  } catch (err) {
    res.status(500).json({ message: 'Error accepting invoice', error: err });
  }
};


// Reject the invoice
// export const rejectInvoice = async (req, res) => {
//   try {
//     const invoiceId = req.params.id;
//     const invoice = await Invoice.findById(invoiceId);

//     if (!invoice) {
//       return res.status(404).json({ message: 'Invoice not found' });
//     }

//     invoice.status = 'rejected';
//     await invoice.save();

//     ticket=invoice.ticketId;
//     if (!ticket) {  
//       return res.status(400).json({ message: 'No invoice attached to this ticket' });
//     }

//     ticket.status = 'invoice-rejected';
//     ticket.updatedAt = Date.now();
//     await ticket.save();

//     res.status(200).json({ message: 'Invoice rejected', ticket, invoice });
//   } catch (err) {
//     res.status(500).json({ message: 'Error rejecting invoice', error: err });
//   }
// };
export const rejectInvoice = async (req, res) => {
  try {
    const invoiceId = req.params.id;
    // console.log('Invoice ID:', invoiceId); // Log the invoice ID for debugging
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    invoice.status = 'rejected';
    invoice.rejectedAt = Date.now(); // optional timestamp
    invoice.rejectedBy = req.user._id; // Assuming the user rejecting the invoice is the one making the request
    await invoice.save();

    const ticket = await Ticket.findById(invoice.ticketId); // ✅ properly fetch ticket
    if (!ticket) {
      return res.status(400).json({ message: 'No ticket associated with this invoice' });
    }

    ticket.status = 'invoiceRejected';
    ticket.invoiceRejectedBy = req.user._id; // Assuming the user rejecting the invoice is the one making the request
    ticket.invoiceRejectedAt = new Date(); // optional timestamp
    ticket.updatedAt = Date.now();
    await ticket.save();

    res.status(200).json({ message: 'Invoice rejected', ticket, invoice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error rejecting invoice', error: err });
  }
};


// Get all tickets
export const getAllTickets = async (req, res) => {
  try {
    const tickets = await Ticket.find().populate('busId').populate('vendorId').populate('createdBy');
    res.status(200).json(tickets);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching tickets', error: err });
  }
};

// Get a specific ticket by ID
export const getTicketById = async (req, res) => {
  try {
    const ticketId = req.params.id;
    const ticket = await Ticket.findById(ticketId)
      .populate('busId')
      .populate('vendorId')
      .populate('createdBy')
      .populate('invoice');

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    res.status(200).json(ticket);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching ticket', error: err });
  }
};

// Get "my tickets"
export const getMyTickets = async (req, res) => {
  try {
    const myTickets = await Ticket.find({ createdBy: req.user._id }).populate('busId').populate('vendorId');
    res.status(200).json(myTickets);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching my tickets', error: err });
  }
};

// Get completed tickets
export const getCompletedTickets = async (req, res) => {
  try {
    const completedTickets = await Ticket.find({ status: 'completed' }).populate('busId').populate('vendorId');
    res.status(200).json(completedTickets);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching completed tickets', error: err });
  }
};
