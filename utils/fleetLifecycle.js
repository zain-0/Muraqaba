/**
 * Bringing records from before 2026-11-09 into the new shape: a bus's lifecycle worked out from
 * its daily status sheet, where Scrapping and Removed used to be set by hand, and an LPO's separate
 * repair and maintenance lines merged into one repair and maintenance line for one make.
 *
 * scripts/migrate-fleet-lifecycle.js runs these on a database, and the client seed on records as
 * it loads them, so a migrated database and a freshly loaded one end up the same. Nothing here
 * knows any depot's makes or vendors: the make comes from the vendor's own buses.
 */
import Bus, { BUS_LIFECYCLES } from '../models/Bus.js';
import { BusStatusChange } from '../models/BusDaily.js';
import { brandKey, toAed, toFils } from './reportMaths.js';

const OLD_LINES = ['repair', 'maintenance'];

/** The index of the first change in the run of the same status that ends at `end`. */
const runStart = (changes, end) => {
  let start = end;
  while (start > 0 && changes[start - 1].status === changes[end].status) start -= 1;
  return start;
};

/**
 * What a bus's latest status says about its lifecycle. `changes` are its `{ date, status }`, in
 * any order. Scrapping: scrapped from the first day of that last run. Removed: sold on the first
 * day of that last run, scrapped from the start of the Scrapping run just before it, or from the
 * sale day if it went straight to Removed. A sale found this way has no buyer or price.
 */
export const lifecycleFromStatuses = (changes) => {
  const sorted = [...changes].sort((a, b) => a.date.localeCompare(b.date));
  const end = sorted.length - 1;
  if (end < 0 || !['scrapping', 'removed'].includes(sorted[end].status)) return { lifecycle: 'inOperation' };
  const start = runStart(sorted, end);
  if (sorted[end].status === 'scrapping') return { lifecycle: 'scrapped', scrappedOn: sorted[start].date };
  const scrapped = start > 0 && sorted[start - 1].status === 'scrapping' ? sorted[runStart(sorted, start - 1)].date : sorted[start].date;
  return { lifecycle: 'sold', scrappedOn: scrapped, saleDate: sorted[start].date };
};

/**
 * One repair and maintenance line in place of an LPO's repair and maintenance lines: quantity 1,
 * the amounts added up in fils. It keeps the first old line's id, so VSRs that used that line
 * still point at it; `merged.from` lists every old id for moving the others.
 */
export const mergeRepairMaintenance = (items) => {
  const old = items.filter((item) => OLD_LINES.includes(item.kind));
  if (!old.length) return { items, merged: null };
  const total = toAed(old.reduce((sum, item) => sum + toFils(item.total), 0));
  const used = toAed(old.reduce((sum, item) => sum + toFils(item.usedAmount ?? 0), 0));
  const line = { _id: old[0]._id, kind: 'repairMaintenance', name: 'Repair and maintenance', quantity: 1, unitPrice: total, total, usedQuantity: 0, usedAmount: used };
  const merged = items.flatMap((item) => (item === old[0] ? [line] : OLD_LINES.includes(item.kind) ? [] : [item]));
  return { items: merged, merged: { id: old[0]._id, from: old.map((item) => item._id) } };
};

/** The make most of these buses have, in its most common spelling; ties go to the first alphabetically. */
export const mostCommonMake = (makes) => {
  const groups = new Map();
  makes
    .filter((make) => typeof make === 'string' && make.trim())
    .forEach((make) => {
      const group = groups.get(brandKey(make)) ?? { count: 0, spellings: new Map() };
      group.count += 1;
      group.spellings.set(make.trim(), (group.spellings.get(make.trim()) ?? 0) + 1);
      groups.set(brandKey(make), group);
    });
  const [best] = [...groups.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  if (!best) return undefined;
  return [...best[1].spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
};

const order = (lifecycle) => BUS_LIFECYCLES.indexOf(lifecycle ?? 'inOperation');

/**
 * Each bus whose lifecycle its status sheet moves on, as `{ bus, from, to, set }`. Only forward:
 * a bus already scrapped or sold through the app keeps its dates and sale, and a bus with a
 * scrap request waiting is the supervisor's to decide. A bus stored with no lifecycle gets
 * inOperation written, so queries on the field find it.
 */
export const busLifecycleChanges = async () => {
  const [buses, changes] = await Promise.all([
    Bus.find().select('fleetNumber lifecycle scrappedOn').lean(),
    BusStatusChange.find().select('bus date status').lean(),
  ]);
  const byBus = new Map();
  changes.forEach((change) => {
    const key = String(change.bus);
    if (!byBus.has(key)) byBus.set(key, []);
    byBus.get(key).push(change);
  });
  return buses.flatMap((bus) => {
    const target = lifecycleFromStatuses(byBus.get(String(bus._id)) ?? []);
    if (bus.lifecycle === 'scrapRequested' || bus.lifecycle === 'sold') return [];
    if (order(target.lifecycle) <= order(bus.lifecycle)) {
      return bus.lifecycle ? [] : [{ bus, from: null, to: 'inOperation', set: { lifecycle: 'inOperation' } }];
    }
    const set = { lifecycle: target.lifecycle, scrappedOn: bus.scrappedOn ?? target.scrappedOn };
    if (target.lifecycle === 'sold') set.sale = { date: target.saleDate, attachments: [] };
    return [{ bus, from: bus.lifecycle ?? null, to: target.lifecycle, set }];
  });
};

export const applyBusLifecycleChanges = async (planned) => {
  if (planned.length) await Bus.bulkWrite(planned.map(({ bus, set }) => ({ updateOne: { filter: { _id: bus._id }, update: { $set: set } } })));
};
