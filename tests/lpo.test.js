/**
 * Item 8: purchasing writes LPOs for a vendor. Tyre and battery VSRs take quantity and amount
 * off the vendor's current LPO when the supervisor accepts the invoice; repairs take amount only.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, estimate, newVendor, run, signInEveryone, submitInvoice, toInvoiceAccepted, toVehicleReturned } from './helpers.js';

let users;
let counter = 0;

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const YEAR = { validFrom: '2026-01-01', validTo: '2099-12-31' };
const makeLpo = (vendorId, items, overrides = {}, token = users.purchasing.token) => {
  counter += 1;
  return api('POST', '/lpos', { token, body: { number: `LPO-${run}-${counter}`, vendorId, ...YEAR, items, ...overrides } });
};
const TYRES = [{ kind: 'tyre', name: 'Tyre 295/80', description: 'Rear axle', quantity: 20, unitPrice: 800 }];
const getLpo = async (id) => ok(await api('GET', `/lpos/${id}`, { token: users.purchasing.token }));

/** A vendor of its own, so each test starts with no LPOs for that vendor. */
const setup = async (label) => {
  const vendor = await newVendor(`lpo-${label}`);
  const bus = await createBus(users, `L${label}`, vendor.id, { rates: undefined });
  return { vendor, bus };
};

/** A tyre or battery VSR whose breakdown lists this many at AED 800, walked up to invoice acceptance. */
const acceptedChange = async ({ vendor, bus }, serviceType, quantity, invoiceAmount) => {
  const raised = ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType, currentReading: 1000 } }));
  ok(await estimate(raised._id, vendor.token, { amount: String(quantity * 800) }));
  ok(await api('PUT', `/tickets/${raised._id}/breakdown`, { token: users.creator.token, body: { parts: [{ name: serviceType, quantity, unitPrice: 800 }] } }));
  ok(await api('PUT', `/tickets/${raised._id}/escalate`, { token: users.creator.token }));
  return toInvoiceAccepted(users, { ...raised, status: 'pending' }, vendor, { invoice: { amount: String(invoiceAmount) } });
};

describe('LPO', () => {
  before(async () => {
    users = await signInEveryone();
  });

  test('purchasing creates it, it adds up, and only the depot can read it', async () => {
    const res = await makeLpo(users.vendor1.id, [...TYRES, { kind: 'battery', name: 'Battery 12V', quantity: 10, unitPrice: 500 }]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const lpo = res.body.data;
    assert.equal(lpo.items[0].total, 16000);
    assert.equal(lpo.items[1].total, 5000);
    assert.equal(lpo.grandTotal, 21000);
    assert.equal(lpo.usedAmount, 0);
    assert.equal(lpo.items[0].remainingQuantity, 20);
    assert.equal(lpo.items[0].remainingAmount, 16000);

    assert.equal((await makeLpo(users.vendor1.id, TYRES, {}, users.creator.token)).status, 403);
    assert.equal((await api('GET', '/lpos', { token: users.creator.token })).status, 200);
    assert.equal((await api('GET', '/lpos', { token: users.supervisor.token })).status, 200);
    assert.equal((await api('GET', '/lpos', { token: users.vendor1.token })).status, 403);
    assert.equal((await api('GET', `/lpos/${lpo._id}`, { token: users.vendor1.token })).status, 403);

    const same = await makeLpo(users.vendor1.id, TYRES, { number: lpo.number });
    assert.equal(same.status, 409);
  });

  test('bad forms are refused', async () => {
    const field = async (body, overrides) => (await makeLpo(body, overrides?.items ?? TYRES, overrides)).body.errors?.[0]?.field;
    assert.equal(await field(users.vendor1.id, { items: [] }), 'items');
    assert.equal(await field(users.vendor1.id, { items: [{ ...TYRES[0], kind: 'wheel' }] }), 'items[0].kind');
    assert.equal(await field(users.vendor1.id, { items: [{ ...TYRES[0], quantity: 0 }] }), 'items[0].quantity');
    assert.equal(await field(users.vendor1.id, { items: [{ ...TYRES[0], name: '' }] }), 'items[0].name');
    assert.equal(await field(users.vendor1.id, { number: '' }), 'number');
    assert.equal(await field(users.vendor1.id, { validTo: '2020-01-01' }), 'validTo');
    assert.equal((await makeLpo(users.supervisor.id, TYRES)).status, 400, 'not a vendor');
  });

  test('a tyre change takes quantity and amount, and only when the invoice is accepted', async () => {
    const context = await setup('TYRE');
    const lpo = ok(await makeLpo(context.vendor.id, TYRES));

    const raised = ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: context.bus._id, serviceType: 'tyre', currentReading: 1000 } }));
    ok(await estimate(raised._id, context.vendor.token, { amount: '1600' }));
    ok(await api('PUT', `/tickets/${raised._id}/breakdown`, { token: users.creator.token, body: { parts: [{ name: 'Tyre', quantity: 2, unitPrice: 800 }] } }));
    ok(await api('PUT', `/tickets/${raised._id}/escalate`, { token: users.creator.token }));
    await toVehicleReturned(users, { ...raised, status: 'pending' }, context.vendor);
    ok(await submitInvoice(raised._id, context.vendor, { amount: '1600' }));
    assert.equal((await getLpo(lpo._id)).usedAmount, 0, 'nothing is taken before acceptance');

    ok(await api('PUT', `/tickets/${raised._id}/invoice/reject`, { token: users.supervisor.token, body: { reason: 'Wrong amount' } }));
    assert.equal((await getLpo(lpo._id)).usedAmount, 0, 'nor on a rejection');

    ok(await submitInvoice(raised._id, context.vendor, { amount: '1550', invoiceNumber: `INV-${run}-T2` }));
    const accepted = ok(await api('PUT', `/tickets/${raised._id}/invoice/accept`, { token: users.supervisor.token }));
    assert.equal(accepted.lpoDeduction.status, 'deducted');
    assert.equal(accepted.lpoDeduction.lpoNumber, lpo.number);
    assert.equal(accepted.lpoDeduction.kind, 'tyre');
    assert.equal(accepted.lpoDeduction.quantity, 2);
    assert.equal(accepted.lpoDeduction.amount, 1550, 'the real invoice figure');
    assert.equal(accepted.lpoDeduction.overrun, false);

    const after = await getLpo(lpo._id);
    assert.equal(after.items[0].usedQuantity, 2);
    assert.equal(after.items[0].usedAmount, 1550);
    assert.equal(after.items[0].remainingQuantity, 18);
    assert.equal(after.items[0].remainingAmount, 14450);
    assert.equal(after.usedAmount, 1550);
    assert.equal(after.usage.length, 1, 'the LPO lists what used it');
    assert.equal(after.usage[0].vsrNumber, raised.vsrNumber);
    assert.equal(after.usage[0].quantity, 2);

    const vendorView = await api('GET', `/tickets/${raised._id}`, { token: context.vendor.token });
    assert.ok(!('lpoDeduction' in vendorView.body.data));
  });

  test('batteries use their own line, and repairs take the amount only', async () => {
    const context = await setup('MIX');
    const lpo = ok(
      await makeLpo(context.vendor.id, [
        ...TYRES,
        { kind: 'battery', name: 'Battery', quantity: 10, unitPrice: 800 },
        { kind: 'repair', name: 'Repairs', quantity: 1, unitPrice: 50000 },
      ])
    );
    const battery = await acceptedChange(context, 'battery', 1, 800);
    assert.equal(battery.lpoDeduction.kind, 'battery');

    const repair = ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: context.bus._id, serviceType: 'repair', repairCategory: 'BODY', currentReading: 1000 } }));
    ok(await estimate(repair._id, context.vendor.token, { amount: '1200' }));
    ok(await api('PUT', `/tickets/${repair._id}/breakdown`, { token: users.creator.token, body: { parts: [{ name: 'Seal', quantity: 3, unitPrice: 400 }] } }));
    ok(await api('PUT', `/tickets/${repair._id}/escalate`, { token: users.creator.token }));
    const done = await toInvoiceAccepted(users, { ...repair, status: 'pending' }, context.vendor, { invoice: { amount: '1200' } });
    assert.equal(done.lpoDeduction.kind, 'repair');
    assert.equal(done.lpoDeduction.quantity, 0);

    const after = await getLpo(lpo._id);
    const line = (kind) => after.items.find((i) => i.kind === kind);
    assert.equal(line('tyre').usedAmount, 0);
    assert.equal(line('battery').usedQuantity, 1);
    assert.equal(line('battery').usedAmount, 800);
    assert.equal(line('repair').usedQuantity, 0);
    assert.equal(line('repair').usedAmount, 1200);
    assert.equal(line('repair').remainingAmount, 48800);
    assert.equal(after.usedAmount, 2000);
  });

  test('only that vendor, only LPOs in date, earliest ending first, and next year uses the new one', async () => {
    const context = await setup('DATE');
    const other = await setup('OTHERV');
    const rival = ok(await makeLpo(other.vendor.id, TYRES));
    const expired = ok(await makeLpo(context.vendor.id, TYRES, { validFrom: '2024-01-01', validTo: '2024-12-31' }));
    const later = ok(await makeLpo(context.vendor.id, TYRES, { validTo: '2099-12-31' }));
    const sooner = ok(await makeLpo(context.vendor.id, TYRES, { validTo: '2098-12-31' }));

    const done = await acceptedChange(context, 'tyre', 1, 800);
    assert.equal(done.lpoDeduction.lpoNumber, sooner.number);
    assert.equal((await getLpo(rival._id)).usedAmount, 0);
    assert.equal((await getLpo(expired._id)).usedAmount, 0);
    assert.equal((await getLpo(later._id)).usedAmount, 0);
  });

  test('a short LPO warns and shows the overrun, and the invoice still goes through', async () => {
    const context = await setup('SHORT');
    const lpo = ok(await makeLpo(context.vendor.id, [{ kind: 'tyre', name: 'Tyre', quantity: 1, unitPrice: 800 }]));
    const done = await acceptedChange(context, 'tyre', 2, 1600);
    assert.equal(done.status, 'invoiceAccepted');
    assert.equal(done.lpoDeduction.status, 'deducted');
    assert.equal(done.lpoDeduction.overrun, true);
    const after = await getLpo(lpo._id);
    assert.equal(after.items[0].remainingQuantity, -1);
    assert.equal(after.items[0].remainingAmount, -800);
  });

  test('a second LPO with room is used before overrunning the first', async () => {
    const context = await setup('NEXT');
    const small = ok(await makeLpo(context.vendor.id, [{ kind: 'tyre', name: 'Tyre', quantity: 1, unitPrice: 800 }], { validTo: '2098-12-31' }));
    const big = ok(await makeLpo(context.vendor.id, TYRES, { validTo: '2099-12-31' }));
    const done = await acceptedChange(context, 'tyre', 2, 1600);
    assert.equal(done.lpoDeduction.lpoNumber, big.number);
    assert.equal(done.lpoDeduction.overrun, false);
    assert.equal((await getLpo(small._id)).usedAmount, 0);
  });

  test('no LPO is recorded, and services without an LPO kind take nothing', async () => {
    const context = await setup('NONE');
    const none = await acceptedChange(context, 'tyre', 1, 800);
    assert.equal(none.status, 'invoiceAccepted');
    assert.equal(none.lpoDeduction.status, 'noLpo');

    const priced = await setup('OIL');
    await api('PUT', `/buses/${priced.bus._id}`, { token: users.creator.token, body: { ...priced.bus, vendorId: undefined, registrationExpiry: '2030-06-30', rates: { oil: 1 }, intervals: { oil: { everyKm: 1000, lastKm: 0 }, transmission: { everyKm: 1000, lastKm: 0 }, tyre: { everyKm: 1000, lastKm: 0 }, battery: { everyMonths: 18, lastDate: '2026-01-01' } } } });
    ok(await makeLpo(priced.vendor.id, TYRES));
    const oil = ok(await api('POST', '/tickets', { token: users.creator.token, body: { busId: priced.bus._id, serviceType: 'oil', currentReading: 900 } }));
    const done = await toInvoiceAccepted(users, oil, priced.vendor);
    assert.equal(done.lpoDeduction, undefined);
  });
});
