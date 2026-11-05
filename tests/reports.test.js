/**
 * Item 13's reports: purchasing's queries, the fleet's month figures, what is due, the weekly
 * supervisor report and the notifications that point people at them.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, busBody, createBus, newVendor, run, signInEveryone, submitInvoice, toForwarded, toInvoiceAccepted, toVehicleReturned } from './helpers.js';

let users;
const raise = async (busId, body) => {
  const res = await api('POST', '/tickets', { token: users.creator.token, body: { busId, currentReading: 500, ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const repair = (busId, category = 'ENGINE', extra = {}) => raise(busId, { serviceType: 'repair', repairCategory: category, ...extra });
const YEAR = new Date().getUTCFullYear();

describe('purchasing queries', () => {
  // A brand of this test run's own, so other files' VSRs cannot change the counts.
  const brand = `Brand${run}`;
  let bus;
  let vendor;

  before(async () => {
    users = await signInEveryone();
    vendor = await newVendor('reports');
    bus = await createBus(users, 'Q1', vendor.id, { make: brand, rates: undefined });
    const second = await createBus(users, 'Q2', vendor.id, { make: brand, rates: undefined });
    await repair(bus._id, 'ACCIDENT');
    await repair(second._id, 'ACCIDENT', { isBreakdown: true });
    await repair(bus._id, 'ENGINE');
    await raise(bus._id, { serviceType: 'tyre' });
    await raise(bus._id, { serviceType: 'battery' });
    await raise(bus._id, { serviceType: 'oil' });
    await raise(bus._id, { serviceType: 'transmission' });
    await toInvoiceAccepted(users, await repair(bus._id, 'BODY'), vendor, { invoice: { amount: '700' } });
  });

  const query = async (params, token = users.purchasing.token) => {
    const qs = new URLSearchParams(params).toString();
    const res = await api('GET', `/reports/query?${qs}`, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data;
  };

  test('only purchasing can run them', async () => {
    assert.equal((await api('GET', '/reports/query', { token: users.creator.token })).status, 403);
    assert.equal((await api('GET', '/reports/query', { token: users.supervisor.token })).status, 403);
    assert.equal((await api('GET', '/reports/query', { token: users.vendor1.token })).status, 403);
  });

  test('how many accidents for a brand this year', async () => {
    const result = await query({ brand, type: 'accident', year: YEAR });
    assert.equal(result.total.count, 2);
    assert.deepEqual(result.rows.map((r) => [r.key, r.count]), [[brand, 2]]);
  });

  test('accidents are repairs, but a repair query can ask for everything else separately', async () => {
    assert.equal((await query({ brand, type: 'repair', year: YEAR })).total.count, 2, 'engine and body');
    assert.equal((await query({ brand, type: 'maintenance', year: YEAR })).total.count, 2, 'oil and transmission');
    assert.equal((await query({ brand, type: 'tyre', year: YEAR })).total.count, 1);
    assert.equal((await query({ brand, type: 'battery', year: YEAR })).total.count, 1);
    assert.equal((await query({ brand, year: YEAR })).total.count, 8, 'no type means all of them');
  });

  test('a year with nothing in it comes back empty', async () => {
    assert.equal((await query({ brand, year: YEAR - 5 })).total.count, 0);
  });

  test('it can group by month, bus, vendor or type', async () => {
    const month = `${YEAR}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    const byMonth = await query({ brand, year: YEAR, groupBy: 'month' });
    assert.ok(byMonth.rows.some((r) => r.key === month && r.count === 8));
    const byBus = await query({ brand, year: YEAR, groupBy: 'bus' });
    assert.equal(byBus.rows.length, 2);
    assert.equal(byBus.rows.find((r) => r.key === bus.fleetNumber).count, 7);
    const byVendor = await query({ brand, year: YEAR, groupBy: 'vendor' });
    assert.equal(byVendor.rows[0].count, 8);
    const byType = await query({ brand, year: YEAR, groupBy: 'type' });
    assert.equal(byType.rows.find((r) => r.key === 'accident').count, 2);
    assert.equal(byType.rows.find((r) => r.key === 'oil').count, 1);
  });

  test('the amount adds accepted invoices', async () => {
    const result = await query({ brand, type: 'repair', year: YEAR });
    assert.equal(result.total.amount, 700);
  });

  test('an invoice still under review adds nothing to the amount', async () => {
    const other = `Other${run}`;
    const own = await createBus(users, 'Q3', vendor.id, { make: other, rates: undefined });
    await toInvoiceAccepted(users, await repair(own._id, 'BODY'), vendor, { invoice: { amount: '700' } });
    const waiting = await repair(own._id, 'BODY');
    await toVehicleReturned(users, waiting, vendor);
    const sent = await submitInvoice(waiting._id, vendor, { amount: '900' });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    const result = await query({ brand: other, year: YEAR });
    assert.equal(result.total.count, 2);
    assert.equal(result.total.amount, 700);
    assert.equal((await query({ brand, year: YEAR })).total.count, 8, 'and it stays out of the other brand');
  });

  test('it can filter by vendor, bus and the breakdown flag, and offers the choices', async () => {
    const onlyMine = await newVendor('reports-filter');
    const mine = await createBus(users, 'Q4', onlyMine.id, { make: `Mine${run}`, rates: undefined });
    await repair(mine._id, 'BODY');
    assert.equal((await query({ vendorId: onlyMine.id, year: YEAR })).total.count, 1);
    assert.equal((await query({ busId: bus._id, year: YEAR })).total.count, 7);
    assert.equal((await query({ brand, isBreakdown: 'true', year: YEAR })).total.count, 1);
    const filters = await query({ brand, year: YEAR });
    assert.ok(filters.filters.brands.includes(brand));
    assert.ok(filters.filters.vendors.some((v) => v._id === vendor.id));
    assert.equal((await api('GET', '/reports/query?year=1', { token: users.purchasing.token })).status, 400);
    assert.equal((await api('GET', '/reports/query?groupBy=mood', { token: users.purchasing.token })).status, 400);
  });

  test('the fleet figures give each month by kind, for all brands or one', async () => {
    assert.equal((await api('GET', '/reports/fleet', { token: users.vendor1.token })).status, 403);
    const res = await api('GET', `/reports/fleet?year=${YEAR}&brand=${brand}`, { token: users.supervisor.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { months, totals, brands } = res.body.data;
    assert.equal(months.length, 12);
    const now = months[new Date().getUTCMonth()];
    assert.deepEqual(now, { month: now.month, repair: 4, tyre: 1, battery: 1, maintenance: 2 }, 'accidents count as repairs here');
    assert.deepEqual({ repair: totals.repair, tyre: totals.tyre, battery: totals.battery, maintenance: totals.maintenance }, { repair: 4, tyre: 1, battery: 1, maintenance: 2 });
    assert.ok(brands.includes(brand));

    const generic = await api('GET', `/reports/fleet?year=${YEAR}`, { token: users.purchasing.token });
    assert.ok(generic.body.data.totals.repair > 4, 'with no brand it covers the whole fleet, other brands included');
    assert.ok(generic.body.data.byBrand.some((row) => row.brand === brand && row.repair === 4 && row.maintenance === 2));
  });
});

describe('weekly supervisor report', () => {
  test('it lists this week\'s work and what is due, and it is for supervisors', async () => {
    const vendor = await newVendor('weekly');
    const bus = await createBus(users, 'WK', vendor.id, { rates: undefined });
    const { today } = (await api('GET', '/sheets/readings', { token: users.creator.token })).body.data;
    await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: bus._id, date: today, km: 9500 } });
    const tyre = await raise(bus._id, { serviceType: 'tyre', currentReading: 9500 });
    await raise(bus._id, { serviceType: 'battery', currentReading: 9500 });
    const transmission = await raise(bus._id, { serviceType: 'transmission', currentReading: 9500 });

    assert.equal((await api('GET', '/reports/weekly', { token: users.creator.token })).status, 403);
    const res = await api('GET', '/reports/weekly', { token: users.supervisor.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const report = res.body.data;
    assert.ok(report.from < report.to);
    assert.ok(report.raised.tyre.some((t) => t._id === tyre._id));
    assert.ok(report.raised.battery.length >= 1);
    assert.ok(report.raised.transmission.some((t) => t._id === transmission._id), 'transmission is reported too');
    const due = report.due.oil.find((row) => row.fleetNumber === bus.fleetNumber);
    assert.equal(due.state, 'soon');
    assert.equal(due.left, 500);
    assert.ok(Array.isArray(report.due.tyre) && Array.isArray(report.due.battery) && Array.isArray(report.due.transmission));
  });
});

describe('notifications', () => {
  const inbox = async (token) => {
    const res = await api('GET', '/notifications', { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };

  test('the creator hears about a registration expiring within a month, once', async () => {
    const vendor = await newVendor('expiry');
    const soon = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const bus = await createBus(users, 'EXP', vendor.id, { registrationExpiry: soon });
    const far = await createBus(users, 'FAR', vendor.id, { registrationExpiry: '2099-01-01' });

    const first = await inbox(users.creator.token);
    const mine = first.data.filter((n) => n.type === 'registrationExpiring' && n.params.fleetNumber === bus.fleetNumber);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].link, `/buses/${bus._id}`);
    assert.ok(!first.data.some((n) => n.params?.fleetNumber === far.fleetNumber), 'a bus with time left says nothing');
    assert.ok(first.unread >= 1);

    const again = await inbox(users.creator.token);
    assert.equal(again.data.filter((n) => n.type === 'registrationExpiring' && n.params.fleetNumber === bus.fleetNumber).length, 1, 'no repeats');

    const supervisor = await inbox(users.supervisor.token);
    assert.ok(!supervisor.data.some((n) => n.type === 'registrationExpiring'), 'it goes to creators');
  });

  test('renewing the registration raises a fresh alert only for the new date', async () => {
    const vendor = await newVendor('renew');
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const bus = await createBus(users, 'REN', vendor.id, { registrationExpiry: soon });
    await inbox(users.creator.token);
    await api('PUT', `/buses/${bus._id}`, { token: users.creator.token, body: busBody('REN', vendor.id, { registrationExpiry: '2099-01-01' }) });
    const after = await inbox(users.creator.token);
    const open = after.data.filter((n) => n.type === 'registrationExpiring' && n.params.fleetNumber === bus.fleetNumber);
    assert.equal(open.length, 1, 'the old one stays in history, nothing new');
  });

  test('supervisors hear about transmission services due, like the others', async () => {
    const vendor = await newVendor('due-t');
    const bus = await createBus(users, 'DUET', vendor.id, { rates: undefined });
    const { today } = (await api('GET', '/sheets/readings', { token: users.creator.token })).body.data;
    await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: bus._id, date: today, km: 59500 } });

    const supervisor = await inbox(users.supervisor.token);
    const notice = supervisor.data.find((n) => n.type === 'serviceDue' && n.params.fleetNumber === bus.fleetNumber && n.params.service === 'transmission');
    assert.ok(notice, 'transmission is due soon');
    assert.equal(notice.params.state, 'soon');
    assert.equal(notice.params.left, 500);

    const report = (await api('GET', '/reports/weekly', { token: users.supervisor.token })).body.data;
    assert.equal(report.due.transmission.find((row) => row.fleetNumber === bus.fleetNumber).left, 500);
  });

  test('supervisors hear about tyres, batteries and oil due, and vendors hear nothing', async () => {
    const vendor = await newVendor('due');
    const bus = await createBus(users, 'DUEN', vendor.id, { rates: undefined });
    const { today } = (await api('GET', '/sheets/readings', { token: users.creator.token })).body.data;
    await api('PUT', '/sheets/readings', { token: users.creator.token, body: { busId: bus._id, date: today, km: 10300 } });

    const supervisor = await inbox(users.supervisor.token);
    const oil = supervisor.data.find((n) => n.type === 'serviceDue' && n.params.fleetNumber === bus.fleetNumber && n.params.service === 'oil');
    assert.ok(oil, 'oil is overdue');
    assert.equal(oil.params.state, 'overdue');
    assert.equal(oil.params.delayed, 300);
    assert.ok(!supervisor.data.some((n) => n.type === 'serviceDue' && n.params.fleetNumber === bus.fleetNumber && n.params.service === 'transmission'), 'transmission has plenty left here');

    const vendorInbox = await inbox(vendor.token);
    assert.equal(vendorInbox.data.length, 0);
  });

  test('supervisors get a weekly report notice, once a week', async () => {
    const supervisor = await inbox(users.supervisor.token);
    const notices = supervisor.data.filter((n) => n.type === 'weeklyReport');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].link, '/reports/weekly');
  });

  test('a short or missing LPO tells purchasing and the supervisor', async () => {
    const vendor = await newVendor('short');
    const bus = await createBus(users, 'LPOS', vendor.id, { rates: undefined });
    const ticket = await toInvoiceAccepted(users, await repair(bus._id), vendor);
    assert.equal(ticket.lpoDeduction.status, 'noLpo');
    for (const token of [users.purchasing.token, users.supervisor.token]) {
      const box = await inbox(token);
      const notice = box.data.find((n) => n.type === 'lpoProblem' && n.params.vsrNumber === ticket.vsrNumber);
      assert.ok(notice, 'each of them hears about it');
      assert.equal(notice.link, `/tickets/${ticket._id}`);
    }
  });

  test('reading one or all marks them read, for that person only', async () => {
    const box = await inbox(users.supervisor.token);
    const [first] = box.data.filter((n) => !n.readAt);
    const marked = await api('PUT', `/notifications/${first._id}/read`, { token: users.supervisor.token });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    const after = await inbox(users.supervisor.token);
    assert.equal(after.unread, box.unread - 1);
    assert.equal((await api('PUT', `/notifications/${first._id}/read`, { token: users.purchasing.token })).status, 404, 'not theirs');

    await api('PUT', '/notifications/read-all', { token: users.supervisor.token });
    assert.equal((await inbox(users.supervisor.token)).unread, 0);
  });

  test('forwarded VSRs show up as work for purchasing on the dashboard', async () => {
    const vendor = await newVendor('dash');
    const bus = await createBus(users, 'DASH', vendor.id, { rates: undefined });
    const before = (await api('GET', '/users/dashboard', { token: users.purchasing.token })).body.data;
    await toForwarded(users, await repair(bus._id), vendor);
    const after = (await api('GET', '/users/dashboard', { token: users.purchasing.token })).body.data;
    assert.equal(after.tickets.forwardedToPurchase, before.tickets.forwardedToPurchase + 1);
    assert.equal(after.actionRequired, before.actionRequired + 1);
  });
});
