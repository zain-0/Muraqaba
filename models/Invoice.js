import mongoose from 'mongoose';

export const INVOICE_STATUSES = ['invoicePending', 'approved', 'rejected'];

const InvoiceSchema = new mongoose.Schema(
  {
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true, index: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    invoiceNumber: { type: String, trim: true, maxlength: 60 }, // the reference number used by the vendor
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, required: true, trim: true, maxlength: 1000 },
    status: { type: String, enum: INVOICE_STATUSES, default: 'invoicePending', index: true },
    submittedAt: { type: Date, default: Date.now },
    approvedAt: Date,
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: Date,
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true, optimisticConcurrency: true }
);

const Invoice = mongoose.model('Invoice', InvoiceSchema);
export default Invoice;
