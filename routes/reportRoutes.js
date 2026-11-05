import express from 'express';
import { fleetFigures, runQuery, weeklyReport } from '../controllers/reportController.js';
import { listNotifications, markAllRead, markRead } from '../controllers/notificationController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateFleetFigures, validateObjectId, validateReportQuery } from '../middleware/validationMiddleware.js';

export const reportRoutes = express.Router();
reportRoutes.use(authMiddleware);
reportRoutes.get('/query', roleMiddleware(['purchaseManager']), validateReportQuery, runQuery);
reportRoutes.get('/fleet', roleMiddleware(['serviceCreator', 'supervisor', 'purchaseManager']), validateFleetFigures, fleetFigures);
reportRoutes.get('/weekly', roleMiddleware(['supervisor']), weeklyReport);

export const notificationRoutes = express.Router();
notificationRoutes.use(authMiddleware);
notificationRoutes.get('/', listNotifications);
notificationRoutes.put('/read-all', markAllRead);
notificationRoutes.put('/:id/read', validateObjectId, markRead);
