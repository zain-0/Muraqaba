import express from 'express';
import { getAllBuses, getBusById, createBus } from '../controllers/busController.js'; // Import controller methods
import authMiddleware from '../middleware/authMiddleware.js'; // Import your auth middleware
import roleMiddleware from '../middleware/roleMiddleware.js'; // Import your role middleware

const router = express.Router();

// Route to get all buses (requires authentication and specific roles)
router.get('/', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor', 'purchaseManager']), getAllBuses);

// Route to get a single bus by ID (requires authentication and specific roles)
router.get('/:id', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor', 'purchaseManager']), getBusById);

// Route to create a new bus (requires authentication and specific roles)
router.post('/create', authMiddleware, roleMiddleware(['serviceCreator', 'supervisor']), createBus);


export default router;
