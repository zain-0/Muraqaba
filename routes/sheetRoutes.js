import express from 'express';
import { getReadingSheet, setReading, getStatusSheet, setBusStatus, getRepairSheet, importReadings, previewReadingImport, getKmReport } from '../controllers/sheetController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateSheetMonth, validateReadingUpdate, validateBusStatusUpdate, validateReadingImport, validateKmRange } from '../middleware/validationMiddleware.js';
import { parseAttachments } from '../utils/uploads.js';

const router = express.Router();

router.use(authMiddleware);

const VIEWERS = ['serviceCreator', 'supervisor'];
const EDITORS = ['serviceCreator'];

router.get('/readings', roleMiddleware(VIEWERS), validateSheetMonth, getReadingSheet);
router.put('/readings', roleMiddleware(EDITORS), validateReadingUpdate, setReading);
router.get('/readings/report', roleMiddleware(VIEWERS), validateKmRange, getKmReport);
// Importing from Excel (2026-11-11): a preview that writes nothing, then the import itself.
router.post('/readings/import/preview', roleMiddleware(EDITORS), parseAttachments, validateReadingImport, previewReadingImport);
router.post('/readings/import', roleMiddleware(EDITORS), parseAttachments, validateReadingImport, importReadings);
router.get('/status', roleMiddleware(VIEWERS), validateSheetMonth, getStatusSheet);
router.put('/status', roleMiddleware(EDITORS), validateBusStatusUpdate, setBusStatus);
router.get('/repairs', roleMiddleware(VIEWERS), validateSheetMonth, getRepairSheet);

export default router;
