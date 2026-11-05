import express from 'express';
import { getProfile, getDashboard, getSignature, saveSignature } from '../controllers/userController.js';
import { validateSignature } from '../middleware/validationMiddleware.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(authMiddleware);
router.get('/profile', getProfile);
router.get('/dashboard', getDashboard);
router.get('/signature', getSignature);
router.put('/signature', validateSignature, saveSignature);

export default router;
