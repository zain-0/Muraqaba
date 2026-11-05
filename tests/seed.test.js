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
    await run(process.execPath, [join(here, '..', 'scripts', 'seed.js'), '--reset'], { env, timeout: 90000 });

    const connection = await mongoose.createConnection(uri).asPromise();
    try {
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

      const maintenance = await tickets.findOne({ 'lpoDeduction.kind': 'maintenance', 'lpoDeduction.status': 'deducted' });
      assert.ok(maintenance, 'an oil service came off a maintenance LPO');
      assert.equal(maintenance.lpoDeduction.quantity, 0);

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
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  });
});
