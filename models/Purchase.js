/** What the purchase department makes: goods receiving notes, purchase invoices and LPOs. */
import mongoose from 'mongoose';
import { AttachmentSchema } from './shared.js';

const { ObjectId } = mongoose.Schema.Types;

// One GRN covers a batch of VSRs from one vendor.
const GrnSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    date: { type: Date, required: true },
    vendor: { type: ObjectId, ref: 'User', required: true },
    tickets: [{ type: ObjectId, ref: 'Ticket', required: true }],
    total: { type: Number, required: true, min: 0 }, // the accepted invoices it covers
    notes: { type: String, trim: true, maxlength: 1000 },
    attachments: { type: [AttachmentSchema], default: [] },
    purchaseInvoice: { type: ObjectId, ref: 'PurchaseInvoice' },
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, optimisticConcurrency: true }
);

const PurchaseInvoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    date: { type: Date, required: true },
    grn: { type: ObjectId, ref: 'Grn', required: true },
    vendor: { type: ObjectId, ref: 'User', required: true },
    tickets: [{ type: ObjectId, ref: 'Ticket', required: true }],
    amount: { type: Number, required: true, min: 0 },
    notes: { type: String, trim: true, maxlength: 1000 },
    attachments: { type: [AttachmentSchema], default: [] },
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// Which VSRs a line pays for. Tyre and battery lines track quantity and amount, the others amount only.
// Repairs, brake pads, oil and transmission services all come off one repair and maintenance amount,
// as on the client's e-LPO (2026-11-09). That line is for one make; tyres and batteries cover every make.
export const LPO_KINDS = ['repairMaintenance', 'tyre', 'battery', 'other'];

const LpoItemSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: LPO_KINDS, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 300 },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    usedQuantity: { type: Number, default: 0 },
    usedAmount: { type: Number, default: 0 },
  },
  { id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);
LpoItemSchema.virtual('remainingQuantity').get(function remainingQuantity() {
  return this.quantity - this.usedQuantity;
});
LpoItemSchema.virtual('remainingAmount').get(function remainingAmount() {
  return Math.round((this.total - this.usedAmount) * 100) / 100;
});

const LpoSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    vendor: { type: ObjectId, ref: 'User', required: true, index: true },
    // The make of bus this LPO is for, spelt as on the fleet. Left out, it covers every make.
    make: { type: String, trim: true, maxlength: 60 },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    items: { type: [LpoItemSchema], required: true },
    grandTotal: { type: Number, required: true, min: 0 },
    usedAmount: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

export const Grn = mongoose.model('Grn', GrnSchema);
export const PurchaseInvoice = mongoose.model('PurchaseInvoice', PurchaseInvoiceSchema);
export const Lpo = mongoose.model('Lpo', LpoSchema);
