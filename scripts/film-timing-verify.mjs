// Film timing regression (stage 1 of minutes-long films): frame holds up to
// 10s, per-scene loop counts and camera moves, and the shared film plan that
// playback + both exporters walk. Isolated server (temp DATA_DIR).
//   node scripts/film-timing-verify.mjs
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SimClient } from '../test/harness/client.mjs';
import { buildFilmPlan, cameraWindow, clampHold, filmRuntimeMs, formatHold, formatRuntime, holdStepIndex, HOLD_STEPS, MAX_FRAME_MS } from '../src/utils/filmPlan.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let assertions = 0;
function check(name, value, detail = '') {
  assert.ok(value, `${name}${detail ? ` — ${detail}` : ''}`);
  assertions += 1;
  console.log(`PASS ${name}`);
}

// ---- pure plan maths ----------------------------------------------------------
{
  const scenes = [
    { id: 's0', loops: 3, camera: 'pan-right', frames: [{ id: 'a', durationMs: 100 }, { id: 'b', durationMs: 300 }] },
    { id: 's1', loops: 1, camera: 'none', frames: [{ id: 'c', durationMs: 10000 }] },
  ];
  const plan = buildFilmPlan(scenes);
  check('plan expands loops in order', plan.map((p) => p.frameId).join('') === 'ababab' + 'c');
  check('plan runtime = frames × loops + holds', plan.reduce((s, p) => s + p.durationMs, 0) === 3 * 400 + 10000 && filmRuntimeMs(scenes) === 11200);
  check('camera progress spans the whole looped scene', plan[0].cameraT0 === 0 && Math.abs(plan[5].cameraT1 - 1) < 1e-9 && plan[2].cameraT0 > plan[1].cameraT0);
  check('a pan glides its window across the picture', cameraWindow('pan-right', 0).x === 0 && Math.abs(cameraWindow('pan-right', 1).x - 0.25) < 1e-9 && cameraWindow('none', 0.5).w === 1);
  check('zoom-in ends on the centre crop', Math.abs(cameraWindow('zoom-in', 1).w - 0.55) < 1e-9);
  check('holds clamp to 40..10000ms', clampHold(5) === 40 && clampHold(99999) === MAX_FRAME_MS && clampHold('x') === 120);
  check('hold slider steps round-trip', HOLD_STEPS[holdStepIndex(333)] === 330 && formatHold(10000) === '10s' && formatHold(120) === '120ms' && formatRuntime(11200) === '11s' && formatRuntime(125000) === '2:05');
}

// ---- server -------------------------------------------------------------------
async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}
const scratch = mkdtempSync(join(tmpdir(), 'drawesome-film-'));
const wrapper = join(scratch, 'fixture.mjs');
writeFileSync(wrapper, `await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server.js')).href)});`);
const port = await freePort();
const child = fork(wrapper, [], {
  cwd: ROOT, silent: true, windowsHide: true,
  env: {
    ...process.env, PORT: String(port), DATA_DIR: scratch, ROOM_DIR: join(scratch, '.rooms'),
    ARTWORK_DIR: join(scratch, '.artworks'), CHAT_LOG_DIR: join(scratch, '.chatlog'), PB_URL: '', POCKETBASE_URL: '',
    ADMIN_KEY: 'isolated-film-test', AUTO_CLOSE: 'off', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_CHECKOUT_ENABLED: 'false',
  },
});
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });
const exited = once(child, 'exit');
const clients = [];
try {
  let ready = false;
  for (let i = 0; i < 150 && !ready; i += 1) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { /* starting */ }
    if (!ready) await sleep(40);
  }
  assert.ok(ready, `server ready: ${logs}`);
  const connect = async (room) => {
    const c = new SimClient(`ws://127.0.0.1:${port}`, { room });
    clients.push(c);
    await c.connect();
    await c.waitFor((m) => m.type === 'history', { timeoutMs: 5000 });
    return c;
  };
  // Private room: first member is the guest host → can enable animation + manage scenes.
  const host = await connect('ZZFILM');
  const guest = await connect('ZZFILM');
  host.send({ type: 'set_animation', enabled: true });
  await host.waitFor((m) => m.type === 'animation_state' || m.type === 'resync' || m.type === 'history', { timeoutMs: 4000, label: 'animation on' });
  await sleep(300);
  host.send({ type: 'scene_add' });
  const added = await host.waitFor((m) => m.type === 'scene_add', { timeoutMs: 4000, label: 'scene_add' });
  check('a new scene carries default timing', added.scene.loops === 1 && added.scene.camera === 'none' && added.scenes.every((s) => 'loops' in s && 'camera' in s));
  const sceneId = added.scene.id;
  const frameId = added.scenes.find((s) => s.id === sceneId).frames[0].id;

  host.send({ type: 'frame_duration', frameId, durationMs: 99999 });
  const dur = await guest.waitFor((m) => m.type === 'frame_duration' && m.frameId === frameId, { timeoutMs: 4000, label: 'frame_duration' });
  check('frame holds accept up to 10s (clamped)', dur.durationMs === 10000);

  host.send({ type: 'scene_set', sceneId, loops: 7, camera: 'zoom-in' });
  const set = await guest.waitFor((m) => m.type === 'scene_set' && m.sceneId === sceneId, { timeoutMs: 4000, label: 'scene_set' });
  const meta = set.scenes.find((s) => s.id === sceneId);
  check('scene_set relays loops + camera to everyone', meta.loops === 7 && meta.camera === 'zoom-in');

  host.send({ type: 'scene_set', sceneId, loops: 500, camera: 'spin' });
  const clamped = await guest.waitFor((m) => m.type === 'scene_set' && m.sceneId === sceneId && m.scenes.find((s) => s.id === sceneId).loops === 20, { timeoutMs: 4000, label: 'clamped scene_set' });
  check('loops clamp to 20 and unknown cameras fall back to still', clamped.scenes.find((s) => s.id === sceneId).camera === 'none');

  guest.send({ type: 'scene_set', sceneId, loops: 2 });
  await sleep(500);
  check('a non-host cannot change scene timing', !guest.messages.some((m) => m.type === 'scene_set' && m.scenes.find((s) => s.id === sceneId).loops === 2));

  // A joiner's scene history carries the timing; the /film payload too.
  const late = await connect('ZZFILM');
  const hist = late.messages.find((m) => m.type === 'history');
  const lateMeta = hist.scenes.find((s) => s.id === sceneId);
  check('late joiner receives scene loops + camera in the history frame', lateMeta.loops === 20 && lateMeta.frames[0].durationMs === 10000);
  const film = await (await fetch(`http://127.0.0.1:${port}/api/rooms/ZZFILM/film`)).json();
  check('/film exposes the same timing for exports', film.scenes.find((s) => s.id === sceneId).loops === 20);
  check('film plan from /film honours the 10s hold × 20 loops', buildFilmPlan(film.scenes).filter((p) => p.sceneId === sceneId).reduce((s, p) => s + p.durationMs, 0) === 200000);

  // Stage 2: private rooms allow 60 frames per scene (cold frames client-side);
  // the handshake tells the strip the cap.
  check('handshake carries the per-scene frame cap', host.connected.animMaxFrames === 60);
  let sceneNow = null;
  for (let i = 0; i < 12; i += 1) {
    host.send({ type: 'frame_add', afterFrameId: null, duplicateOf: null, sceneId });
    // waitFor scans from the start of the mailbox, so match on the frame COUNT.
    const echo = await host.waitFor((m) => m.type === 'frame_add' && m.scenes.find((s) => s.id === sceneId)?.frames.length === i + 2, { timeoutMs: 4000, label: `frame_add ${i}` });
    sceneNow = echo.scenes.find((s) => s.id === sceneId);
  }
  check('a private scene grows past the old 8-frame cap', sceneNow.frames.length === 13, `${sceneNow.frames.length} frames`);

  // Stage 4: soundtrack upload (host/member gate, sniffed, served, persisted meta).
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0); wavHeader.writeUInt32LE(36 + 4800, 4); wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12); wavHeader.writeUInt32LE(16, 16); wavHeader.writeUInt16LE(1, 20); wavHeader.writeUInt16LE(1, 22);
  wavHeader.writeUInt32LE(8000, 24); wavHeader.writeUInt32LE(16000, 28); wavHeader.writeUInt16LE(2, 32); wavHeader.writeUInt16LE(16, 34);
  wavHeader.write('data', 36); wavHeader.writeUInt32LE(4800, 40);
  const wav = Buffer.concat([wavHeader, Buffer.alloc(4800)]);
  const wavDataUrl = `data:audio/wav;base64,${wav.toString('base64')}`;
  host.send({ type: 'set_soundtrack', audio: `data:audio/wav;base64,${Buffer.from('definitely not audio bytes here!!').toString('base64')}`, name: 'junk.wav', durationMs: 1000 });
  const rejected = await host.waitFor((m) => m.type === 'soundtrack_rejected', { timeoutMs: 4000, label: 'junk rejected' });
  check('non-audio bytes are refused by the magic-byte sniff', rejected.reason === 'not_audio');
  guest.send({ type: 'set_soundtrack', audio: wavDataUrl, name: 'guest.wav', durationMs: 300 });
  await sleep(400);
  check('a private-room member may set the soundtrack too', guest.messages.some((m) => m.type === 'soundtrack' && m.soundtrack?.name === 'guest'), JSON.stringify(guest.messages.filter((m) => /soundtrack/.test(m.type)).slice(-3)));
  host.send({ type: 'set_soundtrack', audio: wavDataUrl, name: 'Ocean Song.wav', durationMs: 300 });
  const setSound = await guest.waitFor((m) => m.type === 'soundtrack' && m.soundtrack?.name === 'Ocean Song', { timeoutMs: 4000, label: 'soundtrack set' });
  check('soundtrack meta relays to everyone (name minus extension, sniffed mime)', setSound.soundtrack.mime === 'audio/wav' && setSound.soundtrack.durationMs === 300 && /^snd_[a-f0-9]{24}$/.test(setSound.soundtrack.id));
  const served = await fetch(`http://127.0.0.1:${port}/api/audio/${setSound.soundtrack.id}`);
  const servedBytes = served.ok ? (await served.arrayBuffer()).byteLength : -1;
  check('/api/audio serves the bytes with the sniffed content type', served.ok && served.headers.get('content-type').startsWith('audio/wav') && servedBytes === wav.length, `status ${served.status} type ${served.headers.get('content-type')} bytes ${servedBytes}/${wav.length}`);
  const later = await connect('ZZFILM');
  check('a later joiner gets the soundtrack in the handshake', later.connected.soundtrack?.id === setSound.soundtrack.id);
  const filmWithSound = await (await fetch(`http://127.0.0.1:${port}/api/rooms/ZZFILM/film`)).json();
  check('/film carries the soundtrack for production exports', filmWithSound.soundtrack?.id === setSound.soundtrack.id);
  host.send({ type: 'set_soundtrack', audio: null });
  await guest.waitFor((m) => m.type === 'soundtrack' && m.soundtrack === null, { timeoutMs: 4000, label: 'soundtrack removed' });
  check('removing the soundtrack deletes the served file', (await fetch(`http://127.0.0.1:${port}/api/audio/${setSound.soundtrack.id}`)).status === 404);
  // Hostless public FLIPBOOK: nobody is an accountable uploader.
  const flip = await connect('FLIPBOOK');
  flip.send({ type: 'set_soundtrack', audio: wavDataUrl, name: 'nope.wav', durationMs: 300 });
  await sleep(400);
  check('the hostless public animation room refuses soundtracks', !flip.messages.some((m) => m.type === 'soundtrack'));

  // Storyboard runtime counts loops.
  host.send({ type: 'production_create', title: 'Loop test' });
  const prod = await host.waitFor((m) => m.type === 'production_state', { timeoutMs: 4000, label: 'production_state' });
  const segment = prod.production.segments[0];
  check('storyboard runtime multiplies looped scenes', segment.runtimeMs >= 200000, `runtimeMs ${segment.runtimeMs}`);
} finally {
  for (const c of clients) c.ws?.terminate();
  child.kill();
  await exited;
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\nfilm-timing-verify: ${assertions} assertions passed`);
