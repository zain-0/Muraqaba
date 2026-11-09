import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import Ticket, { PURCHASE_VISIBLE_STATUSES } from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import Bus from '../models/Bus.js';
import { Grn, Lpo, PurchaseInvoice } from '../models/Purchase.js';
import { assertVendorExists } from './busController.js';
import { hasText, toIdList } from '../middleware/validationMiddleware.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { chooseLpo, COUNTED_BY_QUANTITY } from '../utils/lpoDeduction.js';
import { USER_FIELDS, paginate } from '../utils/query.js';
import { uaeDay } from '../utils/uaeTime.js';
import { assertNoClash, CASE_BLIND } from '../utils/unique.js';
import { REPAIR_CATEGORY_LABELS } from '../models/Ticket.js';
import { assertCanSign, stamp } from '../utils/signatures.js';
import { withStoredAttachments } from '../utils/uploads.js';

const money = (value) => Math.round(value * 100) / 100;

const SERVICE_LABELS = { oil: 'Oil service', transmission: 'Transmission service', tyre: 'Tyre change', battery: 'Battery change', brakePads: 'Brake pads', repair: 'Repair', other: 'Other' };

const serviceLabel = ({ serviceType, repairCategory }) =>
  serviceType === 'repair' && repairCategory ? `Repair: ${REPAIR_CATEGORY_LABELS[repairCategory] ?? repairCategory}` : SERVICE_LABELS[serviceType];

// An Excel date is a day; midnight UTC of the UAE day shows that day in any time zone.
const excelDay = (when) => new Date(`${uaeDay(when)}T00:00:00Z`);

const dateError = (message) => new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'date', message }]);

const loadBatch = async (ids) => {
  const tickets = await Ticket.find({ _id: mongoose.trusted({ $in: ids }) }).populate('busId', 'fleetNumber registrationNumber make').populate('vendorId', USER_FIELDS).populate('invoice');
  if (tickets.length !== ids.length) throw new AppError('One of these VSRs was not found', 404, 'NOT_FOUND');
  return tickets;
};

/**
 * Takes each VSR for this GRN in one atomic step, in a fixed order so two batches cannot wait
 * on each other. Only one GRN can hold a VSR, and a batch that loses one lets go of the rest.
 */
const claimForGrn = async (tickets, grnId) => {
  const inOrder = [...tickets].sort((a, b) => String(a._id).localeCompare(String(b._id)));
  for (const ticket of inOrder) {
    const { modifiedCount } = await Ticket.updateOne({ _id: ticket._id, status: 'forwardedToPurchase', grn: mongoose.trusted({ $exists: false }) }, { $set: { grn: grnId } });
    if (!modifiedCount) {
      await releaseGrnClaim(grnId);
      throw new AppError(`${ticket.vsrNumber} has just gone on another GRN`, 409, 'INVALID_STATE');
    }
  }
};
const releaseGrnClaim = (grnId) => Ticket.updateMany({ grn: grnId }, { $unset: { grn: 1 } });

// GET /api/grns/export?ticketIds=a,b  (purchasing: the batch as Excel)
export const exportBatch = asyncHandler(async (req, res) => {
  // Express 5 parses req.query afresh on every read, so a validator cannot rewrite it.
  const tickets = await loadBatch(toIdList(req.query.ticketIds));
  // A job at no charge closes without an invoice, so purchasing never sees it.
  if (tickets.some((ticket) => !PURCHASE_VISIBLE_STATUSES.includes(ticket.status) || ticket.noChargeReason)) throw new AppError('One of these VSRs was not found', 404, 'NOT_FOUND');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('GRN batch');
  sheet.columns = [
    { header: 'VSR', key: 'vsr', width: 14 },
    { header: 'Side number', key: 'site', width: 14 },
    { header: 'Registration', key: 'registration', width: 16 },
    { header: 'Brand', key: 'brand', width: 14 },
    { header: 'Vendor', key: 'vendor', width: 24 },
    { header: 'Service', key: 'service', width: 22 },
    { header: 'Quotation number', key: 'quotation', width: 18 },
    { header: 'Invoice number', key: 'invoice', width: 18 },
    { header: 'Invoice date', key: 'date', width: 13, style: { numFmt: 'dd mmm yyyy' } },
    { header: 'Amount (AED)', key: 'amount', width: 14, style: { numFmt: '#,##0.00' } },
  ];
  sheet.getRow(1).font = { bold: true };
  tickets.forEach((ticket) => {
    sheet.addRow({
      vsr: ticket.vsrNumber,
      site: ticket.busId?.fleetNumber,
      registration: ticket.busId?.registrationNumber,
      brand: ticket.busId?.make,
      vendor: ticket.vendorId?.name,
      service: serviceLabel(ticket),
      quotation: ticket.latestEstimate()?.quotationNumber,
      invoice: ticket.invoice?.invoiceNumber,
      date: ticket.invoice?.submittedAt ? excelDay(ticket.invoice.submittedAt) : undefined,
      amount: ticket.invoice?.amount,
    });
  });
  const total = sheet.addRow({ invoice: 'Total', amount: money(tickets.reduce((sum, t) => sum + (t.invoice?.amount ?? 0), 0)) });
  total.font = { bold: true };

  res.attachment(`grn-batch-${uaeDay()}.xlsx`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(await book.xlsx.writeBuffer()));
});

// POST /api/grns  (purchasing; multipart: number, ticketIds, date, notes, attachments)
export const createGrn = asyncHandler(async (req, res) => {
  const { number, ticketIds, date, notes } = req.body;
  const tickets = await loadBatch(ticketIds);
  const onGrn = tickets.find((ticket) => ticket.grn);
  if (onGrn) {
    const held = await Grn.findById(onGrn.grn).select('number');
    throw new AppError(`${onGrn.vsrNumber} is already on GRN ${held?.number}`, 409, 'INVALID_STATE');
  }
  const waiting = tickets.find((ticket) => ticket.status !== 'forwardedToPurchase');
  if (waiting) throw new AppError(`${waiting.vsrNumber} has not been forwarded to purchasing`, 409, 'INVALID_STATE');
  const vendors = new Set(tickets.map((ticket) => String(ticket.vendorId._id)));
  if (vendors.size > 1) {
    const message = 'A GRN covers one vendor. Choose VSRs from a single vendor.';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'ticketIds', message }]);
  }

  const reached = tickets.map((ticket) => uaeDay(ticket.forwardedAt ?? ticket.updatedAt)).sort().at(-1);
  if (date && uaeDay(date) < reached) throw dateError('A GRN cannot be dated before its VSRs reached purchasing');
  await assertNoClash(Grn, { number });

  assertCanSign(req.user);
  const when = date ?? new Date();
  const grnId = new mongoose.Types.ObjectId();
  await claimForGrn(tickets, grnId);
  let grn;
  try {
    grn = await withStoredAttachments(req.files, (attachments) =>
      Grn.create({
        _id: grnId,
        number,
        date: when,
        vendor: tickets[0].vendorId._id,
        tickets: tickets.map((ticket) => ticket._id),
        total: money(tickets.reduce((sum, ticket) => sum + (ticket.invoice?.amount ?? 0), 0)),
        notes,
        attachments,
        createdBy: req.user._id,
      })
    );
  } catch (err) {
    await releaseGrnClaim(grnId); // a taken number leaves every VSR free
    throw err;
  }
  const claimed = await Ticket.find({ grn: grnId });
  await Promise.all(
    claimed.map((ticket) => {
      stamp(ticket, req.user, 'grn');
      ticket.transition('grnCreated', req.user._id, `GRN ${number}`, { effectiveAt: when });
      return ticket.save();
    })
  );
  res.status(201).json({ success: true, message: 'GRN created', data: grn });
});

const GRN_POPULATE = [
  { path: 'vendor', select: USER_FIELDS },
  { path: 'createdBy', select: USER_FIELDS },
  { path: 'tickets', select: 'vsrNumber serviceType status busId', populate: { path: 'busId', select: 'fleetNumber' } },
  { path: 'purchaseInvoice', select: 'number date amount' },
];

// GET /api/grns
export const listGrns = asyncHandler(async (req, res) => {
  res.json(await paginate(Grn, {}, { page: req.query.page, limit: req.query.limit, sort: req.query.sort, populate: GRN_POPULATE }));
});

// POST /api/purchase-invoices  (purchasing; multipart: number, grnId, date, amount, notes, attachments)
export const createPurchaseInvoice = asyncHandler(async (req, res) => {
  const { number, grnId, date, amount, notes } = req.body;
  const grn = await Grn.findById(grnId);
  if (!grn) throw new AppError('GRN not found', 404, 'NOT_FOUND');
  if (grn.purchaseInvoice) throw new AppError('This GRN already has a purchase invoice', 409, 'INVALID_STATE');
  if (date && uaeDay(date) < uaeDay(grn.date)) throw dateError('A purchase invoice cannot be dated before its GRN');
  await assertNoClash(PurchaseInvoice, { number });

  assertCanSign(req.user);
  const when = date ?? new Date();
  // Taken in one atomic step, so only one purchase invoice can close this GRN.
  const invoiceId = new mongoose.Types.ObjectId();
  const { modifiedCount } = await Grn.updateOne({ _id: grn._id, purchaseInvoice: mongoose.trusted({ $exists: false }) }, { $set: { purchaseInvoice: invoiceId } });
  if (!modifiedCount) throw new AppError('This GRN already has a purchase invoice', 409, 'INVALID_STATE');

  let invoice;
  try {
    invoice = await withStoredAttachments(req.files, (attachments) =>
      PurchaseInvoice.create({
        _id: invoiceId,
        number,
        date: when,
        grn: grn._id,
        vendor: grn.vendor,
        tickets: grn.tickets,
        amount: amount ?? grn.total,
        notes,
        attachments,
        createdBy: req.user._id,
      })
    );
  } catch (err) {
    await Grn.updateOne({ _id: grn._id }, { $unset: { purchaseInvoice: 1 } }); // a taken number leaves the GRN free
    throw err;
  }
  const tickets = await Ticket.find({ _id: mongoose.trusted({ $in: grn.tickets }), status: 'grnCreated' });
  await Promise.all(
    tickets.map((ticket) => {
      ticket.purchaseInvoice = invoice._id;
      stamp(ticket, req.user, 'purchaseInvoice');
      ticket.transition('completed', req.user._id, `Purchase invoice ${number}`, { effectiveAt: when });
      return ticket.save();
    })
  );
  res.status(201).json({ success: true, message: 'Purchase invoice created. The VSRs are closed.', data: invoice });
});

const LPO_POPULATE = [
  { path: 'vendor', select: USER_FIELDS },
  { path: 'createdBy', select: USER_FIELDS },
];

// GET /api/lpos
export const listLpos = asyncHandler(async (req, res) => {
  res.json(await paginate(Lpo, {}, { page: req.query.page, limit: req.query.limit, sort: req.query.sort, populate: LPO_POPULATE }));
});

/** The make as the fleet spells it, so "hino" typed by hand still lists as "Hino". */
const fleetMake = async (make) => {
  if (!hasText(make)) return undefined;
  const bus = await Bus.findOne({ make: make.trim() }).collation(CASE_BLIND).select('make');
  if (!bus) {
    const message = 'No bus on the fleet has this make';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'make', message }]);
  }
  return bus.make;
};

// POST /api/lpos  (purchasing)
export const createLpo = asyncHandler(async (req, res) => {
  const { number, vendorId, validFrom, validTo, items } = req.body;
  const vendor = await assertVendorExists(vendorId);
  const make = await fleetMake(req.body.make);
  await assertNoClash(Lpo, { number });
  const lines = items.map(({ kind, name, description, quantity, unitPrice }) => ({ kind, name, description, quantity, unitPrice, total: money(quantity * unitPrice) }));
  const lpo = await Lpo.create({
    number,
    vendor: vendor._id,
    make,
    validFrom,
    validTo,
    items: lines,
    grandTotal: money(lines.reduce((sum, line) => sum + line.total, 0)),
    createdBy: req.user._id,
  });
  res.status(201).json({ success: true, message: 'LPO created', data: lpo });
});

// GET /api/lpos/:id  (with the VSRs that used it)
export const getLpo = asyncHandler(async (req, res) => {
  const lpo = await Lpo.findById(req.params.id).populate(LPO_POPULATE);
  if (!lpo) throw new AppError('LPO not found', 404, 'NOT_FOUND');
  const tickets = await Ticket.find({ 'lpoDeduction.lpo': lpo._id }).select('vsrNumber lpoDeduction busId').populate('busId', 'fleetNumber').sort({ 'lpoDeduction.at': -1 });
  const usage = tickets.map(({ _id, vsrNumber, busId, lpoDeduction }) => ({
    ticketId: _id,
    vsrNumber,
    fleetNumber: busId?.fleetNumber,
    kind: lpoDeduction.kind,
    quantity: lpoDeduction.quantity,
    amount: lpoDeduction.amount,
    overrun: lpoDeduction.overrun,
    at: lpoDeduction.at,
  }));
  res.json({ success: true, data: { ...lpo.toJSON(), usage } });
});

/** What the creator is shown: the LPO and how much is left on the line the job would come off. */
const previewOf = ({ kind, make, status, lpo, item, overrun }, amountGiven) => ({
  kind,
  make,
  status,
  lpo:
    status === 'found'
      ? {
          _id: lpo._id,
          number: lpo.number,
          make: lpo.make || null,
          validFrom: lpo.validFrom,
          validTo: lpo.validTo,
          lineTotal: item.total,
          lineRemaining: money(item.total - item.usedAmount),
          remainingQuantity: COUNTED_BY_QUANTITY.includes(kind) ? item.quantity - item.usedQuantity : null,
        }
      : null,
  // Whether this amount fits says nothing without an amount, or without an LPO to fit on.
  ...(amountGiven && status === 'found' ? { fits: !overrun } : {}),
});

// GET /api/lpos/for-vsr?busId=&vendorId=&serviceType=&amount=&quantity=  (depot; reads only)
export const lpoForVsr = asyncHandler(async (req, res) => {
  // Express 5 parses req.query afresh on every read, so the checked strings are turned into numbers here.
  const { busId, vendorId, serviceType, amount, quantity } = req.query;
  const bus = await Bus.findById(busId).select('make vendor');
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');
  // Left out, the vendor is the bus's own, as when raising the VSR.
  const vendor = await assertVendorExists(hasText(vendorId) ? vendorId : bus.vendor);
  const amountGiven = hasText(amount);
  const choice = await chooseLpo({ vendorId: vendor._id, bus, serviceType, amount: amountGiven ? Number(amount) : 0, quantity: hasText(quantity) ? Number(quantity) : 0 });
  res.json({ success: true, data: previewOf(choice, amountGiven) });
});
