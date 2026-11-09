/**
 * Brings a database from before 2026-11-09 into the scrap request and LPO-by-make shape:
 *
 * - Each bus's lifecycle from its latest daily status: Scrapping → scrapped from the first day of
 *   that run; Removed → sold on the first day of that run, with no buyer or price. Every other
 *   bus is in operation. Buses already moved on through the app are left as they are.
 * - Each LPO's repair and maintenance lines become one repair and maintenance line, and an LPO
 *   with such a line takes the make most of its vendor's buses have.
 * - VSRs that came off the merged lines point at the new line, with the new kind.
 *
 * It can run any number of times: a second run finds nothing to change. Nothing is written with --dry-run.
 *
 *   node scripts/migrate-fleet-lifecycle.js --dry-run --uri mongodb://localhost:27017/muraqaba_next
 *   MONGO_URI=mongodb://localhost:27017/muraqaba_next node scripts/migrate-fleet-lifecycle.js --dry-run
 *
 * Without either it uses MONGO_URI from .env, the live database.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket from '../models/Ticket.js';
import { Lpo } from '../models/Purchase.js';
import { applyBusLifecycleChanges, busLifecycleChanges, mergeRepairMaintenance, mostCommonMake } from '../utils/fleetLifecycle.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const uriAt = args.indexOf('--uri');
if (uriAt !== -1) {
  if (!args[uriAt + 1] || args[uriAt + 1].startsWith('--')) throw new Error('Give the database after --uri, for example --uri mongodb://localhost:27017/muraqaba_next');
  process.env.MONGO_URI = args[uriAt + 1];
}

/**
 * The LPO changes, read through the driver: the model no longer accepts the old line kinds.
 * Each is `{ lpo, items, make, merged }`, with `make` set only where one is newly inferred.
 */
const lpoChanges = async () => {
  const [lpos, buses] = await Promise.all([Lpo.collection.find().toArray(), Bus.find().select('make vendor').lean()]);
  const makesOf = (vendor) => buses.filter((bus) => String(bus.vendor) === String(vendor)).map((bus) => bus.make);
  return lpos.flatMap((lpo) => {
    const { items, merged } = mergeRepairMaintenance(lpo.items);
    const needsMake = items.some((item) => item.kind === 'repairMaintenance') && !lpo.make?.trim();
    const make = needsMake ? mostCommonMake(makesOf(lpo.vendor)) : undefined;
    if (!merged && !make && !needsMake) return [];
    return [{ lpo, items, make, merged, noMake: needsMake && !make }];
  });
};

const writeLpoChanges = async (planned) => {
  for (const { lpo, items, make, merged } of planned) {
    if (!merged && !make) continue; // only a make that could not be found: nothing to write
    await Lpo.collection.updateOne({ _id: lpo._id }, { $set: { items, ...(make ? { make } : {}) } });
    if (!merged) continue;
    const others = merged.from.filter((id) => !id.equals(merged.id));
    if (others.length) await Ticket.collection.updateMany({ 'lpoDeduction.item': { $in: others } }, { $set: { 'lpoDeduction.item': merged.id } });
  }
  // Every VSR recorded against an old line kind, deducted or with no LPO at all, reads under the new one.
  return Ticket.collection.updateMany({ 'lpoDeduction.kind': { $in: ['repair', 'maintenance'] } }, { $set: { 'lpoDeduction.kind': 'repairMaintenance' } });
};

const main = async () => {
  const { default: connectDB } = await import('../config/db.js');
  await connectDB({ maxAttempts: 2 });
  console.log(`${dryRun ? 'Dry run on' : 'Migrating'} database ${mongoose.connection.name}`);

  const buses = await busLifecycleChanges();
  const lpos = await lpoChanges();
  const oldKinds = await Ticket.collection.countDocuments({ 'lpoDeduction.kind': { $in: ['repair', 'maintenance'] } });

  const count = (to) => buses.filter((change) => change.to === to).length;
  console.log(`Buses: ${count('scrapped')} to scrapped, ${count('sold')} to sold, ${count('inOperation')} marked in operation`);
  buses
    .filter((change) => change.to !== 'inOperation')
    .forEach(({ bus, to, set }) => console.log(`  ${bus.fleetNumber}: ${to}, scrapped from ${set.scrappedOn}${set.sale ? `, sold ${set.sale.date}` : ''}`));
  console.log(`LPOs: ${lpos.filter((c) => c.merged).length} with lines merged, ${lpos.filter((c) => c.make).length} given a make`);
  lpos.forEach(({ lpo, make, merged, noMake }) => {
    const parts = [merged && 'repair and maintenance lines merged', make && `make ${make}`, noMake && 'no bus of its vendor to take a make from; set it by hand'].filter(Boolean);
    console.log(`  ${lpo.number}: ${parts.join(', ')}`);
  });
  console.log(`VSRs: ${oldKinds} LPO deductions under the old line kinds`);

  if (dryRun) {
    console.log('Nothing written (--dry-run).');
  } else {
    await applyBusLifecycleChanges(buses);
    const moved = await writeLpoChanges(lpos);
    console.log(`Done. ${moved.modifiedCount} VSR deductions now read repair and maintenance.`);
  }
  await mongoose.connection.close();
};

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
