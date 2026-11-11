/**
 * The VSR list (owner's testing notes, 2026-11-11): "the ids should be in sequence", so it runs
 * by VSR number compared as numbers, newest first; and "we can select what are we searching in",
 * so `searchIn` narrows the search to one field. Each role's scope stays as it was.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { api, clearLpos, createBus, run, signInEveryone, testDb } from './helpers.js';

let users;

const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};
const raiseVsr = (busId) =>
  api('POST', '/tickets', { token: users.creator.token, body: { busId, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 1000, description: 'List test job.' } });
const numbersOf = (res) => {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.map((ticket) => ticket.vsrNumber);
};

describe('VSR list', () => {
  before(async () => {
    users = await signInEveryone();
    await clearLpos();
  });

  test('runs newest VSR number first, compared as numbers, an additional job beside its parent, on every page', async () => {
    const bus = await createBus(users, 'ORDER', users.vendor1.id);
    const raised = [];
    for (let i = 0; i < 7; i += 1) raised.push(ok(await raiseVsr(bus._id)));

    // The depot's own records: raised in an order that does not follow their numbers, as imported VSRs are.
    const numbers = ['VSR-22195', 'VSR-22260', 'VSR-22193', 'VSR-22557b', 'VSR-9999', 'VSR-22557', 'VSR-22196'];
    const start = Date.parse('2026-10-01T06:00:00Z');
    const connection = await testDb();
    try {
      for (const [i, ticket] of raised.entries()) {
        await connection.collection('tickets').updateOne(
          { _id: new mongoose.Types.ObjectId(ticket._id) },
          { $set: { vsrNumber: numbers[i], createdAt: new Date(start + i * 60_000) } }
        );
      }
    } finally {
      await connection.close();
    }

    const newest = ['VSR-22557b', 'VSR-22557', 'VSR-22260', 'VSR-22196', 'VSR-22195', 'VSR-22193', 'VSR-9999'];
    const forBus = `busId=${bus._id}&limit=200`;
    assert.deepEqual(numbersOf(await api('GET', `/tickets?${forBus}`, { token: users.creator.token })), newest);
    assert.deepEqual(numbersOf(await api('GET', `/tickets?${forBus}&sort=newest`, { token: users.supervisor.token })), newest);
    assert.deepEqual(numbersOf(await api('GET', `/tickets?${forBus}&sort=oldest`, { token: users.creator.token })), [...newest].reverse());

    // Page by page it is the same order, nothing repeated or skipped.
    const paged = [];
    for (let page = 1; page <= 3; page += 1) {
      paged.push(...numbersOf(await api('GET', `/tickets?busId=${bus._id}&limit=3&page=${page}`, { token: users.creator.token })));
    }
    assert.deepEqual(paged, newest);

    // The vendor's list and the other VSR lists run the same way.
    assert.deepEqual(numbersOf(await api('GET', `/tickets?${forBus}`, { token: users.vendor1.token })), newest);
    assert.deepEqual(numbersOf(await api('GET', `/vendors/tickets?${forBus}`, { token: users.vendor1.token })), newest);
    assert.deepEqual(numbersOf(await api('GET', `/tickets/my-tickets?${forBus}`, { token: users.creator.token })), newest);
    const connection2 = await testDb();
    try {
      await connection2.collection('tickets').updateMany({ busId: new mongoose.Types.ObjectId(bus._id) }, { $set: { status: 'pending' } });
    } finally {
      await connection2.close();
    }
    assert.deepEqual(numbersOf(await api('GET', `/tickets/pending?${forBus}`, { token: users.supervisor.token })), newest);
    assert.deepEqual(numbersOf(await api('GET', `/tickets/pending?${forBus}&sort=oldest`, { token: users.supervisor.token })), [...newest].reverse());
  });

  test('searchIn narrows the search to one field; all of them also finds brand and type', async () => {
    const make = `Brand${run}`;
    const model = `Type${run}`;
    const one = await createBus(users, 'SIA', users.vendor1.id, { make: `${make}A`, model: `${model}A` });
    const two = await createBus(users, 'SIB', users.vendor2.id, { make: `${make}B`, model: `${model}B` });
    const a = ok(await raiseVsr(one._id));
    const b = ok(await raiseVsr(two._id));
    const search = async (user, q, searchIn, extra = '') => {
      const field = searchIn === undefined ? '' : `&searchIn=${searchIn}`;
      const res = await api('GET', `/tickets?limit=200&q=${encodeURIComponent(q)}${field}${extra}`, { token: user.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data.map((ticket) => ticket._id).sort();
    };
    const both = [a._id, b._id].sort();

    // All, the default, now looks at the bus's brand and type too.
    assert.deepEqual(await search(users.creator, `${make}A`), [a._id]);
    assert.deepEqual(await search(users.creator, `${model}b`, 'all'), [b._id]);

    // Brand and type: either one, or both as the list shows them.
    assert.deepEqual(await search(users.supervisor, make, 'brandType'), both);
    assert.deepEqual(await search(users.creator, `${model}A`, 'brandType'), [a._id]);
    assert.deepEqual(await search(users.creator, `${make}A ${model}A`, 'brandType'), [a._id]);
    assert.deepEqual(await search(users.creator, one.fleetNumber, 'brandType'), []);

    // VSR number, side number and plate each look at their own field only.
    assert.deepEqual(await search(users.creator, a.vsrNumber, 'vsr'), [a._id]);
    assert.deepEqual(await search(users.creator, one.fleetNumber, 'vsr'), []);
    assert.deepEqual(await search(users.creator, one.fleetNumber.toLowerCase(), 'side'), [a._id]);
    assert.deepEqual(await search(users.creator, one.registrationNumber, 'side'), []);
    assert.deepEqual(await search(users.creator, a.vsrNumber, 'side'), []);
    assert.deepEqual(await search(users.creator, one.registrationNumber, 'plate'), [a._id]);
    assert.deepEqual(await search(users.creator, one.fleetNumber, 'plate'), []);

    // Vendor: the depot finds a vendor's jobs by name, and nothing else.
    const byVendor = await search(users.creator, `vendor-two ${run}`, 'vendor');
    assert.ok(byVendor.includes(b._id) && !byVendor.includes(a._id));
    assert.deepEqual(await search(users.creator, two.fleetNumber, 'vendor'), []);
    assert.deepEqual(await search(users.creator, `vendor-two ${run}`, 'plate'), []);

    // A vendor still sees only their own, whatever the field; their VSRs are all theirs, so no vendor search.
    assert.deepEqual(await search(users.vendor1, make, 'brandType'), [a._id]);
    assert.deepEqual(await search(users.vendor1, `${make}B`), []);
    assert.deepEqual(await search(users.vendor1, two.fleetNumber, 'side'), []);
    assert.deepEqual(await search(users.vendor1, `vendor-one ${run}`, 'vendor'), []);

    // It only narrows: other filters and each role's scope still apply.
    assert.deepEqual(await search(users.creator, make, 'brandType', `&busId=${two._id}`), [b._id]);
    assert.deepEqual(await search(users.creator, make, 'brandType', '&status=completed'), []);
    assert.deepEqual(await search(users.purchasing, make, 'brandType'), []);

    // Without a search it changes nothing; an unknown or repeated field is refused.
    const unsearched = await api('GET', `/tickets?busId=${one._id}&searchIn=plate`, { token: users.creator.token });
    assert.deepEqual(unsearched.body.data.map((ticket) => ticket._id), [a._id]);
    assert.equal((await api('GET', '/tickets?q=a&searchIn=everything', { token: users.creator.token })).status, 400);
    assert.equal((await api('GET', '/tickets?q=a&searchIn=vsr&searchIn=side', { token: users.creator.token })).status, 400);
  });
});
