import mongoose from 'mongoose';
import { REPAIR_CATEGORIES } from './Ticket.js';

export const REPAIR_REQUEST_STATUSES = ['pending', 'resolved', 'rejected'];

const RepairRequestSchema = new mongoose.Schema(
  {
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true, index: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    description: { type: String, required: true, trim: true, maxlength: 1000 },
    repairCategory: { type: String, enum: REPAIR_CATEGORIES, required: true },
    status: { type: String, enum: REPAIR_REQUEST_STATUSES, default: 'pending', index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: Date,
    resolutionNote: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true, optimisticConcurrency: true }
);

const RepairRequest = mongoose.model('RepairRequest', RepairRequestSchema);
export default RepairRequest;
