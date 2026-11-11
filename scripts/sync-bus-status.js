/**
 * Since 2026-11-11 the daily status follows the VSRs both ways: raising one marks the bus out, and
 * the bus being back makes it Ready, unless another open VSR still has it out. Before that only
 * raising did, so a bus whose VSR came back earlier still shows "Out for …". This gives each such
 * bus the status the rule would have given it on the day it came back.
 *
 * Only buses whose latest status came from a VSR are looked at; a status set by hand or by a scrap
 * request is left alone. It can run any number of times: a second run finds nothing to change.
 * Nothing is written without --apply.
 *
 *   node scripts/sync-bus-status.js --uri mongodb://localhost:27017/muraqaba_next
 *   node scripts/sync-bus-status.js --uri mongodb://localhost:27017/muraqaba_next --apply
 *
 * Without --uri it uses MONGO_URI from the environment or .env.
 */
import mongoose from 'mongoose';
import Bus from '../models/Bus.js';
import Ticket from '../models/Ticket.js';
import { BusStatusChange } from '../models/BusDaily.js';
import { BUS_OUT_STATUSES, planReturnToBusDay, writeBusDayPlan } from '../utils/busDay.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const uriAt = args.indexOf('--uri');
if (uriAt !== -1) {
  if (!args[uriAt + 1] || args[uriAt + 1].startsWith('--')) throw new Error('Give the database after --uri, for example --uri mongodb://localhost:27017/muraqaba_next');
  process.env.MONGO_URI = args[uriAt + 1];
}

const LABELS = { ready: 'Ready', repair: 'Out for repair', maintenance: 'Out for maintenance', tyreChange: 'Out for tyre change', batteryChange: 'Out for battery change', accident: 'Accident' };

/** When the creator confirmed the bus was back: the step's date, or when the step was recorded. */
const returnedAt = (ticket) => {
  if (ticket.vehicle?.returnedAt) return ticket.vehicle.returnedAt;
  const entry = ticket.history.find((h) => h.status === 'vehicleReturned');
  return entry ? entry.effectiveAt ?? entry.at : null;
};

const main = async () => {
  const { default: connectDB } = await import('../config/db.js');
  await connectDB({ maxAttempts: 2 });
  console.log(`${apply ? 'Syncing' : 'Dry run on'} database ${mongoose.connection.name}`);

  const latest = await BusStatusChange.aggregate([{ $sort: { date: -1 } }, { $group: { _id: '$bus', change: { $first: '$$ROOT' } } }]);
  const fromVsr = latest.map((row) => row.change).filter((change) => change.source === 'vsr' && change.ticket);
  const buses = new Map((await Bus.find().select('fleetNumber').lean()).map((bus) => [String(bus._id), bus.fleetNumber]));

  const plans = [];
  const counts = { stillOut: 0, alreadyRight: 0, noReturnDate: 0, missing: 0 };
  for (const change of fromVsr) {
    const ticket = await Ticket.findById(change.ticket);
    const root = ticket?.parentTicket ? await Ticket.findById(ticket.parentTicket) : ticket;
    if (!root) {
      counts.missing += 1;
      continue;
    }
    if (BUS_OUT_STATUSES.includes(root.status)) {
      counts.stillOut += 1;
      continue;
    }
    const back = returnedAt(root);
    if (!back) {
      counts.noReturnDate += 1;
      continue;
    }
    const plan = await planReturnToBusDay(root, back);
    if (!plan) counts.alreadyRight += 1;
    else plans.push({ ...plan, vsrNumber: root.vsrNumber, by: root.history.find((h) => h.status === 'vehicleReturned')?.by });
  }

  const ready = plans.filter((plan) => plan.status === 'ready');
  console.log(`Buses whose latest status came from a VSR: ${fromVsr.length}`);
  console.log(`  Ready from the day the bus came back: ${ready.length}`);
  console.log(`  Another open VSR's status from that day: ${plans.length - ready.length}`);
  console.log(`  Still out, the VSR is open: ${counts.stillOut}`);
  console.log(`  Already right: ${counts.alreadyRight}`);
  if (counts.noReturnDate) console.log(`  Back but with no return date, left alone: ${counts.noReturnDate}`);
  if (counts.missing) console.log(`  VSR no longer on file, left alone: ${counts.missing}`);
  plans.forEach((plan) => console.log(`    ${buses.get(String(plan.bus)) ?? plan.bus}: ${LABELS[plan.status] ?? plan.status} from ${plan.day} (${plan.vsrNumber})`));

  if (!apply) {
    console.log('Nothing written. Run it again with --apply to write.');
  } else {
    for (const plan of plans) await writeBusDayPlan(plan, plan.by);
    console.log(`Wrote ${plans.length} changes.`);
  }
  await mongoose.connection.close();
};

main().catch(async (err) => {
  console.error('Sync failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
