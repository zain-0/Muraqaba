/**
 * LPO by make (owner's request, 2026-11-09), with the make on each line since 2026-11-10, so one
 * LPO can hold repair and maintenance for several makes. Repairs, brake pads, oil and transmission
 * come off the line for the bus's make, in any letter case; tyre and battery lines cover every
 * make. The new VSR form lists the lines a job can come off, and the GRN's automatic choice for a
 * VSR with no line follows the same makes.
 */
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api, clearLpos, createBus, estimate, grnFor, newVendor, run, signInEveryone, testDb, toForwarded } from './helpers.js';

let users;
let counter = 0;

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const YEAR = { date: '2026-01-01', validFrom: '2026-01-01', validTo: '2099-12-31' };
const makeLpo = async (vendorId, items, overrides = {}) => {
  counter += 1;
  return ok(await api('POST', '/lpos', { token: users.purchasing.token, body: { number: `MK-${run}-${counter}`, vendorId, ...YEAR, items, ...overrides } }));
};
const RM = (make, amount = 5000) => ({ kind: 'repairMaintenance', make, unitPrice: amount });
const TYRES = { kind: 'tyre', size: '295/80 R22.5', quantity: 10, unitPrice: 800 };
const BATTERIES = { kind: 'battery', size: '12V', quantity: 10, unitPrice: 600 };
const preview = (params, token = users.creator.token) => api('GET', `/lpos/for-vsr?${new URLSearchParams(params)}`, { token });
const field = (res, name) => res.body.errors?.find((e) => e.field === name);

// Makes of this run's own, so other test files' buses cannot match them.
const MAKE_X = `Xbus ${run}`;
const MAKE_Y = `Ybus ${run}`;

/** A vendor of its own with a bus of each make. */
const setup = async (label) => {
  const vendor = await newVendor(`mk-${label}`);
  const x = await createBus(users, `MKX${label}`, vendor.id, { make: MAKE_X, rates: undefined });
  const y = await createBus(users, `MKY${label}`, vendor.id, { make: MAKE_Y, rates: undefined });
  return { vendor, x, y };
};

/** A repair raised while there is no LPO for it, walked to purchasing. */
const forwardedRepair = async ({ vendor }, bus, amount) => {
  const raised = ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', currentReading: 1000 } }));
  ok(await estimate(raised._id, vendor.token, { amount: String(amount) }));
  ok(await api('PUT', `/tickets/${raised._id}/breakdown`, { token: users.creator.token, body: { consumables: amount } }));
  ok(await api('PUT', `/tickets/${raised._id}/escalate`, { token: users.creator.token }));
  return toForwarded(users, { ...raised, status: 'pending' }, vendor, { invoice: { amount: String(amount) } });
};

describe('LPO by make', () => {
  before(async () => {
    users = await signInEveryone();
  });
  beforeEach(clearLpos);
  after(clearLpos);

  test('one LPO can hold a line for each make, kept as the fleet spells it', async () => {
    const { vendor } = await setup('CASE');
    const lpo = await makeLpo(vendor.id, [RM(`  ${MAKE_X.toUpperCase()} `), RM(MAKE_Y.toLowerCase(), 3000)]);
    assert.deepEqual(lpo.items.map((item) => item.make), [MAKE_X, MAKE_Y]);
    const listed = ok(await api('GET', '/lpos?limit=200', { token: users.purchasing.token })).find((row) => row._id === lpo._id);
    assert.deepEqual(listed.items.map((item) => item.make), [MAKE_X, MAKE_Y], 'the list shows each line\'s make');
    assert.equal(listed.make, undefined, 'the LPO itself names none');
  });

  test('repairs, brake pads, oil and transmission are raised against the line for the bus\'s make, in any letter case', async () => {
    const context = await setup('MATCH');
    const lpo = await makeLpo(context.vendor.id, [RM(MAKE_X), RM(MAKE_Y, 3000), TYRES]);
    const [forX, forY] = lpo.items;
    const lower = await createBus(users, 'MKZMATCH', context.vendor.id, { make: MAKE_X.toLowerCase(), rates: undefined });
    for (const serviceType of ['repair', 'brakePads', 'oil', 'transmission']) {
      const onX = ok(await preview({ busId: context.x._id, serviceType }));
      assert.deepEqual([onX.kind, onX.status, onX.make, onX.lines.map((line) => line.item._id)], ['repairMaintenance', 'found', MAKE_X, [forX._id]], serviceType);
      assert.deepEqual(ok(await preview({ busId: context.y._id, serviceType })).lines.map((line) => line.item._id), [forY._id], serviceType);
    }
    const cased = ok(await preview({ busId: lower._id, serviceType: 'repair' }));
    assert.deepEqual([cased.make, cased.lines.map((line) => line.item._id)], [MAKE_X.toLowerCase(), [forX._id]], 'a bus spelt in lower case still matches');

    const refused = await api('POST', '/tickets', { token: users.creator.token, body: { busId: context.y._id, serviceType: 'repair', repairCategory: 'BODY', currentReading: 1000, estimatedAmount: 100, lpoItemId: forX._id } });
    assert.equal(field(refused, 'lpoItemId').message, 'This LPO cannot be used for this job', 'not another make\'s line');
  });

  test('tyre and battery lines cover every make', async () => {
    const context = await setup('ANY');
    const lpo = await makeLpo(context.vendor.id, [RM(MAKE_X), TYRES]);
    for (const bus of [context.x, context.y]) {
      const shown = ok(await preview({ busId: bus._id, serviceType: 'tyre' }));
      assert.deepEqual([shown.kind, shown.status, shown.lines.map((line) => line.item._id), shown.lines[0].item.make], ['tyre', 'found', [lpo.items[1]._id], null]);
      assert.deepEqual(shown.lines[0].balance.available, { amount: 8000, quantity: 10 });
    }
    assert.deepEqual(ok(await preview({ busId: context.x._id, serviceType: 'battery' })), { kind: 'battery', make: MAKE_X, status: 'noLpo', lines: [] }, 'a tyre line does not stand in for batteries');
    await makeLpo(context.vendor.id, [BATTERIES]);
    assert.equal(ok(await preview({ busId: context.y._id, serviceType: 'battery' })).status, 'found');
  });

  test('the automatic choice at the GRN follows the line\'s make too', async () => {
    const context = await setup('AUTO');
    const onY = await forwardedRepair(context, context.y, 1200);
    const lpo = await makeLpo(context.vendor.id, [RM(MAKE_X), RM(MAKE_Y, 3000)]);
    ok(await grnFor(users, onY._id, 'MKAUTO'));
    const charged = ok(await api('GET', `/tickets/${onY._id}`, { token: users.purchasing.token })).lpoDeduction;
    assert.deepEqual([charged.lpoNumber, String(charged.item), charged.kind], [lpo.number, lpo.items[1]._id, 'repairMaintenance']);
    const after = ok(await api('GET', `/lpos/${lpo._id}`, { token: users.purchasing.token }));
    assert.deepEqual(after.items.map((item) => item.usedAmount), [0, 1200], 'the other make\'s line is not touched');
  });

  test('an older repair and maintenance line with no make covers every make at the GRN, but cannot be chosen when raising', async () => {
    const context = await setup('NOMAKE');
    const forwarded = await forwardedRepair(context, context.x, 700);
    const connection = await testDb();
    const lpoId = new mongoose.Types.ObjectId();
    try {
      await connection.collection('lpos').insertOne({
        _id: lpoId, number: `MK-${run}-OLD`, vendor: new mongoose.Types.ObjectId(context.vendor.id), validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), grandTotal: 5000, usedAmount: 0, createdBy: new mongoose.Types.ObjectId(users.purchasing.id),
        items: [{ _id: new mongoose.Types.ObjectId(), kind: 'repairMaintenance', name: 'Repair and maintenance', quantity: 1, unitPrice: 5000, total: 5000, usedQuantity: 0, usedAmount: 0 }],
      });
    } finally {
      await connection.close();
    }
    assert.equal(ok(await preview({ busId: context.x._id, serviceType: 'repair' })).status, 'noLpo');
    ok(await grnFor(users, forwarded._id, 'MKOLD'));
    assert.equal(ok(await api('GET', `/tickets/${forwarded._id}`, { token: users.purchasing.token })).lpoDeduction.lpoNumber, `MK-${run}-OLD`);
  });

  test('the form\'s list checks what it is asked and is for the depot only', async () => {
    const { x } = await setup('CHK');
    assert.equal((await preview({ busId: x._id, serviceType: 'repair' }, users.vendor1.token)).status, 403);
    for (const token of [users.creator.token, users.supervisor.token, users.purchasing.token]) assert.equal((await preview({ busId: x._id, serviceType: 'repair' }, token)).status, 200);
    assert.equal(field(await preview({ serviceType: 'repair' }), 'busId').message, 'Choose a bus');
    assert.equal(field(await preview({ busId: x._id, serviceType: 'wash' }), 'serviceType').message, 'Choose the service type');
    assert.equal(field(await preview({ busId: x._id, serviceType: 'repair', ticketId: 'x' }), 'ticketId').message, 'Choose a valid VSR');
    assert.equal((await preview({ busId: '64b7f0c2e1d2a9b1c8a4f123', serviceType: 'repair' })).status, 404);
  });
});
