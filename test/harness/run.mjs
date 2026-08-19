/* eslint-env node */
// Node WebSocket + REST integration harness for drawesome.art (happypaint).
//
//   node test/harness/run.mjs
//
// Boots the real server.js as a child process with a hermetic, throwaway
// DATA_DIR (under os.tmpdir) and PB_URL pointed at a tiny mock PocketBase, on an
// ephemeral port. Then it runs each scenario from the moderation contract
// (docs/CONTENT_MODERATION.md) against the live server, prints PASS/FAIL per
// scenario, and exits non-zero if any scenario failed.
//
// IMPORTANT: several scenarios describe server behavior that is NOT built yet
// (audience gating, POST /api/rooms, opId, text moderation, mod_hide/restore/
// remove, watcher election + corroboration). They are written to define the
// contract and are designed to FAIL LOUDLY (with a clear reason) until the
// server work lands — never to pass silently. A scenario whose endpoint 404s
// reports FAIL with the reason, it does not throw and abort the suite.

import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { createServer } from 'http';

import { startMockPocketbase } from './mockPocketbase.mjs';
import { SimClient } from './client.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const SERVER_ENTRY = join(REPO_ROOT, 'server.js');

// ---- helpers ---------------------------------------------------------------

function pickEphemeralPort() {
  // Ask the OS for a free port, then immediately release it. There is a tiny
  // race window before the server grabs it; acceptable for a local harness.
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Minimal JSON fetch wrapper that never throws on a non-2xx — returns
// { status, body, ok, networkError? } so scenarios can assert on status codes
// (e.g. expect 401/403) and treat a 404 as "feature missing" -> clear FAIL.
async function api(baseHttp, path, { method = 'GET', token, body, adminKey } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (adminKey) headers['x-admin-key'] = adminKey;
  try {
    const res = await fetch(`${baseHttp}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = null;
    const text = await res.text();
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, ok: res.ok };
  } catch (err) {
    return { status: 0, body: null, ok: false, networkError: err.message };
  }
}

// Wait until the server answers /healthz, or throw after a deadline.
async function waitForHealth(baseHttp, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(baseHttp, '/healthz');
    if (r.ok && r.body && r.body.ok) return;
    await sleep(150);
  }
  throw new Error('server did not become healthy in time');
}

// ---- scenario registry -----------------------------------------------------

const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// Each scenario receives a context { baseHttp, baseWs, adminKey, signedInToken }
// and either returns (PASS) or throws an Error (FAIL). Assertion failures and
// "feature missing" both surface as a thrown Error with a readable message.

// A: Audience gating — friends room hidden from public discovery; kid_safe shown.
scenario('A. Audience gating: kid_safe listed, friends not', async (ctx) => {
  // Create a kid_safe (public) room as a signed-in grown-up.
  const made = await api(ctx.baseHttp, '/api/rooms', {
    method: 'POST',
    token: ctx.signedInToken,
    body: { audience: 'kid_safe', title: 'Public Fingerpaints', listed: true },
  });
  if (made.status === 404) throw new Error('POST /api/rooms not implemented (404) — audience gating cannot be verified');
  assert.strictEqual(made.status, 200, `expected 200 creating kid_safe room, got ${made.status}`);
  assert.ok(made.body && typeof made.body.code === 'string', 'create should return { code }');
  const kidCode = made.body.code;

  // Discovery only surfaces rooms with at least one live participant (an empty,
  // freshly-created room is correctly omitted), so a painter must actually be in
  // the kid_safe room for it to appear. Keep the socket open across the assert.
  const kidPainter = new SimClient(ctx.baseWs, { room: kidCode, token: ctx.signedInToken, name: 'kidPainter' });
  await kidPainter.connect();

  // Create a friends room (private). Lazy-create via WS join is the documented
  // path for friends rooms, so reach it by code over WS. Keep this socket open
  // too, so the only reason it could be hidden is its audience — not emptiness.
  const friendsCode = 'FRNDS1';
  const friend = new SimClient(ctx.baseWs, { room: friendsCode, name: 'friend' });
  await friend.connect();
  await friend.sendOp({ kind: 'draw', strokeId: 's1', points: [[1, 1], [2, 2]] });
  await sleep(150);

  try {
    const pub = await api(ctx.baseHttp, '/api/rooms/public');
    if (pub.status === 404) throw new Error('GET /api/rooms/public not implemented (404)');
    assert.strictEqual(pub.status, 200, `expected 200 from public discovery, got ${pub.status}`);
    const list = (pub.body && pub.body.rooms) || [];
    const codes = list.map((r) => r.code);
    assert.ok(codes.includes(kidCode), `kid_safe room ${kidCode} should appear in public list (got ${JSON.stringify(codes)})`);
    assert.ok(!codes.includes(friendsCode), `friends room ${friendsCode} must NOT appear in public list`);
    // Sanitized shape: never leak owner ids / names / raw strokes. Allowlist of
    // safe metadata (counts, emoji, prompt strings) — anything new must be
    // reviewed here before it ships in discovery.
    const allowed = new Set(['code', 'emoji', 'featured', 'hasHost', 'lastActivity', 'ops', 'prompt', 'sheetId', 'title', 'users']);
    for (const r of list) {
      for (const key of Object.keys(r)) {
        assert.ok(allowed.has(key), `public room entry leaked an unreviewed key "${key}" (${JSON.stringify(Object.keys(r).sort())})`);
      }
      assert.ok(typeof r.users === 'number', 'users must be a headcount, not a roster');
      assert.ok(r.ops === undefined || typeof r.ops === 'number', 'ops must be a count, not stroke data');
    }
  } finally {
    await kidPainter.close();
    await friend.close();
  }
});

// B: POST /api/rooms auth + audience rules.
scenario('B. POST /api/rooms: anon kid_safe 401, signed-in 200, adult_18 403', async (ctx) => {
  const anon = await api(ctx.baseHttp, '/api/rooms', {
    method: 'POST',
    body: { audience: 'kid_safe', title: 'Anon try', listed: true },
  });
  if (anon.status === 404) throw new Error('POST /api/rooms not implemented (404)');
  assert.strictEqual(anon.status, 401, `anonymous kid_safe create must be 401, got ${anon.status}`);

  const signed = await api(ctx.baseHttp, '/api/rooms', {
    method: 'POST',
    token: ctx.signedInToken,
    body: { audience: 'kid_safe', title: 'Signed try', listed: true },
  });
  assert.strictEqual(signed.status, 200, `signed-in kid_safe create must be 200, got ${signed.status}`);
  assert.ok(signed.body && signed.body.code, 'signed-in create returns { code }');

  const adult = await api(ctx.baseHttp, '/api/rooms', {
    method: 'POST',
    token: ctx.signedInToken,
    body: { audience: 'adult_18', title: 'Nope', listed: false },
  });
  assert.strictEqual(adult.status, 403, `adult_18 create must be 403, got ${adult.status}`);
});

// C: Ops carry a monotonic, server-assigned opId.
scenario('C. Ops carry a monotonic opId', async (ctx) => {
  // Two clients in one room: A draws, B observes the broadcast opIds.
  const a = new SimClient(ctx.baseWs, { room: 'OPIDS1', name: 'A' });
  const b = new SimClient(ctx.baseWs, { room: 'OPIDS1', name: 'B' });
  await a.connect();
  await b.connect();
  try {
    a.sendOp({ kind: 'draw', strokeId: 'sa', points: [[0, 0]] });
    a.sendOp({ kind: 'shape', shape: 'rect', x: 1, y: 1 });
    a.sendOp({ kind: 'text', text: 'hi', x: 2, y: 2 });

    // B should receive three 'op' frames, each with an integer opId, strictly
    // increasing in send order.
    const seen = [];
    await b.waitFor((m) => {
      if (m.type === 'op') seen.push(m);
      return seen.length >= 3;
    }, { timeoutMs: 3000, label: 'three op broadcasts with opId' });

    const ids = seen.map((m) => m.op && m.op.opId);
    for (const id of ids) {
      assert.strictEqual(typeof id, 'number', `each op must carry a numeric opId (got ${JSON.stringify(ids)})`);
      assert.ok(Number.isInteger(id), `opId must be an integer (got ${id})`);
    }
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok(ids[i] > ids[i - 1], `opId must be monotonically increasing (got ${JSON.stringify(ids)})`);
    }
  } finally {
    await a.close();
    await b.close();
  }
});

// D: Text moderation — severe text blocked + auto-report + mod_alert in kid_safe;
//    NOT moderated in a friends room.
scenario('D. Text moderation: kid_safe blocks+reports+alerts, friends does not', async (ctx) => {
  // A kid_safe room owned by a signed-in host so a mod_alert has a recipient.
  const made = await api(ctx.baseHttp, '/api/rooms', {
    method: 'POST',
    token: ctx.signedInToken,
    body: { audience: 'kid_safe', title: 'Moderated', listed: true },
  });
  if (made.status === 404) throw new Error('POST /api/rooms not implemented (404) — cannot stand up a kid_safe room for moderation');
  assert.strictEqual(made.status, 200, `kid_safe create must be 200, got ${made.status}`);
  const kidCode = made.body.code;

  // The signed-in owner connects (host -> receives mod_alert). A second
  // anonymous painter posts a severe chat message.
  const host = new SimClient(ctx.baseWs, { room: kidCode, token: ctx.signedInToken, name: 'host' });
  const painter = new SimClient(ctx.baseWs, { room: kidCode, name: 'painter' });
  await host.connect();
  await painter.connect();

  const reportsBefore = await api(ctx.baseHttp, '/api/admin/reports', { adminKey: ctx.adminKey });
  const countBefore = (reportsBefore.body && reportsBefore.body.reports ? reportsBefore.body.reports.length : 0);

  try {
    // A severe slur in chat must be dropped (host must NOT receive the chat) and
    // must produce an auto-report + a mod_alert to the host.
    const SEVERE = 'you are a fucking idiot retard'; // contains a severe term per the contract's list
    painter.sendChat(SEVERE);

    // Host should get a mod_alert (source 'auto').
    await host.waitFor(
      (m) => m.type === 'mod_alert' && m.source === 'auto',
      { timeoutMs: 3000, label: 'mod_alert{source:auto} to host for severe chat' },
    );

    // Host must NOT have received the severe chat message itself.
    await sleep(200);
    const leaked = host.all('chat').some((m) => m.message && m.message.includes('retard'));
    assert.ok(!leaked, 'severe chat must be dropped, not broadcast to the room');

    // An auto-report must have been created (source 'auto').
    const reportsAfter = await api(ctx.baseHttp, '/api/admin/reports', { adminKey: ctx.adminKey });
    assert.ok(reportsAfter.ok, 'GET /api/admin/reports should be reachable');
    const list = (reportsAfter.body && reportsAfter.body.reports) || [];
    assert.ok(list.length > countBefore, 'a severe hit must create a new auto-report');
    assert.ok(
      list.some((r) => r.source === 'auto' && String(r.room).toUpperCase() === kidCode),
      'the new report must be source:auto for the offending room',
    );
  } finally {
    await host.close();
    await painter.close();
  }

  // Friends rooms run the SEVERE tier too (slurs are blocked in EVERY room);
  // only the softer MILD masking stays kid_safe-only, so ordinary salty talk
  // between friends still flows verbatim.
  const friendsCode = 'FRNDMOD';
  const fa = new SimClient(ctx.baseWs, { room: friendsCode, name: 'fa' });
  const fb = new SimClient(ctx.baseWs, { room: friendsCode, name: 'fb' });
  await fa.connect();
  await fb.connect();
  try {
    // SEVERE: dropped — the sender gets chat_blocked, the peer never sees it.
    fa.sendChat('you are a fucking idiot retard');
    await fa.waitFor(
      (m) => m.type === 'chat_blocked',
      { timeoutMs: 2500, label: 'chat_blocked receipt for severe chat in friends room' },
    );
    await sleep(200);
    const leakedToPeer = fb.all('chat').some((m) => m.message && m.message.includes('retard'));
    assert.ok(!leakedToPeer, 'severe chat must be dropped in friends rooms too');

    // MILD: delivered VERBATIM (no masking outside kid_safe).
    fa.sendChat('well damn that drawing is good');
    await fb.waitFor(
      (m) => m.type === 'chat' && typeof m.message === 'string' && m.message.includes('damn'),
      { timeoutMs: 2500, label: 'mild chat delivered unmasked in friends room' },
    );
  } finally {
    await fa.close();
    await fb.close();
  }
});

// E: mod_hide hides ops from replay; mod_restore brings them back; mod_remove
//    is permanent.
scenario('E. mod_hide/restore/remove by opId', async (ctx) => {
  const made = await api(ctx.baseHttp, '/api/rooms', {
    method: 'POST',
    token: ctx.signedInToken,
    body: { audience: 'kid_safe', title: 'Hideable', listed: true },
  });
  if (made.status === 404) throw new Error('POST /api/rooms not implemented (404) — cannot stand up an owned room for hide/restore');
  assert.strictEqual(made.status, 200, `kid_safe create must be 200, got ${made.status}`);
  const code = made.body.code;

  // Host (owner) draws three ops and captures their opIds.
  const host = new SimClient(ctx.baseWs, { room: code, token: ctx.signedInToken, name: 'host' });
  await host.connect();
  const observer = new SimClient(ctx.baseWs, { room: code, name: 'observer' });
  await observer.connect();

  try {
    host.sendOp({ kind: 'draw', strokeId: 'h1', points: [[0, 0]] });
    host.sendOp({ kind: 'draw', strokeId: 'h2', points: [[1, 1]] });
    host.sendOp({ kind: 'draw', strokeId: 'h3', points: [[2, 2]] });

    const seen = [];
    await observer.waitFor((m) => {
      if (m.type === 'op') seen.push(m);
      return seen.length >= 3;
    }, { timeoutMs: 3000, label: 'three ops broadcast' });
    const opIds = seen.map((m) => m.op.opId);
    assert.ok(opIds.every((id) => typeof id === 'number'), 'ops need numeric opIds for hide/restore');
    const target = opIds[1]; // hide the middle op

    // Host hides the middle op. A fresh joiner must replay history WITHOUT it.
    host.modHide([target]);
    await sleep(200);

    const joiner1 = new SimClient(ctx.baseWs, { room: code, name: 'joiner1' });
    await joiner1.connect();
    const hist1 = await joiner1.waitFor((m) => m.type === 'history', { timeoutMs: 2500, label: 'history on join (after hide)' });
    const ids1 = (hist1.ops || []).map((o) => o.opId);
    assert.ok(!ids1.includes(target), `hidden op ${target} must be absent from replayed history (got ${JSON.stringify(ids1)})`);
    await joiner1.close();

    // Restore it — a fresh joiner sees it again.
    host.modRestore([target]);
    await sleep(200);
    const joiner2 = new SimClient(ctx.baseWs, { room: code, name: 'joiner2' });
    await joiner2.connect();
    const hist2 = await joiner2.waitFor((m) => m.type === 'history', { timeoutMs: 2500, label: 'history on join (after restore)' });
    const ids2 = (hist2.ops || []).map((o) => o.opId);
    assert.ok(ids2.includes(target), `restored op ${target} must reappear in replayed history (got ${JSON.stringify(ids2)})`);
    await joiner2.close();

    // Remove it permanently — restore can no longer bring it back.
    host.modRemove([target]);
    await sleep(150);
    host.modRestore([target]);
    await sleep(200);
    const joiner3 = new SimClient(ctx.baseWs, { room: code, name: 'joiner3' });
    await joiner3.connect();
    const hist3 = await joiner3.waitFor((m) => m.type === 'history', { timeoutMs: 2500, label: 'history on join (after remove)' });
    const ids3 = (hist3.ops || []).map((o) => o.opId);
    assert.ok(!ids3.includes(target), `permanently removed op ${target} must NOT come back after restore (got ${JSON.stringify(ids3)})`);
    await joiner3.close();
  } finally {
    await host.close();
    await observer.close();
  }
});

// F: Watcher election + flag corroboration.
//    - a capable client is elected watcher_role{active:true}
//    - a single flag does NOT auto-hide (Tier 1 only)
//    - two independent watcher flags (or 1 flag + 1 human report) DO hide (Tier 2)
//    - no automatic kick ever happens.
scenario('F. Watcher election + flag corroboration (Tier 2, never auto-kick)', async (ctx) => {
  const made = await api(ctx.baseHttp, '/api/rooms', {
    method: 'POST',
    token: ctx.signedInToken,
    body: { audience: 'kid_safe', title: 'Watched', listed: true },
  });
  if (made.status === 404) throw new Error('POST /api/rooms not implemented (404) — cannot stand up a kid_safe room for watcher tests');
  assert.strictEqual(made.status, 200, `kid_safe create must be 200, got ${made.status}`);
  const code = made.body.code;

  // Host owns the room; two "capable" watcher clients join and ack capable.
  // They sign in with DISTINCT identities: corroboration now counts distinct
  // people (profileId, else IP), not distinct sockets, so two loopback guests
  // would (correctly) collapse to one flagger.
  const host = new SimClient(ctx.baseWs, { room: code, token: ctx.signedInToken, name: 'host' });
  await host.connect();
  const w1 = new SimClient(ctx.baseWs, { room: code, token: 'tok_watcher1', name: 'w1' });
  const w2 = new SimClient(ctx.baseWs, { room: code, token: 'tok_watcher2', name: 'w2' });
  await w1.connect();
  await w2.connect();

  try {
    // Election: at least one client must be told it is an active watcher.
    w1.watcherAck(true);
    w2.watcherAck(true);
    const role1 = await w1.waitFor(
      (m) => m.type === 'watcher_role' && m.active === true,
      { timeoutMs: 3000, label: 'watcher_role{active:true} for a capable client' },
    );
    assert.ok(typeof role1.intervalMs === 'number', 'watcher_role should carry an intervalMs');
    assert.ok(typeof role1.maxDim === 'number', 'watcher_role should carry a maxDim');

    // Someone draws an op we can implicate via a flag range.
    host.sendOp({ kind: 'image', src: 'data:image/png;base64,AAAA', x: 0, y: 0 });
    const opMsg = await w1.waitFor((m) => m.type === 'op' && m.op.kind === 'image', { timeoutMs: 2500, label: 'image op broadcast' });
    const toOpId = opMsg.op.opId;
    const sinceOpId = Math.max(0, toOpId - 1);

    // --- Single flag: Tier 1 only (alert), NOT Tier 2 (no hide). ---
    w1.flag({ kind: 'image', score: 0.95, sinceOpId, toOpId });
    // Host should get an alert, but NOT an auto-hide yet.
    await host.waitFor((m) => m.type === 'mod_alert', { timeoutMs: 3000, label: 'Tier1 mod_alert on first flag' });
    await sleep(300);
    const joinerSingle = new SimClient(ctx.baseWs, { room: code, name: 'joinerSingle' });
    await joinerSingle.connect();
    const histA = await joinerSingle.waitFor((m) => m.type === 'history', { timeoutMs: 2500, label: 'history after single flag' });
    const idsA = (histA.ops || []).map((o) => o.opId);
    assert.ok(idsA.includes(toOpId), `a single flag must NOT auto-hide op ${toOpId} (Tier 1 only); history was ${JSON.stringify(idsA)}`);
    await joinerSingle.close();

    // --- Second independent watcher flag: Tier 2 -> the op is hidden. ---
    w2.flag({ kind: 'image', score: 0.93, sinceOpId, toOpId });
    await sleep(400);
    const joinerCorr = new SimClient(ctx.baseWs, { room: code, name: 'joinerCorr' });
    await joinerCorr.connect();
    const histB = await joinerCorr.waitFor((m) => m.type === 'history', { timeoutMs: 2500, label: 'history after corroborating flag' });
    const idsB = (histB.ops || []).map((o) => o.opId);
    assert.ok(!idsB.includes(toOpId), `two independent watcher flags must hide op ${toOpId} (Tier 2); history was ${JSON.stringify(idsB)}`);
    await joinerCorr.close();

    // --- Never auto-kick: no client should have received a 'kicked' frame, and
    //     no socket should have been force-closed with the kick code. ---
    const anyKicked = [host, w1, w2].some((c) => c.all('kicked').length > 0);
    assert.ok(!anyKicked, 'corroborated flags must never auto-kick (Tier 3 is manual only)');
    assert.ok(!w1.closed && !w2.closed && !host.closed, 'no watcher/host socket should be force-closed by moderation');
  } finally {
    await host.close();
    await w1.close();
    await w2.close();
  }
});

// ---- runner ----------------------------------------------------------------

async function main() {
  const port = await pickEphemeralPort();
  const baseHttp = `http://127.0.0.1:${port}`;
  const baseWs = `ws://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'happypaint-harness-'));
  const adminKey = 'harness-admin-key';
  const signedInToken = 'tok_grownup1'; // resolves to profileId "grownup1" in the mock

  const mock = await startMockPocketbase();

  // Boot the real server with a hermetic environment.
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      PB_URL: mock.url,
      ADMIN_KEY: adminKey,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const serverLog = [];
  child.stdout.on('data', (d) => serverLog.push(`[server] ${d.toString().trimEnd()}`));
  child.stderr.on('data', (d) => serverLog.push(`[server:err] ${d.toString().trimEnd()}`));
  let exited = false;
  let exitInfo = null;
  child.on('exit', (codeNum, sig) => { exited = true; exitInfo = { codeNum, sig }; });

  const results = [];
  let healthOk = false;
  try {
    await waitForHealth(baseHttp, { timeoutMs: 12000 });
    healthOk = true;
  } catch (err) {
    results.push({ name: '(server boot)', ok: false, reason: err.message });
  }

  if (healthOk) {
    const ctx = { baseHttp, baseWs, adminKey, signedInToken };
    for (const s of scenarios) {
      const started = Date.now();
      try {
        await s.fn(ctx);
        results.push({ name: s.name, ok: true, ms: Date.now() - started });
      } catch (err) {
        results.push({ name: s.name, ok: false, ms: Date.now() - started, reason: err.message });
      }
    }
  }

  // ---- teardown ----
  await mock.close().catch(() => {});
  if (!exited) {
    child.kill('SIGTERM');
    // Give it a moment, then SIGKILL if still alive.
    for (let i = 0; i < 20 && !exited; i += 1) await sleep(50);
    if (!exited) child.kill('SIGKILL');
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ---- summary ----
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const line = '─'.repeat(72);
  process.stdout.write(`\n${line}\n  drawesome.art WS/REST integration harness\n${line}\n`);
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    const ms = r.ms !== undefined ? ` (${r.ms}ms)` : '';
    process.stdout.write(`  [${tag}] ${r.name}${ms}\n`);
    if (!r.ok && r.reason) {
      process.stdout.write(`         ↳ ${r.reason}\n`);
    }
  }
  process.stdout.write(`${line}\n  ${pass} passed, ${fail} failed, ${results.length} total\n${line}\n`);

  if (fail > 0) {
    // Surface server output on failure — invaluable when a feature is missing.
    if (serverLog.length) {
      process.stdout.write('\n  --- server output (tail) ---\n');
      process.stdout.write(serverLog.slice(-25).map((l) => `  ${l}`).join('\n'));
      process.stdout.write('\n');
    }
    if (exitInfo && exitInfo.codeNum) {
      process.stdout.write(`\n  server exited early: code ${exitInfo.codeNum} sig ${exitInfo.sig}\n`);
    }
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`harness crashed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
