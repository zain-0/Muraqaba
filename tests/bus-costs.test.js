/**
 * What a bus has cost over its whole life, for the scrap request form (owner's testing notes,
 * 2026-11-11): repair, maintenance, tyre, battery, accident and other costs, the grand total, the
 * number of repairs and accidents, the current km and the average cost per km.
 *
 * A VSR costs what the cost reports say it does: its current invoice once accepted, otherwise
 * nothing. Declined VSRs never count; a no-charge job counts AED 0. Service types are grouped so
 * the old shape (transmission, brake pads, accident as a repair category) and the new one
 * (accident as a service type, transmission as a repair category) land in the same place.
 *
 * Bus X (every figure by hand)
 *   oil                       invoice 1,000 accepted              maintenance 1,000
 *   transmission (old shape)  invoice 500.50 accepted             maintenance   500.50  → 1,500.50
 *   repair ENGINE             invoice 2,100 accepted              repair 2,100
 *     additional MECHANICAL   invoice 200 accepted                repair   200
 *     additional MECHANICAL   declined (an invoice of 999 on it)  never counts
 *   brakePads (old shape)     invoice 300 accepted                repair   300
 *   repair TRANSMISSION (new) invoice 400 accepted                repair   400
 *   repair MECHANICAL         approved 900, no invoice yet        repair     0
 *   repair BODY               no charge (warranty)                repair     0          → 3,000, 6 repairs
 *   repair ACCIDENT (old)     invoice 4,000 accepted              accident 4,000
 *   accident (new shape)      invoice 1,500 accepted              accident 1,500        → 5,500, 2 accidents
 *   tyre                      invoice 2,660 accepted              tyre 2,660
 *   battery                   invoice 650 rejected                battery    0
 *   battery                   invoice 600 accepted                battery  600
 *   other                     invoice 50.25 accepted              other     50.25
 *   Grand total 13,310.75 over 14 VSRs. Readings 50,000 (10 Jan) and 62,000 (1 Mar), entered out
 *   of order: current km 62,000, AED 0.2147 per km (13,310.75 / 62,000 = 0.21469…).
 *
 * Bus Y has a repair of 7,777 that must not reach X. Bus Z has no readings, so its current km is
 * its furthest last service (41,000). Bus W is new: no readings, every last service at 0 km.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api, newVendor, run, signInEveryone } from './helpers.js';
import { connectModels, fixture, uae } from './reportChecks.js';

let users;
let vendor;
let models;
let fx;
const bus = {};

before(async () => {
  users = await signInEveryone();
  vendor = await newVendor('bus-costs');
  models = await connectModels();
  fx = fixture(models, { prefix: `BC${run}`, creatorId: users.creator.id });
  const created = uae('2025-01-01T09:00:00');
  for (const key of ['X', 'Y', 'Z', 'W']) bus[key] = await fx.addBus(key, { make: 'Hino', created, vendor: vendor.id });

  const accepted = (amount) => [{ amount, status: 'approved' }];
  const add = (fields) => fx.addTicket({ bus: bus.X, vendor: vendor.id, created: uae('2025-06-01T10:00:00'), ...fields });
  await add({ serviceType: 'oil', approved: 1000, invoices: accepted(1000) });
  await add({ serviceType: 'transmission', approved: 500.5, invoices: accepted(500.5) });
  const engine = await add({ serviceType: 'repair', repairCategory: 'ENGINE', approved: 2100, invoices: accepted(2100) });
  await add({ serviceType: 'repair', repairCategory: 'MECHANICAL', parent: engine, approved: 200, invoices: accepted(200) });
  await add({ serviceType: 'repair', repairCategory: 'MECHANICAL', parent: engine, status: 'declined', invoices: accepted(999) });
  await add({ serviceType: 'brakePads', approved: 300, invoices: accepted(300) });
  const transmissionRepair = await add({ serviceType: 'repair', repairCategory: 'ENGINE', approved: 400, invoices: accepted(400) });
  await add({ serviceType: 'repair', repairCategory: 'MECHANICAL', approved: 900, status: 'approved' });
  await add({ serviceType: 'repair', repairCategory: 'BODY', approved: 0, noChargeReason: 'warranty' });
  await add({ serviceType: 'repair', repairCategory: 'ACCIDENT', approved: 4000, invoices: accepted(4000) });
  const accident = await add({ serviceType: 'repair', repairCategory: 'ACCIDENT', approved: 1500, invoices: accepted(1500) });
  await add({ serviceType: 'tyre', approved: 2660, invoices: accepted(2660) });
  await add({ serviceType: 'battery', approved: 600, status: 'invoiceRejected', invoices: [{ amount: 650, status: 'rejected' }] });
  await add({ serviceType: 'battery', approved: 600, invoices: accepted(600) });
  await add({ serviceType: 'other', approved: 50.25, invoices: accepted(50.25) });
  // The shapes another round of work brings in (2026-11-11), written past the schema's checks:
  // accident as a service type of its own, and transmission as a repair category.
  await models.Ticket.collection.updateOne({ _id: accident._id }, { $set: { serviceType: 'accident' }, $unset: { repairCategory: '' } });
  await models.Ticket.collection.updateOne({ _id: transmissionRepair._id }, { $set: { repairCategory: 'TRANSMISSION' } });

  await fx.addTicket({ bus: bus.Y, vendor: vendor.id, serviceType: 'repair', repairCategory: 'ENGINE', created: uae('2025-06-01T10:00:00'), approved: 7777, invoices: accepted(7777) });

  await fx.addReading(bus.X, '2026-03-01', 62000);
  await fx.addReading(bus.X, '2026-01-10', 50000);
  await models.Bus.updateOne({ _id: bus.Z._id }, { $set: { 'intervals.oil.lastKm': 30000, 'intervals.tyre.lastKm': 41000 } });
});

after(async () => {
  await fx?.cleanup();
  await mongoose.connection.close();
});

const costsOf = async (target, token = users.purchasing.token) => {
  const res = await api('GET', `/buses/${target._id}/costs`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

describe("a bus's whole-life costs", () => {
  test('each kind of work is added up from accepted invoices, old and new service types alike', async () => {
    const data = await costsOf(bus.X);
    assert.deepEqual(data.costs, { repair: 3000, maintenance: 1500.5, tyre: 2660, battery: 600, accident: 5500, other: 50.25 });
    assert.equal(data.grandTotal, 13310.75);
  });

  test('repairs and accidents are counted by VSR; a declined job never counts, a no-charge or open one does', async () => {
    const data = await costsOf(bus.X);
    assert.equal(data.repairs, 6);
    assert.equal(data.accidents, 2);
    assert.equal(data.vsrs, 14);
  });

  test('the current km is the latest daily reading, and the cost per km is the grand total over it', async () => {
    const data = await costsOf(bus.X);
    assert.equal(data.currentKm, 62000);
    assert.equal(data.kmSource, 'reading');
    assert.equal(data.costPerKm, 0.2147);
  });

  test("another bus's VSRs stay with that bus", async () => {
    const data = await costsOf(bus.Y);
    assert.deepEqual(data.costs, { repair: 7777, maintenance: 0, tyre: 0, battery: 0, accident: 0, other: 0 });
    assert.equal(data.grandTotal, 7777);
    assert.equal(data.repairs, 1);
  });

  test('with no reading, the current km is where its intervals put it; with no km at all there is no cost per km', async () => {
    const z = await costsOf(bus.Z);
    assert.equal(z.currentKm, 41000);
    assert.equal(z.kmSource, 'lastService');
    assert.equal(z.grandTotal, 0);
    assert.equal(z.costPerKm, 0);
    const w = await costsOf(bus.W);
    assert.equal(w.currentKm, 0);
    assert.equal(w.costPerKm, null);
    assert.deepEqual([w.repairs, w.accidents, w.vsrs], [0, 0, 0]);
  });

  test('the depot reads it; a vendor or someone signed out does not', async () => {
    for (const who of [users.creator, users.supervisor, users.purchasing]) assert.equal((await api('GET', `/buses/${bus.X._id}/costs`, { token: who.token })).status, 200, who.email);
    assert.equal((await api('GET', `/buses/${bus.X._id}/costs`, { token: users.vendor1.token })).status, 403);
    assert.equal((await api('GET', `/buses/${bus.X._id}/costs`)).status, 401);
  });

  test('an unknown bus is not found, and a wrong id is refused', async () => {
    assert.equal((await api('GET', `/buses/${new mongoose.Types.ObjectId()}/costs`, { token: users.creator.token })).status, 404);
    assert.equal((await api('GET', '/buses/not-an-id/costs', { token: users.creator.token })).status, 400);
  });
});
