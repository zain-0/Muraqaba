import express from 'express';
import vendorController from '../controllers/vendorController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';

const router = express.Router();

// Route for getting all tickets related to the vendor (Vendor)
router.get('/tickets', authMiddleware, roleMiddleware(['vendor']), vendorController.getVendorTickets);

// Route for acknowledging a ticket (Vendor)
router.post('/acknowledge/:id', authMiddleware, roleMiddleware(['vendor']), vendorController.acknowledgeTicket);

// Route for submitting an invoice (Vendor)
router.post('/invoice/:id', authMiddleware, roleMiddleware(['vendor']), vendorController.submitInvoice);

// Route for creating a vendor (serviceCreator)
router.post('/create', authMiddleware, roleMiddleware(['serviceCreator']), vendorController.createVendor);

export default router;
