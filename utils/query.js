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
  { path: 'history.by', select: USER_FIELDS },
  { path: 'negotiation.by', select: USER_FIELDS },
];

export const BUS_POPULATE = [{ path: 'vendor', select: USER_FIELDS }];

/**
 * Runs a Mongoose query with page/limit from the request and returns the
 * standard list envelope.
 */
export const paginate = async (Model, filter, { page = 1, limit = 50, sort, populate = [] }) => {
  const order = { createdAt: sort === 'oldest' ? 1 : -1 };
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const [total, data] = await Promise.all([
    Model.countDocuments(filter),
    Model.find(filter)
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
