import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import User from '../models/User.js';
import Ticket, { CLOSED_STATUSES } from '../models/Ticket.js';
import { BusDailyReading } from '../models/BusDaily.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { BUS_POPULATE } from '../utils/query.js';
import { latestKmByBus, withIntervalStatus } from '../utils/intervals.js';
import { assertNoClash } from '../utils/unique.js';
import { hasText } from '../middleware/validationMiddleware.js';
import { scrapRequestsOf } from './scrapController.js';

const identityOf = ({ fleetNumber, registrationNumber, chassisNumber }) => ({ fleetNumber, registrationNumber, chassisNumber });

export const assertVendorExists = async (vendorId) => {
  const vendor = await User.findById(vendorId);
  if (!vendor) throw new AppError('Vendor not found', 404, 'NOT_FOUND');
  if (vendor.role !== 'vendor') throw new AppError('Selected user is not a vendor', 400, 'NOT_A_VENDOR');
  return vendor;
};

const latestKmOf = async (busId) => (await BusDailyReading.findOne({ bus: busId }).sort({ date: -1 }).select('km'))?.km;

// GET /api/buses
export const getAllBuses = asyncHandler(async (req, res) => {
  const [buses, latest] = await Promise.all([Bus.find().sort({ fleetNumber: 1 }).populate(BUS_POPULATE), latestKmByBus()]);
  const data = buses.map((bus) => withIntervalStatus(bus, latest.get(String(bus._id))));
  // Fleets are small enough to return whole; keep the same envelope as paginated lists.
  res.json({ success: true, count: data.length, total: data.length, page: 1, pages: 1, data });
});

// GET /api/buses/:id
export const getBusById = asyncHandler(async (req, res) => {
  const bus = await Bus.findById(req.params.id).populate(BUS_POPULATE);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');

  const [openTickets, km, scrapRequests] = await Promise.all([
    Ticket.countDocuments({ busId: bus._id, status: mongoose.trusted({ $nin: CLOSED_STATUSES }) }),
    latestKmOf(bus._id),
    scrapRequestsOf(bus._id),
  ]);
  res.json({ success: true, data: { ...withIntervalStatus(bus, km), openTickets, scrapRequests } });
});

/** An empty chassis or registration number is left out, so an edit clears it and the sparse indexes never see "" or null. */
const present = (value) => (hasText(value) ? value.trim() : undefined);

/** What the add-bus and edit-bus forms can set. The vendor is only chosen when adding. */
const busFields = ({ chassisNumber, fleetNumber, registrationNumber, make, model, year, registrationExpiry, expectedLifeYears, labourRate, rates, intervals }) => ({
  chassisNumber: present(chassisNumber),
  fleetNumber,
  registrationNumber: present(registrationNumber),
  make,
  model,
  year,
  registrationExpiry: present(registrationNumber) ? registrationExpiry : undefined, // a bus not registered yet has no expiry
  expectedLifeYears,
  labourRate,
  rates: { oil: rates?.oil, transmission: rates?.transmission },
  intervals: {
    oil: { everyKm: intervals.oil.everyKm, lastKm: intervals.oil.lastKm ?? 0 },
    transmission: { everyKm: intervals.transmission.everyKm, lastKm: intervals.transmission.lastKm ?? 0 },
    tyre: { everyKm: intervals.tyre.everyKm, lastKm: intervals.tyre.lastKm ?? 0 },
    brakePads: { everyKm: intervals.brakePads.everyKm, lastKm: intervals.brakePads.lastKm ?? 0 },
    battery: { everyMonths: intervals.battery.everyMonths, lastDate: intervals.battery.lastDate ?? new Date() },
  },
});

// POST /api/buses
export const createBus = asyncHandler(async (req, res) => {
  const vendor = await assertVendorExists(req.body.vendorId);
  await assertNoClash(Bus, identityOf(req.body));
  const bus = await Bus.create({ ...busFields(req.body), vendor: vendor._id });
  await bus.populate(BUS_POPULATE);
  res.status(201).json({ success: true, message: 'Bus added to the fleet', data: bus });
});

// PUT /api/buses/:id  (new VSRs use the changes; existing ones keep the price they were raised at)
export const updateBus = asyncHandler(async (req, res) => {
  const bus = await Bus.findById(req.params.id);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');
  // Kept as it was on the day it was sold, with all its history.
  if (bus.lifecycle === 'sold') throw new AppError('A sold bus is archived and cannot be changed.', 409, 'INVALID_STATE');
  await assertNoClash(Bus, identityOf(req.body), bus._id);
  bus.set(busFields(req.body));
  await bus.save();
  await bus.populate(BUS_POPULATE);
  res.json({ success: true, message: 'Bus details saved', data: bus });
});
