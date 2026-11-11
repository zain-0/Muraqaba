import express from 'express';
import { listVendors, listOutsideVendors, createVendor } from '../controllers/vendorController.js';
import { listTickets } from '../controllers/ticketController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { validateVendorCreate, validateTicketListQuery } from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use(authMiddleware);

// Directory of vendors, for assigning buses.
router.get('/', roleMiddleware(['serviceCreator', 'supervisor']), listVendors);
// Names of vendors outside the list, suggested when an accident goes to one.
router.get('/outside', roleMiddleware(['serviceCreator', 'supervisor']), listOutsideVendors);

// Create a vendor account (service creator only).
router.post('/', roleMiddleware(['serviceCreator']), validateVendorCreate, createVendor);
router.post('/create', roleMiddleware(['serviceCreator']), validateVendorCreate, createVendor); // legacy path

// Tickets assigned to the signed-in vendor (same as GET /api/tickets for a vendor).
router.get('/tickets', roleMiddleware(['vendor']), validateTicketListQuery, listTickets);

export default router;
