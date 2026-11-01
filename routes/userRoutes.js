import express from 'express';
import { getProfile, getDashboard } from '../controllers/userController.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(authMiddleware);
router.get('/profile', getProfile);
router.get('/dashboard', getDashboard);

export default router;
