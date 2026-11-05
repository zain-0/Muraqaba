import { body, param, query, validationResult } from 'express-validator';
import { ROLES } from '../models/User.js';
import { SERVICE_TYPES, REPAIR_CATEGORIES, TICKET_STATUSES } from '../models/Ticket.js';
import { BUS_DAY_STATUSES } from '../models/BusDaily.js';
import { LPO_KINDS } from '../models/Purchase.js';
import { endOfUaeDay, uaeDay } from '../utils/uaeTime.js';

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

export const validateVendorCreate = [
  name(),
  email(),
  password(),
  handleValidationErrors,
];

const KM_INTERVALS = ['oil', 'transmission', 'tyre'];

const isDate = (field, message) => body(field, message).isString().matches(/^\d{4}-\d{2}-\d{2}/).isISO8601({ strict: true }).toDate();

const busRules = () => [
  str('chassisNumber', 'Chassis number').trim().notEmpty().withMessage('Chassis number is required'),
  str('fleetNumber', 'Site number').trim().notEmpty().withMessage('Site number is required'),
  str('registrationNumber', 'Registration number').trim().notEmpty().withMessage('Registration number is required'),
  str('make', 'Brand').trim().notEmpty().withMessage('Brand is required'),
  str('model', 'Type').trim().notEmpty().withMessage('Type is required'),
  body('year')
    .isInt({ min: 1900, max: new Date().getFullYear() + 1 })
    .withMessage('Enter a valid model year')
    .toInt(),
  isDate('registrationExpiry', 'Enter the registration expiry date'),
  body('expectedLifeYears', 'Enter the expected life in years').not().isArray().isInt({ min: 1, max: 100 }).toInt(),
  body('labourRate', 'Enter the labour charge per hour, above 0').optional({ values: 'null' }).not().isArray().isFloat({ gt: 0, max: MAX_NUMBER }).toFloat(),
  ...['oil', 'transmission'].map((service) =>
    body(`rates.${service}`, 'Enter the rate per km, above 0').optional({ values: 'null' }).not().isArray().isFloat({ gt: 0, max: MAX_NUMBER }).toFloat()
  ),
  ...KM_INTERVALS.flatMap((service) => [
    body(`intervals.${service}.everyKm`, 'Enter the interval in km, above 0').not().isArray().isFloat({ gt: 0, max: MAX_NUMBER }).toFloat(),
    body(`intervals.${service}.lastKm`, 'Enter the km at the last service, 0 or more').optional({ values: 'null' }).not().isArray().isFloat({ min: 0, max: MAX_NUMBER }).toFloat(),
  ]),
  body('intervals.battery.everyMonths', 'Enter the battery interval in months, above 0').not().isArray().isInt({ min: 1, max: 600 }).toInt(),
  body('intervals.battery.lastDate', 'Choose when the battery was last changed').optional({ values: 'null' }).isString().matches(/^\d{4}-\d{2}-\d{2}/).isISO8601({ strict: true }).toDate(),
];

export const validateBusCreate = [
  ...busRules(),
  str('vendorId', 'Vendor').isMongoId().withMessage('Choose the vendor responsible for this bus'),
  handleValidationErrors,
];

export const validateBusUpdate = [...busRules(), handleValidationErrors];

export const validateTicketCreate = [
  str('busId', 'Bus').isMongoId().withMessage('Choose a bus'),
  str('serviceType', 'Service type').isIn(SERVICE_TYPES).withMessage(`Service type must be one of: ${SERVICE_TYPES.join(', ')}`),
  body('repairCategory')
    .if(body('serviceType').equals('repair'))
    .isString()
    .isIn(REPAIR_CATEGORIES)
    .withMessage('Choose a repair category for repair VSRs'),
  body('currentReading', 'Enter the current reading as a whole number of kilometres')
    .not()
    .isArray()
    .isInt({ min: 0, max: MAX_NUMBER })
    .toInt(),
  body('vendorId', 'Choose a vendor').optional({ values: 'falsy' }).isString().isMongoId(),
  body('isBreakdown', 'Breakdown must be yes or no').optional({ values: 'null' }).isBoolean().toBoolean(),
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

export const validateSheetMonth = [
  qstr('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('Choose a valid month'),
  handleValidationErrors,
];

const sheetDay = () => [
  str('busId', 'Bus').isMongoId().withMessage('Choose a bus'),
  str('date', 'Day').matches(/^\d{4}-\d{2}-\d{2}$/).isISO8601({ strict: true }).withMessage('Choose a valid day'),
];

export const validateReadingUpdate = [
  ...sheetDay(),
  body('km', 'Enter the reading as a whole number of kilometres').optional({ values: 'null' }).not().isArray().isInt({ min: 0, max: MAX_NUMBER }).toInt(),
  handleValidationErrors,
];

export const validateBusStatusUpdate = [
  ...sheetDay(),
  str('status', 'Status').isIn(BUS_DAY_STATUSES).withMessage('Choose a valid status'),
  handleValidationErrors,
];

const NEGOTIATION_NOTE = 'Keep the note to 1000 characters or fewer';
const roundNote = () => body('note', NEGOTIATION_NOTE).optional({ values: 'falsy' }).isString().trim().isLength({ max: 1000 });

const daysToComplete = () => body('daysToComplete', 'Enter the number of days to complete the work').not().isArray().isInt({ min: 1, max: 3650 }).toInt();

export const validateEstimate = [
  body('amount', 'Enter the estimate amount').not().isArray().isFloat({ gt: 0, max: MAX_NUMBER }).toFloat(),
  str('quotationNumber', 'Quotation number').trim().isLength({ min: 1, max: 60 }).withMessage('Enter the quotation number'),
  daysToComplete(),
  roundNote(),
  handleValidationErrors,
];

export const validateEstimateReply = [
  body('amount', 'Enter a counter amount above 0, or leave it empty').optional({ values: 'falsy' }).not().isArray().isFloat({ gt: 0, max: MAX_NUMBER }).toFloat(),
  roundNote(),
  handleValidationErrors,
];

// Every date defaults to now when left out and can be overridden, but not into the future.
const stepDate = () =>
  body('date', 'Choose a valid date, today or earlier')
    .optional({ values: 'falsy' })
    .isString()
    .matches(/^\d{4}-\d{2}-\d{2}/)
    .isISO8601({ strict: true })
    .custom((value) => new Date(value) <= endOfUaeDay(uaeDay()))
    .toDate();

const reading = () => body('km', 'Enter the reading as a whole number of kilometres').not().isArray().isInt({ min: 0, max: MAX_NUMBER }).toInt();

export const validateStepDate = [stepDate(), handleValidationErrors];

export const validateVehicleReceived = [stepDate(), reading(), handleValidationErrors];

export const validateVehicleReturned = [
  stepDate(),
  reading(),
  body('replacedPartsReceived', 'Replaced parts received must be yes or no').optional({ values: 'null' }).isBoolean().toBoolean(),
  handleValidationErrors,
];

const optionalText = (field, max) => body(field, `Keep this to ${max} characters or fewer`).optional({ values: 'falsy' }).isString().trim().isLength({ max });

// A batch of VSRs arrives as comma-separated ids in a form or a query, and leaves as an array.
export const toIdList = (value) => (typeof value === 'string' ? value.split(',').map((id) => id.trim()).filter(Boolean) : []);
const validIdList = (value) => {
  const ids = toIdList(value);
  return ids.length > 0 && ids.length <= 200 && ids.every((id) => /^[0-9a-fA-F]{24}$/.test(id));
};
const BATCH_MESSAGE = 'Choose at least one VSR';

const documentNumber = () => str('number', 'Number').trim().isLength({ min: 1, max: 60 }).withMessage('Enter the number');
const documentNotes = () => body('notes', 'Keep the notes to 1000 characters or fewer').optional({ values: 'falsy' }).isString().trim().isLength({ max: 1000 });

export const validateGrn = [
  documentNumber(),
  body('ticketIds', BATCH_MESSAGE).custom(validIdList).customSanitizer(toIdList),
  stepDate(),
  documentNotes(),
  handleValidationErrors,
];

export const validateGrnExport = [query('ticketIds', BATCH_MESSAGE).custom(validIdList), handleValidationErrors];

export const validatePurchaseInvoice = [
  documentNumber(),
  str('grnId', 'GRN').isMongoId().withMessage('Choose a GRN'),
  stepDate(),
  body('amount', 'Enter an amount, 0 or more').optional({ values: 'falsy' }).not().isArray().isFloat({ min: 0, max: MAX_NUMBER }).toFloat(),
  documentNotes(),
  handleValidationErrors,
];

const isoDay = (field, message) => body(field, message).isString().matches(/^\d{4}-\d{2}-\d{2}/).isISO8601({ strict: true });

export const validateLpo = [
  documentNumber(),
  str('vendorId', 'Vendor').isMongoId().withMessage('Choose a vendor'),
  isoDay('validFrom', 'Choose the first day of the LPO').toDate(),
  isoDay('validTo', 'Choose the last day of the LPO, after the first').custom((value, { req }) => new Date(value) >= new Date(req.body.validFrom)).toDate(),
  body('items', 'Add at least one item').isArray({ min: 1, max: 200 }),
  body('items.*.kind', 'Choose what this item is for').isString().isIn(LPO_KINDS),
  body('items.*.name', 'Enter the item name').isString().trim().isLength({ min: 1, max: 120 }),
  optionalText('items.*.description', 300),
  body('items.*.quantity', 'Enter a quantity above 0').not().isArray().isFloat({ gt: 0, max: MAX_NUMBER }).toFloat(),
  body('items.*.unitPrice', 'Enter a unit price, 0 or more').not().isArray().isFloat({ min: 0, max: MAX_NUMBER }).toFloat(),
  handleValidationErrors,
];

export const validateAcknowledge = [note(), daysToComplete().optional({ values: 'null' }), handleValidationErrors];

export const validateBreakdown = [
  body('parts', 'Parts must be a list').optional({ values: 'null' }).isArray({ max: 200 }),
  body('parts.*.name', 'Enter the part name').isString().trim().isLength({ min: 1, max: 120 }),
  optionalText('parts.*.description', 300),
  optionalText('parts.*.code', 60),
  optionalText('parts.*.partNumber', 60),
  body('parts.*.quantity', 'Enter a quantity above 0').not().isArray().isFloat({ gt: 0, max: MAX_NUMBER }).toFloat(),
  body('parts.*.unitPrice', 'Enter a unit price, 0 or more').not().isArray().isFloat({ min: 0, max: MAX_NUMBER }).toFloat(),
  body('labourHours', 'Enter the labour hours, 0 or more').optional({ values: 'null' }).not().isArray().isFloat({ min: 0, max: 100000 }).toFloat(),
  body('consumables', 'Enter the consumables and other costs, 0 or more').optional({ values: 'null' }).not().isArray().isFloat({ min: 0, max: MAX_NUMBER }).toFloat(),
  optionalText('remarks', 1000),
  handleValidationErrors,
];

export const validateAttachmentParams = [
  param('id').isMongoId().withMessage('Invalid ID'),
  param('attachmentId').isMongoId().withMessage('Invalid ID'),
  handleValidationErrors,
];

export const validateTicketReturn = [
  str('reason', 'Reason').trim().isLength({ min: 1, max: 500 }).withMessage('Enter why the VSR is being returned, in 500 characters or fewer'),
  handleValidationErrors,
];

export const validateInvoiceSubmit = [
  body('amount').isFloat({ min: 0, max: MAX_NUMBER }).withMessage('Amount must be 0 or more').toFloat(),
  str('description', 'Description')
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage('Description must be between 10 and 500 characters'),
  str('invoiceNumber', 'Invoice number').trim().isLength({ min: 1, max: 60 }).withMessage('Enter the invoice number'),
  handleValidationErrors,
];

export const validateInvoiceReject = [note('reason'), handleValidationErrors];

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
