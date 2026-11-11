import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Bus from '../models/Bus.js';
import config from '../config/config.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { listed } from '../utils/outsideVendors.js';

// GET /api/vendors
// Returns vendors with the number of buses each one looks after, for assignment pickers. Vendors
// outside the list (accidents only, 2026-11-11) are left out.
export const listVendors = asyncHandler(async (req, res) => {
  const [vendors, busCounts] = await Promise.all([
    User.find({ role: 'vendor', ...listed() }).sort({ name: 1 }),
    Bus.aggregate([{ $group: { _id: '$vendor', buses: { $sum: 1 } } }]),
  ]);
  const counts = new Map(busCounts.map((r) => [String(r._id), r.buses]));
  const data = vendors.map((v) => ({ ...v.toJSON(), buses: counts.get(String(v._id)) || 0 }));
  res.json({ success: true, count: data.length, total: data.length, page: 1, pages: 1, data });
});

// GET /api/vendors/outside
// The vendors outside the list an accident has gone to, by name, to suggest for the next one.
export const listOutsideVendors = asyncHandler(async (req, res) => {
  const vendors = await User.find({ role: 'vendor', outside: true }).select('name').sort({ name: 1 });
  res.json({ success: true, data: vendors.map(({ _id, name }) => ({ _id, name })) });
});

// POST /api/vendors
export const createVendor = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  const existing = await User.findOne({ email });
  if (existing) {
    throw new AppError('An account with this email already exists', 409, 'DUPLICATE', [
      { field: 'email', message: 'Already in use' },
    ]);
  }

  const hashed = await bcrypt.hash(password, config.bcryptRounds);
  const vendor = await User.create({
    name,
    email,
    password: hashed,
    role: 'vendor',
  });

  res.status(201).json({ success: true, message: 'Vendor account created', data: vendor });
});
