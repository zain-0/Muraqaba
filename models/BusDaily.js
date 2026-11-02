import mongoose from 'mongoose';

export const BUS_DAY_STATUSES = ['ready', 'repair', 'maintenance', 'tyreChange', 'batteryChange', 'accident', 'scrapping', 'removed'];

// The odometer a service creator records for a bus on one UAE day.
const BusDailyReadingSchema = new mongoose.Schema(
  {
    bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD, UAE time
    km: { type: Number, required: true, min: 0 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
BusDailyReadingSchema.index({ bus: 1, date: 1 }, { unique: true });

// A status holds from its date until the bus's next change, so only changes are stored.
const BusStatusChangeSchema = new mongoose.Schema(
  {
    bus: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD, UAE time
    status: { type: String, enum: BUS_DAY_STATUSES, required: true },
    source: { type: String, enum: ['manual', 'vsr'], required: true },
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
BusStatusChangeSchema.index({ bus: 1, date: 1 }, { unique: true });

export const BusDailyReading = mongoose.model('BusDailyReading', BusDailyReadingSchema);
export const BusStatusChange = mongoose.model('BusStatusChange', BusStatusChangeSchema);
