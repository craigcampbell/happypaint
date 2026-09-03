// Brush-engine 3-way parity harness (Playwright, against a server serving
// dist/ — `npm run build` then `PORT=8790 node server.js`; BASE defaults to
// server.js's own default port).
//
// Part 1 (Stage 2, kept): the v2 dab marker at 50% keeps uniform opacity and
// ±14-luma parity across local / live remote / history reload.
// Part 2 (Stage 2, kept): every listed brush draws.
// Part 3 (Brush Engine Stage 1 + 2): EXACT parity — v3 oil, acrylic (sprite
// `loaded` + ribbons, source-over), watercolor (wash sprites + bleed /
// wet-edge / granulation passes, MULTIPLY commit), marker (multiply) and
// pencil (graphite sprites, multiply) strokes must each hash SHA-256-identical
// on the display canvas (the stroke's screen rect) on the local client, a
// live remote client, and that remote after a history reload. This is what
// the local-exactness fix buys: the local dab walk is fed the very point
// objects the wire carries, so the same engine on the same browser lands the
// same bytes on all three. The display canvas is the doc drawn through the
// page's view, so both pages must lay out identically: the host's header
// carries more pills and wraps to a second row below ~1500px, which shifts
// the canvas and changes the fit zoom — hence the wide viewport, and `layout`
// reports the two geometries. The five strokes sit in two columns above and
// below Part 1's X (its pixels would otherwise land inside a rect).
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:8787';
const ROOM = 'ZZS2' + Math.floor(Math.random() * 900 + 100);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 850 } });

const p2 = await ctx.newPage();
await p2.goto(`${BASE}/join/${ROOM}`, { waitUntil: 'networkidle' }); await p2.waitForTimeout(2000);
const p1 = await ctx.newPage();
await p1.goto(`${BASE}/join/${ROOM}`, { waitUntil: 'networkidle' });
await p1.waitForSelector('.overlay-canvas'); await p1.waitForTimeout(2000);

const setOpacity = (val) => p1.evaluate((v) => {
  const t = [...document.querySelectorAll('input[type="range"]')].find((el) => !el.closest('.layer-row') && /opacity/i.test((el.getAttribute('aria-label') || '') + (el.closest('label')?.textContent || '')));
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(t, String(v)); t.dispatchEvent(new Event('input', { bubbles: true }));
}, val);
const pickBrush = (name) => p1.evaluate((n) => {
  const chip = [...document.querySelectorAll('.brush-chip')].find((c) => new RegExp(n, 'i').test(c.textContent));
  if (chip) chip.click();
  return !!chip;
}, name);

const r = await p1.evaluate(() => { const e = document.querySelector('.overlay-canvas').getBoundingClientRect(); return { x: e.x, y: e.y, w: e.width, h: e.height }; });
const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
const geometry = (page) => page.evaluate(() => {
  const d = document.querySelector('.display-canvas');
  const rr = d.getBoundingClientRect();
  return [Math.round(rr.x), Math.round(rr.y), Math.round(rr.width), Math.round(rr.height), d.width, d.height, window.devicePixelRatio];
});
const layout = { local: await geometry(p1), live: await geometry(p2) };
layout.identical = layout.local.join(',') === layout.live.join(',');

// --- Part 1: parity with the v2 marker at 50% ---
await setOpacity(50);
await p1.mouse.move(cx - 120, cy - 120); await p1.mouse.down();
for (let t = 0; t <= 1.001; t += 0.05) { await p1.mouse.move(cx - 120 + 240 * t, cy - 120 + 240 * t, { steps: 2 }); await p1.waitForTimeout(9); }
for (let t = 0; t <= 1.001; t += 0.05) { await p1.mouse.move(cx + 120 - 240 * t, cy - 120 + 240 * t, { steps: 2 }); await p1.waitForTimeout(9); }
await p1.mouse.up(); await p1.waitForTimeout(1600);

const sample = (page, px, py) => page.evaluate(({ px, py }) => {
  const el = document.querySelector('.display-canvas'); const g = el.getContext('2d');
  const rr = el.getBoundingClientRect(); const sx = el.width / rr.width, sy = el.height / rr.height;
  let best = [255, 255, 255], bs = 765;
  for (let dx = -20; dx <= 20; dx += 3) for (let dy = -20; dy <= 20; dy += 3) {
    const d = g.getImageData(Math.round((px + dx - rr.x) * sx), Math.round((py + dy - rr.y) * sy), 1, 1).data;
    const s = d[0] + d[1] + d[2]; if (s < bs) { bs = s; best = [d[0], d[1], d[2]]; }
  } return best;
}, { px, py });
const lum = (v) => Math.round((v[0] + v[1] + v[2]) / 3);
const lc = await sample(p1, cx, cy), lb = await sample(p1, cx - 80, cy - 80);
const rc = await sample(p2, cx, cy), rb = await sample(p2, cx - 80, cy - 80);
await p2.reload({ waitUntil: 'networkidle' }); await p2.waitForTimeout(2500);
const hc = await sample(p2, cx, cy), hb = await sample(p2, cx - 80, cy - 80);

// --- Part 3 (runs BEFORE the legacy spray of Part 2 lands anywhere near):
// exact display-canvas hashes for v3 oil + acrylic strokes. Each stroke gets
// its own screen rect (CSS px, the same on every page — same viewport, same
// default view), read back from the display canvas in canvas px.
await setOpacity(95);
const hashRect = (page, rect) => page.evaluate(({ rect }) => {
  const el = document.querySelector('.display-canvas'); const g = el.getContext('2d');
  const rr = el.getBoundingClientRect(); const sx = el.width / rr.width, sy = el.height / rr.height;
  const x = Math.round((rect.x - rr.x) * sx), y = Math.round((rect.y - rr.y) * sy);
  const w = Math.round(rect.w * sx), h = Math.round(rect.h * sy);
  const data = g.getImageData(x, y, w, h).data;
  let painted = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) painted += 1;
  return { bytes: Array.from(data), painted, w, h };
}, { rect });
const sha = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const exact = {};
// Rows at cy ± 200 / ± 330 keep every rect clear of Part 1's X (|dy| <= ~132);
// two 400-px columns per row, 120 px apart, each rect holding only its own
// stroke (± 40 sine + brush radius + the watercolor bleed stay inside ± 60).
const v3 = [
  { name: 'Oil', y: cy - 330, x0: cx - 460 },
  { name: 'Acrylic', y: cy - 330, x0: cx + 60 },
  { name: 'Watercolor', y: cy - 200, x0: cx - 460 },
  { name: 'Marker', y: cy - 200, x0: cx + 60 },
  { name: 'Pencil', y: cy + 200, x0: cx - 460 },
];
for (const { name, y, x0 } of v3) {
  const ok = await pickBrush(name);
  if (!ok) { exact[name] = 'chip-not-found'; continue; }
  await p1.waitForTimeout(150);
  await p1.mouse.move(x0, y); await p1.mouse.down();
  for (let t = 0; t <= 1.001; t += 0.04) { await p1.mouse.move(x0 + 400 * t, y + 40 * Math.sin(t * 7), { steps: 3 }); await p1.waitForTimeout(9); }
  await p1.mouse.up(); await p1.waitForTimeout(1600);
  await p1.mouse.move(cx, cy + 380); await p1.waitForTimeout(300); // park the pointer off the rect
  const rect = { x: x0 - 70, y: y - 60, w: 540, h: 120 };
  const local = await hashRect(p1, rect);
  const live = await hashRect(p2, rect);
  exact[name] = {
    rect,
    painted: { local: local.painted, live: live.painted },
    local: sha(local.bytes),
    live: sha(live.bytes),
  };
}
await p2.reload({ waitUntil: 'networkidle' }); await p2.waitForTimeout(2500);
for (const { name } of v3) {
  const e = exact[name];
  if (!e || typeof e !== 'object') continue;
  const history = await hashRect(p2, e.rect);
  e.history = sha(history.bytes);
  e.painted.history = history.painted;
  e.drew = e.painted.local > 200;
  e.exactLive = e.local === e.live;
  e.exactHistory = e.local === e.history;
}

// --- Part 2: each dab brush draws (short strokes in a row, full opacity) ---
const brushResults = {};
const names = ['Pencil', 'Crayon', 'Paint', 'Glow', 'Spray'];
let bx = cx - 200;
for (const n of names) {
  const ok = await pickBrush(n);
  if (!ok) { brushResults[n] = 'chip-not-found'; continue; }
  await p1.waitForTimeout(150);
  const y = cy + 160;
  await p1.mouse.move(bx, y); await p1.mouse.down();
  for (let t = 0; t <= 1; t += 0.12) { await p1.mouse.move(bx + 70 * t, y + 18 * Math.sin(t * 6), { steps: 2 }); await p1.waitForTimeout(10); }
  await p1.mouse.up(); await p1.waitForTimeout(350);
  const v = await sample(p1, bx + 35, y);
  brushResults[n] = { px: v, drew: lum(v) < 240 };
  bx += 95;
}
await p1.screenshot({ path: '.stage2-brushes.png', clip: { x: r.x, y: r.y, width: r.w, height: r.h } });
await b.close();
const exactOk = layout.identical && v3.every(({ name }) => exact[name]?.drew && exact[name]?.exactLive && exact[name]?.exactHistory);
console.log(JSON.stringify({
  ROOM,
  layout,
  parity: {
    local: { cross: lc, body: lb }, live: { cross: rc, body: rb }, history: { cross: hc, body: hb },
    uniformLocal: Math.abs(lum(lc) - lum(lb)) <= 14,
    uniformLive: Math.abs(lum(rc) - lum(rb)) <= 14,
    uniformHistory: Math.abs(lum(hc) - lum(hb)) <= 14,
    parityLive: Math.abs(lum(rb) - lum(lb)) <= 14,
    parityHistory: Math.abs(lum(hb) - lum(lb)) <= 14,
  },
  exact,
  exactOk,
  brushes: brushResults,
}, null, 2));
process.exit(exactOk ? 0 : 1);
