import mongoose from 'mongoose';
import { AppError } from '../middleware/errorMiddleware.js';

/** Numbers people type are the same number whatever their letter case: "lpo-7" is "LPO-7". */
export const CASE_BLIND = { locale: 'en', strength: 2 };

/**
 * Refuses values another record already uses, ignoring letter case, and names every clashing
 * field at once. The unique indexes still guard exact duplicates that race past this check.
 */
export const assertNoClash = async (Model, values, exceptId) => {
  const fields = Object.entries(values).filter(([, value]) => typeof value === 'string' && value);
  const clashes = await Promise.all(
    fields.map(async ([field, value]) => {
      const filter = { [field]: value };
      if (exceptId) filter._id = mongoose.trusted({ $ne: exceptId });
      return (await Model.exists(filter).collation(CASE_BLIND)) ? field : null;
    })
  );
  const errors = clashes.filter(Boolean).map((field) => ({ field, message: 'Already in use' }));
  if (errors.length) throw new AppError(`A record with this ${errors[0].field} already exists`, 409, 'DUPLICATE', errors);
};
