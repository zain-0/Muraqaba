import express from 'express';
import { getAllBuses, getBusById, createBus, updateBus } from '../controllers/busController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateBusCreate, validateBusUpdate, validateObjectId } from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

const MANAGERS = ['serviceCreator', 'supervisor'];

// Vendors see only their own buses; everyone else sees the fleet.
router.get('/', getAllBuses);
router.post('/', roleMiddleware(MANAGERS), validateBusCreate, createBus);
router.post('/create', roleMiddleware(MANAGERS), validateBusCreate, createBus); // legacy path
router.get('/:id', validateObjectId, getBusById);
router.put('/:id', roleMiddleware(MANAGERS), validateObjectId, validateBusUpdate, updateBus);

export default router;
