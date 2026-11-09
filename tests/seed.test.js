/**
 * The demo data is what the owner clicks through, so it has to run and leave the lifecycle
 * reachable. Runs the real seed against its own database, then reads that database back.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import mongoose from 'mongoose';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

describe('demo data', () => {
  test('the seed runs, reaches every stage, and its files and figures are real', async () => {
    const uri = process.env.MONGO_URI.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, query = '') => `/${db}_seed${query}`);
    const uploads = await mkdtemp(join(tmpdir(), 'muraqaba-seed-'));
    const env = { ...process.env, MONGO_URI: uri, NODE_ENV: 'development', UPLOAD_DIR: uploads, SEED_PASSWORD: 'SeedPass123!' };
    const connection = await mongoose.createConnection(uri).asPromise();
    try {
      // The live database still has the unique indexes from before chassis and registration became optional.
      await connection.dropDatabase();
      await connection.collection('buses').createIndex({ chassisNumber: 1 }, { unique: true, name: 'chassisNumber_1' });
      await connection.collection('buses').createIndex({ registrationNumber: 1 }, { unique: true, name: 'registrationNumber_1' });
      await run(process.execPath, [join(here, '..', 'scripts', 'seed.js'), '--reset'], { env, timeout: 90000 });

      const tickets = connection.collection('tickets');
      const statuses = await tickets.distinct('status');
      for (const status of ['sentToVendor', 'estimateSubmitted', 'estimateCountered', 'pending', 'returned', 'approved', 'acknowledged', 'vehicleSent', 'vehicleReceived', 'workInProgress', 'readyForDelivery', 'vehicleReleased', 'vehicleReturned', 'invoiceSubmitted', 'invoiceRejected', 'invoiceAccepted', 'invoiceReceived', 'forwardedToPurchase', 'grnCreated', 'completed']) {
        assert.ok(statuses.includes(status), `no demo VSR at ${status}`);
      }

      const children = await tickets.find({ parentTicket: { $exists: true } }).toArray();
      assert.equal(children.length, 2);
      const parent = await tickets.findOne({ _id: children[0].parentTicket });
      assert.deepEqual(children.map((c) => c.vsrNumber).sort(), [`${parent.vsrNumber}b`, `${parent.vsrNumber}c`]);

      const deducted = await tickets.findOne({ 'lpoDeduction.status': 'deducted', serviceType: 'tyre' });
      assert.ok(deducted.lpoDeduction.quantity > 0, 'a tyre change took quantity off an LPO');
      const lpos = connection.collection('lpos');
      const used = await lpos.findOne({ number: deducted.lpoDeduction.lpoNumber });
      assert.ok(used.usedAmount > 0);

      const maintenance = await tickets.findOne({ serviceType: 'oil', 'lpoDeduction.kind': 'repairMaintenance', 'lpoDeduction.status': 'deducted' });
      assert.ok(maintenance, 'an oil service came off a repair and maintenance LPO');
      assert.equal(maintenance.lpoDeduction.quantity, 0);

      // LPOs by make (2026-11-09): repair and maintenance for one make, tyres and batteries for every make.
      const buses = connection.collection('buses');
      const fleet = await buses.find().toArray();
      const allLpos = await lpos.find().toArray();
      assert.ok(allLpos.every((lpo) => lpo.items.every((item) => ['repairMaintenance', 'tyre', 'battery', 'other'].includes(item.kind))), 'only the new line kinds');
      for (const lpo of allLpos) {
        const forMake = lpo.items.some((item) => item.kind === 'repairMaintenance');
        assert.equal(Boolean(lpo.make), forMake, `${lpo.number} names a make only for repair and maintenance`);
        if (forMake) assert.ok(fleet.some((bus) => bus.make === lpo.make && String(bus.vendor) === String(lpo.vendor)), `${lpo.number} is for a make its vendor looks after`);
      }
      const offDeducted = await tickets.find({ 'lpoDeduction.status': 'deducted', 'lpoDeduction.kind': 'repairMaintenance' }).toArray();
      for (const ticket of offDeducted) {
        const lpo = allLpos.find((l) => String(l._id) === String(ticket.lpoDeduction.lpo));
        const bus = fleet.find((b) => String(b._id) === String(ticket.busId));
        assert.equal(lpo.make, bus.make, `${ticket.vsrNumber} came off the LPO for its bus's make`);
      }

      // One bus scrapped and sold, one waiting on a scrap request; neither has work open.
      const requests = await connection.collection('scraprequests').find().toArray();
      const open = async (busId) => tickets.countDocuments({ busId, status: { $nin: ['completed', 'declined'] } });
      const pending = requests.filter((r) => r.status === 'pending');
      assert.equal(pending.length, 1, 'one scrap request for the supervisor');
      const waitingBus = fleet.find((bus) => String(bus._id) === String(pending[0].bus));
      assert.equal(waitingBus.lifecycle, 'scrapRequested');
      assert.equal(await open(waitingBus._id), 0);
      assert.ok(pending[0].attachments.length && pending[0].reason);
      const sold = fleet.filter((bus) => bus.lifecycle === 'sold');
      assert.equal(sold.length, 1, 'one sold bus');
      const [archived] = sold;
      assert.ok(archived.sale.buyer && archived.sale.price > 0 && archived.sale.attachments.length, 'the sale has its details and a document');
      assert.ok(archived.scrappedOn < archived.sale.date, 'scrapped before it was sold');
      assert.equal(await open(archived._id), 0);
      assert.equal(requests.find((r) => String(r.bus) === String(archived._id))?.status, 'approved');
      const changes = await connection.collection('busstatuschanges').find({ bus: archived._id }).sort({ date: 1 }).toArray();
      assert.deepEqual(changes.map(({ date, status, source }) => [date, status, source]), [[archived.scrappedOn, 'scrapping', 'scrap'], [archived.sale.date, 'removed', 'scrap']]);
      assert.equal(await connection.collection('busstatuschanges').countDocuments({ status: { $in: ['scrapping', 'removed'] }, source: { $ne: 'scrap' } }), 0, 'never set by hand');
      assert.ok(fleet.filter((bus) => !['sold', 'scrapRequested'].includes(bus.lifecycle)).every((bus) => bus.lifecycle === 'inOperation'));
      const supervisor = await connection.collection('users').findOne({ role: 'supervisor' });
      assert.ok(await connection.collection('notifications').findOne({ user: supervisor._id, type: 'scrapRequested' }), 'the supervisor has been told');

      const completed = await tickets.findOne({ status: 'completed' });
      assert.ok(completed.grn && completed.purchaseInvoice && completed.signatures.some((s) => s.step === 'purchaseInvoice'));

      const round = (await tickets.findOne({ 'negotiation.attachments.0': { $exists: true } })).negotiation.find((r) => r.attachments.length);
      const onDisk = await stat(join(uploads, `${round.attachments[0]._id}.pdf`));
      assert.equal(onDisk.size, round.attachments[0].size, 'the demo documents exist as files');

      // The Vehicle panel and the history must give a trip step the same day.
      const travelled = await tickets.find({ 'vehicle.returnedAt': { $exists: true } }).toArray();
      assert.ok(travelled.length > 0);
      for (const ticket of travelled) {
        for (const [status, field] of [['vehicleSent', 'sentAt'], ['vehicleReleased', 'releasedAt'], ['vehicleReturned', 'returnedAt']]) {
          const entry = ticket.history.find((h) => h.status === status);
          if (entry) assert.equal(entry.effectiveAt?.toISOString(), ticket.vehicle[field]?.toISOString(), `${ticket.vsrNumber} ${status}`);
        }
      }

      const signed = await connection.collection('users').countDocuments({ signatureImage: { $exists: true } });
      assert.equal(signed, 5, 'everyone can sign straight away');

      // The owner's answers of 2026-11-06.
      assert.ok(fleet.every((bus) => bus.intervals.brakePads?.everyKm === 40000), 'every bus has the 40,000 km brake-pad interval');
      assert.ok(fleet.some((bus) => !('chassisNumber' in bus)), 'a bus without a chassis number');
      assert.ok(fleet.some((bus) => !('registrationNumber' in bus) && !('registrationExpiry' in bus)), 'a bus not registered yet');
      assert.ok(fleet.every((bus) => ![bus.chassisNumber, bus.registrationNumber].some((value) => value === null || value === '')), 'missing numbers are left out, never "" or null');
      const indexes = await buses.indexes();
      for (const name of ['chassisNumber_1', 'registrationNumber_1']) assert.ok(indexes.find((index) => index.name === name)?.sparse, `${name} is rebuilt sparse`);

      const depot = await tickets.find({ location: 'depot', serviceType: { $in: ['tyre', 'battery'] } }).toArray();
      assert.ok(depot.length > 0, 'a tyre or battery job done at the depot');
      for (const ticket of depot) {
        assert.ok(!ticket.history.some((h) => ['vehicleSent', 'vehicleReceived', 'vehicleReleased'].includes(h.status)), `${ticket.vsrNumber} makes no trip`);
        const started = ticket.history.find((h) => h.status === 'workInProgress');
        assert.equal(started.effectiveAt.toISOString(), ticket.vehicle.receivedAt.toISOString(), `${ticket.vsrNumber} starts when the vendor gives the reading`);
        assert.equal(started.km, ticket.vehicle.receivedKm);
      }

      const warranty = await tickets.findOne({ serviceType: 'repair', noChargeReason: 'warranty' });
      assert.ok(warranty, 'a repair under warranty');
      assert.equal(warranty.approvedEstimate, 0);
      assert.equal(warranty.status, 'completed');
      assert.equal(warranty.history.at(-1).note, 'No charge');
      assert.equal(warranty.history.at(-2).status, 'vehicleReturned');
      assert.equal(warranty.invoice, undefined);
      assert.equal(warranty.negotiation.filter((r) => r.from === 'vendor').at(-1).noChargeReason, 'warranty');
      assert.ok(warranty.breakdown.quotationTotal > 0, 'what the work was worth is on record');

      const accidents = await tickets.find({ repairCategory: 'ACCIDENT' }).toArray();
      assert.ok(accidents.length > 0);
      assert.ok(accidents.every((t) => t.accident?.severity && t.accident?.fault), 'every accident has severity and fault');
      assert.ok(await tickets.findOne({ serviceType: 'brakePads' }), 'a brake-pad VSR');
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  });
});
