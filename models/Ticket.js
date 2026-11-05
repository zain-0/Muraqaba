import mongoose from 'mongoose';
import { AttachmentSchema } from './shared.js';

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
  'acknowledged', // vendor accepted the job; the creator sends the bus
  'vehicleSent', // the creator sent the bus; the vendor confirms it arrived
  'vehicleReceived', // the bus is at the vendor
  'workInProgress',
  'readyForDelivery',
  'vehicleReleased', // the vendor let the bus go; the creator confirms it is back
  'vehicleReturned', // the bus is back; waiting for the vendor's invoice
  'invoiceSubmitted', // vendor submitted an invoice, waiting for supervisor review
  'invoiceAccepted', // supervisor accepted the invoice; the creator receives it
  'invoiceRejected', // supervisor rejected the invoice; vendor must resubmit
  'invoiceReceived', // the creator has the invoice and forwards it to purchasing
  'forwardedToPurchase', // purchasing makes the GRN
  'grnCreated', // purchasing makes the purchase invoice
  'completed', // the purchase invoice closes the ticket
  'declined', // additional jobs only: the supervisor turned it down
];

// Statuses that end the lifecycle.
export const CLOSED_STATUSES = ['completed', 'declined'];

// What the purchase manager is concerned with: anything that has an invoice.
export const PURCHASE_VISIBLE_STATUSES = ['invoiceSubmitted', 'invoiceAccepted', 'invoiceRejected', 'invoiceReceived', 'forwardedToPurchase', 'grnCreated', 'completed'];

const HistoryEntrySchema = new mongoose.Schema(
  {
    status: { type: String, enum: TICKET_STATUSES, required: true },
    at: { type: Date, default: Date.now }, // when it was really recorded
    effectiveAt: Date, // the date the person gave, if the step has one
    km: { type: Number, min: 0 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

// One message in the estimate negotiation: the vendor's estimate or the creator's reply.
const NegotiationRoundSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['vendor', 'creator'], required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, min: 0 }, // optional on a creator's reply
    quotationNumber: { type: String, trim: true, maxlength: 60 }, // vendor's estimates only, like the next two
    daysToComplete: { type: Number, min: 1 },
    estimateNumber: { type: Number, min: 1 }, // Estimate 1, Estimate 2 and so on
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

// One line of what the vendor's quotation lists. The creator types these so the vendor doesn't have to.
const BreakdownPartSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 300 },
    code: { type: String, trim: true, maxlength: 60 },
    partNumber: { type: String, trim: true, maxlength: 60 },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// What the job is made of, checked against the vendor's estimate before it goes for approval.
// Vendors never see this. discount is the quotation total minus the estimate.
const BreakdownSchema = new mongoose.Schema(
  {
    parts: { type: [BreakdownPartSchema], default: [] },
    partsTotal: { type: Number, required: true, min: 0 },
    labourHours: { type: Number, default: 0, min: 0 },
    labourRate: { type: Number, min: 0 }, // from the bus, frozen here
    labourTotal: { type: Number, default: 0, min: 0 },
    consumables: { type: Number, default: 0, min: 0 },
    quotationTotal: { type: Number, required: true, min: 0 },
    estimateAmount: { type: Number, min: 0 },
    discount: { type: Number },
    remarks: { type: String, trim: true, maxlength: 1000 },
  },
  { _id: false }
);

// What accepting the invoice took off the vendor's LPO. Never shown to vendors.
const LpoDeductionSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['deducted', 'noLpo'], required: true },
    lpo: { type: mongoose.Schema.Types.ObjectId, ref: 'Lpo', index: true },
    lpoNumber: String,
    item: mongoose.Schema.Types.ObjectId,
    kind: { type: String, required: true },
    quantity: { type: Number, default: 0 },
    amount: { type: Number, required: true },
    overrun: Boolean, // the LPO did not have enough left
    at: Date,
  },
  { _id: false }
);

// A person's signature on one step. The name and role are copied so they read as they did that day.
const SignatureStampSchema = new mongoose.Schema(
  {
    step: { type: String, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    role: { type: String, required: true },
    image: { type: mongoose.Schema.Types.ObjectId, ref: 'SignatureImage', required: true },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const TicketSchema = new mongoose.Schema(
  {
    vsrNumber: { type: String, required: true, unique: true, trim: true },
    busId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true, index: true },
    // An additional job the vendor raised during the work on this VSR; VSR-0001 gets VSR-0001b.
    parentTicket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', index: true },
    additionalCount: { type: Number, default: 0 },
    declineReason: { type: String, trim: true, maxlength: 500 },
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
    isBreakdown: { type: Boolean, default: false }, // broke down on the road; our own statistics, not for vendors
    daysToComplete: { type: Number, min: 1 }, // the vendor's latest promise

    // The vendor doing the work: the bus's vendor unless the creator chose another.
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: { type: String, enum: TICKET_STATUSES, default: 'sentToVendor', index: true },
    negotiation: { type: [NegotiationRoundSchema], default: [] },
    breakdown: BreakdownSchema,
    vehicle: {
      sentAt: Date,
      receivedAt: Date,
      receivedKm: { type: Number, min: 0 },
      workStartedAt: Date,
      readyAt: Date,
      releasedAt: Date,
      returnedAt: Date,
      returnedKm: { type: Number, min: 0 },
      replacedPartsReceived: Boolean,
    },
    agreedPrice: AgreedPriceSchema,
    intervalUsage: IntervalUsageSchema,
    approvedEstimate: { type: Number, min: 0 }, // the price the supervisor approved
    returnReason: { type: String, trim: true, maxlength: 500 }, // never shown to vendors
    history: { type: [HistoryEntrySchema], default: [] },
    signatures: { type: [SignatureStampSchema], default: [] },

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
    invoiceReceivedAt: Date,
    forwardedAt: Date,
    grn: { type: mongoose.Schema.Types.ObjectId, ref: 'Grn' },
    purchaseInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseInvoice' },
    lpoDeduction: LpoDeductionSchema,
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
TicketSchema.methods.transition = function transition(status, userId, note, { effectiveAt, km } = {}) {
  const now = new Date();
  this.status = status;
  this.statusUpdated = now;
  this.history.push({ status, at: now, effectiveAt, km, by: userId, note });
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
    case 'declined':
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
