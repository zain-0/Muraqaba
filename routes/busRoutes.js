import express from 'express';
import { getAllBuses, getBusById, createBus } from '../controllers/busController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateBusCreate, validateObjectId } from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

const MANAGERS = ['serviceCreator', 'supervisor'];

// Vendors get only their own buses, to choose from when reporting a fault.
router.get('/', getAllBuses);
router.post('/', roleMiddleware(MANAGERS), validateBusCreate, createBus);
router.post('/create', roleMiddleware(MANAGERS), validateBusCreate, createBus); // legacy path
router.get('/:id', roleMiddleware(['serviceCreator', 'supervisor', 'purchaseManager']), validateObjectId, getBusById);

export default router;
