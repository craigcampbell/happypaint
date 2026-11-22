// Exercise the private Family sheet from provider request through late join and erasure.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { AI_COLORING_CONSENT_VERSION } from '../src/data/aiColoring.js';

const root = new URL('..', import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'family-coloring-'));
const calls = [];
const sockets = new Set();
const adminKey = 'fixture-coloring-moderator';
let rejectStage = '';
let child;
let logs = '';
let base;
const subscriptions = Object.fromEntries(['owner', 'other'].map(id => [id, {
  profileId: id, status: 'active', priceId: 'price_test', quantity: 1,
  familyProductValid: true, currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400,
}]));
const drawing = await sharp(Buffer.from('<svg width="512" height="512"><rect width="512" height="512" fill="white"/><circle cx="256" cy="256" r="140" fill="none" stroke="black" stroke-width="10"/></svg>'))
  .png().toBuffer();
const blank = await sharp({ create: { width: 128, height: 128, channels: 3, background: 'white' } }).png().toBuffer();
const mock = http.createServer(async (req, res) => {
  const reply = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  if (req.url.endsWith('/auth-refresh')) {
    const id = req.headers.authorization;
    return ['owner', 'friend', 'other'].includes(id) ? reply(200, { record: { id } }) : reply(401, {});
  }
  assert.equal(req.headers.authorization, 'Bearer coloring-test-key');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (req.url === '/api/v1/images') {
    calls.push('image');
    const raster = rejectStage === 'blank' ? blank : drawing;
    return reply(200, { data: [{ b64_json: raster.toString('base64'), media_type: 'image/png' }] });
  }
  if (req.url === '/api/v1/chat/completions') {
    const isImage = body.messages.some(msg => Array.isArray(msg.content) && msg.content.some(part => part.type === 'image_url'));
    const stage = isImage ? 'reviewImage' : 'reviewPrompt';
    calls.push(stage);
    return reply(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: rejectStage === stage ? 'BLOCK' : 'ALLOW' } }] });
  }
  return reply(404, {});
});

async function stop() {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exiting = once(child, 'exit');
    child.kill();
    await exiting;
  }
}
async function start(accounts = true, enabled = true) {
  const sock = http.createServer();
  sock.listen(0, '127.0.0.1');
  await once(sock, 'listening');
  const port = sock.address().port;
  await new Promise(resolve => sock.close(resolve));
  base = 'http://127.0.0.1:' + port;
  const mockOrigin = 'http://127.0.0.1:' + mock.address().port;
  child = spawn(process.execPath, ['--import', join(dir, 'fixture.mjs'), 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_KEY: adminKey, PB_URL: accounts ? mockOrigin : '', POCKETBASE_URL: '',
      AI_COLORING_ENABLED: String(enabled), OPENROUTER_API_KEY: 'coloring-test-key', COLORING_TEST_ORIGIN: mockOrigin,
      AI_COLORING_MODEL: 'x-ai/grok-imagine-image-2.0', STRIPE_SECRET_KEY: '', STRIPE_CHECKOUT_ENABLED: 'false' },
  });
  child.stdout.on('data', b => { logs = (logs + b).slice(-4000); });
  child.stderr.on('data', b => { logs = (logs + b).slice(-4000); });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('Server exited: ' + logs);
    try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* starting */ }
    await delay(60);
  }
  throw Error('Server start timed out: ' + logs);
}
async function api(path, token, body, key) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(base + path, { headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
function admin(suffix = '', method = 'GET', headers = { 'x-admin-key': adminKey }) {
  return fetch(base + '/api/admin/ai-coloring' + suffix, { method, headers });
}
async function painter(room, token = '') {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws?room=' + room);
  sockets.add(ws);
  const events = [];
  ws.on('message', raw => events.push(JSON.parse(raw.toString())));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  async function message(test) {
    for (let i = 0; i < 150; i++) {
      const at = events.findIndex(test);
      if (at >= 0) return events.splice(at, 1)[0];
      await delay(25);
    }
    throw Error('Missing WS event in ' + room + ': ' + events.map(row => row.type).join(', '));
  }
  await message(e => e.type === 'connected');
  return { send: value => ws.send(JSON.stringify(value)), events, message };
}

const room = 'PANDA_CAB-01';
const sheetApi = '/api/rooms/' + room + '/ai-coloring';
const request = { prompt: 'A red panda baking moon cakes in a tiny kitchen', detail: 'simple', consentVersion: AI_COLORING_CONSENT_VERSION };
try {
  await writeFile(join(dir, '.billing.json'), JSON.stringify({ version: 2, records: subscriptions }));
  // Keep the production transport and payload shape. Redirect only in this child process.
  await writeFile(join(dir, 'fixture.mjs'), [
    'const actual = globalThis.fetch;',
    'globalThis.fetch = (url, options) => {',
    '  const u = new URL(url);',
    '  if (u.origin === "https://openrouter.ai") return actual(process.env.COLORING_TEST_ORIGIN + u.pathname, options);',
    '  if (u.hostname !== "127.0.0.1") throw Error("Unexpected external request in fixture");',
    '  return actual(url, options);',
    '};',
  ].join('\n'));
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');

  await start(false);
  assert.equal((await api('/api/billing/config')).body.aiColoringEnabled, false);
  assert(Array.isArray((await api('/api/coloring-sheets')).body.sheets));
  await painter('MAIN');
  assert((await api(sheetApi, '', request)).status >= 400);
  assert.equal(calls.length, 0);
  await stop();
  await start();
  assert.equal((await api('/api/billing/config')).body.aiColoringEnabled, true);
  const owner = await painter(room, 'owner');
  const friend = await painter(room, 'friend');
  const outsider = await painter('OTHERBOX', 'other');
  assert.equal((await api(sheetApi, 'owner')).body.remaining, 5);
  assert((await api(sheetApi, 'friend', request)).status >= 400);
  assert((await api(sheetApi, 'other', request)).status >= 400);
  assert.equal((await api(sheetApi, 'owner', { ...request, consentVersion: 'old' })).body.error, 'consent_required');
  assert.equal((await api(sheetApi, 'owner', { ...request, prompt: '' })).body.error, 'invalid_recipe');
  assert.equal(calls.length, 0);

  rejectStage = 'reviewPrompt';
  assert.equal((await api(sheetApi, 'owner', request, randomUUID())).body.stage, 'prompt');
  assert.deepEqual(calls.splice(0), ['reviewPrompt']);
  rejectStage = 'reviewImage';
  assert.equal((await api(sheetApi, 'owner', request, randomUUID())).body.stage, 'image');
  assert.deepEqual(calls.splice(0), ['reviewPrompt', 'image', 'reviewImage']);
  rejectStage = 'blank';
  assert.equal((await api(sheetApi, 'owner', request, randomUUID())).body.error, 'unusable_page');
  assert.deepEqual(calls.splice(0), ['reviewPrompt', 'image', 'reviewImage']);
  rejectStage = '';
  const key = randomUUID();
  const made = await api(sheetApi, 'owner', request, key);
  assert(made.status >= 200 && made.status < 300, JSON.stringify(made.body).slice(0,190));
  const { id, image, remaining } = made.body;
  assert.match(id, /^ai_/);
  assert.equal(remaining, 4);
  assert.match(image, /^data:image\/png;base64,/);
  assert.deepEqual(calls.splice(0), ['reviewPrompt', 'image', 'reviewImage']);
  const repeated = await api(sheetApi, 'owner', request, key);
  assert.equal(repeated.body.id, id);
  assert.equal(calls.length, 0);

  const imagePath = '/' + id + '/image';
  const reviewPath = '/' + id + '/review';
  const removePath = '/' + id + '/remove';
  for (const [suffix, method] of [['', 'GET'], [imagePath, 'GET'], [reviewPath, 'POST'], [removePath, 'POST']]) {
    assert.equal((await admin(suffix, method, {})).status, 401);
    assert.equal((await admin(suffix, method, { Authorization: 'Bearer owner' })).status, 401);
  }
  const pending = await (await admin()).json();
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].id, id);
  assert.equal(pending.items[0].room, room);
  assert.equal(pending.items[0].status, 'pending');
  assert.deepEqual(pending.counts, { pending: 1, reviewed: 0, removed: 0, blockedPrompt: 1, blockedImage: 1 });
  assert(!JSON.stringify(pending).includes(request.prompt));
  assert(!JSON.stringify(pending).includes('data:image'));
  assert.equal((await (await admin('?room=OTHERBOX')).json()).total, 0);
  const adminImage = await admin(imagePath);
  assert.equal(adminImage.status, 200);
  assert.match(adminImage.headers.get('cache-control'), /no-store/);
  assert.equal(adminImage.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(adminImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await adminImage.arrayBuffer()), Buffer.from(image.split(',')[1], 'base64'));
  assert.equal((await admin(reviewPath, 'POST')).status, 200);
  assert.equal((await admin(reviewPath, 'POST')).status, 200);
  assert.equal((await (await admin()).json()).total, 0);

  const read = '/api/sheets/' + id;
  assert.equal((await api(read, 'friend')).status, 404, 'preview is private to its owner');
  assert.equal((await api(read, 'other')).status, 404);
  assert.equal((await api(read)).status, 404);
  assert(!(await api('/api/sheets')).body.sheets.some(sheet => sheet.id === id));
  outsider.send({ type: 'set_sheet', sheetId: id });
  owner.send({ type: 'set_sheet', sheetId: id });
  await friend.message(e => e.type === 'sheet' && e.sheetId === id);
  assert.equal((await api(read, 'friend')).body.image, image);
  assert(!outsider.events.some(e => e.type === 'sheet' && e.sheetId === id));
  await stop();
  await start();
  const rejoined = await painter(room, 'friend');
  await rejoined.message(e => e.type === 'sheet' && e.sheetId === id);
  assert.equal((await api(read, 'friend')).body.image, image);
  const returnedOwner = await painter(room, 'owner');
  const strokeId = 'keep-this-brushstroke';
  returnedOwner.send({ type: 'op', op: { kind: 'draw', strokeId, points: [{ x: 10, y: 12 }, { x: 20, y: 24 }],
    settings: { brush: 'pencil', size: 5, color: '#147281' }, end: true } });
  await rejoined.message(e => e.type === 'op' && e.op.strokeId === strokeId);
  assert.equal((await (await admin('?status=reviewed')).json()).items[0].id, id);
  assert.equal((await admin(removePath, 'POST')).status, 200);
  await rejoined.message(e => e.type === 'ai_coloring_removed' && e.sheetId === id);
  await rejoined.message(e => e.type === 'sheet' && e.sheetId === null);
  assert.equal((await api(read, 'owner')).status, 404);
  assert.equal((await api(read, 'friend')).status, 404);
  assert.equal((await admin(imagePath)).status, 404);
  assert.equal((await admin(removePath, 'POST')).status, 200);
  assert.equal((await admin(reviewPath, 'POST')).status, 409);
  const removed = await (await admin('?status=removed')).json();
  assert.equal(removed.items[0].id, id);
  assert.equal(removed.counts.removed, 1);
  const retryRemoved = await api(sheetApi, 'owner', request, key);
  assert.equal(retryRemoved.status, 410);
  assert.equal(retryRemoved.body.error, 'page_removed');
  assert.equal(calls.length, 0);
  const lateJoin = await painter(room, 'friend');
  await lateJoin.message(e => e.type === 'history' && e.ops?.some(op => op.strokeId === strokeId));
  assert.equal((await api(sheetApi, 'owner')).body.remaining, 4);
  for (let i = 0; i < 4; i++) {
    const next = await api(sheetApi, 'owner', request, randomUUID());
    assert.equal(next.body.remaining, 3 - i, 'monthly allowance');
  }
  const charges = calls.length;
  assert.equal((await api(sheetApi, 'owner', request, randomUUID())).status, 429);
  assert.equal(calls.length, charges);
  assert.equal((await api('/api/account/scrub-chat', 'owner', {})).status, 200);
  assert.equal((await api(read, 'friend')).status, 404);
  assert.equal((await (await admin('?status=all')).json()).total, 0);
  console.log('Family AI coloring passed for anonymous library, access, automated and human moderation, live takedown, preserved strokes, restart, quota and erasure.');
} finally {
  await stop();
  if (mock.listening) await new Promise(resolve => mock.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
