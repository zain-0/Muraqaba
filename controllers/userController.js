// Import necessary models
import User from '../models/User.js'; // Assuming User model is defined elsewhere
import Ticket from '../models/Ticket.js'; // Import the Ticket model

// Get User Profile - Returns different data based on role
export const getProfile = async (req, res) => {
    try {
        // Fetch user by ID (from token payload)
        const userId = req.user.id;
        const user = await User.findById(userId).select('-password'); // Exclude password field

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Respond with user profile information
        res.json({ user });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Get User Dashboard - Different dashboard content based on the user's role
export const getDashboard = async (req, res) => {
    try {
        // Fetch user by ID (from token payload)
        const userId = req.user.id;
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Check user's role and return the appropriate dashboard data
        let dashboardData;

        switch (user.role) {
            case 'serviceCreator':
                dashboardData = await getServiceCreatorDashboard(userId);
                break;
            case 'supervisor':
                dashboardData = await getSupervisorDashboard(userId);
                break;
            case 'vendor':
                dashboardData = await getVendorDashboard(userId);
                break;
            case 'purchaseManager':
                dashboardData = await getPurchaseManagerDashboard(userId);
                break;
            default:
                return res.status(400).json({ message: 'Invalid role' });
        }

        // Respond with the dashboard data
        res.json({ dashboardData });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

// Helper functions for each role's dashboard

// Dashboard for Service Creator
const getServiceCreatorDashboard = async (userId) => {
    // Fetch relevant data for serviceCreator
    const tickets = await Ticket.find({ serviceCreator: userId }); // Example query for tickets
    return {
        totalTickets: tickets.length,
        pendingTickets: tickets.filter(ticket => ticket.status === 'pending').length,
        inProgressTickets: tickets.filter(ticket => ticket.status === 'inProgress').length,
        completedTickets: tickets.filter(ticket => ticket.status === 'completed').length,
    };
};

// Dashboard for Supervisor
const getSupervisorDashboard = async (userId) => {
    // Fetch relevant data for supervisor
    const tickets = await Ticket.find({ supervisor: userId }); // Example query for tickets
    return {
        totalTickets: tickets.length,
        approvedTickets: tickets.filter(ticket => ticket.status === 'approved').length,
        pendingApprovalTickets: tickets.filter(ticket => ticket.status === 'pendingApproval').length,
    };
};

// Dashboard for Vendor
const getVendorDashboard = async (userId) => {
    // Fetch relevant data for vendor
    const tickets = await Ticket.find({ vendor: userId }); // Example query for tickets
    return {
        totalTickets: tickets.length,
        activeTickets: tickets.filter(ticket => ticket.status === 'active').length,
        invoicesSubmitted: tickets.filter(ticket => ticket.invoiceStatus === 'submitted').length,
    };
};

// Dashboard for Purchase Manager
const getPurchaseManagerDashboard = async (userId) => {
    // Fetch relevant data for purchase manager (only completed tickets)
    const tickets = await Ticket.find({ purchaseManager: userId, status: 'completed' });
    return {
        totalCompletedTickets: tickets.length,
    };
};
