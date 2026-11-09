import express from 'express';
import { getAllBuses, getBusById, createBus, updateBus } from '../controllers/busController.js';
import { downloadSaleAttachment, recordSale } from '../controllers/scrapController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateAttachmentParams, validateBusCreate, validateBusUpdate, validateObjectId, validateSale } from '../middleware/validationMiddleware.js';
import { parseAttachments } from '../utils/uploads.js';

const router = express.Router();

router.use(authMiddleware);

const MANAGERS = ['serviceCreator', 'supervisor'];
const READERS = [...MANAGERS, 'purchaseManager'];

router.get('/', roleMiddleware(READERS), getAllBuses);
router.post('/', roleMiddleware(MANAGERS), validateBusCreate, createBus);
router.post('/create', roleMiddleware(MANAGERS), validateBusCreate, createBus); // legacy path
router.get('/:id', roleMiddleware(READERS), validateObjectId, getBusById);
router.put('/:id', roleMiddleware(['serviceCreator']), validateObjectId, validateBusUpdate, updateBus);
router.put('/:id/sale', roleMiddleware(['supervisor']), validateObjectId, parseAttachments, validateSale, recordSale);
router.get('/:id/sale/attachments/:attachmentId', roleMiddleware(READERS), validateAttachmentParams, downloadSaleAttachment);

export default router;
