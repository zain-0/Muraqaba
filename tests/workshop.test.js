/**
 * Item 3: the bus goes to the workshop and comes back, then the invoice, then purchasing.
 * Dates default to now and can be overridden. The vendor's "Mark completed" is gone.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, fileOf, multipart, signInEveryone, toAcknowledged, toInvoiceAccepted, toVehicleReturned } from './helpers.js';

let users;
let bus;
const put = (id, path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });

const raiseRepair = async (overrides = {}) => {
  const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000, ...overrides } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

describe('vehicle flow', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'WORK', users.vendor1.id, { rates: undefined });
  });

  test('each step belongs to one role, in one order, and moves the status on', async () => {
    const { _id: id } = await toAcknowledged(users, await raiseRepair(), users.vendor1);

    assert.equal((await put(id, 'vehicle/sent', users.vendor1.token)).status, 403);
    assert.equal((await put(id, 'vehicle/received', users.vendor1.token, { km: 5100 })).status, 409, 'not sent yet');
    const sent = await put(id, 'vehicle/sent', users.creator.token);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.status, 'vehicleSent');
    assert.ok(sent.body.data.vehicle.sentAt, 'the date defaults to now');

    assert.equal((await put(id, 'vehicle/received', users.creator.token, { km: 5100 })).status, 403);
    assert.equal((await put(id, 'vehicle/received', users.vendor2.token, { km: 5100 })).status, 403, 'another vendor');
    const noKm = await put(id, 'vehicle/received', users.vendor1.token, {});
    assert.equal(noKm.status, 400);
    assert.equal(noKm.body.errors[0].field, 'km');
    const received = await put(id, 'vehicle/received', users.vendor1.token, { km: 5100 });
    assert.equal(received.body.data.status, 'vehicleReceived');
    assert.equal(received.body.data.vehicle.receivedKm, 5100);

    assert.equal((await put(id, 'work/ready', users.vendor1.token)).status, 409, 'work has not started');
    const started = await put(id, 'work/start', users.vendor1.token);
    assert.equal(started.body.data.status, 'workInProgress');
    assert.ok(started.body.data.vehicle.workStartedAt);
    assert.equal((await put(id, 'vehicle/release', users.vendor1.token)).status, 409, 'not ready yet');
    const ready = await put(id, 'work/ready', users.vendor1.token);
    assert.equal(ready.body.data.status, 'readyForDelivery');
    const released = await put(id, 'vehicle/release', users.vendor1.token);
    assert.equal(released.body.data.status, 'vehicleReleased');
    assert.ok(released.body.data.vehicle.releasedAt);

    assert.equal((await put(id, 'vehicle/returned', users.vendor1.token, { km: 5200 })).status, 403);
    const noReading = await put(id, 'vehicle/returned', users.creator.token, {});
    assert.equal(noReading.status, 400);
    assert.equal(noReading.body.errors[0].field, 'km');
    const back = await put(id, 'vehicle/returned', users.creator.token, { km: 5200, replacedPartsReceived: true });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.data.status, 'vehicleReturned');
    assert.equal(back.body.data.vehicle.returnedKm, 5200);
    assert.equal(back.body.data.vehicle.replacedPartsReceived, true);
  });

  test('a date can be overridden, but never into the future', async () => {
    const { _id: id } = await toAcknowledged(users, await raiseRepair(), users.vendor1);
    const future = await put(id, 'vehicle/sent', users.creator.token, { date: '2099-01-01' });
    assert.equal(future.status, 400);
    assert.equal(future.body.errors[0].field, 'date');
    assert.equal((await put(id, 'vehicle/sent', users.creator.token, { date: 'yesterday' })).status, 400);

    const sent = await put(id, 'vehicle/sent', users.creator.token, { date: '2026-10-01' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.vehicle.sentAt.slice(0, 10), '2026-10-01');
    const entry = sent.body.data.history.at(-1);
    assert.equal(entry.status, 'vehicleSent');
    assert.equal(entry.effectiveAt.slice(0, 10), '2026-10-01');
    assert.notEqual(entry.at.slice(0, 10), '2026-10-01', 'the history still says when it was really clicked');

    const received = await put(id, 'vehicle/received', users.vendor1.token, { km: 5100, date: '2026-10-02' });
    assert.equal(received.body.data.vehicle.receivedAt.slice(0, 10), '2026-10-02');
    assert.equal(received.body.data.history.at(-1).km, 5100);
  });

  test('marking the bus back moves its last service on, and the next VSR counts from there', async () => {
    const own = await createBus(users, 'LAST', users.vendor1.id, { rates: undefined });
    const raised = await raiseRepair({ busId: own._id, serviceType: 'tyre', repairCategory: undefined, currentReading: 39000 });
    assert.equal(raised.intervalUsage.actual, 39000);
    await toVehicleReturned(users, raised, users.vendor1, { km: 39500 });

    const detail = await api('GET', `/buses/${own._id}`, { token: users.creator.token });
    assert.equal(detail.body.data.intervals.tyre.lastKm, 39500);
    assert.equal(detail.body.data.intervals.oil.lastKm, 0, 'only the service that was done');

    const next = await raiseRepair({ busId: own._id, serviceType: 'tyre', repairCategory: undefined, currentReading: 40000 });
    assert.equal(next.intervalUsage.actual, 500);

    const repair = await raiseRepair({ busId: own._id, currentReading: 40000 });
    await toVehicleReturned(users, repair, users.vendor1, { km: 41000 });
    const after = await api('GET', `/buses/${own._id}`, { token: users.creator.token });
    assert.equal(after.body.data.intervals.tyre.lastKm, 39500, 'a repair moves no interval');
  });

  test('a battery change resets the battery date', async () => {
    const own = await createBus(users, 'BATT', users.vendor1.id, { rates: undefined });
    const raised = await raiseRepair({ busId: own._id, serviceType: 'battery', repairCategory: undefined, currentReading: 100 });
    await toVehicleReturned(users, raised, users.vendor1, { km: 110, date: '2026-10-15' });
    const detail = await api('GET', `/buses/${own._id}`, { token: users.creator.token });
    assert.equal(detail.body.data.intervals.battery.lastDate.slice(0, 10), '2026-10-15');
  });

  test('the bus-back reading goes on the daily km sheet unless someone typed one', async () => {
    const own = await createBus(users, 'SHEET', users.vendor1.id, { rates: undefined });
    const raised = await raiseRepair({ busId: own._id, currentReading: 700 });
    await toVehicleReturned(users, raised, users.vendor1, { km: 800, date: '2026-10-20' });
    const sheet = await api('GET', '/sheets/readings?month=2026-10', { token: users.creator.token });
    assert.equal(sheet.body.data.buses.find((b) => b._id === own._id).readings['2026-10-20'], 800);
  });
});

describe('invoice and forwarding', () => {
  test('an invoice comes only after the bus is back, with a number and a file', async () => {
    const ticket = await toAcknowledged(users, await raiseRepair(), users.vendor1);
    const send = (id, fields, files = [fileOf('invoice.pdf')]) => multipart(`/tickets/${id}/invoice`, users.vendor1.token, fields, files);
    const fields = { amount: '900', description: 'Engine work and labour', invoiceNumber: 'INV-1' };

    assert.equal((await send(ticket._id, fields)).status, 409, 'the bus is not back yet');

    const back = await toVehicleReturned(users, await raiseRepair(), users.vendor1);
    const noNumber = await send(back._id, { amount: '900', description: 'Engine work and labour' });
    assert.equal(noNumber.status, 400);
    assert.equal(noNumber.body.errors[0].field, 'invoiceNumber');
    const noFile = await send(back._id, fields, []);
    assert.equal(noFile.status, 400);
    assert.equal(noFile.body.errors[0].field, 'attachments');

    const sent = await send(back._id, fields);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.data.status, 'invoiceSubmitted');
    const detail = await api('GET', `/tickets/${back._id}`, { token: users.supervisor.token });
    const [invoice] = detail.body.data.invoices;
    assert.equal(invoice.invoiceNumber, 'INV-1');
    assert.equal(invoice.attachments[0].name, 'invoice.pdf');

    const download = await fetch(`${process.env.API_URL}/api/tickets/${back._id}/attachments/${invoice.attachments[0]._id}`, { headers: { Authorization: `Bearer ${users.supervisor.token}` } });
    assert.equal(download.status, 200);
  });

  test('after acceptance the creator receives it and forwards it, and the vendor no longer closes it', async () => {
    const { _id: id } = await toInvoiceAccepted(users, await raiseRepair(), users.vendor1);

    assert.equal((await put(id, 'complete', users.vendor1.token)).status, 404, 'Mark completed is gone');
    assert.equal((await put(id, 'forward', users.creator.token)).status, 409, 'receive it first');
    assert.equal((await put(id, 'invoice/received', users.vendor1.token)).status, 403);
    const received = await put(id, 'invoice/received', users.creator.token);
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.data.status, 'invoiceReceived');
    assert.ok(received.body.data.invoiceReceivedAt);

    assert.equal((await put(id, 'forward', users.creator.token)).status, 200);
    const detail = await api('GET', `/tickets/${id}`, { token: users.purchasing.token });
    assert.equal(detail.status, 200, 'purchasing can read it');
    assert.equal(detail.body.data.status, 'forwardedToPurchase');
    assert.ok(detail.body.data.forwardedAt);
  });

  test('purchasing sees nothing before the invoice stage', async () => {
    const early = await toVehicleReturned(users, await raiseRepair(), users.vendor1);
    assert.equal((await api('GET', `/tickets/${early._id}`, { token: users.purchasing.token })).status, 404);
    const list = await api('GET', '/tickets?limit=200', { token: users.purchasing.token });
    assert.ok(!list.body.data.some((t) => t._id === early._id));
    assert.ok(!list.body.data.some((t) => ['vehicleSent', 'vehicleReturned'].includes(t.status)));
  });
});
