import express from 'express';
import {
  approveScrapRequest,
  cancelScrapRequest,
  createScrapRequest,
  downloadScrapAttachment,
  getScrapRequest,
  listScrapRequests,
  rejectScrapRequest,
} from '../controllers/scrapController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import {
  validateAttachmentParams,
  validateObjectId,
  validateScrapApproval,
  validateScrapRejection,
  validateScrapRequest,
  validateScrapRequestList,
} from '../middleware/validationMiddleware.js';
import { parseAttachments } from '../utils/uploads.js';

// The depot only: vendors never see a bus leave the fleet.
const DEPOT = roleMiddleware(['purchaseManager', 'supervisor', 'serviceCreator']);
const CREATOR = roleMiddleware(['serviceCreator']);
const SUPERVISOR = roleMiddleware(['supervisor']);

const router = express.Router();
router.use(authMiddleware);

router.get('/', DEPOT, validateScrapRequestList, listScrapRequests);
router.post('/', CREATOR, parseAttachments, validateScrapRequest, createScrapRequest);
router.get('/:id', DEPOT, validateObjectId, getScrapRequest);
router.get('/:id/attachments/:attachmentId', DEPOT, validateAttachmentParams, downloadScrapAttachment);
router.put('/:id/approve', SUPERVISOR, validateObjectId, validateScrapApproval, approveScrapRequest);
router.put('/:id/reject', SUPERVISOR, validateObjectId, validateScrapRejection, rejectScrapRequest);
router.put('/:id/cancel', CREATOR, validateObjectId, cancelScrapRequest);

export default router;
