import mongoose from 'mongoose';
import Ticket, { PURCHASE_VISIBLE_STATUSES, TICKET_STATUSES } from '../models/Ticket.js';
import Bus from '../models/Bus.js';
import { SignatureImage } from '../models/User.js';
import Invoice from '../models/Invoice.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { intervalStatus, latestKmByBus } from '../utils/intervals.js';

// GET /api/users/signature  (your own)
export const getSignature = asyncHandler(async (req, res) => {
  const signature = req.user.signatureImage ? await SignatureImage.findById(req.user.signatureImage) : null;
  res.json({ success: true, data: { image: signature?.image ?? null } });
});

// PUT /api/users/signature  (your own)
export const saveSignature = asyncHandler(async (req, res) => {
  const signature = await SignatureImage.create({ user: req.user._id, image: req.body.image });
  req.user.signatureImage = signature._id;
  await req.user.save();
  res.json({ success: true, message: 'Signature saved', data: { image: signature.image } });
});

// GET /api/users/profile
export const getProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.user, message: 'Profile retrieved successfully' });
});

/** Count tickets grouped by status for the given filter. */
const countByStatus = async (filter) => {
  const rows = await Ticket.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const counts = Object.fromEntries(TICKET_STATUSES.map((status) => [status, 0]));
  rows.forEach((r) => {
    counts[r._id] = r.n;
  });
  counts.total = rows.reduce((sum, r) => sum + r.n, 0);
  return counts;
};

const busesNeedingService = async (filter) => {
  const [buses, latest] = await Promise.all([Bus.find(filter).select('intervals'), latestKmByBus()]);
  return buses.filter((bus) => {
    const status = intervalStatus(bus, latest.get(String(bus._id)));
    return ['oil', 'transmission', 'tyre', 'battery'].some((service) => status[service].state === 'overdue');
  }).length;
};

const serviceCreatorDashboard = async (user) => {
  const [mine, all, buses, busesDue] = await Promise.all([
    countByStatus({ createdBy: user._id }),
    countByStatus({}),
    Bus.countDocuments(),
    busesNeedingService({}),
  ]);
  return {
    role: user.role,
    tickets: all,
    myTickets: mine,
    fleet: { buses, busesNeedingService: busesDue },
    // Things only this role can move forward.
    actionRequired: all.estimateSubmitted + all.returned + all.acknowledged + all.vehicleReleased + all.invoiceAccepted + all.invoiceReceived + busesDue,
  };
};

const supervisorDashboard = async (user) => {
  const [tickets, buses, busesDue] = await Promise.all([
    countByStatus({}),
    Bus.countDocuments(),
    busesNeedingService({}),
  ]);
  return {
    role: user.role,
    tickets,
    fleet: { buses, busesNeedingService: busesDue },
    actionRequired: tickets.pending + tickets.invoiceSubmitted,
  };
};

const vendorDashboard = async (user) => {
  const tickets = await countByStatus({ vendorId: user._id });
  return {
    role: user.role,
    tickets,
    actionRequired: tickets.sentToVendor + tickets.estimateCountered + tickets.approved + tickets.vehicleSent + tickets.vehicleReceived + tickets.workInProgress + tickets.readyForDelivery + tickets.vehicleReturned + tickets.invoiceRejected,
  };
};

const purchaseManagerDashboard = async (user) => {
  const [tickets, amounts] = await Promise.all([
    // Same scope as the purchase manager's ticket list: only tickets that have an invoice.
    countByStatus({ status: mongoose.trusted({ $in: PURCHASE_VISIBLE_STATUSES }) }),
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
    actionRequired: tickets.forwardedToPurchase + tickets.grnCreated,
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
