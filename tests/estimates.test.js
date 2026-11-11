/**
 * Items 1, 2, 5 and 6, plus the breakdown flag: VSR numbers, what the vendor adds to an
 * estimate, and the parts and labour the service creator fills in and checks against it.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, estimate, multipart, signInEveryone } from './helpers.js';

let users;
let bus;
const raise = (body = {}) =>
  api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 1000, ...body } });
const raised = async (body) => {
  const res = await raise(body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const FULL_ESTIMATE = { amount: '900', quotationNumber: 'Q-77', daysToComplete: '4' };

// 2 x 300 + 1 x 150 = 750 parts; 4 hours x AED 50 = 200 labour; 50 consumables. Total 1000.
const BREAKDOWN = {
  parts: [
    { name: 'Water pump', description: 'Front', code: 'WP', partNumber: 'WP-1', quantity: 2, unitPrice: 300 },
    { name: 'Gasket', quantity: 1, unitPrice: 150 },
  ],
  labourHours: 4,
  consumables: 50,
  remarks: 'Pump seized, gasket worn.',
};
const saveBreakdown = (id, body = BREAKDOWN, token = users.creator.token) => api('PUT', `/tickets/${id}/breakdown`, { token, body });

describe('VSR numbers and estimates', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'EST', users.vendor1.id);
  });

  test('every raised VSR gets the next number in sequence', async () => {
    const first = await raised();
    const second = await raised();
    assert.match(first.vsrNumber, /^VSR-\d{4,}$/);
    assert.equal(Number(second.vsrNumber.slice(4)), Number(first.vsrNumber.slice(4)) + 1);
  });

  test('a vendor estimate needs a quotation number and days; the reply does not', async () => {
    const ticket = await raised();
    const send = (fields) => multipart(`/tickets/${ticket._id}/estimate`, users.vendor1.token, fields);

    const noQuotation = await send({ amount: '900', daysToComplete: '4' });
    assert.equal(noQuotation.status, 400);
    assert.equal(noQuotation.body.errors[0].field, 'quotationNumber');
    for (const daysToComplete of ['0', '1.5', 'soon']) {
      const badDays = await send({ amount: '900', quotationNumber: 'Q-1', daysToComplete });
      assert.equal(badDays.status, 400, daysToComplete);
      assert.equal(badDays.body.errors[0].field, 'daysToComplete');
    }

    const sent = await send(FULL_ESTIMATE);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const [round] = sent.body.data.negotiation;
    assert.equal(round.quotationNumber, 'Q-77');
    assert.equal(round.daysToComplete, 4);
    assert.equal(round.estimateNumber, 1);
    assert.equal(sent.body.data.daysToComplete, 4);

    const reply = await multipart(`/tickets/${ticket._id}/estimate/reply`, users.creator.token, { note: 'Lower please' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.negotiation[1].estimateNumber, undefined);

    const second = await send({ amount: '850', quotationNumber: 'Q-78', daysToComplete: '6' });
    assert.equal(second.body.data.negotiation[2].estimateNumber, 2, 'replies do not use up an estimate number');
    assert.equal(second.body.data.daysToComplete, 6, 'the latest estimate is the promise that counts');
  });

  test('an agreed-price VSR gets its days when the vendor acknowledges', async () => {
    const ticket = await raised({ serviceType: 'oil', repairCategory: undefined, currentReading: 9000 });
    assert.equal(ticket.status, 'approved', 'an agreed price goes to the vendor to acknowledge');

    const none = await api('PUT', `/tickets/${ticket._id}/acknowledge`, { token: users.vendor1.token });
    assert.equal(none.status, 400);
    assert.equal(none.body.errors[0].field, 'daysToComplete');
    const ok = await api('PUT', `/tickets/${ticket._id}/acknowledge`, { token: users.vendor1.token, body: { daysToComplete: 2 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.daysToComplete, 2);
  });

  test('the breakdown flag is for the depot only', async () => {
    const flagged = await raised({ isBreakdown: true });
    assert.equal(flagged.isBreakdown, true);
    const plain = await raised();
    assert.equal(plain.isBreakdown, false);
    assert.equal((await raise({ isBreakdown: 'maybe' })).status, 400);

    const seen = await api('GET', `/tickets/${flagged._id}`, { token: users.vendor1.token });
    assert.equal(seen.status, 200);
    assert.ok(!('isBreakdown' in seen.body.data));
    const list = await api('GET', '/tickets?limit=200', { token: users.vendor1.token });
    assert.ok(list.body.data.every((t) => !('isBreakdown' in t)));
    const supervisor = await api('GET', `/tickets/${flagged._id}`, { token: users.supervisor.token });
    assert.equal(supervisor.body.data.isBreakdown, true);
  });
});

describe('parts, labour and the check against the estimate', () => {
  test('the creator fills it in and it adds up; the discount is what the estimate takes off', async () => {
    const ticket = await raised();
    await estimate(ticket._id, users.vendor1.token, FULL_ESTIMATE);

    assert.equal((await saveBreakdown(ticket._id, BREAKDOWN, users.vendor1.token)).status, 403);
    const saved = await saveBreakdown(ticket._id);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const { breakdown } = saved.body.data;
    assert.equal(breakdown.parts[0].total, 600);
    assert.equal(breakdown.parts[0].partNumber, 'WP-1');
    assert.equal(breakdown.partsTotal, 750);
    assert.equal(breakdown.labourRate, 50, 'the labour charge comes from the bus');
    assert.equal(breakdown.labourTotal, 200);
    assert.equal(breakdown.consumables, 50);
    assert.equal(breakdown.quotationTotal, 1000);
    assert.equal(breakdown.estimateAmount, 900);
    assert.equal(breakdown.discount, 100);
    assert.equal(breakdown.remarks, 'Pump seized, gasket worn.');
  });

  test('it has to be filled in before going to the supervisor, and vendors never see it', async () => {
    const ticket = await raised();
    await estimate(ticket._id, users.vendor1.token, FULL_ESTIMATE);
    const early = await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token });
    assert.equal(early.status, 409);
    assert.match(early.body.message, /parts/i);
    assert.equal(early.body.code, 'NOT_READY', 'nothing changed under them, so the screen must not say it did');

    await saveBreakdown(ticket._id);
    const sent = await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.status, 'pending');

    const supervisor = await api('GET', `/tickets/${ticket._id}`, { token: users.supervisor.token });
    assert.equal(supervisor.body.data.breakdown.discount, 100);
    const vendor = await api('GET', `/tickets/${ticket._id}`, { token: users.vendor1.token });
    assert.ok(!('breakdown' in vendor.body.data));
    assert.ok(!JSON.stringify(vendor.body).includes('Water pump'));
  });

  test('a total below the estimate does not check out, and a new estimate is checked again', async () => {
    const ticket = await raised();
    await estimate(ticket._id, users.vendor1.token, { ...FULL_ESTIMATE, amount: '1100' });
    const saved = await saveBreakdown(ticket._id);
    assert.equal(saved.status, 200, 'the creator can save and then sort it out');
    assert.equal(saved.body.data.breakdown.discount, -100);

    const refused = await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /below/i);
    assert.equal(refused.body.code, 'NOT_READY');

    await multipart(`/tickets/${ticket._id}/estimate/reply`, users.creator.token, { note: 'That is above the parts and labour' });
    await estimate(ticket._id, users.vendor1.token, { ...FULL_ESTIMATE, amount: '950' });
    const sent = await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.breakdown.estimateAmount, 950);
    assert.equal(sent.body.data.breakdown.discount, 50);
  });

  test('bad lines, empty forms and labour on a bus without a charge are refused', async () => {
    const ticket = await raised();
    await estimate(ticket._id, users.vendor1.token, FULL_ESTIMATE);
    for (const [body, field] of [
      [{ parts: [{ quantity: 1, unitPrice: 1 }] }, 'parts[0].name'],
      [{ parts: [{ name: 'Pump', quantity: 0, unitPrice: 1 }] }, 'parts[0].quantity'],
      [{ parts: [{ name: 'Pump', quantity: 1, unitPrice: -1 }] }, 'parts[0].unitPrice'],
      [{ parts: 'lots' }, 'parts'],
      [{ labourHours: -1 }, 'labourHours'],
      [{ consumables: -1 }, 'consumables'],
      [{}, 'parts'],
    ]) {
      const res = await saveBreakdown(ticket._id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.errors[0].field, field, JSON.stringify(res.body.errors));
    }

    const noCharge = await createBus(users, 'NOLAB', users.vendor1.id, { labourRate: undefined, rates: undefined });
    const other = await raised({ busId: noCharge._id });
    await estimate(other._id, users.vendor1.token, FULL_ESTIMATE);
    const refused = await saveBreakdown(other._id, { labourHours: 2 });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.errors[0].field, 'labourHours');
    assert.equal((await saveBreakdown(other._id, { consumables: 900 })).status, 200, 'no labour, no charge needed');
  });

  test('it can only change while the price is still open', async () => {
    const ticket = await raised();
    assert.equal((await saveBreakdown(ticket._id)).status, 409, 'no estimate yet');

    await estimate(ticket._id, users.vendor1.token, FULL_ESTIMATE);
    await saveBreakdown(ticket._id);
    await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token });
    assert.equal((await saveBreakdown(ticket._id)).status, 409, 'waiting for approval');

    await api('PUT', `/tickets/${ticket._id}/return`, { token: users.supervisor.token, body: { reason: 'Check the labour' } });
    assert.equal((await saveBreakdown(ticket._id)).status, 200, 'returned to the creator');

    const priced = await raised({ serviceType: 'oil', repairCategory: undefined, currentReading: 9000 });
    await api('PUT', `/tickets/${priced._id}/return`, { token: users.supervisor.token, body: { reason: 'Check' } });
    assert.equal((await saveBreakdown(priced._id)).status, 409, 'an agreed price has nothing to break down');
  });
});
