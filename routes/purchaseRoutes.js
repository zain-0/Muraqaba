import express from 'express';
import { createGrn, createLpo, createPurchaseInvoice, exportBatch, getLpo, listGrns, listLpos } from '../controllers/purchaseController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateGrn, validateGrnExport, validateLpo, validateObjectId, validatePurchaseInvoice } from '../middleware/validationMiddleware.js';
import { parseAttachments } from '../utils/uploads.js';

const PURCHASING = roleMiddleware(['purchaseManager']);
const DEPOT = roleMiddleware(['purchaseManager', 'supervisor', 'serviceCreator']);

export const grnRoutes = express.Router();
grnRoutes.use(authMiddleware);
grnRoutes.get('/', DEPOT, listGrns);
grnRoutes.get('/export', PURCHASING, validateGrnExport, exportBatch);
grnRoutes.post('/', PURCHASING, parseAttachments, validateGrn, createGrn);

export const purchaseInvoiceRoutes = express.Router();
purchaseInvoiceRoutes.use(authMiddleware);
purchaseInvoiceRoutes.post('/', PURCHASING, parseAttachments, validatePurchaseInvoice, createPurchaseInvoice);

export const lpoRoutes = express.Router();
lpoRoutes.use(authMiddleware);
lpoRoutes.get('/', DEPOT, listLpos);
lpoRoutes.post('/', PURCHASING, validateLpo, createLpo);
lpoRoutes.get('/:id', DEPOT, validateObjectId, getLpo);
