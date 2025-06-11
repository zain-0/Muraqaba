import { body, param, validationResult } from 'express-validator';

// Generic validation error handler
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

// Auth validation rules
export const validateRegister = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  body('role')
    .isIn(['vendor', 'serviceCreator', 'supervisor', 'purchaseManager'])
    .withMessage('Valid role is required'),
  handleValidationErrors
];

export const validateLogin = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  handleValidationErrors
];

// Bus validation rules
export const validateBusCreate = [
  body('chassisNumber')
    .trim()
    .notEmpty()
    .withMessage('Chassis number is required'),
  body('fleetNumber')
    .trim()
    .notEmpty()
    .withMessage('Fleet number is required'),
  body('registrationNumber')
    .trim()
    .notEmpty()
    .withMessage('Registration number is required'),
  body('make')
    .trim()
    .notEmpty()
    .withMessage('Make is required'),
  body('model')
    .trim()
    .notEmpty()
    .withMessage('Model is required'),
  body('year')
    .isInt({ min: 1900, max: new Date().getFullYear() + 1 })
    .withMessage('Valid year is required'),
  body('vendorId')
    .isMongoId()
    .withMessage('Valid vendor ID is required'),
  body('engine.serviceKm')
    .isNumeric()
    .withMessage('Engine service KM must be a number'),
  body('engine.currentKm')
    .isNumeric()
    .withMessage('Engine current KM must be a number'),
  handleValidationErrors
];

// Ticket validation rules
export const validateTicketCreate = [
  body('busId')
    .isMongoId()
    .withMessage('Valid bus ID is required'),
  body('serviceType')
    .isIn(['minor', 'major', 'repair', 'other'])
    .withMessage('Valid service type is required'),
  body('vendorId')
    .isMongoId()
    .withMessage('Valid vendor ID is required'),
  body('repairCategory')
    .optional()
    .isIn(['ELECTRICAL', 'MECHANICAL', 'AC REPAIR', 'ENGINE', 'BODY', 'BATTERY REPLACEMENT', 'TYRE REPLACEMENT'])
    .withMessage('Valid repair category is required for repair tickets'),
  handleValidationErrors
];

// Invoice validation rules
export const validateInvoiceSubmit = [
  body('amount')
    .isFloat({ min: 0 })
    .withMessage('Amount must be a positive number'),
  body('description')
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage('Description must be between 10 and 500 characters'),
  handleValidationErrors
];

// Repair request validation rules
export const validateRepairRequest = [
  body('busId')
    .isMongoId()
    .withMessage('Valid bus ID is required'),
  body('description')
    .trim()
    .isLength({ min: 10, max: 500 })
    .withMessage('Description must be between 10 and 500 characters'),
  body('repairCategory')
    .isIn(['ELECTRICAL', 'MECHANICAL', 'AC REPAIR', 'ENGINE', 'BODY', 'BATTERY REPLACEMENT', 'TYRE REPLACEMENT'])
    .withMessage('Valid repair category is required'),
  handleValidationErrors
];

// Parameter validation
export const validateObjectId = [
  param('id')
    .isMongoId()
    .withMessage('Valid ID is required'),
  handleValidationErrors
];

export const validateStatus = [
  body('status')
    .notEmpty()
    .withMessage('Status is required'),
  handleValidationErrors
];

// Vendor creation validation rules
export const validateVendorCreate = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  handleValidationErrors
];
