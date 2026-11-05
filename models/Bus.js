import mongoose from 'mongoose';

// Services charged per km from the rate on the bus.
export const RATED_SERVICES = ['oil', 'transmission'];

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

// On screen: fleetNumber is the Site Number, make the Brand, model the Type, year the Model year.
const BusSchema = new mongoose.Schema(
  {
    chassisNumber: { type: String, required: true, unique: true, trim: true },
    fleetNumber: { type: String, required: true, unique: true, trim: true },
    registrationNumber: { type: String, required: true, unique: true, trim: true },
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 1900 },
    registrationExpiry: { type: Date, required: true },
    expectedLifeYears: { type: Number, required: true, min: 1 },

    labourRate: { type: Number, min: 0 }, // AED per repair labour hour
    rates: {
      oil: { type: Number, min: 0 }, // AED per km
      transmission: { type: Number, min: 0 },
    },
    intervals: {
      oil: { type: KmIntervalSchema, required: true },
      transmission: { type: KmIntervalSchema, required: true },
      tyre: { type: KmIntervalSchema, required: true },
      battery: { type: MonthIntervalSchema, required: true },
    },

    // The vendor (User with role vendor) responsible for servicing this bus.
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const Bus = mongoose.model('Bus', BusSchema);
export default Bus;
