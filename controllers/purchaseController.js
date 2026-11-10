import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import Ticket, { PURCHASE_VISIBLE_STATUSES } from '../models/Ticket.js';
import Invoice from '../models/Invoice.js';
import Bus from '../models/Bus.js';
import { Grn, Lpo, PurchaseInvoice, lineName } from '../models/Purchase.js';
import { assertVendorExists } from './busController.js';
import { hasText, toIdList } from '../middleware/validationMiddleware.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { candidateLines, deductAtGrn, isInDate, LINE_FOR_SERVICE, lineStatus } from '../utils/lpoDeduction.js';
import { COUNTED_BY_QUANTITY, amountTotals, balanceOf, balancesFor, isBooked, lineIdOf, reservedAmount, ticketsOnLines, unitsOf } from '../utils/lpoBalance.js';
import { notifyLpoProblem } from '../utils/notifications.js';
import { brandsFrom } from './reportController.js';
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

/**
 * The GRN takes each VSR's accepted invoice off its LPO line, in place of what it had booked
 * (2026-11-10). One at a time, so the automatic choice for a VSR with no line sees the deduction
 * before it. The GRN stands whatever happens to the LPO, so a failure here only leaves a log.
 */
const deductForGrn = async (tickets, amountOf) => {
  for (const ticket of tickets) {
    try {
      const deduction = await deductAtGrn(ticket, amountOf.get(String(ticket._id)) ?? 0);
      if (!deduction) continue;
      ticket.lpoDeduction = deduction;
      await ticket.save();
      if (deduction.status === 'noLpo' || deduction.overrun) await notifyLpoProblem(ticket);
    } catch (err) {
      console.error(`Could not take ${ticket.vsrNumber} off its LPO:`, err);
    }
  }
};

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
  await deductForGrn(claimed, new Map(tickets.map((ticket) => [String(ticket._id), ticket.invoice?.amount ?? 0])));
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

/** An LPO with its lines' amount totals and whether it is valid today. LPOs from before 2026-11-10 are dated by their first day. */
const withTotals = (lpo, balances, today) => ({
  ...lpo.toJSON(),
  date: lpo.date ?? lpo.validFrom,
  ...amountTotals(lpo.items.map((item) => balances.get(String(item._id)))),
  inDate: isInDate(lpo, today),
});

// GET /api/lpos
export const listLpos = asyncHandler(async (req, res) => {
  const result = await paginate(Lpo, {}, { page: req.query.page, limit: req.query.limit, sort: req.query.sort, populate: LPO_POPULATE });
  const balances = await balancesFor(result.data);
  const today = uaeDay();
  res.json({ ...result, data: result.data.map((lpo) => withTotals(lpo, balances, today)) });
});

// GET /api/lpos/items  (the LPO form's pick-lists; a new size can still be typed)
export const lpoItems = asyncHandler(async (req, res) => {
  const [buses, lpos] = await Promise.all([Bus.find().select('make'), Lpo.find().select('items.kind items.size')]);
  const sizes = (kind) => [...new Set(lpos.flatMap((lpo) => lpo.items.filter((item) => item.kind === kind && hasText(item.size)).map((item) => item.size.trim())))].sort(byNumberText);
  res.json({ success: true, data: { makes: brandsFrom(buses), tyreSizes: sizes('tyre'), batteryTypes: sizes('battery') } });
});

const byNumberText = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/** The make as the fleet spells it, so "hino" typed by hand still lists as "Hino". */
const fleetMake = async (make, field) => {
  const bus = await Bus.findOne({ make: make.trim() }).collation(CASE_BLIND).select('make');
  if (!bus) {
    const message = 'No bus on the fleet has this make';
    throw new AppError(message, 400, 'VALIDATION_ERROR', [{ field, message }]);
  }
  return bus.make;
};

/**
 * One line as purchasing entered it, named and totalled by the API (2026-11-10). Repair and
 * maintenance is one amount for one make; tyres and batteries are a size or type, a quantity and a
 * unit price, and tyres may say how many km they last.
 */
const lineFrom = async ({ kind, make, size, lifeKm, description, quantity, unitPrice }, index) => {
  if (kind === 'repairMaintenance') {
    const spelt = await fleetMake(make, `items[${index}].make`);
    return { kind, make: spelt, name: lineName({ kind, make: spelt }), description, quantity: 1, unitPrice, total: unitPrice };
  }
  return { kind, size, lifeKm: kind === 'tyre' && lifeKm ? lifeKm : undefined, name: lineName({ kind, size }), description, quantity, unitPrice, total: money(quantity * unitPrice) };
};

// POST /api/lpos  (purchasing)
export const createLpo = asyncHandler(async (req, res) => {
  const { number, vendorId, date, validFrom, validTo, items } = req.body;
  const vendor = await assertVendorExists(vendorId);
  const lines = [];
  for (const [index, item] of items.entries()) lines.push(await lineFrom(item, index));
  await assertNoClash(Lpo, { number });
  const lpo = await Lpo.create({
    number,
    date,
    vendor: vendor._id,
    validFrom,
    validTo,
    items: lines,
    grandTotal: money(lines.reduce((sum, line) => sum + line.total, 0)),
    createdBy: req.user._id,
  });
  res.status(201).json({ success: true, message: 'LPO created', data: lpo });
});

/** One VSR on a line, as the LPO page lists it. Quantities only for tyres and batteries. */
const vsrOnLine = (item) => (ticket) => {
  const booked = isBooked(ticket);
  const deducted = ticket.lpoDeduction?.status === 'deducted' ? ticket.lpoDeduction : null;
  return {
    _id: ticket._id,
    vsrNumber: ticket.vsrNumber,
    fleetNumber: ticket.busId?.fleetNumber ?? null,
    status: ticket.status,
    reserved: booked ? reservedAmount(ticket) : null,
    deducted: deducted ? deducted.amount : null,
    quantity: COUNTED_BY_QUANTITY.includes(item.kind) ? (deducted ? deducted.quantity : booked ? unitsOf(ticket) : null) : null,
    grnNumber: ticket.grn?.number ?? null,
  };
};

// GET /api/lpos/:id  (each line with its figures and its VSRs)
export const getLpo = asyncHandler(async (req, res) => {
  const lpo = await Lpo.findById(req.params.id).populate(LPO_POPULATE);
  if (!lpo) throw new AppError('LPO not found', 404, 'NOT_FOUND');
  const tickets = await ticketsOnLines(lpo.items.map((item) => item._id)).populate('busId', 'fleetNumber').populate('grn', 'number');
  const items = lpo.items.map((item) => {
    const onLine = tickets.filter((ticket) => String(lineIdOf(ticket)) === String(item._id)).sort((a, b) => byNumberText(a.vsrNumber, b.vsrNumber));
    return { ...item.toJSON(), balance: balanceOf(item, onLine), vsrs: onLine.map(vsrOnLine(item)) };
  });
  // What was taken off it, newest first, as the page showed before 2026-11-10.
  const usage = tickets
    .filter((ticket) => ticket.lpoDeduction?.status === 'deducted' && String(ticket.lpoDeduction.lpo) === String(lpo._id))
    .sort((a, b) => (b.lpoDeduction.at ?? 0) - (a.lpoDeduction.at ?? 0))
    .map(({ _id, vsrNumber, busId, lpoDeduction }) => ({
      ticketId: _id,
      vsrNumber,
      fleetNumber: busId?.fleetNumber,
      kind: lpoDeduction.kind,
      quantity: lpoDeduction.quantity,
      amount: lpoDeduction.amount,
      overrun: lpoDeduction.overrun,
      at: lpoDeduction.at,
    }));
  res.json({
    success: true,
    data: { ...lpo.toJSON(), date: lpo.date ?? lpo.validFrom, items, ...amountTotals(items.map((item) => item.balance)), inDate: isInDate(lpo), usage },
  });
});

// GET /api/lpos/for-vsr?busId=&serviceType=&ticketId=  (depot; reads only)
export const lpoForVsr = asyncHandler(async (req, res) => {
  const { busId, serviceType, ticketId } = req.query;
  const bus = await Bus.findById(busId).select('make vendor');
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');
  const lines = await candidateLines({ bus, serviceType });
  const lpos = [...new Map(lines.map(({ lpo }) => [String(lpo._id), lpo])).values()];
  // A VSR being corrected is shown what is left without its own booking, as the check counts it.
  const balances = await balancesFor(lpos, { exclude: hasText(ticketId) ? ticketId : undefined });
  res.json({
    success: true,
    data: {
      kind: LINE_FOR_SERVICE[serviceType],
      make: bus.make?.trim() ?? null,
      status: lineStatus(serviceType, lines),
      lines: lines.map(({ lpo, item }) => ({
        lpo: { _id: lpo._id, number: lpo.number, date: lpo.date ?? lpo.validFrom, validTo: lpo.validTo, vendor: { _id: lpo.vendor._id, name: lpo.vendor.name } },
        item: { _id: item._id, name: item.name, kind: item.kind, make: item.make ?? null, size: item.size ?? null, lifeKm: item.lifeKm ?? null, unitPrice: item.unitPrice },
        balance: balances.get(String(item._id)),
      })),
    },
  });
});
