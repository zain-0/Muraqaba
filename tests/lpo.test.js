/**
 * Item 8: purchasing writes LPOs for a vendor. Since 2026-11-10 the GRN takes each VSR off its
 * LPO line: tyres and batteries by quantity and amount, everything else by amount, off one repair
 * and maintenance line for the bus's make. A VSR raised with no line gets the automatic choice at
 * the GRN: its vendor's LPOs valid today, earliest ending first, the first with room.
 */
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, clearLpos, createBus, estimate, grnFor, newVendor, run, signInEveryone, submitInvoice, toForwarded, toVehicleReturned } from './helpers.js';

let users;
let counter = 0;

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const MAKE = `Lbus ${run}`;
const YEAR = { date: '2026-01-01', validFrom: '2026-01-01', validTo: '2099-12-31' };
const postLpo = (vendorId, items, overrides = {}, token = users.purchasing.token) => {
  counter += 1;
  return api('POST', '/lpos', { token, body: { number: `LPO-${run}-${counter}`, vendorId, ...YEAR, items, ...overrides } });
};
const makeLpo = async (...args) => ok(await postLpo(...args));
const TYRES = [{ kind: 'tyre', size: '295/80 R22.5', description: 'Rear axle', quantity: 20, unitPrice: 800 }];
const RM = (amount) => [{ kind: 'repairMaintenance', make: MAKE, unitPrice: amount }];
const getLpo = async (id) => ok(await api('GET', `/lpos/${id}`, { token: users.purchasing.token }));
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });
let reading = 0;
const raise = (bus, serviceType, extra = {}) => {
  reading += 1000; // each job further on, as an odometer only goes up
  return api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType, currentReading: reading, ...(serviceType === 'repair' ? { repairCategory: 'BODY' } : {}), ...extra } });
};

/** A vendor of its own and a bus of this file's make. */
const setup = async (label, overrides = {}) => {
  const vendor = await newVendor(`lpo-${label}`);
  const bus = await createBus(users, `L${label}`, vendor.id, { make: MAKE, rates: undefined, ...overrides });
  return { vendor, bus };
};

/** A job raised while there is no LPO for it, priced by the vendor at AED 800 a unit, walked to purchasing. */
const forwardedWithoutLine = async ({ vendor, bus }, serviceType, quantity, invoiceAmount) => {
  const raised = ok(await raise(bus, serviceType));
  assert.equal(raised.lpoLine, undefined);
  ok(await estimate(raised._id, vendor.token, { amount: String(quantity * 800) }));
  ok(await put(raised._id, 'breakdown', users.creator.token, { parts: [{ name: serviceType, quantity, unitPrice: 800 }] }));
  ok(await put(raised._id, 'escalate', users.creator.token));
  return toForwarded(users, { ...raised, status: 'pending' }, vendor, { invoice: { amount: String(invoiceAmount) } });
};

/** Purchasing's GRN for one VSR, and the VSR as it then is. */
const onGrn = async (ticket, label) => {
  ok(await grnFor(users, ticket._id, label));
  return ok(await api('GET', `/tickets/${ticket._id}`, { token: users.supervisor.token }));
};

describe('LPO', () => {
  before(async () => {
    users = await signInEveryone();
    await createBus(users, 'LMAKE', users.vendor1.id, { make: MAKE });
  });
  beforeEach(clearLpos);
  after(clearLpos);

  test('purchasing creates it, it adds up, and only the depot can read it', async () => {
    const res = await postLpo(users.vendor1.id, [...TYRES, { kind: 'battery', size: '12V', quantity: 10, unitPrice: 500 }]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const lpo = res.body.data;
    assert.equal(lpo.items[0].total, 16000);
    assert.equal(lpo.items[1].total, 5000);
    assert.equal(lpo.grandTotal, 21000);
    assert.equal(lpo.usedAmount, 0);
    assert.equal(lpo.items[0].remainingQuantity, 20);
    assert.equal(lpo.items[0].remainingAmount, 16000);

    assert.equal((await postLpo(users.vendor1.id, TYRES, {}, users.creator.token)).status, 403);
    assert.equal((await api('GET', '/lpos', { token: users.creator.token })).status, 200);
    assert.equal((await api('GET', '/lpos', { token: users.supervisor.token })).status, 200);
    assert.equal((await api('GET', '/lpos', { token: users.vendor1.token })).status, 403);
    assert.equal((await api('GET', `/lpos/${lpo._id}`, { token: users.vendor1.token })).status, 403);

    assert.equal((await postLpo(users.vendor1.id, TYRES, { number: lpo.number })).status, 409);
  });

  test('bad forms are refused', async () => {
    const field = async (vendorId, overrides) => (await postLpo(vendorId, overrides?.items ?? TYRES, overrides)).body.errors?.[0]?.field;
    assert.equal(await field(users.vendor1.id, { items: [] }), 'items');
    assert.equal(await field(users.vendor1.id, { items: [{ ...TYRES[0], kind: 'wheel' }] }), 'items[0].kind');
    assert.equal(await field(users.vendor1.id, { items: [{ ...TYRES[0], quantity: 0 }] }), 'items[0].quantity');
    assert.equal(await field(users.vendor1.id, { number: '' }), 'number');
    assert.equal(await field(users.vendor1.id, { validTo: '2020-01-01' }), 'validTo');
    assert.equal((await postLpo(users.supervisor.id, TYRES)).status, 400, 'not a vendor');
  });

  test('a tyre change takes quantity and amount off its line, at the GRN only', async () => {
    const context = await setup('TYRE');
    const lpo = await makeLpo(context.vendor.id, TYRES);
    const raised = ok(await raise(context.bus, 'tyre', { lpoItemId: lpo.items[0]._id, quantity: 2 }));
    await toVehicleReturned(users, raised, context.vendor);
    ok(await submitInvoice(raised._id, context.vendor, { amount: '1600' }));
    ok(await put(raised._id, 'invoice/reject', users.supervisor.token, { reason: 'Wrong amount' }));
    ok(await submitInvoice(raised._id, context.vendor, { amount: '1550', invoiceNumber: `INV-${run}-T2` }));
    const accepted = ok(await put(raised._id, 'invoice/accept', users.supervisor.token));
    assert.equal(accepted.lpoDeduction, undefined, 'accepting the invoice takes nothing');
    assert.equal((await getLpo(lpo._id)).usedAmount, 0);
    ok(await put(raised._id, 'invoice/received', users.creator.token));
    ok(await put(raised._id, 'forward', users.creator.token));

    const charged = await onGrn(raised, 'TYRE');
    assert.deepEqual(
      [charged.lpoDeduction.status, charged.lpoDeduction.lpoNumber, charged.lpoDeduction.kind, charged.lpoDeduction.quantity, charged.lpoDeduction.amount, charged.lpoDeduction.overrun],
      ['deducted', lpo.number, 'tyre', 2, 1550, false],
      'the real invoice figure'
    );
    const after = await getLpo(lpo._id);
    assert.deepEqual([after.items[0].usedQuantity, after.items[0].usedAmount, after.items[0].remainingQuantity, after.items[0].remainingAmount, after.usedAmount], [2, 1550, 18, 14450, 1550]);
    assert.equal(after.usage.length, 1, 'the LPO lists what used it');
    assert.deepEqual([after.usage[0].vsrNumber, after.usage[0].quantity], [raised.vsrNumber, 2]);

    const vendorView = await api('GET', `/tickets/${raised._id}`, { token: context.vendor.token });
    assert.ok(!('lpoDeduction' in vendorView.body.data) && !('lpoLine' in vendorView.body.data));
  });

  test('batteries use their own line, and repairs take the amount only', async () => {
    const context = await setup('MIX');
    const lpo = await makeLpo(context.vendor.id, [...TYRES, { kind: 'battery', size: '12V', quantity: 10, unitPrice: 800 }, ...RM(50000)]);
    const line = (kind) => lpo.items.find((item) => item.kind === kind)._id;
    const battery = ok(await raise(context.bus, 'battery', { lpoItemId: line('battery'), quantity: 1 }));
    const repair = ok(await raise(context.bus, 'repair', { lpoItemId: line('repairMaintenance'), estimatedAmount: 1000 }));
    await toForwarded(users, battery, context.vendor, { invoice: { amount: '800' } });
    await toForwarded(users, repair, context.vendor, { invoice: { amount: '1200' } });
    ok(await grnFor(users, [battery._id, repair._id], 'MIX'));
    const read = async (id) => ok(await api('GET', `/tickets/${id}`, { token: users.supervisor.token })).lpoDeduction;
    assert.deepEqual([(await read(battery._id)).kind, (await read(battery._id)).quantity], ['battery', 1]);
    assert.deepEqual([(await read(repair._id)).kind, (await read(repair._id)).quantity, (await read(repair._id)).amount], ['repairMaintenance', 0, 1200]);

    const after = await getLpo(lpo._id);
    const of = (kind) => after.items.find((i) => i.kind === kind);
    assert.equal(of('tyre').usedAmount, 0);
    assert.deepEqual([of('battery').usedQuantity, of('battery').usedAmount], [1, 800]);
    assert.deepEqual([of('repairMaintenance').usedQuantity, of('repairMaintenance').usedAmount, of('repairMaintenance').remainingAmount], [0, 1200, 48800]);
    assert.equal(after.usedAmount, 2000);
  });

  describe('a VSR raised with no line gets the automatic choice at the GRN', () => {
    test('only its vendor\'s LPOs, only in date, the earliest ending first', async () => {
      const context = await setup('DATE');
      const other = await setup('OTHERV');
      const forwarded = await forwardedWithoutLine(context, 'tyre', 1, 800);
      const rival = await makeLpo(other.vendor.id, TYRES);
      const expired = await makeLpo(context.vendor.id, TYRES, { validFrom: '2024-01-01', validTo: '2024-12-31' });
      const later = await makeLpo(context.vendor.id, TYRES, { validTo: '2099-12-31' });
      const sooner = await makeLpo(context.vendor.id, TYRES, { validTo: '2098-12-31' });
      const done = await onGrn(forwarded, 'DATE');
      assert.equal(done.lpoDeduction.lpoNumber, sooner.number);
      for (const untouched of [rival, expired, later]) assert.equal((await getLpo(untouched._id)).usedAmount, 0);
    });

    test('an LPO with room, counting what is booked on it, is used before overrunning the first', async () => {
      const context = await setup('NEXT');
      const forwarded = await forwardedWithoutLine(context, 'tyre', 2, 1600);
      const small = await makeLpo(context.vendor.id, [{ ...TYRES[0], quantity: 5 }], { validTo: '2098-12-31' });
      const big = await makeLpo(context.vendor.id, TYRES, { validTo: '2099-12-31' });
      ok(await raise(context.bus, 'tyre', { lpoItemId: small.items[0]._id, quantity: 4 })); // books 4 of its 5
      const done = await onGrn(forwarded, 'NEXT');
      assert.deepEqual([done.lpoDeduction.lpoNumber, done.lpoDeduction.overrun], [big.number, false]);
      assert.equal((await getLpo(small._id)).usedAmount, 0);
    });

    test('a short LPO is charged and flagged, and the GRN still goes through', async () => {
      const context = await setup('SHORT');
      const forwarded = await forwardedWithoutLine(context, 'tyre', 2, 1600);
      const lpo = await makeLpo(context.vendor.id, [{ ...TYRES[0], quantity: 1 }]);
      const done = await onGrn(forwarded, 'SHORT');
      assert.deepEqual([done.status, done.lpoDeduction.status, done.lpoDeduction.overrun], ['grnCreated', 'deducted', true]);
      const after = await getLpo(lpo._id);
      assert.deepEqual([after.items[0].remainingQuantity, after.items[0].remainingAmount], [-1, -800]);
      const notice = ok(await api('GET', '/notifications', { token: users.purchasing.token })).find((n) => n.type === 'lpoProblem' && n.params.vsrNumber === forwarded.vsrNumber);
      assert.deepEqual(notice.params, { vsrNumber: forwarded.vsrNumber, problem: 'short', lpoNumber: lpo.number, kind: 'tyre' });
    });

    test('with no LPO at all it is recorded, so someone can look', async () => {
      const context = await setup('NONE');
      const forwarded = await forwardedWithoutLine(context, 'tyre', 1, 800);
      const done = await onGrn(forwarded, 'NONE');
      assert.deepEqual([done.status, done.lpoDeduction.status, done.lpoDeduction.kind], ['grnCreated', 'noLpo', 'tyre']);
    });
  });

  describe('oil and transmission', () => {
    /** A bus with rates, so these VSRs are priced from the bus and skip the estimates. */
    const pricedBus = (label) => setup(label, { rates: { oil: 0.1, transmission: 0.05 } });
    const service = async ({ vendor, bus }, serviceType, amount, extra = {}) => {
      const raised = ok(await raise(bus, serviceType, extra));
      assert.equal(raised.status, 'pending', 'priced from the rate on the bus');
      return toForwarded(users, raised, vendor, { invoice: { amount: String(amount) } });
    };

    test('both take the price off the repair and maintenance line for the bus make, and never a quantity', async () => {
      const context = await pricedBus('MNT');
      const tyres = await makeLpo(context.vendor.id, TYRES);
      const maintenance = await makeLpo(context.vendor.id, RM(50000));
      const lpoItemId = maintenance.items[0]._id;
      const oil = await onGrn(await service(context, 'oil', 900, { lpoItemId }), 'MNT1');
      assert.deepEqual([oil.lpoDeduction.status, oil.lpoDeduction.lpoNumber, oil.lpoDeduction.kind, oil.lpoDeduction.quantity, oil.lpoDeduction.amount], ['deducted', maintenance.number, 'repairMaintenance', 0, 900]);
      const transmission = await onGrn(await service(context, 'transmission', 3000, { lpoItemId }), 'MNT2');
      assert.equal(transmission.lpoDeduction.lpoNumber, maintenance.number);

      const after = await getLpo(maintenance._id);
      assert.deepEqual([after.items[0].usedAmount, after.items[0].usedQuantity, after.items[0].remainingAmount, after.usage.length], [3900, 0, 46100, 2]);
      assert.equal((await getLpo(tyres._id)).usedAmount, 0, 'a tyre LPO is not touched');
    });

    test('with only a tyre LPO there is no line for it, and the GRN flags it', async () => {
      const context = await pricedBus('MNO');
      await makeLpo(context.vendor.id, TYRES);
      const done = await onGrn(await service(context, 'oil', 900), 'MNO');
      assert.deepEqual([done.lpoDeduction.status, done.lpoDeduction.kind], ['noLpo', 'repairMaintenance']);
    });

    test('a repair and maintenance LPO written too small is charged and flagged at the GRN', async () => {
      const context = await pricedBus('MNS');
      const forwarded = await service(context, 'oil', 900);
      await makeLpo(context.vendor.id, RM(500));
      const done = await onGrn(forwarded, 'MNS');
      assert.deepEqual([done.status, done.lpoDeduction.overrun], ['grnCreated', true]);
    });
  });
});
