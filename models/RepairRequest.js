import mongoose from 'mongoose';
import Bus from './Bus.js';
import User from './User.js';

const RepairRequestSchema = new mongoose.Schema(
    {
        busId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Bus', // Reference to the Bus model
            required: true, // Each repair request is linked to a bus
        },
        vendorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User', // Reference to the User model (vendor)
            required: true, // Vendor is required for the repair request
        },
        description: {
            type: String,
            required: true, // Description of the issue for repair
        },
        repairCategory: {
            type: String,
            enum: ['ELECTRICAL', 'MECHANICAL', 'AC REPAIR', 'ENGINE', 'BODY', 'BATTERY REPLACEMENT', 'TYRE REPLACEMENT'],
            required: true, // Category of the repair request
        },
        status: {
            type: String,
            enum: ['pending', 'resolved'],
            default: 'pending', // Default status is pending
        },
        createdAt: {
            type: Date,
            default: Date.now, // Timestamp when the repair request is created
        },
        
    },
    { timestamps: true } // Automatically adds createdAt and updatedAt
);

// Create the RepairRequest model
const RepairRequest = mongoose.model('RepairRequest', RepairRequestSchema);

export default RepairRequest;
