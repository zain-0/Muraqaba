/**
 * Item 11: while fixing a bus the vendor can raise an additional job. It is linked (VSR-0001b),
 * separate in everything, approved first, then sits at Vehicle received and leaves with its parent.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, estimate, fileOf, fillBreakdown, multipart, signInEveryone, submitInvoice, toAcknowledged } from './helpers.js';

let users;
let bus;
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });
const read = async (id, token = users.creator.token) => (await api('GET', `/tickets/${id}`, { token })).body.data;
const JOB = { description: 'Found a cracked exhaust while fixing the engine.', serviceType: 'repair', repairCategory: 'MECHANICAL', amount: '400', quotationNumber: 'Q-EXTRA', daysToComplete: '2' };
const addJob = (parentId, fields = JOB, token = users.vendor1.token, files = []) => multipart(`/tickets/${parentId}/additional`, token, fields, files);

/** A parent VSR with the bus at the vendor, work under way. */
const parentAtWork = async () => {
  const raised = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000 } });
  const { _id: id } = await toAcknowledged(users, raised.body.data, users.vendor1);
  await put(id, 'vehicle/sent', users.creator.token, { date: '2026-10-04' });
  await put(id, 'vehicle/received', users.vendor1.token, { km: 5050, date: '2026-10-05' });
  return (await put(id, 'work/start', users.vendor1.token, { date: '2026-10-06' })).body.data;
};
/** An additional job that went through the creator and the supervisor. */
const approvedJob = async (parent) => {
  const job = (await addJob(parent._id)).body.data;
  await fillBreakdown(users, job._id, 400);
  await put(job._id, 'escalate', users.creator.token);
  return (await put(job._id, 'approve', users.supervisor.token)).body.data;
};

describe('additional jobs', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'ADD', users.vendor1.id, { rates: undefined });
  });

  test('the vendor raises it during the work and it starts with its estimate, linked and numbered', async () => {
    const parent = await parentAtWork();
    const res = await addJob(parent._id, JOB, users.vendor1.token, [fileOf('extra.pdf')]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const job = res.body.data;
    assert.equal(job.vsrNumber, `${parent.vsrNumber}b`);
    assert.equal(job.status, 'estimateSubmitted');
    assert.equal(job.parentTicket, parent._id);
    assert.equal(job.busId._id, bus._id);
    assert.equal(job.vendorId._id, users.vendor1.id);
    assert.equal(job.description, JOB.description);
    assert.equal(job.currentReading, 5050, 'the reading from when the vendor received the bus');
    assert.equal(job.negotiation[0].amount, 400);
    assert.equal(job.negotiation[0].quotationNumber, 'Q-EXTRA');
    assert.equal(job.negotiation[0].attachments[0].name, 'extra.pdf');
    assert.equal(job.daysToComplete, 2);
    assert.equal(job.createdBy._id, users.vendor1.id);

    const second = await addJob(parent._id);
    assert.equal(second.body.data.vsrNumber, `${parent.vsrNumber}c`);

    const detail = await read(parent._id);
    assert.deepEqual(detail.linkedTickets.map((t) => t.vsrNumber), [`${parent.vsrNumber}b`, `${parent.vsrNumber}c`]);
    const childDetail = await read(job._id);
    assert.equal(childDetail.linkedTickets[0].vsrNumber, parent.vsrNumber, 'the job links back to its parent');
    assert.equal(childDetail.linkedTickets[1].vsrNumber, `${parent.vsrNumber}c`);
  });

  test('only the owning vendor, only while the bus is at the workshop, with a full estimate', async () => {
    const parent = await parentAtWork();
    assert.equal((await addJob(parent._id, JOB, users.vendor2.token)).status, 403);
    assert.equal((await addJob(parent._id, JOB, users.creator.token)).status, 403);
    for (const [field, change] of [
      ['amount', { amount: '0' }],
      ['quotationNumber', { quotationNumber: '' }],
      ['daysToComplete', { daysToComplete: '0' }],
      ['serviceType', { serviceType: 'oil' }],
      ['repairCategory', { repairCategory: 'MAGIC' }],
      ['description', { description: 'short' }],
    ]) {
      const res = await addJob(parent._id, { ...JOB, ...change });
      assert.equal(res.status, 400, field);
      assert.equal(res.body.errors[0].field, field);
    }

    const raised = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000 } });
    assert.equal((await addJob(raised.body.data._id)).status, 409, 'the bus is not at the vendor');

    const job = (await addJob(parent._id)).body.data;
    assert.equal((await addJob(job._id)).status, 409, 'an additional job takes no job of its own');
  });

  test('it needs the same approval, then sits at Vehicle received without Sent or Received steps', async () => {
    const parent = await parentAtWork();
    const job = (await addJob(parent._id)).body.data;
    assert.equal((await put(job._id, 'escalate', users.creator.token)).status, 409, 'parts and labour first');
    await fillBreakdown(users, job._id, 400);
    const sent = await put(job._id, 'escalate', users.creator.token);
    assert.equal(sent.body.data.status, 'pending');

    const approved = await put(job._id, 'approve', users.supervisor.token);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'vehicleReceived');
    assert.equal(approved.body.data.approvedEstimate, 400);
    assert.equal(approved.body.data.vehicle.receivedKm, 5050);
    assert.equal(approved.body.data.vehicle.receivedAt.slice(0, 10), '2026-10-05');
    assert.deepEqual(approved.body.data.history.slice(-2).map((h) => h.status), ['approved', 'vehicleReceived']);

    const started = await put(job._id, 'work/start', users.vendor1.token);
    assert.equal(started.body.data.status, 'workInProgress');
  });

  test('a job still waiting blocks the release, and the supervisor can decline it', async () => {
    const parent = await parentAtWork();
    await put(parent._id, 'work/ready', users.vendor1.token);
    const job = (await addJob(parent._id)).body.data;

    const blocked = await put(parent._id, 'vehicle/release', users.vendor1.token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'NOT_READY');
    assert.match(blocked.body.message, new RegExp(job.vsrNumber));
    assert.equal((await read(parent._id)).status, 'readyForDelivery');

    await fillBreakdown(users, job._id, 400);
    await put(job._id, 'escalate', users.creator.token);
    assert.equal((await put(job._id, 'decline', users.creator.token, { reason: 'No' })).status, 403);
    assert.equal((await put(job._id, 'decline', users.supervisor.token, { reason: ' ' })).status, 400);
    const declined = await put(job._id, 'decline', users.supervisor.token, { reason: 'Not needed now' });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.data.status, 'declined');
    assert.equal(declined.body.data.declineReason, 'Not needed now');

    const released = await put(parent._id, 'vehicle/release', users.vendor1.token);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal((await read(job._id)).status, 'declined', 'a declined job stays declined');

    const plain = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000 } });
    await estimate(plain.body.data._id, users.vendor1.token, { amount: '100' });
    await fillBreakdown(users, plain.body.data._id, 100);
    await put(plain.body.data._id, 'escalate', users.creator.token);
    assert.equal((await put(plain.body.data._id, 'decline', users.supervisor.token, { reason: 'No' })).status, 409, 'an ordinary VSR is returned, not declined');
  });

  test('releasing either one releases both, and the bus coming back updates both', async () => {
    const parent = await parentAtWork();
    const job = await approvedJob(parent);
    assert.equal(job.status, 'vehicleReceived');
    await put(parent._id, 'work/ready', users.vendor1.token, { date: '2026-10-08' });

    const released = await put(parent._id, 'vehicle/release', users.vendor1.token, { date: '2026-10-09' });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    const child = await read(job._id);
    assert.equal(child.status, 'vehicleReleased');
    assert.equal(child.vehicle.releasedAt.slice(0, 10), '2026-10-09');

    assert.equal((await put(job._id, 'vehicle/returned', users.creator.token, { km: 5300, replacedPartsReceived: true })).status, 200);
    const [backParent, backChild] = [await read(parent._id), await read(job._id)];
    assert.equal(backParent.status, 'vehicleReturned');
    assert.equal(backChild.status, 'vehicleReturned');
    assert.equal(backParent.vehicle.returnedKm, 5300);
    assert.equal(backParent.vehicle.replacedPartsReceived, true);

    const fromChild = await parentAtWork();
    const other = await approvedJob(fromChild);
    await put(other._id, 'work/start', users.vendor1.token);
    await put(other._id, 'work/ready', users.vendor1.token);
    const childFirst = await put(other._id, 'vehicle/release', users.vendor1.token);
    assert.equal(childFirst.status, 200, JSON.stringify(childFirst.body));
    assert.equal((await read(fromChild._id)).status, 'vehicleReleased', 'it works from the job as well');
  });

  test('invoice, GRN and everything after the bus is back stay separate', async () => {
    const parent = await parentAtWork();
    const job = await approvedJob(parent);
    await put(parent._id, 'work/ready', users.vendor1.token);
    await put(parent._id, 'vehicle/release', users.vendor1.token);
    await put(parent._id, 'vehicle/returned', users.creator.token, { km: 5300 });

    assert.equal((await submitInvoice(job._id, users.vendor1, { amount: '400' })).status, 201);
    assert.equal((await read(job._id)).status, 'invoiceSubmitted');
    assert.equal((await read(parent._id)).status, 'vehicleReturned', 'the parent has its own invoice to come');
    assert.equal((await submitInvoice(parent._id, users.vendor1, { amount: '900' })).status, 201);
    const invoices = await api('GET', `/tickets/${job._id}`, { token: users.supervisor.token });
    assert.equal(invoices.body.data.invoices.length, 1);
    assert.equal(invoices.body.data.invoices[0].amount, 400);
  });

  test('a job raised by the vendor does not touch the bus status for the day', async () => {
    const sheet = async () => (await api('GET', '/sheets/status', { token: users.supervisor.token })).body.data;
    const parent = await parentAtWork();
    const before = await sheet();
    const index = before.days.indexOf(before.today);
    await addJob(parent._id, { ...JOB, repairCategory: 'ACCIDENT' });
    const after = await sheet();
    assert.equal(after.buses.find((b) => b._id === bus._id).cells[index].status, before.buses.find((b) => b._id === bus._id).cells[index].status);
  });
});
