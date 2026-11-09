/**
 * A bus leaving the fleet (owner's request and answers, 2026-11-09): in operation → scrap
 * requested → scrapped → sold. The service creator raises a scrap request, the supervisor
 * approves or turns it down and records the sale, and a sold bus is archived. The daily status
 * sheet follows the request instead of being set by hand, and a bus sold before a month is left
 * off that month's sheets and reports. Databases from before are brought over by a migration.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { BASE, api, busBody, createBus, fileOf, multipart, newVendor, requestScrap, run, scrapBus, signIn, signInEveryone } from './helpers.js';
import { connectModels, fixture, report, assertMatchesSheet } from './reportChecks.js';
import { uaeDay } from '../utils/uaeTime.js';

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => uaeDay(new Date(Date.now() - n * DAY_MS));

let users;
let models;
let counter = 0;
const label = (name) => `${name}${(counter += 1)}`;

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const put = (path, token, body) => api('PUT', path, { token, body });
const bus = async (name, overrides) => createBus(users, label(name), users.vendor1.id, overrides);
const busNow = async (id) => ok(await api('GET', `/buses/${id}`, { token: users.creator.token }));
const raiseVsr = (busId, token = users.creator.token) => api('POST', '/tickets', { token, body: { busId, serviceType: 'repair', repairCategory: 'BODY', currentReading: 1000 } });
const sale = (busId, fields, files = [], token = users.supervisor.token) => multipart(`/buses/${busId}/sale`, token, fields, files, 'PUT');
const inbox = async (token) => (await api('GET', '/notifications', { token })).body.data;
const statusCell = async (busId, day) => {
  const sheet = ok(await api('GET', `/sheets/status?month=${day.slice(0, 7)}`, { token: users.supervisor.token }));
  return sheet.buses.find((b) => b._id === busId)?.cells[sheet.days.indexOf(day)];
};
const setStatus = (busId, date, status) => put('/sheets/status', users.creator.token, { busId, date, status });
const download = (path, token) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });

/** An open VSR written straight into the database, as if it had been raised before the bus was asked to be scrapped. */
const openVsr = (busId) =>
  models.Ticket.create({ vsrNumber: `FL-${run}-${label('V')}`, busId, serviceType: 'other', vendorId: users.vendor1.id, createdBy: users.creator.id, status: 'sentToVendor' });

before(async () => {
  users = await signInEveryone();
  models = await connectModels();
  // A second service creator, who did not raise the requests below.
  const { default: User } = await import('../models/User.js');
  const email = `creator2-${run}@muraqaba.test`;
  await User.create({ name: `Other Creator ${run}`, email, role: 'serviceCreator', password: await bcrypt.hash(process.env.TEST_STAFF_PASSWORD, 4) });
  users.creator2 = await signIn(email);
});

after(() => mongoose.connection.close());

describe('scrap requests', () => {
  test('raising one: the bus must be in operation with no open VSR, and every supervisor hears of it', async () => {
    const busy = await bus('BUSY');
    const vsr = ok(await raiseVsr(busy._id));
    const refused = await requestScrap(users, busy._id);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'INVALID_STATE');
    assert.equal(refused.body.message, `Finish or cancel its open VSRs first: ${vsr.vsrNumber}`);

    const free = await bus('FREE');
    const field = async (fields) => (await requestScrap(users, free._id, fields)).body.errors?.[0];
    assert.deepEqual(await field({ reason: 'tooOld' }), { field: 'reason', message: 'Choose why the bus should be scrapped' });
    assert.deepEqual(await field({ note: 'x'.repeat(1001) }), { field: 'note', message: 'Keep the note to 1000 characters or fewer' });
    assert.deepEqual((await requestScrap(users, 'nope')).body.errors[0], { field: 'busId', message: 'Choose a bus' });
    assert.equal((await requestScrap(users, '64b7f0c2e1d2a9b1c8a4f123')).status, 404);
    assert.equal((await multipart('/scrap-requests', users.supervisor.token, { busId: free._id, reason: 'endOfLife' })).status, 403, 'the creator raises it');
    assert.equal((await multipart('/scrap-requests', users.purchasing.token, { busId: free._id, reason: 'endOfLife' })).status, 403);
    assert.equal((await busNow(free._id)).lifecycle, 'inOperation', 'nothing was sent');

    const decideBefore = ok(await api('GET', '/users/dashboard', { token: users.supervisor.token }));
    const sent = await requestScrap(users, free._id, { reason: 'highRunningCost', note: 'Costs more than it earns.' }, [fileOf('costs.pdf', '%PDF-1.4 costs')]);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.message, 'Scrap request sent to the supervisor');
    const request = sent.body.data;
    assert.deepEqual([request.status, request.reason, request.note, request.attachments.length], ['pending', 'highRunningCost', 'Costs more than it earns.', 1]);
    assert.deepEqual([request.bus.fleetNumber, request.bus.lifecycle, request.bus.make, request.bus.year], [free.fleetNumber, 'scrapRequested', 'Hino', 2020]);
    assert.equal(request.createdBy.email, users.creator.email);

    const shown = await busNow(free._id);
    assert.equal(shown.lifecycle, 'scrapRequested');
    assert.deepEqual(shown.scrapRequests.map((r) => r._id), [request._id]);
    const listed = (await api('GET', '/buses', { token: users.purchasing.token })).body.data.find((b) => b._id === free._id);
    assert.equal(listed.lifecycle, 'scrapRequested', 'the list says it too');

    const decideAfter = ok(await api('GET', '/users/dashboard', { token: users.supervisor.token }));
    assert.equal(decideAfter.scrapRequestsToDecide, decideBefore.scrapRequestsToDecide + 1);
    assert.equal(decideAfter.actionRequired, decideBefore.actionRequired + 1);
    const notice = (await inbox(users.supervisor.token)).find((n) => n.type === 'scrapRequested' && n.params.fleetNumber === free.fleetNumber);
    assert.deepEqual([notice.link, notice.params.reason], [`/buses/${free._id}`, 'highRunningCost']);

    // While it waits: no second request and no VSR.
    const again = await requestScrap(users, free._id);
    assert.deepEqual([again.status, again.body.message], [409, 'A scrap request for this bus is waiting for the supervisor.']);
    const vsrRefused = await raiseVsr(free._id);
    assert.deepEqual([vsrRefused.status, vsrRefused.body.code, vsrRefused.body.message], [409, 'INVALID_STATE', 'A scrap request for this bus is waiting for the supervisor.']);
    assert.equal((await raiseVsr(free._id, users.supervisor.token)).status, 409, 'nor by the supervisor');

    // The depot reads it and its file; vendors get nothing.
    for (const token of [users.creator.token, users.supervisor.token, users.purchasing.token]) {
      const list = await api('GET', `/scrap-requests?status=pending&busId=${free._id}`, { token });
      assert.deepEqual([list.status, list.body.total, list.body.data[0]._id], [200, 1, request._id]);
      assert.equal(ok(await api('GET', `/scrap-requests/${request._id}`, { token })).bus.fleetNumber, free.fleetNumber);
    }
    assert.equal((await api('GET', '/scrap-requests', { token: users.vendor1.token })).status, 403);
    assert.equal((await api('GET', `/scrap-requests/${request._id}`, { token: users.vendor1.token })).status, 403);
    assert.equal((await api('GET', '/scrap-requests?status=waiting', { token: users.creator.token })).status, 400);
    const file = await download(`/scrap-requests/${request._id}/attachments/${request.attachments[0]._id}`, users.purchasing.token);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), '%PDF-1.4 costs');
    assert.equal((await download(`/scrap-requests/${request._id}/attachments/${request.attachments[0]._id}`, users.vendor1.token)).status, 403);
  });

  test('cancelling: only the creator who raised it, only while it waits, and the bus is back in operation', async () => {
    const own = await bus('CANCEL');
    const request = (await requestScrap(users, own._id)).body.data;
    const other = await put(`/scrap-requests/${request._id}/cancel`, users.creator2.token);
    assert.deepEqual([other.status, other.body.code], [403, 'FORBIDDEN']);
    assert.equal(other.body.message, 'Only the service creator who raised this request can cancel it');
    assert.equal((await put(`/scrap-requests/${request._id}/cancel`, users.supervisor.token)).status, 403);

    const cancelled = await put(`/scrap-requests/${request._id}/cancel`, users.creator.token);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.message, 'Scrap request cancelled');
    assert.equal(cancelled.body.data.status, 'cancelled');
    assert.ok(cancelled.body.data.cancelledAt);
    assert.equal((await busNow(own._id)).lifecycle, 'inOperation');
    for (const action of ['cancel', 'approve', 'reject']) {
      const token = action === 'cancel' ? users.creator.token : users.supervisor.token;
      const late = await put(`/scrap-requests/${request._id}/${action}`, token, { note: 'Too late' });
      assert.deepEqual([late.status, late.body.code, late.body.message], [409, 'INVALID_STATE', 'This scrap request is no longer waiting for the supervisor.'], action);
    }
    assert.equal((await raiseVsr(own._id)).status, 201, 'work can be raised again');
  });

  test('turning one down needs a reason, puts the bus back in operation and tells the creator', async () => {
    const own = await bus('REJECT');
    const request = (await requestScrap(users, own._id, { reason: 'totalLoss' })).body.data;
    assert.deepEqual((await put(`/scrap-requests/${request._id}/reject`, users.supervisor.token, {})).body.errors[0], { field: 'note', message: 'Enter why the scrap request is turned down' });
    assert.equal((await put(`/scrap-requests/${request._id}/reject`, users.creator.token, { note: 'No' })).status, 403, 'the supervisor decides');

    const rejected = await put(`/scrap-requests/${request._id}/reject`, users.supervisor.token, { note: 'The body shop can repair it.' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.message, 'Scrap request turned down');
    assert.deepEqual([rejected.body.data.status, rejected.body.data.decisionNote, rejected.body.data.decidedBy.email], ['rejected', 'The body shop can repair it.', users.supervisor.email]);
    assert.equal((await busNow(own._id)).lifecycle, 'inOperation');
    const notice = (await inbox(users.creator.token)).find((n) => n.type === 'scrapRejected' && n.params.fleetNumber === own.fleetNumber);
    assert.deepEqual([notice.link, notice.params.note], [`/buses/${own._id}`, 'The body shop can repair it.']);
    assert.ok(!(await inbox(users.creator2.token)).some((n) => n.type === 'scrapRejected' && n.params.fleetNumber === own.fleetNumber), 'only the creator who raised it');
    assert.equal((await raiseVsr(own._id)).status, 201);
  });

  test('approving checks again for open VSRs, scraps the bus today and writes Scrapping on the sheet', async () => {
    const own = await bus('APPROVE');
    const request = (await requestScrap(users, own._id)).body.data;
    const vsr = await openVsr(own._id);
    const blocked = await put(`/scrap-requests/${request._id}/approve`, users.supervisor.token);
    assert.deepEqual([blocked.status, blocked.body.message], [409, `Finish or cancel its open VSRs first: ${vsr.vsrNumber}`]);
    assert.equal((await put(`/scrap-requests/${request._id}/approve`, users.creator.token)).status, 403);
    await models.Ticket.updateOne({ _id: vsr._id }, { $set: { status: 'completed' } });

    assert.deepEqual((await put(`/scrap-requests/${request._id}/approve`, users.supervisor.token, { note: 'x'.repeat(1001) })).body.errors[0].field, 'note');
    const approved = await put(`/scrap-requests/${request._id}/approve`, users.supervisor.token, { note: 'Agreed.' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.message, 'Bus scrapped. Record the sale when it is sold.');
    assert.deepEqual([approved.body.data.status, approved.body.data.decisionNote, approved.body.data.bus.lifecycle], ['approved', 'Agreed.', 'scrapped']);

    const today = uaeDay();
    const shown = await busNow(own._id);
    assert.deepEqual([shown.lifecycle, shown.scrappedOn], ['scrapped', today]);
    assert.deepEqual(await statusCell(own._id, today), { status: 'scrapping', source: 'scrap' });
    const notice = (await inbox(users.creator.token)).find((n) => n.type === 'scrapApproved' && n.params.fleetNumber === own.fleetNumber);
    assert.deepEqual([notice.link, notice.params.scrappedOn], [`/buses/${own._id}`, today]);

    const vsrRefused = await raiseVsr(own._id);
    assert.deepEqual([vsrRefused.status, vsrRefused.body.message], [409, 'This bus is scrapped. No VSR can be raised on it.']);
    assert.deepEqual((await requestScrap(users, own._id)).body.message, 'This bus is already scrapped.');
    const edited = await put(`/buses/${own._id}`, users.creator.token, busBody('x', users.vendor1.id, { fleetNumber: own.fleetNumber, chassisNumber: own.chassisNumber, registrationNumber: own.registrationNumber, model: 'Coach (scrapped)' }));
    assert.equal(edited.status, 200, 'a scrapped bus can still be corrected');
  });

  test('the sheet: Scrapping and Removed only through a request, and nothing from the scrapped day on', async () => {
    const own = await bus('SHEET');
    for (const status of ['scrapping', 'removed']) {
      assert.deepEqual((await setStatus(own._id, uaeDay(), status)).body.errors[0], { field: 'status', message: 'Scrapping and selling go through a scrap request.' });
    }
    await scrapBus(users, own._id);
    // Pretend it was scrapped ten days ago, so there are days either side.
    const scrappedOn = daysAgo(10);
    await models.Bus.updateOne({ _id: own._id }, { $set: { scrappedOn } });
    await models.BusStatusChange.updateOne({ bus: own._id, date: uaeDay() }, { $set: { date: scrappedOn } });

    for (const day of [scrappedOn, daysAgo(3), uaeDay()]) {
      const locked = await setStatus(own._id, day, 'ready');
      assert.deepEqual([locked.status, locked.body.code, locked.body.message], [409, 'INVALID_STATE', `This bus is scrapped from ${scrappedOn}.`], day);
    }
    const before = await setStatus(own._id, daysAgo(11), 'repair');
    assert.equal(before.status, 200, 'a day before it was scrapped can still be corrected');
    assert.equal((await statusCell(own._id, daysAgo(11))).status, 'repair');
  });
});

describe('recording the sale', () => {
  test('the supervisor records date, buyer and price for a scrapped bus, which is then archived', async () => {
    const own = await bus('SALE');
    const request = await scrapBus(users, own._id);
    const scrappedOn = daysAgo(10);
    await models.Bus.updateOne({ _id: own._id }, { $set: { scrappedOn } });
    await models.BusStatusChange.updateOne({ bus: own._id, date: uaeDay() }, { $set: { date: scrappedOn } });
    // A Scrapping day typed by hand before scrap requests existed, after the sale day.
    await models.BusStatusChange.create({ bus: own._id, date: daysAgo(2), status: 'scrapping', source: 'manual' });

    const valid = { date: daysAgo(5), buyer: 'Scrap Yard LLC', price: '15250.50', note: 'Sold with its engine.' };
    const error = async (fields) => (await sale(own._id, { ...valid, ...fields })).body.errors?.[0];
    assert.equal((await sale(own._id, valid, [], users.creator.token)).status, 403);
    assert.equal((await sale(own._id, valid, [], users.purchasing.token)).status, 403);
    assert.deepEqual(await error({ buyer: '' }), { field: 'buyer', message: 'Enter who bought the bus' });
    assert.deepEqual(await error({ buyer: 'B'.repeat(201) }), { field: 'buyer', message: 'Keep this to 200 characters or fewer' });
    assert.deepEqual(await error({ price: '' }), { field: 'price', message: 'Enter the price, 0 or more' });
    assert.deepEqual(await error({ price: '-1' }), { field: 'price', message: 'Enter the price, 0 or more' });
    assert.deepEqual(await error({ price: '10.555' }), { field: 'price', message: 'Use at most 2 decimals' });
    assert.deepEqual(await error({ date: '' }), { field: 'date', message: 'Choose the day the bus was sold' });
    assert.deepEqual(await error({ date: '2099-01-01' }), { field: 'date', message: 'The sale date cannot be in the future' });
    assert.deepEqual(await error({ date: daysAgo(11) }), { field: 'date', message: 'The sale cannot be dated before the bus was scrapped' });
    assert.deepEqual(await error({ note: 'n'.repeat(1001) }), { field: 'note', message: 'Keep the note to 1000 characters or fewer' });
    assert.equal((await busNow(own._id)).lifecycle, 'scrapped', 'nothing was recorded');

    const sold = await sale(own._id, valid, [fileOf('sale.pdf', '%PDF-1.4 sale')]);
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    assert.equal(sold.body.message, 'Sale recorded. The bus is archived.');
    const { lifecycle, sale: recorded } = sold.body.data;
    assert.equal(lifecycle, 'sold');
    assert.deepEqual([recorded.date, recorded.buyer, recorded.price, recorded.note, recorded.attachments.length, recorded.recordedBy.email], [daysAgo(5), 'Scrap Yard LLC', 15250.5, 'Sold with its engine.', 1, users.supervisor.email]);

    // Removed from the sale day on, and the hand-typed Scrapping after it is gone.
    const changes = await models.BusStatusChange.find({ bus: own._id }).sort({ date: 1 }).lean();
    assert.deepEqual(changes.map(({ date, status, source }) => [date, status, source]), [[scrappedOn, 'scrapping', 'scrap'], [daysAgo(5), 'removed', 'scrap']]);
    if (daysAgo(5).slice(0, 7) === uaeDay().slice(0, 7)) assert.deepEqual(await statusCell(own._id, uaeDay()), { status: 'removed', source: null }, 'sold this month, so still on this month\'s sheet');

    const notice = (await inbox(users.creator.token)).find((n) => n.type === 'busSold' && n.params.fleetNumber === own.fleetNumber);
    assert.deepEqual([notice.link, notice.params.date], [`/buses/${own._id}`, daysAgo(5)]);
    assert.equal(request.createdBy.email, users.creator.email, 'the creator who raised the request');

    const file = await download(`/buses/${own._id}/sale/attachments/${recorded.attachments[0]._id}`, users.purchasing.token);
    assert.deepEqual([file.status, await file.text()], [200, '%PDF-1.4 sale']);
    assert.equal((await download(`/buses/${own._id}/sale/attachments/${recorded.attachments[0]._id}`, users.vendor1.token)).status, 403);

    // Archived: kept with its history, changed no more.
    const shown = await busNow(own._id);
    assert.deepEqual([shown.lifecycle, shown.sale.buyer, shown.scrapRequests[0].status], ['sold', 'Scrap Yard LLC', 'approved']);
    const SOLD = 'A sold bus is archived and cannot be changed.';
    assert.deepEqual([(await sale(own._id, valid)).status, (await sale(own._id, valid)).body.message], [409, SOLD]);
    const edit = await put(`/buses/${own._id}`, users.creator.token, busBody('x', users.vendor1.id, { fleetNumber: own.fleetNumber, chassisNumber: own.chassisNumber, registrationNumber: own.registrationNumber }));
    assert.deepEqual([edit.status, edit.body.code, edit.body.message], [409, 'INVALID_STATE', SOLD]);
    assert.deepEqual((await raiseVsr(own._id)).body.message, 'This bus is sold and archived. No VSR can be raised on it.');
    assert.deepEqual((await requestScrap(users, own._id)).body.message, SOLD);
    assert.deepEqual((await setStatus(own._id, uaeDay(), 'ready')).body.message, `This bus is scrapped from ${scrappedOn}.`);
  });

  test('only a scrapped bus can be sold', async () => {
    const own = await bus('NOTSCRAPPED');
    const valid = { date: uaeDay(), buyer: 'Someone', price: '100' };
    assert.deepEqual([(await sale(own._id, valid)).status, (await sale(own._id, valid)).body.message], [409, 'Only a scrapped bus can be sold.']);
    await requestScrap(users, own._id);
    assert.deepEqual((await sale(own._id, valid)).body.message, 'Only a scrapped bus can be sold.', 'nor one waiting for the supervisor');
    assert.equal((await sale('64b7f0c2e1d2a9b1c8a4f123', valid)).status, 404);
  });

  test('a sale can be sent without files, and on the day the bus was scrapped', async () => {
    const own = await bus('SAMEDAY');
    await scrapBus(users, own._id);
    const sold = await api('PUT', `/buses/${own._id}/sale`, { token: users.supervisor.token, body: { date: uaeDay(), buyer: 'Same Day Metals', price: 0 } });
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    assert.deepEqual([sold.body.data.sale.price, sold.body.data.sale.attachments], [0, []]);
    assert.deepEqual(await statusCell(own._id, uaeDay()), { status: 'removed', source: 'scrap' }, 'Removed replaces the day\'s Scrapping');
  });
});

describe('a bus sold before a period', () => {
  test('is left off that period\'s status and km sheets and its reports, but not off the period it was sold in', async () => {
    const vendor = await newVendor('fl-gone');
    const fx = fixture(models, { prefix: `FL${run}`, creatorId: users.creator.id });
    try {
      const created = new Date('2023-12-01T08:00:00+04:00');
      const gone = await fx.addBus('GONE', { make: 'Hino', created, vendor: vendor.id });
      const goingInMarch = await fx.addBus('MARCH', { make: 'Hino', created, vendor: vendor.id });
      const staying = await fx.addBus('STAY', { make: 'Hino', created, vendor: vendor.id });
      await fx.setStatus(gone, '2024-02-01', 'scrapping', 'scrap');
      await fx.setStatus(gone, '2024-02-10', 'removed', 'scrap');
      await fx.setStatus(goingInMarch, '2024-02-01', 'scrapping', 'scrap');
      await fx.setStatus(goingInMarch, '2024-03-15', 'removed', 'scrap');
      await fx.addReading(gone, '2024-01-15', 1000);
      await fx.addReading(goingInMarch, '2024-01-15', 2000);

      const ids = async (path) => ok(await api('GET', path, { token: users.supervisor.token })).buses.map((b) => b._id);
      const [inFebruary, inMarch, kmInMarch] = await Promise.all([ids('/sheets/status?month=2024-02'), ids('/sheets/status?month=2024-03'), ids('/sheets/readings?month=2024-03')]);
      assert.ok(inFebruary.includes(String(gone._id)), 'sold in February: on February\'s sheet');
      assert.ok(!inMarch.includes(String(gone._id)), 'and off March\'s');
      assert.ok(inMarch.includes(String(goingInMarch._id)) && inMarch.includes(String(staying._id)));
      assert.ok(!kmInMarch.includes(String(gone._id)) && kmInMarch.includes(String(goingInMarch._id)), 'the km sheet agrees');

      const token = users.purchasing.token;
      const availability = await report(token, 'availability', { year: 2024, month: 3 });
      const sheet = ok(await api('GET', '/sheets/status?month=2024-03', { token: users.supervisor.token }));
      assertMatchesSheet(availability, sheet);
      const downtime = await report(token, 'downtime', { year: 2024, month: 3 });
      assert.ok(!downtime.rows.some((row) => row.busId === String(gone._id)));
      const kmIds = async (year) => (await report(token, 'km', { year })).rows.map((row) => row.busId);
      assert.ok((await kmIds(2024)).includes(String(gone._id)), 'sold during 2024, so on the 2024 km report');
      const in2025 = await kmIds(2025);
      assert.ok(!in2025.includes(String(gone._id)) && !in2025.includes(String(goingInMarch._id)) && in2025.includes(String(staying._id)), 'and off 2025\'s');
    } finally {
      await fx.cleanup();
    }
  });
});

describe('migration of a database from before', () => {
  const oid = () => new mongoose.Types.ObjectId();

  test('sets lifecycles from the sheets and merges LPO lines, writes nothing on a dry run, and changes nothing the second time', async () => {
    const uri = process.env.MONGO_URI.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, query = '') => `/${db}_migrate${query}`);
    const connection = await mongoose.createConnection(uri).asPromise();
    const db = (name) => connection.collection(name);
    try {
      await connection.dropDatabase();
      const [v1, v2, v3] = [oid(), oid(), oid()];
      await db('users').insertMany([v1, v2, v3].map((_id, i) => ({ _id, name: `Vendor ${i}`, email: `v${i}-${run}@test.dev`, role: 'vendor', password: 'x' })));
      const b = Object.fromEntries(['scrapped', 'sold', 'straight', 'back', 'none', 'waiting', 'sale'].map((key) => [key, oid()]));
      const busDoc = (key, vendor, make, extra = {}) => ({ _id: b[key], fleetNumber: `M-${key}`, make, model: 'Coach', year: 2015, vendor, ...extra });
      await db('buses').insertMany([
        busDoc('scrapped', v1, 'Hino'),
        busDoc('sold', v1, 'hino'),
        busDoc('straight', v1, 'Isuzu'),
        busDoc('back', v1, 'Hino'),
        busDoc('none', v2, 'Coachline'),
        busDoc('waiting', v2, 'Coachline', { lifecycle: 'scrapRequested' }),
        busDoc('sale', v2, 'Coachline', { lifecycle: 'sold', scrappedOn: '2026-01-08', sale: { date: '2026-01-08', buyer: 'Kept Buyer', price: 100, attachments: [] } }),
      ]);
      const changes = {
        scrapped: [['01', 'ready'], ['05', 'scrapping'], ['08', 'ready'], ['10', 'scrapping'], ['12', 'scrapping']],
        sold: [['03', 'scrapping'], ['04', 'scrapping'], ['06', 'removed'], ['07', 'removed']],
        straight: [['02', 'removed']],
        back: [['02', 'scrapping'], ['09', 'ready']],
        waiting: [['05', 'scrapping']],
        sale: [['08', 'removed']],
      };
      await db('busstatuschanges').insertMany(Object.entries(changes).flatMap(([key, list]) => list.map(([day, status]) => ({ bus: b[key], date: `2026-01-${day}`, status, source: 'manual' }))));

      const ids = Object.fromEntries(['t1', 'r1', 'm1', 'm2', 't3', 'r5', 'rm4'].map((key) => [key, oid()]));
      const lpo = (number, vendor, items, extra = {}) => ({ _id: oid(), number, vendor, validFrom: new Date('2026-01-01'), validTo: new Date('2026-12-31'), items, grandTotal: items.reduce((s, i) => s + i.total, 0), usedAmount: 0, ...extra });
      const line = (_id, kind, total, usedAmount = 0, quantity = 1) => ({ _id, kind, name: kind, quantity, unitPrice: total / quantity, total, usedQuantity: 0, usedAmount });
      const lpos = {
        mixed: lpo('L1', v1, [line(ids.t1, 'tyre', 8000, 0, 10), line(ids.r1, 'repair', 1000, 300), line(ids.m1, 'maintenance', 500.5, 200.25)]),
        services: lpo('L2', v2, [line(ids.m2, 'maintenance', 800)]),
        tyres: lpo('L3', v2, [line(ids.t3, 'tyre', 1600, 0, 2)]),
        done: lpo('L4', v1, [line(ids.rm4, 'repairMaintenance', 900)], { make: 'Isuzu' }),
        orphan: lpo('L5', v3, [line(ids.r5, 'repair', 400)]),
      };
      await db('lpos').insertMany(Object.values(lpos));
      const deduction = (key, extra) => ({ _id: oid(), vsrNumber: `M-${key}`, lpoDeduction: { amount: 100, quantity: 0, ...extra } });
      const tickets = {
        repair: deduction('repair', { status: 'deducted', lpo: lpos.mixed._id, item: ids.r1, kind: 'repair' }),
        oil: deduction('oil', { status: 'deducted', lpo: lpos.mixed._id, item: ids.m1, kind: 'maintenance' }),
        tyre: deduction('tyre', { status: 'deducted', lpo: lpos.mixed._id, item: ids.t1, kind: 'tyre' }),
        missing: deduction('missing', { status: 'noLpo', kind: 'maintenance' }),
        services: deduction('services', { status: 'deducted', lpo: lpos.services._id, item: ids.m2, kind: 'maintenance' }),
      };
      await db('tickets').insertMany(Object.values(tickets));

      const snapshot = async () => Object.fromEntries(await Promise.all(['buses', 'lpos', 'tickets', 'busstatuschanges'].map(async (name) => [name, await db(name).find().sort({ _id: 1 }).toArray()])));
      const script = join(here, '..', 'scripts', 'migrate-fleet-lifecycle.js');
      const migrate = (extra, env = {}) => exec(process.execPath, [script, ...extra], { env: { ...process.env, ...env }, timeout: 60000 });

      // A dry run, pointed at the database by MONGO_URI, reports and writes nothing.
      const before = await snapshot();
      const dry = await migrate(['--dry-run'], { MONGO_URI: uri });
      assert.match(dry.stdout, /Dry run on database \S+_migrate/);
      assert.match(dry.stdout, /Buses: 1 to scrapped, 2 to sold, 2 marked in operation/);
      assert.match(dry.stdout, /LPOs: 3 with lines merged, 2 given a make/);
      assert.match(dry.stdout, /L5: repair and maintenance lines merged, no bus of its vendor to take a make from/);
      assert.match(dry.stdout, /Nothing written/);
      assert.deepEqual(await snapshot(), before);

      // The real run, pointed at it by --uri.
      await migrate(['--uri', uri]);
      const bus = async (key) => db('buses').findOne({ _id: b[key] });
      const scrapped = await bus('scrapped');
      assert.deepEqual([scrapped.lifecycle, scrapped.scrappedOn, scrapped.sale], ['scrapped', '2026-01-10', undefined], 'from the first day of the last Scrapping run');
      const sold = await bus('sold');
      assert.deepEqual([sold.lifecycle, sold.scrappedOn, sold.sale.date, sold.sale.buyer, sold.sale.price], ['sold', '2026-01-03', '2026-01-06', undefined, undefined]);
      const straight = await bus('straight');
      assert.deepEqual([straight.lifecycle, straight.scrappedOn, straight.sale.date], ['sold', '2026-01-02', '2026-01-02']);
      assert.deepEqual([(await bus('back')).lifecycle, (await bus('none')).lifecycle], ['inOperation', 'inOperation']);
      assert.equal((await bus('waiting')).lifecycle, 'scrapRequested', 'a request waiting for the supervisor is left to them');
      assert.deepEqual((await bus('sale')).sale.buyer, 'Kept Buyer', 'a sale recorded in the app is kept');

      const lpoNow = async (key) => db('lpos').findOne({ _id: lpos[key]._id });
      const mixed = await lpoNow('mixed');
      assert.equal(mixed.make, 'Hino', 'the make most of the vendor\'s buses have, any letter case counted together');
      assert.deepEqual(mixed.items.map((i) => i.kind), ['tyre', 'repairMaintenance']);
      const merged = mixed.items[1];
      assert.deepEqual([String(merged._id), merged.name, merged.quantity, merged.unitPrice, merged.total, merged.usedAmount, merged.usedQuantity], [String(ids.r1), 'Repair and maintenance', 1, 1500.5, 1500.5, 500.25, 0]);
      assert.equal(mixed.grandTotal, lpos.mixed.grandTotal);
      const services = await lpoNow('services');
      assert.deepEqual([services.make, services.items[0].kind, String(services.items[0]._id)], ['Coachline', 'repairMaintenance', String(ids.m2)]);
      assert.deepEqual(await lpoNow('tyres'), lpos.tyres, 'a tyre LPO names no make and is left alone');
      assert.deepEqual(await lpoNow('done'), lpos.done);
      const orphan = await lpoNow('orphan');
      assert.deepEqual([orphan.make, orphan.items[0].kind], [undefined, 'repairMaintenance']);

      const deducted = async (key) => (await db('tickets').findOne({ _id: tickets[key]._id })).lpoDeduction;
      assert.deepEqual([String((await deducted('repair')).item), (await deducted('repair')).kind], [String(ids.r1), 'repairMaintenance']);
      assert.deepEqual([String((await deducted('oil')).item), (await deducted('oil')).kind], [String(ids.r1), 'repairMaintenance'], 'moved to the merged line');
      assert.deepEqual([String((await deducted('tyre')).item), (await deducted('tyre')).kind], [String(ids.t1), 'tyre']);
      assert.equal((await deducted('missing')).kind, 'repairMaintenance');
      assert.equal((await deducted('services')).kind, 'repairMaintenance');

      // Again: nothing left to do.
      const once = await snapshot();
      const twice = await migrate(['--uri', uri]);
      assert.match(twice.stdout, /Buses: 0 to scrapped, 0 to sold, 0 marked in operation/);
      assert.match(twice.stdout, /LPOs: 0 with lines merged, 0 given a make/);
      assert.deepEqual(await snapshot(), once);
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  });
});
