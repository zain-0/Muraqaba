import express from 'express';
import repairRequestController from '../controllers/repairRequestController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';

const router = express.Router();

// Vendor creates a repair request
router.post('/', authMiddleware, roleMiddleware(['vendor',]), repairRequestController.createRepairRequest);

// Service Creator views all pending repair requests
router.get('/pending', authMiddleware, roleMiddleware(['serviceCreator','supervisor']), repairRequestController.getPendingRepairRequests);

// Service Creator updates the status of a repair request (pending -> resolved/rejected)
router.put('/status/:id', authMiddleware, roleMiddleware(['serviceCreator','supervisor']), repairRequestController.updateRepairRequestStatus);

export default router;
