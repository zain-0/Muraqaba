import express from 'express';
import { 
  createTicket, 
  updateTicketStatus, 
  approveTicket, 
  submitInvoice, 
  submitRepairRequest, 
  acceptInvoice, 
  rejectInvoice, 
  getAllTickets, 
  getTicketById, 
  getMyTickets, 
  getCompletedTickets 
} from '../controllers/ticketController.js';

import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';

const router = express.Router();

// Route for creating a new ticket (Service Creator, Supervisor)
router.post('/create', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor']), createTicket);

// Route for updating ticket status (Service Creator, Supervisor, Vendor)
router.put('/update/:id', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor', 'vendor']), updateTicketStatus);

// Route for approving a ticket (Initial Approval by Supervisor)
router.put('/approve/:id', authMiddleware, roleMiddleware(['supervisor']), approveTicket);

// Route for vendor to submit invoice (Vendor)
router.put('/invoice/:id', authMiddleware, roleMiddleware(['vendor']), submitInvoice);

// Route for vendor to request repair (Vendor)
router.put('/request-repair/:id', authMiddleware, roleMiddleware(['vendor']), submitRepairRequest);

// Route for invoice supervisor to accept invoice (Invoice Acceptance)
router.put('/invoice/accept/:id', authMiddleware, roleMiddleware(['supervisor']), acceptInvoice);

// Route for invoice supervisor to reject invoice (Invoice Rejection)
router.put('/invoice/reject/:id', authMiddleware, roleMiddleware(['supervisor']), rejectInvoice);

// Route for viewing all tickets (Service Creator, Supervisor)
router.get('/', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor']), getAllTickets);

// Route for viewing a specific ticket (Vendor can interact with their tickets)
router.get('/:id', authMiddleware, getTicketById);

// Route for Service Creator to view tickets ("my tickets")
router.get('/my-tickets', authMiddleware, roleMiddleware(['serviceCreator']), getMyTickets);

// Route for Purchase Manager to view completed tickets (Purchase Manager)
router.get('/completed', authMiddleware, roleMiddleware(['purchaseManager']), getCompletedTickets);

export default router; // Export the router as default
