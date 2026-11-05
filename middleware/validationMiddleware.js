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
const TOO_LARGE = 'That number is too large';
const WHOLE = 'Enter a whole number';
const TWO_DECIMALS = 'Use at most 2 decimals';

/** Money is in fils at the finest: no more than two decimals. */
const twoDecimals = (value) => {
  const scaled = Number(value) * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};

/**
 * A number field. `message` covers anything that is not a number in range at the low end;
 * a number that is too large, has decimals where only whole ones fit, or has more decimals
 * than money does, each gets its own message, so the screen says what is actually wrong.
 */
const number = (field, message, { above, min = 0, max = MAX_NUMBER, whole = false, money = false } = {}) =>
  body(field)
    .not()
    .isArray()
    .withMessage(message)
    .isFloat(above === undefined ? { min } : { gt: above })
    .withMessage(message)
    .bail()
    .custom((value) => Number(value) <= max)
    .withMessage(TOO_LARGE)
    .bail()
    .custom((value) => !whole || Number.isInteger(Number(value)))
    .withMessage(WHOLE)
    .custom((value) => !money || twoDecimals(value))
    .withMessage(TWO_DECIMALS)
    .toFloat();

/** A whole number of kilometres: decimals and minus signs share one message, size its own. */
const km = (field, message) => body(field, message).not().isArray().isInt({ min: 0 }).bail().custom((value) => Number(value) <= MAX_NUMBER).withMessage(TOO_LARGE).toInt();

/** Text that must be there, within a length the screens can show. */
const requiredText = (field, label, required, max) =>
  str(field, label).trim().notEmpty().withMessage(required).bail().isLength({ max }).withMessage(`Keep this to ${max} characters or fewer`);
const MAX_PAGE = 100000;

const email = () => str('email', 'Email').trim().toLowerCase().isEmail().withMessage('Enter a valid email address');
const password = () =>
  str('password', 'Password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters')
    .bail()
    .isLength({ max: 128 })
    .withMessage('Keep the password to 128 characters or fewer')
    .bail()
    .matches(/\S/)
    .withMessage('Password cannot be only spaces');
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

const isDay = (field, message) => body(field, message).isString().matches(/^\d{4}-\d{2}-\d{2}/).isISO8601({ strict: true }).bail();

const yearsAhead = (years) => {
  const limit = new Date();
  limit.setUTCFullYear(limit.getUTCFullYear() + years);
  return limit;
};

// Rate times interval is the price of the service, which has to stay a sensible amount.
const priceFits = (service) => (value, { req }) => !(Number(value) * Number(req.body.intervals?.[service]?.everyKm) > MAX_NUMBER);

// A battery was changed between the bus being built (a model year can start the year before) and today.
const batteryDateFits = (value, { req }) => {
  const when = new Date(value);
  const year = Number(req.body.year);
  const built = Number.isInteger(year) ? new Date(Date.UTC(year - 1, 0, 1)) : new Date(0);
  return when >= built && when <= endOfUaeDay(uaeDay());
};

const busRules = () => [
  requiredText('chassisNumber', 'Chassis number', 'Chassis number is required', 30),
  requiredText('fleetNumber', 'Site number', 'Site number is required', 30),
  requiredText('registrationNumber', 'Registration number', 'Registration number is required', 30),
  requiredText('make', 'Brand', 'Brand is required', 60),
  requiredText('model', 'Type', 'Type is required', 60),
  body('year')
    .isInt({ min: 1900, max: new Date().getFullYear() + 1 })
    .withMessage('Enter a valid model year')
    .toInt(),
  isDay('registrationExpiry', 'Enter the registration expiry date')
    .custom((value) => new Date(value) <= yearsAhead(10))
    .withMessage('Choose an expiry date within the next 10 years')
    .toDate(),
  body('expectedLifeYears', 'Enter the expected life in years').not().isArray().isInt({ min: 1, max: 100 }).toInt(),
  number('labourRate', 'Enter the labour charge per hour, above 0', { above: 0, money: true }).optional({ values: 'null' }),
  ...['oil', 'transmission'].map((service) =>
    number(`rates.${service}`, 'Enter the rate per km, above 0', { above: 0, money: true })
      .custom(priceFits(service))
      .withMessage('That rate makes the service price too large')
      .optional({ values: 'null' })
  ),
  ...KM_INTERVALS.flatMap((service) => [
    number(`intervals.${service}.everyKm`, 'Enter the interval in km, above 0', { above: 0, whole: true }),
    number(`intervals.${service}.lastKm`, 'Enter the km at the last service, 0 or more', { whole: true }).optional({ values: 'null' }),
  ]),
  body('intervals.battery.everyMonths', 'Enter the battery interval in months, above 0').not().isArray().isInt({ min: 1, max: 600 }).toInt(),
  isDay('intervals.battery.lastDate', 'Choose when the battery was last changed')
    .custom(batteryDateFits)
    .withMessage('Choose a date from the year the bus was built until today')
    .toDate()
    .optional({ values: 'null' }),
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
  km('currentReading', 'Enter the current reading as a whole number of kilometres'),
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
  km('km', 'Enter the reading as a whole number of kilometres').optional({ values: 'null' }),
  handleValidationErrors,
];

export const validateBusStatusUpdate = [
  ...sheetDay(),
  str('status', 'Status').isIn(BUS_DAY_STATUSES).withMessage('Choose a valid status'),
  handleValidationErrors,
];

const NEGOTIATION_NOTE = 'Keep the note to 1000 characters or fewer';
const roundNote = () => body('note', NEGOTIATION_NOTE).optional({ values: 'falsy' }).isString().trim().isLength({ max: 1000 });

const daysToComplete = () => body('daysToComplete', 'Enter a whole number of days, from 1 to 3650').not().isArray().isInt({ min: 1, max: 3650 }).toInt();

/** A number someone copies off a document: needed, and short enough to show. */
const referenceNumber = (field, label, required) => requiredText(field, label, required, 60).withMessage('Keep the number to 60 characters or fewer');

export const validateEstimate = [
  number('amount', 'Enter the estimate amount', { above: 0, money: true }),
  referenceNumber('quotationNumber', 'Quotation number', 'Enter the quotation number'),
  daysToComplete(),
  roundNote(),
  handleValidationErrors,
];

export const validateEstimateReply = [
  number('amount', 'Enter a counter amount above 0, or leave it empty', { above: 0, money: true }).optional({ values: 'falsy' }),
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

const reading = () => km('km', 'Enter the reading as a whole number of kilometres');

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

const documentNumber = () => referenceNumber('number', 'Number', 'Enter the number');
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
  number('amount', 'Enter an amount, 0 or more', { money: true }).optional({ values: 'falsy' }),
  documentNotes(),
  handleValidationErrors,
];

// Tyres and batteries come off an LPO by the unit, so a line of them is a whole number.
const countedInWholeUnits = (value, { req, path }) => {
  const kind = req.body.items?.[Number(/\[(\d+)\]/.exec(path)?.[1])]?.kind;
  return !['tyre', 'battery'].includes(kind) || Number.isInteger(Number(value));
};

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
  number('items.*.quantity', 'Enter a quantity above 0', { above: 0 }).custom(countedInWholeUnits).withMessage(WHOLE),
  number('items.*.unitPrice', 'Enter a unit price, 0 or more', { money: true }),
  handleValidationErrors,
];

const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_PREFIX = 'data:image/png;base64,';

export const validateSignature = [
  body('image', 'Draw your signature')
    .isString()
    .custom((value) => value.startsWith(PNG_PREFIX) && Buffer.from(value.slice(PNG_PREFIX.length, PNG_PREFIX.length + 12), 'base64').subarray(0, 8).equals(PNG_START)),
  handleValidationErrors,
];

export const validateAcknowledge = [note(), daysToComplete().optional({ values: 'null' }), handleValidationErrors];

export const validateBreakdown = [
  body('parts', 'Parts must be a list').optional({ values: 'null' }).isArray({ max: 200 }),
  body('parts.*.name', 'Enter the part name').isString().trim().isLength({ min: 1, max: 120 }),
  optionalText('parts.*.description', 300),
  optionalText('parts.*.code', 60),
  optionalText('parts.*.partNumber', 60),
  number('parts.*.quantity', 'Enter a quantity above 0', { above: 0 }),
  number('parts.*.unitPrice', 'Enter a unit price, 0 or more', { money: true }),
  number('labourHours', 'Enter the labour hours, 0 or more', { max: 100000, money: true }).optional({ values: 'null' }),
  number('consumables', 'Enter the consumables and other costs, 0 or more', { money: true }).optional({ values: 'null' }),
  number('unitsFitted', 'Enter how many were fitted, above 0', { above: 0, whole: true }).optional({ values: 'null' }),
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
  number('amount', 'Amount must be 0 or more', { money: true }),
  str('description', 'Description')
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage('Description must be between 10 and 500 characters'),
  referenceNumber('invoiceNumber', 'Invoice number', 'Enter the invoice number'),
  handleValidationErrors,
];

export const validateInvoiceReject = [note('reason'), handleValidationErrors];

export const validateTicketDecline = [
  str('reason', 'Reason').trim().isLength({ min: 1, max: 500 }).withMessage('Enter why the job is being declined, in 500 characters or fewer'),
  handleValidationErrors,
];

export const validateAdditionalJob = [
  number('amount', 'Enter the estimate amount', { above: 0, money: true }),
  referenceNumber('quotationNumber', 'Quotation number', 'Enter the quotation number'),
  daysToComplete(),
  str('serviceType', 'Service type').isIn(['repair', 'tyre', 'battery', 'other']).withMessage('Choose what kind of work this is'),
  body('repairCategory').if(body('serviceType').equals('repair')).isString().isIn(REPAIR_CATEGORIES).withMessage('Choose a repair category for repair VSRs'),
  str('description', 'Description').trim().isLength({ min: 10, max: 1000 }).withMessage('Describe the additional work, in 10 to 1000 characters'),
  roundNote(),
  handleValidationErrors,
];

const reportYear = () => qstr('year').isInt({ min: 2000, max: 2100 }).withMessage('Choose a valid year');

export const validateReportQuery = [
  reportYear(),
  qstr('brand').isLength({ max: 120 }).withMessage('Choose a valid brand'),
  qstr('type').isIn(['accident', 'repair', 'maintenance', 'oil', 'transmission', 'tyre', 'battery', 'other']).withMessage('Choose a valid kind of work'),
  qstr('vendorId').isMongoId().withMessage('Choose a valid vendor'),
  qstr('busId').isMongoId().withMessage('Choose a valid bus'),
  qstr('isBreakdown').isBoolean().withMessage('Breakdown must be yes or no'),
  qstr('groupBy').isIn(['brand', 'month', 'bus', 'vendor', 'type']).withMessage('Choose a valid grouping'),
  handleValidationErrors,
];

export const validateFleetFigures = [reportYear(), qstr('brand').isLength({ max: 120 }).withMessage('Choose a valid brand'), handleValidationErrors];

export const validateScan = [
  body('attachmentId', 'Choose a valid file').optional({ values: 'falsy' }).isString().isMongoId(),
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
