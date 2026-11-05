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
  declineTicket,
  correctTicketDetails,
  saveBreakdown,
  submitEstimate,
  replyToEstimate,
  escalateTicket,
  downloadAttachment,
  acknowledgeTicket,
  submitInvoice,
  acceptInvoice,
  rejectInvoice,
} from '../controllers/ticketController.js';
import {
  markVehicleSent,
  markVehicleReceived,
  startWork,
  markReady,
  releaseVehicle,
  markVehicleReturned,
  markInvoiceReceived,
  forwardToPurchase,
  createAdditionalJob,
} from '../controllers/workshopController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import {
  validateTicketCreate,
  validateInvoiceSubmit,
  validateInvoiceReject,
  validateTransitionNote,
  validateTicketReturn,
  validateTicketDecline,
  validateAdditionalJob,
  validateEstimate,
  validateEstimateReply,
  validateBreakdown,
  validateAcknowledge,
  validateAttachmentParams,
  validateObjectId,
  validateTicketListQuery,
  validateStepDate,
  validateVehicleReceived,
  validateVehicleReturned,
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
router.put('/:id/decline', roleMiddleware(['supervisor']), validateObjectId, validateTicketDecline, declineTicket);
router.post('/:id/additional', roleMiddleware(['vendor']), validateObjectId, parseAttachments, validateAdditionalJob, createAdditionalJob);
router.put('/:id/details', roleMiddleware(CREATORS), validateObjectId, validateTicketCreate, correctTicketDetails);
router.post('/:id/estimate', roleMiddleware(['vendor']), validateObjectId, parseAttachments, validateEstimate, submitEstimate);
router.post('/:id/estimate/reply', roleMiddleware(CREATORS), validateObjectId, parseAttachments, validateEstimateReply, replyToEstimate);
router.put('/:id/escalate', roleMiddleware(CREATORS), validateObjectId, validateTransitionNote, escalateTicket);
router.put('/:id/breakdown', roleMiddleware(CREATORS), validateObjectId, validateBreakdown, saveBreakdown);
router.put('/:id/acknowledge', roleMiddleware(['vendor']), validateObjectId, validateAcknowledge, acknowledgeTicket);
router.put('/:id/vehicle/sent', roleMiddleware(CREATORS), validateObjectId, validateStepDate, markVehicleSent);
router.put('/:id/vehicle/received', roleMiddleware(['vendor']), validateObjectId, validateVehicleReceived, markVehicleReceived);
router.put('/:id/work/start', roleMiddleware(['vendor']), validateObjectId, validateStepDate, startWork);
router.put('/:id/work/ready', roleMiddleware(['vendor']), validateObjectId, validateStepDate, markReady);
router.put('/:id/vehicle/release', roleMiddleware(['vendor']), validateObjectId, validateStepDate, releaseVehicle);
router.put('/:id/vehicle/returned', roleMiddleware(CREATORS), validateObjectId, validateVehicleReturned, markVehicleReturned);
router.post('/:id/invoice', roleMiddleware(['vendor']), validateObjectId, parseAttachments, validateInvoiceSubmit, submitInvoice);
router.put('/:id/invoice/accept', roleMiddleware(['supervisor']), validateObjectId, validateTransitionNote, acceptInvoice);
router.put('/:id/invoice/reject', roleMiddleware(['supervisor']), validateObjectId, validateInvoiceReject, rejectInvoice);
router.put('/:id/invoice/received', roleMiddleware(CREATORS), validateObjectId, validateStepDate, markInvoiceReceived);
router.put('/:id/forward', roleMiddleware(CREATORS), validateObjectId, validateStepDate, forwardToPurchase);

export default router;
