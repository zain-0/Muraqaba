/**
 * Items 7 and 12: purchasing takes forwarded VSRs in batches, makes one GRN and one purchase
 * invoice for them, can download the batch as Excel, and the purchase invoice closes them.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { BASE, api, createBus, fileOf, multipart, run, signInEveryone, toForwarded, toVehicleReturned } from './helpers.js';

let users;
let bus;
let bus2;
const raise = async (busId = bus._id) => {
  const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 5000 } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const forwarded = async (amount = '900', vendor = users.vendor1, busId) => toForwarded(users, await raise(busId), vendor, { invoice: { amount } });
const grnNumber = (label) => `GRN-${run}-${label}`;
const makeGrn = (fields, files = [], token = users.purchasing.token) => multipart('/grns', token, fields, files);
const piNumber = (label) => `PI-${run}-${label}`;
const makePi = (fields, files = [], token = users.purchasing.token) => multipart('/purchase-invoices', token, fields, files);
const getTicket = async (id, token = users.supervisor.token) => (await api('GET', `/tickets/${id}`, { token })).body.data;

describe('GRN', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'PUR', users.vendor1.id, { rates: undefined });
    bus2 = await createBus(users, 'PUR2', users.vendor2.id, { rates: undefined });
  });

  test('one GRN covers a batch of VSRs and adds up their accepted invoices', async () => {
    const a = await forwarded('900');
    const b = await forwarded('450.50');
    const fields = { number: grnNumber('BATCH'), ticketIds: `${a._id},${b._id}`, notes: 'Received in good order' };

    assert.equal((await makeGrn(fields, [], users.creator.token)).status, 403);
    assert.equal((await makeGrn(fields, [], users.vendor1.token)).status, 403);

    const res = await makeGrn(fields, [fileOf('grn.pdf')]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.number, fields.number);
    assert.equal(res.body.data.total, 1350.5);
    assert.equal(res.body.data.tickets.length, 2);
    assert.equal(res.body.data.vendor, users.vendor1.id);

    for (const ticket of [a, b]) {
      const after = await getTicket(ticket._id);
      assert.equal(after.status, 'grnCreated');
      assert.equal(after.grn.number, fields.number);
      assert.equal(after.history.at(-1).status, 'grnCreated');
    }

    const list = await api('GET', '/grns', { token: users.purchasing.token });
    assert.ok(list.body.data.some((g) => g.number === fields.number));
    assert.equal((await api('GET', '/grns', { token: users.vendor1.token })).status, 403);
  });

  test('a batch is all or nothing: only forwarded VSRs, one vendor, a unique number', async () => {
    const good = await forwarded();
    const early = await toVehicleReturned(users, await raise(), users.vendor1);
    const notForwarded = await makeGrn({ number: grnNumber('EARLY'), ticketIds: `${good._id},${early._id}` });
    assert.equal(notForwarded.status, 409);
    assert.match(notForwarded.body.message, new RegExp(early.vsrNumber));
    assert.equal((await getTicket(good._id)).status, 'forwardedToPurchase', 'the good one is untouched');

    const other = await forwarded('100', users.vendor2, bus2._id);
    const mixed = await makeGrn({ number: grnNumber('MIX'), ticketIds: `${good._id},${other._id}` });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.errors[0].field, 'ticketIds');

    assert.equal((await makeGrn({ ticketIds: good._id })).body.errors[0].field, 'number');
    assert.equal((await makeGrn({ number: grnNumber('NONE'), ticketIds: '' })).body.errors[0].field, 'ticketIds');
    assert.equal((await makeGrn({ number: grnNumber('BAD'), ticketIds: 'nope' })).status, 400);
    assert.equal((await makeGrn({ number: grnNumber('MISS'), ticketIds: '64b000000000000000000000' })).status, 404);

    assert.equal((await makeGrn({ number: grnNumber('ONE'), ticketIds: good._id })).status, 201);
    const again = await forwarded();
    assert.equal((await makeGrn({ number: grnNumber('ONE'), ticketIds: again._id })).status, 409, 'the number is taken');
    assert.equal((await getTicket(again._id)).status, 'forwardedToPurchase');
  });

  test('GRN documents stay with the depot', async () => {
    const ticket = await forwarded();
    const res = await makeGrn({ number: grnNumber('DOC'), ticketIds: ticket._id }, [fileOf('grn.pdf', '%PDF-1.4 goods')]);
    const [file] = res.body.data.attachments;
    const url = `${BASE}/tickets/${ticket._id}/attachments/${file._id}`;
    const fetchFile = (token) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const ok = await fetchFile(users.supervisor.token);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '%PDF-1.4 goods');
    assert.equal((await fetchFile(users.vendor1.token)).status, 404, 'the vendor owns the VSR but not this file');

    const seen = await getTicket(ticket._id, users.vendor1.token);
    assert.ok(!('grn' in seen));
  });

  test('the batch downloads as a real Excel file', async () => {
    const a = await forwarded('900');
    const b = await forwarded('250');
    const url = `${BASE}/grns/export?ticketIds=${a._id},${b._id}`;
    const denied = await fetch(url, { headers: { Authorization: `Bearer ${users.creator.token}` } });
    assert.equal(denied.status, 403);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${users.purchasing.token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.match(res.headers.get('content-disposition'), /\.xlsx/);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const sheet = book.worksheets[0];
    const rows = [];
    sheet.eachRow((row) => rows.push(row.values.slice(1)));
    assert.equal(rows.length, 4, 'header, two VSRs, total');
    assert.ok(rows[0].includes('VSR'));
    const flat = JSON.stringify(rows);
    assert.ok(flat.includes(a.vsrNumber) && flat.includes(b.vsrNumber));
    assert.ok(flat.includes(bus.fleetNumber));
    assert.ok(rows[1].includes(900) && rows[2].includes(250));
    assert.ok(rows[3].includes(1150), 'the last row adds them up');

    const none = await fetch(`${BASE}/grns/export?ticketIds=`, { headers: { Authorization: `Bearer ${users.purchasing.token}` } });
    assert.equal(none.status, 400);
  });
});

describe('purchase invoice', () => {
  test('one purchase invoice closes every VSR of its GRN', async () => {
    const a = await forwarded('900');
    const b = await forwarded('100');
    const grn = (await makeGrn({ number: grnNumber('PI'), ticketIds: `${a._id},${b._id}` })).body.data;

    assert.equal((await makePi({ number: piNumber('X'), grnId: grn._id }, [], users.supervisor.token)).status, 403);
    assert.equal((await makePi({ grnId: grn._id })).body.errors[0].field, 'number');
    assert.equal((await makePi({ number: piNumber('Y'), grnId: '64b000000000000000000000' })).status, 404);

    const res = await makePi({ number: piNumber('OK'), grnId: grn._id }, [fileOf('pi.pdf')]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.amount, 1000, 'defaults to the GRN total');

    for (const ticket of [a, b]) {
      const after = await getTicket(ticket._id);
      assert.equal(after.status, 'completed');
      assert.ok(after.completedAt);
      assert.equal(after.purchaseInvoice.number, piNumber('OK'));
      assert.equal(after.grn.number, grnNumber('PI'));
    }

    const twice = await makePi({ number: piNumber('AGAIN'), grnId: grn._id });
    assert.equal(twice.status, 409);

    const seen = await getTicket(a._id, users.vendor1.token);
    assert.equal(seen.status, 'completed');
    assert.ok(!('purchaseInvoice' in seen));
  });

  test('the amount can differ from the GRN, and a closed VSR shows on the repair sheet that day', async () => {
    const ticket = await forwarded('500');
    const grn = (await makeGrn({ number: grnNumber('AMT'), ticketIds: ticket._id })).body.data;
    assert.equal((await makePi({ number: piNumber('NEG'), grnId: grn._id, amount: '-1' })).status, 400);
    const res = await makePi({ number: piNumber('AMT'), grnId: grn._id, amount: '480' });
    assert.equal(res.body.data.amount, 480);

    const sheet = (await api('GET', '/sheets/repairs', { token: users.supervisor.token })).body.data;
    assert.equal(sheet.rows.find((r) => r._id === ticket._id).stage, 'closed');
    assert.ok(sheet.summary.closed[sheet.days.indexOf(sheet.today)] >= 1);
  });
});
