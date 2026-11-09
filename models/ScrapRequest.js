import mongoose from 'mongoose';
import { AttachmentSchema } from './shared.js';

const { ObjectId } = mongoose.Schema.Types;

// Why the creator wants the bus scrapped: an accident that wrote it off, a bus that costs too much
// to keep running, or one past its service life.
export const SCRAP_REASONS = ['totalLoss', 'highRunningCost', 'endOfLife'];
export const SCRAP_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

/** A service creator asks the supervisor to scrap a bus. Only one can wait per bus: the bus's lifecycle holds it. */
const ScrapRequestSchema = new mongoose.Schema(
  {
    bus: { type: ObjectId, ref: 'Bus', required: true, index: true },
    reason: { type: String, enum: SCRAP_REASONS, required: true },
    note: { type: String, trim: true, maxlength: 1000 },
    attachments: { type: [AttachmentSchema], default: [] },
    status: { type: String, enum: SCRAP_REQUEST_STATUSES, default: 'pending', index: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    decidedBy: { type: ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: { type: String, trim: true, maxlength: 1000 }, // required when turned down
    cancelledAt: Date,
  },
  // Approve, turn down and cancel at the same moment cannot all win; the second gets a 409.
  { timestamps: true, optimisticConcurrency: true }
);

const ScrapRequest = mongoose.model('ScrapRequest', ScrapRequestSchema);
export default ScrapRequest;
