/**
 * Owner's testing notes, 2026-11-11: the daily status follows the VSRs, so nobody keeps it by hand.
 * Raising a VSR marks the bus out (unchanged), and the bus is Ready again from the day it is back,
 * unless another open VSR on it still has it out. Scrapping and removed are never overridden, and
 * a change made by hand stays the record for its day.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, fillBreakdown, fromAcknowledgedToReturned, multipart, signInEveryone, testDb, toAcknowledged } from './helpers.js';
import mongoose from 'mongoose';
import { uaeDay } from '../utils/uaeTime.js';

let users;
let db;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => uaeDay(new Date(Date.now() - n * DAY));
const today = () => uaeDay();
const tomorrow = () => uaeDay(new Date(Date.now() + DAY));
const oid = (id) => new mongoose.Types.ObjectId(id);
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });

const newBus = (suffix) => createBus(users, `VS${suffix}`, users.vendor1.id, { rates: undefined });
const raise = async (bus, body = { serviceType: 'repair', repairCategory: 'ENGINE' }) => {
  const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, currentReading: 5000, ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
/** Takes a raised VSR to the bus being back on `date` (a day, or now when left out). */
const bringBack = async (ticket, date) => {
  await toAcknowledged(users, ticket, users.vendor1);
  return fromAcknowledgedToReturned(users, ticket._id, users.vendor1, { km: 5300, date });
};

/** The bus's status on a day, as the status sheet shows it. */
const statusOn = async (bus, day) => {
  const sheet = (await api('GET', `/sheets/status?month=${day.slice(0, 7)}`, { token: users.supervisor.token })).body.data;
  return sheet.buses.find((b) => b._id === bus._id).cells[sheet.days.indexOf(day)];
};
/** Every change stored for the bus, oldest first. */
const changes = async (bus) => (await db.collection('busstatuschanges').find({ bus: oid(bus._id) }).sort({ date: 1 }).toArray()).map(({ date, status, source }) => ({ date, status, source }));
/** Moves the VSR's own status change to an earlier day, as if it had been raised then. */
const raisedOn = async (bus, ticket, day) => {
  await db.collection('busstatuschanges').updateOne({ bus: oid(bus._id), ticket: oid(ticket._id) }, { $set: { date: day } });
  await db.collection('tickets').updateOne({ _id: oid(ticket._id) }, { $set: { createdAt: new Date(`${day}T08:00:00+04:00`) } });
};

describe('the daily status follows the VSRs', () => {
  before(async () => {
    users = await signInEveryone();
    db = await testDb();
  });
  after(async () => {
    await db.close();
  });

  test('the bus is Ready again from the day it comes back, and stays so', async () => {
    const bus = await newBus('BACK');
    const ticket = await raise(bus);
    await raisedOn(bus, ticket, daysAgo(4));
    assert.equal((await statusOn(bus, daysAgo(4))).status, 'repair');

    await bringBack(ticket, daysAgo(2));
    assert.deepEqual(await changes(bus), [
      { date: daysAgo(4), status: 'repair', source: 'vsr' },
      { date: daysAgo(2), status: 'ready', source: 'vsr' },
    ]);
    assert.equal((await statusOn(bus, daysAgo(3))).status, 'repair', 'out until the day it came back');
    assert.deepEqual(await statusOn(bus, daysAgo(2)), { status: 'ready', source: 'vsr' });
    assert.equal((await statusOn(bus, today())).status, 'ready');
  });

  test('raised and back on the same day: the day ends Ready', async () => {
    const bus = await newBus('SAME');
    const ticket = await raise(bus, { serviceType: 'other' });
    assert.equal((await statusOn(bus, today())).status, 'maintenance');
    await bringBack(ticket);
    assert.deepEqual(await statusOn(bus, today()), { status: 'ready', source: 'vsr' });
    assert.deepEqual(await changes(bus), [{ date: today(), status: 'ready', source: 'vsr' }], 'the day keeps one record, the last thing that happened');
  });

  test('a return dated before the VSR was raised counts from the day it was raised', async () => {
    const bus = await newBus('EARLY');
    const ticket = await raise(bus);
    await bringBack(ticket, '2026-10-15');
    assert.deepEqual(await changes(bus), [{ date: today(), status: 'ready', source: 'vsr' }]);
  });

  test('another open VSR on the bus keeps it out, with that VSR\'s status', async () => {
    const bus = await newBus('TWO');
    const repair = await raise(bus);
    const tyre = await raise(bus, { serviceType: 'tyre' });
    assert.equal((await statusOn(bus, today())).status, 'tyreChange', 'the last one raised picks the status');

    await bringBack(tyre);
    assert.deepEqual(await statusOn(bus, today()), { status: 'repair', source: 'vsr' }, 'the repair still has it out');
    await bringBack(repair);
    assert.equal((await statusOn(bus, today())).status, 'ready');
  });

  test('a VSR raised after the day the bus came back does not keep that day out', async () => {
    const bus = await newBus('LATER');
    const first = await raise(bus);
    await raisedOn(bus, first, daysAgo(5));
    await raise(bus, { serviceType: 'battery' });
    await bringBack(first, daysAgo(3));
    assert.deepEqual(await changes(bus), [
      { date: daysAgo(5), status: 'repair', source: 'vsr' },
      { date: daysAgo(3), status: 'ready', source: 'vsr' },
      { date: today(), status: 'batteryChange', source: 'vsr' },
    ]);
  });

  test('additional jobs travel with their parent: the bus is Ready when they come back together', async () => {
    const bus = await newBus('JOB');
    const parent = await raise(bus);
    const { _id: id } = await toAcknowledged(users, parent, users.vendor1);
    await put(id, 'vehicle/sent', users.creator.token);
    await put(id, 'vehicle/received', users.vendor1.token, { km: 5050 });
    await put(id, 'work/start', users.vendor1.token);
    const added = await multipart(`/tickets/${id}/additional`, users.vendor1.token, { description: 'Cracked exhaust found during the work.', serviceType: 'repair', repairCategory: 'ACCIDENT', amount: '400', quotationNumber: 'Q-JOB', daysToComplete: '2' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    await fillBreakdown(users, added.body.data._id, 400);
    await put(added.body.data._id, 'escalate', users.creator.token);
    assert.equal((await put(added.body.data._id, 'approve', users.supervisor.token)).status, 200);

    await put(id, 'work/ready', users.vendor1.token);
    await put(id, 'vehicle/release', users.vendor1.token);
    const back = await put(id, 'vehicle/returned', users.creator.token, { km: 5200, replacedPartsReceived: true });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal((await statusOn(bus, today())).status, 'ready', 'the job is not another VSR keeping the bus out');
  });

  test('scrapping and removed are never overridden', async () => {
    const bus = await newBus('SCRAP');
    const ticket = await raise(bus);
      await db.collection('busstatuschanges').updateOne({ bus: oid(bus._id), date: today() }, { $set: { status: 'scrapping', source: 'scrap' }, $unset: { ticket: 1 } });
    await bringBack(ticket);
    assert.deepEqual(await changes(bus), [{ date: today(), status: 'scrapping', source: 'scrap' }]);
  });

  test('a change made by hand stays the record for its day; the VSR\'s change starts the next day', async () => {
    const bus = await newBus('HAND');
    const ticket = await raise(bus);
    const set = await api('PUT', '/sheets/status', { token: users.creator.token, body: { busId: bus._id, date: today(), status: 'accident' } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.message, 'Status saved. VSRs still change it when the bus goes out or comes back.');
    await bringBack(ticket);
    assert.deepEqual(await statusOn(bus, today()), { status: 'accident', source: 'manual' });
    assert.deepEqual(await changes(bus), [
      { date: today(), status: 'accident', source: 'manual' },
      { date: tomorrow(), status: 'ready', source: 'vsr' },
    ]);

    // Raising works the same way: today stays as set by hand, and the VSR's status starts tomorrow.
    const other = await newBus('HAND2');
    await api('PUT', '/sheets/status', { token: users.creator.token, body: { busId: other._id, date: today(), status: 'ready' } });
    await raise(other, { serviceType: 'battery' });
    assert.deepEqual(await changes(other), [
      { date: today(), status: 'ready', source: 'manual' },
      { date: tomorrow(), status: 'batteryChange', source: 'vsr' },
    ]);
  });

  test('a bus already Ready by hand gets no second record when its VSR comes back', async () => {
    const bus = await newBus('READY');
    const ticket = await raise(bus);
    await raisedOn(bus, ticket, daysAgo(3));
    await api('PUT', '/sheets/status', { token: users.creator.token, body: { busId: bus._id, date: daysAgo(2), status: 'ready' } });
    await bringBack(ticket, daysAgo(1));
    assert.deepEqual(await changes(bus), [
      { date: daysAgo(3), status: 'repair', source: 'vsr' },
      { date: daysAgo(2), status: 'ready', source: 'manual' },
    ]);
  });
});
