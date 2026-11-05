/**
 * The bus's trip to the workshop and back, and the invoice's way to purchasing. Every step
 * takes an optional date, which defaults to now; the history keeps when it was really done.
 */
import Bus from '../models/Bus.js';
import Ticket from '../models/Ticket.js';
import { BusDailyReading } from '../models/BusDaily.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { usageWhenRaised } from '../utils/intervals.js';
import { stamp } from '../utils/signatures.js';
import { uaeDay } from '../utils/uaeTime.js';
import { withStoredAttachments } from '../utils/uploads.js';
import { assertStatus, assertVendorOwns, loadTicket, respond } from './ticketController.js';

/** Moves the ticket one step; `fields` go on ticket.vehicle. */
const step = (ticket, to, user, { date, km, fields = {} }) => {
  const when = date || new Date();
  Object.entries(fields).forEach(([key, value]) => {
    ticket.vehicle[key] = value === WHEN ? when : value;
  });
  ticket.transition(to, user._id, undefined, { effectiveAt: when, km });
};
const WHEN = Symbol('the step date');

/** A VSR and its additional jobs travel in one bus, so the bus's movements apply to all of them. */
const familyOf = (ticket) => {
  const root = ticket.parentTicket ?? ticket._id;
  return Ticket.find({ $or: [{ _id: root }, { parentTicket: root }] });
};

const AT_THE_WORKSHOP = ['vehicleReceived', 'workInProgress', 'readyForDelivery'];
// A job in one of these has not been decided yet, so the bus has to wait for it.
const NOT_YET_AT_THE_WORKSHOP = ['sentToVendor', 'estimateSubmitted', 'estimateCountered', 'pending', 'returned', 'approved', 'acknowledged', 'vehicleSent'];

const fieldError = (field, message) => new AppError(message, 400, 'VALIDATION_ERROR', [{ field, message }]);

/** A date someone typed cannot go before the step before it. Left empty, it is now, which never can. */
const assertAfterPreviousStep = (ticket, date) => {
  if (!date) return;
  const previous = [...ticket.history].reverse().find((entry) => entry.effectiveAt)?.effectiveAt;
  if (previous && uaeDay(date) < uaeDay(previous)) throw fieldError('date', 'This date is before the step before it');
};

// A bus at a workshop barely moves, so a reading this far above the last is a typing slip.
const READING_MARGIN_KM = 20000;

/** An odometer does not go backwards, and a mistyped one would throw the bus's intervals out. */
const assertReading = (km, lastKnown = 0) => {
  if (km < lastKnown) throw fieldError('km', 'This reading is lower than the one already recorded on this VSR');
  if (km > lastKnown + READING_MARGIN_KM) throw fieldError('km', 'This reading is far above the one recorded on this VSR. Check it.');
};

// PUT /api/tickets/:id/vehicle/sent  (creator)
export const markVehicleSent = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'acknowledged', `The bus can be sent once the vendor has acknowledged the job (this one is ${ticket.status})`);
  assertAfterPreviousStep(ticket, req.body.date);
  step(ticket, 'vehicleSent', req.user, { date: req.body.date, fields: { sentAt: WHEN } });
  await ticket.save();
  await respond(res, ticket, 'Bus marked as sent to the vendor');
});

// PUT /api/tickets/:id/vehicle/received  (vendor)
export const markVehicleReceived = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'vehicleSent', `The bus has to be sent before it can be received (this one is ${ticket.status})`);
  const { date, km } = req.body;
  assertAfterPreviousStep(ticket, date);
  assertReading(km, ticket.currentReading);
  step(ticket, 'vehicleReceived', req.user, { date, km, fields: { receivedAt: WHEN, receivedKm: km } });
  await ticket.save();
  await respond(res, ticket, 'Bus marked as received');
});

// PUT /api/tickets/:id/work/start  (vendor)
export const startWork = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'vehicleReceived', `Work starts after the bus is received (this one is ${ticket.status})`);
  assertAfterPreviousStep(ticket, req.body.date);
  step(ticket, 'workInProgress', req.user, { date: req.body.date, fields: { workStartedAt: WHEN } });
  await ticket.save();
  await respond(res, ticket, 'Work in progress');
});

// PUT /api/tickets/:id/work/ready  (vendor)
export const markReady = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'workInProgress', `Work has to be in progress before the bus can be ready (this one is ${ticket.status})`);
  assertAfterPreviousStep(ticket, req.body.date);
  step(ticket, 'readyForDelivery', req.user, { date: req.body.date, fields: { readyAt: WHEN } });
  await ticket.save();
  await respond(res, ticket, 'Bus is ready for delivery');
});

// PUT /api/tickets/:id/vehicle/release  (vendor)
export const releaseVehicle = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'readyForDelivery', `The bus has to be ready before it can be released (this one is ${ticket.status})`);
  assertAfterPreviousStep(ticket, req.body.date);

  const family = await familyOf(ticket);
  const waiting = family.find((member) => NOT_YET_AT_THE_WORKSHOP.includes(member.status));
  if (waiting) throw new AppError(`${waiting.vsrNumber} is still waiting. It has to be approved or declined before the bus can leave.`, 409, 'NOT_READY');

  // Anything already gone stays as it is, so a job that got left behind can always be released later.
  const moving = family.filter((member) => AT_THE_WORKSHOP.includes(member.status));
  const when = req.body.date || new Date();
  moving.forEach((member) => {
    stamp(member, req.user, 'vehicleReleased');
    step(member, 'vehicleReleased', req.user, { date: when, fields: { releasedAt: WHEN } });
  });
  await Promise.all(moving.map((member) => member.save()));
  await respond(res, moving.find((member) => member._id.equals(ticket._id)), 'Bus released. The service creator confirms when it is back.');
});

/** The service this VSR did has just been done, so the bus's interval counts from here. */
const moveLastService = async ({ busId, serviceType }, km, when) => {
  if (serviceType === 'battery') {
    await Bus.updateOne({ _id: busId }, { $set: { 'intervals.battery.lastDate': when } });
  } else if (['oil', 'transmission', 'tyre'].includes(serviceType)) {
    await Bus.updateOne({ _id: busId }, { $set: { [`intervals.${serviceType}.lastKm`]: km } });
  }
};

// PUT /api/tickets/:id/vehicle/returned  (creator)
export const markVehicleReturned = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'vehicleReleased', `The vendor has to release the bus first (this one is ${ticket.status})`);
  const { date, km, replacedPartsReceived } = req.body;
  assertAfterPreviousStep(ticket, date);
  assertReading(km, ticket.vehicle?.receivedKm ?? ticket.currentReading);
  const when = date || new Date();
  const family = (await familyOf(ticket)).filter((member) => member.status === 'vehicleReleased');
  family.forEach((member) => {
    step(member, 'vehicleReturned', req.user, {
      date: when,
      km,
      fields: { returnedAt: WHEN, returnedKm: km, replacedPartsReceived: Boolean(replacedPartsReceived) },
    });
  });
  await Promise.all(family.map((member) => member.save()));
  await Promise.all(family.map((member) => moveLastService(member, km, when)));
  await BusDailyReading.updateOne({ bus: ticket.busId, date: uaeDay(when) }, { $setOnInsert: { km, by: req.user._id } }, { upsert: true });
  await respond(res, family.find((member) => member._id.equals(ticket._id)), 'Bus is back. The vendor can now send the invoice.');
});

// PUT /api/tickets/:id/invoice/received  (creator)
export const markInvoiceReceived = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'invoiceAccepted', `The invoice has to be accepted first (this one is ${ticket.status})`);
  assertAfterPreviousStep(ticket, req.body.date);
  ticket.invoiceReceivedAt = req.body.date || new Date();
  ticket.transition('invoiceReceived', req.user._id, undefined, { effectiveAt: ticket.invoiceReceivedAt });
  await ticket.save();
  await respond(res, ticket, 'Invoice marked as received');
});

// PUT /api/tickets/:id/forward  (creator)
export const forwardToPurchase = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'invoiceReceived', `Mark the invoice as received first (this one is ${ticket.status})`);
  assertAfterPreviousStep(ticket, req.body.date);
  ticket.forwardedAt = req.body.date || new Date();
  ticket.transition('forwardedToPurchase', req.user._id, undefined, { effectiveAt: ticket.forwardedAt });
  await ticket.save();
  await respond(res, ticket, 'Forwarded to the purchase department');
});

// POST /api/tickets/:id/additional  (vendor; multipart, with the job's first estimate)
export const createAdditionalJob = asyncHandler(async (req, res) => {
  const parent = await loadTicket(req.params.id);
  assertVendorOwns(parent, req.user);
  if (parent.parentTicket) throw new AppError('An additional job cannot have one of its own. Raise it on the main VSR.', 409, 'INVALID_STATE');
  assertStatus(parent, AT_THE_WORKSHOP, `An additional job can be raised only while the bus is at your workshop (this one is ${parent.status})`);

  const { description, serviceType, repairCategory, amount, quotationNumber, daysToComplete, note } = req.body;
  const { additionalCount } = await Ticket.findByIdAndUpdate(parent._id, { $inc: { additionalCount: 1 } }, { new: true }).select('additionalCount');
  const bus = await Bus.findById(parent.busId);
  const job = new Ticket({
    vsrNumber: `${parent.vsrNumber}${String.fromCharCode(97 + additionalCount)}`, // the first job is b
    parentTicket: parent._id,
    busId: parent.busId,
    vendorId: parent.vendorId,
    createdBy: req.user._id,
    serviceType,
    repairCategory: serviceType === 'repair' ? repairCategory : undefined,
    description,
    currentReading: parent.vehicle.receivedKm,
    intervalUsage: usageWhenRaised(bus, serviceType, parent.vehicle.receivedKm),
    daysToComplete,
    status: 'estimateSubmitted',
  });
  await withStoredAttachments(req.files, async (attachments) => {
    job.negotiation.push({ from: 'vendor', by: req.user._id, amount, quotationNumber, daysToComplete, estimateNumber: 1, note, attachments });
    job.history.push({ status: 'estimateSubmitted', by: req.user._id, note: 'Additional job raised by the vendor' });
    await job.save();
  });
  await respond(res, job, 'Additional job sent to the service creator', 201);
});
