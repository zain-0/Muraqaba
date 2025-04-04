const roleMiddleware = (roles) => {
    return (req, res, next) => {
      
      // Check if the user's role is in the allowed roles array
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ message: 'Permission denied' });
      }
  
      next();  // Allow the request to proceed
    };
  };
  
  export default roleMiddleware;
  