import mongoose from 'mongoose';

export const SERVICE_TYPES = ['minor', 'major', 'repair', 'other'];
export const REPAIR_CATEGORIES = [
  'ELECTRICAL',
  'MECHANICAL',
  'AC REPAIR',
  'ENGINE',
  'BODY',
  'BATTERY REPLACEMENT',
  'TYRE REPLACEMENT',
];
export const TICKET_STATUSES = [
  'pending', // created, waiting for supervisor approval
  'approved', // supervisor approved, waiting for the vendor to acknowledge
  'acknowledged', // vendor accepted the job; work in progress, waiting for an invoice
  'invoiceSubmitted', // vendor submitted an invoice, waiting for supervisor review
  'invoiceAccepted', // supervisor accepted the invoice; vendor can close the ticket
  'invoiceRejected', // supervisor rejected the invoice; vendor must resubmit
  'completed', // vendor closed the ticket after invoice acceptance
  'cancelled', // withdrawn while still pending (by a supervisor or the person who raised it)
];

// Statuses that end the lifecycle.
export const CLOSED_STATUSES = ['completed', 'cancelled'];

const HistoryEntrySchema = new mongoose.Schema(
  {
    status: { type: String, enum: TICKET_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const TicketSchema = new mongoose.Schema(
  {
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true, index: true },
    serviceType: { type: String, enum: SERVICE_TYPES, required: true },
    repairCategory: {
      type: String,
      enum: REPAIR_CATEGORIES,
      required: function requiredForRepair() {
        return this.serviceType === 'repair';
      },
    },
    description: { type: String, trim: true, maxlength: 1000 },

    // Always derived from the assigned vendor of the bus at creation time.
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Set when this ticket was raised to answer a repair request from the vendor.
    repairRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'RepairRequest' },

    status: { type: String, enum: TICKET_STATUSES, default: 'pending', index: true },
    history: { type: [HistoryEntrySchema], default: [] },

    initialApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    acknowledgedAt: Date,
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }, // current (latest) invoice
    invoiceSubmittedAt: Date,
    invoiceApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    invoiceAcceptedAt: Date,
    invoiceRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    invoiceRejectedAt: Date,
    completedAt: Date,
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: Date,
    cancellationReason: { type: String, trim: true, maxlength: 500 },
    statusUpdated: Date,
  },
  // optimisticConcurrency: two requests that load the same ticket and both try to save
  // it (for example accept and reject at once) cannot both win; the second gets a
  // VersionError that the error handler turns into 409 INVALID_STATE.
  { timestamps: true, optimisticConcurrency: true }
);

TicketSchema.index({ status: 1, createdAt: -1 });
TicketSchema.index({ vendorId: 1, status: 1 });

/**
 * Move the ticket to a new status and record who did it. Keeps the per-status
 * timestamp fields in sync so existing consumers keep working.
 */
TicketSchema.methods.transition = function transition(status, userId, note) {
  const now = new Date();
  this.status = status;
  this.statusUpdated = now;
  this.history.push({ status, at: now, by: userId, note });
  switch (status) {
    case 'approved':
      this.initialApprovedBy = userId;
      this.approvedAt = now;
      break;
    case 'acknowledged':
      this.acknowledgedBy = userId;
      this.acknowledgedAt = now;
      break;
    case 'invoiceSubmitted':
      this.invoiceSubmittedAt = now;
      break;
    case 'invoiceAccepted':
      this.invoiceApprovedBy = userId;
      this.invoiceAcceptedAt = now;
      break;
    case 'invoiceRejected':
      this.invoiceRejectedBy = userId;
      this.invoiceRejectedAt = now;
      break;
    case 'completed':
      this.completedAt = now;
      break;
    case 'cancelled':
      this.cancelledBy = userId;
      this.cancelledAt = now;
      this.cancellationReason = note;
      break;
    default:
      break;
  }
};

const Ticket = mongoose.model('Ticket', TicketSchema);
export default Ticket;
