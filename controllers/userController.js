import mongoose from 'mongoose';
import Ticket, { PURCHASE_VISIBLE_STATUSES, TICKET_STATUSES } from '../models/Ticket.js';
import Bus from '../models/Bus.js';
import ScrapRequest from '../models/ScrapRequest.js';
import { SignatureImage } from '../models/User.js';
import Invoice from '../models/Invoice.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { intervalStatus, latestKmByBus } from '../utils/intervals.js';
import { offFleetBusIds } from '../utils/busDay.js';

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

/**
 * At the depot the bus makes no trip: after acknowledging, the vendor starts the work, and once
 * it is ready the creator confirms it is done. These counts move those two steps to the right person.
 */
const depotTurns = async (filter) => {
  const counts = await countByStatus({ ...filter, location: 'depot' });
  return { acknowledged: counts.acknowledged, readyForDelivery: counts.readyForDelivery };
};

const busesNeedingService = async (filter) => {
  const [buses, latest, offFleet] = await Promise.all([Bus.find(filter).select('intervals'), latestKmByBus(), offFleetBusIds()]);
  return buses.filter((bus) => {
    if (offFleet.has(String(bus._id))) return false; // scrapped or removed
    const status = intervalStatus(bus, latest.get(String(bus._id)));
    // Brake pads only on buses that have the interval; older buses have none.
    return ['oil', 'transmission', 'tyre', 'battery', 'brakePads'].some((service) => status[service]?.state === 'overdue');
  }).length;
};

const serviceCreatorDashboard = async (user) => {
  const [mine, all, buses, busesDue, depot] = await Promise.all([
    countByStatus({ createdBy: user._id }),
    countByStatus({}),
    Bus.countDocuments(),
    busesNeedingService({}),
    depotTurns({}),
  ]);
  return {
    role: user.role,
    tickets: all,
    myTickets: mine,
    fleet: { buses, busesNeedingService: busesDue },
    // Things only this role can move forward.
    actionRequired: all.estimateSubmitted + all.returned + (all.acknowledged - depot.acknowledged) + all.vehicleReleased + depot.readyForDelivery + all.invoiceAccepted + all.invoiceReceived + busesDue,
  };
};

const supervisorDashboard = async (user) => {
  const [tickets, buses, busesDue, scrapRequestsToDecide] = await Promise.all([
    countByStatus({}),
    Bus.countDocuments(),
    busesNeedingService({}),
    ScrapRequest.countDocuments({ status: 'pending' }),
  ]);
  return {
    role: user.role,
    tickets,
    fleet: { buses, busesNeedingService: busesDue },
    scrapRequestsToDecide,
    actionRequired: tickets.pending + tickets.invoiceSubmitted + scrapRequestsToDecide,
  };
};

const vendorDashboard = async (user) => {
  const [tickets, depot] = await Promise.all([countByStatus({ vendorId: user._id }), depotTurns({ vendorId: user._id })]);
  return {
    role: user.role,
    tickets,
    actionRequired:
      tickets.sentToVendor + tickets.estimateCountered + tickets.approved + depot.acknowledged + tickets.vehicleSent + tickets.vehicleReceived + tickets.workInProgress + (tickets.readyForDelivery - depot.readyForDelivery) + tickets.vehicleReturned + tickets.invoiceRejected,
  };
};

const purchaseManagerDashboard = async (user) => {
  // Same scope as the purchase manager's ticket list: only tickets that have an invoice, so a
  // no-charge job, which closes without one, is left out.
  const visible = { status: mongoose.trusted({ $in: PURCHASE_VISIBLE_STATUSES }), noChargeReason: mongoose.trusted({ $exists: false }) };
  const [tickets, amounts, current] = await Promise.all([
    countByStatus(visible),
    Invoice.aggregate([
      { $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    // The "Total value" tile: each of those VSRs' current invoice, summed here rather than over the
    // page of VSRs the dashboard loads, which on a real fleet is only part of them. Summed in fils.
    Ticket.aggregate([
      { $match: { status: { $in: PURCHASE_VISIBLE_STATUSES }, noChargeReason: { $exists: false }, invoice: { $exists: true } } },
      { $lookup: { from: Invoice.collection.name, localField: 'invoice', foreignField: '_id', as: 'current' } },
      { $unwind: '$current' },
      { $group: { _id: null, fils: { $sum: { $round: [{ $multiply: ['$current.amount', 100] }, 0] } } } },
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
    invoiceTotal: (current[0]?.fils ?? 0) / 100,
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
