/**
 * Brings a database from before 2026-11-10 into the LPO items shape, where the creator picks the
 * LPO line when raising a VSR, its amount is booked against the line, and the GRN deducts it:
 *
 * - Each LPO without a date takes its first valid day.
 * - An LPO's make moves onto its repair and maintenance lines, and the LPO no longer has one.
 * - Every line is named by the rule: "Repair & Maintenance of {make} Buses", "Tyre size {size}",
 *   "Battery {type}". A tyre or battery line already named that way takes the size from its name;
 *   one with no size is "Tyres" or "Batteries".
 * - Each open VSR with no LPO line and no deduction gets the line the automatic choice would take
 *   it off (the vendor's, the make, the kind, valid today, room counted), so it is booked from now.
 *   Tyre and battery VSRs among them get their quantity from what was fitted.
 *
 * Past deductions are left as they are. It can run any number of times: a second run finds nothing
 * to change. Nothing is written with --dry-run. Run scripts/migrate-fleet-lifecycle.js first on a
 * database from before 2026-11-09.
 *
 *   node scripts/migrate-lpo-items.js --dry-run --uri mongodb://localhost:27017/muraqaba_next
 *   MONGO_URI=mongodb://localhost:27017/muraqaba_next node scripts/migrate-lpo-items.js --dry-run
 *
 * Without either it uses MONGO_URI from .env, the live database.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket, { CLOSED_STATUSES } from '../models/Ticket.js';
import { Lpo, lineName } from '../models/Purchase.js';
import { COUNTED_BY_QUANTITY, ticketsOnLines } from '../utils/lpoBalance.js';
import { isInDate, linesForOpen, lpoLineOf, roomOn } from '../utils/lpoDeduction.js';
import { uaeDay } from '../utils/uaeTime.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const uriAt = args.indexOf('--uri');
if (uriAt !== -1) {
  if (!args[uriAt + 1] || args[uriAt + 1].startsWith('--')) throw new Error('Give the database after --uri, for example --uri mongodb://localhost:27017/muraqaba_next');
  process.env.MONGO_URI = args[uriAt + 1];
}

/** The size a tyre or battery line was named with before lines had a size of their own: "Tyre size {size}", "Battery {type}". */
const sizeInName = ({ kind, name = '' }) => (kind === 'tyre' ? /^Tyre size (.+)$/.exec(name) : kind === 'battery' ? /^Battery (.+)$/.exec(name) : null)?.[1]?.trim();

/** One line as it should be now: the LPO's make on a repair and maintenance line, a size read from its name, and its name by the rule. */
const lineNow = (item, make) => {
  let line = item;
  if (line.kind === 'repairMaintenance' && !line.make && make) line = { ...line, make };
  if (['tyre', 'battery'].includes(line.kind) && !line.size && sizeInName(line)) line = { ...line, size: sizeInName(line) };
  return { ...line, name: lineName(line) };
};

/** An LPO as it should be now, and what to write for it, or null when it is already so. Read through the driver: the model has no LPO make any more. */
const lpoChange = (lpo) => {
  const make = typeof lpo.make === 'string' && lpo.make.trim() ? lpo.make.trim() : undefined;
  const items = lpo.items.map((item) => lineNow(item, make));
  const renamed = items.filter((item, i) => ['name', 'make', 'size'].some((key) => item[key] !== lpo.items[i][key]));
  const needsDate = !lpo.date;
  const hasMakeField = 'make' in lpo;
  if (!needsDate && !hasMakeField && !renamed.length) return null;
  const noMake = items.filter((item) => item.kind === 'repairMaintenance' && !item.make).length;
  return { lpo, items, date: needsDate ? lpo.validFrom : undefined, unsetMake: hasMakeField, renamed: renamed.length, noMake };
};

/** The LPOs as they will be once their changes are written, so a dry run chooses lines as the real run will. */
const lposAfter = (lpos, changes) => {
  const byId = new Map(changes.map((change) => [String(change.lpo._id), change]));
  return lpos.map((lpo) => {
    const change = byId.get(String(lpo._id));
    return change ? { ...lpo, items: change.items, date: change.date ?? lpo.date } : lpo;
  });
};

/**
 * The line each open VSR without one would come off, worked out one VSR at a time, oldest first,
 * so each one's booking counts against the next. Returns `{ ticket, lpoLine, quantity, overrun }`
 * for every VSR with something to write: a line, a quantity, or both.
 */
const vsrChanges = async (lpos) => {
  const [open, buses] = await Promise.all([
    Ticket.collection
      .find({ status: { $nin: CLOSED_STATUSES }, lpoDeduction: { $exists: false }, lpoLine: { $exists: false } })
      .sort({ createdAt: 1, vsrNumber: 1 })
      .toArray(),
    Bus.find().select('make').lean(),
  ]);
  const makes = new Map(buses.map((bus) => [String(bus._id), bus.make]));
  const inDate = lpos.filter((lpo) => isInDate(lpo, uaeDay()));
  const items = inDate.flatMap((lpo) => lpo.items);
  const room = roomOn(inDate, items.length ? await ticketsOnLines(items.map((item) => item._id)) : []);

  // Tyres and batteries take their quantity from what was fitted, so it is booked too.
  const withQuantity = open.map((ticket) => {
    const counted = COUNTED_BY_QUANTITY.includes(ticket.serviceType);
    const quantity = counted && ticket.quantity == null && ticket.breakdown?.unitsFitted ? ticket.breakdown.unitsFitted : undefined;
    return { ticket, quantity, merged: quantity ? { ...ticket, quantity } : ticket };
  });
  const lines = linesForOpen(withQuantity.map(({ merged }) => merged), { lpos: inDate, makeOf: (ticket) => makes.get(String(ticket.busId)), room });
  const lineFor = new Map(lines.map((line) => [String(line.ticket._id), line]));
  return withQuantity.flatMap(({ ticket, quantity }) => {
    const line = lineFor.get(String(ticket._id));
    if (!line && !quantity) return [];
    return [{ ticket, lpoLine: line ? lpoLineOf(line) : undefined, quantity, overrun: line?.overrun ?? false }];
  });
};

const main = async () => {
  const { default: connectDB } = await import('../config/db.js');
  await connectDB({ maxAttempts: 2 });
  console.log(`${dryRun ? 'Dry run on' : 'Migrating'} database ${mongoose.connection.name}`);

  const lpos = await Lpo.collection.find().sort({ number: 1 }).toArray();
  const oldKinds = lpos.filter((lpo) => lpo.items.some((item) => ['repair', 'maintenance'].includes(item.kind)));
  if (oldKinds.length) console.log(`  ${oldKinds.length} LPOs still have separate repair and maintenance lines. Run scripts/migrate-fleet-lifecycle.js first.`);
  const changes = lpos.map(lpoChange).filter(Boolean);
  const vsrs = await vsrChanges(lposAfter(lpos, changes));

  console.log(`LPOs: ${changes.filter((c) => c.date).length} dated, ${changes.filter((c) => c.unsetMake).length} with the make moved to their lines, ${changes.reduce((sum, c) => sum + c.renamed, 0)} lines named by the rule`);
  changes.forEach(({ lpo, items, date, unsetMake, noMake }) => {
    const parts = [date && `dated ${date.toISOString().slice(0, 10)}`, unsetMake && `make ${lpo.make || '(none)'} moved to its lines`, noMake && `${noMake} repair and maintenance line with no make: it cannot be chosen for a VSR`].filter(Boolean);
    console.log(`  ${lpo.number}: ${parts.join(', ') || 'lines renamed'}; ${items.map((item) => item.name).join(' / ')}`);
  });
  const lined = vsrs.filter((change) => change.lpoLine);
  console.log(`VSRs: ${lined.length} open ones given the line they will come off, ${vsrs.filter((change) => change.quantity).length} given their quantity`);
  lined.forEach(({ ticket, lpoLine, overrun }) => console.log(`  ${ticket.vsrNumber}: ${lpoLine.lpoNumber}, ${lpoLine.name}${overrun ? ' (more than it has left)' : ''}`));

  if (dryRun) {
    console.log('Nothing written (--dry-run).');
  } else {
    for (const { lpo, items, date, unsetMake } of changes) {
      await Lpo.collection.updateOne({ _id: lpo._id }, { $set: { items, ...(date ? { date } : {}) }, ...(unsetMake ? { $unset: { make: '' } } : {}) });
    }
    for (const { ticket, lpoLine, quantity } of vsrs) {
      await Ticket.collection.updateOne({ _id: ticket._id }, { $set: { ...(lpoLine ? { lpoLine } : {}), ...(quantity ? { quantity } : {}) } });
    }
    console.log(`Done. ${changes.length} LPOs and ${vsrs.length} VSRs written.`);
  }
  await mongoose.connection.close();
};

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
