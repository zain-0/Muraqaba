import mongoose from 'mongoose';
const BusSchema = new mongoose.Schema(
    {
      chassisNumber: { type: String, required: true, unique: true },
      fleetNumber: { type: String, required: true, unique: true },
      registrationNumber: { type: String, required: true, unique: true },
      make: { type: String, required: true },
      model: { type: String, required: true },
      year: { type: Number, required: true },
  
      engine: {
        serviceKm: { type: Number, required: true },
        currentKm: { type: Number, required: true },
      },
      ac: {
        serviceKm: { type: Number, required: true },
        currentKm: { type: Number, required: true },
      },
      tyre: {
        serviceKm: { type: Number, required: true },
        currentKm: { type: Number, required: true },
      },
      transmission: {
        serviceKm: { type: Number, required: true },
        currentKm: { type: Number, required: true },
      },
      brakePad: {
        serviceKm: { type: Number, required: true },
        currentKm: { type: Number, required: true },
      },
  
      vendor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
      vendorName: {
        type: String,
        required: true, // store the username from the User model
      },
    },
    { timestamps: true }
  );

  const Bus = mongoose.model('Bus', BusSchema);

  export default Bus;