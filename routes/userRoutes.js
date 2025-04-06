import express from 'express';
import { getProfile, getDashboard } from '../controllers/userController.js'; // Named imports
import authMiddleware from '../middleware/authMiddleware.js';
import roleMiddleware from '../middleware/roleMiddleware.js';

const router = express.Router();

// Route to get user profile details
router.get('/profile', authMiddleware, getProfile);

// Route to view role-based dashboard
router.get('/dashboard', authMiddleware, getDashboard);

export default router;  // Correctly exporting the router

