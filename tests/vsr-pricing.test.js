/**
 * Owner's testing notes of 2026-11-11, pricing on the Raise VSR form.
 *
 * - A VSR with an agreed price (oil at the bus rate; a tyre or battery off an LPO line) goes to the
 *   vendor to acknowledge, unless the creator ticks "Send to the supervisor for approval first".
 * - A bus has a tyre size, and a tyre change only comes off the tyre LPO lines that fit it.
 */
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, busBody, clearLpos, createBus, newVendor, run, signInEveryone } from './helpers.js';
import { tyreSizeFits } from '../utils/tyreSize.js';

let users;
let counter = 0;

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const firstError = (res) => res.body.errors?.[0];

const YEAR = { date: '2026-01-01', validFrom: '2026-01-01', validTo: '2099-12-31' };
const TYRE = (size, quantity = 100, unitPrice = 1800) => ({ kind: 'tyre', size, quantity, unitPrice });
const BATTERY = (quantity = 10, unitPrice = 640) => ({ kind: 'battery', size: '12V 200Ah', quantity, unitPrice });

const makeLpo = async (vendorId, items) => {
  counter += 1;
  return ok(await api('POST', '/lpos', { token: users.purchasing.token, body: { number: `VP-${run}-${counter}`, vendorId, ...YEAR, items } }));
};
const raise = (body) => api('POST', '/tickets', { token: users.creator.token, body: { currentReading: 1000, ...body } });
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });
const forVsr = async (busId, serviceType) => ok(await api('GET', `/lpos/for-vsr?${new URLSearchParams({ busId, serviceType })}`, { token: users.creator.token }));
const lineBalance = async (lpo, index = 0) => ok(await api('GET', `/lpos/${lpo._id}`, { token: users.purchasing.token })).items[index].balance;

describe('tyre sizes', () => {
  test('a line fits by rim diameter, and by width and profile when both sides give them', () => {
    for (const [bus, line] of [
      ['295/80 R22.5', 'R22.5 80-295'],
      ['R22.5 80-295', '295/80 R22.5'],
      ['295/80R22.5', '295/80 R 22.5'],
      ['22.5', 'R22.5 80-295'],
      ['22.5', '315/80 R22.5'],
      ['295/80 R22.5', '22.5'],
      ['295/80 R22.5', '11R22.5'],
      ['r17.5 70-215', '215/70 R17.5'],
    ]) assert.equal(tyreSizeFits(bus, line), true, `${bus} takes ${line}`);
    for (const [bus, line] of [
      ['295/80 R22.5', '315/80 R22.5'],
      ['295/80 R22.5', '295/70 R22.5'],
      ['22.5', 'R17.5 70-215'],
      ['295/80 R22.5', 'R19.5 80-295'],
    ]) assert.equal(tyreSizeFits(bus, line), false, `${bus} does not take ${line}`);
  });

  test('a bus with no size takes every line; text with no rim is compared as written', () => {
    assert.equal(tyreSizeFits(undefined, 'R22.5 80-295'), true);
    assert.equal(tyreSizeFits('  ', 'R22.5 80-295'), true);
    assert.equal(tyreSizeFits('Super single', 'super  SINGLE'), true);
    assert.equal(tyreSizeFits('Super single', 'R22.5 80-295'), false);
  });
});

describe('pricing on the Raise VSR form', () => {
  before(async () => {
    users = await signInEveryone();
  });
  // Any vendor's line can carry a job, so each test starts with none.
  beforeEach(clearLpos);
  after(clearLpos);

  describe('an agreed price goes to the vendor', () => {
    test('oil at the bus rate goes to the vendor to acknowledge, with nobody\'s approval on it', async () => {
      const bus = await createBus(users, 'VPOIL', users.vendor1.id);
      const res = await raise({ busId: bus._id, serviceType: 'oil', currentReading: 9000 });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.message, 'VSR created and sent to the vendor at the agreed price');
      const raised = res.body.data;
      assert.deepEqual([raised.status, raised.agreedPrice.amount, raised.approvedEstimate], ['approved', 5000, 5000]);
      assert.deepEqual(raised.signatures, [], 'no approval stamp, and nothing was sent for approval');
      assert.equal(raised.initialApprovedBy, undefined);
      assert.deepEqual(
        raised.history.map(({ status, note, by }) => [status, note, by?._id ?? by]),
        [['approved', 'Sent to the vendor at the agreed price', users.creator.id]]
      );

      const assigned = ok(await api('GET', '/tickets?status=approved&limit=100', { token: users.vendor1.token }));
      assert.ok(assigned.some((ticket) => ticket._id === raised._id), 'the vendor has it to acknowledge');
      assert.equal((await put(raised._id, 'approve', users.supervisor.token)).status, 409, 'there is nothing for a supervisor to approve');
      const acknowledged = ok(await put(raised._id, 'acknowledge', users.vendor1.token, { daysToComplete: 2 }));
      assert.equal(acknowledged.status, 'acknowledged');
    });

    test('tyres and batteries off a line go to the vendor, and the line books the agreed price', async () => {
      const vendor = await newVendor('vp-tyre');
      const bus = await createBus(users, 'VPTYRE', vendor.id, { rates: undefined });
      const lpo = await makeLpo(vendor.id, [TYRE('R22.5 80-295'), BATTERY()]);
      const tyres = ok(await raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: lpo.items[0]._id, quantity: 6 }));
      assert.deepEqual([tyres.status, tyres.agreedPrice.amount, tyres.approvedEstimate], ['approved', 10800, 10800]);
      assert.deepEqual((await lineBalance(lpo)).booked, { amount: 10800, quantity: 6 });
      const battery = ok(await raise({ busId: bus._id, serviceType: 'battery', lpoItemId: lpo.items[1]._id, quantity: 2 }));
      assert.deepEqual([battery.status, battery.approvedEstimate], ['approved', 1280]);
    });

    test('ticked, it goes to the supervisor for approval first, as before', async () => {
      const bus = await createBus(users, 'VPFIRST', users.vendor1.id);
      const res = await raise({ busId: bus._id, serviceType: 'oil', currentReading: 9000, supervisorFirst: true });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.message, 'VSR created and sent for supervisor approval');
      const raised = res.body.data;
      assert.deepEqual([raised.status, raised.approvedEstimate], ['pending', undefined]);
      assert.deepEqual(raised.signatures.map((s) => s.step), ['escalated']);
      assert.deepEqual(raised.history.map((entry) => [entry.status, entry.note]), [['pending', 'VSR created']]);

      ok(await put(raised._id, 'return', users.supervisor.token, { reason: 'Check the reading' }));
      const corrected = ok(await api('PUT', `/tickets/${raised._id}/details`, { token: users.creator.token, body: { busId: bus._id, serviceType: 'oil', currentReading: 9100 } }));
      assert.equal(corrected.status, 'returned', 'a correction keeps today\'s flow');
      assert.equal(ok(await put(raised._id, 'escalate', users.creator.token)).status, 'pending');
      const approved = ok(await put(raised._id, 'approve', users.supervisor.token));
      assert.deepEqual([approved.status, approved.approvedEstimate], ['approved', 5000]);
    });

    test('with no agreed price the box changes nothing, and it has to be yes or no', async () => {
      const bus = await createBus(users, 'VPREPAIR', users.vendor1.id);
      const repair = ok(await raise({ busId: bus._id, serviceType: 'repair', repairCategory: 'BODY', supervisorFirst: true }));
      assert.equal(repair.status, 'sentToVendor');
      assert.deepEqual(firstError(await raise({ busId: bus._id, serviceType: 'oil', supervisorFirst: 'maybe' })), {
        field: 'supervisorFirst',
        message: 'Sending to the supervisor first must be yes or no',
      });
    });
  });

  describe('tyre size on the bus', () => {
    test('a bus keeps its tyre size, trimmed, and an edit can clear it', async () => {
      const bus = await createBus(users, 'VPSIZE', users.vendor1.id, { tyreSize: '  295/80 R22.5 ' });
      assert.equal(bus.tyreSize, '295/80 R22.5');
      assert.equal(ok(await api('GET', `/buses/${bus._id}`, { token: users.supervisor.token })).tyreSize, '295/80 R22.5');
      const edit = (tyreSize) => api('PUT', `/buses/${bus._id}`, { token: users.creator.token, body: busBody('VPSIZE', users.vendor1.id, { tyreSize }) });
      assert.equal(ok(await edit('R22.5 80-295')).tyreSize, 'R22.5 80-295');
      assert.equal(ok(await edit('')).tyreSize, undefined);
      const tooLong = await edit('x'.repeat(31));
      assert.equal(tooLong.status, 400);
      assert.deepEqual(firstError(tooLong), { field: 'tyreSize', message: 'Keep this to 30 characters or fewer' });
      assert.equal(firstError(await edit(22.5)).field, 'tyreSize', 'text only');
    });

    test('a tyre change is offered only the tyre lines that fit the bus', async () => {
      const vendor = await newVendor('vp-fit');
      const lpo = await makeLpo(vendor.id, [TYRE('R22.5 80-295'), TYRE('315/80 R22.5'), TYRE('R17.5 70-215'), TYRE('22.5'), BATTERY()]);
      const names = (shown) => shown.lines.map((line) => line.item.size);

      const sized = await createBus(users, 'VPFIT1', vendor.id, { rates: undefined, tyreSize: '295/80 R22.5' });
      const shown = await forVsr(sized._id, 'tyre');
      assert.deepEqual([shown.status, shown.tyreSize, names(shown)], ['found', '295/80 R22.5', ['R22.5 80-295', '22.5']]);

      const rimOnly = await createBus(users, 'VPFIT2', vendor.id, { rates: undefined, tyreSize: '22.5' });
      assert.deepEqual(names(await forVsr(rimOnly._id, 'tyre')), ['R22.5 80-295', '315/80 R22.5', '22.5']);

      const unsized = await createBus(users, 'VPFIT3', vendor.id, { rates: undefined });
      const every = await forVsr(unsized._id, 'tyre');
      assert.deepEqual([every.tyreSize, every.lines.length], [null, 4], 'no size on the bus: every tyre line');
      assert.equal((await forVsr(sized._id, 'battery')).lines.length, 1, 'batteries are not sized');

      const wrong = await raise({ busId: sized._id, serviceType: 'tyre', lpoItemId: lpo.items[1]._id, quantity: 6 });
      assert.deepEqual(firstError(wrong), { field: 'lpoItemId', message: 'This LPO cannot be used for this job' });
      assert.equal(ok(await raise({ busId: sized._id, serviceType: 'tyre', lpoItemId: lpo.items[0]._id, quantity: 6 })).lpoLine.item, lpo.items[0]._id);
    });

    test('when no line fits the size, the VSR is raised without one and purchasing is told', async () => {
      const vendor = await newVendor('vp-none');
      const lpo = await makeLpo(vendor.id, [TYRE('R22.5 80-295')]);
      const bus = await createBus(users, 'VPNONE', vendor.id, { rates: undefined, tyreSize: 'R19.5 70-245' });
      assert.deepEqual(await forVsr(bus._id, 'tyre'), { kind: 'tyre', make: 'Hino', tyreSize: 'R19.5 70-245', status: 'noLpo', lines: [] });
      assert.equal(firstError(await raise({ busId: bus._id, serviceType: 'tyre', lpoItemId: lpo.items[0]._id, quantity: 6 })).message, 'This LPO cannot be used for this job');
      const raised = ok(await raise({ busId: bus._id, serviceType: 'tyre', quantity: 6 }));
      assert.deepEqual([raised.status, raised.lpoLine], ['sentToVendor', undefined]);
    });
  });
});
