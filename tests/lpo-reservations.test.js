/**
 * LPO items, reservations and balances (client's document and owner's answers, 2026-11-10).
 * Purchasing enters dated LPOs whose lines are Repair & Maintenance of one make, a tyre size or a
 * battery type. The creator picks the line when raising a VSR; its vendor does the work; the
 * amount (and quantity) is booked on the line, follows the approved amount, and the GRN deducts
 * the invoice in its place. Raising past what is left is refused; later increases are flagged.
 */
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import mongoose from 'mongoose';
import { api, clearLpos, createBus, estimate, fillBreakdown, fromAcknowledgedToReturned, grnFor, multipart, newVendor, run, signInEveryone, testDb, toAcknowledged, toForwarded, toVehicleReturned } from './helpers.js';
import { balanceOf, reservedAmount, unitsOf } from '../utils/lpoBalance.js';

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);

let users;
let counter = 0;

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const firstError = (res) => res.body.errors?.[0];

// Makes of this file's own, so no other file's buses or LPOs can match them.
const MAKE = `Rbus ${run}`;
const OTHER_MAKE = `Qbus ${run}`;
const SIZE = 'R22.5 80-295';
const YEAR = { date: '2026-01-01', validFrom: '2026-01-01', validTo: '2099-12-31' };
const RM = (amount, make = MAKE) => ({ kind: 'repairMaintenance', make, unitPrice: amount });
const TYRE = (quantity, unitPrice, extra = {}) => ({ kind: 'tyre', size: SIZE, quantity, unitPrice, ...extra });
const BATTERY = (quantity, unitPrice) => ({ kind: 'battery', size: '12V 200Ah', quantity, unitPrice });

const postLpo = (vendorId, items, overrides = {}) => {
  counter += 1;
  return api('POST', '/lpos', { token: users.purchasing.token, body: { number: `RS-${run}-${counter}`, vendorId, ...YEAR, items, ...overrides } });
};
const makeLpo = async (...args) => ok(await postLpo(...args));
const getLpo = async (id) => ok(await api('GET', `/lpos/${id}`, { token: users.purchasing.token }));
const balanceOn = async (lpo, index = 0) => (await getLpo(lpo._id)).items[index].balance;
const raise = (body, token = users.creator.token) => api('POST', '/tickets', { token, body: { currentReading: 1000, ...body } });
const forVsr = async (busId, serviceType, extra = {}) => ok(await api('GET', `/lpos/for-vsr?${new URLSearchParams({ busId, serviceType, ...extra })}`, { token: users.creator.token }));
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });
const inbox = async (user) => ok(await api('GET', '/notifications', { token: user.token }));

/** A vendor and a bus of this file's make, with no rates, so nothing is priced from the bus. */
const setup = async (label, overrides = {}) => {
  const vendor = await newVendor(`rs-${label}`);
  const bus = await createBus(users, `RS${label}`, vendor.id, { make: MAKE, rates: undefined, ...overrides });
  return { vendor, bus };
};

describe('LPO balances', () => {
  // The client's sheet works its tyre example this way; these figures are made up for the test.
  test('available is value less booked less GRN, and remaining after GRN is value less GRN', () => {
    const item = { _id: 'L1', kind: 'tyre', total: 500000, quantity: 400, usedAmount: 112500, usedQuantity: 90 };
    const booked = Array.from({ length: 20 }, (_, i) => ({ _id: `b${i}`, status: i % 2 ? 'approved' : 'pending', lpoLine: { item: 'L1' }, agreedPrice: { amount: 7500 }, quantity: 6 }));
    const deducted = Array.from({ length: 15 }, (_, i) => ({ _id: `d${i}`, status: 'completed', lpoLine: { item: 'L1' }, approvedEstimate: 7500, quantity: 6, lpoDeduction: { status: 'deducted', item: 'L1', amount: 7500, quantity: 6 } }));
    const others = [
      { _id: 'x1', status: 'declined', lpoLine: { item: 'L1' }, agreedPrice: { amount: 999 }, quantity: 1 },
      { _id: 'x2', status: 'completed', lpoLine: { item: 'L1' }, approvedEstimate: 0, quantity: 2 }, // at no charge
      { _id: 'x3', status: 'approved', lpoLine: { item: 'L2' }, agreedPrice: { amount: 5000 }, quantity: 3 }, // another line
    ];
    const balance = balanceOf(item, [...booked, ...deducted, ...others]);
    assert.deepEqual(balance, {
      value: { amount: 500000, quantity: 400 },
      booked: { amount: 150000, quantity: 120 },
      grn: { amount: 112500, quantity: 90 },
      available: { amount: 237500, quantity: 190 },
      afterGrn: { amount: 387500, quantity: 310 },
      vsrs: 36,
    });
    assert.equal(balanceOf(item, booked, { exclude: 'b3' }).booked.amount, 150000 - 7500, 'a VSR being corrected leaves its own booking out');

    const repair = balanceOf({ _id: 'R', kind: 'repairMaintenance', total: 1000.1, quantity: 1, usedAmount: 0.2, usedQuantity: 0 }, [{ _id: 'r', status: 'pending', lpoLine: { item: 'R' }, estimatedAmount: 0.1 }]);
    assert.deepEqual(repair.available, { amount: 999.8, quantity: null }, 'repair and maintenance has no quantities, and fils add up exactly');
  });

  test('a VSR reserves its approved amount, else its agreed price, the creator\'s estimate or the vendor\'s latest', () => {
    const vendorSaid = [{ from: 'vendor', amount: 9 }, { from: 'creator', amount: 8 }, { from: 'vendor', amount: 8.5 }];
    assert.equal(reservedAmount({ approvedEstimate: 0, agreedPrice: { amount: 5 } }), 0);
    assert.equal(reservedAmount({ agreedPrice: { amount: 5 }, estimatedAmount: 7 }), 5);
    assert.equal(reservedAmount({ estimatedAmount: 7, negotiation: vendorSaid }), 7);
    assert.equal(reservedAmount({ negotiation: vendorSaid }), 8.5);
    assert.equal(reservedAmount({}), 0);
    assert.equal(unitsOf({ breakdown: { unitsFitted: 2, parts: [{ quantity: 6 }] }, quantity: 4 }), 2, 'what was fitted');
    assert.equal(unitsOf({ quantity: 4 }), 4, 'else what was raised');
  });
});

describe('LPO items, reservations and balances', () => {
  before(async () => {
    users = await signInEveryone();
    await createBus(users, 'RSMAKE', users.vendor1.id, { make: MAKE });
    await createBus(users, 'RSOTHER', users.vendor1.id, { make: OTHER_MAKE });
  });
  // Any vendor's line can carry a job, so each test starts with none.
  beforeEach(clearLpos);
  after(clearLpos);

  describe('the LPO form', () => {
    test('purchasing enters dated lines, and the API names and totals them', async () => {
      const lpo = await makeLpo(users.vendor1.id, [{ ...RM(500000, `  ${MAKE.toUpperCase()} `), name: 'Typed name' }, TYRE(100, 950, { lifeKm: 120000 }), BATTERY(10, 640)]);
      assert.equal(lpo.date.slice(0, 10), '2026-01-01');
      assert.equal(lpo.make, undefined, 'the make is on the line');
      const [repair, tyre, battery] = lpo.items;
      assert.deepEqual([repair.kind, repair.make, repair.name, repair.quantity, repair.unitPrice, repair.total], ['repairMaintenance', MAKE, `Repair & Maintenance of ${MAKE} Buses`, 1, 500000, 500000]);
      assert.deepEqual([tyre.name, tyre.size, tyre.lifeKm, tyre.total, tyre.make], [`Tyre size ${SIZE}`, SIZE, 120000, 95000, undefined]);
      assert.deepEqual([battery.name, battery.size, battery.lifeKm, battery.total], ['Battery 12V 200Ah', '12V 200Ah', undefined, 6400]);
      assert.equal(lpo.grandTotal, 601400);

      const byTotal = await makeLpo(users.vendor1.id, [{ kind: 'repairMaintenance', make: MAKE, total: 1234.5, quantity: 7 }]);
      assert.deepEqual([byTotal.items[0].quantity, byTotal.items[0].unitPrice, byTotal.items[0].total], [1, 1234.5, 1234.5], 'an amount sent as the total, and quantity 1 whatever is sent');
    });

    test('bad lines are refused, each with its own message', async () => {
      const refused = async (items, overrides) => firstError(await postLpo(users.vendor1.id, items, overrides));
      assert.deepEqual(await refused([RM(100)], { date: undefined }), { field: 'date', message: 'Choose the LPO date' });
      assert.deepEqual(await refused([{ kind: 'other', name: 'Cleaning', quantity: 1, unitPrice: 100 }]), { field: 'items[0].kind', message: 'Choose what this item is for' });
      assert.deepEqual(await refused([{ kind: 'repairMaintenance', unitPrice: 100 }]), { field: 'items[0].make', message: 'Choose the make this item is for' });
      assert.deepEqual(await refused([TYRE(1, 100), RM(100, `Nobus ${run}`)]), { field: 'items[1].make', message: 'No bus on the fleet has this make' });
      assert.deepEqual(await refused([RM(0)]), { field: 'items[0].unitPrice', message: 'Enter the amount, above 0' });
      assert.deepEqual(await refused([{ ...TYRE(1, 100), size: ' ' }]), { field: 'items[0].size', message: 'Enter the tyre size' });
      assert.deepEqual(await refused([{ kind: 'battery', quantity: 1, unitPrice: 100 }]), { field: 'items[0].size', message: 'Enter the battery type' });
      assert.deepEqual(await refused([TYRE(2.5, 100)]), { field: 'items[0].quantity', message: 'Enter a whole number' });
      assert.deepEqual(await refused([TYRE(0, 100)]), { field: 'items[0].quantity', message: 'Enter a quantity above 0' });
      assert.deepEqual(await refused([TYRE(1, 0)]), { field: 'items[0].unitPrice', message: 'Enter a unit price above 0' });
      assert.deepEqual(await refused([TYRE(1, 100, { lifeKm: -5 })]), { field: 'items[0].lifeKm', message: 'Enter the life in km as a whole number above 0' });
      assert.deepEqual(await refused([TYRE(1, 100, { lifeKm: 1.5 })]), { field: 'items[0].lifeKm', message: 'Enter a whole number' });
    });

    test('the form\'s pick-lists: the fleet\'s makes, and the sizes and types already on LPOs', async () => {
      await makeLpo(users.vendor1.id, [TYRE(1, 100), TYRE(1, 100, { size: 'R17.5 70-215' }), BATTERY(1, 100)]);
      const lists = ok(await api('GET', '/lpos/items', { token: users.creator.token }));
      assert.ok(lists.makes.includes(MAKE) && lists.makes.includes(OTHER_MAKE));
      assert.deepEqual(lists.tyreSizes, ['R17.5 70-215', SIZE]);
      assert.deepEqual(lists.batteryTypes, ['12V 200Ah']);
      assert.equal((await api('GET', '/lpos/items', { token: users.vendor1.token })).status, 403);
    });
  });

  describe('raising a VSR', () => {
    test('with no line it is raised as before and purchasing is told; other work needs none', async () => {
      const { vendor, bus } = await setup('NONE');
      assert.deepEqual(await forVsr(bus._id, 'repair'), { kind: 'repairMaintenance', make: MAKE, status: 'noLpo', lines: [] });
      const repair = ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY' }));
      assert.deepEqual([repair.status, repair.lpoLine, repair.vendorId._id], ['sentToVendor', undefined, vendor.id]);
      const notice = (await inbox(users.purchasing)).find((n) => n.type === 'lpoMissing' && n.params.vsrNumber === repair.vsrNumber);
      assert.deepEqual([notice.params, notice.link], [{ vsrNumber: repair.vsrNumber, fleetNumber: bus.fleetNumber, make: MAKE, kind: 'repairMaintenance' }, '/lpos/new']);
      assert.ok(!(await inbox(users.supervisor)).some((n) => n.type === 'lpoMissing'), 'it is purchasing\'s to write');

      const tyre = ok(await raise({ busId: bus._id, serviceType: 'tyre', quantity: 4 }));
      assert.deepEqual([tyre.status, tyre.agreedPrice, tyre.quantity], ['sentToVendor', undefined, 4], 'tyres with no line wait for the vendor\'s estimate');
      assert.equal((await inbox(users.purchasing)).find((n) => n.params?.vsrNumber === tyre.vsrNumber)?.params.kind, 'tyre');

      assert.deepEqual(await forVsr(bus._id, 'other'), { kind: 'other', make: MAKE, status: 'notNeeded', lines: [] });
      const other = ok(await raise({ busId: bus._id, serviceType: 'other' }));
      assert.ok(!(await inbox(users.purchasing)).some((n) => n.params?.vsrNumber === other.vsrNumber));
      assert.equal(firstError(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', lpoItemId: repair._id })).message, 'This LPO cannot be used for this job');
    });

    test('with lines one has to be chosen, and only a line that fits the job', async () => {
      const { vendor, bus } = await setup('PICK');
      const mine = await makeLpo(vendor.id, [RM(5000)]);
      const otherMake = await makeLpo(vendor.id, [RM(5000, OTHER_MAKE), TYRE(5, 100)]);
      const expired = await makeLpo(vendor.id, [RM(5000)], { validFrom: '2024-01-01', validTo: '2024-12-31' });
      const repair = (lpoItemId) => raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', estimatedAmount: 100, lpoItemId });

      assert.deepEqual(firstError(await repair()), { field: 'lpoItemId', message: 'Choose the LPO this job comes off' });
      for (const id of [otherMake.items[0]._id, otherMake.items[1]._id, expired.items[0]._id, mine._id]) {
        assert.deepEqual(firstError(await repair(id)), { field: 'lpoItemId', message: 'This LPO cannot be used for this job' });
      }
      assert.equal(firstError(await repair('not-an-id')).message, 'This LPO cannot be used for this job');
      const raised = ok(await repair(mine.items[0]._id));
      assert.deepEqual(raised.lpoLine, { lpo: mine._id, lpoNumber: mine.number, item: mine.items[0]._id, name: `Repair & Maintenance of ${MAKE} Buses`, kind: 'repairMaintenance', unitPrice: 5000 });
      assert.equal(raised.estimatedAmount, 100);
    });

    test('the line sets the vendor, the bus\'s own vendor\'s lines come first, then the soonest ending', async () => {
      const { vendor, bus } = await setup('VEND');
      const elsewhere = await newVendor('rs-elsewhere');
      const later = await makeLpo(elsewhere.id, [RM(5000)], { validTo: '2098-12-31' });
      const own = await makeLpo(vendor.id, [RM(5000)], { validTo: '2099-12-31' });
      const sooner = await makeLpo(elsewhere.id, [RM(4000)], { validTo: '2097-12-31' });

      const shown = await forVsr(bus._id, 'repair');
      assert.deepEqual([shown.kind, shown.status, shown.make], ['repairMaintenance', 'found', MAKE]);
      assert.deepEqual(shown.lines.map((line) => line.lpo.number), [own.number, sooner.number, later.number]);
      const [first] = shown.lines;
      assert.deepEqual(Object.keys(first.lpo).sort(), ['_id', 'date', 'number', 'validTo', 'vendor']);
      assert.deepEqual(first.lpo.vendor, { _id: vendor.id, name: `rs-VEND ${run}` });
      assert.deepEqual(first.item, { _id: own.items[0]._id, name: `Repair & Maintenance of ${MAKE} Buses`, kind: 'repairMaintenance', make: MAKE, size: null, lifeKm: null, unitPrice: 5000 });
      assert.deepEqual(first.balance, { value: { amount: 5000, quantity: null }, booked: { amount: 0, quantity: null }, grn: { amount: 0, quantity: null }, available: { amount: 5000, quantity: null }, afterGrn: { amount: 5000, quantity: null }, vsrs: 0 });

      const pads = (extra) => raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BRAKE PADS', estimatedAmount: 300, lpoItemId: sooner.items[0]._id, ...extra });
      const taken = ok(await pads());
      assert.equal(taken.vendorId._id, elsewhere.id, 'the LPO\'s vendor does the work');
      const clash = await pads({ vendorId: vendor.id });
      assert.equal(clash.status, 400);
      assert.deepEqual(firstError(clash), { field: 'lpoItemId', message: `This LPO belongs to ${shown.lines[1].lpo.vendor.name}. Choose that vendor or another LPO.` });
      assert.equal(ok(await pads({ vendorId: elsewhere.id })).vendorId._id, elsewhere.id);
    });

    test('tyres and batteries take a quantity, priced at the line, and go straight to the supervisor', async () => {
      const { vendor, bus } = await setup('TYRE');
      const lpo = await makeLpo(vendor.id, [TYRE(10, 800), BATTERY(5, 640)]);
      const tyres = (extra) => raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: lpo.items[0]._id, ...extra });
      assert.deepEqual(firstError(await tyres()), { field: 'quantity', message: 'Enter how many' });
      assert.equal(firstError(await tyres({ quantity: 1.5 })).message, 'Enter a whole number');

      const res = await tyres({ quantity: 2 });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.message, 'VSR created and sent for supervisor approval');
      const raised = res.body.data;
      assert.deepEqual([raised.status, raised.quantity, raised.agreedPrice], ['pending', 2, { basis: 'lpo', unitPrice: 800, quantity: 2, amount: 1600 }]);
      assert.deepEqual([raised.lpoLine.name, raised.lpoLine.kind, raised.lpoLine.unitPrice], [`Tyre size ${SIZE}`, 'tyre', 800]);
      assert.ok(raised.signatures.some((s) => s.step === 'escalated'));
      assert.deepEqual((await forVsr(bus._id, 'tyre')).lines[0].balance.booked, { amount: 1600, quantity: 2 });

      const seen = ok(await api('GET', `/tickets/${raised._id}`, { token: vendor.token }));
      assert.deepEqual([seen.quantity, seen.agreedPrice.amount, seen.agreedPrice.unitPrice], [2, 1600, 800], 'the vendor sees the job and its agreed price');
      assert.ok(!('lpoLine' in seen) && !('estimatedAmount' in seen), 'but not the LPO');

      const battery = ok(await raise({ busId: bus._id, serviceType: 'battery', lpoItemId: lpo.items[1]._id, quantity: 1 }));
      assert.deepEqual([battery.status, battery.agreedPrice.amount], ['pending', 640]);
    });

    test('repairs take the creator\'s estimate; oil the rate, or without one the estimate', async () => {
      const { vendor, bus } = await setup('EST');
      const rated = await createBus(users, 'RSRATED', vendor.id, { make: MAKE });
      const lpo = await makeLpo(vendor.id, [RM(50000)]);
      const line = lpo.items[0]._id;
      assert.deepEqual(firstError(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', lpoItemId: line })), { field: 'estimatedAmount', message: 'Enter the estimated amount' });
      assert.equal(firstError(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', lpoItemId: line, estimatedAmount: 10.005 })).message, 'Use at most 2 decimals');
      const pads = ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BRAKE PADS', lpoItemId: line, estimatedAmount: 750 }));
      assert.deepEqual([pads.status, pads.estimatedAmount, pads.agreedPrice], ['sentToVendor', 750, undefined]);

      const oil = ok(await raise({ busId: rated._id, serviceType: 'oil', lpoItemId: line }));
      assert.deepEqual([oil.status, oil.agreedPrice, oil.estimatedAmount], ['pending', { basis: 'rate', rate: 0.5, km: 10000, amount: 5000 }, undefined], 'the rate on the bus');
      assert.deepEqual(firstError(await raise({ busId: bus._id, serviceType: 'oil', lpoItemId: line })), { field: 'estimatedAmount', message: 'Enter the estimated amount' }, 'oil with no rate on the bus');
      const unrated = ok(await raise({ busId: bus._id, serviceType: 'oil', lpoItemId: line, estimatedAmount: 2000 }));
      assert.deepEqual([unrated.status, unrated.estimatedAmount], ['sentToVendor', 2000]);
      assert.equal((await balanceOn(lpo)).booked.amount, 7750);
    });

    test('raising past what is left is refused with the sentence the form shows', async () => {
      const { vendor, bus } = await setup('LIMIT');
      const lpo = await makeLpo(vendor.id, [RM(1500000), TYRE(4, 2200)]);
      const [repairLine, tyreLine] = lpo.items.map((item) => item._id);
      const repair = (estimatedAmount) => raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', lpoItemId: repairLine, estimatedAmount });
      ok(await repair(1000000));
      const over = await repair(600000);
      assert.equal(over.status, 400);
      assert.deepEqual(firstError(over), { field: 'estimatedAmount', message: `LPO ${lpo.number} has AED 500,000.00 left for Repair & Maintenance of ${MAKE} Buses. Ask purchasing to add to it, or choose another LPO.` });
      ok(await repair(500000));
      assert.equal(firstError(await repair(0.01)).message, `LPO ${lpo.number} has AED 0.00 left for Repair & Maintenance of ${MAKE} Buses. Ask purchasing to add to it, or choose another LPO.`);

      const tyres = (quantity) => raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: tyreLine, quantity });
      ok(await tyres(3));
      assert.deepEqual(firstError(await tyres(2)), { field: 'quantity', message: `LPO ${lpo.number} has 1 left of Tyre size ${SIZE}.` });
      ok(await tyres(1));

      // A rate price cannot be changed, so the refusal is on the LPO.
      const rated = await createBus(users, 'RSLIMR', vendor.id, { make: MAKE });
      const small = await makeLpo(vendor.id, [RM(4000)]);
      assert.equal(firstError(await raise({ busId: rated._id, serviceType: 'oil', lpoItemId: small.items[0]._id })).field, 'lpoItemId');
    });

    test('a correction is checked without its own booking', async () => {
      const { vendor, bus } = await setup('CORR');
      const lpo = await makeLpo(vendor.id, [TYRE(10, 800)]);
      const line = lpo.items[0]._id;
      const raised = ok(await raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: line, quantity: 6 }));
      ok(await put(raised._id, 'return', users.supervisor.token, { reason: 'Check the count' }));
      const correction = (quantity, path = `/tickets/${raised._id}/details`) => api('PUT', path, { token: users.creator.token, body: { busId: bus._id, serviceType: 'tyre', currentReading: 1000, lpoItemId: line, quantity } });

      assert.equal((await forVsr(bus._id, 'tyre', { ticketId: raised._id })).lines[0].balance.available.quantity, 10, 'the form is shown what is left without this VSR');
      assert.equal((await forVsr(bus._id, 'tyre')).lines[0].balance.available.quantity, 4);
      assert.deepEqual(firstError(await correction(11)), { field: 'quantity', message: `LPO ${lpo.number} has 10 left of Tyre size ${SIZE}.` });
      const corrected = ok(await correction(10));
      assert.deepEqual([corrected.status, corrected.quantity, corrected.agreedPrice.amount], ['returned', 10, 8000], 'repriced at the line');
      assert.equal(firstError(await raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: line, quantity: 1 })).message, `LPO ${lpo.number} has 0 left of Tyre size ${SIZE}.`);
      assert.equal(ok(await correction(9, `/tickets/${raised._id}`)).quantity, 9, 'PUT /tickets/:id corrects too');
    });
  });

  describe('after raising, nothing blocks', () => {
    test('approval books the approved amount, and an overrun is flagged', async () => {
      const { vendor, bus } = await setup('APPR');
      const lpo = await makeLpo(vendor.id, [RM(1000)]);
      const raised = ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', lpoItemId: lpo.items[0]._id, estimatedAmount: 900 }));
      ok(await estimate(raised._id, vendor.token, { amount: '1200' }));
      assert.equal((await balanceOn(lpo)).booked.amount, 900, 'the creator\'s estimate until approval');
      await fillBreakdown(users, raised._id, 1200);
      ok(await put(raised._id, 'escalate', users.creator.token));
      ok(await put(raised._id, 'approve', users.supervisor.token));
      const balance = await balanceOn(lpo);
      assert.deepEqual([balance.booked.amount, balance.available.amount], [1200, -200]);
      for (const user of [users.purchasing, users.supervisor]) {
        const notice = (await inbox(user)).find((n) => n.type === 'lpoProblem' && n.params.vsrNumber === raised.vsrNumber);
        assert.deepEqual(notice?.params, { vsrNumber: raised.vsrNumber, problem: 'short', lpoNumber: lpo.number, kind: 'repairMaintenance' });
      }
    });

    test('additional jobs take their parent\'s line when it is for that work, and are never refused', async () => {
      const { vendor, bus } = await setup('ADD');
      const lpo = await makeLpo(vendor.id, [RM(1000)]);
      const parent = ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', lpoItemId: lpo.items[0]._id, estimatedAmount: 900 }));
      await toAcknowledged(users, parent, vendor);
      ok(await put(parent._id, 'vehicle/sent', users.creator.token));
      ok(await put(parent._id, 'vehicle/received', vendor.token, { km: 1050 }));
      const job = { description: 'Found a cracked exhaust while fixing the engine.', serviceType: 'repair', repairCategory: 'MECHANICAL', amount: '400', quotationNumber: 'Q-X', daysToComplete: '2' };
      const added = await multipart(`/tickets/${parent._id}/additional`, vendor.token, job);
      assert.equal(added.status, 201, JSON.stringify(added.body));
      const staffView = ok(await api('GET', `/tickets/${added.body.data._id}`, { token: users.creator.token }));
      assert.deepEqual(staffView.lpoLine, parent.lpoLine);
      const balance = await balanceOn(lpo);
      assert.deepEqual([balance.booked.amount, balance.available.amount, balance.vsrs], [1300, -300, 2], 'booked at its amount though it overruns');
      assert.ok((await inbox(users.purchasing)).some((n) => n.type === 'lpoProblem' && n.params.vsrNumber === staffView.vsrNumber));

      const battery = ok(await multipart(`/tickets/${parent._id}/additional`, vendor.token, { ...job, serviceType: 'battery', repairCategory: '' }));
      assert.equal(ok(await api('GET', `/tickets/${battery._id}`, { token: users.creator.token })).lpoLine, undefined, 'a battery does not come off a repair line');
    });

    test('the GRN deducts the invoice in place of the booking, and invoice acceptance takes nothing', async () => {
      const { vendor, bus } = await setup('GRN');
      const lpo = await makeLpo(vendor.id, [TYRE(10, 800)]);
      const raised = ok(await raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: lpo.items[0]._id, quantity: 2 }));
      const forwarded = await toForwarded(users, raised, vendor, { invoice: { amount: '2000' } });
      assert.equal(forwarded.lpoDeduction, undefined, 'nothing comes off at acceptance');
      assert.deepEqual((await balanceOn(lpo)).booked, { amount: 1600, quantity: 2 });

      ok(await grnFor(users, raised._id, 'RS1'));
      const after = ok(await api('GET', `/tickets/${raised._id}`, { token: users.purchasing.token }));
      assert.deepEqual(
        [after.lpoDeduction.status, after.lpoDeduction.lpoNumber, after.lpoDeduction.kind, after.lpoDeduction.quantity, after.lpoDeduction.amount, after.lpoDeduction.overrun],
        ['deducted', lpo.number, 'tyre', 2, 2000, false]
      );
      const page = await getLpo(lpo._id);
      assert.deepEqual(page.items[0].balance, {
        value: { amount: 8000, quantity: 10 },
        booked: { amount: 0, quantity: 0 },
        grn: { amount: 2000, quantity: 2 },
        available: { amount: 6000, quantity: 8 },
        afterGrn: { amount: 6000, quantity: 8 },
        vsrs: 1,
      });
      assert.deepEqual(page.items[0].vsrs, [{ _id: raised._id, vsrNumber: raised.vsrNumber, fleetNumber: bus.fleetNumber, status: 'grnCreated', reserved: null, deducted: 2000, quantity: 2, grnNumber: `GRN-${run}-RS1` }]);
      assert.deepEqual([page.value, page.booked, page.grn, page.available, page.afterGrn, page.vsrs, page.inDate], [8000, 0, 2000, 6000, 6000, 1, true]);
      const listed = ok(await api('GET', '/lpos?limit=200', { token: users.creator.token })).find((row) => row._id === lpo._id);
      assert.deepEqual([listed.value, listed.booked, listed.grn, listed.available, listed.inDate], [8000, 0, 2000, 6000, true]);

      // Eight tyres fit the count but not the AED 6,000 left, as the GRN took more than the agreed price.
      assert.deepEqual(firstError(await raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: lpo.items[0]._id, quantity: 8, currentReading: 2000 })), {
        field: 'quantity',
        message: `LPO ${lpo.number} has AED 6,000.00 left for Tyre size ${SIZE}. Ask purchasing to add to it, or choose another LPO.`,
      });
    });

    test('a VSR with no line comes off its vendor\'s line at the GRN, or is flagged when there is none', async () => {
      const { vendor, bus } = await setup('LATE');
      const otherBus = await createBus(users, 'RSLATE2', vendor.id, { make: OTHER_MAKE, rates: undefined });
      const repair = async (onBus) => toForwarded(users, ok(await raise({ busId: onBus._id, serviceType: 'repair', repairCategory: 'BODY' })), vendor, { invoice: { amount: '900' } });
      const covered = await repair(bus);
      const uncovered = await repair(otherBus);
      const lpo = await makeLpo(vendor.id, [RM(5000)]); // written after the VSRs were raised
      ok(await grnFor(users, [covered._id, uncovered._id], 'RS2'));
      const read = async (id) => ok(await api('GET', `/tickets/${id}`, { token: users.purchasing.token })).lpoDeduction;
      assert.deepEqual([(await read(covered._id)).status, (await read(covered._id)).lpoNumber], ['deducted', lpo.number]);
      assert.deepEqual([(await read(uncovered._id)).status, (await read(uncovered._id)).kind, (await read(uncovered._id)).amount], ['noLpo', 'repairMaintenance', 900]);
      assert.equal((await getLpo(lpo._id)).items[0].usedAmount, 900);
      for (const user of [users.purchasing, users.supervisor]) {
        assert.equal((await inbox(user)).find((n) => n.type === 'lpoProblem' && n.params.vsrNumber === uncovered.vsrNumber)?.params.problem, 'noLpo');
      }
    });

    test('a VSR already charged under the old rule is not charged again', async () => {
      const { vendor, bus } = await setup('OLD');
      const lpo = await makeLpo(vendor.id, [RM(5000)]);
      const raised = ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', lpoItemId: lpo.items[0]._id, estimatedAmount: 900 }));
      await toForwarded(users, raised, vendor, { invoice: { amount: '900' } });
      // What accepting the invoice used to do before 2026-11-10.
      const connection = await testDb();
      try {
        const oid = (id) => new mongoose.Types.ObjectId(id);
        await connection.collection('lpos').updateOne({ _id: oid(lpo._id), 'items._id': oid(lpo.items[0]._id) }, { $inc: { usedAmount: 900, 'items.$.usedAmount': 900 } });
        await connection.collection('tickets').updateOne({ _id: oid(raised._id) }, { $set: { lpoDeduction: { status: 'deducted', lpo: oid(lpo._id), lpoNumber: lpo.number, item: oid(lpo.items[0]._id), kind: 'repairMaintenance', quantity: 0, amount: 900, overrun: false, at: new Date() } } });
      } finally {
        await connection.close();
      }
      assert.deepEqual([(await balanceOn(lpo)).booked.amount, (await balanceOn(lpo)).grn.amount], [0, 900], 'charged, so nothing is booked');
      ok(await grnFor(users, raised._id, 'RS3'));
      assert.equal((await getLpo(lpo._id)).items[0].usedAmount, 900, 'the GRN skips it');
    });

    test('a job at no charge, or a declined one, releases what it booked', async () => {
      const { vendor, bus } = await setup('FREE');
      const lpo = await makeLpo(vendor.id, [RM(5000)]);
      const raised = ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', lpoItemId: lpo.items[0]._id, estimatedAmount: 700 }));
      assert.equal((await balanceOn(lpo)).booked.amount, 700);
      ok(await estimate(raised._id, vendor.token, { amount: '0', noChargeReason: 'warranty' }));
      ok(await put(raised._id, 'escalate', users.creator.token));
      ok(await put(raised._id, 'approve', users.supervisor.token));
      assert.equal((await balanceOn(lpo)).booked.amount, 0, 'approved at AED 0');
      ok(await put(raised._id, 'acknowledge', vendor.token, { daysToComplete: 2 }));
      const back = await fromAcknowledgedToReturned(users, raised._id, vendor);
      assert.equal(back.status, 'completed');
      const closed = await balanceOn(lpo);
      assert.deepEqual([closed.booked.amount, closed.grn.amount, closed.vsrs], [0, 0, 1]);

      // An additional job turned down by the supervisor counts for nothing.
      const parent = ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', lpoItemId: lpo.items[0]._id, estimatedAmount: 500, currentReading: 2000 }));
      await toAcknowledged(users, parent, vendor);
      ok(await put(parent._id, 'vehicle/sent', users.creator.token));
      ok(await put(parent._id, 'vehicle/received', vendor.token, { km: 2050 }));
      const job = ok(await multipart(`/tickets/${parent._id}/additional`, vendor.token, { description: 'Found worn mounts while on the lift.', serviceType: 'repair', repairCategory: 'MECHANICAL', amount: '400', quotationNumber: 'Q-D', daysToComplete: '2' }));
      assert.equal((await balanceOn(lpo)).booked.amount, 900 + 400);
      await fillBreakdown(users, job._id, 400);
      ok(await put(job._id, 'escalate', users.creator.token));
      ok(await put(job._id, 'decline', users.supervisor.token, { reason: 'Not now' }));
      const declined = await balanceOn(lpo);
      assert.deepEqual([declined.booked.amount, declined.vsrs], [900, 2]);
    });

    test('tyres off a line with a life in km set the bus\'s tyre interval from the km they were fitted at', async () => {
      const { vendor, bus } = await setup('LIFE');
      const plain = await createBus(users, 'RSLIFE2', vendor.id, { make: MAKE, rates: undefined });
      const lpo = await makeLpo(vendor.id, [TYRE(10, 800, { lifeKm: 75000 }), TYRE(10, 700, { size: 'R17.5 70-215' })]);
      const fitted = ok(await raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: lpo.items[0]._id, quantity: 2, currentReading: 5000 }));
      await toVehicleReturned(users, fitted, vendor, { km: 5200 });
      const tyre = async (id) => ok(await api('GET', `/buses/${id}`, { token: users.creator.token })).intervals.tyre;
      assert.deepEqual(await tyre(bus._id), { everyKm: 75000, lastKm: 5200 });

      const without = ok(await raise({ busId: plain._id, serviceType: 'tyre', lpoItemId: lpo.items[1]._id, quantity: 2, currentReading: 5000 }));
      await toVehicleReturned(users, without, vendor, { km: 5200 });
      assert.deepEqual(await tyre(plain._id), { everyKm: 40000, lastKm: 5200 }, 'a line with no life leaves the interval');
    });
  });

  describe('the LPO balances report', () => {
    const report = (query, token = users.purchasing.token) => api('GET', `/reports/lpo-balances?${new URLSearchParams(query)}`, { token });

    test('each line has the document\'s figures, and the subtotals and total add up', async () => {
      const { vendor, bus } = await setup('REP');
      const tyresAndRepairs = await makeLpo(vendor.id, [RM(10000), TYRE(10, 800, { lifeKm: 120000 })]);
      const batteries = await makeLpo(vendor.id, [BATTERY(5, 600)], { date: '2026-02-01' });
      const expired = await makeLpo(vendor.id, [TYRE(3, 900)], { date: '2024-01-01', validFrom: '2024-01-01', validTo: '2024-12-31' });
      ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', lpoItemId: tyresAndRepairs.items[0]._id, estimatedAmount: 1234.56 }));
      const tyres = ok(await raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: tyresAndRepairs.items[1]._id, quantity: 2 }));
      await toForwarded(users, tyres, vendor, { invoice: { amount: '1650.25' } });
      ok(await grnFor(users, tyres._id, 'RS4'));
      ok(await raise({ busId: bus._id, serviceType: 'battery', lpoItemId: batteries.items[0]._id, quantity: 1, currentReading: 2000 }));

      const data = ok(await report({ vendorId: vendor.id }));
      assert.deepEqual(data.rows.map((row) => [row.lpoNumber, row.kind]), [[expired.number, 'tyre'], [tyresAndRepairs.number, 'repairMaintenance'], [tyresAndRepairs.number, 'tyre'], [batteries.number, 'battery']], 'by LPO date');
      const tyreRow = data.rows[2];
      assert.deepEqual(
        [tyreRow.item, tyreRow.unitPrice, tyreRow.lifeKm, tyreRow.inDate, tyreRow.vendor._id, tyreRow.itemId, tyreRow.value, tyreRow.booked, tyreRow.grn, tyreRow.available, tyreRow.afterGrn, tyreRow.vsrs],
        [`Tyre size ${SIZE}`, 800, 120000, true, vendor.id, tyresAndRepairs.items[1]._id, { amount: 8000, quantity: 10 }, { amount: 0, quantity: 0 }, { amount: 1650.25, quantity: 2 }, { amount: 6349.75, quantity: 8 }, { amount: 6349.75, quantity: 8 }, 1]
      );
      assert.deepEqual([data.rows[1].booked.amount, data.rows[1].available.amount, data.rows[1].booked.quantity], [1234.56, 8765.44, null]);
      for (const row of data.rows) {
        assert.equal(Math.round(row.available.amount * 100), Math.round((row.value.amount - row.booked.amount - row.grn.amount) * 100), `${row.lpoNumber} ${row.kind} available`);
        assert.equal(Math.round(row.afterGrn.amount * 100), Math.round((row.value.amount - row.grn.amount) * 100), `${row.lpoNumber} ${row.kind} after GRN`);
      }
      const fils = (n) => Math.round(n * 100);
      for (const field of ['value', 'booked', 'grn', 'available', 'afterGrn']) {
        assert.equal(fils(data.total[field]), data.rows.reduce((sum, row) => sum + fils(row[field].amount), 0), `total ${field}`);
        assert.equal(fils(data.total[field]), data.lpos.reduce((sum, lpo) => sum + fils(lpo[field]), 0), `subtotals ${field}`);
      }
      assert.deepEqual(data.lpos.find((lpo) => lpo.lpoId === tyresAndRepairs._id), { lpoId: tyresAndRepairs._id, lpoNumber: tyresAndRepairs.number, vendor: tyreRow.vendor, value: 18000, booked: 1234.56, grn: 1650.25, available: 15115.19, afterGrn: 16349.75, vsrs: 2 });
      assert.equal(data.total.vsrs, 3);
      assert.ok(data.filters.vendors.some((v) => v._id === vendor.id));
      assert.deepEqual(data.filters.kinds, ['repairMaintenance', 'tyre', 'battery']);

      assert.deepEqual(ok(await report({ vendorId: vendor.id, kind: 'tyre' })).rows.map((row) => row.lpoNumber), [expired.number, tyresAndRepairs.number]);
      assert.deepEqual(ok(await report({ vendorId: vendor.id, inDate: 'false' })).rows.map((row) => row.lpoNumber), [expired.number]);
      assert.equal(ok(await report({ vendorId: vendor.id, inDate: 'true' })).rows.length, 3);
    });

    test('it is for the depot, and its filters are checked', async () => {
      for (const user of [users.creator, users.supervisor, users.purchasing]) assert.equal((await report({}, user.token)).status, 200);
      assert.equal((await report({}, users.vendor1.token)).status, 403);
      assert.deepEqual(firstError(await report({ kind: 'wheel' })), { field: 'kind', message: 'Choose a valid kind of item' });
      assert.deepEqual(firstError(await report({ inDate: 'maybe' })), { field: 'inDate', message: 'inDate must be true or false' });
      assert.equal(firstError(await report({ vendorId: 'x' })).field, 'vendorId');
    });
  });
});

describe('migration of LPOs and open VSRs from before 2026-11-10', () => {
  const oid = () => new mongoose.Types.ObjectId();

  test('dates LPOs, moves the make onto its lines, names them, books open VSRs; a dry run writes nothing and a second run changes nothing', async () => {
    const uri = process.env.MONGO_URI.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, query = '') => `/${db}_lpomigrate${query}`);
    const connection = await mongoose.createConnection(uri).asPromise();
    const db = (name) => connection.collection(name);
    try {
      await connection.dropDatabase();
      const [v1, v2] = [oid(), oid()];
      await db('users').insertMany([v1, v2].map((_id, i) => ({ _id, name: `Vendor ${i}`, email: `mig${i}-${run}@test.dev`, role: 'vendor', password: 'x' })));
      const [hino, isuzu] = [oid(), oid()];
      await db('buses').insertMany([
        { _id: hino, fleetNumber: 'M-1', make: 'Hino', model: 'Coach', year: 2015, vendor: v1 },
        { _id: isuzu, fleetNumber: 'M-2', make: 'Isuzu', model: 'Coach', year: 2015, vendor: v1 },
      ]);
      const ids = Object.fromEntries(['rm1', 't1', 'b2', 'rm3', 't4'].map((key) => [key, oid()]));
      const line = (_id, kind, name, total, quantity = 1, used = [0, 0], extra = {}) => ({ _id, kind, name, quantity, unitPrice: total / quantity, total, usedAmount: used[0], usedQuantity: used[1], ...extra });
      const validity = { validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31') };
      const lpo = (number, vendor, items, extra = {}) => ({ _id: oid(), number, vendor, ...validity, items, grandTotal: items.reduce((s, i) => s + i.total, 0), usedAmount: 0, createdAt: new Date('2026-01-01'), ...extra });
      const lpos = {
        // As the 2026-11-09 shape left them: a make on the LPO, one repair and maintenance line, a tyre line with no size.
        mixed: lpo('L1', v1, [line(ids.rm1, 'repairMaintenance', 'Repair and maintenance', 5000, 1, [1000, 0]), line(ids.t1, 'tyre', 'Tyre 295/80', 8000, 10, [800, 1])], { make: 'Hino', validTo: new Date('2098-12-31') }),
        batteries: lpo('L2', v1, [line(ids.b2, 'battery', 'Batteries', 600, 1)], { date: new Date('2026-01-01') }),
        other: lpo('L3', v2, [line(ids.rm3, 'repairMaintenance', 'Repair and maintenance', 900)], { make: 'Isuzu', date: new Date('2026-01-01') }),
        current: lpo('L4', v1, [line(ids.t4, 'tyre', `Tyre size ${SIZE}`, 1600, 2, [0, 0], { size: SIZE })], { date: new Date('2026-01-01') }),
        // Named by the rule but loaded before lines had a size.
        sizeInName: lpo('L5', v2, [line(oid(), 'tyre', 'Tyre size R19.5 70-265', 1300, 1), line(oid(), 'battery', 'Battery 12V 200Ah', 600, 1)], { date: new Date('2026-01-01') }),
      };
      await db('lpos').insertMany(Object.values(lpos));
      const ticket = (key, fields) => ({ _id: oid(), vsrNumber: `M-${key}`, vendorId: v1, busId: hino, createdAt: new Date(`2026-03-0${Object.keys(tickets).length + 1}`), ...fields });
      const tickets = {};
      tickets.repair = ticket('repair', { serviceType: 'repair', status: 'approved', approvedEstimate: 700 });
      tickets.tyre = ticket('tyre', { serviceType: 'tyre', status: 'pending', negotiation: [{ from: 'vendor', amount: 1600 }], breakdown: { unitsFitted: 2, parts: [{ quantity: 2 }, { quantity: 4 }] } });
      tickets.offMake = ticket('offMake', { serviceType: 'repair', status: 'sentToVendor', busId: isuzu });
      tickets.charged = ticket('charged', { serviceType: 'repair', status: 'invoiceAccepted', approvedEstimate: 300, lpoDeduction: { status: 'deducted', lpo: lpos.mixed._id, item: ids.rm1, kind: 'repairMaintenance', amount: 300, quantity: 0 } });
      tickets.done = ticket('done', { serviceType: 'repair', status: 'completed', approvedEstimate: 400 });
      await db('tickets').insertMany(Object.values(tickets));

      const snapshot = async () => Object.fromEntries(await Promise.all(['lpos', 'tickets'].map(async (name) => [name, await db(name).find().sort({ _id: 1 }).toArray()])));
      const script = join(here, '..', 'scripts', 'migrate-lpo-items.js');
      const migrate = (extra, env = {}) => exec(process.execPath, [script, ...extra], { env: { ...process.env, ...env }, timeout: 60000 });

      const before = await snapshot();
      const dry = await migrate(['--dry-run'], { MONGO_URI: uri });
      assert.match(dry.stdout, /Dry run on database \S+_lpomigrate/);
      assert.match(dry.stdout, /LPOs: 1 dated, 2 with the make moved to their lines, 5 lines named by the rule/);
      assert.match(dry.stdout, /VSRs: 2 open ones given the line they will come off, 1 given their quantity/);
      assert.match(dry.stdout, /M-repair: L1, Repair & Maintenance of Hino Buses/);
      assert.match(dry.stdout, /Nothing written/);
      assert.deepEqual(await snapshot(), before);

      await migrate(['--uri', uri]);
      const lpoNow = (key) => db('lpos').findOne({ _id: lpos[key]._id });
      const mixed = await lpoNow('mixed');
      assert.deepEqual([mixed.date.toISOString(), 'make' in mixed], [lpos.mixed.validFrom.toISOString(), false]);
      assert.deepEqual(mixed.items.map((i) => [i.name, i.make]), [['Repair & Maintenance of Hino Buses', 'Hino'], ['Tyres', undefined]]);
      assert.deepEqual([mixed.items[0].usedAmount, mixed.items[1].usedQuantity], [1000, 1], 'past deductions stay');
      assert.deepEqual((await lpoNow('other')).items.map((i) => [i.name, i.make]), [['Repair & Maintenance of Isuzu Buses', 'Isuzu']]);
      assert.deepEqual(await lpoNow('batteries'), lpos.batteries);
      assert.deepEqual(await lpoNow('current'), lpos.current);
      assert.deepEqual((await lpoNow('sizeInName')).items.map((i) => [i.name, i.size]), [['Tyre size R19.5 70-265', 'R19.5 70-265'], ['Battery 12V 200Ah', '12V 200Ah']], 'the size read from the name');

      const ticketNow = (key) => db('tickets').findOne({ _id: tickets[key]._id });
      assert.deepEqual((await ticketNow('repair')).lpoLine, { lpo: lpos.mixed._id, lpoNumber: 'L1', item: ids.rm1, name: 'Repair & Maintenance of Hino Buses', kind: 'repairMaintenance', unitPrice: 5000 });
      const tyre = await ticketNow('tyre');
      assert.deepEqual([String(tyre.lpoLine.item), tyre.lpoLine.name, tyre.quantity], [String(ids.t1), 'Tyres', 2], 'the line ending first, with what was fitted');
      assert.deepEqual(await ticketNow('offMake'), tickets.offMake, 'no line for its make from its vendor');
      assert.deepEqual(await ticketNow('charged'), tickets.charged);
      assert.deepEqual(await ticketNow('done'), tickets.done);

      const once = await snapshot();
      const twice = await migrate(['--uri', uri]);
      assert.match(twice.stdout, /LPOs: 0 dated, 0 with the make moved to their lines, 0 lines named by the rule/);
      assert.match(twice.stdout, /VSRs: 0 open ones given the line they will come off, 0 given their quantity/);
      assert.deepEqual(await snapshot(), once);
    } finally {
      await connection.dropDatabase();
      await connection.close();
    }
  });
});
