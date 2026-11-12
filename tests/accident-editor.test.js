/**
 * The accident details on a VSR say who last changed them, by name. The 2026-11-12 walk-through on
 * a copy of live data showed "Last changed by Unknown": the API sent only the person's id.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createBus, signInEveryone } from './helpers.js';

let users;
let bus;
const ok = (res) => {
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return res.body.data;
};

describe('who changed the accident details', () => {
  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'ACCEDIT', users.vendor1.id);
  });

  test('the VSR names who raised the details, and who changed them since', async () => {
    const raised = ok(
      await api('POST', '/tickets', {
        token: users.creator.token,
        body: { busId: bus._id, currentReading: 5000, description: 'Rear panel scraped.', serviceType: 'accident', accident: { severity: 'minor', fault: 'ourDriver' } },
      })
    );
    const read = async () => ok(await api('GET', `/tickets/${raised._id}`, { token: users.supervisor.token }));
    // tests/run.mjs seeds these two staff accounts by these names.
    assert.equal((await read()).accident.updatedBy?.name, 'Test Creator');

    ok(await api('PUT', `/tickets/${raised._id}/accident`, { token: users.supervisor.token, body: { severity: 'major', fault: 'otherParty' } }));
    const changed = await read();
    assert.equal(changed.accident.updatedBy?.name, 'Test Supervisor');
    assert.equal(changed.accident.updatedBy?.password, undefined, 'only the name, email and role come with it');
  });

  test('a vendor still never sees the accident details', async () => {
    const listed = ok(await api('GET', `/tickets?busId=${bus._id}`, { token: users.vendor1.token }));
    assert.ok(listed.length > 0);
    listed.forEach((ticket) => assert.equal(ticket.accident, undefined));
  });
});
