// Exercise a Jam Pass coloring book from generation through room reuse, saving versions and erasure.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
let delayReviewUntil = 0;
const slowPrompt = 'A green turtle painting daisies';
let child;
let logs = '';
let base;
const now = Math.floor(Date.now() / 1000);
const paidUntil = now + 86400;
function subscription(id, overrides = {}) {
  return {
    profileId: id, customerId: 'cus_' + id, subscriptionId: 'sub_' + id, status: 'active',
    priceId: 'price_test', productId: 'prod_family', quantity: 1, familyProductValid: true,
    currentPeriodEnd: paidUntil, paidThrough: paidUntil, aiColoringPaidThrough: paidUntil, ...overrides,
  };
}
const subscriptions = {
  owner: subscription('owner'), other: subscription('other'), early: subscription('early'),
  canceled: subscription('canceled', { status: 'canceled' }),
  trial: subscription('trial', { status: 'trialing' }),
  grace: subscription('grace', { status: 'past_due', paidThrough: now - 3600, aiColoringPaidThrough: now - 3600 }),
  expired: subscription('expired', { paidThrough: now - 3600, aiColoringPaidThrough: now - 3600 }),
  unrelated: subscription('unrelated', { priceId: 'price_unrelated', productId: 'prod_other', familyProductValid: false }),
  unconfirmed: subscription('unconfirmed', { aiColoringPaidThrough: 0 }),
};
const drawing = await sharp(Buffer.from('<svg width="512" height="512"><rect width="512" height="512" fill="white"/><circle cx="256" cy="256" r="140" fill="none" stroke="black" stroke-width="10"/></svg>'))
  .png().toBuffer();
const blank = await sharp({ create: { width: 128, height: 128, channels: 3, background: 'white' } }).png().toBuffer();
const mock = http.createServer(async (req, res) => {
  const reply = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  if (req.url.endsWith('/auth-refresh')) {
    const id = req.headers.authorization;
    return id === 'friend' || Object.hasOwn(subscriptions, id) ? reply(200, { record: { id } }) : reply(401, {});
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
    if (delayReviewUntil && (isImage || body.messages.at(-1).content.includes(slowPrompt))) {
      await delay(Math.max(0, delayReviewUntil - Date.now()));
    }
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
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, THUMB_DIR: join(dir, '.thumbs'), ADMIN_KEY: adminKey,
      PB_URL: accounts ? mockOrigin : '', POCKETBASE_URL: '',
      AI_COLORING_ENABLED: String(enabled), OPENROUTER_API_KEY: 'coloring-test-key', COLORING_TEST_ORIGIN: mockOrigin,
      AI_COLORING_MODEL: 'x-ai/grok-imagine-image-2.0', STRIPE_PRODUCT_FAMILY: 'prod_family', STRIPE_PRICE_FAMILY_MONTHLY: 'price_test',
      STRIPE_PAST_DUE_GRACE_HOURS: '72', STRIPE_SECRET_KEY: '', STRIPE_CHECKOUT_ENABLED: 'false' },
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
const bookPath = '/api/me/coloring-book';
function bookImage(path, token) {
  return fetch(base + bookPath + path, { headers: { Authorization: 'Bearer ' + token } });
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
  const connected = await message(e => e.type === 'connected');
  return { send: value => ws.send(JSON.stringify(value)), close: () => ws.close(), events, message, connected };
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
  assert.equal((await api(bookPath)).status, 401);
  assert((await api(sheetApi, '', request)).status >= 400);
  assert.equal(calls.length, 0);
  await stop();
  await start();
  assert.equal((await api('/api/billing/config')).body.aiColoringEnabled, true);
  const owner = await painter(room, 'owner');
  const friend = await painter(room, 'friend');
  const outsider = await painter('OTHERBOX', 'other');
  assert.equal(owner.connected.aiColoringPaid, true);
  assert.equal(friend.connected.aiColoringPaid, false, 'a paid room does not grant an invitee generation rights');
  for (const token of ['', 'invalid-token']) {
    assert.equal((await api(bookPath, token)).status, 401);
    assert.equal((await api(sheetApi, token)).status, 401);
    assert.equal((await api(sheetApi, token, request, randomUUID())).status, 401);
  }
  assert.equal((await api('/api/billing/me', 'grace')).body.active, true, 'ordinary Family benefits still have a grace period');
  for (const profile of ['friend', 'canceled', 'trial', 'grace', 'expired', 'unrelated', 'unconfirmed']) {
    // Each user owns a private room, so these denials specifically test billing.
    const code = ('ROOM_' + profile).toUpperCase();
    const ownApi = '/api/rooms/' + code + '/ai-coloring';
    const member = await painter(code, profile);
    assert.equal(member.connected.isOwner, true);
    assert.equal(member.connected.aiColoringPaid, false, profile);
    assert.equal((await api(bookPath, profile)).status, 403);
    assert.equal((await api(ownApi, profile)).status, 403, profile);
    assert.equal((await api(ownApi, profile, request, randomUUID())).status, 403, profile);
    member.close();
  }
  assert.equal((await api(sheetApi, 'owner')).body.remaining, 5);
  assert.equal((await api(sheetApi, 'friend', request)).status, 403);
  assert.equal((await api(sheetApi, 'other', request)).status, 403);
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
  const bookEntry = '/' + id;
  const versionsPath = bookPath + bookEntry + '/versions';
  const finishedImage = await sharp(drawing).tint('#cd4c32').png().toBuffer();
  const capture = { room, image: 'data:image/png;base64,' + finishedImage.toString('base64') };
  const list = await api(bookPath, 'owner');
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].id, id);
  assert.equal((await api(bookPath, 'other')).body.total, 0);
  const outline = await bookImage(bookEntry + '/image', 'owner');
  assert.match(outline.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await outline.arrayBuffer()), Buffer.from(image.split(',')[1], 'base64'));
  assert.equal((await bookImage(bookEntry + '/image', 'other')).status, 404);
  assert((await api(versionsPath, 'owner', capture, randomUUID())).status >= 400, 'only an applied outline can get a finished version');

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
  assert.equal((await api(sheetApi, 'owner')).body.page.id, id);
  assert.equal((await api(read, 'owner')).body.image, image);
  assert.equal((await api(read, 'friend')).status, 404, 'preview is private to its owner');
  assert.equal((await api(read, 'other')).status, 404);
  assert.equal((await api(read)).status, 404);
  assert(!(await api('/api/sheets')).body.sheets.some(sheet => sheet.id === id));
  friend.send({ type: 'wipe_request', sheetId: id });
  await friend.message(e => e.type === 'wipe_req_denied' && e.reason === 'blocked');
  outsider.send({ type: 'set_sheet', sheetId: id });
  owner.send({ type: 'set_sheet', sheetId: id });
  await friend.message(e => e.type === 'sheet' && e.sheetId === id);
  assert((await api(versionsPath, 'friend', capture, randomUUID())).status >= 400);
  assert((await api(versionsPath, 'other', capture, randomUUID())).status >= 400);
  assert((await api(versionsPath, 'owner', { room, image: 'not an image' }, randomUUID())).status >= 400);
  const saveKey = randomUUID();
  const versions = await Promise.all([api(versionsPath, 'owner', capture, saveKey), api(versionsPath, 'owner', capture, saveKey)]);
  assert(versions.every(v => v.status === 200 || v.status === 201), 'simultaneous retries save the same finished version');
  assert.equal(versions[0].body.id, versions[1].body.id);
  const savedVersion = versions[0].body.id;
  const secondSaveKey = randomUUID();
  const secondCapture = { room, image: 'data:image/png;base64,' + drawing.toString('base64') };
  const nextVersion = await api(versionsPath, 'owner', secondCapture, secondSaveKey);
  assert(nextVersion.status === 200 || nextVersion.status === 201);
  assert.notEqual(nextVersion.body.id, savedVersion);
  const savedImagePath = bookEntry + '/versions/' + savedVersion + '/image';
  const finished = await bookImage(savedImagePath, 'owner');
  assert.equal(finished.status, 200);
  assert.equal(finished.headers.get('content-type'), 'image/png');
  assert.equal((await sharp(Buffer.from(await finished.arrayBuffer())).metadata()).width, 512);
  assert.equal((await bookImage(savedImagePath, 'other')).status, 404);
  assert.equal((await api(bookPath, 'owner')).body.items[0].versions.length, 2);
  const secondVersionPath = base + versionsPath + '/' + nextVersion.body.id;
  assert.equal((await fetch(secondVersionPath, { method: 'DELETE', headers: { Authorization: 'Bearer other' } })).status, 404);
  assert.equal((await fetch(secondVersionPath, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } })).status, 200);
  assert.equal((await api(versionsPath, 'owner', secondCapture, secondSaveKey)).status, 410);
  assert.equal((await bookImage(bookEntry + '/versions/' + nextVersion.body.id + '/image', 'owner')).status, 404);
  assert.equal((await api(sheetApi, 'owner')).body.remaining, 4, 'saving versions is free of generation charges');
  const otherJam = 'JAM_TOGETHER';
  const jamOwner = await painter(otherJam, 'owner');
  const jamGuest = await painter(otherJam, 'early');
  jamOwner.send({ type: 'set_sheet', sheetId: id });
  await jamGuest.message(e => e.type === 'sheet' && e.sheetId === id);
  assert.equal((await api(read + '?room=' + otherJam, 'early')).body.image, image);
  assert.equal((await api(read + '?room=' + room, 'early')).status, 404);
  assert.equal(calls.length, 0);
  assert.equal((await api(read, 'friend')).body.image, image);
  assert.equal((await api(read)).status, 404);
  assert.equal((await api(read, 'other')).status, 404);
  assert(!outsider.events.some(e => e.type === 'sheet' && e.sheetId === id));
  await stop();
  await start();
  assert.equal((await api(bookPath, 'owner')).body.items[0].versions.length, 1);
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
  assert.equal((await api(bookPath, 'owner')).body.total, 0);
  assert.equal((await bookImage(savedImagePath, 'owner')).status, 404);
  assert.equal((await painter(otherJam, 'early')).connected.hasSheet, false, 'takedown clears a second dormant room');
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

  // The subscription expires while OpenRouter is checking a third image.
  // The paid owner has one applied and one privately previewed page at expiry.
  const secondRoom = 'OTHERBOX';
  const secondApi = '/api/rooms/' + secondRoom + '/ai-coloring';
  const payingHost = await painter(secondRoom, 'other');
  const guest = await painter(secondRoom, 'friend');
  const first = await api(secondApi, 'other', request, randomUUID());
  const privateKey = randomUUID();
  const second = await api(secondApi, 'other', request, privateKey);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  payingHost.send({ type: 'set_sheet', sheetId: first.body.id });
  await guest.message(e => e.type === 'sheet' && e.sheetId === first.body.id);
  const activeSheet = '/api/sheets/' + first.body.id;
  const privateSheet = '/api/sheets/' + second.body.id;
  assert.equal((await api(activeSheet, 'friend')).status, 200);
  assert.equal((await api(privateSheet, 'other')).status, 200);
  const secondVersionApi = bookPath + '/' + first.body.id + '/versions';
  const keepKey = randomUUID();
  const keepData = { ...capture, room: secondRoom };
  const keep = await api(secondVersionApi, 'other', keepData, keepKey);
  assert(keep.status === 200 || keep.status === 201);
  await stop();
  const thumbnail = await sharp(drawing).resize(128, 128).jpeg().toBuffer();
  const thumbPath = join(dir, '.thumbs', secondRoom + '.jpg');
  await mkdir(join(dir, '.thumbs'), { recursive: true });
  await writeFile(thumbPath, thumbnail);
  const fetchThumbnail = () => fetch(base + '/api/me/rooms/' + secondRoom + '/thumb', { headers: { Authorization: 'Bearer other' } });
  const soon = Math.ceil(Date.now() / 1000) + 7;
  const endingPeriod = { paidThrough: soon, aiColoringPaidThrough: soon, currentPeriodEnd: soon };
  await writeFile(join(dir, '.billing.json'), JSON.stringify({ version: 2, records: {
    other: subscription('other', endingPeriod), early: subscription('early', endingPeriod),
  } }));
  await start();
  const paidThumbnail = await fetchThumbnail();
  assert.equal(paidThumbnail.status, 200, 'a paid owner can see a dormant room thumbnail');
  assert.deepEqual(Buffer.from(await paidThumbnail.arrayBuffer()), thumbnail);
  const expiringHost = await painter(secondRoom, 'other');
  const expiringGuest = await painter(secondRoom, 'friend');
  await expiringGuest.message(e => e.type === 'sheet' && e.sheetId === first.body.id);
  await painter('TURTLEBOX', 'early');
  calls.length = 0;
  delayReviewUntil = soon * 1000 + 100;
  const [interrupted, expiredAtPrompt] = await Promise.all([
    api(secondApi, 'other', request, randomUUID()),
    api('/api/rooms/TURTLEBOX/ai-coloring', 'early', { ...request, prompt: slowPrompt }, randomUUID()),
  ]);
  assert.equal(interrupted.status, 403, 'an in-flight page requires a paid owner at delivery');
  assert(!interrupted.body.image);
  assert.equal(expiredAtPrompt.status, 403);
  assert.deepEqual(calls.splice(0).sort(), ['image', 'reviewImage', 'reviewPrompt', 'reviewPrompt'],
    'expiry during prompt review stops the second image generation call');
  assert.equal((await (await admin('?room=' + secondRoom)).json()).total, 2);
  assert.equal((await api(secondApi, 'other')).status, 403);
  assert.equal((await api(secondApi, 'other', request, privateKey)).status, 403);
  assert.equal((await api(activeSheet, 'friend')).status, 404);
  assert.equal((await api(activeSheet, 'other')).status, 404);
  assert.equal((await api(privateSheet, 'other')).status, 404);
  assert.equal((await api(bookPath, 'other')).status, 403, 'lapsed accounts retain their data privately until renewal');
  await expiringHost.message(e => e.type === 'billing_entitlement' && e.aiColoringPaid === false);
  await expiringGuest.message(e => e.type === 'sheet' && e.sheetId === null);
  expiringHost.send({ type: 'set_sheet', sheetId: second.body.id });
  expiringHost.send({ type: 'wipe_request', sheetId: second.body.id });
  await expiringHost.message(e => e.type === 'wipe_req_denied' && e.reason === 'blocked');
  assert(!expiringHost.events.some(e => e.type === 'sheet' && e.sheetId === second.body.id));
  assert.equal((await painter(secondRoom, 'friend')).connected.hasSheet, false);
  assert.equal(calls.length, 0, 'rejected retries never reach OpenRouter');
  assert.equal((await fetchThumbnail()).status, 404);
  await stop();
  // Even an older render left on disk cannot bypass the cold-room paid check.
  await writeFile(thumbPath, thumbnail);
  await start();
  assert.equal((await fetchThumbnail()).status, 404);
  assert.equal((await painter(secondRoom, 'friend')).connected.hasSheet, false, 'an offline room also hides the outline after expiry');
  assert.equal((await api(activeSheet, 'friend')).status, 404);
  await stop();
  await writeFile(join(dir, '.billing.json'), JSON.stringify({ version: 2, records: { other: subscriptions.other } }));
  await start();
  const renewedGuest = await painter(secondRoom, 'friend');
  await renewedGuest.message(e => e.type === 'sheet' && e.sheetId === first.body.id);
  assert.equal((await api(activeSheet, 'friend')).body.image, first.body.image, 'renewal restores the purchased room’s original sheet');
  const beforeClosing = await api(bookPath, 'other');
  assert.equal(beforeClosing.body.total, 2);
  const closed = await fetch(base + '/api/admin/rooms/' + secondRoom + '/delete', { method: 'POST', headers: { 'x-admin-key': adminKey } });
  assert.equal(closed.status, 200);
  await stop();
  await start(true, false); // Archive survives both room closure and a disabled provider.
  assert.equal((await api(bookPath, 'other')).body.total, 2);
  assert.equal((await bookImage('/' + first.body.id + '/image', 'other')).status, 200);
  assert.equal((await bookImage('/' + first.body.id + '/versions/' + keep.body.id + '/image', 'other')).status, 200);
  assert.equal((await api(secondVersionApi, 'other', keepData, keepKey)).body.id, keep.body.id, 'a delayed retry after room closure recovers the saved version');
  assert.equal((await api('/api/account/scrub-chat', 'other', {})).status, 200);
  assert.equal((await (await admin('?status=all&room=' + secondRoom)).json()).total, 0);
  assert.equal(calls.length, 0, 'restoring a purchased page is free');
  console.log('Jam Pass coloring passed for private books, saved versions, room reuse and closure, Stripe access, moderation, quota, restart and erasure.');
} finally {
  await stop();
  if (mock.listening) await new Promise(resolve => mock.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
