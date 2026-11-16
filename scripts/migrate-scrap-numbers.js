/**
 * Gives every scrap request raised before 2026-11-16 its number (SCR-0001 and so on), oldest
 * first. New requests number themselves. A second run finds nothing to do.
 *
 *   node scripts/migrate-scrap-numbers.js --uri mongodb://localhost:27017/muraqaba_next
 *
 * Without --uri it uses MONGO_URI, from the environment or .env.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import ScrapRequest from '../models/ScrapRequest.js';
import { nextScrapNumber } from '../models/Counter.js';

const uriAt = process.argv.indexOf('--uri');
const uri = uriAt !== -1 ? process.argv[uriAt + 1] : process.env.MONGO_URI;
if (!uri) throw new Error('Give the database with --uri or MONGO_URI');

await mongoose.connect(uri);
const unnumbered = await ScrapRequest.find({ number: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).select('_id');
for (const { _id } of unnumbered) {
  await ScrapRequest.updateOne({ _id }, { $set: { number: await nextScrapNumber() } });
}
console.log(`${unnumbered.length} scrap request(s) numbered in ${mongoose.connection.name}`);
await mongoose.disconnect();
