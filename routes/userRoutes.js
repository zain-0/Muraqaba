import express from 'express';
import { getProfile, getDashboard } from '../controllers/userController.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// Middleware to log API calls
router.use((req, res, next) => {
    console.log(`API Called: ${req.method} ${req.originalUrl}`);
    next();
});

// Route to get user profile details
router.get('/profile', authMiddleware, getProfile);

// Route to view role-based dashboard
router.get('/dashboard', authMiddleware, getDashboard);

export default router;

