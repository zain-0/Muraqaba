import config from '../config/config.js';

export class AppError extends Error {
  /**
   * @param {string} message user-safe message
   * @param {number} statusCode HTTP status
   * @param {string} [code] stable machine-readable code
   * @param {Array<{field: string, message: string}>} [errors] field-level errors for forms
   */
  constructor(message, statusCode = 500, code, errors) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const notFound = (req, res, next) => {
  next(new AppError(`Not Found - ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed', errors });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      code: 'DUPLICATE',
      message: `A record with this ${field} already exists`,
      errors: [{ field, message: 'Already in use' }],
    });
  }

  if (err.name === 'CastError') {
    const isId = !err.path || err.path === '_id' || /Id$/.test(err.path);
    return res.status(400).json({
      success: false,
      code: isId ? 'INVALID_ID' : 'INVALID_VALUE',
      message: isId ? 'Invalid ID format' : `Invalid value for ${err.path}`,
    });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, code: 'BAD_JSON', message: 'Request body is not valid JSON' });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' });
  }

  // Optimistic concurrency: someone else changed the record between our read and our write.
  if (err.name === 'VersionError') {
    return res.status(409).json({
      success: false,
      code: 'INVALID_STATE',
      message: 'This record was changed by someone else a moment ago. Refresh and try again.',
    });
  }

  const status = err.statusCode || err.status || 500;
  // A 502 or 503 we raised on purpose is an expected outcome, not a crash.
  if (status === 500 || (status > 500 && !err.isOperational)) {
    console.error('Unhandled error:', err);
  }
  return res.status(status).json({
    success: false,
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    message: status >= 500 && config.isProduction ? 'Internal Server Error' : err.message || 'Internal Server Error',
    ...(Array.isArray(err.errors) && status < 500 && { errors: err.errors }),
    ...(config.env === 'development' && status >= 500 && { stack: err.stack }),
  });
};
