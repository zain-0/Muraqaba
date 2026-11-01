import express from 'express';
import rateLimit from 'express-rate-limit';
import { registerUser, loginUser, me, authConfig } from '../controllers/authController.js';
import { validateRegister, validateLogin } from '../middleware/validationMiddleware.js';
import authMiddleware from '../middleware/authMiddleware.js';
import config from '../config/config.js';

const router = express.Router();

// Tighter limit on credential endpoints to slow brute force attempts.
const authLimiter = rateLimit({
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' },
});

router.get('/config', authConfig);
router.post('/register', authLimiter, validateRegister, registerUser);
router.post('/login', authLimiter, validateLogin, loginUser);
router.get('/me', authMiddleware, me);

export default router;
