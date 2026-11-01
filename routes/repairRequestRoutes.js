import express from 'express';
import {
  createRepairRequest,
  listRepairRequests,
  getPendingRepairRequests,
  updateRepairRequestStatus,
} from '../controllers/repairRequestController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import {
  validateRepairRequest,
  validateRepairRequestStatus,
  validateRepairRequestListQuery,
  validateObjectId,
} from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

const REVIEWERS = ['serviceCreator', 'supervisor'];

router.post('/', roleMiddleware(['vendor']), validateRepairRequest, createRepairRequest);
router.get('/', validateRepairRequestListQuery, listRepairRequests);
router.get('/pending', validateRepairRequestListQuery, getPendingRepairRequests);
router.put('/:id/status', roleMiddleware(REVIEWERS), validateObjectId, validateRepairRequestStatus, updateRepairRequestStatus);
router.put('/status/:id', roleMiddleware(REVIEWERS), validateObjectId, validateRepairRequestStatus, updateRepairRequestStatus); // legacy path

export default router;
