/**
 * Brings a database from before the owner's testing notes of 2026-11-11 into their shape:
 *
 * - Transmission services become repairs in the Transmission category, and brake-pad services
 *   repairs in the Brake pads category. Their price and what was measured when raised stay.
 * - Repairs in the old Accident category become accidents, a service type of their own, with no
 *   repair category. Their severity and fault stay.
 * - The breakdown flag goes with repairs only, so it is cleared on any other work.
 * - Buses lose their transmission rate and interval.
 * - Notices that a transmission service is due are removed: there is no such service any more.
 *
 * Daily statuses are left as they were recorded. LPO lines and deductions name LPO kinds, not
 * services, so they need nothing.
 *
 * It only reports what it would change unless given --apply, and a second run finds nothing to do.
 *
 *   node scripts/migrate-owner-testing.js --uri mongodb://localhost:27017/muraqaba_next
 *   node scripts/migrate-owner-testing.js --uri mongodb://localhost:27017/muraqaba_next --apply
 *
 * Without --uri it uses MONGO_URI, from the environment or .env.
 */
import mongoose from 'mongoose';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const uriAt = args.indexOf('--uri');
if (uriAt !== -1) {
  if (!args[uriAt + 1] || args[uriAt + 1].startsWith('--')) throw new Error('Give the database after --uri, for example --uri mongodb://localhost:27017/muraqaba_next');
  process.env.MONGO_URI = args[uriAt + 1];
}

// Read and written through the driver: the models no longer accept the old shapes.
const CHANGES = [
  {
    label: 'Transmission services to repairs (Transmission)',
    collection: 'tickets',
    filter: { serviceType: 'transmission' },
    update: { $set: { serviceType: 'repair', repairCategory: 'TRANSMISSION' } },
  },
  {
    label: 'Brake-pad services to repairs (Brake pads)',
    collection: 'tickets',
    filter: { serviceType: 'brakePads' },
    update: { $set: { serviceType: 'repair', repairCategory: 'BRAKE PADS' } },
  },
  {
    label: 'Accident repairs to accidents',
    collection: 'tickets',
    filter: { serviceType: 'repair', repairCategory: 'ACCIDENT' },
    update: { $set: { serviceType: 'accident' }, $unset: { repairCategory: '' } },
  },
  // After the accidents have moved, so an accident repair that broke down is cleared too.
  {
    label: 'Breakdown flags cleared on work that is not a repair',
    collection: 'tickets',
    filter: { isBreakdown: true, serviceType: { $ne: 'repair' } },
    update: { $set: { isBreakdown: false } },
    // Counted before anything moves, as the accidents above will be among them.
    countFilter: { isBreakdown: true, $nor: [{ serviceType: { $in: ['repair', 'transmission', 'brakePads'] }, repairCategory: { $ne: 'ACCIDENT' } }] },
  },
  {
    label: 'Buses losing their transmission rate or interval',
    collection: 'buses',
    filter: { $or: [{ 'rates.transmission': { $exists: true } }, { 'intervals.transmission': { $exists: true } }] },
    update: { $unset: { 'rates.transmission': '', 'intervals.transmission': '' } },
  },
  {
    label: 'Transmission due notices removed',
    collection: 'notifications',
    filter: { type: 'serviceDue', 'params.service': 'transmission' },
    remove: true,
  },
];

const main = async () => {
  const { default: connectDB } = await import('../config/db.js');
  await connectDB({ maxAttempts: 2 });
  // The filters here are the script's own, so operators are meant.
  mongoose.set('sanitizeFilter', false);
  const { db } = mongoose.connection;
  console.log(`${apply ? 'Migrating' : 'Dry run on'} database ${mongoose.connection.name}`);

  const counts = [];
  for (const change of CHANGES) counts.push(await db.collection(change.collection).countDocuments(change.countFilter ?? change.filter));
  CHANGES.forEach((change, i) => console.log(`${change.label}: ${counts[i]}`));

  if (!apply) {
    console.log('Nothing written. Run again with --apply to make these changes.');
  } else {
    for (const change of CHANGES) {
      const collection = db.collection(change.collection);
      if (change.remove) await collection.deleteMany(change.filter);
      else await collection.updateMany(change.filter, change.update);
    }
    console.log('Done.');
  }
  await mongoose.connection.close();
};

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
