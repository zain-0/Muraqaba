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

// PUT /api/buses/:id
// Partial update: details, odometer readings per part, or the assigned vendor.
export const updateBus = asyncHandler(async (req, res) => {
  const bus = await Bus.findById(req.params.id);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');

  ['make', 'model', 'year'].forEach((k) => {
    if (req.body[k] !== undefined) bus[k] = req.body[k];
  });
  BUS_PARTS.forEach((p) => {
    if (req.body[p]) {
      if (req.body[p].serviceKm !== undefined) bus[p].serviceKm = req.body[p].serviceKm;
      if (req.body[p].currentKm !== undefined) bus[p].currentKm = req.body[p].currentKm;
    }
  });
  if (req.body.vendorId && !bus.vendor.equals(req.body.vendorId)) {
    const vendor = await assertVendorExists(req.body.vendorId);
    // Tickets keep the vendor they were raised with, so a bus cannot change hands mid-job.
    const open = await Ticket.countDocuments({ busId: bus._id, status: mongoose.trusted({ $nin: CLOSED_STATUSES }) });
    if (open > 0) {
      throw new AppError(
        `This bus has ${open} open ticket${open === 1 ? '' : 's'}. Complete or cancel them before assigning it to another vendor.`,
        409,
        'OPEN_TICKETS'
      );
    }
    bus.vendor = vendor._id;
  }

  await bus.save();
  await bus.populate(BUS_POPULATE);
  res.json({ success: true, message: 'Bus updated', data: bus });
});
