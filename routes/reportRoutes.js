import express from 'express';
import {
  accidentsReport,
  availabilityReport,
  categoriesReport,
  costsReport,
  downtimeReport,
  fleetFigures,
  freeWorkReport,
  invoiceCheckReport,
  kmReport,
  lpoBalancesReport,
  runQuery,
  vendorsReport,
  weeklyReport,
} from '../controllers/reportController.js';
import { listNotifications, markAllRead, markRead } from '../controllers/notificationController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateFleetFigures, validateObjectId, validateReportQuery } from '../middleware/validationMiddleware.js';
import { validateCosts, validateInvoiceCheck, validateLpoBalances, validateYear, validateYearBrand, validateYearMonth, validateYearMonthBrand } from '../middleware/reportValidation.js';

const PURCHASING = roleMiddleware(['purchaseManager']);
const DEPOT = roleMiddleware(['purchaseManager', 'supervisor', 'serviceCreator']);

export const reportRoutes = express.Router();
reportRoutes.use(authMiddleware);
reportRoutes.get('/query', PURCHASING, validateReportQuery, runQuery);
reportRoutes.get('/fleet', roleMiddleware(['serviceCreator', 'supervisor', 'purchaseManager']), validateFleetFigures, fleetFigures);
reportRoutes.get('/weekly', roleMiddleware(['supervisor', 'purchaseManager']), weeklyReport);
reportRoutes.get('/availability', PURCHASING, validateYearMonth, availabilityReport);
reportRoutes.get('/downtime', PURCHASING, validateYearMonthBrand, downtimeReport);
reportRoutes.get('/costs', PURCHASING, validateCosts, costsReport);
reportRoutes.get('/vendors', PURCHASING, validateYearMonth, vendorsReport);
reportRoutes.get('/km', PURCHASING, validateYear, kmReport);
reportRoutes.get('/categories', PURCHASING, validateYearBrand, categoriesReport);
reportRoutes.get('/accidents', PURCHASING, validateYear, accidentsReport);
reportRoutes.get('/free-work', PURCHASING, validateYear, freeWorkReport);
reportRoutes.get('/invoice-check', PURCHASING, validateInvoiceCheck, invoiceCheckReport);
reportRoutes.get('/lpo-balances', DEPOT, validateLpoBalances, lpoBalancesReport);

export const notificationRoutes = express.Router();
notificationRoutes.use(authMiddleware);
notificationRoutes.get('/', listNotifications);
notificationRoutes.put('/read-all', markAllRead);
notificationRoutes.put('/:id/read', validateObjectId, markRead);
