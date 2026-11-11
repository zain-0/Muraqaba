/**
 * Shared query helpers: pagination and the populate specs that strip sensitive
 * fields from referenced users.
 */
export const USER_FIELDS = 'name email role';

export const TICKET_POPULATE = [
  { path: 'busId' },
  { path: 'vendorId', select: USER_FIELDS },
  { path: 'createdBy', select: USER_FIELDS },
  { path: 'initialApprovedBy', select: USER_FIELDS },
  { path: 'acknowledgedBy', select: USER_FIELDS },
  { path: 'invoiceApprovedBy', select: USER_FIELDS },
  { path: 'invoiceRejectedBy', select: USER_FIELDS },
  { path: 'invoice' },
  { path: 'grn', select: 'number date total notes attachments' },
  { path: 'purchaseInvoice', select: 'number date amount notes attachments' },
  { path: 'history.by', select: USER_FIELDS },
  { path: 'negotiation.by', select: USER_FIELDS },
];

export const BUS_POPULATE = [
  { path: 'vendor', select: USER_FIELDS },
  { path: 'sale.recordedBy', select: USER_FIELDS },
];

export const SCRAP_REQUEST_POPULATE = [
  { path: 'bus', select: 'fleetNumber registrationNumber make model year lifecycle' },
  { path: 'createdBy', select: USER_FIELDS },
  { path: 'decidedBy', select: USER_FIELDS },
];

/**
 * VSR lists run by VSR number compared as numbers (owner's testing notes, 2026-11-11: "the ids
 * should be in sequence"): VSR-22557 before VSR-22260 before VSR-9999, and an additional job
 * (VSR-22557b) right beside its parent. The number is unique, and _id breaks a tie the collation
 * could see (VSR-12 and VSR-0012), so pages never repeat or skip a VSR.
 */
export const BY_VSR_NUMBER = { field: 'vsrNumber', collation: { locale: 'en', numericOrdering: true } };

/**
 * Runs a Mongoose query with page/limit from the request and returns the
 * standard list envelope. Newest first by creation date, or by `by` when given.
 */
export const paginate = async (Model, filter, { page = 1, limit = 50, sort, populate = [], by }) => {
  const direction = sort === 'oldest' ? 1 : -1;
  const order = by ? { [by.field]: direction, _id: direction } : { createdAt: direction };
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const count = Model.countDocuments(filter);
  const find = Model.find(filter);
  if (by?.collation) {
    count.collation(by.collation);
    find.collation(by.collation);
  }
  const [total, data] = await Promise.all([
    count,
    find
      .sort(order)
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate(populate),
  ]);
  return {
    success: true,
    count: data.length,
    total,
    page: safePage,
    pages: Math.max(Math.ceil(total / safeLimit), 1),
    data,
  };
};
