/**
 * The bus's trip to the workshop and back, and the invoice's way to purchasing. Every step
 * takes an optional date, which defaults to now; the history keeps when it was really done.
 */
import Bus from '../models/Bus.js';
import { BusDailyReading } from '../models/BusDaily.js';
import { asyncHandler } from '../middleware/errorMiddleware.js';
import { uaeDay } from '../utils/uaeTime.js';
import { assertStatus, assertVendorOwns, loadTicket, respond } from './ticketController.js';

/** Moves the ticket one step; `fields` go on ticket.vehicle. */
const step = (ticket, to, user, { date, km, fields = {} }) => {
  const when = date ?? new Date();
  Object.entries(fields).forEach(([key, value]) => {
    ticket.vehicle[key] = value === WHEN ? when : value;
  });
  ticket.transition(to, user._id, undefined, { effectiveAt: when, km });
};
const WHEN = Symbol('the step date');

// PUT /api/tickets/:id/vehicle/sent  (creator)
export const markVehicleSent = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'acknowledged', `The bus can be sent once the vendor has acknowledged the job (this one is ${ticket.status})`);
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
  step(ticket, 'vehicleReceived', req.user, { date, km, fields: { receivedAt: WHEN, receivedKm: km } });
  await ticket.save();
  await respond(res, ticket, 'Bus marked as received');
});

// PUT /api/tickets/:id/work/start  (vendor)
export const startWork = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'vehicleReceived', `Work starts after the bus is received (this one is ${ticket.status})`);
  step(ticket, 'workInProgress', req.user, { date: req.body.date, fields: { workStartedAt: WHEN } });
  await ticket.save();
  await respond(res, ticket, 'Work in progress');
});

// PUT /api/tickets/:id/work/ready  (vendor)
export const markReady = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'workInProgress', `Work has to be in progress before the bus can be ready (this one is ${ticket.status})`);
  step(ticket, 'readyForDelivery', req.user, { date: req.body.date, fields: { readyAt: WHEN } });
  await ticket.save();
  await respond(res, ticket, 'Bus is ready for delivery');
});

// PUT /api/tickets/:id/vehicle/release  (vendor)
export const releaseVehicle = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertVendorOwns(ticket, req.user);
  assertStatus(ticket, 'readyForDelivery', `The bus has to be ready before it can be released (this one is ${ticket.status})`);
  step(ticket, 'vehicleReleased', req.user, { date: req.body.date, fields: { releasedAt: WHEN } });
  await ticket.save();
  await respond(res, ticket, 'Bus released. The service creator confirms when it is back.');
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
  const when = date ?? new Date();
  step(ticket, 'vehicleReturned', req.user, {
    date: when,
    km,
    fields: { returnedAt: WHEN, returnedKm: km, replacedPartsReceived: Boolean(replacedPartsReceived) },
  });
  await ticket.save();
  await moveLastService(ticket, km, when);
  await BusDailyReading.updateOne({ bus: ticket.busId, date: uaeDay(when) }, { $setOnInsert: { km, by: req.user._id } }, { upsert: true });
  await respond(res, ticket, 'Bus is back. The vendor can now send the invoice.');
});

// PUT /api/tickets/:id/invoice/received  (creator)
export const markInvoiceReceived = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'invoiceAccepted', `The invoice has to be accepted first (this one is ${ticket.status})`);
  ticket.invoiceReceivedAt = req.body.date ?? new Date();
  ticket.transition('invoiceReceived', req.user._id, undefined, { effectiveAt: ticket.invoiceReceivedAt });
  await ticket.save();
  await respond(res, ticket, 'Invoice marked as received');
});

// PUT /api/tickets/:id/forward  (creator)
export const forwardToPurchase = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  assertStatus(ticket, 'invoiceReceived', `Mark the invoice as received first (this one is ${ticket.status})`);
  ticket.forwardedAt = req.body.date ?? new Date();
  ticket.transition('forwardedToPurchase', req.user._id, undefined, { effectiveAt: ticket.forwardedAt });
  await ticket.save();
  await respond(res, ticket, 'Forwarded to the purchase department');
});
