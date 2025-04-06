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
    const tickets = await Ticket.find(); // Example query for tickets
    return {
        totalTickets: tickets.length,
        pendingTickets: tickets.filter(ticket => ticket.status === 'pending').length,
        inProgressTickets: tickets.filter(ticket => ticket.status !== 'completed').length,
        completedTickets: tickets.filter(ticket => ticket.status === 'completed').length,
    };
};

// Dashboard for Supervisor
const getSupervisorDashboard = async (userId) => {
    // Fetch relevant data for supervisor
    const tickets = await Ticket.find(); // Example query for tickets
    return {
        totalTickets: tickets.length,
        approvedTickets: tickets.filter(ticket => ticket.status === 'approved').length,
        pendingApprovalTickets: tickets.filter(ticket => ticket.status === 'pendingApproval').length,
    };
};

// Dashboard for Vendor
import mongoose from 'mongoose'; // Import mongoose for ObjectId conversion

// Dashboard for Vendor
const getVendorDashboard = async (userId) => {
    try {
        // Log the userId to verify the input
        console.log('Fetching dashboard for userId:', userId);

        // Convert userId to ObjectId if necessary (use 'new' for ObjectId)
        

        // Fetch relevant data for vendor
        const tickets = await Ticket.find({ vendorId: userId }).populate('busId'); // Populate busId to get bus details

        // Log the fetched tickets to check the structure and values
        console.log('Fetched tickets:', tickets);

        // Check if no tickets are found and log a message
        if (tickets.length === 0) {
            console.log(`No tickets found for vendor with userId: ${userId}`);
        }

        // Calculate active tickets (those that are not 'completed')
        const activeTickets = tickets.filter(ticket => ticket.status !== 'completed');
        console.log('Active Tickets (not completed):', activeTickets);

        // Calculate invoices submitted (those that have status 'invoiceSubmitted')
        const invoicesSubmitted = tickets.filter(ticket => ticket.status === 'invoiceSubmitted');
        console.log('Invoices Submitted:', invoicesSubmitted);

        // Return the final result
        return {
            activeTickets,
            invoicesSubmitted,
            tickets, // Total tickets for the vendor
        };
    } catch (error) {
        console.error('Error fetching vendor dashboard:', error);
        throw error; // Throw error to handle it properly in the caller function
    }
};



// Dashboard for Purchase Manager
const getPurchaseManagerDashboard = async (userId) => {
    // Fetch relevant data for purchase manager (only completed tickets)
    const tickets = await Ticket.find({ status: 'completed' });
    return {
        totalCompletedTickets: tickets.length,
    };
};
