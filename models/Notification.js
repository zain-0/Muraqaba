import mongoose from 'mongoose';

// One notice for one person. Screens word it from type and params, in the viewer's language.
const NotificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    link: String,
    dedupeKey: { type: String, required: true },
    readAt: Date,
  },
  { timestamps: true }
);
NotificationSchema.index({ user: 1, dedupeKey: 1 }, { unique: true });
NotificationSchema.index({ user: 1, createdAt: -1 });

const Notification = mongoose.model('Notification', NotificationSchema);
export default Notification;
