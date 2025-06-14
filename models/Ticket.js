import mongoose from 'mongoose';
import Bus from './Bus.js';
import User from './User.js';

const TicketSchema = new mongoose.Schema(
    {
        busId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Bus',
            required: true,
        },
        serviceType: {
            type: String,
            enum: ['minor', 'major', 'repair', 'other'],
            required: true,
        },
        vendorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        initialApprovedBy: {        
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User', // Reference to the User model (initial approval supervisor)
            required: false,
            default:null // Not required until ticket is initially approved
        },
        invoiceApprovedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User', // Reference to the User model (invoice approval supervisor)
            required: false, // Not required until the invoice is accepted
        },
        invoice: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Invoice', // Reference to an Invoice model, if you want a separate Invoice schema
            required: false, // Optional until vendor submits the invoice
        },
        repairCategory: {
            type: String,
            enum: ['ELECTRICAL', 'MECHANICAL', 'AC REPAIR', 'ENGINE', 'BODY', 'BATTERY REPLACEMENT', 'TYRE REPLACEMENT'],
            required: function() {
                return this.serviceType === 'repair'; // Required only for repair tickets
            }
        },
        status: {
            type: String,
            enum: ['pending', 'approved', 'acknowledged', 'invoiceSubmitted','invoiceAccepted' ,'completed', 'invoiceRejected'],
            default: 'pending',
        },
        statusUpdated: {
            type: Date, // Timestamp of when the status was last updated
            required: false,
        },
        approvedAt: {
            type: Date, // Timestamp of when the ticket was initially approved
            required: false,
        },        acknowledgedAt: {
            type: Date, // Timestamp of when the ticket was acknowledged by the vendor
            required: false,
        },
        acknowledgedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User', // Reference to the User model (vendor who acknowledged)
            required: false,
        },
        invoiceSubmittedAt: {
            type: Date, // Timestamp of when the invoice was submitted by the vendor
            required: false,
        },
        invoiceAcceptedAt: {
            type: Date, // Timestamp of when the invoice was accepted
            required: false,
        },
        invoiceRejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User', // Reference to the User model (supervisor who rejected invoice)
            required: false,
        },
        completedAt: {
            type: Date, // Timestamp of when the ticket was completed
            required: false,
        },
        invoiceRejectedAt: {
            type: Date, // Timestamp of when the invoice was rejected
            required: false,
        },
    },
    { timestamps: true } // Automatically adds createdAt and updatedAt
);

// Middleware to automatically assign vendor based on busId before saving the ticket
TicketSchema.pre('save', async function (next) {
    if (this.isNew) {
        try {
            // Find the bus by busId and set the vendorId automatically
            const bus = await Bus.findById(this.busId);
            if (bus && bus.vendor) {
                this.vendorId = bus.vendor; // Set vendorId based on bus vendor (field is named 'vendor' in Bus model)
            }
            next();
        } catch (err) {
            next(err);
        }
    } else {
        next();
    }
});

// Create the Ticket model
const Ticket = mongoose.model('Ticket', TicketSchema);

export default Ticket;
