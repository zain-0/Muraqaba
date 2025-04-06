import mongoose from 'mongoose';
import Ticket from './Ticket.js';
import User from './User.js';

const InvoiceSchema = new mongoose.Schema(
    {
        ticketId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Ticket', // Reference to the Ticket model
            required: true,
        },
        vendorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User', // Reference to the User model (vendor)
            required: true,
        },
        amount: {
            type: Number,
            required: true,
            min: 0, // Invoice amount can't be negative
        },
        description: {
            type: String,
            required: true, // Description for the invoice
        },
        status: {
            type: String,
            enum: ['invoicePending', 'approved', 'rejected'],
            default: 'invoicePending', // Default status is pending
        },
        submittedAt: {
            type: Date,
            default: Date.now, // Timestamp when the invoice is submitted
        },
        approvedAt: {
            type: Date,
            required: false, // Timestamp when the invoice is approved
        },
        rejectedAt: {
            type: Date,
            required: false, // Timestamp when the invoice is rejected
        },
        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User', // Reference to the User model (invoice approval supervisor)
            required: false, // Not required until the invoice is approved
        },
        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User', // Reference to the User model (invoice rejection supervisor)
            required: false, // Not required until the invoice is rejected
        },
    },
    { timestamps: true } // Automatically adds createdAt and updatedAt
);

// Create the Invoice model
const Invoice = mongoose.model('Invoice', InvoiceSchema);

export default Invoice;
