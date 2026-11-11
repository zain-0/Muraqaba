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
  scanQuotationFile,
  submitEstimate,
  replyToEstimate,
  escalateTicket,
  downloadAttachment,
  acknowledgeTicket,
  submitInvoice,
  acceptInvoice,
  rejectInvoice,
  updateAccident,
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
  validateScan,
  validateAcknowledge,
  validateAttachmentParams,
  validateObjectId,
  validateTicketListQuery,
  validateStepDate,
  validateVehicleReceived,
  validateVehicleReturned,
  validateWorkStart,
  validateAccident,
} from '../middleware/validationMiddleware.js';

import { parseAttachments } from '../utils/uploads.js';

const router = express.Router();

router.use(authMiddleware);

const CREATORS = ['serviceCreator', 'supervisor'];
const SERVICE_CREATOR = ['serviceCreator'];
// The vendor's own steps. The service creator records them for a vendor outside the list, who
// cannot sign in (2026-11-11); assertVendorOwns refuses the creator on any other VSR.
const VENDOR = ['vendor', 'serviceCreator'];

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
router.post('/:id/additional', roleMiddleware(VENDOR), validateObjectId, parseAttachments, validateAdditionalJob, createAdditionalJob);
router.put('/:id/details', roleMiddleware(CREATORS), validateObjectId, validateTicketCreate, correctTicketDetails);
router.put('/:id', roleMiddleware(CREATORS), validateObjectId, validateTicketCreate, correctTicketDetails); // the same correction, as the 2026-11-10 plan names it
router.put('/:id/accident', roleMiddleware(CREATORS), validateObjectId, validateAccident, updateAccident); // any stage; never shown to vendors
router.post('/:id/estimate', roleMiddleware(VENDOR), validateObjectId, parseAttachments, validateEstimate, submitEstimate);
router.post('/:id/estimate/reply', roleMiddleware(CREATORS), validateObjectId, parseAttachments, validateEstimateReply, replyToEstimate);
router.put('/:id/escalate', roleMiddleware(CREATORS), validateObjectId, validateTransitionNote, escalateTicket);
router.post('/:id/scan-quotation', roleMiddleware(SERVICE_CREATOR), validateObjectId, validateScan, scanQuotationFile);
router.put('/:id/breakdown', roleMiddleware(SERVICE_CREATOR), validateObjectId, validateBreakdown, saveBreakdown);
router.put('/:id/acknowledge', roleMiddleware(VENDOR), validateObjectId, validateAcknowledge, acknowledgeTicket);
router.put('/:id/vehicle/sent', roleMiddleware(SERVICE_CREATOR), validateObjectId, validateStepDate, markVehicleSent);
router.put('/:id/vehicle/received', roleMiddleware(VENDOR), validateObjectId, validateVehicleReceived, markVehicleReceived);
router.put('/:id/work/start', roleMiddleware(VENDOR), validateObjectId, validateWorkStart, startWork);
router.put('/:id/work/ready', roleMiddleware(VENDOR), validateObjectId, validateStepDate, markReady);
router.put('/:id/vehicle/release', roleMiddleware(VENDOR), validateObjectId, validateStepDate, releaseVehicle);
router.put('/:id/vehicle/returned', roleMiddleware(SERVICE_CREATOR), validateObjectId, validateVehicleReturned, markVehicleReturned);
router.post('/:id/invoice', roleMiddleware(VENDOR), validateObjectId, parseAttachments, validateInvoiceSubmit, submitInvoice);
router.put('/:id/invoice/accept', roleMiddleware(['supervisor']), validateObjectId, validateTransitionNote, acceptInvoice);
router.put('/:id/invoice/reject', roleMiddleware(['supervisor']), validateObjectId, validateInvoiceReject, rejectInvoice);
router.put('/:id/invoice/received', roleMiddleware(SERVICE_CREATOR), validateObjectId, validateStepDate, markInvoiceReceived);
router.put('/:id/forward', roleMiddleware(SERVICE_CREATOR), validateObjectId, validateStepDate, forwardToPurchase);

export default router;
