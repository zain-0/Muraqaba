import express from 'express';
import { 
    createRepairRequest, 
    getPendingRepairRequests, 
    updateRepairRequestStatus 
} from '../controllers/repairRequestController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateRepairRequest, validateObjectId, validateStatus } from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use((req, res, next) => {
    console.log(`API Called: ${req.method} ${req.originalUrl}`);
    next();
});

// Vendor creates a repair request
router.post('/', authMiddleware, roleMiddleware(['vendor']), validateRepairRequest, createRepairRequest);

// Service Creator views all pending repair requests
router.get('/pending', authMiddleware, roleMiddleware(['serviceCreator','supervisor']), getPendingRepairRequests);

// Service Creator updates the status of a repair request (pending -> resolved/rejected)
router.put('/status/:id', authMiddleware, roleMiddleware(['serviceCreator','supervisor']), validateObjectId, validateStatus, updateRepairRequestStatus);

export default router;
