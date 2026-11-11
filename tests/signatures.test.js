/**
 * Item 9: each person draws a signature once. It is stamped with their name and the time on
 * the key steps of a VSR, and stays as it was even if they change their signature later.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, multipart, register, run, signInEveryone, signatureOf, toAcknowledged, toForwarded } from './helpers.js';

let users;
let bus;
const raise = async (busId = bus._id) => {
  const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000 } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const steps = (ticket) => ticket.signatures.map((s) => s.step);

describe('signatures', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'SIGN', users.vendor1.id, { rates: undefined });
  });

  test('anyone can save their own signature, and only a real PNG drawing', async () => {
    const fresh = await register('vendor', 'sign-new');
    const me = await api('GET', '/auth/me', { token: fresh.token });
    assert.equal(me.body.user.hasSignature, false);

    for (const image of ['', 'hello', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${'A'.repeat(100001)}`]) {
      const bad = await api('PUT', '/users/signature', { token: fresh.token, body: { image } });
      assert.ok(bad.status === 400 || bad.status === 413, `refused ${image.slice(0, 30)}`);
    }
    assert.equal((await api('PUT', '/users/signature', { body: { image: signatureOf('x') } })).status, 401);

    const saved = await api('PUT', '/users/signature', { token: fresh.token, body: { image: signatureOf('mine') } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const after = await api('GET', '/auth/me', { token: fresh.token });
    assert.equal(after.body.user.hasSignature, true);

    const mine = await api('GET', '/users/signature', { token: fresh.token });
    assert.equal(mine.body.data.image, signatureOf('mine'));
  });

  test('the key steps refuse someone without a signature and say why', async () => {
    const vendor = await register('vendor', 'sign-none');
    const own = await createBus(users, 'SIGN2', vendor.id, { rates: { oil: 1 } });
    const raised = await api('POST', '/tickets', { token: users.creator.token, body: { busId: own._id, serviceType: 'oil', currentReading: 100, supervisorFirst: true } });
    const id = raised.body.data._id;
    assert.equal((await api('PUT', `/tickets/${id}/approve`, { token: users.supervisor.token })).status, 200);

    const refused = await api('PUT', `/tickets/${id}/acknowledge`, { token: vendor.token, body: { daysToComplete: 2 } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'SIGNATURE_REQUIRED');
    const still = await api('GET', `/tickets/${id}`, { token: users.creator.token });
    assert.equal(still.body.data.status, 'approved', 'nothing moved');

    await api('PUT', '/users/signature', { token: vendor.token, body: { image: signatureOf('vendor') } });
    const ok = await api('PUT', `/tickets/${id}/acknowledge`, { token: vendor.token, body: { daysToComplete: 2 } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test('every key step is stamped with who and when, and the VSR shows the drawing', async () => {
    const ticket = await raise();
    const forwarded = await toForwarded(users, ticket, users.vendor1);
    assert.deepEqual(steps(forwarded), ['escalated', 'approved', 'acknowledged', 'vehicleReleased', 'invoiceAccepted']);
    const approved = forwarded.signatures[1];
    assert.equal(approved.name, 'Test Supervisor');
    assert.equal(approved.role, 'supervisor');
    assert.ok(approved.at);

    const detail = await api('GET', `/tickets/${ticket._id}`, { token: users.creator.token });
    assert.equal(detail.body.data.signatures[1].image.image, signatureOf('supervisor'));

    const list = await api('GET', '/tickets?limit=200', { token: users.creator.token });
    const row = list.body.data.find((t) => t._id === ticket._id);
    assert.ok(row.signatures.every((s) => typeof s.image !== 'object'), 'lists stay light');

    const grn = await multipart('/grns', users.purchasing.token, { number: `GRN-${run}-S`, ticketIds: ticket._id });
    assert.equal(grn.status, 201, JSON.stringify(grn.body));
    const pi = await multipart('/purchase-invoices', users.purchasing.token, { number: `PI-${run}-S`, grnId: grn.body.data._id });
    assert.equal(pi.status, 201, JSON.stringify(pi.body));
    const closed = await api('GET', `/tickets/${ticket._id}`, { token: users.creator.token });
    assert.deepEqual(steps(closed.body.data).slice(-2), ['grn', 'purchaseInvoice']);
  });

  test('changing a signature later leaves the old stamps as they were', async () => {
    const supervisor = users.supervisor;
    await api('PUT', '/users/signature', { token: supervisor.token, body: { image: signatureOf('old') } });
    const ticket = await toAcknowledged(users, await raise(), users.vendor1);
    await api('PUT', '/users/signature', { token: supervisor.token, body: { image: signatureOf('new') } });

    const detail = await api('GET', `/tickets/${ticket._id}`, { token: users.creator.token });
    const stamp = detail.body.data.signatures.find((s) => s.step === 'approved');
    assert.equal(stamp.image.image, signatureOf('old'));

    await api('PUT', '/users/signature', { token: supervisor.token, body: { image: signatureOf('supervisor') } });
  });

  test('reading a signature only ever returns your own', async () => {
    const seen = await api('GET', `/users/signature`, { token: users.vendor2.token });
    assert.equal(seen.status, 200);
    assert.notEqual(seen.body.data.image, signatureOf('supervisor'));
  });
});
