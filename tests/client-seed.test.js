/**
 * The client seed loads a depot's own records (prepared outside this repository). It runs only
 * where that folder exists: CLIENT_DATA, or client-data/ next to the backend folder. It checks the
 * database against the JSON it was loaded from, and that the records fit the app's own rules.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import mongoose from 'mongoose';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const folder = process.env.CLIENT_DATA || join(here, '..', '..', 'client-data');
const present = existsSync(join(folder, 'client-data.json'));

describe('client seed', () => {
  test('loads every record and leaves each VSR where the records put it', { skip: !present && 'no client data folder' }, async () => {
    const data = JSON.parse(await readFile(join(folder, 'client-data.json'), 'utf8'));
    const uri = process.env.MONGO_URI.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, query = '') => `/${db}_client${query}`);
    const uploads = await mkdtemp(join(tmpdir(), 'muraqaba-client-'));
    const env = { ...process.env, MONGO_URI: uri, NODE_ENV: 'development', UPLOAD_DIR: uploads, SEED_PASSWORD: 'SeedPass123!' };
    const connection = await mongoose.createConnection(uri).asPromise();
    try {
      await connection.dropDatabase();
      await run(process.execPath, [join(here, '..', 'scripts', 'seed.js'), '--reset', '--client', folder], { env, timeout: 180000 });
      const db = (name) => connection.collection(name);

      // Everything in the file is there.
      assert.equal(await db('buses').countDocuments(), data.buses.length);
      assert.equal(await db('users').countDocuments({ role: 'vendor' }), data.vendors.length);
      assert.equal(await db('users').countDocuments({ role: { $ne: 'vendor' } }), 3, 'the demo staff accounts');
      assert.equal(await db('users').countDocuments({ signatureImage: { $exists: true } }), data.vendors.length + 3);
      for (const email of ['creator@muraqaba.dev', 'supervisor@muraqaba.dev', 'purchasing@muraqaba.dev', 'vendor@muraqaba.dev', 'vendor2@muraqaba.dev']) {
        assert.ok(await db('users').findOne({ email }), `${email} exists`);
      }
      assert.equal(await db('lpos').countDocuments(), data.lpos.length);
      assert.equal(await db('busdailyreadings').countDocuments(), Object.values(data.readings).reduce((sum, days) => sum + days.length, 0));
      assert.equal(await db('busstatuschanges').countDocuments(), data.statusChanges.length);
      assert.equal((await db('counters').findOne({ _id: 'vsr' })).seq, data.meta.lastVsrNumber, 'new VSRs continue the depot\'s numbering');

      const tickets = await db('tickets').find().toArray();
      assert.equal(tickets.length, data.vsrs.length);
      const byNumber = new Map(tickets.map((t) => [t.vsrNumber, t]));
      for (const vsr of data.vsrs) assert.equal(byNumber.get(vsr.vsrNumber)?.status, vsr.stage, vsr.vsrNumber);

      // Nothing is dated in the future, and every history runs forward in time.
      const now = Date.now();
      for (const ticket of tickets) {
        const times = ticket.history.map((h) => h.at.getTime());
        assert.ok(times.every((t, i) => t <= now && (i === 0 || t >= times[i - 1])), `${ticket.vsrNumber} history in order and not in the future`);
        assert.equal(ticket.createdAt.getTime(), times[0], `${ticket.vsrNumber} was raised when its history starts`);
      }

      // A finished paid job has an accepted invoice, a GRN and a purchase invoice; a no-charge one has none.
      const invoices = new Map((await db('invoices').find().toArray()).map((i) => [String(i._id), i]));
      for (const ticket of tickets.filter((t) => t.status === 'completed')) {
        if (ticket.noChargeReason) {
          assert.equal(ticket.invoice, undefined, `${ticket.vsrNumber} no charge, no invoice`);
          assert.equal(ticket.approvedEstimate, 0);
        } else {
          assert.equal(invoices.get(String(ticket.invoice))?.status, 'approved', `${ticket.vsrNumber} invoice accepted`);
          assert.ok(ticket.grn && ticket.purchaseInvoice, `${ticket.vsrNumber} has a GRN and a purchase invoice`);
        }
      }
      for (const grn of await db('grns').find().toArray()) {
        const total = grn.tickets.reduce((sum, id) => sum + Math.round(invoices.get(String(tickets.find((t) => t._id.equals(id)).invoice)).amount * 100), 0);
        assert.equal(Math.round(grn.total * 100), total, `${grn.number} totals its invoices`);
      }

      // Each LPO line has taken off exactly what the accepted invoices say.
      for (const lpo of await db('lpos').find().toArray()) {
        for (const item of lpo.items) {
          const taken = tickets.filter((t) => t.lpoDeduction?.status === 'deducted' && String(t.lpoDeduction.item) === String(item._id));
          assert.equal(Math.round(item.usedAmount * 100), taken.reduce((sum, t) => sum + Math.round(t.lpoDeduction.amount * 100), 0), `${lpo.number} ${item.kind} amount`);
          assert.equal(item.usedQuantity, taken.reduce((sum, t) => sum + t.lpoDeduction.quantity, 0), `${lpo.number} ${item.kind} quantity`);
        }
      }

      // Repair and maintenance are one line for one make, the make most of the vendor's buses have (2026-11-09).
      const fleet = await db('buses').find().toArray();
      for (const lpo of await db('lpos').find().toArray()) {
        assert.ok(lpo.items.every((item) => !['repair', 'maintenance'].includes(item.kind)), `${lpo.number} has no old line kinds`);
        assert.ok(lpo.items.filter((item) => item.kind === 'repairMaintenance').length <= 1, `${lpo.number} has one repair and maintenance line`);
        const forMake = lpo.items.some((item) => item.kind === 'repairMaintenance');
        assert.equal(Boolean(lpo.make), forMake, `${lpo.number} names a make only for repair and maintenance`);
        if (!forMake) continue;
        const makes = fleet.filter((bus) => String(bus.vendor) === String(lpo.vendor)).map((bus) => bus.make);
        const most = Math.max(...makes.map((make) => makes.filter((m) => m.toLowerCase() === make.toLowerCase()).length));
        assert.equal(makes.filter((m) => m.toLowerCase() === lpo.make.toLowerCase()).length, most, `${lpo.number} is for its vendor's main make`);
      }

      // Each bus's lifecycle is what its latest daily status says.
      const statusesOf = new Map();
      data.statusChanges.forEach((change) => statusesOf.set(change.bus, [...(statusesOf.get(change.bus) ?? []), change]));
      for (const bus of fleet) {
        const list = (statusesOf.get(bus.fleetNumber) ?? []).sort((a, b) => a.date.localeCompare(b.date));
        const latest = list.at(-1)?.status;
        const expected = latest === 'scrapping' ? 'scrapped' : latest === 'removed' ? 'sold' : 'inOperation';
        assert.equal(bus.lifecycle, expected, `${bus.fleetNumber} lifecycle`);
        const statusOn = (day) => list.filter((change) => change.date <= day).at(-1)?.status;
        if (expected === 'scrapped') assert.equal(statusOn(bus.scrappedOn), 'scrapping', `${bus.fleetNumber} scrapped from a Scrapping day`);
        if (expected === 'sold') {
          assert.equal(statusOn(bus.sale.date), 'removed', `${bus.fleetNumber} sold on a Removed day`);
          assert.ok(list.filter((change) => change.date > bus.sale.date).every((change) => change.status === 'removed'), `${bus.fleetNumber} removed from then on`);
          assert.notEqual(list.filter((change) => change.date < bus.sale.date).at(-1)?.status, 'removed', `${bus.fleetNumber} sold on the first day of that run`);
          assert.ok(bus.scrappedOn <= bus.sale.date && bus.sale.buyer === undefined && bus.sale.price === undefined, `${bus.fleetNumber} has no buyer or price on record`);
        }
      }
      assert.equal(await db('scraprequests').countDocuments(), 0, 'the records hold no scrap request');

      // Odometers never go down, as the daily sheet requires.
      const readings = await db('busdailyreadings').find().sort({ bus: 1, date: 1 }).toArray();
      readings.forEach((r, i) => {
        const before = readings[i - 1];
        if (before && String(before.bus) === String(r.bus)) assert.ok(r.km >= before.km, `reading on ${r.date} below the day before`);
      });

      // Missing numbers are left out, never stored empty, so the sparse unique indexes hold.
      const buses = await db('buses').find().toArray();
      assert.ok(buses.every((bus) => ![bus.chassisNumber, bus.registrationNumber].some((value) => value === null || value === '')));
      assert.ok(buses.every((bus) => Boolean(bus.registrationNumber) === Boolean(bus.registrationExpiry)), 'an expiry goes only with a registration number');
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  });
});
