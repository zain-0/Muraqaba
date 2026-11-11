import mongoose from 'mongoose';
import { AttachmentSchema } from './shared.js';

// Services charged per km from the rate on the bus. Transmission had one until 2026-11-11, when it became a repair category.
export const RATED_SERVICES = ['oil'];

// In operation → scrap requested → scrapped → sold. A sold bus is the archived bus: kept with
// all its history and hidden from current lists. Only a scrap request and a sale move it.
export const BUS_LIFECYCLES = ['inOperation', 'scrapRequested', 'scrapped', 'sold'];

// Buyer and price are required by the API; a bus migrated from the daily sheet has neither.
const SaleSchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // YYYY-MM-DD, UAE time
    buyer: { type: String, trim: true, maxlength: 200 },
    price: { type: Number, min: 0 }, // AED
    note: { type: String, trim: true, maxlength: 1000 },
    attachments: { type: [AttachmentSchema], default: [] },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedAt: Date,
  },
  { _id: false }
);

const KmIntervalSchema = new mongoose.Schema(
  {
    everyKm: { type: Number, required: true, min: 1 },
    lastKm: { type: Number, default: 0, min: 0 }, // odometer at the last service of this kind
  },
  { _id: false }
);

const MonthIntervalSchema = new mongoose.Schema(
  {
    everyMonths: { type: Number, required: true, min: 1 },
    lastDate: { type: Date, default: Date.now }, // when this was last changed
  },
  { _id: false }
);

// On screen: fleetNumber is the Side Number (painted on the bus), make the Brand, model the Type,
// year the Model year. A new bus may run for months before it is registered, and the depot's
// records hold no chassis numbers, so both are optional; when given they are unique. Leave them
// out rather than storing "" or null, or the sparse indexes would see duplicates.
const BusSchema = new mongoose.Schema(
  {
    chassisNumber: { type: String, unique: true, sparse: true, trim: true },
    fleetNumber: { type: String, required: true, unique: true, trim: true },
    registrationNumber: { type: String, unique: true, sparse: true, trim: true },
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 1900 },
    registrationExpiry: Date, // required by the API whenever there is a registration number
    expectedLifeYears: { type: Number, required: true, min: 1 },

    labourRate: { type: Number, min: 0 }, // AED per repair labour hour
    rates: {
      oil: { type: Number, min: 0 }, // AED per km
    },
    intervals: {
      oil: { type: KmIntervalSchema, required: true },
      tyre: { type: KmIntervalSchema, required: true },
      brakePads: KmIntervalSchema, // 40,000 km on the depot's sheet; buses added before 2026-11-06 may have none
      battery: { type: MonthIntervalSchema, required: true },
    },

    // The vendor (User with role vendor) responsible for servicing this bus.
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    lifecycle: { type: String, enum: BUS_LIFECYCLES, default: 'inOperation' },
    scrappedOn: String, // YYYY-MM-DD, UAE time: the supervisor approved the scrap request
    sale: SaleSchema,
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const Bus = mongoose.model('Bus', BusSchema);
export default Bus;
