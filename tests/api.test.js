/**
 * End-to-end API tests. They run against a live server (default http://localhost:5000)
 * backed by a real MongoDB, exercising the full ticket lifecycle for every role plus the
 * authorization boundaries between them.
 *
 *   API_URL=http://localhost:5000 npm test
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.API_URL || 'http://localhost:5000').replace(/\/$/, '') + '/api';
const run = Date.now().toString(36);
const PASSWORD = 'TestPass123!';

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, headers: res.headers };
};

const assertNoSecrets = (value, where = 'response') => {
  const text = JSON.stringify(value);
  assert.ok(!/"password"/.test(text), `${where} must not contain a password field`);
  assert.ok(!/\$2[aby]\$/.test(text), `${where} must not contain a bcrypt hash`);
};

const users = {};
const ctx = {};

const register = async (role, label) => {
  const res = await api('POST', '/auth/register', {
    body: { name: `${label} ${run}`, email: `${label}-${run}@test.muraqaba.dev`, password: PASSWORD, role },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.token);
  assert.equal(res.body.user.role, role);
  assertNoSecrets(res.body);
  return { token: res.body.token, id: res.body.user.id, email: res.body.user.email };
};

const signIn = async (email) => {
  const res = await api('POST', '/auth/login', { body: { email, password: process.env.TEST_STAFF_PASSWORD || PASSWORD } });
  assert.equal(res.status, 200, `${email}: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, id: res.body.user.id, email: res.body.user.email };
};

/** Sends a multipart estimate or reply, the way the browser does. */
const estimate = async (ticketId, token, fields, suffix = '', files = []) => {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.set(key, value));
  files.forEach((file) => form.append('attachments', file));
  const res = await fetch(`${BASE}/tickets/${ticketId}/estimate${suffix}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
};

describe('Muraqaba API', () => {
  before(async () => {
    const health = await api('GET', '/health');
    assert.equal(health.status, 200, `API not reachable at ${BASE}: ${JSON.stringify(health.body)}`);
    assert.equal(health.body.db, 'connected');

    // Staff accounts cannot self-register; tests/run.mjs seeds them.
    users.creator = await signIn('test-creator@muraqaba.test');
    users.supervisor = await signIn('test-supervisor@muraqaba.test');
    users.purchasing = await signIn('test-purchasing@muraqaba.test');
    users.vendor1 = await register('vendor', 'vendor-one');
    users.vendor2 = await register('vendor', 'vendor-two');
  });

  describe('auth', () => {
    test('rejects invalid registration data with field errors', async () => {
      const res = await api('POST', '/auth/register', { body: { name: 'A', email: 'nope', password: '123', role: 'admin' } });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_ERROR');
      assert.ok(res.body.errors.length >= 3);
    });

    test('rejects duplicate email with 409', async () => {
      const res = await api('POST', '/auth/register', {
        body: { name: 'Dup', email: users.creator.email, password: PASSWORD, role: 'vendor' },
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'DUPLICATE');
    });

    test('login works case-insensitively and rejects wrong passwords with one message', async () => {
      const ok = await api('POST', '/auth/login', { body: { email: users.creator.email.toUpperCase(), password: PASSWORD } });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.token);
      assertNoSecrets(ok.body);

      const wrongPw = await api('POST', '/auth/login', { body: { email: users.creator.email, password: 'wrong-password' } });
      const unknown = await api('POST', '/auth/login', { body: { email: `ghost-${run}@test.muraqaba.dev`, password: PASSWORD } });
      assert.equal(wrongPw.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(wrongPw.body.message, unknown.body.message);
    });

    test('me returns the current user without secrets', async () => {
      const res = await api('GET', '/auth/me', { token: users.vendor1.token });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.role, 'vendor');
      assertNoSecrets(res.body);
    });

    test('protected routes need a token and distinguish invalid tokens', async () => {
      assert.equal((await api('GET', '/tickets')).status, 401);
      const bad = await api('GET', '/tickets', { token: 'not-a-token' });
      assert.equal(bad.status, 401);
      assert.equal(bad.body.code, 'TOKEN_INVALID');
    });
  });

  describe('vendors and buses', () => {
    test('only service creators can create vendors; directory hides passwords', async () => {
      const forbidden = await api('POST', '/vendors', {
        token: users.vendor1.token,
        body: { name: 'Nope', email: `nope-${run}@test.muraqaba.dev`, password: PASSWORD },
      });
      assert.equal(forbidden.status, 403);

      const created = await api('POST', '/vendors', {
        token: users.creator.token,
        body: { name: `Vendor Three ${run}`, email: `vendor-three-${run}@test.muraqaba.dev`, password: PASSWORD },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.role, 'vendor');
      assertNoSecrets(created.body);

      const list = await api('GET', '/vendors', { token: users.supervisor.token });
      assert.equal(list.status, 200);
      assert.ok(list.body.data.some((v) => v._id === users.vendor1.id));
      assertNoSecrets(list.body, 'vendor list');

      const vendorDenied = await api('GET', '/vendors', { token: users.vendor1.token });
      assert.equal(vendorDenied.status, 403);
    });

    const busPayload = (suffix, vendorId) => ({
      fleetNumber: `T-${run}-${suffix}`,
      chassisNumber: `CH-${run}-${suffix}`,
      registrationNumber: `REG-${run}-${suffix}`,
      make: 'Hino',
      model: 'RK8J',
      year: 2020,
      vendorId,
      engine: { serviceKm: 15000, currentKm: 14900 },
      ac: { serviceKm: 10000, currentKm: 100 },
      tyre: { serviceKm: 40000, currentKm: 41000 },
      transmission: { serviceKm: 60000, currentKm: 100 },
      brakePad: { serviceKm: 20000, currentKm: 100 },
    });

    test('creates a bus, validates parts, rejects duplicates and non-vendor assignees', async () => {
      const created = await api('POST', '/buses', { token: users.creator.token, body: busPayload('A', users.vendor1.id) });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      ctx.bus1 = created.body.data;
      assert.equal(ctx.bus1.vendor._id, users.vendor1.id);
      assertNoSecrets(created.body);

      const second = await api('POST', '/buses', { token: users.supervisor.token, body: busPayload('B', users.vendor2.id) });
      assert.equal(second.status, 201);
      ctx.bus2 = second.body.data;

      const missingPart = { ...busPayload('C', users.vendor1.id) };
      delete missingPart.brakePad;
      const invalid = await api('POST', '/buses', { token: users.creator.token, body: missingPart });
      assert.equal(invalid.status, 400);
      assert.ok(invalid.body.errors.some((e) => e.field.startsWith('brakePad')));

      const dup = await api('POST', '/buses', { token: users.creator.token, body: busPayload('A', users.vendor1.id) });
      assert.equal(dup.status, 409);

      const notVendor = await api('POST', '/buses', { token: users.creator.token, body: busPayload('D', users.supervisor.id) });
      assert.equal(notVendor.status, 400);
      assert.equal(notVendor.body.code, 'NOT_A_VENDOR');

      const vendorCannotCreate = await api('POST', '/buses', { token: users.vendor1.token, body: busPayload('E', users.vendor1.id) });
      assert.equal(vendorCannotCreate.status, 403);
    });

    test('vendors cannot see the fleet or report faults; the creator raises the work', async () => {
      const list = await api('GET', '/buses', { token: users.vendor1.token });
      assert.equal(list.status, 403);

      const report = await api('POST', '/repair-requests', {
        token: users.vendor1.token,
        body: { busId: ctx.bus1._id, repairCategory: 'MECHANICAL', description: 'Grinding noise from the front axle.' },
      });
      assert.equal(report.status, 404);

      const page = await api('GET', `/buses/${ctx.bus1._id}`, { token: users.vendor1.token });
      assert.equal(page.status, 403);

      const manager = await api('GET', `/buses/${ctx.bus1._id}`, { token: users.purchasing.token });
      assert.equal(manager.status, 200);
      assert.equal(typeof manager.body.data.openTickets, 'number');
    });

    test('buses cannot be edited and the vendor directory is not open to purchasing', async () => {
      const edit = await api('PUT', `/buses/${ctx.bus1._id}`, { token: users.creator.token, body: { make: 'X' } });
      assert.equal(edit.status, 404);
      const purchasing = await api('GET', '/vendors', { token: users.purchasing.token });
      assert.equal(purchasing.status, 403);
    });
  });

  describe('ticket lifecycle', () => {
    test('service creator raises a repair ticket; it goes to the bus vendor first', async () => {
      const missingCategory = await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: ctx.bus1._id, serviceType: 'repair', currentReading: 52000, description: 'Battery dead' },
      });
      assert.equal(missingCategory.status, 400);

      for (const currentReading of [undefined, '', -1, 1.5, 'abc', [52000]]) {
        const badReading = await api('POST', '/tickets', {
          token: users.creator.token,
          body: { busId: ctx.bus1._id, serviceType: 'minor', currentReading },
        });
        assert.equal(badReading.status, 400, `reading ${JSON.stringify(currentReading)}`);
        assert.equal(badReading.body.errors[0].field, 'currentReading');
      }

      const res = await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: ctx.bus1._id, serviceType: 'repair', repairCategory: 'BATTERY REPLACEMENT', currentReading: 52000, description: 'Battery not holding charge.' },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      ctx.ticket = res.body.data;
      assert.equal(ctx.ticket.status, 'sentToVendor');
      assert.equal(ctx.ticket.vendorId._id, users.vendor1.id);
      assert.equal(ctx.ticket.description, 'Battery not holding charge.');
      assert.equal(ctx.ticket.currentReading, 52000);
      assert.equal(ctx.ticket.history.length, 1);
      assertNoSecrets(res.body, 'created ticket');
    });

    test('vendors cannot act on tickets that belong to other vendors', async () => {
      const read = await api('GET', `/tickets/${ctx.ticket._id}`, { token: users.vendor2.token });
      assert.equal(read.status, 404);
      const list = await api('GET', '/tickets', { token: users.vendor2.token });
      assert.ok(!list.body.data.some((t) => t._id === ctx.ticket._id));
    });

    test('transitions enforce order and role', async () => {
      const early = await api('PUT', `/tickets/${ctx.ticket._id}/acknowledge`, { token: users.vendor1.token });
      assert.equal(early.status, 409);
      assert.equal(early.body.code, 'INVALID_STATE');

      const creatorApprove = await api('PUT', `/tickets/${ctx.ticket._id}/approve`, { token: users.creator.token });
      assert.equal(creatorApprove.status, 403);

      const tooSoon = await api('PUT', `/tickets/${ctx.ticket._id}/approve`, { token: users.supervisor.token });
      assert.equal(tooSoon.status, 409);
      const noEstimate = await api('PUT', `/tickets/${ctx.ticket._id}/escalate`, { token: users.creator.token });
      assert.equal(noEstimate.status, 409);

      const bad = await estimate(ctx.ticket._id, users.vendor1.token, { amount: '0' });
      assert.equal(bad.status, 400);
      const wrong = await estimate(ctx.ticket._id, users.vendor2.token, { amount: '900' });
      assert.equal(wrong.status, 403);
      const first = await estimate(ctx.ticket._id, users.vendor1.token, { amount: '1200', note: 'Battery and labour' });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.data.status, 'estimateSubmitted');

      const empty = await estimate(ctx.ticket._id, users.creator.token, {}, '/reply');
      assert.equal(empty.status, 400);
      const counter = await estimate(ctx.ticket._id, users.creator.token, { amount: '1000', note: 'Too high' }, '/reply');
      assert.equal(counter.status, 201, JSON.stringify(counter.body));
      assert.equal(counter.body.data.status, 'estimateCountered');
      const notYet = await api('PUT', `/tickets/${ctx.ticket._id}/escalate`, { token: users.creator.token });
      assert.equal(notYet.status, 409);

      const second = await estimate(ctx.ticket._id, users.vendor1.token, { amount: '1100' });
      assert.equal(second.body.data.negotiation.length, 3);
      assert.equal((await api('PUT', `/tickets/${ctx.ticket._id}/escalate`, { token: users.vendor1.token })).status, 403);
      const escalated = await api('PUT', `/tickets/${ctx.ticket._id}/escalate`, { token: users.creator.token });
      assert.equal(escalated.status, 200, JSON.stringify(escalated.body));
      assert.equal(escalated.body.data.status, 'pending');

      const approve = await api('PUT', `/tickets/${ctx.ticket._id}/approve`, { token: users.supervisor.token });
      assert.equal(approve.status, 200);
      assert.equal(approve.body.data.status, 'approved');
      assert.equal(approve.body.data.approvedEstimate, 1100);
      assert.equal(approve.body.data.initialApprovedBy._id, users.supervisor.id);

      const twice = await api('PUT', `/tickets/${ctx.ticket._id}/approve`, { token: users.supervisor.token });
      assert.equal(twice.status, 409);

      const wrongVendor = await api('PUT', `/tickets/${ctx.ticket._id}/acknowledge`, { token: users.vendor2.token });
      assert.equal(wrongVendor.status, 403);

      const ack = await api('PUT', `/tickets/${ctx.ticket._id}/acknowledge`, { token: users.vendor1.token });
      assert.equal(ack.status, 200);
      assert.equal(ack.body.data.status, 'acknowledged');
    });

    test('invoice submit, reject, resubmit, accept, complete', async () => {
      const bad = await api('POST', `/tickets/${ctx.ticket._id}/invoice`, { token: users.vendor1.token, body: { amount: -5, description: 'x' } });
      assert.equal(bad.status, 400);

      const submit = await api('POST', `/tickets/${ctx.ticket._id}/invoice`, {
        token: users.vendor1.token,
        body: { amount: 12000, description: 'New battery and labour', invoiceNumber: 'INV-1' },
      });
      assert.equal(submit.status, 201, JSON.stringify(submit.body));
      assert.equal(submit.body.data.status, 'invoiceSubmitted');
      assert.equal(submit.body.data.invoice.amount, 12000);

      const vendorAccept = await api('PUT', `/tickets/${ctx.ticket._id}/invoice/accept`, { token: users.vendor1.token });
      assert.equal(vendorAccept.status, 403);

      const reject = await api('PUT', `/tickets/${ctx.ticket._id}/invoice/reject`, {
        token: users.supervisor.token,
        body: { reason: 'Please itemise labour.' },
      });
      assert.equal(reject.status, 200);
      assert.equal(reject.body.data.status, 'invoiceRejected');
      assert.equal(reject.body.data.invoice.status, 'rejected');
      assert.equal(reject.body.data.invoice.rejectionReason, 'Please itemise labour.');

      const completeTooEarly = await api('PUT', `/tickets/${ctx.ticket._id}/complete`, { token: users.vendor1.token });
      assert.equal(completeTooEarly.status, 409);

      const resubmit = await api('POST', `/tickets/${ctx.ticket._id}/invoice`, {
        token: users.vendor1.token,
        body: { amount: 11000, description: 'Battery 9000, labour 2000', invoiceNumber: 'INV-2' },
      });
      assert.equal(resubmit.status, 201);
      assert.equal(resubmit.body.data.status, 'invoiceSubmitted');

      const detail = await api('GET', `/tickets/${ctx.ticket._id}`, { token: users.supervisor.token });
      assert.equal(detail.body.data.invoices.length, 2);
      assert.equal(detail.body.data.history.at(-1).status, 'invoiceSubmitted');
      assertNoSecrets(detail.body, 'ticket detail');

      const accept = await api('PUT', `/tickets/${ctx.ticket._id}/invoice/accept`, { token: users.supervisor.token });
      assert.equal(accept.status, 200);
      assert.equal(accept.body.data.status, 'invoiceAccepted');

      const complete = await api('PUT', `/tickets/${ctx.ticket._id}/complete`, { token: users.vendor1.token });
      assert.equal(complete.status, 200);
      assert.equal(complete.body.data.status, 'completed');
      assert.ok(complete.body.data.completedAt);
    });

    test('purchase manager sees invoiced tickets only', async () => {
      const list = await api('GET', '/tickets', { token: users.purchasing.token });
      assert.equal(list.status, 200);
      assert.ok(list.body.data.some((t) => t._id === ctx.ticket._id));
      assert.ok(list.body.data.every((t) => ['invoiceSubmitted', 'invoiceAccepted', 'invoiceRejected', 'completed'].includes(t.status)));

      const pending = await api('GET', '/tickets?status=pending', { token: users.purchasing.token });
      assert.equal(pending.body.data.length, 0);

      const cannotCreate = await api('POST', '/tickets', {
        token: users.purchasing.token,
        body: { busId: ctx.bus1._id, serviceType: 'minor' },
      });
      assert.equal(cannotCreate.status, 403);
    });

    test('list filters and pagination envelope', async () => {
      const res = await api('GET', `/tickets?busId=${ctx.bus1._id}&limit=1&page=1`, { token: users.creator.token });
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 1);
      assert.ok(res.body.total >= 1);
      assert.equal(res.body.page, 1);

      const badStatus = await api('GET', '/tickets?status=bogus', { token: users.creator.token });
      assert.equal(badStatus.status, 400);
    });
  });

  describe('audit regressions', () => {
    const newBus = async (suffix, vendorId) => {
      const res = await api('POST', '/buses', {
        token: users.creator.token,
        body: {
          fleetNumber: `R-${run}-${suffix}`,
          chassisNumber: `RC-${run}-${suffix}`,
          registrationNumber: `RR-${run}-${suffix}`,
          make: 'Isuzu',
          model: 'LT134',
          year: 2021,
          vendorId,
          engine: { serviceKm: 15000, currentKm: 0 },
          ac: { serviceKm: 10000, currentKm: 0 },
          tyre: { serviceKm: 40000, currentKm: 0 },
          transmission: { serviceKm: 60000, currentKm: 0 },
          brakePad: { serviceKm: 20000, currentKm: 0 },
        },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data;
    };
    const toApproval = async (ticket, vendor) => {
      await estimate(ticket._id, vendor.token, { amount: '800' });
      const res = await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data;
    };
    const newTicket = async (busId) => {
      const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId, serviceType: 'minor', currentReading: 52000 } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data;
    };

    test('minor and major services take the vendor price per km and skip the negotiation', async () => {
      const email = `priced-${run}@test.muraqaba.dev`;
      const created = await api('POST', '/vendors', {
        token: users.creator.token,
        body: { name: 'Priced Motors', email, password: PASSWORD, serviceRates: { minor: 0.5, major: 1 } },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const vendor = created.body.data;
      assert.equal(vendor.serviceRates.minor, 0.5);
      const bus = await newBus('PRICE', vendor._id);
      const raise = (body) => api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, ...body } });

      const first = await raise({ serviceType: 'minor', currentReading: 10000 });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.data.status, 'pending');
      assert.deepEqual(first.body.data.agreedPrice, { rate: 0.5, km: 10000, amount: 5000 });

      const second = await raise({ serviceType: 'minor', currentReading: 12000 });
      assert.deepEqual(second.body.data.agreedPrice, { rate: 0.5, km: 2000, amount: 1000 });

      const lower = await raise({ serviceType: 'minor', currentReading: 11000 });
      assert.equal(lower.status, 400);
      assert.equal(lower.body.errors[0].field, 'currentReading');

      const major = await raise({ serviceType: 'major', currentReading: 12000 });
      assert.deepEqual(major.body.data.agreedPrice, { rate: 1, km: 12000, amount: 12000 });

      const repair = await raise({ serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 12000 });
      assert.equal(repair.body.data.status, 'sentToVendor');
      assert.equal(repair.body.data.agreedPrice, undefined);

      const reply = await estimate(second.body.data._id, users.creator.token, { note: 'Can we talk?' }, '/reply');
      assert.equal(reply.status, 409);
      const returned = await api('PUT', `/tickets/${second.body.data._id}/return`, { token: users.supervisor.token, body: { reason: 'Check it' } });
      assert.equal(returned.status, 200);
      const noTalks = await estimate(second.body.data._id, users.creator.token, { note: 'Can we talk?' }, '/reply');
      assert.equal(noTalks.status, 409);
      const again = await api('PUT', `/tickets/${second.body.data._id}/escalate`, { token: users.creator.token });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      const approved = await api('PUT', `/tickets/${second.body.data._id}/approve`, { token: users.supervisor.token });
      assert.equal(approved.body.data.approvedEstimate, 1000);
      assert.equal(approved.body.data.status, 'approved');

      const setRates = (token, body) => api('PUT', `/vendors/${vendor._id}/rates`, { token, body });
      assert.equal((await setRates(users.supervisor.token, { minor: 2, major: 3 })).status, 403);
      assert.equal((await setRates(users.creator.token, { minor: 0, major: 3 })).status, 400);
      const saved = await setRates(users.creator.token, { minor: 2, major: 3 });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.data.serviceRates.major, 3);
      assert.equal((await api('PUT', `/vendors/${users.supervisor.id}/rates`, { token: users.creator.token, body: { minor: 2, major: 3 } })).status, 404);
    });

    test('daily km sheet: creators fill it, supervisors read it, nobody else sees it', async () => {
      const bus = await newBus('KM', users.vendor1.id);
      const sheet = (token, query = '') => api('GET', `/sheets/readings${query}`, { token });
      assert.equal((await sheet(users.vendor1.token)).status, 403);
      assert.equal((await sheet(users.purchasing.token)).status, 403);
      assert.equal((await sheet(users.creator.token, '?month=2026-13')).status, 400);
      const read = await sheet(users.supervisor.token);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const { today, days } = read.body.data;
      assert.ok(days.includes(today));
      assert.ok(days.length >= 28);

      const put = (token, body) => api('PUT', '/sheets/readings', { token, body });
      assert.equal((await put(users.supervisor.token, { busId: bus._id, date: today, km: 100 })).status, 403);
      assert.equal((await put(users.creator.token, { busId: bus._id, date: '2099-01-01', km: 100 })).status, 400);
      assert.equal((await put(users.creator.token, { busId: bus._id, date: today, km: -1 })).status, 400);
      assert.equal((await put(users.creator.token, { busId: bus._id, date: today, km: 1.5 })).status, 400);
      assert.equal((await put(users.creator.token, { busId: bus._id, date: '2026-02-31', km: 5 })).status, 400);
      assert.equal((await put(users.creator.token, { busId: '0123456789abcdef01234567', date: today, km: 5 })).status, 404);

      const saved = await put(users.creator.token, { busId: bus._id, date: today, km: 4321 });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const row = async () => (await sheet(users.creator.token)).body.data.buses.find((b) => b._id === bus._id);
      assert.equal((await row()).readings[today], 4321);
      assert.equal((await put(users.creator.token, { busId: bus._id, date: today, km: 5000 })).status, 200);
      assert.equal((await row()).readings[today], 5000);
      assert.equal((await put(users.creator.token, { busId: bus._id, date: today, km: null })).status, 200);
      assert.equal((await row()).readings[today], undefined);

      await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'other', currentReading: 7777 } });
      assert.equal((await row()).readings[today], 7777);
      await put(users.creator.token, { busId: bus._id, date: today, km: 7800 });
      await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'other', currentReading: 7900 } });
      assert.equal((await row()).readings[today], 7800, 'a VSR must not overwrite what the creator typed');
    });

    test('daily status sheet: VSRs pick it, it carries forward and scrapping stays locked', async () => {
      const bus = await newBus('STAT', users.vendor1.id);
      const sheet = async () => (await api('GET', '/sheets/status', { token: users.supervisor.token })).body.data;
      const row = async () => (await sheet()).buses.find((b) => b._id === bus._id);
      const { today, days } = await sheet();
      const todayIndex = days.indexOf(today);
      const put = (token, body) => api('PUT', '/sheets/status', { token, body });
      const raise = (body) => api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, currentReading: 100, ...body } });

      assert.equal((await row()).cells[todayIndex].status, 'ready');
      assert.equal((await api('GET', '/sheets/status', { token: users.vendor1.token })).status, 403);
      assert.equal((await put(users.supervisor.token, { busId: bus._id, date: today, status: 'ready' })).status, 403);
      assert.equal((await put(users.creator.token, { busId: bus._id, date: today, status: 'flying' })).status, 400);
      assert.equal((await put(users.creator.token, { busId: bus._id, date: '2099-01-01', status: 'ready' })).status, 400);

      const picked = [
        [{ serviceType: 'minor' }, 'maintenance'],
        [{ serviceType: 'major' }, 'maintenance'],
        [{ serviceType: 'other' }, 'maintenance'],
        [{ serviceType: 'repair', repairCategory: 'ENGINE' }, 'repair'],
        [{ serviceType: 'repair', repairCategory: 'TYRE REPLACEMENT' }, 'tyreChange'],
        [{ serviceType: 'repair', repairCategory: 'BATTERY REPLACEMENT' }, 'batteryChange'],
        [{ serviceType: 'repair', repairCategory: 'ACCIDENT' }, 'accident'],
      ];
      for (const [body, status] of picked) {
        const res = await raise(body);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const cell = (await row()).cells[todayIndex];
        assert.equal(cell.status, status, JSON.stringify(body));
        assert.equal(cell.source, 'vsr');
      }

      assert.equal((await put(users.creator.token, { busId: bus._id, date: days[0], status: 'removed' })).status, 200);
      const carried = await row();
      assert.equal(carried.cells[0].status, 'removed');
      assert.equal(carried.cells[0].source, 'manual');
      if (todayIndex > 1) assert.equal(carried.cells[1].status, 'removed', 'a status holds until the next change');
      if (todayIndex + 1 < days.length) assert.equal(carried.cells[todayIndex + 1], null, 'future days stay empty');

      assert.equal((await put(users.creator.token, { busId: bus._id, date: today, status: 'scrapping' })).status, 200);
      await raise({ serviceType: 'repair', repairCategory: 'ENGINE' });
      assert.equal((await row()).cells[todayIndex].status, 'scrapping', 'a VSR must not override scrapping');
      assert.equal((await put(users.creator.token, { busId: bus._id, date: today, status: 'ready' })).status, 200);
      assert.equal((await row()).cells[todayIndex].status, 'ready');

      const whole = await sheet();
      const countedToday = Object.values(whole.summary).reduce((sum, counts) => sum + counts[todayIndex], 0);
      assert.equal(countedToday, whole.buses.length, 'the day summary accounts for every bus');
    });

    test('repair tracker follows a VSR through its stages and counts buses per day', async () => {
      const bus = await newBus('TRACK', users.vendor1.id);
      const sheet = async () => (await api('GET', '/sheets/repairs', { token: users.supervisor.token })).body.data;
      assert.equal((await api('GET', '/sheets/repairs', { token: users.vendor1.token })).status, 403);
      const raised = await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 100 },
      });
      const id = raised.body.data._id;
      const stage = async () => (await sheet()).rows.find((r) => r._id === id)?.stage;

      assert.equal(await stage(), 'waitingEstimate');
      const before = await sheet();
      const todayIndex = before.days.indexOf(before.today);
      assert.ok(before.summary.waitingEstimate[todayIndex] >= 1);
      if (todayIndex + 1 < before.days.length) assert.equal(before.summary.waitingEstimate[todayIndex + 1], null);

      await estimate(id, users.vendor1.token, { amount: '900' });
      assert.equal(await stage(), 'negotiation');
      await api('PUT', `/tickets/${id}/escalate`, { token: users.creator.token });
      assert.equal(await stage(), 'waitingApproval');
      await api('PUT', `/tickets/${id}/approve`, { token: users.supervisor.token });
      assert.equal(await stage(), 'estimateApproved');
      await api('PUT', `/tickets/${id}/acknowledge`, { token: users.vendor1.token });
      assert.equal(await stage(), 'goneForRepair');
      await api('POST', `/tickets/${id}/invoice`, { token: users.vendor1.token, body: { amount: 900, description: 'Engine work and labour', invoiceNumber: `INV-${run}` } });
      assert.equal(await stage(), 'invoicing');
      await api('PUT', `/tickets/${id}/invoice/accept`, { token: users.supervisor.token });
      await api('PUT', `/tickets/${id}/complete`, { token: users.vendor1.token });
      const finished = await sheet();
      const row = finished.rows.find((r) => r._id === id);
      assert.equal(row.stage, 'received');
      assert.equal(row.estimate, 900);
      assert.ok(finished.summary.received[todayIndex] >= 1);

      const minor = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'minor', currentReading: 200 } });
      assert.equal((await sheet()).rows.find((r) => r._id === minor.body.data._id), undefined, 'minor services are not in the repair process');
    });

    test('estimate files upload, stay with those allowed to see them and reject bad types', async () => {
      const ticket = await newTicket(ctx.bus1._id);
      const pdf = new File(['%PDF-1.4 quote'], 'عرض سعر.pdf', { type: 'application/pdf' });
      const sent = await estimate(ticket._id, users.vendor1.token, { amount: '500' }, '', [pdf]);
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
      const [file] = sent.body.data.negotiation[0].attachments;
      assert.equal(file.name, 'عرض سعر.pdf');
      assert.equal(file.mimeType, 'application/pdf');

      const url = `/tickets/${ticket._id}/attachments/${file._id}`;
      const fetchFile = (token) => fetch(`${BASE}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const ok = await fetchFile(users.creator.token);
      assert.equal(ok.status, 200);
      assert.equal(await ok.text(), '%PDF-1.4 quote');
      assert.match(ok.headers.get('content-disposition'), /^attachment/);
      assert.equal((await fetchFile(users.vendor2.token)).status, 404);
      assert.equal((await fetchFile(users.purchasing.token)).status, 404);
      assert.equal((await fetchFile()).status, 401);

      const script = new File(['<script>'], 'quote.html', { type: 'application/pdf' });
      const refused = await estimate(ticket._id, users.creator.token, { note: 'See this' }, '/reply', [script]);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.errors[0].field, 'attachments');
      const tooBig = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf');
      assert.equal((await estimate(ticket._id, users.creator.token, { note: 'See this' }, '/reply', [tooBig])).status, 400);
    });

    test('a supervisor returns an escalated ticket with a reason and the creator takes it back', async () => {
      const ticket = await toApproval(await newTicket(ctx.bus1._id), users.vendor1);
      const path = `/tickets/${ticket._id}`;
      const send = (token, reason) => api('PUT', `${path}/return`, { token, body: { reason } });

      assert.equal((await send(users.creator.token, 'Wrong')).status, 403);
      assert.equal((await send(users.supervisor.token, '   ')).status, 400);
      assert.equal((await send(users.supervisor.token, 'x'.repeat(501))).status, 400);

      const corrected = { busId: ctx.bus1._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 53000, description: 'Corrected' };
      const tooEarly = await api('PUT', `${path}/details`, { token: users.creator.token, body: corrected });
      assert.equal(tooEarly.status, 409);

      const returned = await send(users.supervisor.token, 'Reading looks wrong');
      assert.equal(returned.status, 200, JSON.stringify(returned.body));
      assert.equal(returned.body.data.status, 'returned');
      assert.equal(returned.body.data.history.at(-1).note, 'Reading looks wrong');
      assert.equal(returned.body.data.returnReason, 'Reading looks wrong');

      const vendorView = await api('GET', path, { token: users.vendor1.token });
      assert.equal(vendorView.body.data.returnReason, undefined);
      assert.ok(!JSON.stringify(vendorView.body).includes('Reading looks wrong'));
      const vendorList = await api('GET', '/tickets?limit=100', { token: users.vendor1.token });
      assert.ok(!JSON.stringify(vendorList.body).includes('Reading looks wrong'));

      const approve = await api('PUT', `${path}/approve`, { token: users.supervisor.token });
      assert.equal(approve.status, 409);

      const vendorCannot = await api('PUT', `${path}/details`, { token: users.vendor1.token, body: corrected });
      assert.equal(vendorCannot.status, 403);
      const badReading = await api('PUT', `${path}/details`, { token: users.creator.token, body: { ...corrected, currentReading: -1 } });
      assert.equal(badReading.status, 400);
      const newVendor = await api('PUT', `${path}/details`, { token: users.creator.token, body: { ...corrected, vendorId: users.vendor2.id } });
      assert.equal(newVendor.status, 409);

      const saved = await api('PUT', `${path}/details`, { token: users.creator.token, body: corrected });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.data.status, 'returned');
      assert.equal(saved.body.data.currentReading, 53000);
      assert.equal(saved.body.data.repairCategory, 'ENGINE');
      assert.equal(saved.body.data.vendorId._id, users.vendor1.id);

      const reply = await estimate(ticket._id, users.creator.token, { note: 'Please lower the price' }, '/reply');
      assert.equal(reply.body.data.status, 'estimateCountered');
      await estimate(ticket._id, users.vendor1.token, { amount: '700' });
      const again = await api('PUT', `${path}/escalate`, { token: users.creator.token });
      assert.equal(again.body.data.status, 'pending');
      assert.equal(again.body.data.returnReason, undefined);
      const approved = await api('PUT', `${path}/approve`, { token: users.supervisor.token });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.data.approvedEstimate, 700);
    });

    test('the creator can send a ticket to a vendor other than the bus vendor', async () => {
      const raise = (vendorId) =>
        api('POST', '/tickets', { token: users.creator.token, body: { busId: ctx.bus1._id, serviceType: 'minor', currentReading: 52000, vendorId } });

      const res = await raise(users.vendor2.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.vendorId._id, users.vendor2.id);
      assert.equal((await api('GET', `/tickets/${res.body.data._id}`, { token: users.vendor2.token })).status, 200);
      assert.equal((await api('GET', `/tickets/${res.body.data._id}`, { token: users.vendor1.token })).status, 404);

      assert.equal((await raise(users.supervisor.id)).status, 400);
      assert.equal((await raise('0123456789abcdef01234567')).status, 404);
      assert.equal((await raise('not-an-id')).status, 400);
      assert.equal((await raise([users.vendor2.id])).status, 400);
    });

    test('staff roles cannot self-register, including through an array value', async () => {
      const email = `escalate-${run}@test.muraqaba.dev`;
      const res = await api('POST', '/auth/register', { body: { name: 'Escalate', email, password: PASSWORD, role: 'supervisor' } });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'ROLE_NOT_SELF_REGISTRABLE');

      const array = await api('POST', '/auth/register', { body: { name: 'Escalate', email, password: PASSWORD, role: ['vendor'] } });
      assert.equal(array.status, 400);

      const config = await api('GET', '/auth/config');
      assert.deepEqual(config.body.data.registration.roles, ['vendor']);
    });

    test('purchase manager cannot read a pending ticket by id and sees scoped counts', async () => {
      const bus = await newBus('PM', users.vendor2.id);
      const ticket = await newTicket(bus._id);
      const read = await api('GET', `/tickets/${ticket._id}`, { token: users.purchasing.token });
      assert.equal(read.status, 404);

      const dash = await api('GET', '/users/dashboard', { token: users.purchasing.token });
      assert.equal(dash.body.data.tickets.pending, 0);
      assert.equal(dash.body.data.tickets.approved, 0);

      const detail = await api('GET', `/buses/${bus._id}`, { token: users.creator.token });
      assert.equal(detail.body.data.openTickets, 1);
    });

    test('lists can be ordered oldest first', async () => {
      const oldest = await api('GET', '/tickets?sort=oldest&limit=200', { token: users.creator.token });
      const newest = await api('GET', '/tickets?limit=200', { token: users.creator.token });
      assert.equal(oldest.status, 200);
      assert.equal(oldest.body.data[0]._id, newest.body.data.at(-1)._id);
      const bad = await api('GET', '/tickets?sort=sideways', { token: users.creator.token });
      assert.equal(bad.status, 400);
    });

    test('non-finite numbers are rejected', async () => {
      const bus = await api('POST', '/buses', {
        token: users.creator.token,
        body: {
          fleetNumber: `INF-${run}`, chassisNumber: `INFC-${run}`, registrationNumber: `INFR-${run}`, make: 'Hino', model: 'RK8J', year: 2020,
          vendorId: users.vendor1.id,
          engine: { serviceKm: '1e400', currentKm: 0 }, ac: { serviceKm: 1, currentKm: 0 }, tyre: { serviceKm: 1, currentKm: 0 },
          transmission: { serviceKm: 1, currentKm: 0 }, brakePad: { serviceKm: 1, currentKm: 0 },
        },
      });
      assert.equal(bus.status, 400);
    });

    test('simultaneous invoice submissions: exactly one wins and no orphan invoices remain', async () => {
      const bus = await newBus('RACE', users.vendor2.id);
      const ticket = await toApproval(await newTicket(bus._id), users.vendor2);
      await api('PUT', `/tickets/${ticket._id}/approve`, { token: users.supervisor.token });
      await api('PUT', `/tickets/${ticket._id}/acknowledge`, { token: users.vendor2.token });

      const attempts = await Promise.all(
        [1, 2, 3].map((n) =>
          api('POST', `/tickets/${ticket._id}/invoice`, { token: users.vendor2.token, body: { amount: 100 * n, description: `Invoice attempt ${n}` } })
        )
      );
      const statuses = attempts.map((a) => a.status).sort();
      assert.equal(statuses.filter((s) => s === 201).length, 1, statuses.join());
      assert.ok(statuses.filter((s) => s !== 201).every((s) => s === 409), statuses.join());

      const detail = await api('GET', `/tickets/${ticket._id}`, { token: users.supervisor.token });
      assert.equal(detail.body.data.invoices.length, 1);
    });

  });

  describe('dashboards and misc', () => {
    test('each role gets a dashboard with counts and an action-required number', async () => {
      for (const key of ['creator', 'supervisor', 'vendor1', 'purchasing']) {
        const res = await api('GET', '/users/dashboard', { token: users[key].token });
        assert.equal(res.status, 200, key);
        assert.ok(res.body.data.tickets, key);
      }
      const vendor = await api('GET', '/users/dashboard', { token: users.vendor1.token });
      assert.ok(vendor.body.data.tickets.completed >= 1);
    });

    test('profile hides the password hash', async () => {
      const res = await api('GET', '/users/profile', { token: users.creator.token });
      assert.equal(res.status, 200);
      assertNoSecrets(res.body, 'profile');
    });

    test('unknown routes and malformed ids return JSON errors', async () => {
      const missing = await api('GET', '/nope', { token: users.creator.token });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, 'NOT_FOUND');

      const badId = await api('GET', '/tickets/not-an-id', { token: users.creator.token });
      assert.equal(badId.status, 400);

      const unknownTicket = await api('GET', '/tickets/64b000000000000000000000', { token: users.creator.token });
      assert.equal(unknownTicket.status, 404);
    });
  });
});
