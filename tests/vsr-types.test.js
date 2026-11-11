/**
 * The owner's testing notes of 2026-11-11, VSR types. Transmission is a repair category, not a
 * service, and the bus has no transmission rate or interval. Brake pads are a repair category,
 * measured against the bus's brake-pad interval. Accident is a service type of its own: it goes
 * to any listed vendor or to one outside the list, for whom the service creator records the
 * vendor's steps. The breakdown flag goes with repairs only.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { api, busBody, createBus, estimate, fillBreakdown, fileOf, fromAcknowledgedToReturned, grnFor, multipart, newVendor, run, signInEveryone, submitInvoice, testDb, toAcknowledged, toForwarded } from './helpers.js';
import { statusForTicket } from '../utils/busDay.js';
import { LINE_FOR_SERVICE, lineStatus } from '../utils/lpoDeduction.js';
import { kindOf } from '../utils/reportMaths.js';

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);

let users;
let bus;
let counter = 0;
const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const firstError = (res) => res.body.errors?.[0];
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });
const post = (body, token = users.creator.token) => api('POST', '/tickets', { token, body: { busId: bus._id, currentReading: 5000, description: 'Raised in a test.', ...body } });
const raise = async (body, token) => ok(await post(body, token));
const read = async (id, token = users.creator.token) => ok(await api('GET', `/tickets/${id}`, { token }));
const DETAILS = { severity: 'medium', fault: 'otherParty' };
const ACCIDENT = { serviceType: 'accident', accident: DETAILS };
const MAKE = `Tbus ${run}`;
const withDb = async (work) => {
  const connection = await testDb();
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
};
const oid = (id) => new mongoose.Types.ObjectId(String(id));

describe('VSR types, 2026-11-11', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'TYPES', users.vendor1.id, { make: MAKE, rates: undefined });
  });

  describe('service types', () => {
    test('transmission and brake pads are no longer service types', async () => {
      for (const serviceType of ['transmission', 'brakePads']) {
        const res = await post({ serviceType });
        assert.equal(res.status, 400, serviceType);
        assert.deepEqual(firstError(res), { field: 'serviceType', message: 'Service type must be one of: oil, tyre, battery, repair, accident, other' });
      }
    });

    test('accident is no longer a repair category; transmission and brake pads are', async () => {
      assert.equal(firstError(await post({ serviceType: 'repair', repairCategory: 'ACCIDENT' })).field, 'repairCategory');
      const transmission = await raise({ serviceType: 'repair', repairCategory: 'TRANSMISSION' });
      assert.deepEqual([transmission.serviceType, transmission.repairCategory, transmission.status], ['repair', 'TRANSMISSION', 'sentToVendor']);
      assert.equal(transmission.intervalUsage, undefined, 'a transmission repair has no interval of its own');
      const pads = await raise({ serviceType: 'repair', repairCategory: 'BRAKE PADS' });
      assert.equal(pads.repairCategory, 'BRAKE PADS');
    });

    test('a brake-pad repair is measured against the brake-pad interval, and moves it when the bus is back', async () => {
      const padded = await createBus(users, `PADS${(counter += 1)}`, users.vendor1.id, { make: MAKE, rates: undefined, intervals: { ...busBody('x', 'x').intervals, brakePads: { everyKm: 40000, lastKm: 10000 } } });
      const ticket = await raise({ busId: padded._id, serviceType: 'repair', repairCategory: 'BRAKE PADS', currentReading: 45000 });
      assert.deepEqual(ticket.intervalUsage, { unit: 'km', interval: 40000, actual: 35000, left: 5000, delayed: 0 });
      await toAcknowledged(users, ticket, users.vendor1);
      await fromAcknowledgedToReturned(users, ticket._id, users.vendor1, { km: 45200 });
      const after = ok(await api('GET', `/buses/${padded._id}`, { token: users.creator.token }));
      assert.equal(after.intervals.brakePads.lastKm, 45200);
      assert.equal(after.intervals.oil.lastKm, 0, 'only the brake pads were done');
    });

    test('a brake-pad repair is refused on a bus with no brake-pad interval, and other repairs are not', async () => {
      const old = await createBus(users, `OLD${(counter += 1)}`, users.vendor1.id, { make: MAKE, rates: undefined });
      await withDb((db) => db.collection('buses').updateOne({ _id: oid(old._id) }, { $unset: { 'intervals.brakePads': 1 } }));
      const refused = await post({ busId: old._id, serviceType: 'repair', repairCategory: 'BRAKE PADS' });
      assert.equal(refused.status, 400);
      assert.deepEqual(firstError(refused), { field: 'repairCategory', message: 'This bus has no brake-pad interval. Add it on the bus first.' });
      assert.equal((await post({ busId: old._id, serviceType: 'repair', repairCategory: 'ENGINE' })).status, 201);
    });

    test('the daily status follows the kind of work', () => {
      assert.equal(statusForTicket({ serviceType: 'oil' }), 'maintenance');
      assert.equal(statusForTicket({ serviceType: 'tyre' }), 'tyreChange');
      assert.equal(statusForTicket({ serviceType: 'battery' }), 'batteryChange');
      for (const repairCategory of ['ENGINE', 'TRANSMISSION', 'BRAKE PADS']) assert.equal(statusForTicket({ serviceType: 'repair', repairCategory }), 'repair', repairCategory);
      assert.equal(statusForTicket({ serviceType: 'accident' }), 'accident');
      assert.equal(statusForTicket({ serviceType: 'other' }), 'maintenance');
    });
  });

  describe('the breakdown flag', () => {
    test('only a repair keeps it', async () => {
      assert.equal((await raise({ serviceType: 'repair', repairCategory: 'ENGINE', isBreakdown: true })).isBreakdown, true);
      assert.equal((await raise({ serviceType: 'oil', isBreakdown: true })).isBreakdown, false);
      assert.equal((await raise({ ...ACCIDENT, isBreakdown: true })).isBreakdown, false);
      assert.equal((await raise({ serviceType: 'other', isBreakdown: true })).isBreakdown, false);
    });
  });

  describe('accidents', () => {
    test('need severity and fault, keep them from vendors, and take no repair category', async () => {
      assert.deepEqual(firstError(await post({ serviceType: 'accident' })), { field: 'accident.severity', message: 'Choose how serious the accident was' });
      assert.deepEqual(firstError(await post({ serviceType: 'accident', accident: { severity: 'minor' } })), { field: 'accident.fault', message: 'Choose who was at fault' });
      const ticket = await raise({ ...ACCIDENT, repairCategory: 'ENGINE' });
      assert.equal(ticket.serviceType, 'accident');
      assert.equal(ticket.repairCategory, undefined);
      assert.deepEqual([ticket.accident.severity, ticket.accident.fault], ['medium', 'otherParty']);
      assert.equal(ticket.status, 'sentToVendor', 'a listed vendor sends an estimate, as for a repair');
      assert.equal(ticket.vendorId._id, users.vendor1.id, 'the bus\'s vendor unless another is chosen');
      const seen = await read(ticket._id, users.vendor1.token);
      assert.ok(!('accident' in seen), 'vendors never see the details');
      // A repair carries no accident details, whatever is sent.
      assert.equal((await raise({ serviceType: 'repair', repairCategory: 'BODY', accident: DETAILS })).accident, undefined);
    });

    test('details can be changed on an accident, and a repair has none', async () => {
      const accident = await raise(ACCIDENT);
      const changed = ok(await put(accident._id, 'accident', users.supervisor.token, { severity: 'major', fault: 'ourDriver' }));
      assert.deepEqual([changed.accident.severity, changed.accident.fault], ['major', 'ourDriver']);
      const repair = await raise({ serviceType: 'repair', repairCategory: 'BODY' });
      assert.equal((await put(repair._id, 'accident', users.creator.token, DETAILS)).status, 409);
    });

    test('mark the bus as in an accident on the daily sheet', async () => {
      const ticket = await raise(ACCIDENT);
      const status = await withDb((db) => db.collection('busstatuschanges').findOne({ ticket: oid(ticket._id) }));
      assert.equal(status.status, 'accident');
    });

    test('choose no LPO when raised, tell purchasing nothing, and come off the make\'s repair and maintenance LPO at the GRN', async () => {
      assert.equal(LINE_FOR_SERVICE.accident, 'repairMaintenance');
      assert.equal(lineStatus('accident', []), 'notNeeded');
      const vendor = await newVendor(`acc-${(counter += 1)}`);
      // A make of its own, so this LPO is not offered for the rest of this file's repairs.
      const make = `${MAKE} GRN`;
      const own = await createBus(users, `ACC${counter}`, vendor.id, { make, rates: undefined });
      const lpo = ok(await api('POST', '/lpos', { token: users.purchasing.token, body: { number: `ACC-${run}-${counter}`, vendorId: vendor.id, date: '2026-01-01', validFrom: '2026-01-01', validTo: '2099-12-31', items: [{ kind: 'repairMaintenance', make, unitPrice: 50000 }] } }));
      const line = lpo.items[0]._id;

      const shown = ok(await api('GET', `/lpos/for-vsr?busId=${own._id}&serviceType=accident`, { token: users.creator.token }));
      assert.equal(shown.status, 'notNeeded');
      assert.deepEqual(firstError(await post({ busId: own._id, ...ACCIDENT, lpoItemId: line })), { field: 'lpoItemId', message: 'This LPO cannot be used for this job' });
      const ticket = await raise({ busId: own._id, ...ACCIDENT });
      assert.equal(ticket.lpoLine, undefined);
      const inbox = ok(await api('GET', '/notifications', { token: users.purchasing.token }));
      assert.ok(!inbox.some((notice) => notice.params?.vsrNumber === ticket.vsrNumber), 'purchasing is not told of a missing LPO');

      await toForwarded(users, ticket, vendor, { invoice: { amount: '900' } });
      ok(await grnFor(users, ticket._id, `ACC${counter}`));
      const after = await read(ticket._id);
      assert.equal(after.lpoDeduction.status, 'deducted');
      assert.equal(after.lpoDeduction.item, line);
      assert.equal(after.lpoDeduction.amount, 900);
    });

    test('count as accidents in the reports, apart from repairs', async () => {
      assert.equal(kindOf({ serviceType: 'accident' }), 'accident');
      assert.equal(kindOf({ serviceType: 'repair', repairCategory: 'TRANSMISSION' }), 'repair');
      const ticket = await raise(ACCIDENT);
      const year = new Date().getUTCFullYear();
      const accidents = ok(await api('GET', `/reports/accidents?year=${year}`, { token: users.purchasing.token }));
      assert.ok(accidents.rows.some((row) => row._id === ticket._id), 'in the accidents report');
      const categories = ok(await api('GET', `/reports/categories?year=${year}`, { token: users.purchasing.token }));
      const names = categories.rows.map((row) => row.category);
      assert.ok(!names.includes('ACCIDENT'), 'not a repair category');
      assert.ok(names.includes('TRANSMISSION') && names.includes('BRAKE PADS'));
      const query = ok(await api('GET', `/reports/query?type=accident&busId=${bus._id}&year=${year}`, { token: users.purchasing.token }));
      assert.ok(query.total.count >= 1);
      for (const type of ['transmission', 'brakePads']) assert.equal((await api('GET', `/reports/query?type=${type}`, { token: users.purchasing.token })).status, 400, type);
    });
  });

  describe('vendors outside the list', () => {
    const outsideName = `Desert Garage ${run}`;

    test('an accident can go to a vendor outside the list, kept once per name', async () => {
      const first = await raise({ ...ACCIDENT, outsideVendorName: outsideName });
      assert.equal(first.vendorId.name, outsideName);
      assert.equal(first.vendorId.outside, true);
      assert.equal(first.status, 'sentToVendor');
      const again = await raise({ ...ACCIDENT, outsideVendorName: `  ${outsideName.toUpperCase()} ` });
      assert.equal(again.vendorId._id, first.vendorId._id, 'the same name in any letter case is the same vendor');
      const stored = await withDb((db) => db.collection('users').findOne({ _id: oid(first.vendorId._id) }));
      assert.equal(stored.role, 'vendor');
      assert.equal(stored.outside, true);
      assert.match(stored.email, /\.invalid$/, 'an address nothing can be sent to');
      // A correction can keep it by id, as the form sends it.
      const listed = ok(await api('GET', '/vendors', { token: users.creator.token }));
      assert.ok(!listed.some((vendor) => vendor._id === first.vendorId._id), 'not on the Vendors page or in vendor pickers');
      const offered = ok(await api('GET', '/vendors/outside', { token: users.creator.token }));
      assert.ok(offered.some((vendor) => vendor.name === outsideName), 'offered as a name for the next accident');
      assert.equal((await api('GET', '/vendors/outside', { token: users.vendor1.token })).status, 403);
    });

    test('only an accident can, and listed-vendor places refuse one', async () => {
      assert.deepEqual(firstError(await post({ serviceType: 'repair', repairCategory: 'BODY', outsideVendorName: outsideName })), {
        field: 'outsideVendorName',
        message: 'Only an accident can go to a vendor outside the list',
      });
      const outside = (await raise({ ...ACCIDENT, outsideVendorName: outsideName })).vendorId._id;
      assert.deepEqual(firstError(await post({ serviceType: 'repair', repairCategory: 'BODY', vendorId: outside })), { field: 'vendorId', message: 'Choose a vendor from the list' });
      assert.equal((await post({ ...ACCIDENT, vendorId: outside })).status, 201, 'an accident may name it by id');
      const busRes = await api('POST', '/buses', { token: users.creator.token, body: busBody(`OUT${(counter += 1)}`, outside) });
      assert.deepEqual(firstError(busRes), { field: 'vendorId', message: 'Choose a vendor from the list' });
    });

    test('nobody can sign in as one', async () => {
      const outside = (await raise({ ...ACCIDENT, outsideVendorName: outsideName })).vendorId;
      const stored = await withDb((db) => db.collection('users').findOne({ _id: oid(outside._id) }));
      const known = 'KnownPass123!';
      const hashed = await bcrypt.hash(known, 4);
      await withDb((db) => db.collection('users').updateOne({ _id: stored._id }, { $set: { password: hashed } }));
      const login = await api('POST', '/auth/login', { body: { email: stored.email, password: known } });
      assert.equal(login.status, 401);
      const token = jwt.sign({ id: String(stored._id), role: 'vendor' }, process.env.JWT_SECRET, { expiresIn: '1h' });
      assert.equal((await api('GET', '/auth/me', { token })).status, 401, 'nor use a token made for one');
    });

    test('the service creator records every step of the outside vendor', async () => {
      const ticket = await raise({ ...ACCIDENT, outsideVendorName: outsideName });
      const id = ticket._id;
      const creator = users.creator.token;
      assert.equal((await estimate(id, users.vendor1.token, { amount: '1200' })).status, 403, 'a listed vendor cannot');
      assert.equal((await estimate(id, users.supervisor.token, { amount: '1200' })).status, 403, 'nor a supervisor');

      const quoted = await estimate(id, creator, { amount: '1200' });
      assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
      assert.equal(quoted.body.data.negotiation[0].from, 'vendor');
      await fillBreakdown(users, id, 1200);
      ok(await put(id, 'escalate', creator));
      ok(await put(id, 'approve', users.supervisor.token));
      const acknowledged = ok(await put(id, 'acknowledge', creator, { daysToComplete: 4 }));
      assert.equal(acknowledged.history.at(-1).by._id, users.creator.id);

      ok(await put(id, 'vehicle/sent', creator));
      ok(await put(id, 'vehicle/received', creator, { km: 5050 }));
      ok(await put(id, 'work/start', creator));
      const job = await multipart(`/tickets/${id}/additional`, creator, { description: 'The bumper bracket is cracked as well.', serviceType: 'repair', repairCategory: 'BODY', amount: '300', quotationNumber: 'Q-OUT', daysToComplete: '1' });
      assert.equal(job.status, 201, JSON.stringify(job.body));
      await fillBreakdown(users, job.body.data._id, 300);
      ok(await put(job.body.data._id, 'escalate', creator));
      ok(await put(job.body.data._id, 'approve', users.supervisor.token));
      ok(await put(id, 'work/ready', creator));
      ok(await put(id, 'vehicle/release', creator));
      ok(await put(id, 'vehicle/returned', creator, { km: 5100 }));
      const invoiced = await submitInvoice(id, users.creator, { amount: '1200' });
      assert.equal(invoiced.status, 201, JSON.stringify(invoiced.body));
      const invoice = await withDb((db) => db.collection('invoices').findOne({ ticketId: oid(id) }));
      assert.equal(String(invoice.vendorId), ticket.vendorId._id, 'the invoice is the outside vendor\'s');
      ok(await put(id, 'invoice/accept', users.supervisor.token));
    });

    test('the service creator cannot stand in for a listed vendor', async () => {
      const ticket = await raise({ serviceType: 'repair', repairCategory: 'BODY' });
      const refused = await estimate(ticket._id, users.creator.token, { amount: '500' });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.message, 'This step is for the vendor. The service creator records it only for a vendor outside the list.');
      const acknowledged = await toAcknowledged(users, ticket, users.vendor1);
      assert.equal((await put(acknowledged._id, 'vehicle/sent', users.creator.token)).status, 200);
      assert.equal((await put(acknowledged._id, 'vehicle/received', users.creator.token, { km: 5050 })).status, 403);
    });
  });

  describe('the bus', () => {
    test('has no transmission rate or interval', async () => {
      // What an older screen still sends is not read.
      const intervals = { ...busBody('x', 'x').intervals, transmission: { everyKm: 60000, lastKm: 0 } };
      const added = await createBus(users, `NOTR${(counter += 1)}`, users.vendor1.id, { make: MAKE, rates: { oil: 0.5, transmission: 1 }, intervals });
      assert.deepEqual(added.rates, { oil: 0.5 });
      assert.ok(!('transmission' in added.intervals));
      const detail = ok(await api('GET', `/buses/${added._id}`, { token: users.creator.token }));
      assert.deepEqual(Object.keys(detail.intervalStatus).sort(), ['battery', 'brakePads', 'currentKm', 'oil', 'tyre']);
    });

    test('the weekly report knows no transmission, and reports a brake-pad repair under brake pads', async () => {
      const ticket = await raise({ serviceType: 'repair', repairCategory: 'BRAKE PADS' });
      const weekly = ok(await api('GET', '/reports/weekly', { token: users.supervisor.token }));
      assert.deepEqual(Object.keys(weekly.due).sort(), ['battery', 'brakePads', 'oil', 'tyre']);
      assert.deepEqual(Object.keys(weekly.raised).sort(), ['battery', 'brakePads', 'oil', 'tyre']);
      assert.ok(weekly.raised.brakePads.some((row) => row._id === ticket._id));
    });
  });

  describe('existing data', () => {
    test('migrate-owner-testing moves old VSRs, buses and notices, writes only with --apply, and can run twice', async () => {
      const uri = process.env.MONGO_URI.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, query = '') => `/${db}_ownermigrate${query}`);
      const connection = await mongoose.createConnection(uri).asPromise();
      const db = (name) => connection.collection(name);
      try {
        await connection.dropDatabase();
        const someone = new mongoose.Types.ObjectId();
        const busId = new mongoose.Types.ObjectId();
        const base = { busId, vendorId: someone, createdBy: someone, status: 'sentToVendor', history: [], negotiation: [], createdAt: new Date() };
        await db('buses').insertOne({
          _id: busId,
          fleetNumber: 'M-1',
          rates: { oil: 0.1, transmission: 0.05 },
          intervals: { oil: { everyKm: 10000, lastKm: 0 }, transmission: { everyKm: 60000, lastKm: 0 }, tyre: { everyKm: 40000, lastKm: 0 }, brakePads: { everyKm: 40000, lastKm: 0 }, battery: { everyMonths: 18, lastDate: new Date() } },
        });
        await db('tickets').insertMany([
          { ...base, vsrNumber: 'M-T', serviceType: 'transmission', agreedPrice: { basis: 'rate', rate: 0.05, km: 60000, amount: 3000 }, intervalUsage: { unit: 'km', interval: 60000, actual: 1000, left: 59000, delayed: 0 } },
          { ...base, vsrNumber: 'M-B', serviceType: 'brakePads', intervalUsage: { unit: 'km', interval: 40000, actual: 1000, left: 39000, delayed: 0 } },
          { ...base, vsrNumber: 'M-A', serviceType: 'repair', repairCategory: 'ACCIDENT', accident: { severity: 'minor', fault: 'ourDriver' }, isBreakdown: true },
          { ...base, vsrNumber: 'M-R', serviceType: 'repair', repairCategory: 'ENGINE', isBreakdown: true },
          { ...base, vsrNumber: 'M-O', serviceType: 'oil', isBreakdown: true },
        ]);
        await db('notifications').insertMany([
          { user: someone, type: 'serviceDue', params: { service: 'transmission', fleetNumber: 'M-1' }, dedupeKey: 'due:t' },
          { user: someone, type: 'serviceDue', params: { service: 'oil', fleetNumber: 'M-1' }, dedupeKey: 'due:o' },
        ]);

        const script = join(here, '..', 'scripts', 'migrate-owner-testing.js');
        const migrate = (extra) => exec(process.execPath, [script, '--uri', uri, ...extra], { env: process.env, timeout: 60000 });
        const dry = await migrate([]);
        assert.match(dry.stdout, /Dry run on database \S+_ownermigrate/);
        assert.match(dry.stdout, /Transmission services to repairs \(Transmission\): 1/);
        assert.match(dry.stdout, /Brake-pad services to repairs \(Brake pads\): 1/);
        assert.match(dry.stdout, /Accident repairs to accidents: 1/);
        assert.match(dry.stdout, /Breakdown flags cleared on work that is not a repair: 2/);
        assert.match(dry.stdout, /Buses losing their transmission rate or interval: 1/);
        assert.match(dry.stdout, /Transmission due notices removed: 1/);
        assert.equal(await db('tickets').countDocuments({ serviceType: 'transmission' }), 1, 'a dry run writes nothing');

        const applied = await migrate(['--apply']);
        assert.match(applied.stdout, /Migrating database/);
        const byNumber = async (vsrNumber) => db('tickets').findOne({ vsrNumber });
        const transmission = await byNumber('M-T');
        assert.deepEqual([transmission.serviceType, transmission.repairCategory], ['repair', 'TRANSMISSION']);
        assert.equal(transmission.agreedPrice.amount, 3000, 'its price stays');
        assert.equal(transmission.intervalUsage.interval, 60000, 'what was measured stays');
        const pads = await byNumber('M-B');
        assert.deepEqual([pads.serviceType, pads.repairCategory, pads.intervalUsage.interval], ['repair', 'BRAKE PADS', 40000]);
        const accident = await byNumber('M-A');
        assert.equal(accident.serviceType, 'accident');
        assert.ok(!('repairCategory' in accident));
        assert.equal(accident.accident.severity, 'minor');
        assert.equal(accident.isBreakdown, false);
        assert.equal((await byNumber('M-R')).isBreakdown, true, 'a repair keeps its flag');
        assert.equal((await byNumber('M-O')).isBreakdown, false);
        const migratedBus = await db('buses').findOne({ _id: busId });
        assert.deepEqual(migratedBus.rates, { oil: 0.1 });
        assert.ok(!('transmission' in migratedBus.intervals));
        assert.deepEqual((await db('notifications').find().toArray()).map((n) => n.params.service), ['oil']);

        const twice = await migrate(['--apply']);
        for (const line of [/Transmission services to repairs \(Transmission\): 0/, /Accident repairs to accidents: 0/, /Buses losing their transmission rate or interval: 0/, /Transmission due notices removed: 0/]) assert.match(twice.stdout, line);
      } finally {
        await connection.dropDatabase();
        await connection.close();
      }
    });
  });
});
