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
      assert.deepEqual(ctx.bus1.partsDue.sort(), ['tyre']);
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

    test('vendors only see their own buses', async () => {
      const v1 = await api('GET', '/buses', { token: users.vendor1.token });
      assert.ok(v1.body.data.every((b) => b.vendor._id === users.vendor1.id));
      assert.ok(v1.body.data.some((b) => b._id === ctx.bus1._id));

      const v2Direct = await api('GET', `/buses/${ctx.bus1._id}`, { token: users.vendor2.token });
      assert.equal(v2Direct.status, 404);

      const manager = await api('GET', `/buses/${ctx.bus1._id}`, { token: users.purchasing.token });
      assert.equal(manager.status, 200);
      assert.equal(typeof manager.body.data.openTickets, 'number');
    });

    test('updates odometer readings', async () => {
      const res = await api('PUT', `/buses/${ctx.bus1._id}`, {
        token: users.creator.token,
        body: { tyre: { currentKm: 0 } },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.tyre.currentKm, 0);
      assert.deepEqual(res.body.data.partsDue, []);
    });
  });

  describe('ticket lifecycle', () => {
    test('service creator raises a repair ticket; vendor is derived from the bus', async () => {
      const missingCategory = await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: ctx.bus1._id, serviceType: 'repair', description: 'Battery dead' },
      });
      assert.equal(missingCategory.status, 400);

      const res = await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: ctx.bus1._id, serviceType: 'repair', repairCategory: 'BATTERY REPLACEMENT', description: 'Battery not holding charge.' },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      ctx.ticket = res.body.data;
      assert.equal(ctx.ticket.status, 'pending');
      assert.equal(ctx.ticket.vendorId._id, users.vendor1.id);
      assert.equal(ctx.ticket.description, 'Battery not holding charge.');
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

      const approve = await api('PUT', `/tickets/${ctx.ticket._id}/approve`, { token: users.supervisor.token });
      assert.equal(approve.status, 200);
      assert.equal(approve.body.data.status, 'approved');
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

  describe('repair requests', () => {
    test('vendor raises a request only for their own buses', async () => {
      const otherBus = await api('POST', '/repair-requests', {
        token: users.vendor2.token,
        body: { busId: ctx.bus1._id, repairCategory: 'MECHANICAL', description: 'Grinding noise from the front axle.' },
      });
      assert.equal(otherBus.status, 403);

      const res = await api('POST', '/repair-requests', {
        token: users.vendor1.token,
        body: { busId: ctx.bus1._id, repairCategory: 'MECHANICAL', description: 'Grinding noise from the front axle.' },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      ctx.request1 = res.body.data;
      assert.equal(ctx.request1.status, 'pending');

      const second = await api('POST', '/repair-requests', {
        token: users.vendor1.token,
        body: { busId: ctx.bus1._id, repairCategory: 'BODY', description: 'Cracked rear bumper after reversing.' },
      });
      ctx.request2 = second.body.data;

      const creatorCannotRaise = await api('POST', '/repair-requests', {
        token: users.creator.token,
        body: { busId: ctx.bus1._id, repairCategory: 'BODY', description: 'Creators do not raise requests.' },
      });
      assert.equal(creatorCannotRaise.status, 403);
    });

    test('vendors only list their own requests; reviewers list all pending', async () => {
      const v2 = await api('GET', '/repair-requests', { token: users.vendor2.token });
      assert.ok(!v2.body.data.some((r) => r._id === ctx.request1._id));

      const pending = await api('GET', '/repair-requests/pending', { token: users.creator.token });
      assert.ok(pending.body.data.some((r) => r._id === ctx.request1._id));
      assertNoSecrets(pending.body, 'repair request list');
    });

    test('raising a ticket from a request resolves and links it', async () => {
      const wrongBus = await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: ctx.bus2._id, serviceType: 'repair', repairCategory: 'MECHANICAL', repairRequestId: ctx.request1._id },
      });
      assert.equal(wrongBus.status, 400);
      assert.equal(wrongBus.body.code, 'BUS_MISMATCH');

      const res = await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: ctx.bus1._id, serviceType: 'repair', repairCategory: 'MECHANICAL', repairRequestId: ctx.request1._id },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.description, ctx.request1.description);
      assert.equal(res.body.data.repairRequest._id, ctx.request1._id);

      const list = await api('GET', '/repair-requests?status=resolved', { token: users.vendor1.token });
      const resolved = list.body.data.find((r) => r._id === ctx.request1._id);
      assert.ok(resolved);
      assert.equal(resolved.ticketId._id, res.body.data._id);

      const again = await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: ctx.bus1._id, serviceType: 'repair', repairCategory: 'MECHANICAL', repairRequestId: ctx.request1._id },
      });
      assert.equal(again.status, 409);
    });

    test('reviewers can reject a request once', async () => {
      const vendorCannot = await api('PUT', `/repair-requests/${ctx.request2._id}/status`, {
        token: users.vendor1.token,
        body: { status: 'rejected' },
      });
      assert.equal(vendorCannot.status, 403);

      const res = await api('PUT', `/repair-requests/${ctx.request2._id}/status`, {
        token: users.supervisor.token,
        body: { status: 'rejected', note: 'Cosmetic, defer to next major service.' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'rejected');
      assert.equal(res.body.data.rejectedBy._id, users.supervisor.id);

      const twice = await api('PUT', `/repair-requests/${ctx.request2._id}/status`, {
        token: users.supervisor.token,
        body: { status: 'resolved' },
      });
      assert.equal(twice.status, 409);
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
    const newTicket = async (busId) => {
      const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId, serviceType: 'minor' } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data;
    };

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
      const bus = await api('PUT', `/buses/${ctx.bus2._id}`, { token: users.creator.token, body: { engine: { serviceKm: '1e400' } } });
      assert.equal(bus.status, 400);
    });

    test('a bus update without a body is a no-op, not a crash', async () => {
      const res = await fetch(`${BASE}/buses/${ctx.bus2._id}`, { method: 'PUT', headers: { Authorization: `Bearer ${users.creator.token}` } });
      assert.equal(res.status, 200);
    });

    test('simultaneous invoice submissions: exactly one wins and no orphan invoices remain', async () => {
      const bus = await newBus('RACE', users.vendor2.id);
      const ticket = await newTicket(bus._id);
      await api('PUT', `/tickets/${ticket._id}/approve`, { token: users.supervisor.token });
      await api('PUT', `/tickets/${ticket._id}/acknowledge`, { token: users.vendor2.token });

      const attempts = await Promise.all(
        [1, 2, 3].map((n) =>
          api('POST', `/tickets/${ticket._id}/invoice`, { token: users.vendor2.token, body: { amount: 100 * n, description: `Attempt ${n}` } })
        )
      );
      const statuses = attempts.map((a) => a.status).sort();
      assert.equal(statuses.filter((s) => s === 201).length, 1, statuses.join());
      assert.ok(statuses.filter((s) => s !== 201).every((s) => s === 409), statuses.join());

      const detail = await api('GET', `/tickets/${ticket._id}`, { token: users.supervisor.token });
      assert.equal(detail.body.data.invoices.length, 1);
    });

    test('pending tickets can be cancelled by a supervisor or their creator, once, with a reason', async () => {
      const bus = await newBus('CXL', users.vendor2.id);
      const ticket = await newTicket(bus._id);

      const noReason = await api('PUT', `/tickets/${ticket._id}/cancel`, { token: users.supervisor.token, body: {} });
      assert.equal(noReason.status, 400);
      const vendor = await api('PUT', `/tickets/${ticket._id}/cancel`, { token: users.vendor2.token, body: { reason: 'Not needed' } });
      assert.equal(vendor.status, 403);

      const ok = await api('PUT', `/tickets/${ticket._id}/cancel`, { token: users.supervisor.token, body: { reason: 'Raised by mistake' } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.data.status, 'cancelled');
      assert.equal(ok.body.data.cancellationReason, 'Raised by mistake');

      const again = await api('PUT', `/tickets/${ticket._id}/cancel`, { token: users.supervisor.token, body: { reason: 'Raised by mistake' } });
      assert.equal(again.status, 409);
    });

    test('a bus with open tickets cannot be reassigned to another vendor', async () => {
      const bus = await newBus('MOVE', users.vendor2.id);
      await newTicket(bus._id);
      const res = await api('PUT', `/buses/${bus._id}`, { token: users.creator.token, body: { vendorId: users.vendor1.id } });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'OPEN_TICKETS');
    });
  });

  describe('dashboards and misc', () => {
    test('each role gets a dashboard with counts and an action-required number', async () => {
      for (const key of ['creator', 'supervisor', 'vendor1', 'purchasing']) {
        const res = await api('GET', '/users/dashboard', { token: users[key].token });
        assert.equal(res.status, 200, key);
        assert.equal(typeof res.body.data.actionRequired, 'number', key);
        assert.ok(res.body.data.tickets, key);
      }
      const vendor = await api('GET', '/users/dashboard', { token: users.vendor1.token });
      assert.ok(vendor.body.data.tickets.completed >= 1);
      assert.equal(vendor.body.data.repairRequests.pending, 0);
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
