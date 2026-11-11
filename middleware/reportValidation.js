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

const checks = (...list) => [...list.map((make) => make()), handleValidationErrors];

export const validateYear = checks(year);
export const validateYearMonth = checks(year, month);
export const validateYearMonthBrand = checks(year, month, brand);
export const validateYearBrand = checks(year, brand);
export const validateCosts = checks(year, brand, type, vendorId);
export const validateInvoiceCheck = checks(year, all);
export const validateLpoBalances = checks(vendorId, lpoKind, inDate);
