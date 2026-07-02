// Stage 2 verification: (1) v2 dab marker keeps uniform opacity + EXACT 3-way
// parity (local / live remote / history replay); (2) every dab brush draws.
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:3000';
const ROOM = 'ZZS2' + Math.floor(Math.random() * 900 + 100);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 850 } });

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

// --- Part 2: each dab brush draws (short strokes in a row, full opacity) ---
await setOpacity(95);
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
console.log(JSON.stringify({
  ROOM,
  parity: {
    local: { cross: lc, body: lb }, live: { cross: rc, body: rb }, history: { cross: hc, body: hb },
    uniformLocal: Math.abs(lum(lc) - lum(lb)) <= 14,
    uniformLive: Math.abs(lum(rc) - lum(rb)) <= 14,
    uniformHistory: Math.abs(lum(hc) - lum(hb)) <= 14,
    parityLive: Math.abs(lum(rb) - lum(lb)) <= 14,
    parityHistory: Math.abs(lum(hb) - lum(lb)) <= 14,
  },
  brushes: brushResults,
}, null, 2));
process.exit(0);
