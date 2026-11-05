import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { runChecks } from '../utils/notifications.js';

const SHOWN = 200;

// GET /api/notifications  (your own, newest first)
export const listNotifications = asyncHandler(async (req, res) => {
  await runChecks();
  const [data, unread] = await Promise.all([
    Notification.find({ user: req.user._id }).sort({ createdAt: -1, _id: -1 }).limit(SHOWN),
    Notification.countDocuments({ user: req.user._id, readAt: mongoose.trusted({ $exists: false }) }),
  ]);
  res.json({ success: true, data, unread });
});

// PUT /api/notifications/:id/read
export const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { $set: { readAt: new Date() } }, { new: true });
  if (!notification) throw new AppError('Notification not found', 404, 'NOT_FOUND');
  res.json({ success: true, data: notification });
});

// PUT /api/notifications/read-all
export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, readAt: mongoose.trusted({ $exists: false }) }, { $set: { readAt: new Date() } });
  res.json({ success: true });
});
