import express from 'express';
import { registerUser, loginUser } from '../controllers/authController.js';
import { validateRegister, validateLogin } from '../middleware/validationMiddleware.js';

const router = express.Router();

// Middleware to log API calls
router.use((req, res, next) => {
    console.log(`API Called: ${req.method} ${req.originalUrl}`);
    next();
});

// Register Route - POST /api/auth/register
router.post('/register', validateRegister, registerUser);

// Login Route - POST /api/auth/login
router.post('/login', validateLogin, loginUser);

export default router;
