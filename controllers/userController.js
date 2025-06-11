// Import necessary models
import User from '../models/User.js';
import Ticket from '../models/Ticket.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

// Get User Profile - Returns different data based on role
export const getProfile = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const user = await User.findById(userId).select('-password');

    if (!user) {
        throw new AppError('User not found', 404);
    }

    res.status(200).json({ 
        success: true,
        data: user,
        message: 'Profile retrieved successfully'
    });
});

// Get User Dashboard - Different dashboard content based on the user's role
export const getDashboard = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
        throw new AppError('User not found', 404);
    }

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
            throw new AppError('Invalid user role', 400);
    }

    res.status(200).json({ 
        success: true,
        data: dashboardData,
        message: 'Dashboard data retrieved successfully'
    });
});

// Helper functions for each role's dashboard

// Dashboard for Service Creator
const getServiceCreatorDashboard = async (userId) => {
    const tickets = await Ticket.find({ createdBy: userId });
    return {
        totalTickets: tickets.length,
        pendingTickets: tickets.filter(ticket => ticket.status === 'pending').length,
        approvedTickets: tickets.filter(ticket => ticket.status === 'approved').length,
        acknowledgedTickets: tickets.filter(ticket => ticket.status === 'acknowledged').length,
        completedTickets: tickets.filter(ticket => ticket.status === 'completed').length,
    };
};

// Dashboard for Supervisor
const getSupervisorDashboard = async (userId) => {
    const tickets = await Ticket.find();
    return {
        totalTickets: tickets.length,
        pendingTickets: tickets.filter(ticket => ticket.status === 'pending').length,
        approvedTickets: tickets.filter(ticket => ticket.status === 'approved').length,
        invoiceSubmittedTickets: tickets.filter(ticket => ticket.status === 'invoiceSubmitted').length,
        invoiceAcceptedTickets: tickets.filter(ticket => ticket.status === 'invoiceAccepted').length,
        completedTickets: tickets.filter(ticket => ticket.status === 'completed').length,
    };
};

// Dashboard for Vendor
const getVendorDashboard = async (userId) => {
    try {
        const tickets = await Ticket.find({ vendorId: userId }).populate('busId');

        if (tickets.length === 0) {
            console.log(`No tickets found for vendor with userId: ${userId}`);
        }

        const activeTickets = tickets.filter(ticket => ticket.status !== 'completed');
        const invoicesSubmitted = tickets.filter(ticket => ticket.status === 'invoiceSubmitted');
        const acknowledgedTickets = tickets.filter(ticket => ticket.status === 'acknowledged');
        const approvedTickets = tickets.filter(ticket => ticket.status === 'approved');

        return {
            totalTickets: tickets.length,
            approvedTickets: approvedTickets.length,
            acknowledgedTickets: acknowledgedTickets.length,
            activeTickets: activeTickets.length,
            invoicesSubmitted: invoicesSubmitted.length,
            completedTickets: tickets.filter(ticket => ticket.status === 'completed').length,
        };
    } catch (error) {
        console.error('Error fetching vendor dashboard:', error);
        throw error;
    }
};

// Dashboard for Purchase Manager
const getPurchaseManagerDashboard = async (userId) => {
    const completedTickets = await Ticket.find({ status: 'completed' });
    const invoiceAcceptedTickets = await Ticket.find({ status: 'invoiceAccepted' });
    
    return {
        totalCompletedTickets: completedTickets.length,
        invoiceAcceptedTickets: invoiceAcceptedTickets.length,
        totalProcessedAmount: completedTickets.reduce((total, ticket) => {
            return ticket.invoice ? total + (ticket.invoice.amount || 0) : total;
        }, 0),
    };
};
