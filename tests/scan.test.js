/**
 * Item 6's OCR: the creator scans the vendor's quotation file and gets the parts table filled
 * in to check. Claude itself is the one external thing here, so a local stand-in answers on
 * its URL; everything up to the HTTP request is the real code and the real SDK.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { api, createBus, estimate, fileOf, signInEveryone } from './helpers.js';

let users;
let bus;
const mainApi = process.env.API_URL;

// What the stand-in answers next, and what it was asked last.
let answer;
let lastRequest;
const QUOTATION = {
  quotationNumber: 'Q-2291',
  parts: [
    { name: 'Water pump', description: 'Front', code: 'WP', partNumber: 'WP-1', quantity: 2, unitPrice: 300 },
    { name: 'Gasket', description: null, code: null, partNumber: null, quantity: 1, unitPrice: 150 },
  ],
  labourHours: 4,
  labourAmount: 200,
  consumables: 50,
  total: 1000,
};
const message = (text, stop_reason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const standIn = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
});

let withKey; // an API like the live one, but with a key and pointed at the stand-in

const scan = (id, body = {}, token = users.creator.token, base = withKey) =>
  fetch(`${base}/api/tickets/${id}/scan-quotation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

const withEstimate = async (files = [fileOf('quote.pdf', '%PDF-1.4 quotation')]) => {
  const raised = await api('POST', '/tickets', { token: users.creator.token, body: { busId: bus._id, serviceType: 'repair', repairCategory: 'ENGINE', currentReading: 100 } });
  const sent = await estimate(raised.body.data._id, users.vendor1.token, { amount: '900' }, '', files);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return sent.body.data;
};

describe('scanning a quotation', () => {
  let server;

  before(async () => {
    users = await signInEveryone();
    bus = await createBus(users, 'SCAN', users.vendor1.id, { rates: undefined });

    await new Promise((resolve) => {
      standIn.listen(0, '127.0.0.1', resolve);
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${standIn.address().port}`;
    const { default: connectDB } = await import('../config/db.js');
    const { default: app } = await import('../app.js');
    await connectDB({ maxAttempts: 2 });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    withKey = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await mongoose.connection.close();
    server.close();
    standIn.close();
  });

  test('with no key the button says it is not set up, and nothing else stops working', async () => {
    const ticket = await withEstimate();
    const res = await scan(ticket._id, {}, users.creator.token, mainApi);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'SCAN_NOT_CONFIGURED');
  });

  test('it reads the PDF and hands back lines for the creator to check, saving nothing', async () => {
    const ticket = await withEstimate();
    answer = { status: 200, body: message(JSON.stringify(QUOTATION)) };

    const res = await scan(ticket._id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { data } = res.body;
    assert.equal(data.quotationNumber, 'Q-2291');
    assert.equal(data.parts.length, 2);
    assert.deepEqual(data.parts[0], { name: 'Water pump', description: 'Front', code: 'WP', partNumber: 'WP-1', quantity: 2, unitPrice: 300 });
    assert.equal(data.parts[1].description, '', 'empty fields come back ready for a form');
    assert.equal(data.labourHours, 4);
    assert.equal(data.consumables, 50);
    assert.equal(data.total, 1000);

    const { body, headers, url } = lastRequest;
    assert.match(url, /^\/v1\/messages/);
    assert.match(headers['x-api-key'] ?? headers.authorization, /test-key/);
    assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.output_config.format.type, 'json_schema');
    const [document] = body.messages[0].content;
    assert.equal(document.type, 'document');
    assert.equal(document.source.media_type, 'application/pdf');
    assert.equal(Buffer.from(document.source.data, 'base64').toString(), '%PDF-1.4 quotation');

    const after_ = await api('GET', `/tickets/${ticket._id}`, { token: users.creator.token });
    assert.equal(after_.body.data.breakdown, undefined, 'the creator decides what to save');
  });

  test('a photo goes as an image, and a chosen file wins over the first one', async () => {
    const photo = new File(['fake-jpeg'], 'quote.jpg', { type: 'image/jpeg' });
    const ticket = await withEstimate([fileOf('other.pdf'), photo]);
    answer = { status: 200, body: message(JSON.stringify(QUOTATION)) };
    const [, jpg] = ticket.negotiation[0].attachments;
    const res = await scan(ticket._id, { attachmentId: jpg._id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [image] = lastRequest.body.messages[0].content;
    assert.equal(image.type, 'image');
    assert.equal(image.source.media_type, 'image/jpeg');
    assert.equal(Buffer.from(image.source.data, 'base64').toString(), 'fake-jpeg');
  });

  test('nonsense lines are dropped and missing quantities become one', async () => {
    const ticket = await withEstimate();
    const messy = {
      ...QUOTATION,
      parts: [
        { name: '  ', description: null, code: null, partNumber: null, quantity: 1, unitPrice: 1 },
        { name: 'Belt', description: null, code: null, partNumber: null, quantity: 0, unitPrice: 40 },
        { name: 'Hose', description: null, code: null, partNumber: null, quantity: 2, unitPrice: -5 },
      ],
      labourHours: null,
      consumables: null,
    };
    answer = { status: 200, body: message(JSON.stringify(messy)) };
    const { data } = (await scan(ticket._id)).body;
    assert.deepEqual(data.parts.map((p) => [p.name, p.quantity, p.unitPrice]), [['Belt', 1, 40], ['Hose', 2, 0]]);
    assert.equal(data.labourHours, 0);
    assert.equal(data.consumables, 0);
  });

  test('only the creator, only while the price is open, only with a file it can read', async () => {
    const ticket = await withEstimate();
    assert.equal((await scan(ticket._id, {}, users.vendor1.token)).status, 403);
    assert.equal((await scan(ticket._id, { attachmentId: 'nope' })).status, 400);
    assert.equal((await scan(ticket._id, { attachmentId: '64b000000000000000000000' })).status, 404);

    const noFile = await withEstimate([]);
    const none = await scan(noFile._id);
    assert.equal(none.status, 400);
    assert.equal(none.body.errors[0].field, 'attachments');

    const word = new File(['doc'], 'quote.docx', { type: 'application/msword' });
    const wordOnly = await withEstimate([word]);
    const refused = await scan(wordOnly._id);
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /PDF/);

    await api('PUT', `/tickets/${ticket._id}/breakdown`, { token: users.creator.token, body: { consumables: 900 } });
    await api('PUT', `/tickets/${ticket._id}/escalate`, { token: users.creator.token });
    assert.equal((await scan(ticket._id)).status, 409);
  });

  test('a refusal or a failed call says the scan did not work, so the creator types it', async () => {
    const ticket = await withEstimate();
    answer = { status: 200, body: { ...message(''), content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'no' } } };
    const refused = await scan(ticket._id);
    assert.equal(refused.status, 502);
    assert.equal(refused.body.code, 'SCAN_FAILED');

    answer = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' }, request_id: 'req_1' } };
    const failed = await scan(ticket._id);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, 'SCAN_FAILED');

    answer = { status: 200, body: message(JSON.stringify(QUOTATION), 'max_tokens') };
    assert.equal((await scan(ticket._id)).status, 502, 'a cut-off answer is not trusted, even if it reads as JSON');

    answer = { status: 200, body: message('not json at all') };
    const garbled = await scan(ticket._id);
    assert.equal(garbled.status, 502);
  });
});
