import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import config from '../config/config.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

const signToken = (user) =>
  jwt.sign({ id: String(user._id), role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

const publicUser = (user) => ({
  id: user._id,
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  hasSignature: Boolean(user.signatureImage),
});

// Compared against when the email is unknown, so login takes the same time either way
// and the response cannot be used to probe which emails have accounts.
const DUMMY_HASH = await bcrypt.hash(`not-a-real-password-${Date.now()}`, config.bcryptRounds);

const registrationConfig = () => ({
  enabled: config.allowPublicRegistration && config.selfRegisterRoles.length > 0,
  roles: config.allowPublicRegistration ? config.selfRegisterRoles : [],
});

// GET /api/auth/config  (public: lets the sign-up page show only what is allowed)
export const authConfig = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { registration: registrationConfig() } });
});

// POST /api/auth/register
export const registerUser = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;
  const registration = registrationConfig();

  if (!registration.enabled) {
    throw new AppError('Self registration is disabled. Ask an administrator for an account.', 403, 'REGISTRATION_DISABLED');
  }
  if (!registration.roles.includes(role)) {
    throw new AppError(
      `Accounts with the ${role} role are created by an administrator. You can self register as: ${registration.roles.join(', ')}.`,
      403,
      'ROLE_NOT_SELF_REGISTRABLE',
      [{ field: 'role', message: 'Not available for self registration' }]
    );
  }

  const existing = await User.findOne({ email });
  if (existing) {
    throw new AppError('An account with this email already exists', 409, 'DUPLICATE', [
      { field: 'email', message: 'Already in use' },
    ]);
  }

  const hashed = await bcrypt.hash(password, config.bcryptRounds);
  const user = await User.create({ name, email, password: hashed, role });

  res.status(201).json({
    success: true,
    message: 'Account created',
    token: signToken(user),
    user: publicUser(user),
  });
});

// POST /api/auth/login
export const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password');
  const matches = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
  // Same message for unknown email and wrong password so the endpoint does not reveal which accounts exist.
  if (!user || !matches) {
    throw new AppError('Incorrect email or password', 401, 'INVALID_CREDENTIALS');
  }

  res.json({ success: true, token: signToken(user), user: publicUser(user) });
});

// GET /api/auth/me
export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, user: publicUser(req.user), data: publicUser(req.user) });
});
