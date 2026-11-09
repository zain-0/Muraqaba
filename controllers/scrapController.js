/**
 * A bus leaving the fleet (owner's request of 2026-11-09): the service creator raises a scrap
 * request, the supervisor approves or turns it down, and the supervisor records the sale of a
 * scrapped bus, which archives it. In operation → scrap requested → scrapped → sold.
 *
 * The daily status sheet follows: approving writes Scrapping on the day, the sale writes Removed
 * on the sale day, and neither can be set by hand any more.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import ScrapRequest from '../models/ScrapRequest.js';
import Ticket, { CLOSED_STATUSES } from '../models/Ticket.js';
import { BusStatusChange } from '../models/BusDaily.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { notifyRoles, notifyUser } from '../utils/notifications.js';
import { BUS_POPULATE, SCRAP_REQUEST_POPULATE, paginate } from '../utils/query.js';
import { uaeDay } from '../utils/uaeTime.js';
import { sendStored, withStoredAttachments } from '../utils/uploads.js';

const WAITING = 'A scrap request for this bus is waiting for the supervisor.';
const SOLD = 'A sold bus is archived and cannot be changed.';
const NOT_PENDING = 'This scrap request is no longer waiting for the supervisor.';
// Buses added before lifecycles existed have none stored, and are in operation.
const IN_OPERATION = mongoose.trusted({ $in: ['inOperation', null] });

const CANNOT_REQUEST = { scrapRequested: WAITING, scrapped: 'This bus is already scrapped.', sold: SOLD };

const busLink = (busId) => `/buses/${busId}`;

/** A notice that fails to save must not report the scrap request itself as failed. */
const quietly = (notice) => notice.catch((err) => console.error('Could not send the notice:', err));

/** A bus at a workshop, or waiting for an invoice, is still being worked on, so it cannot be scrapped yet. */
const assertNoOpenVsrs = async (busId) => {
  const open = await Ticket.find({ busId, status: mongoose.trusted({ $nin: CLOSED_STATUSES }) }).select('vsrNumber').sort({ vsrNumber: 1 });
  if (open.length) throw new AppError(`Finish or cancel its open VSRs first: ${open.map((t) => t.vsrNumber).join(', ')}`, 409, 'INVALID_STATE');
};

const loadBus = async (id) => {
  const bus = await Bus.findById(id);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');
  return bus;
};

const loadRequest = async (id) => {
  const request = await ScrapRequest.findById(id);
  if (!request) throw new AppError('Scrap request not found', 404, 'NOT_FOUND');
  return request;
};

const assertPending = (request) => {
  if (request.status !== 'pending') throw new AppError(NOT_PENDING, 409, 'INVALID_STATE');
};

const respond = async (res, request, message, status = 200) => {
  await request.populate(SCRAP_REQUEST_POPULATE);
  res.status(status).json({ success: true, message, data: request });
};

// GET /api/scrap-requests?status=&busId=&page=&limit=  (depot)
export const listScrapRequests = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.busId) filter.bus = req.query.busId;
  res.json(await paginate(ScrapRequest, filter, { page: req.query.page, limit: req.query.limit, sort: req.query.sort, populate: SCRAP_REQUEST_POPULATE }));
});

// GET /api/scrap-requests/:id  (depot)
export const getScrapRequest = asyncHandler(async (req, res) => {
  const request = await ScrapRequest.findById(req.params.id).populate(SCRAP_REQUEST_POPULATE);
  if (!request) throw new AppError('Scrap request not found', 404, 'NOT_FOUND');
  res.json({ success: true, data: request });
});

// POST /api/scrap-requests  (creator; multipart: busId, reason, note, attachments)
export const createScrapRequest = asyncHandler(async (req, res) => {
  const { busId, reason, note } = req.body;
  const bus = await loadBus(busId);
  if (CANNOT_REQUEST[bus.lifecycle]) throw new AppError(CANNOT_REQUEST[bus.lifecycle], 409, 'INVALID_STATE');
  await assertNoOpenVsrs(bus._id);

  // Taken in one atomic step, so two requests for one bus cannot both go through.
  const { modifiedCount } = await Bus.updateOne({ _id: bus._id, lifecycle: IN_OPERATION }, { $set: { lifecycle: 'scrapRequested' } });
  if (!modifiedCount) throw new AppError(WAITING, 409, 'INVALID_STATE');
  let request;
  try {
    request = await withStoredAttachments(req.files, (attachments) => ScrapRequest.create({ bus: bus._id, reason, note: note || undefined, attachments, createdBy: req.user._id }));
  } catch (err) {
    await Bus.updateOne({ _id: bus._id, lifecycle: 'scrapRequested' }, { $set: { lifecycle: 'inOperation' } }); // nothing was sent, so the bus is free again
    throw err;
  }
  await quietly(notifyRoles(['supervisor'], { type: 'scrapRequested', params: { fleetNumber: bus.fleetNumber, reason }, link: busLink(bus._id), dedupeKey: `scrap:${request._id}:requested` }));
  await respond(res, request, 'Scrap request sent to the supervisor', 201);
});

// PUT /api/scrap-requests/:id/approve  (supervisor; optional note)
export const approveScrapRequest = asyncHandler(async (req, res) => {
  const request = await loadRequest(req.params.id);
  assertPending(request);
  const bus = await loadBus(request.bus);
  // A VSR could have been raised before the request was sent and still be open: checked again.
  await assertNoOpenVsrs(bus._id);

  const today = uaeDay();
  Object.assign(request, { status: 'approved', decidedBy: req.user._id, decidedAt: new Date(), decisionNote: req.body.note || undefined });
  await request.save();
  await Bus.updateOne({ _id: bus._id }, { $set: { lifecycle: 'scrapped', scrappedOn: today } });
  await BusStatusChange.updateOne(
    { bus: bus._id, date: today },
    { $set: { status: 'scrapping', source: 'scrap', by: req.user._id }, $unset: { ticket: 1 } },
    { upsert: true, runValidators: true }
  );
  await quietly(notifyUser(request.createdBy, { type: 'scrapApproved', params: { fleetNumber: bus.fleetNumber, scrappedOn: today }, link: busLink(bus._id), dedupeKey: `scrap:${request._id}:approved` }));
  await respond(res, request, 'Bus scrapped. Record the sale when it is sold.');
});

// PUT /api/scrap-requests/:id/reject  (supervisor; note required)
export const rejectScrapRequest = asyncHandler(async (req, res) => {
  const request = await loadRequest(req.params.id);
  assertPending(request);
  Object.assign(request, { status: 'rejected', decidedBy: req.user._id, decidedAt: new Date(), decisionNote: req.body.note });
  await request.save();
  await Bus.updateOne({ _id: request.bus, lifecycle: 'scrapRequested' }, { $set: { lifecycle: 'inOperation' } });
  const bus = await Bus.findById(request.bus).select('fleetNumber');
  await quietly(notifyUser(request.createdBy, { type: 'scrapRejected', params: { fleetNumber: bus?.fleetNumber, note: req.body.note }, link: busLink(request.bus), dedupeKey: `scrap:${request._id}:rejected` }));
  await respond(res, request, 'Scrap request turned down');
});

// PUT /api/scrap-requests/:id/cancel  (the creator who raised it)
export const cancelScrapRequest = asyncHandler(async (req, res) => {
  const request = await loadRequest(req.params.id);
  if (!request.createdBy.equals(req.user._id)) throw new AppError('Only the service creator who raised this request can cancel it', 403, 'FORBIDDEN');
  assertPending(request);
  Object.assign(request, { status: 'cancelled', cancelledAt: new Date() });
  await request.save();
  await Bus.updateOne({ _id: request.bus, lifecycle: 'scrapRequested' }, { $set: { lifecycle: 'inOperation' } });
  await respond(res, request, 'Scrap request cancelled');
});

// GET /api/scrap-requests/:id/attachments/:attachmentId  (depot)
export const downloadScrapAttachment = asyncHandler(async (req, res) => {
  const request = await loadRequest(req.params.id);
  await sendStored(res, request.attachments.find((a) => a._id.equals(req.params.attachmentId)));
});

const saleDateError = (message) => new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'date', message }]);

// PUT /api/buses/:id/sale  (supervisor; multipart: date, buyer, price, note, attachments)
export const recordSale = asyncHandler(async (req, res) => {
  const bus = await loadBus(req.params.id);
  if (bus.lifecycle === 'sold') throw new AppError(SOLD, 409, 'INVALID_STATE');
  if (bus.lifecycle !== 'scrapped') throw new AppError('Only a scrapped bus can be sold.', 409, 'INVALID_STATE');
  const { date, buyer, price, note } = req.body;
  if (bus.scrappedOn && date < bus.scrappedOn) throw saleDateError('The sale cannot be dated before the bus was scrapped');

  await withStoredAttachments(req.files, async (attachments) => {
    const sale = { date, buyer, price, note: note || undefined, attachments, recordedBy: req.user._id, recordedAt: new Date() };
    // One atomic step, so two supervisors recording a sale at once cannot both win.
    const { modifiedCount } = await Bus.updateOne({ _id: bus._id, lifecycle: 'scrapped' }, { $set: { lifecycle: 'sold', sale } }, { runValidators: true });
    if (!modifiedCount) throw new AppError(SOLD, 409, 'INVALID_STATE');
  });
  // Removed from the sale day on. A hand-set Scrapping day after it, from before scrap requests, would bring it back.
  await BusStatusChange.deleteMany({ bus: bus._id, date: mongoose.trusted({ $gt: date }) });
  await BusStatusChange.updateOne(
    { bus: bus._id, date },
    { $set: { status: 'removed', source: 'scrap', by: req.user._id }, $unset: { ticket: 1 } },
    { upsert: true, runValidators: true }
  );
  // A bus scrapped before scrap requests existed has no one to tell.
  const raised = await ScrapRequest.findOne({ bus: bus._id, status: 'approved' }).sort({ decidedAt: -1 }).select('createdBy');
  if (raised) await quietly(notifyUser(raised.createdBy, { type: 'busSold', params: { fleetNumber: bus.fleetNumber, date }, link: busLink(bus._id), dedupeKey: `sold:${bus._id}` }));

  const sold = await Bus.findById(bus._id).populate(BUS_POPULATE);
  res.json({ success: true, message: 'Sale recorded. The bus is archived.', data: sold });
});

// GET /api/buses/:id/sale/attachments/:attachmentId  (depot)
export const downloadSaleAttachment = asyncHandler(async (req, res) => {
  const bus = await loadBus(req.params.id);
  await sendStored(res, bus.sale?.attachments.find((a) => a._id.equals(req.params.attachmentId)));
});

/** A bus's scrap requests, newest first, for the bus page. */
export const scrapRequestsOf = (busId) =>
  ScrapRequest.find({ bus: busId })
    .sort({ createdAt: -1, _id: -1 })
    .populate(SCRAP_REQUEST_POPULATE.filter(({ path }) => path !== 'bus'));
