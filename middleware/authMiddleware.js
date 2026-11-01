import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import config from '../config/config.js';

/**
 * Verifies the Bearer token and attaches the current user (without password) to req.user.
 * Responses carry a stable code so the client can tell "sign in again" apart from other 401s.
 */
const authMiddleware = async (req, res, next) => {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ success: false, code: 'NO_TOKEN', message: 'Authentication required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      message: expired ? 'Your session has expired. Please sign in again.' : 'Invalid authentication token',
    });
  }

  if (typeof decoded.id !== 'string' || !/^[a-f\d]{24}$/i.test(decoded.id)) {
    return res.status(401).json({ success: false, code: 'TOKEN_INVALID', message: 'Invalid authentication token' });
  }

  try {
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ success: false, code: 'USER_NOT_FOUND', message: 'Account no longer exists' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
};

export default authMiddleware;
