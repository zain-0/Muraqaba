import dotenv from 'dotenv';

dotenv.config();

const required = ['MONGO_URI', 'JWT_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  // Fail fast with a clear message instead of a confusing stack trace later.
  console.error(`Missing required environment variables: ${missing.join(', ')}. See .env.example.`);
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters in production.');
  process.exit(1);
}

const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '24h';
if (!/^\d+\s*(ms|s|m|h|d|w|y)?$/i.test(jwtExpiresIn)) {
  console.error(`JWT_EXPIRES_IN "${jwtExpiresIn}" is not a valid duration (examples: 24h, 7d, 30m).`);
  process.exit(1);
}

const parseList = (value, fallback) =>
  (value ? value.split(',') : fallback).map((s) => s.trim()).filter(Boolean);

const ALL_ROLES = ['vendor', 'serviceCreator', 'supervisor', 'purchaseManager'];

/**
 * TRUST_PROXY tells Express how many reverse proxies sit in front of the API (or a
 * subnet such as "loopback" or "10.0.0.0/8"). Leave unset when the API is reached
 * directly; otherwise clients could spoof X-Forwarded-For and dodge rate limits.
 */
const parseTrustProxy = (value) => {
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return 1;
  return /^\d+$/.test(value) ? Number(value) : value;
};

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction,
  port: Number(process.env.PORT) || 5000,
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Comma-separated list of allowed browser origins.
  corsOrigins: parseList(process.env.FRONTEND_URL, ['http://localhost:3000', 'http://localhost:5173']),
  // Requests per IP per window. Generous outside production so background refreshes in the UI do not trip it.
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX) || (isProduction ? 300 : 5000),
  },
  // Stricter limit for credential endpoints to slow down brute force attempts.
  authRateLimit: {
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT_MAX) || (isProduction ? 20 : 500),
  },
  /**
   * Self registration. Off by default in production: staff accounts come from the seed
   * script or an administrator, and vendor accounts from a service creator. In development
   * every role may self-register so the app can be tried without seeding.
   */
  allowPublicRegistration: (process.env.ALLOW_PUBLIC_REGISTRATION ?? (isProduction ? 'false' : 'true')) !== 'false',
  selfRegisterRoles: parseList(process.env.SELF_REGISTER_ROLES, isProduction ? ['vendor'] : ALL_ROLES).filter((r) =>
    ALL_ROLES.includes(r)
  ),
  bcryptRounds: 12,
};

export default config;
