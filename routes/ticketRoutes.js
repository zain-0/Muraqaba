import express from 'express';
import {
  createTicket,
  listTickets,
  getAllPendingTickets,
  getMyTickets,
  getCompletedTickets,
  getTicketById,
  approveTicket,
  returnTicket,
  correctTicketDetails,
  submitEstimate,
  replyToEstimate,
  escalateTicket,
  downloadAttachment,
  acknowledgeTicket,
  submitInvoice,
  acceptInvoice,
  rejectInvoice,
  completeTicket,
} from '../controllers/ticketController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import {
  validateTicketCreate,
  validateInvoiceSubmit,
  validateInvoiceReject,
  validateTransitionNote,
  validateTicketReturn,
  validateEstimate,
  validateEstimateReply,
  validateAttachmentParams,
  validateObjectId,
  validateTicketListQuery,
} from '../middleware/validationMiddleware.js';

import { parseAttachments } from '../utils/uploads.js';

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
router.get('/:id/attachments/:attachmentId', validateAttachmentParams, downloadAttachment);

// Lifecycle transitions
router.put('/:id/approve', roleMiddleware(['supervisor']), validateObjectId, validateTransitionNote, approveTicket);
router.put('/:id/return', roleMiddleware(['supervisor']), validateObjectId, validateTicketReturn, returnTicket);
router.put('/:id/details', roleMiddleware(CREATORS), validateObjectId, validateTicketCreate, correctTicketDetails);
router.post('/:id/estimate', roleMiddleware(['vendor']), validateObjectId, parseAttachments, validateEstimate, submitEstimate);
router.post('/:id/estimate/reply', roleMiddleware(CREATORS), validateObjectId, parseAttachments, validateEstimateReply, replyToEstimate);
router.put('/:id/escalate', roleMiddleware(CREATORS), validateObjectId, validateTransitionNote, escalateTicket);
router.put('/:id/acknowledge', roleMiddleware(['vendor']), validateObjectId, validateTransitionNote, acknowledgeTicket);
router.post('/:id/invoice', roleMiddleware(['vendor']), validateObjectId, validateInvoiceSubmit, submitInvoice);
router.put('/:id/invoice/accept', roleMiddleware(['supervisor']), validateObjectId, validateTransitionNote, acceptInvoice);
router.put('/:id/invoice/reject', roleMiddleware(['supervisor']), validateObjectId, validateInvoiceReject, rejectInvoice);
router.put('/:id/complete', roleMiddleware(['vendor']), validateObjectId, validateTransitionNote, completeTicket);

export default router;
