/**
 * Query checks for purchasing's reports. An empty value (`?month=`) counts as left out; a value
 * given twice arrives as a list and is refused, so a filter always means one thing.
 */
import { query } from 'express-validator';
import { handleValidationErrors } from './validationMiddleware.js';
import { LPO_KINDS } from '../models/Purchase.js';

// Maintenance is the oil service alone since 2026-11-11, when transmission and brake pads became repair categories.
export const REPORT_TYPES = ['accident', 'repair', 'maintenance', 'oil', 'tyre', 'battery', 'other'];

const optional = (field) => query(field).optional({ values: 'falsy' }).isString().withMessage(`${field} must appear once`).bail();

const year = () => optional('year').isInt({ min: 2000, max: 2100 }).withMessage('Choose a valid year');
const month = () => optional('month').isInt({ min: 1, max: 12 }).withMessage('Choose a month from 1 to 12');
const brand = () => optional('brand').isLength({ max: 120 }).withMessage('Choose a valid brand');
const type = () => optional('type').isIn(REPORT_TYPES).withMessage('Choose a valid kind of work');
const vendorId = () => optional('vendorId').isMongoId().withMessage('Choose a valid vendor');
const all = () => optional('all').isIn(['true', 'false']).withMessage('all must be true or false');
const lpoKind = () => optional('kind').isIn(LPO_KINDS).withMessage('Choose a valid kind of item');
const inDate = () => optional('inDate').isIn(['true', 'false']).withMessage('inDate must be true or false');

/**
 * Custom dates: `from` and `to` are UAE days (YYYY-MM-DD), given together, and win over the year
 * and month. The end may be after today. The longest range is three years, so no report has to
 * count more days than that.
 */
export const MAX_RANGE_DAYS = 1100;
const DAY_MS = 24 * 60 * 60 * 1000;
const given = (value) => value !== undefined && value !== '';
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const inYears = (value) => value >= '2000-01-01' && value <= '2100-12-31';
const day = (field, message) => () => optional(field).custom((value) => isDay(value) && inYears(value)).withMessage(message);
const pairOf = (field, other, message) => () => query(field).custom((value, { req }) => given(value) || !given(req.query[other])).withMessage(message);
const rangeFits = () =>
  query('to').custom((to, { req }) => {
    const { from } = req.query;
    // Anything else wrong with either date has its own message above.
    if (!isDay(from) || !isDay(to)) return true;
    if (to < from) throw new Error('The end date is before the start date');
    if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) throw new Error(`Choose dates no more than ${MAX_RANGE_DAYS.toLocaleString('en-US')} days apart`);
    return true;
  });
const range = [
  day('from', 'Choose a valid start date'),
  day('to', 'Choose a valid end date'),
  pairOf('from', 'to', 'Choose a start date as well as an end date'),
  pairOf('to', 'from', 'Choose an end date as well as a start date'),
  rangeFits,
];

const checks = (...list) => [...list.map((make) => make()), handleValidationErrors];

export const validateYear = checks(year);
/** Only the custom dates: put before a report whose other checks live elsewhere (Queries, fleet figures). */
export const validateRange = checks(...range);
export const validatePeriod = checks(year, ...range);
export const validateYearMonth = checks(year, month, ...range);
export const validateYearMonthBrand = checks(year, month, ...range, brand);
export const validateYearBrand = checks(year, ...range, brand);
export const validateCosts = checks(year, ...range, brand, type, vendorId);
export const validateInvoiceCheck = checks(year, ...range, all);
export const validateLpoBalances = checks(vendorId, lpoKind, inDate);
