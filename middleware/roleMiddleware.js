/**
 * Allows the request only if the role of the authenticated user is in roles.
 * Must run after authMiddleware.
 */
const roleMiddleware = (roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, code: 'NO_TOKEN', message: 'Authentication required' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      code: 'FORBIDDEN',
      message: `This action is only available to: ${roles.join(', ')}`,
    });
  }
  return next();
};

export default roleMiddleware;
