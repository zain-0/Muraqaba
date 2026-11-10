import { body, param, query, validationResult } from 'express-validator';
import { ROLES } from '../models/User.js';
import { SERVICE_TYPES, REPAIR_CATEGORIES, TICKET_STATUSES, NO_CHARGE_REASONS, WORK_LOCATIONS, ACCIDENT_SEVERITIES, ACCIDENT_FAULTS } from '../models/Ticket.js';
import { BUS_DAY_STATUSES } from '../models/BusDaily.js';
import { LPO_ITEM_CATEGORIES } from '../models/Purchase.js';
import { SCRAP_REASONS, SCRAP_REQUEST_STATUSES } from '../models/ScrapRequest.js';
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
const FOUR_DECIMALS = 'Use at most 4 decimals';

/** No more decimals than `places`. Money is in fils at the finest, so two. */
const atMostDecimals = (value, places) => {
  const scaled = Number(value) * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};
const twoDecimals = (value) => atMostDecimals(value, 2);

/**
 * A number field. `message` covers anything that is not a number in range at the low end;
 * a number that is too large, has decimals where only whole ones fit, or has more decimals
 * than money does, each gets its own message, so the screen says what is actually wrong.
 */
const number = (field, message, { above, min = 0, max = MAX_NUMBER, whole = false, money = false, rate = false, when } = {}) =>
  (when ? body(field).if(when) : body(field))
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
    .custom((value) => !rate || atMostDecimals(value, 4))
    .withMessage(FOUR_DECIMALS)
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

const KM_INTERVALS = ['oil', 'transmission', 'tyre', 'brakePads'];

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

/** Text that may be left empty; the controller then leaves the field out. */
export const hasText = (value) => typeof value === 'string' && value.trim() !== '';
const optionalNumber = (field, label) =>
  body(field).optional({ values: 'falsy' }).isString().withMessage(`${label} must be text`).trim().isLength({ max: 30 }).withMessage('Keep this to 30 characters or fewer');
const registered = (value, { req }) => hasText(req.body.registrationNumber);

const busRules = () => [
  // A new bus can run for months before it is registered, and the depot's records hold no chassis numbers.
  optionalNumber('chassisNumber', 'Chassis number'),
  requiredText('fleetNumber', 'Side number', 'Side number is required', 30),
  optionalNumber('registrationNumber', 'Registration number'),
  requiredText('make', 'Brand', 'Brand is required', 60),
  requiredText('model', 'Type', 'Type is required', 60),
  body('year')
    .isInt({ min: 1900, max: new Date().getFullYear() + 1 })
    .withMessage('Enter a valid model year')
    .toInt(),
  body('registrationExpiry', 'Enter the registration expiry date')
    .if(registered)
    .isString()
    .matches(/^\d{4}-\d{2}-\d{2}/)
    .isISO8601({ strict: true })
    .bail()
    .custom((value) => new Date(value) <= yearsAhead(10))
    .withMessage('Choose an expiry date within the next 10 years')
    .toDate(),
  body('registrationExpiry', 'An expiry date goes only with a registration number')
    .if((value, meta) => !registered(value, meta))
    .custom((value) => value === undefined || value === null || value === ''),
  body('expectedLifeYears', 'Enter the expected life in years').not().isArray().isInt({ min: 1, max: 100 }).toInt(),
  number('labourRate', 'Enter the labour charge per hour, above 0', { above: 0, money: true }).optional({ values: 'null' }),
  ...['oil', 'transmission'].map((service) =>
    // A rate per km is finer than money: 3,300 for a 40,000 km service is 0.0825 a km.
    number(`rates.${service}`, 'Enter the rate per km, above 0', { above: 0, rate: true })
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

const SEVERITY = 'Choose how serious the accident was';
const FAULT = 'Choose who was at fault';
const isAccident = (value, { req }) => req.body.serviceType === 'repair' && req.body.repairCategory === 'ACCIDENT';

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
  body('location', 'Choose where the work is done').optional({ values: 'falsy' }).isString().isIn(WORK_LOCATIONS),
  // For the depot's own records: required on an accident repair, and dropped on anything else.
  body('accident.severity', SEVERITY).if(isAccident).isString().isIn(ACCIDENT_SEVERITIES),
  body('accident.fault', FAULT).if(isAccident).isString().isIn(ACCIDENT_FAULTS),
  body('description')
    .optional({ values: 'falsy' })
    .isString()
    .withMessage('Description must be text')
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description must be 1000 characters or fewer'),
  // The LPO line and what it books (2026-11-10). Whether each is needed depends on the lines there are, so the controller asks for them.
  body('lpoItemId', 'This LPO cannot be used for this job').optional({ values: 'falsy' }).isString().isMongoId(),
  number('quantity', 'Enter how many', { above: 0, whole: true }).optional({ values: 'falsy' }),
  number('estimatedAmount', 'Enter the estimated amount', { above: 0, money: true }).optional({ values: 'falsy' }),
  handleValidationErrors,
];

export const validateTransitionNote = [note(), handleValidationErrors];

export const validateAccident = [
  body('severity', SEVERITY).isString().isIn(ACCIDENT_SEVERITIES),
  body('fault', FAULT).isString().isIn(ACCIDENT_FAULTS),
  handleValidationErrors,
];

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
  str('status', 'Status')
    .isIn(BUS_DAY_STATUSES)
    .withMessage('Choose a valid status')
    .bail()
    // Since 2026-11-09 the supervisor approves a scrap request and records the sale; the sheet follows them.
    .not()
    .isIn(['scrapping', 'removed'])
    .withMessage('Scrapping and selling go through a scrap request.'),
  handleValidationErrors,
];

const NEGOTIATION_NOTE = 'Keep the note to 1000 characters or fewer';
const roundNote = () => body('note', NEGOTIATION_NOTE).optional({ values: 'falsy' }).isString().trim().isLength({ max: 1000 });

const daysToComplete = () => body('daysToComplete', 'Enter a whole number of days, from 1 to 3650').not().isArray().isInt({ min: 1, max: 3650 }).toInt();

/** A number someone copies off a document: needed, and short enough to show. */
const referenceNumber = (field, label, required) => requiredText(field, label, required, 60).withMessage('Keep the number to 60 characters or fewer');

/**
 * A vendor's estimate may be AED 0 for warranty, goodwill, insurance or free-of-charge work, and
 * then has to say which; a reason never goes with a price. A form sends an empty choice as "".
 */
const NO_CHARGE = 'Enter an amount above 0, or choose why there is no charge';
const estimateAmount = () =>
  number('amount', 'Enter the estimate amount', { money: true })
    .custom((value, { req }) => Number(value) > 0 || hasText(req.body.noChargeReason))
    .withMessage(NO_CHARGE);
const noChargeReason = () =>
  body('noChargeReason')
    .optional({ values: 'falsy' })
    .isString()
    .isIn(NO_CHARGE_REASONS)
    .withMessage('Choose a valid reason for no charge')
    .bail()
    .custom((value, { req }) => Number(req.body.amount) === 0)
    .withMessage('A reason for no charge goes only with an amount of 0');

export const validateEstimate = [
  estimateAmount(),
  noChargeReason(),
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

// At the depot the vendor gives the reading when starting, since the bus was never received.
export const validateWorkStart = [stepDate(), reading().optional({ values: 'null' }), handleValidationErrors];

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

const isoDay = (field, message) => body(field, message).isString().matches(/^\d{4}-\d{2}-\d{2}/).isISO8601({ strict: true });

/** The LPO line a wildcard path such as items[2].make is about. */
const lineAt = (req, path) => req.body.items?.[Number(/\[(\d+)\]/.exec(path)?.[1])];
const lineIs = (...kinds) => (value, { req, path }) => kinds.includes(lineAt(req, path)?.kind);
const COUNTED = lineIs('tyre', 'battery');
const REPAIR_MAINTENANCE = lineIs('repairMaintenance');

/** A repair and maintenance line is one amount; it is read from unitPrice, or from total or amount if that is what came. */
const repairAmount = (items) =>
  Array.isArray(items)
    ? items.map((item) => (item?.kind === 'repairMaintenance' && [undefined, null, ''].includes(item.unitPrice) ? { ...item, unitPrice: item.total ?? item.amount } : item))
    : items;

/** Text a line needs, such as its make or tyre size, for the kinds of line that need it. */
const lineText = (field, when, message) =>
  body(field).if(when).isString().withMessage(message).bail().trim().notEmpty().withMessage(message).bail().isLength({ max: 60 }).withMessage('Keep this to 60 characters or fewer');

/**
 * An LPO as purchasing enters it (2026-11-10): its date, number, vendor and days, and lines of
 * Repair & Maintenance (a make and an amount), Tyre (a size, quantity, unit price and optional life
 * in km) or Battery (a type, quantity and unit price). The API names each line; a name sent is not read.
 */
export const validateLpo = [
  body('items').customSanitizer(repairAmount),
  documentNumber(),
  str('vendorId', 'Vendor').isMongoId().withMessage('Choose a vendor'),
  isoDay('date', 'Choose the LPO date').toDate(),
  isoDay('validFrom', 'Choose the first day of the LPO').toDate(),
  isoDay('validTo', 'Choose the last day of the LPO, after the first').custom((value, { req }) => new Date(value) >= new Date(req.body.validFrom)).toDate(),
  body('items', 'Add at least one item').isArray({ min: 1, max: 200 }),
  body('items.*.kind', 'Choose what this item is for').isString().isIn(LPO_ITEM_CATEGORIES),
  lineText('items.*.make', REPAIR_MAINTENANCE, 'Choose the make this item is for'),
  lineText('items.*.size', lineIs('tyre'), 'Enter the tyre size'),
  lineText('items.*.size', lineIs('battery'), 'Enter the battery type'),
  number('items.*.lifeKm', 'Enter the life in km as a whole number above 0', { above: 0, whole: true, when: lineIs('tyre') }).optional({ values: 'falsy' }),
  optionalText('items.*.description', 300),
  number('items.*.quantity', 'Enter a quantity above 0', { above: 0, whole: true, when: COUNTED }),
  number('items.*.unitPrice', 'Enter a unit price above 0', { above: 0, money: true, when: COUNTED }),
  number('items.*.unitPrice', 'Enter the amount, above 0', { above: 0, money: true, when: REPAIR_MAINTENANCE }),
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
  estimateAmount(),
  noChargeReason(),
  referenceNumber('quotationNumber', 'Quotation number', 'Enter the quotation number'),
  daysToComplete(),
  str('serviceType', 'Service type').isIn(['repair', 'tyre', 'battery', 'brakePads', 'other']).withMessage('Choose what kind of work this is'),
  body('repairCategory').if(body('serviceType').equals('repair')).isString().isIn(REPAIR_CATEGORIES).withMessage('Choose a repair category for repair VSRs'),
  str('description', 'Description').trim().isLength({ min: 10, max: 1000 }).withMessage('Describe the additional work, in 10 to 1000 characters'),
  roundNote(),
  handleValidationErrors,
];

const reportYear = () => qstr('year').isInt({ min: 2000, max: 2100 }).withMessage('Choose a valid year');

export const validateReportQuery = [
  reportYear(),
  qstr('brand').isLength({ max: 120 }).withMessage('Choose a valid brand'),
  qstr('type').isIn(['accident', 'repair', 'maintenance', 'oil', 'transmission', 'tyre', 'battery', 'brakePads', 'other']).withMessage('Choose a valid kind of work'),
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

export const validateScrapRequestList = [
  qstr('status').isIn(SCRAP_REQUEST_STATUSES).withMessage('Unknown status'),
  qstr('busId').isMongoId().withMessage('Invalid bus'),
  ...pageQuery,
  handleValidationErrors,
];

export const validateScrapRequest = [
  str('busId', 'Bus').isMongoId().withMessage('Choose a bus'),
  str('reason', 'Reason').isIn(SCRAP_REASONS).withMessage('Choose why the bus should be scrapped'),
  roundNote(),
  handleValidationErrors,
];

export const validateScrapApproval = [roundNote(), handleValidationErrors];

/** Text that must be there: missing, empty or not text all ask for it the same way. */
const needed = (field, message, max) =>
  body(field, message).isString().bail().trim().notEmpty().bail().isLength({ max }).withMessage(`Keep this to ${max} characters or fewer`);

export const validateScrapRejection = [needed('note', 'Enter why the scrap request is turned down', 1000), handleValidationErrors];

// Kept as a plain UAE day, like the daily sheets, so the sale and the sheet's Removed day are one day.
export const validateSale = [
  body('date', 'Choose the day the bus was sold')
    .isString()
    .bail()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .bail()
    .isISO8601({ strict: true })
    .bail()
    .custom((value) => value <= uaeDay())
    .withMessage('The sale date cannot be in the future'),
  needed('buyer', 'Enter who bought the bus', 200),
  number('price', 'Enter the price, 0 or more', { money: true }),
  roundNote(),
  handleValidationErrors,
];

export const validateLpoPreview = [
  query('busId').isString().withMessage('Choose a bus').bail().isMongoId().withMessage('Choose a bus'),
  query('serviceType').isString().withMessage('Choose the service type').bail().isIn(SERVICE_TYPES).withMessage('Choose the service type'),
  // A VSR being corrected, whose own booking is left out of what is left.
  query('ticketId').optional({ values: 'falsy' }).isString().isMongoId().withMessage('Choose a valid VSR'),
  handleValidationErrors,
];
