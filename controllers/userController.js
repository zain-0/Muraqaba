import mongoose from 'mongoose';
import Ticket from '../models/Ticket.js';
import Bus from '../models/Bus.js';
import RepairRequest from '../models/RepairRequest.js';
import Invoice from '../models/Invoice.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

// GET /api/users/profile
export const getProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.user, message: 'Profile retrieved successfully' });
});

/** Count tickets grouped by status for the given filter. */
const countByStatus = async (filter) => {
  const rows = await Ticket.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const counts = {
    sentToVendor: 0,
    estimateSubmitted: 0,
    estimateCountered: 0,
    pending: 0,
    returned: 0,
    approved: 0,
    acknowledged: 0,
    invoiceSubmitted: 0,
    invoiceAccepted: 0,
    invoiceRejected: 0,
    completed: 0,
  };
  rows.forEach((r) => {
    counts[r._id] = r.n;
  });
  counts.total = rows.reduce((sum, r) => sum + r.n, 0);
  return counts;
};

const busesNeedingService = async (filter) => {
  const buses = await Bus.find(filter).select('engine ac tyre transmission brakePad');
  return buses.filter((b) => b.partsDue.length > 0).length;
};

const serviceCreatorDashboard = async (user) => {
  const [mine, all, buses, busesDue, pendingRepairRequests] = await Promise.all([
    countByStatus({ createdBy: user._id }),
    countByStatus({}),
    Bus.countDocuments(),
    busesNeedingService({}),
    RepairRequest.countDocuments({ status: 'pending' }),
  ]);
  return {
    role: user.role,
    tickets: all,
    myTickets: mine,
    fleet: { buses, busesNeedingService: busesDue },
    repairRequests: { pending: pendingRepairRequests },
    // Things only this role can move forward.
    actionRequired: all.estimateSubmitted + all.returned + pendingRepairRequests + busesDue,
  };
};

const supervisorDashboard = async (user) => {
  const [tickets, pendingRepairRequests, buses, busesDue] = await Promise.all([
    countByStatus({}),
    RepairRequest.countDocuments({ status: 'pending' }),
    Bus.countDocuments(),
    busesNeedingService({}),
  ]);
  return {
    role: user.role,
    tickets,
    fleet: { buses, busesNeedingService: busesDue },
    repairRequests: { pending: pendingRepairRequests },
    actionRequired: tickets.pending + tickets.invoiceSubmitted + pendingRepairRequests,
  };
};

const vendorDashboard = async (user) => {
  const [tickets, buses, busesDue, repairRequests] = await Promise.all([
    countByStatus({ vendorId: user._id }),
    Bus.countDocuments({ vendor: user._id }),
    busesNeedingService({ vendor: user._id }),
    RepairRequest.aggregate([{ $match: { vendorId: user._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const rr = { pending: 0, resolved: 0, rejected: 0 };
  repairRequests.forEach((r) => {
    rr[r._id] = r.n;
  });
  return {
    role: user.role,
    tickets,
    fleet: { buses, busesNeedingService: busesDue },
    repairRequests: rr,
    actionRequired: tickets.sentToVendor + tickets.estimateCountered + tickets.approved + tickets.acknowledged + tickets.invoiceRejected + tickets.invoiceAccepted,
  };
};

const purchaseManagerDashboard = async (user) => {
  const [tickets, amounts] = await Promise.all([
    // Same scope as the purchase manager's ticket list: only tickets that have an invoice.
    countByStatus({
      status: mongoose.trusted({ $in: ['invoiceSubmitted', 'invoiceAccepted', 'invoiceRejected', 'completed'] }),
    }),
    Invoice.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
  ]);
  const invoices = { pending: { count: 0, amount: 0 }, approved: { count: 0, amount: 0 }, rejected: { count: 0, amount: 0 } };
  amounts.forEach((r) => {
    const key = r._id === 'invoicePending' ? 'pending' : r._id;
    invoices[key] = { count: r.n, amount: r.amount };
  });
  return {
    role: user.role,
    tickets,
    invoices,
    actionRequired: 0, // read-only role
  };
};

// GET /api/users/dashboard
export const getDashboard = asyncHandler(async (req, res) => {
  const builders = {
    serviceCreator: serviceCreatorDashboard,
    supervisor: supervisorDashboard,
    vendor: vendorDashboard,
    purchaseManager: purchaseManagerDashboard,
  };
  const build = builders[req.user.role];
  if (!build) throw new AppError('Invalid user role', 400, 'INVALID_ROLE');
  const data = await build(req.user);
  res.json({ success: true, data, message: 'Dashboard data retrieved successfully' });
});
