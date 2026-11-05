import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import mongoose from 'mongoose';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import config from './config/config.js';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import vendorRoutes from './routes/vendorRoutes.js';
import busRoutes from './routes/busRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';
import sheetRoutes from './routes/sheetRoutes.js';
import { grnRoutes, lpoRoutes, purchaseInvoiceRoutes } from './routes/purchaseRoutes.js';
import { errorHandler, notFound } from './middleware/errorMiddleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const swaggerDocument = JSON.parse(readFileSync(join(__dirname, 'swagger', 'swagger.json'), 'utf-8'));

const app = express();

// Only trust X-Forwarded-For when TRUST_PROXY says a proxy sets it; otherwise clients
// could spoof their address and dodge the per-IP rate limits.
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

// Strict defaults everywhere; Swagger UI alone needs inline styles and scripts.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  '/api-docs',
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  })
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server calls (no Origin header) and listed browser origins.
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      const err = new Error(`Origin ${origin} is not allowed`);
      err.statusCode = 403;
      err.code = 'CORS_FORBIDDEN';
      return callback(err);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // ngrok-skip-browser-warning: sent by the web app when the API is exposed through an ngrok tunnel.
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    credentials: true,
    maxAge: 600,
  })
);

app.use(
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' },
  })
);

app.use(compression());
app.use(express.json({ limit: '100kb' }));
// Express 5 leaves req.body undefined when no JSON body was sent; controllers expect an object.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

if (config.env !== 'test') {
  app.use(morgan(config.isProduction ? 'combined' : 'dev'));
}

// Liveness/readiness for load balancers and the frontend's connectivity check.
app.get(['/api/health', '/health'], (req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  const ok = dbState === 1;
  res.status(ok ? 200 : 503).json({
    success: ok,
    status: ok ? 'ok' : 'degraded',
    db: ok ? 'connected' : 'disconnected',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vendors', vendorRoutes);
app.use(['/api/buses', '/api/bus'], busRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/sheets', sheetRoutes);
app.use('/api/grns', grnRoutes);
app.use('/api/purchase-invoices', purchaseInvoiceRoutes);
app.use('/api/lpos', lpoRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
