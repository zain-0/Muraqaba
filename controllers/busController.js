import mongoose from 'mongoose';
import Bus, { BUS_PARTS } from '../models/Bus.js';
import User from '../models/User.js';
import Ticket, { CLOSED_STATUSES } from '../models/Ticket.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { BUS_POPULATE } from '../utils/query.js';

const scopeForRole = (user) => (user.role === 'vendor' ? { vendor: user._id } : {});

const assertVendorExists = async (vendorId) => {
  const vendor = await User.findById(vendorId);
  if (!vendor) throw new AppError('Vendor not found', 404, 'NOT_FOUND');
  if (vendor.role !== 'vendor') throw new AppError('Selected user is not a vendor', 400, 'NOT_A_VENDOR');
  return vendor;
};

// GET /api/buses
export const getAllBuses = asyncHandler(async (req, res) => {
  const buses = await Bus.find(scopeForRole(req.user)).sort({ fleetNumber: 1 }).populate(BUS_POPULATE);
  // Fleets are small enough to return whole; keep the same envelope as paginated lists.
  res.json({ success: true, count: buses.length, total: buses.length, page: 1, pages: 1, data: buses });
});

// GET /api/buses/:id
export const getBusById = asyncHandler(async (req, res) => {
  const bus = await Bus.findOne({ _id: req.params.id, ...scopeForRole(req.user) }).populate(BUS_POPULATE);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');

  const openTickets = await Ticket.countDocuments({ busId: bus._id, status: mongoose.trusted({ $nin: CLOSED_STATUSES }) });
  res.json({ success: true, data: { ...bus.toJSON(), openTickets } });
});

// POST /api/buses
export const createBus = asyncHandler(async (req, res) => {
  const { chassisNumber, fleetNumber, registrationNumber, make, model, year, vendorId } = req.body;
  const vendor = await assertVendorExists(vendorId);

  const parts = {};
  BUS_PARTS.forEach((p) => {
    parts[p] = { serviceKm: req.body[p].serviceKm, currentKm: req.body[p].currentKm };
  });

  const bus = await Bus.create({
    chassisNumber,
    fleetNumber,
    registrationNumber,
    make,
    model,
    year,
    ...parts,
    vendor: vendor._id,
  });
  await bus.populate(BUS_POPULATE);

  res.status(201).json({ success: true, message: 'Bus added to the fleet', data: bus });
});
