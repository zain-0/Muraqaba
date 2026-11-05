import mongoose from 'mongoose';

export const SERVICE_TYPES = ['oil', 'transmission', 'tyre', 'battery', 'repair', 'other'];
export const REPAIR_CATEGORIES = [
  'ELECTRICAL',
  'MECHANICAL',
  'AC REPAIR',
  'ENGINE',
  'BODY',
  'ACCIDENT',
];
export const TICKET_STATUSES = [
  'sentToVendor', // created, waiting for the vendor's estimate
  'estimateSubmitted', // vendor sent an estimate; the creator replies or escalates it
  'estimateCountered', // creator replied; waiting for the vendor's updated estimate
  'pending', // creator escalated the estimate, waiting for supervisor approval
  'returned', // supervisor sent it back with a reason; the creator corrects, replies or escalates again
  'approved', // supervisor approved, waiting for the vendor to acknowledge
  'acknowledged', // vendor accepted the job; work in progress, waiting for an invoice
  'invoiceSubmitted', // vendor submitted an invoice, waiting for supervisor review
  'invoiceAccepted', // supervisor accepted the invoice; vendor can close the ticket
  'invoiceRejected', // supervisor rejected the invoice; vendor must resubmit
  'completed', // vendor closed the ticket after invoice acceptance
];

// Status that ends the lifecycle.
export const CLOSED_STATUSES = ['completed'];

const HistoryEntrySchema = new mongoose.Schema(
  {
    status: { type: String, enum: TICKET_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const AttachmentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  size: { type: Number, required: true },
  mimeType: { type: String, required: true },
});

// One message in the estimate negotiation: the vendor's estimate or the creator's reply.
const NegotiationRoundSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['vendor', 'creator'], required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, min: 0 }, // optional on a creator's reply
    note: { type: String, trim: true, maxlength: 1000 },
    attachments: { type: [AttachmentSchema], default: [] },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

// Oil and transmission services: the rate on the bus times its interval, frozen when the ticket is raised.
const AgreedPriceSchema = new mongoose.Schema(
  {
    rate: { type: Number, required: true, min: 0 }, // AED per km
    km: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// How much of the bus's interval was left or delayed when the ticket was raised. Kept for
// our own figures; the vendor charges by the interval either way and never sees this.
const IntervalUsageSchema = new mongoose.Schema(
  {
    unit: { type: String, enum: ['km', 'months'], required: true },
    interval: { type: Number, required: true },
    actual: { type: Number, required: true },
    left: { type: Number, required: true },
    delayed: { type: Number, required: true },
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
    // Odometer in km when the ticket was raised. The API requires it; older tickets have none.
    currentReading: { type: Number, min: 0 },

    // The vendor doing the work: the bus's vendor unless the creator chose another.
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: { type: String, enum: TICKET_STATUSES, default: 'sentToVendor', index: true },
    negotiation: { type: [NegotiationRoundSchema], default: [] },
    agreedPrice: AgreedPriceSchema,
    intervalUsage: IntervalUsageSchema,
    approvedEstimate: { type: Number, min: 0 }, // the price the supervisor approved
    returnReason: { type: String, trim: true, maxlength: 500 }, // never shown to vendors
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
    default:
      break;
  }
};

/** The vendor's most recent estimate, which is what gets escalated and approved. */
TicketSchema.methods.latestEstimate = function latestEstimate() {
  return [...this.negotiation].reverse().find((round) => round.from === 'vendor');
};

const Ticket = mongoose.model('Ticket', TicketSchema);
export default Ticket;
