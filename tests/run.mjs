/**
 * Self-contained test runner: starts the API on an ephemeral port against a separate
 * `<db>_test` database, seeds the staff accounts the tests sign in with, runs
 * tests/api.test.js against it, then drops that database.
 * Only needs MongoDB to be reachable (docker compose up -d, or npm run db:local).
 *
 *   npm test
 *   API_URL=http://localhost:5000 node --test tests/   # alternative: test a server you started yourself
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const baseUri = process.env.MONGO_URI || 'mongodb://localhost:27017/muraqaba';
const testUri = baseUri.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, query = '') => `/${db}_test${query}`);
if (testUri === baseUri) {
  console.error(`Could not derive a test database name from MONGO_URI (${baseUri}). Add a database name to the URI.`);
  process.exit(1);
}

process.env.MONGO_URI = testUri;
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = join(tmpdir(), 'muraqaba-test-uploads');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-for-production-use-only-0123456789';
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
// Production-like registration policy so the tests prove staff roles cannot self-register.
process.env.ALLOW_PUBLIC_REGISTRATION = 'true';
process.env.SELF_REGISTER_ROLES = 'vendor';

const { default: connectDB } = await import('../config/db.js');
const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const mongoose = (await import('mongoose')).default;

const conn = await connectDB({ maxAttempts: 3 });
await conn.dropDatabase(); // start clean even if a previous run crashed

// Staff accounts (the tests read these from the environment).
const STAFF_PASSWORD = 'TestPass123!';
const hashed = await bcrypt.hash(STAFF_PASSWORD, 4);
await User.create([
  { name: 'Test Creator', email: 'test-creator@muraqaba.test', role: 'serviceCreator', password: hashed },
  { name: 'Test Supervisor', email: 'test-supervisor@muraqaba.test', role: 'supervisor', password: hashed },
  { name: 'Test Purchasing', email: 'test-purchasing@muraqaba.test', role: 'purchaseManager', password: hashed },
]);

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const apiUrl = `http://127.0.0.1:${port}`;
console.log(`Test API on ${apiUrl} (database ${conn.name})`);

const child = spawn(process.execPath, ['--test', join(__dirname, 'api.test.js')], {
  stdio: 'inherit',
  env: { ...process.env, API_URL: apiUrl, TEST_STAFF_PASSWORD: STAFF_PASSWORD },
});

const code = await new Promise((resolve) => child.on('exit', resolve));

await conn.dropDatabase();
await mongoose.connection.close();
server.close();
process.exit(code ?? 1);
