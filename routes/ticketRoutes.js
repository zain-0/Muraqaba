import express from 'express';
import {
  createTicket,
  listTickets,
  getAllPendingTickets,
  getMyTickets,
  getCompletedTickets,
  getTicketById,
  approveTicket,
  acknowledgeTicket,
  submitInvoice,
  acceptInvoice,
  rejectInvoice,
  completeTicket,
  cancelTicket,
} from '../controllers/ticketController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import {
  validateTicketCreate,
  validateInvoiceSubmit,
  validateInvoiceReject,
  validateTicketCancel,
  validateTransitionNote,
  validateObjectId,
  validateTicketListQuery,
} from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

const CREATORS = ['serviceCreator', 'supervisor'];

// Create
router.post('/', roleMiddleware(CREATORS), validateTicketCreate, createTicket);
router.post('/create', roleMiddleware(CREATORS), validateTicketCreate, createTicket); // legacy path

// Lists (all role-scoped inside the controller)
router.get('/', validateTicketListQuery, listTickets);
router.get('/pending', roleMiddleware(CREATORS), validateTicketListQuery, getAllPendingTickets);
router.get('/my-tickets', roleMiddleware(CREATORS), validateTicketListQuery, getMyTickets);
router.get('/completed', validateTicketListQuery, getCompletedTickets);

// Single ticket (vendors only see their own)
router.get('/:id', validateObjectId, getTicketById);

// Lifecycle transitions
router.put('/:id/approve', roleMiddleware(['supervisor']), validateObjectId, validateTransitionNote, approveTicket);
router.put('/:id/cancel', roleMiddleware(['supervisor', 'serviceCreator']), validateObjectId, validateTicketCancel, cancelTicket);
router.put('/:id/acknowledge', roleMiddleware(['vendor']), validateObjectId, validateTransitionNote, acknowledgeTicket);
router.post('/:id/invoice', roleMiddleware(['vendor']), validateObjectId, validateInvoiceSubmit, submitInvoice);
router.put('/:id/invoice/accept', roleMiddleware(['supervisor']), validateObjectId, validateTransitionNote, acceptInvoice);
router.put('/:id/invoice/reject', roleMiddleware(['supervisor']), validateObjectId, validateInvoiceReject, rejectInvoice);
router.put('/:id/complete', roleMiddleware(['vendor']), validateObjectId, validateTransitionNote, completeTicket);

export default router;
