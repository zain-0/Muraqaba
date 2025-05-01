// routes/authRoutes.js

import express from 'express';
import { registerUser, loginUser } from '../controllers/authController.js'; // Import controller methods

const router = express.Router();

// Middleware to log API calls
router.use((req, res, next) => {
    console.log(`API Called: ${req.method} ${req.originalUrl}`);
    next();
});

// Register Route - POST /api/auth/register
router.post('/register', registerUser);

// Login Route - POST /api/auth/login
router.post('/login', loginUser);

export default router;
