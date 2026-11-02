import express from 'express';
import { getAllBuses, getBusById, createBus } from '../controllers/busController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateBusCreate, validateObjectId } from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

const MANAGERS = ['serviceCreator', 'supervisor'];
const READERS = [...MANAGERS, 'purchaseManager'];

router.get('/', roleMiddleware(READERS), getAllBuses);
router.post('/', roleMiddleware(MANAGERS), validateBusCreate, createBus);
router.post('/create', roleMiddleware(MANAGERS), validateBusCreate, createBus); // legacy path
router.get('/:id', roleMiddleware(READERS), validateObjectId, getBusById);

export default router;
