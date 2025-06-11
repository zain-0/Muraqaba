import express from 'express';
import { 
    getVendorTickets, 
    acknowledgeTicket, 
    submitInvoice, 
    createVendor, 
    completeTicket 
} from '../controllers/vendorController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';
import { 
    validateObjectId, 
    validateInvoiceSubmit,
    validateVendorCreate 
} from '../middleware/validationMiddleware.js';

const router = express.Router();

router.use((req, res, next) => {
    console.log(`API Called: ${req.method} ${req.originalUrl}`);
    next();
});

// Route for getting all tickets related to the vendor (Vendor)
router.get('/tickets', authMiddleware, roleMiddleware(['vendor']), getVendorTickets);

// Route for acknowledging a ticket (Vendor)
router.post('/acknowledge/:id', authMiddleware, roleMiddleware(['vendor']), validateObjectId, acknowledgeTicket);

// Route for submitting an invoice (Vendor)
router.post('/invoice/:id', authMiddleware, roleMiddleware(['vendor']), validateObjectId, validateInvoiceSubmit, submitInvoice);

// Route for creating a vendor (serviceCreator)
router.post('/create', authMiddleware, roleMiddleware(['serviceCreator']), validateVendorCreate, createVendor);

// Route for completing a ticket (Vendor)
router.put('/complete/:id', authMiddleware, roleMiddleware(['vendor']), validateObjectId, completeTicket);

export default router;

