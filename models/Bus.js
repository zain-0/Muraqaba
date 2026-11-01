import mongoose from 'mongoose';

export const BUS_PARTS = ['engine', 'ac', 'tyre', 'transmission', 'brakePad'];

const PartSchema = new mongoose.Schema(
  {
    serviceKm: { type: Number, required: true, min: 0 }, // km interval between services
    currentKm: { type: Number, required: true, min: 0 }, // km accumulated since the last service of this part
  },
  { _id: false }
);

const BusSchema = new mongoose.Schema(
  {
    chassisNumber: { type: String, required: true, unique: true, trim: true },
    fleetNumber: { type: String, required: true, unique: true, trim: true },
    registrationNumber: { type: String, required: true, unique: true, trim: true },
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 1900 },

    engine: { type: PartSchema, required: true },
    ac: { type: PartSchema, required: true },
    tyre: { type: PartSchema, required: true },
    transmission: { type: PartSchema, required: true },
    brakePad: { type: PartSchema, required: true },

    // The vendor (User with role vendor) responsible for servicing this bus.
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Parts that are at or past their service interval, so the UI can flag buses that need
// attention without recomputing the rule on the client.
BusSchema.virtual('partsDue').get(function partsDue() {
  return BUS_PARTS.filter((p) => this[p] && this[p].currentKm >= this[p].serviceKm);
});

const Bus = mongoose.model('Bus', BusSchema);
export default Bus;
