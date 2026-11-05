/**
 * Each person's signature is saved once as an image. A stamp copies their name and role and
 * points at the image they had that day, so changing a signature later alters no old VSR.
 */
import { AppError } from '../middleware/errorMiddleware.js';

export const assertCanSign = (user) => {
  if (!user.signatureImage) {
    throw new AppError('Add your signature before doing this step.', 409, 'SIGNATURE_REQUIRED');
  }
};

export const stamp = (ticket, user, step, at = new Date()) => {
  assertCanSign(user);
  ticket.signatures.push({ step, by: user._id, name: user.name, role: user.role, image: user.signatureImage, at });
};
