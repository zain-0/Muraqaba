/**
 * What an independent review of the workshop flow found: races, dead ends, and data that
 * slipped past the checks. Each test names the failure it stops happening again.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api, busBody, createBus, estimate, fillBreakdown, multipart, newVendor, run, signInEveryone, toAcknowledged, toForwarded, toInvoiceAccepted } from './helpers.js';

let users;
let bus;
let Ticket;
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });
const read = async (id, token = users.creator.token) => (await api('GET', `/tickets/${id}`, { token })).body.data;
const raise = async (body = {}, busId = bus._id) => {
  const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000, ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const JOB = { description: 'Found a cracked exhaust while fixing the engine.', serviceType: 'repair', repairCategory: 'MECHANICAL', amount: '400', quotationNumber: 'Q-X', daysToComplete: '2' };

/** A VSR with the bus at the vendor and a job approved on it. */
const parentWithJob = async () => {
  const { _id: id } = await toAcknowledged(users, await raise(), users.vendor1);
  await put(id, 'vehicle/sent', users.creator.token);
  await put(id, 'vehicle/received', users.vendor1.token, { km: 5050 });
  await put(id, 'work/start', users.vendor1.token);
  const job = (await multipart(`/tickets/${id}/additional`, users.vendor1.token, JOB)).body.data;
  await fillBreakdown(users, job._id, 400);
  await put(job._id, 'escalate', users.creator.token);
  await put(job._id, 'approve', users.supervisor.token);
  return { id, jobId: job._id };
};

describe('after the review', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'AUD', users.vendor1.id, { rates: undefined });
    ({ default: Ticket } = await import('../models/Ticket.js'));
    const { default: connectDB } = await import('../config/db.js');
    await connectDB({ maxAttempts: 2 });
  });

  after(() => mongoose.connection.close());

  describe('who can do and see what', () => {
    test('only the service creator does the steps the owner gave the creator, not a supervisor through the API', async () => {
      const { _id: id } = await toAcknowledged(users, await raise(), users.vendor1);
      assert.equal((await put(id, 'vehicle/sent', users.supervisor.token)).status, 403);
      assert.equal((await put(id, 'breakdown', users.supervisor.token, { consumables: 1 })).status, 403);
      const back = await fetch(`${process.env.API_URL}/api/tickets/${id}/scan-quotation`, { method: 'POST', headers: { Authorization: `Bearer ${users.supervisor.token}` } });
      assert.equal(back.status, 403);
      assert.equal((await put(id, 'vehicle/returned', users.supervisor.token, { km: 5100 })).status, 403);
      assert.equal((await put(id, 'invoice/received', users.supervisor.token)).status, 403);
      assert.equal((await put(id, 'forward', users.supervisor.token)).status, 403);
    });

    test('a vendor is not told who in the depot handled purchasing, or when', async () => {
      const vendor = await newVendor('aud-hist');
      const own = await createBus(users, 'AUDH', vendor.id, { rates: undefined });
      const ticket = await toForwarded(users, await raise({}, own._id), vendor);
      const grn = await multipart('/grns', users.purchasing.token, { number: `GRN-${run}-H`, ticketIds: ticket._id });
      await multipart('/purchase-invoices', users.purchasing.token, { number: `PI-${run}-H`, grnId: grn.body.data._id });

      const seen = await read(ticket._id, vendor.token);
      assert.equal(seen.status, 'completed');
      const statuses = seen.history.map((h) => h.status);
      for (const hidden of ['invoiceReceived', 'forwardedToPurchase', 'grnCreated']) assert.ok(!statuses.includes(hidden), hidden);
      assert.ok(statuses.includes('completed'), 'they still see that it closed');
      assert.equal(seen.history.at(-1).by, undefined);
      assert.ok(!JSON.stringify(seen).includes('test-purchasing'), 'no purchasing account anywhere');
      assert.equal(seen.forwardedAt, undefined);
      assert.equal(seen.invoiceReceivedAt, undefined);

      const depot = await read(ticket._id);
      assert.ok(depot.history.some((h) => h.status === 'grnCreated'), 'the depot keeps the whole history');
    });

    test('a vendor dashboard says nothing about the fleet', async () => {
      const res = await api('GET', '/users/dashboard', { token: users.vendor1.token });
      assert.equal(res.body.data.fleet, undefined);
      assert.ok(res.body.data.tickets);
    });

    test('purchasing can only export what it can read', async () => {
      const early = await raise();
      const res = await fetch(`${process.env.API_URL}/api/grns/export?ticketIds=${early._id}`, { headers: { Authorization: `Bearer ${users.purchasing.token}` } });
      assert.equal(res.status, 404);
    });

    test('a returned additional job cannot be moved to another bus or kind', async () => {
      const { _id: id } = await toAcknowledged(users, await raise(), users.vendor1);
      await put(id, 'vehicle/sent', users.creator.token);
      await put(id, 'vehicle/received', users.vendor1.token, { km: 5050 });
      const job = (await multipart(`/tickets/${id}/additional`, users.vendor1.token, JOB)).body.data;
      await fillBreakdown(users, job._id, 400);
      await put(job._id, 'escalate', users.creator.token);
      await put(job._id, 'return', users.supervisor.token, { reason: 'Check it' });

      const other = await createBus(users, 'AUDO', users.vendor1.id);
      const moved = await put(job._id, 'details', users.creator.token, { busId: other._id, serviceType: 'oil', currentReading: 9000 });
      assert.equal(moved.status, 409);
      const after = await read(job._id);
      assert.equal(after.busId._id, bus._id);
      assert.equal(after.agreedPrice, undefined);
      assert.equal((await put(job._id, 'escalate', users.creator.token)).status, 200, 'it can still go back for approval');
    });
  });

  describe('purchasing under load', () => {
    const number = (label) => `${label}-${run}`;

    test('two GRNs racing for one VSR: one wins, and the loser leaves nothing behind', async () => {
      const [a, b, c] = [await toForwarded(users, await raise(), users.vendor1), await toForwarded(users, await raise(), users.vendor1), await toForwarded(users, await raise(), users.vendor1)];
      const results = await Promise.all([
        multipart('/grns', users.purchasing.token, { number: number('RACE-A'), ticketIds: `${a._id},${b._id}` }),
        multipart('/grns', users.purchasing.token, { number: number('RACE-B'), ticketIds: `${b._id},${c._id}` }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409], statuses.join());

      const grns = (await api('GET', '/grns?limit=200', { token: users.purchasing.token })).body.data;
      const made = grns.filter((g) => [number('RACE-A'), number('RACE-B')].includes(g.number));
      assert.equal(made.length, 1, 'the loser made no GRN');

      const winnerHas = made[0].tickets.map((t) => t._id);
      for (const ticket of [a, b, c]) {
        const after = await read(ticket._id);
        if (winnerHas.includes(ticket._id)) {
          assert.equal(after.status, 'grnCreated');
          assert.equal(after.grn.number, made[0].number);
        } else {
          assert.equal(after.status, 'forwardedToPurchase', 'the one only the loser wanted is untouched');
          assert.equal(after.grn, undefined);
        }
      }
    });

    test('a taken GRN number leaves every VSR free for the next try', async () => {
      const first = await toForwarded(users, await raise(), users.vendor1);
      assert.equal((await multipart('/grns', users.purchasing.token, { number: number('TAKEN'), ticketIds: first._id })).status, 201);
      const next = await toForwarded(users, await raise(), users.vendor1);
      assert.equal((await multipart('/grns', users.purchasing.token, { number: number('TAKEN'), ticketIds: next._id })).status, 409);
      assert.equal((await multipart('/grns', users.purchasing.token, { number: number('FREE'), ticketIds: next._id })).status, 201, 'nothing was left claimed');
    });

    test('two purchase invoices racing for one GRN: one wins and each VSR closes once', async () => {
      const ticket = await toForwarded(users, await raise(), users.vendor1);
      const grn = (await multipart('/grns', users.purchasing.token, { number: number('PIR'), ticketIds: ticket._id })).body.data;
      const results = await Promise.all([1, 2].map((n) => multipart('/purchase-invoices', users.purchasing.token, { number: number(`PIR${n}`), grnId: grn._id })));
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      const after = await read(ticket._id);
      assert.equal(after.history.filter((h) => h.status === 'completed').length, 1);
      assert.equal(after.signatures.filter((s) => s.step === 'purchaseInvoice').length, 1);
    });

    test('a taken purchase invoice number leaves the GRN free for the next try', async () => {
      const ticket = await toForwarded(users, await raise(), users.vendor1);
      const grn = (await multipart('/grns', users.purchasing.token, { number: number('PIF'), ticketIds: ticket._id })).body.data;
      assert.equal((await multipart('/purchase-invoices', users.purchasing.token, { number: number('PIT'), grnId: grn._id })).status, 201);
      const other = await toForwarded(users, await raise(), users.vendor1);
      const second = (await multipart('/grns', users.purchasing.token, { number: number('PIF2'), ticketIds: other._id })).body.data;
      assert.equal((await multipart('/purchase-invoices', users.purchasing.token, { number: number('PIT'), grnId: second._id })).status, 409);
      assert.equal((await multipart('/purchase-invoices', users.purchasing.token, { number: number('PIT2'), grnId: second._id })).status, 201);
    });
  });

  describe('dead ends', () => {
    test('a job left behind when its parent has gone can still be released on its own', async () => {
      const { id, jobId } = await parentWithJob();
      await put(id, 'work/ready', users.vendor1.token);
      assert.equal((await put(id, 'vehicle/release', users.vendor1.token)).status, 200);
      // What a race between releasing the parent and starting the job leaves behind.
      await Ticket.updateOne({ _id: jobId }, { $set: { status: 'workInProgress' } });

      assert.equal((await put(jobId, 'work/ready', users.vendor1.token)).status, 200);
      const released = await put(jobId, 'vehicle/release', users.vendor1.token);
      assert.equal(released.status, 200, JSON.stringify(released.body));
      assert.equal((await read(jobId)).status, 'vehicleReleased');
    });

    test('a job left behind after the bus is back can still get there', async () => {
      const { id, jobId } = await parentWithJob();
      await put(id, 'work/ready', users.vendor1.token);
      await put(id, 'vehicle/release', users.vendor1.token);
      await put(id, 'vehicle/returned', users.creator.token, { km: 5200 });
      await Ticket.updateOne({ _id: jobId }, { $set: { status: 'readyForDelivery' } });
      assert.equal((await put(jobId, 'vehicle/release', users.vendor1.token)).status, 200);
      assert.equal((await read(id)).status, 'vehicleReturned', 'releasing the job leaves a parent that is already back alone');
      assert.equal((await put(jobId, 'vehicle/returned', users.creator.token, { km: 5200 })).status, 200);
      assert.equal((await read(id)).history.filter((h) => h.status === 'vehicleReturned').length, 1);
      assert.equal((await read(id)).status, 'vehicleReturned', 'the parent is where it was');
    });
  });

  describe('readings and dates', () => {
    const atVendor = async (extra) => {
      const { _id: id } = await toAcknowledged(users, await raise(extra), users.vendor1);
      await put(id, 'vehicle/sent', users.creator.token, { date: '2026-10-05' });
      return id;
    };

    test('a date cannot go before the step before it', async () => {
      const id = await atVendor();
      const early = await put(id, 'vehicle/received', users.vendor1.token, { km: 5100, date: '2026-10-04' });
      assert.equal(early.status, 400);
      assert.equal(early.body.errors[0].field, 'date');
      assert.equal((await put(id, 'vehicle/received', users.vendor1.token, { km: 5100, date: '2026-10-05' })).status, 200, 'the same day is fine');
    });

    test('an odometer does not go backwards, and an extra digit is caught', async () => {
      const id = await atVendor();
      for (const km of [4999, 999999]) {
        const res = await put(id, 'vehicle/received', users.vendor1.token, { km });
        assert.equal(res.status, 400, String(km));
        assert.equal(res.body.errors[0].field, 'km');
      }
      assert.equal((await put(id, 'vehicle/received', users.vendor1.token, { km: 5100 })).status, 200);
      await put(id, 'work/start', users.vendor1.token);
      await put(id, 'work/ready', users.vendor1.token);
      await put(id, 'vehicle/release', users.vendor1.token);
      const lower = await put(id, 'vehicle/returned', users.creator.token, { km: 5099 });
      assert.equal(lower.status, 400, 'lower than when the vendor received it');
      assert.equal(lower.body.errors[0].field, 'km');
      assert.equal((await put(id, 'vehicle/returned', users.creator.token, { km: 999999 })).status, 400);
      assert.equal((await read(id)).status, 'vehicleReleased');
      assert.equal((await put(id, 'vehicle/returned', users.creator.token, { km: 5100 })).status, 200, 'the same reading is fine');
    });

    test('an empty date means today, on every step', async () => {
      const { _id: id } = await toAcknowledged(users, await raise(), users.vendor1);
      const sent = await put(id, 'vehicle/sent', users.creator.token, { date: '' });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.ok(sent.body.data.vehicle.sentAt);
    });

    test('a battery date left empty on a bus never takes the fleet down', async () => {
      const own = await createBus(users, 'AUDB', users.vendor1.id);
      const intervals = { ...busBody('X', users.vendor1.id).intervals, battery: { everyMonths: 18, lastDate: null }, oil: { everyKm: 10000, lastKm: null } };
      const saved = await api('PUT', `/buses/${own._id}`, { token: users.creator.token, body: busBody('AUDB', users.vendor1.id, { intervals }) });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.ok(saved.body.data.intervals.battery.lastDate, 'it keeps a date');
      assert.equal(saved.body.data.intervals.oil.lastKm, 0);
      assert.equal((await api('GET', '/buses', { token: users.creator.token })).status, 200);
      assert.equal((await api('GET', '/users/dashboard', { token: users.supervisor.token })).status, 200);
    });

    test('empty values on parts and labour read as nothing', async () => {
      const ticket = await raise();
      await estimate(ticket._id, users.vendor1.token, { amount: '100' });
      const nothing = await put(ticket._id, 'breakdown', users.creator.token, { parts: null, labourHours: null, consumables: null });
      assert.equal(nothing.status, 400);
      assert.equal(nothing.body.errors[0].field, 'parts');
      const saved = await put(ticket._id, 'breakdown', users.creator.token, { parts: null, labourHours: null, consumables: 100 });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.data.breakdown.quotationTotal, 100);
    });

    test('what is left never reads above the interval, after a reading older than the last service', async () => {
      const own = await createBus(users, 'AUDL', users.vendor1.id, { rates: undefined });
      const { today } = (await api('GET', '/sheets/readings', { token: users.creator.token })).body.data;
      await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: own._id, date: today, km: 100000 } });
      const oil = await raise({ serviceType: 'oil', repairCategory: undefined, currentReading: 100000 }, own._id);
      await toAcknowledged(users, oil, users.vendor1);
      await put(oil._id, 'vehicle/sent', users.creator.token);
      await put(oil._id, 'vehicle/received', users.vendor1.token, { km: 100020 });
      await put(oil._id, 'work/start', users.vendor1.token);
      await put(oil._id, 'work/ready', users.vendor1.token);
      await put(oil._id, 'vehicle/release', users.vendor1.token);
      await put(oil._id, 'vehicle/returned', users.creator.token, { km: 100050 });

      const { intervalStatus } = (await api('GET', `/buses/${own._id}`, { token: users.creator.token })).body.data;
      assert.equal(intervalStatus.oil.left, 10000);
      assert.equal(intervalStatus.oil.used, 0);
    });
  });

  describe('LPO and figures', () => {
    const YEAR = new Date().getUTCFullYear();
    const VALID = { validFrom: '2026-01-01', validTo: '2099-12-31' };
    const lpoOf = (vendor, label, items) => api('POST', '/lpos', { token: users.purchasing.token, body: { number: `LPO-${run}-${label}`, vendorId: vendor.id, ...VALID, items } });

    test('a tyre job counts its tyres, not its valves and weights', async () => {
      const vendor = await newVendor('aud-lpo');
      const own = await createBus(users, 'AUDT', vendor.id, { rates: undefined });
      await lpoOf(vendor, 'T', [{ kind: 'tyre', name: 'Tyre', quantity: 10, unitPrice: 800 }]);
      const ticket = await raise({ serviceType: 'tyre', repairCategory: undefined, currentReading: 1000 }, own._id);
      await estimate(ticket._id, vendor.token, { amount: '1700' });
      const saved = await put(ticket._id, 'breakdown', users.creator.token, {
        parts: [
          { name: 'Tyre', quantity: 2, unitPrice: 800 },
          { name: 'Valve', quantity: 4, unitPrice: 10 },
          { name: 'Weight', quantity: 12, unitPrice: 5 },
        ],
        unitsFitted: 2,
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.data.breakdown.unitsFitted, 2);
      await put(ticket._id, 'escalate', users.creator.token);
      const done = await toInvoiceAccepted(users, { ...ticket, status: 'pending' }, vendor, { invoice: { amount: '1700' } });
      assert.equal(done.lpoDeduction.quantity, 2);
      assert.equal(done.lpoDeduction.overrun, false);
      assert.equal((await put(ticket._id, 'breakdown', users.creator.token, { unitsFitted: -1, consumables: 1 })).status, 400, 'and it is checked');
    });

    test('other work comes off an Other line when the vendor has one, and is quiet when not', async () => {
      const vendor = await newVendor('aud-other');
      const own = await createBus(users, 'AUDX', vendor.id, { rates: undefined });
      const none = await toInvoiceAccepted(users, await raise({ serviceType: 'other', repairCategory: undefined, currentReading: 1000 }, own._id), vendor, { invoice: { amount: '300' } });
      assert.equal(none.lpoDeduction, undefined, 'no line for it, so no warning');

      const lpo = (await lpoOf(vendor, 'X', [{ kind: 'other', name: 'Cleaning', quantity: 1, unitPrice: 5000 }])).body.data;
      const done = await toInvoiceAccepted(users, await raise({ serviceType: 'other', repairCategory: undefined, currentReading: 1000 }, own._id), vendor, { invoice: { amount: '300' } });
      assert.equal(done.lpoDeduction.status, 'deducted');
      assert.equal(done.lpoDeduction.quantity, 0);
      const after = (await api('GET', `/lpos/${lpo._id}`, { token: users.purchasing.token })).body.data;
      assert.equal(after.items[0].usedAmount, 300);
    });

    test('a declined job is not counted as work done', async () => {
      const brand = `Declined${run}`;
      const own = await createBus(users, 'AUDD', users.vendor1.id, { make: brand, rates: undefined });
      const { _id: id } = await toAcknowledged(users, await raise({}, own._id), users.vendor1);
      await put(id, 'vehicle/sent', users.creator.token);
      await put(id, 'vehicle/received', users.vendor1.token, { km: 5050 });
      const job = (await multipart(`/tickets/${id}/additional`, users.vendor1.token, JOB)).body.data;
      await fillBreakdown(users, job._id, 400);
      await put(job._id, 'escalate', users.creator.token);
      await put(job._id, 'decline', users.supervisor.token, { reason: 'Not now' });

      const query = await api('GET', `/reports/query?brand=${brand}&year=${YEAR}`, { token: users.purchasing.token });
      assert.equal(query.body.data.total.count, 1);
      const fleet = await api('GET', `/reports/fleet?brand=${brand}&year=${YEAR}`, { token: users.supervisor.token });
      assert.equal(fleet.body.data.totals.repair, 1);
      assert.equal(fleet.body.data.byBrand.find((row) => row.brand === brand).repair, 1);
    });
  });

  describe('the history shows the documents', () => {
    test('each estimate, invoice, GRN and purchase invoice is named in the depot history', async () => {
      const ticket = await raise();
      await estimate(ticket._id, users.vendor1.token, { amount: '900' });
      const reply = await multipart(`/tickets/${ticket._id}/estimate/reply`, users.creator.token, { note: 'Lower' });
      assert.equal(reply.status, 201);
      await estimate(ticket._id, users.vendor1.token, { amount: '900', quotationNumber: 'Q-2' });
      const afterTwo = await read(ticket._id);
      const notes = afterTwo.history.filter((h) => h.status === 'estimateSubmitted').map((h) => h.note);
      assert.deepEqual(notes, ['Estimate 1', 'Estimate 2']);
    });
  });
});
