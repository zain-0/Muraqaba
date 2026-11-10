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
// Other is no longer offered (2026-11-10) but older LPOs may still have such a line.
export const LPO_KINDS = ['repairMaintenance', 'tyre', 'battery', 'other'];
export const LPO_ITEM_CATEGORIES = ['repairMaintenance', 'tyre', 'battery'];

/** What a line is called, worked out from what it is, so purchasing never types it (2026-11-10). */
export const lineName = ({ kind, make, size, name }) => {
  if (kind === 'repairMaintenance' && make) return `Repair & Maintenance of ${make} Buses`;
  if (kind === 'tyre') return size ? `Tyre size ${size}` : 'Tyres';
  if (kind === 'battery') return size ? `Battery ${size}` : 'Batteries';
  return name;
};

const LpoItemSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: LPO_KINDS, required: true },
    make: { type: String, trim: true, maxlength: 60 }, // repair and maintenance only, spelt as on the fleet
    size: { type: String, trim: true, maxlength: 60 }, // the tyre size or battery type
    lifeKm: { type: Number, min: 1 }, // tyres only: fitting one sets the bus's tyre interval
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 300 },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    // What GRNs have taken off it. Before 2026-11-10 accepting the invoice did.
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
    // The date on the LPO. The API requires it; LPOs from before 2026-11-10 take their first valid day.
    date: Date,
    vendor: { type: ObjectId, ref: 'User', required: true, index: true },
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
