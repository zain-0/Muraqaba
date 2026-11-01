import { body, param, query, validationResult } from 'express-validator';
import { ROLES } from '../models/User.js';
import { BUS_PARTS } from '../models/Bus.js';
import { SERVICE_TYPES, REPAIR_CATEGORIES, TICKET_STATUSES } from '../models/Ticket.js';
import { REPAIR_REQUEST_STATUSES } from '../models/RepairRequest.js';

export const handleValidationErrors = (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const errors = result.array({ onlyFirstError: true }).map((e) => ({ field: e.path, message: e.msg }));
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: errors[0]?.message || 'Validation failed',
      errors,
    });
  }
  return next();
};

// express-validator runs standard validators on each element of an array, so a scalar
// field must be pinned to a string first or `role: ["supervisor"]` would pass `isIn`.
const str = (field, label = field) => body(field).isString().withMessage(`${label} must be text`);
const qstr = (field) => query(field).optional().isString().withMessage(`${field} must appear once`);

// Largest kilometre reading or amount we accept; also rejects "1e400" (Infinity).
const MAX_NUMBER = 1e12;
const MAX_PAGE = 100000;

const email = () => str('email', 'Email').trim().toLowerCase().isEmail().withMessage('Enter a valid email address');
const password = () =>
  str('password', 'Password').isLength({ min: 6, max: 128 }).withMessage('Password must be at least 6 characters');
const name = () => str('name', 'Name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be between 2 and 80 characters');
const note = (field = 'note') =>
  body(field).optional({ values: 'falsy' }).isString().withMessage('Note must be text').trim().isLength({ max: 500 }).withMessage('Note is too long (500 characters max)');

export const validateRegister = [
  name(),
  email(),
  password(),
  str('role', 'Role').isIn(ROLES).withMessage(`Role must be one of: ${ROLES.join(', ')}`),
  handleValidationErrors,
];

export const validateLogin = [
  email(),
  str('password', 'Password').notEmpty().withMessage('Password is required'),
  handleValidationErrors,
];

export const validateVendorCreate = [name(), email(), password(), handleValidationErrors];

const partRules = (part) =>
  ['serviceKm', 'currentKm'].map((k) =>
    body(`${part}.${k}`)
      .isFloat({ min: 0, max: MAX_NUMBER })
      .withMessage(`${part}.${k} must be a number of kilometres (0 or more)`)
      .toFloat()
  );

export const validateBusCreate = [
  str('chassisNumber', 'Chassis number').trim().notEmpty().withMessage('Chassis number is required'),
  str('fleetNumber', 'Fleet number').trim().notEmpty().withMessage('Fleet number is required'),
  str('registrationNumber', 'Registration number').trim().notEmpty().withMessage('Registration number is required'),
  str('make', 'Make').trim().notEmpty().withMessage('Make is required'),
  str('model', 'Model').trim().notEmpty().withMessage('Model is required'),
  body('year')
    .isInt({ min: 1900, max: new Date().getFullYear() + 1 })
    .withMessage('Enter a valid year')
    .toInt(),
  str('vendorId', 'Vendor').isMongoId().withMessage('Choose the vendor responsible for this bus'),
  ...BUS_PARTS.flatMap((p) => partRules(p)),
  handleValidationErrors,
];

export const validateTicketCreate = [
  str('busId', 'Bus').isMongoId().withMessage('Choose a bus'),
  str('serviceType', 'Service type').isIn(SERVICE_TYPES).withMessage(`Service type must be one of: ${SERVICE_TYPES.join(', ')}`),
  body('repairCategory')
    .if(body('serviceType').equals('repair'))
    .isString()
    .isIn(REPAIR_CATEGORIES)
    .withMessage('Choose a repair category for repair tickets'),
  body('description')
    .optional({ values: 'falsy' })
    .isString()
    .withMessage('Description must be text')
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description must be 1000 characters or fewer'),
  handleValidationErrors,
];

export const validateTransitionNote = [note(), handleValidationErrors];

export const validateInvoiceSubmit = [
  body('amount').isFloat({ min: 0, max: MAX_NUMBER }).withMessage('Amount must be 0 or more').toFloat(),
  str('description', 'Description')
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage('Description must be between 10 and 500 characters'),
  body('invoiceNumber').optional({ values: 'falsy' }).isString().trim().isLength({ max: 60 }).withMessage('Invoice number is too long'),
  handleValidationErrors,
];

export const validateInvoiceReject = [note('reason'), handleValidationErrors];

export const validateRepairRequest = [
  str('busId', 'Bus').isMongoId().withMessage('Choose a bus'),
  str('description', 'Description')
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage('Describe the problem in at least 10 characters'),
  str('repairCategory', 'Repair category').isIn(REPAIR_CATEGORIES).withMessage('Choose a repair category'),
  handleValidationErrors,
];

export const validateRepairRequestStatus = [
  str('status', 'Status')
    .isIn(REPAIR_REQUEST_STATUSES.filter((s) => s !== 'pending'))
    .withMessage('Status must be resolved or rejected'),
  note(),
  handleValidationErrors,
];

export const validateObjectId = [param('id').isMongoId().withMessage('Invalid ID'), handleValidationErrors];

const pageQuery = [
  qstr('page').isInt({ min: 1, max: MAX_PAGE }).withMessage(`page must be between 1 and ${MAX_PAGE}`).toInt(),
  qstr('limit').isInt({ min: 1, max: 200 }).withMessage('limit must be between 1 and 200').toInt(),
  qstr('sort').isIn(['newest', 'oldest']).withMessage('sort must be newest or oldest'),
];

export const validateTicketListQuery = [
  qstr('status').isIn(TICKET_STATUSES).withMessage('Unknown status'),
  qstr('busId').isMongoId().withMessage('Invalid bus'),
  qstr('mine').isBoolean().withMessage('mine must be true or false').toBoolean(),
  ...pageQuery,
  handleValidationErrors,
];

export const validateRepairRequestListQuery = [
  qstr('status').isIn(REPAIR_REQUEST_STATUSES).withMessage('Unknown status'),
  ...pageQuery,
  handleValidationErrors,
];
