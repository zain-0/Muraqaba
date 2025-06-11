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
  getCompletedTickets,
  getAllPendingTickets 
} from '../controllers/ticketController.js';

import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { 
  validateTicketCreate, 
  validateInvoiceSubmit, 
  validateObjectId, 
  validateStatus 
} from '../middleware/validationMiddleware.js';

const router = express.Router();

// Middleware to log API calls
router.use((req, res, next) => {
    console.log(`API Called: ${req.method} ${req.originalUrl}`);
    next();
});

// Route for creating a new ticket (Service Creator, Supervisor)
router.post('/create', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor']), validateTicketCreate, createTicket);

// Route for updating ticket status (Service Creator, Supervisor, Vendor)
// router.put('/update/:id', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor', 'vendor']), validateObjectId, validateStatus, updateTicketStatus);

// Route for approving a ticket (Initial Approval by Supervisor)
router.put('/approve/:id', authMiddleware, roleMiddleware(['supervisor']), validateObjectId, approveTicket);

// Route for vendor to submit invoice (Vendor)
router.put('/invoice/:id', authMiddleware, roleMiddleware(['vendor']), validateObjectId, validateInvoiceSubmit, submitInvoice);

// Route for vendor to request repair (Vendor)
// router.put('/request-repair/:id', authMiddleware, roleMiddleware(['vendor']), submitRepairRequest);111

// Route for invoice supervisor to accept invoice (Invoice Acceptance)
router.put('/invoice/accept/:id', authMiddleware, roleMiddleware(['supervisor']), validateObjectId, acceptInvoice);

// Route for invoice supervisor to reject invoice (Invoice Rejection)
router.put('/invoice/reject/:id', authMiddleware, roleMiddleware(['supervisor']), validateObjectId, rejectInvoice);

// Route for viewing all tickets (Service Creator, Supervisor)
router.get('/', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor']), getAllTickets);

// Route for getting all the pending tickets (Supervisor, Service Creator)
router.get('/pending', authMiddleware, roleMiddleware(['supervisor', 'serviceCreator']), getAllPendingTickets);

// Route for Service Creator to view tickets ("my tickets")
router.get('/my-tickets', authMiddleware, roleMiddleware(['serviceCreator']), getMyTickets);

// Route for Purchase Manager to view completed tickets (Purchase Manager)
router.get('/completed', authMiddleware, roleMiddleware(['purchaseManager']), getCompletedTickets);

// Route for viewing a specific ticket (Vendor can interact with their tickets)
router.get('/:id', authMiddleware, validateObjectId, getTicketById);

export default router; // Export the router as default
