/**
 * LPO by make (owner's request and answer, 2026-11-09). A repair and maintenance LPO names one
 * make, and repairs, brake pads, oil and transmission all come off its one amount. Tyre and
 * battery LPOs name no make and cover the whole fleet. The new VSR form shows which LPO a job
 * will come off, from the same choice the invoice is charged by, so the two cannot disagree.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, estimate, newVendor, run, signInEveryone, toInvoiceAccepted } from './helpers.js';

let users;
let counter = 0;

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const YEAR = { validFrom: '2026-01-01', validTo: '2099-12-31' };
const makeLpo = (vendorId, items, overrides = {}) => {
  counter += 1;
  return api('POST', '/lpos', { token: users.purchasing.token, body: { number: `MK-${run}-${counter}`, vendorId, ...YEAR, items, ...overrides } });
};
const RM = (amount) => [{ kind: 'repairMaintenance', name: 'Repair and maintenance', quantity: 1, unitPrice: amount }];
const TYRES = [{ kind: 'tyre', name: 'Tyre', quantity: 10, unitPrice: 800 }];
const preview = (params, token = users.creator.token) => api('GET', `/lpos/for-vsr?${new URLSearchParams(params)}`, { token });
const field = (res, name) => res.body.errors?.find((e) => e.field === name);

// Makes of this run's own, so other test files' buses and LPOs cannot match them.
const MAKE_X = `Xbus ${run}`;
const MAKE_Y = `Ybus ${run}`;

/** A vendor of its own with a bus of each make, so each test controls every LPO that could match. */
const setup = async (label) => {
  const vendor = await newVendor(`mk-${label}`);
  const x = await createBus(users, `MKX${label}`, vendor.id, { make: MAKE_X, rates: undefined });
  const y = await createBus(users, `MKY${label}`, vendor.id, { make: MAKE_Y, rates: undefined });
  return { vendor, x, y };
};

/** A repair walked to invoice acceptance, so the LPO is charged. */
const acceptedRepair = async ({ vendor }, bus, amount) => {
  const raised = ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', currentReading: 1000 } }));
  ok(await estimate(raised._id, vendor.token, { amount: String(amount) }));
  ok(await api('PUT', `/tickets/${raised._id}/breakdown`, { token: users.creator.token, body: { consumables: amount } }));
  ok(await api('PUT', `/tickets/${raised._id}/escalate`, { token: users.creator.token }));
  return toInvoiceAccepted(users, { ...raised, status: 'pending' }, vendor, { invoice: { amount: String(amount) } });
};

/** A tyre change of `quantity` tyres at AED 800, walked to invoice acceptance. */
const acceptedTyres = async ({ vendor }, bus, quantity) => {
  const raised = ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'tyre', currentReading: 1000 } }));
  ok(await estimate(raised._id, vendor.token, { amount: String(quantity * 800) }));
  ok(await api('PUT', `/tickets/${raised._id}/breakdown`, { token: users.creator.token, body: { parts: [{ name: 'Tyre', quantity, unitPrice: 800 }] } }));
  ok(await api('PUT', `/tickets/${raised._id}/escalate`, { token: users.creator.token }));
  return toInvoiceAccepted(users, { ...raised, status: 'pending' }, vendor, { invoice: { amount: String(quantity * 800) } });
};

describe('LPO by make', () => {
  before(async () => {
    users = await signInEveryone();
  });

  describe('the make on the LPO form', () => {
    test('a repair and maintenance LPO needs a make; tyre, battery and other LPOs must not have one', async () => {
      const { vendor } = await setup('VAL');
      const none = await makeLpo(vendor.id, RM(1000));
      assert.equal(none.status, 400);
      assert.deepEqual(field(none, 'make'), { field: 'make', message: 'Choose the make this LPO is for' });

      for (const items of [TYRES, [{ kind: 'battery', name: 'Battery', quantity: 5, unitPrice: 600 }], [{ kind: 'other', name: 'Cleaning', quantity: 1, unitPrice: 500 }]]) {
        const res = await makeLpo(vendor.id, items, { make: MAKE_X });
        assert.equal(res.status, 400, items[0].kind);
        assert.deepEqual(field(res, 'make'), { field: 'make', message: 'Tyre and battery LPOs cover every make. Leave the make empty.' });
      }
      const blank = await makeLpo(vendor.id, TYRES, { make: '  ' });
      assert.equal(blank.status, 201, 'spaces are no make');
      assert.equal(blank.body.data.make, undefined);

      const unknown = await makeLpo(vendor.id, RM(1000), { make: `Nobus ${run}` });
      assert.equal(unknown.status, 400);
      assert.deepEqual(unknown.body.errors, [{ field: 'make', message: 'No bus on the fleet has this make' }]);

      const long = await makeLpo(vendor.id, RM(1000), { make: 'M'.repeat(61) });
      assert.equal(field(long, 'make').message, 'Keep this to 60 characters or fewer');
    });

    test('the make matches the fleet in any letter case and is kept as the fleet spells it', async () => {
      const { vendor } = await setup('CASE');
      const res = await makeLpo(vendor.id, [...RM(1000), ...TYRES], { make: `  ${MAKE_X.toUpperCase()} ` });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.make, MAKE_X);
      const listed = ok(await api('GET', '/lpos?limit=200', { token: users.purchasing.token })).find((lpo) => lpo._id === res.body.data._id);
      assert.equal(listed.make, MAKE_X, 'the list shows the make');
      assert.equal(ok(await api('GET', `/lpos/${res.body.data._id}`, { token: users.supervisor.token })).make, MAKE_X, 'and so does the LPO');
    });

    test('the old repair and maintenance kinds are refused', async () => {
      const { vendor } = await setup('OLD');
      for (const kind of ['repair', 'maintenance']) {
        const res = await makeLpo(vendor.id, [{ kind, name: 'Old', quantity: 1, unitPrice: 100 }], { make: MAKE_X });
        assert.equal(res.status, 400, kind);
        assert.equal(field(res, 'items[0].kind').message, 'Choose what this item is for');
      }
    });
  });

  describe('which LPO a VSR comes off', () => {
    test('repairs, brake pads, oil and transmission come off the LPO for the bus\'s make, in any letter case', async () => {
      const context = await setup('MATCH');
      const forX = ok(await makeLpo(context.vendor.id, RM(50000), { make: MAKE_X }));
      const forY = ok(await makeLpo(context.vendor.id, RM(30000), { make: MAKE_Y }));
      const lower = await createBus(users, `MKZMATCH`, context.vendor.id, { make: MAKE_X.toLowerCase(), rates: undefined });

      for (const serviceType of ['repair', 'brakePads', 'oil', 'transmission']) {
        const onX = ok(await preview({ busId: context.x._id, serviceType }));
        assert.deepEqual([onX.kind, onX.status, onX.make, onX.lpo._id], ['repairMaintenance', 'found', MAKE_X, forX._id], serviceType);
        assert.equal(ok(await preview({ busId: context.y._id, serviceType })).lpo._id, forY._id, serviceType);
      }
      const cased = ok(await preview({ busId: lower._id, serviceType: 'repair' }));
      assert.equal(cased.lpo._id, forX._id, 'a bus spelt in lower case still matches');
      assert.equal(cased.make, MAKE_X.toLowerCase(), 'make is the bus\'s own');

      const charged = await acceptedRepair(context, context.y, 1200);
      assert.equal(charged.lpoDeduction.lpoNumber, forY.number);
      assert.equal(charged.lpoDeduction.kind, 'repairMaintenance');
      const after = ok(await api('GET', `/lpos/${forY._id}`, { token: users.purchasing.token }));
      assert.equal(after.items[0].usedAmount, 1200);
      assert.equal(ok(await api('GET', `/lpos/${forX._id}`, { token: users.purchasing.token })).items[0].usedAmount, 0, 'the other make is not touched');
    });

    test('tyre and battery LPOs name no make and cover every make; an LPO with a make covers only that make', async () => {
      const context = await setup('ANY');
      const tyres = ok(await makeLpo(context.vendor.id, TYRES));
      for (const bus of [context.x, context.y]) {
        const shown = ok(await preview({ busId: bus._id, serviceType: 'tyre' }));
        assert.deepEqual([shown.kind, shown.status, shown.lpo._id, shown.lpo.make], ['tyre', 'found', tyres._id, null]);
        assert.equal(shown.lpo.remainingQuantity, 10);
      }
      const battery = ok(await preview({ busId: context.x._id, serviceType: 'battery' }));
      assert.deepEqual([battery.status, battery.lpo], ['noLpo', null], 'a tyre LPO does not stand in for batteries');

      const charged = await acceptedTyres(context, context.y, 2);
      assert.equal(charged.lpoDeduction.lpoNumber, tyres.number, 'the any-make LPO is charged for either make');
      assert.equal(charged.lpoDeduction.quantity, 2);

      // A second vendor whose only tyre line sits on an LPO for one make.
      const other = await setup('ONE');
      const mixed = ok(await makeLpo(other.vendor.id, [...RM(10000), ...TYRES], { make: MAKE_X }));
      assert.equal(ok(await preview({ busId: other.x._id, serviceType: 'tyre' })).lpo._id, mixed._id);
      const offMake = ok(await preview({ busId: other.y._id, serviceType: 'tyre' }));
      assert.equal(offMake.status, 'noLpo');
    });

    test('no LPO for the vendor and make is noLpo; other work with none is not needed', async () => {
      const context = await setup('NONE');
      ok(await makeLpo(context.vendor.id, RM(5000), { make: MAKE_X }));
      const missing = ok(await preview({ busId: context.y._id, serviceType: 'oil', amount: '900' }));
      assert.deepEqual(missing, { kind: 'repairMaintenance', make: MAKE_Y, status: 'noLpo', lpo: null });
      const other = ok(await preview({ busId: context.y._id, serviceType: 'other', amount: '300' }));
      assert.deepEqual(other, { kind: 'other', make: MAKE_Y, status: 'notNeeded', lpo: null });

      const charged = await acceptedRepair(context, context.y, 700);
      assert.equal(charged.lpoDeduction.status, 'noLpo');
      assert.equal(charged.lpoDeduction.kind, 'repairMaintenance');

      const cleaning = ok(await makeLpo(context.vendor.id, [{ kind: 'other', name: 'Cleaning', quantity: 1, unitPrice: 2000 }]));
      assert.equal(ok(await preview({ busId: context.y._id, serviceType: 'other' })).lpo._id, cleaning._id, 'an Other line covers every make');
    });
  });

  describe('the preview is the charge', () => {
    test('a job that fits skips a short LPO for one with room, before and after', async () => {
      const context = await setup('FIT');
      const small = ok(await makeLpo(context.vendor.id, RM(500), { make: MAKE_X, validTo: '2098-12-31' }));
      const big = ok(await makeLpo(context.vendor.id, RM(50000), { make: MAKE_X }));

      const shown = ok(await preview({ busId: context.x._id, serviceType: 'repair', amount: '900' }));
      assert.equal(shown.lpo._id, big._id);
      assert.equal(shown.fits, true);
      assert.deepEqual([shown.lpo.number, shown.lpo.lineTotal, shown.lpo.lineRemaining, shown.lpo.remainingQuantity], [big.number, 50000, 50000, null]);
      assert.ok(shown.lpo.validFrom && shown.lpo.validTo);
      assert.equal(ok(await preview({ busId: context.x._id, serviceType: 'repair', amount: '400' })).lpo._id, small._id, 'earliest ending first when it has room');
      assert.ok(!('fits' in ok(await preview({ busId: context.x._id, serviceType: 'repair' }))), 'no amount, no fits');

      const charged = await acceptedRepair(context, context.x, 900);
      assert.equal(charged.lpoDeduction.lpo, shown.lpo._id, 'charged where the preview said');
      assert.equal(charged.lpoDeduction.overrun, false);
      const left = ok(await preview({ busId: context.x._id, serviceType: 'repair', amount: '600' }));
      assert.deepEqual([left.lpo._id, left.lpo.lineRemaining], [big._id, 49100]);
    });

    test('with no room anywhere, both say the first LPO, and that it overruns', async () => {
      const context = await setup('OVER');
      const only = ok(await makeLpo(context.vendor.id, RM(500), { make: MAKE_X }));
      const shown = ok(await preview({ busId: context.x._id, serviceType: 'oil', amount: '900' }));
      assert.deepEqual([shown.lpo._id, shown.fits], [only._id, false]);

      const charged = await acceptedRepair(context, context.x, 900);
      assert.equal(charged.lpoDeduction.lpo, only._id);
      assert.equal(charged.lpoDeduction.overrun, true);
      const after = ok(await preview({ busId: context.x._id, serviceType: 'repair', amount: '0' }));
      assert.deepEqual([after.lpo._id, after.lpo.lineRemaining, after.fits], [only._id, -400, false]);
    });

    test('tyres are matched on quantity as well as amount', async () => {
      const context = await setup('QTY');
      const fewTyres = ok(await makeLpo(context.vendor.id, [{ kind: 'tyre', name: 'Tyre', quantity: 1, unitPrice: 5000 }], { validTo: '2098-12-31' }));
      const manyTyres = ok(await makeLpo(context.vendor.id, TYRES));
      const shown = ok(await preview({ busId: context.x._id, serviceType: 'tyre', amount: '1600', quantity: '2' }));
      assert.deepEqual([shown.lpo._id, shown.fits, shown.lpo.remainingQuantity], [manyTyres._id, true, 10]);
      assert.equal(ok(await preview({ busId: context.x._id, serviceType: 'tyre', amount: '1600', quantity: '1' })).lpo._id, fewTyres._id);

      const charged = await acceptedTyres(context, context.x, 2);
      assert.equal(charged.lpoDeduction.lpo, shown.lpo._id);
    });

    test('the vendor is the bus\'s own unless another is chosen', async () => {
      const context = await setup('VEND');
      const mine = ok(await makeLpo(context.vendor.id, RM(5000), { make: MAKE_X }));
      const elsewhere = await setup('VEND2');
      const theirs = ok(await makeLpo(elsewhere.vendor.id, RM(5000), { make: MAKE_X }));
      assert.equal(ok(await preview({ busId: context.x._id, serviceType: 'repair' })).lpo._id, mine._id);
      assert.equal(ok(await preview({ busId: context.x._id, serviceType: 'repair', vendorId: elsewhere.vendor.id })).lpo._id, theirs._id);
    });
  });

  test('the preview checks what it is asked and is for the depot only', async () => {
    const { x } = await setup('CHK');
    assert.equal((await preview({ busId: x._id, serviceType: 'repair' }, users.vendor1.token)).status, 403);
    for (const token of [users.creator.token, users.supervisor.token, users.purchasing.token]) assert.equal((await preview({ busId: x._id, serviceType: 'repair' }, token)).status, 200);

    assert.equal(field(await preview({ serviceType: 'repair' }), 'busId').message, 'Choose a bus');
    assert.equal(field(await preview({ busId: x._id, serviceType: 'wash' }), 'serviceType').message, 'Choose the service type');
    assert.equal(field(await preview({ busId: x._id, serviceType: 'repair', amount: 'abc' }), 'amount').message, 'Enter an amount, 0 or more');
    assert.equal(field(await preview({ busId: x._id, serviceType: 'repair', amount: '1.234' }), 'amount').message, 'Use at most 2 decimals');
    assert.equal(field(await preview({ busId: x._id, serviceType: 'tyre', quantity: '1.5' }), 'quantity').message, 'Enter a whole number');
    assert.equal((await preview({ busId: '64b7f0c2e1d2a9b1c8a4f123', serviceType: 'repair' })).status, 404);
    const notVendor = await preview({ busId: x._id, serviceType: 'repair', vendorId: users.supervisor.id });
    assert.equal(notVendor.body.code, 'NOT_A_VENDOR');
  });
});
