/**
 * What browser testing on 2026-11-06 found: values the API took that it should not have,
 * numbers that differ only in letter case, dates out of order, and wording.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { BASE, api, busBody, createBus, estimate, fileOf, fillBreakdown, multipart, newVendor, run, signInEveryone, submitInvoice, toAcknowledged, toForwarded, toVehicleReturned } from './helpers.js';
import { uaeDaysUntil } from '../utils/uaeTime.js';

let users;
let bus;
const VALID = { validFrom: '2026-01-01', validTo: '2099-12-31' };
let counter = 0;
const lpo = (items, overrides = {}) => {
  counter += 1;
  return api('POST', '/lpos', { token: users.purchasing.token, body: { number: `QA-${run}-${counter}`, vendorId: users.vendor1.id, ...VALID, items, ...overrides } });
};
const firstError = (res) => res.body.errors?.[0];
const raise = async (body = {}) => {
  const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ELECTRICAL', currentReading: 5000, ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

describe('browser testing findings', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'QA', users.vendor1.id, { rates: undefined });
  });

  describe('numbers', () => {
    test('a number too large says so, rather than asking for one above zero', async () => {
      const res = await lpo([{ kind: 'repair', name: 'Repairs', quantity: 2e12, unitPrice: 1 }]);
      assert.equal(res.status, 400);
      assert.deepEqual(firstError(res), { field: 'items[0].quantity', message: 'That number is too large' });
      const price = await lpo([{ kind: 'repair', name: 'Repairs', quantity: 1, unitPrice: 2e12 }]);
      assert.equal(firstError(price).message, 'That number is too large');
    });

    test('tyres and batteries come in whole numbers on an LPO, and so does what was fitted', async () => {
      for (const kind of ['tyre', 'battery']) {
        const res = await lpo([{ kind, name: 'Item', quantity: 2.5, unitPrice: 100 }]);
        assert.equal(res.status, 400, kind);
        assert.deepEqual(firstError(res), { field: 'items[0].quantity', message: 'Enter a whole number' });
      }
      assert.equal((await lpo([{ kind: 'repair', name: 'Repairs', quantity: 1.5, unitPrice: 100 }])).status, 201, 'a repair line can be part of a unit');

      const ticket = await raise({ serviceType: 'tyre', repairCategory: undefined });
      await estimate(ticket._id, users.vendor1.token, { amount: '1600' });
      const fitted = await api('PUT', `/tickets/${ticket._id}/breakdown`, { token: users.creator.token, body: { parts: [{ name: 'Tyre', quantity: 2, unitPrice: 800 }], unitsFitted: 1.5 } });
      assert.equal(fitted.status, 400);
      assert.deepEqual(firstError(fitted), { field: 'unitsFitted', message: 'Enter a whole number' });
    });

    test('money has at most two decimals, wherever it is typed', async () => {
      const priced = await lpo([{ kind: 'repair', name: 'Repairs', quantity: 1, unitPrice: 0.005 }]);
      assert.deepEqual(firstError(priced), { field: 'items[0].unitPrice', message: 'Use at most 2 decimals' });
      assert.equal((await lpo([{ kind: 'repair', name: 'Repairs', quantity: 1, unitPrice: 0.05 }])).status, 201);

      const ticket = await raise();
      const sent = await estimate(ticket._id, users.vendor1.token, { amount: '10.555' });
      assert.deepEqual(firstError(sent), { field: 'amount', message: 'Use at most 2 decimals' });
      await estimate(ticket._id, users.vendor1.token, { amount: '10.5' });
      const parts = await api('PUT', `/tickets/${ticket._id}/breakdown`, { token: users.creator.token, body: { parts: [{ name: 'Fuse', quantity: 1, unitPrice: 0.001 }] } });
      assert.deepEqual(firstError(parts), { field: 'parts[0].unitPrice', message: 'Use at most 2 decimals' });
      const extras = await api('PUT', `/tickets/${ticket._id}/breakdown`, { token: users.creator.token, body: { consumables: 1.001 } });
      assert.deepEqual(firstError(extras), { field: 'consumables', message: 'Use at most 2 decimals' });
      assert.equal((await api('PUT', `/tickets/${ticket._id}/breakdown`, { token: users.creator.token, body: { consumables: 10.5 } })).status, 200);

      const back = await toVehicleReturned(users, await raise(), users.vendor1);
      const invoice = await multipart(`/tickets/${back._id}/invoice`, users.vendor1.token, { amount: '900.125', description: 'Work done as estimated', invoiceNumber: `INV-${run}-DP` }, [fileOf('i.pdf')]);
      assert.deepEqual(firstError(invoice), { field: 'amount', message: 'Use at most 2 decimals' });
    });

    test('a purchase invoice amount says when it is too large, or has too many decimals', async () => {
      const ticket = await toForwarded(users, await raise(), users.vendor1);
      const grn = (await multipart('/grns', users.purchasing.token, { number: `QA-GRN-${run}-N`, ticketIds: ticket._id })).body.data;
      for (const [amount, message] of [['1e13', 'That number is too large'], ['12.345', 'Use at most 2 decimals']]) {
        const res = await multipart('/purchase-invoices', users.purchasing.token, { number: `QA-PI-${run}-N`, grnId: grn._id, amount });
        assert.deepEqual(firstError(res), { field: 'amount', message }, amount);
      }
    });
  });

  describe('numbers that differ only in letter case are the same number', () => {
    test('LPO, GRN and purchase invoice numbers', async () => {
      assert.equal((await lpo([{ kind: 'repair', name: 'R', quantity: 1, unitPrice: 1 }], { number: `QA-CASE-${run}` })).status, 201);
      const lower = await lpo([{ kind: 'repair', name: 'R', quantity: 1, unitPrice: 1 }], { number: `qa-case-${run}` });
      assert.equal(lower.status, 409);
      assert.equal(firstError(lower).field, 'number');

      const [a, b] = [await toForwarded(users, await raise(), users.vendor1), await toForwarded(users, await raise(), users.vendor1)];
      const grn = await multipart('/grns', users.purchasing.token, { number: `QA-GRN-CASE-${run}`, ticketIds: a._id });
      assert.equal(grn.status, 201);
      assert.equal((await multipart('/grns', users.purchasing.token, { number: `qa-grn-case-${run}`, ticketIds: b._id })).status, 409);
      const other = await multipart('/grns', users.purchasing.token, { number: `QA-GRN-CASE2-${run}`, ticketIds: b._id });
      assert.equal((await multipart('/purchase-invoices', users.purchasing.token, { number: `QA-PI-CASE-${run}`, grnId: grn.body.data._id })).status, 201);
      assert.equal((await multipart('/purchase-invoices', users.purchasing.token, { number: `qa-pi-case-${run}`, grnId: other.body.data._id })).status, 409);
    });

    test('site, registration and chassis numbers on a bus', async () => {
      const first = await createBus(users, 'CASE', users.vendor1.id);
      for (const [i, field] of ['fleetNumber', 'registrationNumber', 'chassisNumber'].entries()) {
        const body = { ...first, vendorId: users.vendor1.id, fleetNumber: `F-${run}-${i}`, registrationNumber: `R-${run}-${i}`, chassisNumber: `C-${run}-${i}`, [field]: first[field].toLowerCase() };
        delete body._id;
        const res = await api('POST', '/buses', { token: users.creator.token, body: { ...body, registrationExpiry: '2030-06-30', intervals: { ...first.intervals, battery: { everyMonths: 18, lastDate: '2026-01-01' } } } });
        assert.equal(res.status, 409, field);
        assert.equal(firstError(res).field, field);
      }
    });
  });

  describe('dates in order', () => {
    test('a GRN cannot be dated before its VSRs reached purchasing, nor a purchase invoice before its GRN', async () => {
      const ticket = await toForwarded(users, await raise(), users.vendor1);
      const early = await multipart('/grns', users.purchasing.token, { number: `QA-GRN-D-${run}`, ticketIds: ticket._id, date: '2020-01-01' });
      assert.equal(early.status, 400);
      assert.equal(firstError(early).field, 'date');
      const grn = await multipart('/grns', users.purchasing.token, { number: `QA-GRN-D-${run}`, ticketIds: ticket._id });
      assert.equal(grn.status, 201, JSON.stringify(grn.body));

      const before = await multipart('/purchase-invoices', users.purchasing.token, { number: `QA-PI-D-${run}`, grnId: grn.body.data._id, date: '2020-01-01' });
      assert.equal(before.status, 400);
      assert.equal(firstError(before).field, 'date');
      assert.equal((await multipart('/purchase-invoices', users.purchasing.token, { number: `QA-PI-D-${run}`, grnId: grn.body.data._id })).status, 201);
    });

    test('a battery cannot have been changed before the bus was built, or in the future', async () => {
      for (const lastDate of ['1900-01-01', '2099-01-01']) {
        const res = await api('POST', '/buses', {
          token: users.creator.token,
          body: { ...busBody(`BD${lastDate.slice(0, 2)}`, users.vendor1.id), year: 2020, intervals: { oil: { everyKm: 10000, lastKm: 0 }, transmission: { everyKm: 60000, lastKm: 0 }, tyre: { everyKm: 40000, lastKm: 0 }, battery: { everyMonths: 18, lastDate } } },
        });
        assert.equal(res.status, 400, lastDate);
        assert.equal(firstError(res).field, 'intervals.battery.lastDate');
      }
    });

    test('the weekly report covers seven whole days, ending today', async () => {
      const { from } = (await api('GET', '/reports/weekly', { token: users.supervisor.token })).body.data;
      const sixDaysAgo = new Date(Date.now() + 4 * 3600 * 1000 - 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      assert.equal(new Date(from).getTime(), new Date(`${sixDaysAgo}T00:00:00+04:00`).getTime());
    });
  });

  describe('wording', () => {
    test('a VSR already on a GRN says so', async () => {
      const ticket = await toForwarded(users, await raise(), users.vendor1);
      await multipart('/grns', users.purchasing.token, { number: `QA-GRN-W-${run}`, ticketIds: ticket._id });
      const again = await multipart('/grns', users.purchasing.token, { number: `QA-GRN-W2-${run}`, ticketIds: ticket._id });
      assert.equal(again.status, 409);
      assert.match(again.body.message, new RegExp(`${ticket.vsrNumber} is already on GRN QA-GRN-W-${run}`));
    });

    test('the Excel file writes dates as dates and names the repair category', async () => {
      const ticket = await toForwarded(users, await raise(), users.vendor1);
      const res = await fetch(`${BASE}/grns/export?ticketIds=${ticket._id}`, { headers: { Authorization: `Bearer ${users.purchasing.token}` } });
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.from(await res.arrayBuffer()));
      const [, row] = book.worksheets[0].getSheetValues().filter(Boolean);
      assert.ok(row.includes('Repair: Electrical'));
      assert.ok(row.some((value) => value instanceof Date), 'the invoice date is an Excel date');
    });

    test('a vendor never reads what the creator wrote to the supervisor', async () => {
      const ticket = await raise();
      await estimate(ticket._id, users.vendor1.token, { amount: '100' });
      await api('PUT', `/tickets/${ticket._id}/breakdown`, { token: users.creator.token, body: { consumables: 100 } });
      await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token, body: { note: 'Consumables checked, unchanged.' } });
      const seen = await api('GET', `/tickets/${ticket._id}`, { token: users.vendor1.token });
      assert.ok(!JSON.stringify(seen.body).includes('Consumables checked'));
      const depot = await api('GET', `/tickets/${ticket._id}`, { token: users.creator.token });
      assert.ok(JSON.stringify(depot.body).includes('Consumables checked'));
    });
  });

  describe('a returned VSR keeps how it was priced', () => {
    const correct = (ticket, changes) =>
      api('PUT', `/tickets/${ticket._id}/details`, {
        token: users.creator.token,
        body: { busId: ticket.busId._id ?? ticket.busId, serviceType: ticket.serviceType, repairCategory: ticket.repairCategory, currentReading: ticket.currentReading, description: 'Corrected', ...changes },
      });
    const returned = async (ticket) => (await api('PUT', `/tickets/${ticket._id}/return`, { token: users.supervisor.token, body: { reason: 'Check it' } })).body.data;

    test('an agreed price stays as raised when only the details change', async () => {
      const rated = await createBus(users, 'PRICE', users.vendor1.id, { rates: { oil: 0.15, transmission: 1 } });
      const raisedRes = await api('POST', '/tickets', { token: users.creator.token, body: { busId: rated._id, serviceType: 'oil', currentReading: 5000 } });
      const raised = raisedRes.body.data;
      assert.equal(raised.agreedPrice.amount, 1500);
      const edit = { ...busBody('PRICE', users.vendor1.id), rates: { oil: 0.25, transmission: 1 }, intervals: { ...busBody('PRICE', users.vendor1.id).intervals, oil: { everyKm: 12000, lastKm: 0 } } };
      delete edit.vendorId;
      assert.equal((await api('PUT', `/buses/${rated._id}`, { token: users.creator.token, body: edit })).status, 200);
      const back = await returned(raised);
      const saved = await correct(back, { description: 'Only the words changed' });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.data.agreedPrice.amount, 1500);
      assert.equal(saved.body.data.agreedPrice.rate, 0.15);
    });

    test('a correction cannot switch a VSR between the bus rate and an estimate', async () => {
      const rated = await createBus(users, 'SWITCH', users.vendor1.id);
      const repair = await raise({ busId: rated._id });
      await estimate(repair._id, users.vendor1.token, { amount: '500' });
      await fillBreakdown(users, repair._id, 500);
      await api('PUT', `/tickets/${repair._id}/escalate`, { token: users.creator.token });
      const toOil = await correct(await returned(repair), { serviceType: 'oil', repairCategory: undefined });
      assert.equal(toOil.status, 409);
      assert.match(toOil.body.message, /how the VSR is priced/);

      const oil = (await api('POST', '/tickets', { token: users.creator.token, body: { busId: rated._id, serviceType: 'oil', currentReading: 5000 } })).body.data;
      const other = await newVendor('qa-switch');
      const toOtherVendor = await correct(await returned(oil), { vendorId: other.id });
      assert.equal(toOtherVendor.status, 409);
      assert.match(toOtherVendor.body.message, /how the VSR is priced/);
    });

    test('moving a VSR to another bus prices its labour at that bus\'s charge', async () => {
      const [first, second] = [await createBus(users, 'LAB1', users.vendor1.id, { labourRate: 50 }), await createBus(users, 'LAB2', users.vendor1.id, { labourRate: 75 })];
      const ticket = await raise({ busId: first._id });
      await estimate(ticket._id, users.vendor1.token, { amount: '100' });
      assert.equal((await api('PUT', `/tickets/${ticket._id}/breakdown`, { token: users.creator.token, body: { labourHours: 2 } })).status, 200);
      await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token });
      const moved = await correct(await returned(ticket), { busId: second._id });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body.data.breakdown.labourRate, 75);
      assert.equal(moved.body.data.breakdown.labourTotal, 150);
      assert.equal(moved.body.data.breakdown.quotationTotal, 150);
    });
  });

  describe('the km sheet', () => {
    const put = (busId, date, km) => api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId, date, km } });

    test('an odometer never goes down, and never jumps more than 20,000 km in a step', async () => {
      const own = await createBus(users, 'SHEET', users.vendor1.id);
      assert.equal((await put(own._id, '2026-10-10', 300000)).status, 200);
      const lower = await put(own._id, '2026-10-11', 5);
      assert.equal(lower.status, 400);
      assert.equal(firstError(lower).field, 'km');
      const jump = await put(own._id, '2026-10-12', 330000);
      assert.equal(jump.status, 400);
      assert.equal(firstError(jump).field, 'km');
      const beforeLater = await put(own._id, '2026-10-09', 300500);
      assert.equal(beforeLater.status, 400, 'a day cannot read more than a later day');
      assert.equal((await put(own._id, '2026-10-11', 300150)).status, 200);
      assert.equal((await put(own._id, '2026-10-10', 299900)).status, 200, 'correcting a day within its neighbours');
    });

    test('a bus shows only from the day it was added', async () => {
      const added = await createBus(users, 'NEW', users.vendor1.id);
      const previousMonth = new Date(Date.now() + 4 * 3600 * 1000);
      previousMonth.setUTCDate(1);
      previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
      const month = previousMonth.toISOString().slice(0, 7);
      const readings = await api('GET', `/sheets/readings?month=${month}`, { token: users.creator.token });
      assert.ok(!readings.body.data.buses.some((bus) => bus._id === added._id));
      const status = await api('GET', `/sheets/status?month=${month}`, { token: users.creator.token });
      assert.ok(!status.body.data.buses.some((bus) => bus._id === added._id));
    });
  });

  describe('the trip to the workshop', () => {
    test('pressing Release twice releases once and answers the second press plainly', async () => {
      const ticket = await toAcknowledged(users, await raise(), users.vendor1);
      const put = (path, token, body) => api('PUT', `/tickets/${ticket._id}/${path}`, { token, body });
      await put('vehicle/sent', users.creator.token);
      await put('vehicle/received', users.vendor1.token, { km: 5000 });
      await put('work/start', users.vendor1.token);
      await put('work/ready', users.vendor1.token);
      const presses = await Promise.all(Array.from({ length: 6 }, () => put('vehicle/release', users.vendor1.token)));
      const statuses = presses.map((res) => res.status);
      assert.equal(statuses.filter((status) => status === 200).length, 1, statuses.join());
      assert.ok(statuses.every((status) => status === 200 || status === 409), statuses.join());
    });

    test('a parent waiting on several jobs names all of them', async () => {
      const ticket = await toAcknowledged(users, await raise(), users.vendor1);
      const put = (path, token, body) => api('PUT', `/tickets/${ticket._id}/${path}`, { token, body });
      await put('vehicle/sent', users.creator.token);
      await put('vehicle/received', users.vendor1.token, { km: 5000 });
      const job = (n) => multipart(`/tickets/${ticket._id}/additional`, users.vendor1.token, { amount: '100', quotationNumber: `Q-${n}`, daysToComplete: '1', serviceType: 'other', description: 'Something else found' });
      const [b, c] = [(await job(1)).body.data, (await job(2)).body.data];
      await put('work/start', users.vendor1.token);
      await put('work/ready', users.vendor1.token);
      const blocked = await put('vehicle/release', users.vendor1.token);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.message, `${b.vsrNumber} and ${c.vsrNumber} are still waiting. They have to be approved or declined before the bus can leave.`);
    });
  });

  describe('invoices', () => {
    test('staff see when an invoice number is already on another of the vendor\'s VSRs', async () => {
      const [first, second] = [await toVehicleReturned(users, await raise(), users.vendor1), await toVehicleReturned(users, await raise(), users.vendor1)];
      await submitInvoice(first._id, users.vendor1, { invoiceNumber: `QA-SAME-${run}` });
      assert.equal((await submitInvoice(second._id, users.vendor1, { invoiceNumber: `qa-same-${run}` })).status, 201);
      const seen = await api('GET', `/tickets/${second._id}`, { token: users.supervisor.token });
      assert.deepEqual(seen.body.data.duplicateInvoiceNumber, [{ _id: first._id, vsrNumber: first.vsrNumber }]);
      const vendor = await api('GET', `/tickets/${second._id}`, { token: users.vendor1.token });
      assert.equal(vendor.body.data.duplicateInvoiceNumber, undefined);
    });

    test('a number too long says so', async () => {
      const back = await toVehicleReturned(users, await raise(), users.vendor1);
      const res = await submitInvoice(back._id, users.vendor1, { invoiceNumber: 'N'.repeat(61) });
      assert.deepEqual(firstError(res), { field: 'invoiceNumber', message: 'Keep the number to 60 characters or fewer' });
    });
  });

  describe('messages that name the right problem', () => {
    test('days to complete says what it takes', async () => {
      const ticket = await raise();
      const res = await estimate(ticket._id, users.vendor1.token, { amount: '100', daysToComplete: '2.5' });
      assert.deepEqual(firstError(res), { field: 'daysToComplete', message: 'Enter a whole number of days, from 1 to 3650' });
    });

    test('a reading too large says so', async () => {
      const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ELECTRICAL', currentReading: 99999999999999 } });
      assert.deepEqual(firstError(res), { field: 'currentReading', message: 'That number is too large' });
    });

    test('a password of only spaces is refused, and one too long says so', async () => {
      const register = (password) => api('POST', '/auth/register', { body: { name: 'Space Vendor', email: `spaces-${run}@muraqaba.test`, password, role: 'vendor' } });
      assert.deepEqual(firstError(await register('      ')), { field: 'password', message: 'Password cannot be only spaces' });
      assert.deepEqual(firstError(await register('x'.repeat(129))), { field: 'password', message: 'Keep the password to 128 characters or fewer' });
      assert.deepEqual(firstError(await register('short')), { field: 'password', message: 'Password must be at least 6 characters' });
    });
  });

  describe('the bus form', () => {
    const post = (overrides) => {
      counter += 1;
      return api('POST', '/buses', { token: users.creator.token, body: busBody(`F${counter}`, users.vendor1.id, overrides) });
    };
    const intervals = (changes) => ({ ...busBody('x', 'x').intervals, ...changes });

    test('numbers fit the bus', async () => {
      const cases = [
        [{ fleetNumber: 'S'.repeat(31) }, 'fleetNumber', 'Keep this to 30 characters or fewer'],
        [{ make: 'B'.repeat(61) }, 'make', 'Keep this to 60 characters or fewer'],
        [{ intervals: intervals({ oil: { everyKm: 10000.5, lastKm: 0 } }) }, 'intervals.oil.everyKm', 'Enter a whole number'],
        [{ intervals: intervals({ tyre: { everyKm: 40000, lastKm: 1000.75 } }) }, 'intervals.tyre.lastKm', 'Enter a whole number'],
        [{ rates: { oil: 0.0001, transmission: 1 } }, 'rates.oil', 'Use at most 2 decimals'],
        [{ labourRate: 50.125 }, 'labourRate', 'Use at most 2 decimals'],
        [{ rates: { oil: 1, transmission: 999999999999 } }, 'rates.transmission', 'That rate makes the service price too large'],
        [{ registrationExpiry: '9999-12-31' }, 'registrationExpiry', 'Choose an expiry date within the next 10 years'],
      ];
      for (const [overrides, field, message] of cases) {
        const res = await post(overrides);
        assert.equal(res.status, 400, field);
        assert.deepEqual(firstError(res), { field, message }, field);
      }
    });

    test('every clash is named at once', async () => {
      const first = await createBus(users, 'ALL', users.vendor1.id);
      const res = await api('POST', '/buses', { token: users.creator.token, body: { ...busBody('ALL2', users.vendor1.id), fleetNumber: first.fleetNumber, registrationNumber: first.registrationNumber.toLowerCase(), chassisNumber: first.chassisNumber } });
      assert.equal(res.status, 409);
      assert.deepEqual(res.body.errors.map((e) => e.field).sort(), ['chassisNumber', 'fleetNumber', 'registrationNumber']);
    });

    test('brands that differ only in letter case count as one', async () => {
      await createBus(users, 'BR1', users.vendor1.id, { make: `Qabrand${run}` });
      await createBus(users, 'BR2', users.vendor1.id, { make: `qabrand${run}` });
      const figures = await api('GET', '/reports/fleet', { token: users.creator.token });
      assert.equal(figures.body.data.brands.filter((b) => b.toLowerCase() === `qabrand${run}`.toLowerCase()).length, 1);
    });
  });

  describe('alerts', () => {
    test('days to a registration expiry count UAE calendar days', () => {
      const justAfterMidnight = new Date('2026-11-06T00:30:00+04:00');
      assert.equal(uaeDaysUntil(new Date('2026-11-06T00:00:00Z'), justAfterMidnight), 0);
      assert.equal(uaeDaysUntil(new Date('2026-11-07T00:00:00Z'), justAfterMidnight), 1);
      assert.equal(uaeDaysUntil(new Date('2026-11-16T00:00:00Z'), justAfterMidnight), 10);
      assert.equal(uaeDaysUntil(new Date('2026-11-05T00:00:00Z'), justAfterMidnight), -1);
    });
  });
});
