import RepairRequest from '../models/RepairRequest.js';
import Bus from '../models/Bus.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';
import { REPAIR_REQUEST_POPULATE, paginate } from '../utils/query.js';

const scopeForRole = (user) => (user.role === 'vendor' ? { vendorId: user._id } : {});

// POST /api/repair-requests  (vendor, for a bus assigned to them)
export const createRepairRequest = asyncHandler(async (req, res) => {
  const { busId, description, repairCategory } = req.body;

  const bus = await Bus.findById(busId);
  if (!bus) throw new AppError('Bus not found', 404, 'NOT_FOUND');
  if (!bus.vendor.equals(req.user._id)) {
    throw new AppError('You can only raise repair requests for buses assigned to you', 403, 'FORBIDDEN');
  }

  const request = await RepairRequest.create({
    busId: bus._id,
    vendorId: req.user._id,
    description,
    repairCategory,
  });
  await request.populate(REPAIR_REQUEST_POPULATE);

  res.status(201).json({
    success: true,
    message: 'Repair request sent. A service creator will review it and raise a ticket.',
    data: request,
  });
});

// GET /api/repair-requests  (role-scoped; ?status=&page=&limit=)
export const listRepairRequests = asyncHandler(async (req, res) => {
  const filter = scopeForRole(req.user);
  if (req.query.status) filter.status = req.query.status;
  const result = await paginate(RepairRequest, filter, {
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort,
    populate: REPAIR_REQUEST_POPULATE,
  });
  res.json(result);
});

// GET /api/repair-requests/pending
export const getPendingRepairRequests = asyncHandler(async (req, res) => {
  const result = await paginate(RepairRequest, { ...scopeForRole(req.user), status: 'pending' }, {
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort,
    populate: REPAIR_REQUEST_POPULATE,
  });
  res.json(result);
});

// PUT /api/repair-requests/:id/status  {status: resolved|rejected, note}
export const updateRepairRequestStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  const request = await RepairRequest.findById(req.params.id);
  if (!request) throw new AppError('Repair request not found', 404, 'NOT_FOUND');
  if (request.status !== 'pending') {
    throw new AppError(`This request was already ${request.status}`, 409, 'INVALID_STATE');
  }

  request.status = status;
  request.resolutionNote = note || undefined;
  if (status === 'resolved') {
    request.resolvedBy = req.user._id;
    request.resolvedAt = new Date();
  } else {
    request.rejectedBy = req.user._id;
    request.rejectedAt = new Date();
  }
  await request.save();
  await request.populate(REPAIR_REQUEST_POPULATE);

  res.json({ success: true, message: status === 'rejected' ? 'Repair request declined' : 'Repair request resolved', data: request });
});
