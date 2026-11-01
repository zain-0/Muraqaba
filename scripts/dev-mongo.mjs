/**
 * Local MongoDB without Docker, for development only.
 *
 * Uses the official mongod binary that mongodb-memory-server downloads once into
 * ~/.cache/mongodb-binaries, and keeps data in backend/.data/mongo so it survives
 * restarts. Production and CI should use `docker compose up -d` or a managed cluster.
 *
 *   npm run db:local            # listens on mongodb://localhost:27017/muraqaba
 *   MONGO_PORT=27018 npm run db:local
 */
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { MongoMemoryServer } from 'mongodb-memory-server';

const port = Number(process.env.MONGO_PORT) || 27017;
const dbPath = fileURLToPath(new URL('../.data/mongo/', import.meta.url));
mkdirSync(dbPath, { recursive: true });

const mongod = await MongoMemoryServer.create({
  instance: { port, dbPath, storageEngine: 'wiredTiger' },
});

console.log(`MongoDB ${mongod.instanceInfo?.version ?? ''} running at ${mongod.getUri()} (data in ${dbPath})`);
console.log('Press Ctrl+C to stop.');

const stop = async () => {
  await mongod.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
