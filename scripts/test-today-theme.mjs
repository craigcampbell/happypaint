import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const dataDir = await mkdtemp(join(tmpdir(), 'drawesome-theme-data-'));
const libraryDir = await mkdtemp(join(tmpdir(), 'drawesome-theme-library-'));
await mkdir(join(libraryDir, 'full'));
await mkdir(join(libraryDir, 'thumbs'));
await writeFile(join(libraryDir, 'index.json'), JSON.stringify({
  count: 2,
  sheets: [
    { id: 'friendly-dragon', title: 'Friendly Dragon', q: 'friendly dragon fantasy', cats: ['fantasy'] },
    { id: 'happy-butterfly', title: 'Happy Butterfly', q: 'happy butterfly nature', cats: ['nature'] },
  ],
}));

const port = 19800 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    COLORING_DIR: libraryDir,
    PB_URL: '',
    ADMIN_KEY: 'test-admin-key',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRODUCT_FAMILY: '',
    STRIPE_PRICE_FAMILY_MONTHLY: '',
    STRIPE_PRICE_FAMILY_YEARLY: '',
    STRIPE_PORTAL_CONFIGURATION_ID: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${stderr}`);
}

function setTheme(sheetId, key = 'test-admin-key') {
  return fetch(`http://127.0.0.1:${port}/api/admin/sheet-theme`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify({ sheetId }),
  });
}

try {
  await waitForServer();
  const initial = await fetch(`http://127.0.0.1:${port}/api/coloring-sheets/today`);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.ok((await initial.json()).sheet, 'automatic daily pick works');

  const badRoom = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audience: 'friends', sheetId: 'lib:not-real' }),
  });
  assert.equal(badRoom.status, 400, 'new rooms reject invented coloring sheets');

  const room = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audience: 'friends', sheetId: 'lib:friendly-dragon' }),
  }).then((response) => response.json());
  assert.equal(room.sheetId, 'lib:friendly-dragon', 'a private room can start on a library sheet');
  const joinedSheet = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room.code}`);
    const timer = setTimeout(() => reject(new Error('sheet join timeout')), 4000);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'sheet') {
        clearTimeout(timer);
        socket.close();
        resolve(message.sheetId);
      }
    });
    socket.on('error', reject);
  });
  assert.equal(joinedSheet, 'lib:friendly-dragon', 'invitees receive the starting sheet on join');

  assert.equal((await setTheme('friendly-dragon', 'wrong-key')).status, 401, 'theme controls are admin-only');
  assert.equal((await setTheme('../not-real')).status, 400, 'unknown sheet ids are rejected');

  const selected = await setTheme('happy-butterfly');
  assert.equal(selected.status, 200);
  assert.deepEqual((await selected.json()).sheet, { id: 'happy-butterfly', title: 'Happy Butterfly' });
  const today = await fetch(`http://127.0.0.1:${port}/api/coloring-sheets/today`).then((response) => response.json());
  assert.equal(today.source, 'admin');
  assert.equal(today.sheet.id, 'happy-butterfly');

  assert.equal((await setTheme(null)).status, 200, 'admin can restore automatic rotation');
  const automatic = await fetch(`http://127.0.0.1:${port}/api/coloring-sheets/today`).then((response) => response.json());
  assert.notEqual(automatic.source, 'admin');

  console.log('today theme integration: ok');
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
  await rm(libraryDir, { recursive: true, force: true });
}
