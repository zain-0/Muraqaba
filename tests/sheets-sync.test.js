/**
 * scripts/sync-bus-status.js: buses whose VSR came back before 2026-11-11 still show "Out for …".
 * The script gives them the status the new rule would have given on the day the bus came back.
 * It runs on a database of its own, built here, never on the test API's.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import mongoose from 'mongoose';
import { run } from './helpers.js';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'sync-bus-status.js');
const oid = () => new mongoose.Types.ObjectId();
const at = (day) => new Date(`${day}T09:00:00+04:00`);

describe('syncing the daily status with VSRs that came back before the rule', () => {
  test('dry run by default, --apply writes, and a second run finds nothing to do', async () => {
    const uri = process.env.MONGO_URI.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, query = '') => `/${db}_sync${query}`);
    const connection = await mongoose.createConnection(uri).asPromise();
    const db = (name) => connection.collection(name);
    try {
      await connection.dropDatabase();
      const vendor = oid();
      const creator = oid();
      const b = Object.fromEntries(['back', 'kept', 'out', 'hand', 'job'].map((key) => [key, oid()]));
      await db('buses').insertMany(Object.entries(b).map(([key, _id]) => ({ _id, fleetNumber: `Y-${key}-${run}`, make: 'Hino', model: 'Coach', year: 2018, vendor })));

      const t = Object.fromEntries(['back', 'keptTyre', 'keptRepair', 'out', 'hand', 'job', 'jobExtra'].map((key) => [key, oid()]));
      const ticket = (key, bus, fields) => ({ _id: t[key], vsrNumber: `VSR-${key}`, busId: b[bus], vendorId: vendor, createdBy: creator, serviceType: 'repair', repairCategory: 'ENGINE', history: [], ...fields });
      const returned = (day) => ({ status: 'vehicleReturned', vehicle: { returnedAt: at(day) }, history: [{ status: 'vehicleReturned', at: at(day), effectiveAt: at(day), by: creator }] });
      await db('tickets').insertMany([
        // Back on 3 October; the sheet still says repair.
        ticket('back', 'back', { createdAt: at('2026-10-01'), ...returned('2026-10-03') }),
        // The tyre change is closed, but the repair raised before it still has the bus out.
        ticket('keptRepair', 'kept', { createdAt: at('2026-10-01'), status: 'workInProgress' }),
        ticket('keptTyre', 'kept', { createdAt: at('2026-10-02'), serviceType: 'tyre', repairCategory: undefined, status: 'completed', vehicle: { returnedAt: at('2026-10-04') } }),
        // Still at the workshop.
        ticket('out', 'out', { createdAt: at('2026-10-01'), status: 'vehicleReceived' }),
        // Back, but someone set the bus Ready by hand since.
        ticket('hand', 'hand', { createdAt: at('2026-10-01'), ...returned('2026-10-05') }),
        // A VSR and its additional job, back together; the job set nothing on the sheet.
        ticket('job', 'job', { createdAt: at('2026-10-01'), status: 'invoiceSubmitted', vehicle: { returnedAt: at('2026-10-06') } }),
        ticket('jobExtra', 'job', { createdAt: at('2026-10-02'), parentTicket: t.job, status: 'invoiceSubmitted', vehicle: { returnedAt: at('2026-10-06') } }),
      ]);
      const change = (bus, date, status, source, ticketKey) => ({ bus: b[bus], date, status, source, ...(ticketKey ? { ticket: t[ticketKey] } : {}) });
      await db('busstatuschanges').insertMany([
        change('back', '2026-10-01', 'repair', 'vsr', 'back'),
        change('kept', '2026-10-01', 'repair', 'vsr', 'keptRepair'),
        change('kept', '2026-10-02', 'tyreChange', 'vsr', 'keptTyre'),
        change('out', '2026-10-01', 'repair', 'vsr', 'out'),
        change('hand', '2026-10-01', 'repair', 'vsr', 'hand'),
        change('hand', '2026-10-04', 'ready', 'manual'),
        change('job', '2026-10-01', 'repair', 'vsr', 'job'),
      ]);

      const changesOf = async () => (await db('busstatuschanges').find().sort({ bus: 1, date: 1 }).toArray()).map(({ bus, date, status, source }) => [Object.keys(b).find((key) => b[key].equals(bus)), date, status, source]);
      const sync = (extra) => exec(process.execPath, [script, '--uri', uri, ...extra], { env: process.env, timeout: 60000 });

      const before = await changesOf();
      const dry = await sync([]);
      assert.match(dry.stdout, /Dry run on database \S+_sync/);
      assert.match(dry.stdout, /Buses whose latest status came from a VSR: 4/);
      assert.match(dry.stdout, /Ready from the day the bus came back: 2/);
      assert.match(dry.stdout, /Another open VSR's status from that day: 1/);
      assert.match(dry.stdout, /Still out, the VSR is open: 1/);
      assert.match(dry.stdout, /Already right: 0/);
      assert.match(dry.stdout, new RegExp(`Y-back-${run}: Ready from 2026-10-03 \\(VSR-back\\)`));
      assert.match(dry.stdout, new RegExp(`Y-kept-${run}: Out for repair from 2026-10-04 \\(VSR-keptTyre\\)`));
      assert.match(dry.stdout, /Nothing written\. Run it again with --apply to write\./);
      assert.deepEqual(await changesOf(), before, 'a dry run writes nothing');

      const applied = await sync(['--apply']);
      assert.match(applied.stdout, /Wrote 3 changes/);
      const after = await changesOf();
      const added = after.filter((row) => !before.some((old) => JSON.stringify(old) === JSON.stringify(row)));
      assert.deepEqual(added.sort(), [
        ['back', '2026-10-03', 'ready', 'vsr'],
        ['job', '2026-10-06', 'ready', 'vsr'],
        ['kept', '2026-10-04', 'repair', 'vsr'],
      ]);

      const again = await sync(['--apply']);
      assert.match(again.stdout, /Ready from the day the bus came back: 0/);
      assert.match(again.stdout, /Already right: 3/);
      assert.match(again.stdout, /Wrote 0 changes/);
      assert.deepEqual(await changesOf(), after);
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  });
});
