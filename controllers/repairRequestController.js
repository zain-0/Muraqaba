import RepairRequest from '../models/RepairRequest.js';

// Controller method to create a repair request (Vendor)
const createRepairRequest = async (req, res) => {
    try {
        const { busId, description, repairCategory } = req.body;

        // Check if all required fields are provided
        if (!busId || !description || !repairCategory) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        // Create a new repair request
        const newRequest = new RepairRequest({
            busId,
            vendorId: req.user._id, // Vendor is the logged-in user
            description,
            repairCategory,
        });

        // Save the repair request to the database
        await newRequest.save();

        return res.status(201).json({ message: 'Repair request created successfully', request: newRequest });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error, please try again later.' });
    }
};

// Controller method to fetch all pending repair requests (Service Creator)
const getPendingRepairRequests = async (req, res) => {
    try {
        const pendingRequests = await RepairRequest.find({ status: 'pending' });

        if (!pendingRequests.length) {
            return res.status(404).json({ message: 'No pending repair requests found.' });
        }

        return res.status(200).json(pendingRequests);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error, please try again later.' });
    }
};

// Controller method to update the status of a repair request (Service Creator)
const updateRepairRequestStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        // Ensure the status is either 'resolved' or 'rejected'
        if (!['resolved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Must be either "resolved" or "rejected".' });
        }

        // Find and update the repair request
        const updatedRequest = await RepairRequest.findByIdAndUpdate(
            id,
            { status, resolvedAt: status === 'resolved' ? new Date() : null, rejectedAt: status === 'rejected' ? new Date() : null },
            { new: true } // Return the updated document
        );

        if (!updatedRequest) {
            return res.status(404).json({ message: 'Repair request not found.' });
        }

        return res.status(200).json({ message: 'Repair request status updated.', request: updatedRequest });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Server error, please try again later.' });
    }
};

export default {
    createRepairRequest,
    getPendingRepairRequests,
    updateRepairRequestStatus,
};
