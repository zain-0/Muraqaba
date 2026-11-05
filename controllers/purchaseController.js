import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import Ticket from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import { Grn, Lpo, PurchaseInvoice } from '../models/Purchase.js';
import { assertVendorExists } from './busController.js';
import { toIdList } from '../middleware/validationMiddleware.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { USER_FIELDS, paginate } from '../utils/query.js';
import { uaeDay } from '../utils/uaeTime.js';
import { assertCanSign, stamp } from '../utils/signatures.js';
import { withStoredAttachments } from '../utils/uploads.js';

const money = (value) => Math.round(value * 100) / 100;

const loadBatch = async (ids) => {
  const tickets = await Ticket.find({ _id: mongoose.trusted({ $in: ids }) }).populate('busId', 'fleetNumber registrationNumber make').populate('vendorId', USER_FIELDS).populate('invoice');
  if (tickets.length !== ids.length) throw new AppError('One of these VSRs was not found', 404, 'NOT_FOUND');
  return tickets;
};

// GET /api/grns/export?ticketIds=a,b  (purchasing: the batch as Excel)
export const exportBatch = asyncHandler(async (req, res) => {
  // Express 5 parses req.query afresh on every read, so a validator cannot rewrite it.
  const tickets = await loadBatch(toIdList(req.query.ticketIds));
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('GRN batch');
  sheet.columns = [
    { header: 'VSR', key: 'vsr', width: 14 },
    { header: 'Site number', key: 'site', width: 14 },
    { header: 'Registration', key: 'registration', width: 16 },
    { header: 'Brand', key: 'brand', width: 14 },
    { header: 'Vendor', key: 'vendor', width: 24 },
    { header: 'Service', key: 'service', width: 14 },
    { header: 'Quotation number', key: 'quotation', width: 18 },
    { header: 'Invoice number', key: 'invoice', width: 18 },
    { header: 'Invoice date', key: 'date', width: 13 },
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
      service: ticket.serviceType,
      quotation: ticket.latestEstimate()?.quotationNumber,
      invoice: ticket.invoice?.invoiceNumber,
      date: ticket.invoice?.submittedAt ? uaeDay(ticket.invoice.submittedAt) : undefined,
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
  const waiting = tickets.find((ticket) => ticket.status !== 'forwardedToPurchase');
  if (waiting) throw new AppError(`${waiting.vsrNumber} has not been forwarded to purchasing`, 409, 'INVALID_STATE');
  const vendors = new Set(tickets.map((ticket) => String(ticket.vendorId._id)));
  if (vendors.size > 1) {
    const message = 'A GRN covers one vendor. Choose VSRs from a single vendor.';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'ticketIds', message }]);
  }

  assertCanSign(req.user);
  const when = date ?? new Date();
  let grn;
  await withStoredAttachments(req.files, async (attachments) => {
    // The number is unique, so saving the GRN first means a taken number changes no VSR.
    grn = await Grn.create({
      number,
      date: when,
      vendor: tickets[0].vendorId._id,
      tickets: tickets.map((ticket) => ticket._id),
      total: money(tickets.reduce((sum, ticket) => sum + (ticket.invoice?.amount ?? 0), 0)),
      notes,
      attachments,
      createdBy: req.user._id,
    });
    await Promise.all(
      tickets.map((ticket) => {
        ticket.grn = grn._id;
        stamp(ticket, req.user, 'grn');
        ticket.transition('grnCreated', req.user._id, `GRN ${number}`, { effectiveAt: when });
        return ticket.save();
      })
    );
  });
  res.status(201).json({ success: true, message: 'GRN created', data: grn });
});

const GRN_POPULATE = [
  { path: 'vendor', select: USER_FIELDS },
  { path: 'createdBy', select: USER_FIELDS },
  { path: 'tickets', select: 'vsrNumber serviceType status' },
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

  assertCanSign(req.user);
  const when = date ?? new Date();
  const tickets = await Ticket.find({ _id: mongoose.trusted({ $in: grn.tickets }) });
  let invoice;
  await withStoredAttachments(req.files, async (attachments) => {
    invoice = await PurchaseInvoice.create({
      number,
      date: when,
      grn: grn._id,
      vendor: grn.vendor,
      tickets: grn.tickets,
      amount: amount ?? grn.total,
      notes,
      attachments,
      createdBy: req.user._id,
    });
    grn.purchaseInvoice = invoice._id;
    await grn.save();
    await Promise.all(
      tickets.map((ticket) => {
        ticket.purchaseInvoice = invoice._id;
        stamp(ticket, req.user, 'purchaseInvoice');
        ticket.transition('completed', req.user._id, `Purchase invoice ${number}`, { effectiveAt: when });
        return ticket.save();
      })
    );
  });
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

// POST /api/lpos  (purchasing)
export const createLpo = asyncHandler(async (req, res) => {
  const { number, vendorId, validFrom, validTo, items } = req.body;
  const vendor = await assertVendorExists(vendorId);
  const lines = items.map(({ kind, name, description, quantity, unitPrice }) => ({ kind, name, description, quantity, unitPrice, total: money(quantity * unitPrice) }));
  const lpo = await Lpo.create({
    number,
    vendor: vendor._id,
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
