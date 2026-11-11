import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket from '../models/Ticket.js';
import { BusDailyReading } from '../models/BusDaily.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { busCosts } from '../utils/busCosts.js';
import { intervalStatus } from '../utils/intervals.js';

// GET /api/buses/:id/costs  (depot)
// The bus's whole-life costs for the scrap request form. The current km is the latest reading on
// the daily sheet, or with none the km the bus's intervals stand at.
export const getBusCosts = asyncHandler(async (req, res) => {
  const bus = await Bus.findById(req.params.id);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');
  const [tickets, reading] = await Promise.all([
    Ticket.find({ busId: bus._id, status: mongoose.trusted({ $ne: 'declined' }) })
      .select('serviceType repairCategory status invoice')
      .populate('invoice', 'amount status'),
    BusDailyReading.findOne({ bus: bus._id }).sort({ date: -1 }).select('km'),
  ]);
  const currentKm = intervalStatus(bus, reading?.km).currentKm;
  res.json({ success: true, data: { busId: bus._id, fleetNumber: bus.fleetNumber, ...busCosts(tickets, currentKm), kmSource: reading ? 'reading' : 'lastService' } });
});
