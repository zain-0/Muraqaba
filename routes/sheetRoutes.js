import express from 'express';
import { getReadingSheet, setReading, getStatusSheet, setBusStatus, getRepairSheet } from '../controllers/sheetController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateSheetMonth, validateReadingUpdate, validateBusStatusUpdate } from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

const VIEWERS = ['serviceCreator', 'supervisor'];
const EDITORS = ['serviceCreator'];

router.get('/readings', roleMiddleware(VIEWERS), validateSheetMonth, getReadingSheet);
router.put('/readings', roleMiddleware(EDITORS), validateReadingUpdate, setReading);
router.get('/status', roleMiddleware(VIEWERS), validateSheetMonth, getStatusSheet);
router.put('/status', roleMiddleware(EDITORS), validateBusStatusUpdate, setBusStatus);
router.get('/repairs', roleMiddleware(VIEWERS), validateSheetMonth, getRepairSheet);

export default router;
