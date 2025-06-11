import RepairRequest from '../models/RepairRequest.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

// Controller method to create a repair request (Vendor)
export const createRepairRequest = asyncHandler(async (req, res) => {
    const { busId, description, repairCategory } = req.body;

    // Create a new repair request
    const newRequest = new RepairRequest({
        busId,
        vendorId: req.user._id, // Vendor is the logged-in user
        description,
        repairCategory,
    });

    // Save the repair request to the database
    await newRequest.save();
    await newRequest.populate(['busId', 'vendorId']);

    res.status(201).json({ 
        success: true,
        message: 'Repair request created successfully', 
        data: newRequest 
    });
});

// Controller method to fetch all pending repair requests (Service Creator)
export const getPendingRepairRequests = asyncHandler(async (req, res) => {
    const pendingRequests = await RepairRequest.find({ status: 'pending' })
        .populate('busId')
        .populate('vendorId', 'name email');

    res.status(200).json({
        success: true,
        count: pendingRequests.length,
        data: pendingRequests
    });
});

// Controller method to update the status of a repair request (Service Creator)
export const updateRepairRequestStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    // Ensure the status is either 'resolved' or 'rejected'
    if (!['resolved', 'rejected'].includes(status)) {
        throw new AppError('Invalid status. Must be either "resolved" or "rejected"', 400);
    }

    // Find and update the repair request
    const updatedRequest = await RepairRequest.findByIdAndUpdate(
        id,
        { 
            status, 
            resolvedAt: status === 'resolved' ? new Date() : null, 
            rejectedAt: status === 'rejected' ? new Date() : null 
        },
        { new: true }
    ).populate(['busId', 'vendorId']);

    if (!updatedRequest) {
        throw new AppError('Repair request not found', 404);
    }

    res.status(200).json({ 
        success: true,
        message: 'Repair request status updated', 
        data: updatedRequest 
    });
});


