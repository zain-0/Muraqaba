/**
 * Shared by every API test file. The tests run against a live server backed by a real
 * MongoDB; tests/run.mjs starts one and seeds the staff accounts signed in with here.
 */
import assert from 'node:assert/strict';

export const BASE = (process.env.API_URL || 'http://localhost:5000').replace(/\/$/, '') + '/api';
export const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const PASSWORD = 'TestPass123!';

export const api = async (method, path, { token, body } = {}) => {
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

export const assertNoSecrets = (value, where = 'response') => {
  const text = JSON.stringify(value);
  assert.ok(!/"password"/.test(text), `${where} must not contain a password field`);
  assert.ok(!/\$2[aby]\$/.test(text), `${where} must not contain a bcrypt hash`);
};

export const register = async (role, label) => {
  const res = await api('POST', '/auth/register', {
    body: { name: `${label} ${run}`, email: `${label}-${run}@test.muraqaba.dev`, password: PASSWORD, role },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.token);
  assert.equal(res.body.user.role, role);
  assertNoSecrets(res.body);
  return { token: res.body.token, id: res.body.user.id, email: res.body.user.email };
};

export const signIn = async (email) => {
  const res = await api('POST', '/auth/login', { body: { email, password: process.env.TEST_STAFF_PASSWORD || PASSWORD } });
  assert.equal(res.status, 200, `${email}: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, id: res.body.user.id, email: res.body.user.email };
};

/** The three staff accounts tests/run.mjs seeds, plus two vendors of this file's own. */
export const signInEveryone = async () => {
  const health = await api('GET', '/health');
  assert.equal(health.status, 200, `API not reachable at ${BASE}: ${JSON.stringify(health.body)}`);
  assert.equal(health.body.db, 'connected');
  return {
    creator: await signIn('test-creator@muraqaba.test'),
    supervisor: await signIn('test-supervisor@muraqaba.test'),
    purchasing: await signIn('test-purchasing@muraqaba.test'),
    vendor1: await register('vendor', 'vendor-one'),
    vendor2: await register('vendor', 'vendor-two'),
  };
};

/** A complete add-bus form. Rates are on the bus; oil at AED 0.5 and transmission at AED 1 per km. */
export const busBody = (suffix, vendorId, overrides = {}) => ({
  fleetNumber: `S-${run}-${suffix}`,
  chassisNumber: `CH-${run}-${suffix}`,
  registrationNumber: `REG-${run}-${suffix}`,
  make: 'Hino',
  model: 'Coach',
  year: 2020,
  registrationExpiry: '2030-06-30',
  expectedLifeYears: 15,
  labourRate: 50,
  rates: { oil: 0.5, transmission: 1 },
  intervals: {
    oil: { everyKm: 10000, lastKm: 0 },
    transmission: { everyKm: 60000, lastKm: 0 },
    tyre: { everyKm: 40000, lastKm: 0 },
    battery: { everyMonths: 18, lastDate: '2026-01-01' },
  },
  vendorId,
  ...overrides,
});

export const createBus = async (users, suffix, vendorId, overrides) => {
  const res = await api('POST', '/buses', { token: users.creator.token, body: busBody(suffix, vendorId, overrides) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

/** Sends a multipart request, the way the browser sends forms with files. */
export const multipart = async (path, token, fields, files = []) => {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.set(key, value));
  files.forEach((file) => form.append('attachments', file));
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json() };
};

/** A vendor's estimate, or with suffix '/reply' a creator's reply. */
export const estimate = (ticketId, token, fields, suffix = '', files = []) =>
  multipart(`/tickets/${ticketId}/estimate${suffix}`, token, suffix ? fields : { quotationNumber: 'Q-1', daysToComplete: '3', ...fields }, files);

export const fileOf = (name, content = '%PDF-1.4 test') => new File([content], name, { type: 'application/pdf' });

/** The simplest breakdown that checks out against an estimate of this amount. */
export const fillBreakdown = async (users, ticketId, amount) => {
  const res = await api('PUT', `/tickets/${ticketId}/breakdown`, { token: users.creator.token, body: { consumables: amount } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};

/** Walks a raised VSR up to the vendor's acknowledgement. Repairs get an estimate of AED 900. */
export const toAcknowledged = async (users, ticket, vendor) => {
  const id = ticket._id;
  if (ticket.status === 'sentToVendor') {
    ok(await estimate(id, vendor.token, { amount: '900' }));
    await fillBreakdown(users, id, 900);
    ok(await api('PUT', `/tickets/${id}/escalate`, { token: users.creator.token }));
  }
  ok(await api('PUT', `/tickets/${id}/approve`, { token: users.supervisor.token }));
  return ok(await api('PUT', `/tickets/${id}/acknowledge`, { token: vendor.token, body: { daysToComplete: 3 } }));
};

/** From acknowledged to the bus being back with the creator. */
export const fromAcknowledgedToReturned = async (users, id, vendor, { km = 6000, date } = {}) => {
  const put = (path, token, body) => api('PUT', `/tickets/${id}/${path}`, { token, body });
  ok(await put('vehicle/sent', users.creator.token));
  ok(await put('vehicle/received', vendor.token, { km }));
  ok(await put('work/start', vendor.token));
  ok(await put('work/ready', vendor.token));
  ok(await put('vehicle/release', vendor.token));
  return ok(await put('vehicle/returned', users.creator.token, { km, date, replacedPartsReceived: true }));
};

export const toVehicleReturned = async (users, ticket, vendor, options) => {
  await toAcknowledged(users, ticket, vendor);
  return fromAcknowledgedToReturned(users, ticket._id, vendor, options);
};

export const submitInvoice = (ticketId, vendor, fields = {}) =>
  multipart(`/tickets/${ticketId}/invoice`, vendor.token, { amount: '900', description: 'Work done as estimated', invoiceNumber: `INV-${run}-${ticketId.slice(-6)}`, ...fields }, [fileOf('invoice.pdf')]);

export const toInvoiceAccepted = async (users, ticket, vendor, options = {}) => {
  await toVehicleReturned(users, ticket, vendor, options);
  ok(await submitInvoice(ticket._id, vendor, options.invoice));
  return ok(await api('PUT', `/tickets/${ticket._id}/invoice/accept`, { token: users.supervisor.token }));
};

export const toForwarded = async (users, ticket, vendor, options) => {
  await toInvoiceAccepted(users, ticket, vendor, options);
  ok(await api('PUT', `/tickets/${ticket._id}/invoice/received`, { token: users.creator.token }));
  return ok(await api('PUT', `/tickets/${ticket._id}/forward`, { token: users.creator.token }));
};
