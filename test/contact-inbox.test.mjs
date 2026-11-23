import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { createContactInbox } from '../server/contactInbox.js';

const day = 86_400_000;

async function fixture(t, { directory, seed, clock, rateOk = () => true, contactEmail = 'owner@example.test' } = {}) {
  const dir = directory || mkdtempSync(join(tmpdir(), 'drawesome-contact-'));
  if (!directory) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.contact-inbox.json');
  if (seed) writeFileSync(file, seed);
  const inbox = createContactInbox(dir, clock);
  const app = express();
  inbox.registerRoutes(app, {
    adminGuard(req, res) {
      if (req.get('x-admin-key') === 'test-key') return true;
      res.status(401).json({ error: 'unauthorized' });
      return false;
    },
    clientIp: req => req.get('x-fixture-ip') || 'test', rateOk, contactEmail,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  async function request(path, { method = 'GET', body, admin = false, ip = 'test' } = {}) {
    return fetch('http://127.0.0.1:' + server.address().port + '/api/' + path, {
      method,
      headers: { 'x-fixture-ip': ip, ...(admin ? { 'x-admin-key': 'test-key' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const list = async () => (await (await request('admin/contact', { admin: true })).json()).messages;
  async function solve() {
    const response = await request('contact/challenge');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const challenge = await response.json();
    assert.deepEqual(Object.keys(challenge).sort(), ['challengeId', 'emailAvailable', 'question']);
    const [, a, b] = /^What is (\d+) plus (\d+)\?$/.exec(challenge.question);
    return { challengeId: challenge.challengeId, answer: String(Number(a) + Number(b)) };
  }
  const submit = async body => request('contact', { method: 'POST', body: { ...body, ...await solve() } });
  return { dir, file, inbox, request, list, solve, submit };
}

test('contact inbox persists one receipt per request; only admins can read, resolve or delete', async t => {
  const f = await fixture(t);
  const draft = { topic: 'bug', email: 'reply+paint@example.org', message: 'The brushes move aside on my tablet.', requestId: randomUUID() };
  const body = { ...draft, ...await f.solve() };
  const replay = await Promise.all([1, 2].map(() => f.request('contact', { method: 'POST', body })));
  assert.deepEqual(replay.map(r => r.status), [201, 201]);
  assert.deepEqual(await replay[0].json(), { ok: true });
  assert.equal((await f.submit({ ...draft, topic: 'safety' })).status, 409);
  assert.equal(f.inbox.openCount(), 1);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  const [msg] = await f.list();
  assert.deepEqual(Object.keys(msg).sort(), ['id','topic','message','email','createdAt','status'].sort());
  assert.equal(msg.email, draft.email);
  const path = 'admin/contact/' + msg.id;
  for (const [method, url] of [['GET','admin/contact'],['PATCH',path],['DELETE',path]]) {
    const unauth = await f.request(url, { method });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await f.request(path, { method: 'PATCH', body: { status: 'resolved' }, admin: true })).status, 200);
  assert.equal(f.inbox.openCount(), 0);
  const restart = await fixture(t, { directory: f.dir });
  assert.equal((await restart.list())[0].status, 'resolved');
  assert.equal((await restart.request(path, { method: 'DELETE', admin: true })).status, 200);
  assert.deepEqual(await restart.list(), []);
});

test('both contact actions need a live, single-use human check from the issuing visitor', async t => {
  let time = Date.now();
  const f = await fixture(t, { clock: () => time });
  const draft = { topic: 'general', message: 'A private note from a visitor.' };
  const post = (path, body, ip = 'test') => f.request(path, { method: 'POST', body, ip });
  async function assertRejected(response) {
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'invalid_challenge' });
  }
  await assertRejected(await post('contact', draft));
  await assertRejected(await post('contact/email', {}));
  assert.deepEqual(await f.list(), []);

  const check = await f.solve();
  await assertRejected(await post('contact/email', check, 'different'));
  const revealed = await post('contact/email', check);
  assert.equal(revealed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await revealed.json(), { email: 'owner@example.test' });
  await assertRejected(await post('contact', { ...draft, ...check }));

  const wrong = await f.solve();
  await assertRejected(await post('contact/email', { ...wrong, answer: '999' }));
  await assertRejected(await post('contact/email', wrong));
  const expired = await f.solve();
  time += 15 * 60_000;
  await assertRejected(await post('contact', { ...draft, ...expired }));
  assert.deepEqual(await f.list(), []);
  const valid = await f.solve();
  assert.equal((await post('contact', { ...draft, ...valid })).status, 201);
  await assertRejected(await post('contact/email', valid));
  assert.equal((await f.list()).length, 1);
});

test('an unset or invalid contact address leaves the guest inbox available', async t => {
  for (const contactEmail of ['', 'first@example.test,second@example.test']) {
    const f = await fixture(t, { contactEmail });
    assert.equal((await (await f.request('contact/challenge')).json()).emailAvailable, false);
    const check = await f.solve();
    const response = await f.request('contact/email', { method: 'POST', body: check });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'email_unavailable' });
    const post = await f.request('contact', { method: 'POST', body: { topic: 'bug', message: 'Please help with my drawing.', ...check } });
    assert.equal(post.status, 201);
    assert.equal((await f.list()).length, 1);
  }
});

test('challenge issuance and both verification paths are rate limited before disclosing data', async t => {
  const keys = [];
  const f = await fixture(t, { rateOk(key) { keys.push(key); return false; } });
  const responses = [
    await f.request('contact/challenge'),
    await f.request('contact/email', { method: 'POST', body: {} }),
    await f.request('contact', { method: 'POST', body: {} }),
  ];
  assert.deepEqual(keys, ['contact-challenge:test', 'contact-attempt:test', 'contact-attempt:test']);
  for (const response of responses) {
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'rate_limited' });
  }
});

test('public form limits and retention; erasure matches the verified reply address only', async t => {
  let time = Date.now();
  const f = await fixture(t, { clock: () => time });
  const draft = { topic: 'privacy', message: 'Could you help with my painting?' };
  assert.equal((await f.submit({ ...draft, email: 'not-an-email' })).status, 400);
  assert.equal((await f.submit({ ...draft, message: 'short' })).status, 400);
  assert.equal((await f.submit({ ...draft, message: 'm'.repeat(17*1024) })).status, 413);
  assert.equal((await f.submit({ website: 'crawler.example' })).status, 201);
  assert.deepEqual(await f.list(), []);
  await f.submit({ ...draft, email: 'Reply@example.org' });
  await f.submit(draft);
  f.inbox.scrubEmail('reply@EXAMPLE.org');
  assert.deepEqual((await f.list()).map(m => m.email), ['']);
  time += 90 * day;
  assert.equal(f.inbox.openCount(), 0);
  assert.deepEqual(await f.list(), []);
  assert.deepEqual(JSON.parse(readFileSync(f.file)).messages, []);
});

test('failed storage does not acknowledge delivery or replace damaged data', async t => {
  const damaged = 'damaged file for test';
  const f = await fixture(t, { seed: damaged });
  assert.equal((await f.submit({ topic: 'general', message: 'I need help with the studio.' })).status, 503);
  assert.equal((await f.request('admin/contact', { admin: true })).status, 503);
  assert.equal(readFileSync(f.file, 'utf8'), damaged);
});

test('inbox capacity and failed disk writes preserve existing submissions', async t => {
  const draft = { topic: 'general', email: '', message: 'Please help with drawing together.' };
  const messages = Array.from({ length: 500 }, () => ({ ...draft, id: randomUUID(), requestId: '', createdAt: Date.now(), status: 'open' }));
  const f = await fixture(t, { seed: JSON.stringify({ version: 1, messages }) });
  assert.equal((await f.submit(draft)).status, 503);
  assert.equal(f.inbox.openCount(), 500);
  const url = 'admin/contact/' + messages[0].id;
  mkdirSync(f.file + '.tmp'); // The atomic writer cannot create its temporary file.
  assert.equal((await f.request(url, { admin: true, method: 'DELETE' })).status, 503);
  assert.equal(f.inbox.openCount(), 500);
  assert.equal(JSON.parse(readFileSync(f.file)).messages.length, 500);
  rmSync(f.file + '.tmp', { recursive: true });
  assert.equal((await f.request(url, { admin: true, method: 'DELETE' })).status, 200);
  assert.equal((await f.submit(draft)).status, 201);
  assert.equal(f.inbox.openCount(), 500);
});
