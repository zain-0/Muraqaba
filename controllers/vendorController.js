import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Bus from '../models/Bus.js';
import config from '../config/config.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

// GET /api/vendors
// Returns vendors with the number of buses each one looks after, for assignment pickers.
export const listVendors = asyncHandler(async (req, res) => {
  const [vendors, busCounts] = await Promise.all([
    User.find({ role: 'vendor' }).sort({ name: 1 }),
    Bus.aggregate([{ $group: { _id: '$vendor', buses: { $sum: 1 } } }]),
  ]);
  const counts = new Map(busCounts.map((r) => [String(r._id), r.buses]));
  const data = vendors.map((v) => ({ ...v.toJSON(), buses: counts.get(String(v._id)) || 0 }));
  res.json({ success: true, count: data.length, total: data.length, page: 1, pages: 1, data });
});

// POST /api/vendors
export const createVendor = asyncHandler(async (req, res) => {
  const { name, email, password, serviceRates } = req.body;

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
    serviceRates: { minor: serviceRates?.minor, major: serviceRates?.major },
  });

  res.status(201).json({ success: true, message: 'Vendor account created', data: vendor });
});

// PUT /api/vendors/:id/rates  (new VSRs use these; existing ones keep the price they were raised at)
export const setVendorRates = asyncHandler(async (req, res) => {
  const { minor, major } = req.body;
  const vendor = await User.findOneAndUpdate({ _id: req.params.id, role: 'vendor' }, { serviceRates: { minor, major } }, { new: true, runValidators: true });
  if (!vendor) throw new AppError('Vendor not found', 404, 'NOT_FOUND');
  res.json({ success: true, message: 'Vendor prices saved', data: vendor });
});
