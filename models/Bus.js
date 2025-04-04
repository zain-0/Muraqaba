import mongoose from 'mongoose';

// Define the Bus Schema
const BusSchema = new mongoose.Schema(
    {
        chassisNumber: {
            type: String,
            required: true,
            unique: true, // Each bus should have a unique chassis number
        },
        fleetNumber: {
            type: String,
            required: true,
            unique: true, // Fleet number should also be unique
        },
        registrationNumber: {
            type: String,
            required: true,
            unique: true, // Registration number should be unique
        },
        make: {
            type: String,
            required: true, // The manufacturer of the bus
        },
        model: {
            type: String,
            required: true, // The model of the bus
        },
        year: {
            type: Number,
            required: true, // The manufacturing year of the bus
        },
        engine: {
            serviceKm: {
                type: Number,
                required: true, // Kilometers before the engine needs service
            },
            currentKm: {
                type: Number,
                required: true, // Current kilometers on the engine
            },
        },
        ac: {
            serviceKm: {
                type: Number,
                required: true, // Kilometers before the AC needs service
            },
            currentKm: {
                type: Number,
                required: true, // Current kilometers on the AC
            },
        },
        tyre: {
            serviceKm: {
                type: Number,
                required: true, // Kilometers before the tyres need replacement
            },
            currentKm: {
                type: Number,
                required: true, // Current kilometers on the tyres
            },
        },
        transmission: {
            serviceKm: {
                type: Number,
                required: true, // Kilometers before the transmission needs service
            },
            currentKm: {
                type: Number,
                required: true, // Current kilometers on the transmission
            },
        },
        brakePad: {
            serviceKm: {
                type: Number,
                required: true, // Kilometers before the brake pads need replacement
            },
            currentKm: {
                type: Number,
                required: true, // Current kilometers on the brake pads
            },
        },
    },
    { timestamps: true }
);

// Create the Bus model from the schema
const Bus = mongoose.model('Bus', BusSchema);

export default Bus;
