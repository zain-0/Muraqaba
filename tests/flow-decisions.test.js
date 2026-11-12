/**
 * The owner's answers of 2026-11-06 (.audit/client-decisions-plan.md, sections A to F): jobs
 * at no charge, work done at the depot, accident details for our own records, brake pads,
 * buses without a chassis number or a registration yet, and the Side number.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import { BASE, api, busBody, createBus, estimate, fillBreakdown, fromAcknowledgedToReturned, multipart, run, signInEveryone, submitInvoice, toAcknowledged, toForwarded } from './helpers.js';

let users;
let bus;
let counter = 0;
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });
const read = async (id, token = users.creator.token) => (await api('GET', `/tickets/${id}`, { token })).body.data;
const firstError = (res) => res.body.errors?.[0];
const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const raise = async (body = {}, onBus = bus) => ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: onBus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000, ...body } }));
const ownBus = (suffix, overrides = {}) => createBus(users, `${suffix}${(counter += 1)}`, users.vendor1.id, { rates: undefined, ...overrides });
const postBus = (overrides) => api('POST', '/buses', { token: users.creator.token, body: busBody(`B${(counter += 1)}`, users.vendor1.id, overrides) });

const JOB = { description: 'Found a cracked exhaust while fixing the engine.', serviceType: 'repair', repairCategory: 'MECHANICAL', amount: '400', quotationNumber: 'Q-EXTRA', daysToComplete: '2' };
const addJob = (parentId, fields = {}) => multipart(`/tickets/${parentId}/additional`, users.vendor1.token, { ...JOB, ...fields });
/** An additional job taken through parts and labour, the creator and the supervisor. */
const approveJob = async (job, amount = 400) => {
  if (amount) await fillBreakdown(users, job._id, amount);
  ok(await put(job._id, 'escalate', users.creator.token));
  return ok(await put(job._id, 'approve', users.supervisor.token));
};

/** A VSR the vendor quoted at AED 0 for this reason, approved and acknowledged. */
const noChargeAcknowledged = async (reason, overrides = {}, onBus = bus) => {
  const ticket = await raise(overrides, onBus);
  ok(await estimate(ticket._id, users.vendor1.token, { amount: '0', noChargeReason: reason }));
  ok(await put(ticket._id, 'escalate', users.creator.token));
  ok(await put(ticket._id, 'approve', users.supervisor.token));
  return ok(await put(ticket._id, 'acknowledge', users.vendor1.token, { daysToComplete: 3 }));
};

/** At the vendor's workshop with work under way, received on 5 October at 5050 km. */
const atTheWorkshop = async (ticket) => {
  await put(ticket._id, 'vehicle/sent', users.creator.token, { date: '2026-10-04' });
  ok(await put(ticket._id, 'vehicle/received', users.vendor1.token, { km: 5050, date: '2026-10-05' }));
  return ok(await put(ticket._id, 'work/start', users.vendor1.token, { date: '2026-10-06' }));
};

/** A depot job the vendor has started on 5 October, 50 km after the reading it was raised at. */
const depotAtWork = async (overrides = {}, onBus = bus) => {
  const ticket = await toAcknowledged(users, await raise({ location: 'depot', ...overrides }, onBus), users.vendor1);
  return ok(await put(ticket._id, 'work/start', users.vendor1.token, { km: ticket.currentReading + 50, date: '2026-10-05' }));
};

// An accident is a service type of its own since 2026-11-11, with no repair category.
const ACCIDENT = { serviceType: 'accident', repairCategory: undefined, accident: { severity: 'minor', fault: 'otherParty' } };

/** Talks to the test database directly, for what the API no longer lets anyone do. */
const withDatabase = async (uri, work) => {
  const connection = await mongoose.createConnection(uri).asPromise();
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
};

/** A bus added before brake pads had an interval. */
const busWithoutBrakePads = async (suffix) => {
  const created = await ownBus(suffix);
  await withDatabase(process.env.MONGO_URI, (db) => db.collection('buses').updateOne({ _id: new mongoose.Types.ObjectId(created._id) }, { $unset: { 'intervals.brakePads': 1 } }));
  return created;
};

describe('client decisions of 2026-11-06', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'FLOW', users.vendor1.id, { rates: undefined });
  });

  describe('A. jobs at no charge', () => {
    test('an estimate of AED 0 needs a reason, and a reason needs AED 0', async () => {
      const ticket = await raise();
      const send = (fields) => estimate(ticket._id, users.vendor1.token, fields);
      assert.deepEqual(firstError(await send({ amount: '0' })), { field: 'amount', message: 'Enter an amount above 0, or choose why there is no charge' });
      assert.deepEqual(firstError(await send({ amount: '0', noChargeReason: '' })), { field: 'amount', message: 'Enter an amount above 0, or choose why there is no charge' });
      assert.deepEqual(firstError(await send({ amount: '500', noChargeReason: 'warranty' })), { field: 'noChargeReason', message: 'A reason for no charge goes only with an amount of 0' });
      assert.deepEqual(firstError(await send({ amount: '0', noChargeReason: 'cheap' })), { field: 'noChargeReason', message: 'Choose a valid reason for no charge' });

      const sent = await send({ amount: '0', noChargeReason: 'warranty' });
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
      assert.equal(sent.body.data.negotiation[0].amount, 0);
      assert.equal(sent.body.data.negotiation[0].noChargeReason, 'warranty');

      const paid = await send({ amount: '500', noChargeReason: '' });
      assert.equal(paid.status, 409, 'the rules pass, only the stage is wrong now');

      const reply = await estimate(ticket._id, users.creator.token, { amount: '0' }, '/reply');
      assert.equal(reply.status, 400, 'the creator still counters with an amount above 0');
    });

    test('an additional job follows the same rules', async () => {
      const parent = await atTheWorkshop(await toAcknowledged(users, await raise(), users.vendor1));
      assert.deepEqual(firstError(await addJob(parent._id, { amount: '0' })), { field: 'amount', message: 'Enter an amount above 0, or choose why there is no charge' });
      assert.deepEqual(firstError(await addJob(parent._id, { noChargeReason: 'goodwill' })), { field: 'noChargeReason', message: 'A reason for no charge goes only with an amount of 0' });
      const job = await addJob(parent._id, { amount: '0', noChargeReason: 'goodwill' });
      assert.equal(job.status, 201, JSON.stringify(job.body));
      assert.equal(job.body.data.negotiation[0].noChargeReason, 'goodwill');
    });

    test('it goes for approval without parts and labour, is approved at AED 0, and closes when the bus is back', async () => {
      const ticket = await raise();
      ok(await estimate(ticket._id, users.vendor1.token, { amount: '0', noChargeReason: 'warranty' }));
      const escalated = await put(ticket._id, 'escalate', users.creator.token);
      assert.equal(escalated.status, 200, JSON.stringify(escalated.body));
      const approved = ok(await put(ticket._id, 'approve', users.supervisor.token));
      assert.equal(approved.approvedEstimate, 0);
      assert.equal(approved.noChargeReason, 'warranty');

      ok(await put(ticket._id, 'acknowledge', users.vendor1.token, { daysToComplete: 3 }));
      const back = await fromAcknowledgedToReturned(users, ticket._id, users.vendor1);
      assert.equal(back.status, 'completed');
      const [returned, closed] = back.history.slice(-2);
      assert.equal(returned.status, 'vehicleReturned');
      assert.equal(closed.status, 'completed');
      assert.equal(closed.note, 'No charge');
      assert.equal(back.vehicle.returnedKm, 5200);

      assert.equal((await submitInvoice(ticket._id, users.vendor1)).status, 409, 'there is nothing to invoice');
      assert.equal((await api('GET', `/tickets/${ticket._id}`, { token: users.purchasing.token })).status, 404);
      for (const path of ['/tickets?limit=200', '/tickets?status=completed&limit=200', '/tickets/completed?limit=200']) {
        const list = await api('GET', path, { token: users.purchasing.token });
        assert.ok(!list.body.data.some((t) => t._id === ticket._id), `purchasing never sees it: ${path}`);
      }
    });

    test('parts and labour saved on it are still checked, at a discount of their full value', async () => {
      const ticket = await raise();
      ok(await estimate(ticket._id, users.vendor1.token, { amount: '0', noChargeReason: 'freeOfCharge' }));
      await fillBreakdown(users, ticket._id, 300);
      const escalated = ok(await put(ticket._id, 'escalate', users.creator.token));
      assert.equal(escalated.breakdown.estimateAmount, 0);
      assert.equal(escalated.breakdown.discount, 300);
    });

    test('a no-charge parent closes when the bus is back while its paid job goes on to the invoice', async () => {
      const parent = await atTheWorkshop(await noChargeAcknowledged('warranty'));
      const paid = await approveJob(ok(await addJob(parent._id)));
      const free = await approveJob(ok(await addJob(parent._id, { amount: '0', noChargeReason: 'goodwill' })), 0);
      assert.equal(free.approvedEstimate, 0);
      assert.equal(free.noChargeReason, 'goodwill');

      ok(await put(parent._id, 'work/ready', users.vendor1.token));
      ok(await put(parent._id, 'vehicle/release', users.vendor1.token));
      const back = await put(parent._id, 'vehicle/returned', users.creator.token, { km: 5300 });
      assert.equal(back.body.message, 'Bus is back. There is no charge, so the VSR is closed.');
      assert.equal((await read(parent._id)).status, 'completed');
      assert.equal((await read(free._id)).status, 'completed');
      assert.equal((await read(paid._id)).status, 'vehicleReturned');
      assert.equal((await submitInvoice(paid._id, users.vendor1, { amount: '400' })).status, 201);
    });
  });

  describe('B. work at the depot', () => {
    test('a VSR is done at the vendor workshop unless the creator says otherwise', async () => {
      assert.equal((await raise()).location, 'vendorWorkshop');
      assert.equal((await raise({ location: 'thirdParty' })).location, 'thirdParty');
      const wrong = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000, location: 'garage' } });
      assert.deepEqual(firstError(wrong), { field: 'location', message: 'Choose where the work is done' });
    });

    test('the bus is never sent, received or released: the vendor starts and finishes, the creator confirms the work is done', async () => {
      const own = await ownBus('DEPOT');
      const ticket = await toAcknowledged(users, await raise({ serviceType: 'tyre', repairCategory: undefined, location: 'depot' }, own), users.vendor1);
      const id = ticket._id;

      const sent = await put(id, 'vehicle/sent', users.creator.token);
      assert.equal(sent.status, 409);
      assert.equal(sent.body.message, 'This job is done at the depot, so the bus is not sent.');

      assert.equal((await put(id, 'work/start', users.creator.token, { km: 5010 })).status, 403);
      assert.deepEqual(firstError(await put(id, 'work/start', users.vendor1.token, {})), { field: 'km', message: 'Enter the reading as a whole number of kilometres' });
      assert.equal(firstError(await put(id, 'work/start', users.vendor1.token, { km: 4000 })).field, 'km', 'below the reading it was raised at');
      const started = ok(await put(id, 'work/start', users.vendor1.token, { km: 5010, date: '2026-10-05' }));
      assert.equal(started.status, 'workInProgress');
      assert.equal(started.vehicle.receivedAt.slice(0, 10), '2026-10-05');
      assert.equal(started.vehicle.workStartedAt.slice(0, 10), '2026-10-05');
      assert.equal(started.vehicle.receivedKm, 5010);
      assert.equal(started.vehicle.sentAt, undefined);
      assert.equal(started.history.at(-1).km, 5010);

      assert.equal((await put(id, 'vehicle/returned', users.creator.token, { km: 5020 })).status, 409, 'the work is not ready yet');
      ok(await put(id, 'work/ready', users.vendor1.token, { date: '2026-10-06' }));
      const release = await put(id, 'vehicle/release', users.vendor1.token);
      assert.equal(release.status, 409);
      assert.equal(release.body.message, 'This job is done at the depot. The service creator confirms when the work is done.');

      assert.equal((await put(id, 'vehicle/returned', users.vendor1.token, { km: 5020 })).status, 403);
      const done = await put(id, 'vehicle/returned', users.creator.token, { km: 5020, date: '2026-10-06', replacedPartsReceived: true });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body.data.status, 'vehicleReturned');
      assert.equal(done.body.data.vehicle.returnedKm, 5020);
      assert.equal(done.body.data.vehicle.returnedAt.slice(0, 10), '2026-10-06');
      assert.deepEqual(
        done.body.data.history.map((h) => h.status).filter((s) => s.startsWith('vehicle') || ['workInProgress', 'readyForDelivery'].includes(s)),
        ['workInProgress', 'readyForDelivery', 'vehicleReturned']
      );

      const busNow = (await api('GET', `/buses/${own._id}`, { token: users.creator.token })).body.data;
      assert.equal(busNow.intervals.tyre.lastKm, 5020, 'the tyre change counts from here');
      const sheet = await api('GET', '/sheets/readings?month=2026-10', { token: users.creator.token });
      assert.equal(sheet.body.data.buses.find((b) => b._id === own._id).readings['2026-10-06'], 5020);
      assert.equal((await submitInvoice(id, users.vendor1)).status, 201, 'a paid depot job is invoiced as usual');
    });

    test('each step says what comes next on a depot job', async () => {
      const ticket = await raise({ location: 'depot' });
      ok(await estimate(ticket._id, users.vendor1.token, { amount: '500' }));
      await fillBreakdown(users, ticket._id, 500);
      ok(await put(ticket._id, 'escalate', users.creator.token));
      ok(await put(ticket._id, 'approve', users.supervisor.token));
      const acknowledged = await put(ticket._id, 'acknowledge', users.vendor1.token, { daysToComplete: 3 });
      assert.equal(acknowledged.body.message, 'VSR acknowledged. Start the work at the depot and enter the reading.');
      assert.equal((await put(ticket._id, 'work/start', users.vendor1.token, { km: 5010 })).body.message, 'Work in progress');
      assert.equal((await put(ticket._id, 'work/ready', users.vendor1.token)).body.message, 'Work is ready. The service creator confirms when it is done.');
      assert.equal((await put(ticket._id, 'vehicle/returned', users.creator.token, { km: 5020 })).body.message, 'Work done. The vendor can now send the invoice.');

      const other = await raise();
      ok(await estimate(other._id, users.vendor1.token, { amount: '500' }));
      await fillBreakdown(users, other._id, 500);
      ok(await put(other._id, 'escalate', users.creator.token));
      ok(await put(other._id, 'approve', users.supervisor.token));
      assert.equal((await put(other._id, 'acknowledge', users.vendor1.token, { daysToComplete: 3 })).body.message, 'VSR acknowledged. The service creator sends the bus.', 'a trip reads as before');
    });

    test('an additional job waits as it would for a release, then moves with its parent', async () => {
      const parent = await depotAtWork();
      const job = ok(await addJob(parent._id));
      assert.equal(job.location, 'depot', 'it takes its parent\'s location');
      assert.equal(job.currentReading, 5050);
      ok(await put(parent._id, 'work/ready', users.vendor1.token, { date: '2026-10-06' }));

      const blocked = await put(parent._id, 'vehicle/returned', users.creator.token, { km: 5100 });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, 'NOT_READY');
      assert.equal(blocked.body.message, `${job.vsrNumber} is still waiting. It has to be approved or declined before the bus can leave.`);

      const approved = await approveJob(job);
      assert.equal(approved.status, 'vehicleReceived');
      assert.equal(approved.vehicle.receivedAt.slice(0, 10), '2026-10-05');
      assert.equal(approved.vehicle.receivedKm, 5050);

      ok(await put(parent._id, 'vehicle/returned', users.creator.token, { km: 5100 }));
      assert.equal((await read(parent._id)).status, 'vehicleReturned');
      const child = await read(job._id);
      assert.equal(child.status, 'vehicleReturned');
      assert.equal(child.vehicle.returnedKm, 5100);
    });

    test('a no-charge depot job closes on the work done step', async () => {
      const ticket = await noChargeAcknowledged('insurance', { location: 'depot' });
      ok(await put(ticket._id, 'work/start', users.vendor1.token, { km: 5010 }));
      ok(await put(ticket._id, 'work/ready', users.vendor1.token));
      const done = await put(ticket._id, 'vehicle/returned', users.creator.token, { km: 5020 });
      assert.equal(done.body.message, 'Work done. There is no charge, so the VSR is closed.');
      assert.equal(done.body.data.status, 'completed');
      assert.equal(done.body.data.history.at(-1).note, 'No charge');
    });

    test('the location changes only through the correction of a returned VSR', async () => {
      const ticket = await raise({ location: 'depot' });
      ok(await estimate(ticket._id, users.vendor1.token, { amount: '500' }));
      await fillBreakdown(users, ticket._id, 500);
      ok(await put(ticket._id, 'escalate', users.creator.token));
      ok(await put(ticket._id, 'return', users.supervisor.token, { reason: 'Do it at the workshop' }));
      const form = { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000 };
      assert.equal(ok(await put(ticket._id, 'details', users.creator.token, form)).location, 'depot', 'left out, it stays as it was');
      assert.equal(ok(await put(ticket._id, 'details', users.creator.token, { ...form, location: 'vendorWorkshop' })).location, 'vendorWorkshop');
    });
  });

  describe('C. accident details, for our own records', () => {
    test('an accident needs severity and fault; other VSRs carry none', async () => {
      const post = (body) => api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'accident', currentReading: 5000, ...body } });
      assert.deepEqual(firstError(await post({})), { field: 'accident.severity', message: 'Choose how serious the accident was' });
      assert.deepEqual(firstError(await post({ accident: { severity: 'minor' } })), { field: 'accident.fault', message: 'Choose who was at fault' });
      assert.equal(firstError(await post({ accident: { severity: 'huge', fault: 'otherParty' } })).field, 'accident.severity');

      const raised = await raise(ACCIDENT);
      assert.equal(raised.accident.severity, 'minor');
      assert.equal(raised.accident.fault, 'otherParty');
      assert.equal(raised.accident.updatedBy._id, users.creator.id);
      assert.ok(raised.accident.updatedAt);

      assert.equal((await raise({ accident: { severity: 'minor', fault: 'otherParty' } })).accident, undefined, 'an engine repair has no accident');
    });

    test('correcting an accident into a repair clears the details, and the other way needs them', async () => {
      const ticket = await raise(ACCIDENT);
      ok(await estimate(ticket._id, users.vendor1.token, { amount: '500' }));
      await fillBreakdown(users, ticket._id, 500);
      ok(await put(ticket._id, 'escalate', users.creator.token));
      ok(await put(ticket._id, 'return', users.supervisor.token, { reason: 'Not an accident' }));
      const form = { busId: bus._id, currentReading: 5000 };
      assert.equal(firstError(await put(ticket._id, 'details', users.creator.token, { ...form, serviceType: 'accident' })).field, 'accident.severity');
      const corrected = ok(await put(ticket._id, 'details', users.creator.token, { ...form, serviceType: 'repair', repairCategory: 'BODY', accident: { severity: 'major', fault: 'ourDriver' } }));
      assert.equal(corrected.accident, undefined);
      assert.equal((await read(ticket._id)).accident, undefined);
    });

    test('the creator and the supervisor update them at any stage; nobody else can', async () => {
      const ticket = await raise(ACCIDENT);
      await toAcknowledged(users, ticket, users.vendor1);
      await fromAcknowledgedToReturned(users, ticket._id, users.vendor1);

      const byVendor = await put(ticket._id, 'accident', users.vendor1.token, { severity: 'major', fault: 'ourDriver' });
      assert.equal(byVendor.status, 403);
      assert.equal((await put(ticket._id, 'accident', users.purchasing.token, { severity: 'major', fault: 'ourDriver' })).status, 403);
      assert.deepEqual(firstError(await put(ticket._id, 'accident', users.supervisor.token, { severity: 'huge', fault: 'ourDriver' })), { field: 'severity', message: 'Choose how serious the accident was' });
      assert.deepEqual(firstError(await put(ticket._id, 'accident', users.supervisor.token, { severity: 'major' })), { field: 'fault', message: 'Choose who was at fault' });

      const updated = await put(ticket._id, 'accident', users.supervisor.token, { severity: 'major', fault: 'ourDriver' });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.message, 'Accident details saved');
      assert.equal(updated.body.data.status, 'vehicleReturned', 'the stage stays as it was');
      assert.deepEqual([updated.body.data.accident.severity, updated.body.data.accident.fault], ['major', 'ourDriver']);
      assert.equal(updated.body.data.accident.updatedBy._id, users.supervisor.id);
      assert.equal(ok(await put(ticket._id, 'accident', users.creator.token, { severity: 'medium', fault: 'unknown' })).accident.updatedBy._id, users.creator.id);

      const engine = await raise();
      const refused = await put(engine._id, 'accident', users.creator.token, { severity: 'major', fault: 'ourDriver' });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.message, 'Only an accident has accident details.');
    });

    test('vendors never receive them, and the details a vendor sends with a job are ignored', async () => {
      const seen = [];
      const asVendor = (res) => {
        seen.push(res.body);
        return res;
      };
      const ticket = await raise(ACCIDENT);
      asVendor(await api('GET', `/tickets/${ticket._id}`, { token: users.vendor1.token }));
      asVendor(await api('GET', '/tickets?limit=200', { token: users.vendor1.token }));
      asVendor(await estimate(ticket._id, users.vendor1.token, { amount: '0', noChargeReason: 'insurance' }));
      ok(await put(ticket._id, 'escalate', users.creator.token));
      ok(await put(ticket._id, 'approve', users.supervisor.token));
      asVendor(await put(ticket._id, 'acknowledge', users.vendor1.token, { daysToComplete: 3 }));
      await fromAcknowledgedToReturned(users, ticket._id, users.vendor1);
      const completed = asVendor(await api('GET', '/tickets/completed?limit=200', { token: users.vendor1.token }));
      assert.ok(completed.body.data.some((t) => t._id === ticket._id), 'the closed accident is in the vendor\'s list');
      // The vendor knows the job is an accident (its service type), never the details.
      for (const body of seen) assert.ok(!JSON.stringify(body).includes('otherParty') && !JSON.stringify(body).includes('"accident":'), JSON.stringify(body).slice(0, 300));
      assert.equal((await read(ticket._id)).accident.fault, 'otherParty', 'staff still see them');

      const parent = await atTheWorkshop(await toAcknowledged(users, await raise(), users.vendor1));
      // An additional job is never an accident (2026-11-11), and what a vendor sends for one is not read.
      assert.equal((await multipart(`/tickets/${parent._id}/additional`, users.vendor1.token, { ...JOB, serviceType: 'accident' })).status, 400);
      const job = ok(await multipart(`/tickets/${parent._id}/additional`, users.vendor1.token, { ...JOB, 'accident[severity]': 'major', 'accident[fault]': 'ourDriver' }));
      assert.equal((await read(job._id)).accident, undefined, 'a vendor\'s job has none');
    });
  });

  // Brake pads became a repair category on 2026-11-11, still measured against the bus's interval.
  const PADS = { serviceType: 'repair', repairCategory: 'BRAKE PADS' };

  describe('D. brake pads', () => {
    test('a bus needs a brake-pad interval in whole km above 0', async () => {
      const { brakePads, ...withoutBrakePads } = busBody('x', 'x').intervals;
      assert.equal(brakePads.everyKm, 40000);
      assert.deepEqual(firstError(await postBus({ intervals: withoutBrakePads })), { field: 'intervals.brakePads.everyKm', message: 'Enter the interval in km, above 0' });
      assert.deepEqual(firstError(await postBus({ intervals: { ...withoutBrakePads, brakePads: { everyKm: 0 } } })), { field: 'intervals.brakePads.everyKm', message: 'Enter the interval in km, above 0' });
      assert.deepEqual(firstError(await postBus({ intervals: { ...withoutBrakePads, brakePads: { everyKm: 40000.5 } } })), { field: 'intervals.brakePads.everyKm', message: 'Enter a whole number' });

      const added = await postBus({ intervals: { ...withoutBrakePads, brakePads: { everyKm: 40000 } } });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      assert.deepEqual(added.body.data.intervals.brakePads, { everyKm: 40000, lastKm: 0 });

      const edited = await api('PUT', `/buses/${added.body.data._id}`, { token: users.creator.token, body: busBody(`E${counter}`, users.vendor1.id, { intervals: withoutBrakePads }) });
      assert.equal(firstError(edited).field, 'intervals.brakePads.everyKm', 'an edit needs it too');
    });

    test('brake pads are priced by estimate, count as a repair on the daily sheet and the LPO, and move their interval on return', async () => {
      const own = await ownBus('PADS', { rates: { oil: 0.5 }, intervals: { ...busBody('x', 'x').intervals, brakePads: { everyKm: 40000, lastKm: 1000 } } });
      const raised = await raise({ ...PADS, currentReading: 39000 }, own);
      assert.equal(raised.status, 'sentToVendor');
      assert.equal(raised.agreedPrice, undefined);
      assert.deepEqual(raised.intervalUsage, { unit: 'km', interval: 40000, actual: 38000, left: 2000, delayed: 0 });

      const sheet = (await api('GET', '/sheets/status', { token: users.supervisor.token })).body.data;
      assert.equal(sheet.buses.find((b) => b._id === own._id).cells[sheet.days.indexOf(sheet.today)].status, 'repair');

      const status = (await api('GET', `/buses/${own._id}`, { token: users.creator.token })).body.data.intervalStatus;
      assert.deepEqual(status.brakePads, { unit: 'km', interval: 40000, used: 38000, left: 2000, delayed: 0, state: 'ok' });

      await toAcknowledged(users, raised, users.vendor1);
      await fromAcknowledgedToReturned(users, raised._id, users.vendor1, { km: 39500 });
      assert.equal((await api('GET', `/buses/${own._id}`, { token: users.creator.token })).body.data.intervals.brakePads.lastKm, 39500);
      ok(await submitInvoice(raised._id, users.vendor1));
      ok(await put(raised._id, 'invoice/accept', users.supervisor.token));
      const line = ok(await api('GET', `/lpos/for-vsr?busId=${own._id}&serviceType=repair`, { token: users.creator.token }));
      assert.equal(line.kind, 'repairMaintenance', 'brake pads come off the repair and maintenance line');

      const next = await raise({ ...PADS, currentReading: 39600 }, own);
      assert.equal(next.intervalUsage.actual, 100);
    });

    test('purchasing counts brake pads with the repairs', async () => {
      const own = await ownBus('PADQ');
      await raise(PADS, own);
      assert.equal((await api('GET', `/reports/query?type=brakePads`, { token: users.purchasing.token })).status, 400, 'no longer a kind of work of its own');
      const res = await api('GET', `/reports/query?type=repair&busId=${own._id}&year=${new Date().getUTCFullYear()}`, { token: users.purchasing.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.total.count, 1);
    });

    test('a vendor can raise brake pads as an additional job', async () => {
      const parent = await atTheWorkshop(await toAcknowledged(users, await raise(), users.vendor1));
      const job = await addJob(parent._id, PADS);
      assert.equal(job.status, 201, JSON.stringify(job.body));
      assert.deepEqual([job.body.data.serviceType, job.body.data.repairCategory], ['repair', 'BRAKE PADS']);
    });

    test('a bus without the interval refuses brake pads and leaves them out of its status', async () => {
      const old = await busWithoutBrakePads('NOPADS');
      const refused = await api('POST', '/tickets', { token: users.creator.token, body: { busId: old._id, ...PADS, currentReading: 5000 } });
      assert.equal(refused.status, 400);
      assert.deepEqual(firstError(refused), { field: 'repairCategory', message: 'This bus has no brake-pad interval. Add it on the bus first.' });

      const detail = await api('GET', `/buses/${old._id}`, { token: users.creator.token });
      assert.equal(detail.status, 200);
      assert.ok(!('brakePads' in detail.body.data.intervalStatus));
      assert.equal(detail.body.data.intervalStatus.oil.state, 'ok');
      assert.equal((await api('GET', '/buses', { token: users.supervisor.token })).status, 200);

      const parent = await atTheWorkshop(await toAcknowledged(users, await raise({}, old), users.vendor1));
      assert.deepEqual(firstError(await addJob(parent._id, PADS)), { field: 'repairCategory', message: 'This bus has no brake-pad interval. Add it on the bus first.' });
    });
  });

  describe('E. buses without a chassis number or a registration yet', () => {
    test('both are optional and left out when empty; an expiry goes only with a registration number', async () => {
      const bare = await postBus({ chassisNumber: '', registrationNumber: '', registrationExpiry: undefined });
      assert.equal(bare.status, 201, JSON.stringify(bare.body));
      for (const field of ['chassisNumber', 'registrationNumber', 'registrationExpiry']) assert.ok(!(field in bare.body.data), `${field} is left out`);
      const another = await postBus({ chassisNumber: null, registrationNumber: '   ', registrationExpiry: null });
      assert.equal(another.status, 201, 'two buses without them do not clash');
      await withDatabase(process.env.MONGO_URI, async (db) => {
        const stored = await db.collection('buses').findOne({ _id: new mongoose.Types.ObjectId(another.body.data._id) });
        assert.ok(!('chassisNumber' in stored) && !('registrationNumber' in stored), 'stored absent, never "" or null');
      });

      assert.deepEqual(firstError(await postBus({ registrationExpiry: undefined })), { field: 'registrationExpiry', message: 'Enter the registration expiry date' });
      assert.deepEqual(firstError(await postBus({ registrationNumber: '', registrationExpiry: '2030-06-30' })), { field: 'registrationExpiry', message: 'An expiry date goes only with a registration number' });

      const first = await createBus(users, `CH${(counter += 1)}`, users.vendor1.id);
      const clash = await postBus({ chassisNumber: first.chassisNumber });
      assert.equal(clash.status, 409);
      assert.deepEqual(clash.body.errors.map((e) => e.field), ['chassisNumber']);
    });

    test('an edit can clear them, which frees the numbers', async () => {
      const own = await ownBus('CLEAR');
      const body = busBody('CLEAR', users.vendor1.id, { fleetNumber: own.fleetNumber, chassisNumber: '', registrationNumber: null, registrationExpiry: undefined, rates: undefined });
      const saved = await api('PUT', `/buses/${own._id}`, { token: users.creator.token, body });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const after = (await api('GET', `/buses/${own._id}`, { token: users.creator.token })).body.data;
      for (const field of ['chassisNumber', 'registrationNumber', 'registrationExpiry']) assert.ok(!(field in after), `${field} is cleared`);
      assert.equal((await postBus({ chassisNumber: own.chassisNumber, registrationNumber: own.registrationNumber })).status, 201, 'the old numbers are free');
    });

    test('a bus not registered yet gets no expiry alert, and its VSRs reach the vendor and the GRN Excel', async () => {
      const unregistered = await ownBus('NOREG', { registrationNumber: '', registrationExpiry: undefined });
      const notices = await api('GET', '/notifications', { token: users.creator.token });
      assert.equal(notices.status, 200);
      assert.ok(!notices.body.data.some((n) => n.type === 'registrationExpiring' && n.params.fleetNumber === unregistered.fleetNumber));

      const ticket = await raise(PADS, unregistered);
      const seen = await api('GET', `/tickets/${ticket._id}`, { token: users.vendor1.token });
      assert.equal(seen.body.data.busId.fleetNumber, unregistered.fleetNumber);
      assert.equal(seen.body.data.busId.registrationNumber, undefined);

      await toForwarded(users, ticket, users.vendor1);
      const res = await fetch(`${BASE}/grns/export?ticketIds=${ticket._id}`, { headers: { Authorization: `Bearer ${users.purchasing.token}` } });
      assert.equal(res.status, 200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.from(await res.arrayBuffer()));
      const sheet = book.worksheets[0];
      const header = sheet.getRow(1).values;
      const row = sheet.getRow(2).values;
      assert.equal(header[2], 'Side number');
      assert.equal(row[2], unregistered.fleetNumber);
      assert.equal(row[3], undefined, 'no registration to show');
      assert.equal(row[6], 'Repair: Brake pads');
    });

    test('the API replaces the old unique indexes on chassis and registration when it starts', async () => {
      const uri = process.env.MONGO_URI.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, query = '') => `/${db}_indexes${query}`);
      await withDatabase(uri, async (db) => {
        await db.dropDatabase();
        const buses = db.collection('buses');
        // What the live database was built with before 2026-11-06.
        await buses.createIndex({ chassisNumber: 1 }, { unique: true, name: 'chassisNumber_1' });
        await buses.createIndex({ registrationNumber: 1 }, { unique: true, name: 'registrationNumber_1' });

        const port = await new Promise((resolve) => {
          const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port: free } = probe.address();
            probe.close(() => resolve(free));
          });
        });
        const backend = join(dirname(fileURLToPath(import.meta.url)), '..');
        const server = spawn(process.execPath, ['server.js'], { cwd: backend, env: { ...process.env, MONGO_URI: uri, PORT: String(port), NODE_ENV: 'test' } });
        try {
          await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error(`the API did not start: ${output}`)), 30000);
            const listen = (chunk) => {
              output += chunk;
              if (output.includes('listening on port')) {
                clearTimeout(timer);
                resolve();
              }
            };
            server.stdout.on('data', listen);
            server.stderr.on('data', listen);
            server.on('exit', (code) => reject(new Error(`the API stopped (${code}): ${output}`)));
          });
          const indexes = await buses.indexes();
          for (const name of ['chassisNumber_1', 'registrationNumber_1']) {
            const index = indexes.find((i) => i.name === name);
            assert.ok(index?.unique && index.sparse, `${name}: ${JSON.stringify(index)}`);
          }
          await buses.insertMany([{ fleetNumber: `IDX-${run}-1` }, { fleetNumber: `IDX-${run}-2` }]);
        } finally {
          server.kill();
          await db.dropDatabase();
        }
      });
    });
  });

  describe('F. Side number', () => {
    test('the bus form calls it the Side number', async () => {
      assert.deepEqual(firstError(await postBus({ fleetNumber: '' })), { field: 'fleetNumber', message: 'Side number is required' });
    });
  });

  describe('Dashboards', () => {
    const dashboard = async (who) => ok(await api('GET', '/users/dashboard', { token: users[who].token }));

    test("a depot job is the vendor's to start and the creator's to confirm", async () => {
      const before = { vendor: (await dashboard('vendor1')).actionRequired, creator: (await dashboard('creator')).actionRequired };
      const turns = async () => ({ vendor: (await dashboard('vendor1')).actionRequired - before.vendor, creator: (await dashboard('creator')).actionRequired - before.creator });

      const ticket = await toAcknowledged(users, await raise({ location: 'depot' }), users.vendor1);
      assert.deepEqual(await turns(), { vendor: 1, creator: 0 }, 'acknowledged at the depot: the vendor starts the work, nobody sends the bus');
      ok(await put(ticket._id, 'work/start', users.vendor1.token, { km: ticket.currentReading + 10 }));
      assert.deepEqual(await turns(), { vendor: 1, creator: 0 });
      ok(await put(ticket._id, 'work/ready', users.vendor1.token));
      assert.deepEqual(await turns(), { vendor: 0, creator: 1 }, 'ready at the depot: the creator confirms, the vendor releases nothing');
    });

    test("purchasing's figures leave out a job that closed with no charge", async () => {
      const before = (await dashboard('purchasing')).tickets.completed;
      const ticket = await noChargeAcknowledged('warranty', { location: 'depot' });
      ok(await put(ticket._id, 'work/start', users.vendor1.token, { km: ticket.currentReading + 10 }));
      ok(await put(ticket._id, 'work/ready', users.vendor1.token));
      ok(await put(ticket._id, 'vehicle/returned', users.creator.token, { km: ticket.currentReading + 20 }));
      assert.equal((await read(ticket._id)).status, 'completed');
      assert.equal((await dashboard('purchasing')).tickets.completed, before);
    });
  });
});
