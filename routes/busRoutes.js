import express from 'express';
import { getAllBuses, getBusById, createBus } from '../controllers/busController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateBusCreate, validateObjectId } from '../middleware/validationMiddleware.js';

const router = express.Router();

// Middleware to log API calls
router.use((req, res, next) => {
    console.log(`API Called: ${req.method} ${req.originalUrl}`);
    next();
});

// Route to get all buses (requires authentication and specific roles)
router.get('/', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor', 'purchaseManager']), getAllBuses);

// Route to get a single bus by ID (requires authentication and specific roles)
router.get('/:id', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor', 'purchaseManager']), validateObjectId, getBusById);

// Route to create a new bus (requires authentication and specific roles)
router.post('/create', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor']), validateBusCreate, createBus);

export default router;
