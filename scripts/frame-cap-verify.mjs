// End-to-end check of the + behaviour after the fix, on an isolated server with
// a fresh DATA_DIR (so the reel starts small, like a new kid's session):
//   1. tapping + adds a cel (the normal path still works);
//   2. the reel scrolls the newest cel into view;
//   3. the + stays VISIBLE (pinned) once cels overflow;
//   4. at the cap the + is still tappable and explains itself with a toast.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = 'C:/Users/Craig Campbell/Projects/happypaint';
const OUT = path.join(ROOT, 'captures', 'verify-frames');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecap-'));
const PORT = 8955;
const log = fs.openSync(path.join(dir, 'server.log'), 'w');
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, PB_URL: '' }, stdio: ['ignore', log, log],
});
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
await page.goto(`http://127.0.0.1:${PORT}/join/FLIPBOOK`, { waitUntil: 'load' });
await page.waitForTimeout(6000);
try { await page.getByRole('button', { name: 'Start drawing', exact: true }).click({ timeout: 3000 }); } catch {}
await page.waitForTimeout(1200);

const probe = () => page.evaluate(() => {
  const reel = document.querySelector('.fs-reel');
  const add = document.querySelector('button[aria-label^="Add frame"]');
  const box = reel ? reel.getBoundingClientRect() : null;
  const abox = add ? add.getBoundingClientRect() : null;
  const cels = reel ? [...reel.querySelectorAll('.fs-cel')].length : 0;
  const counter = document.querySelector('.fs-counter')?.textContent?.trim() || null;
  const toastEl = [...document.querySelectorAll('.studio-toast, .toast, [class*="toast"]')].map((n) => n.textContent.trim()).filter(Boolean);
  const active = reel ? reel.querySelector('.fs-cel.is-active') : null;
  const aboxActive = active ? active.getBoundingClientRect() : null;
  return {
    cels,
    counter,
    addDisabled: add ? add.disabled : null,
    addTitle: add ? add.title : null,
    addVisibleInReel: !!(box && abox && abox.left >= box.left - 4 && abox.right <= box.right + 4),
    activeInView: !!(box && aboxActive && aboxActive.left >= box.left - 4 && aboxActive.right <= box.right + 4),
    reelScrollLeft: reel ? Math.round(reel.scrollLeft) : null,
    toast: toastEl.slice(0, 2),
  };
});

const trace = [{ step: 'start', ...(await probe()) }];
for (let i = 1; i <= 12; i += 1) {
  const before = await probe();
  let clickErr = null;
  try { await page.locator('button[aria-label^="Add frame"]').click({ timeout: 2500 }); }
  catch (err) { clickErr = String(err).slice(0, 60); }
  await page.waitForTimeout(1300);
  const after = await probe();
  trace.push({ step: `tap${i}`, added: after.cels - before.cels, clickErr, ...after });
  if (after.addTitle && /full/i.test(after.addTitle)) {
    // the cap is here: tap twice more to prove the explanation repeats
    for (let k = 0; k < 2; k += 1) {
      await page.locator('button[aria-label^="Add frame"]').click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(900);
      trace.push({ step: `cap-tap${k + 1}`, ...(await probe()) });
    }
    break;
  }
}
await page.screenshot({ path: path.join(OUT, 'framecap-after.png') });
fs.writeFileSync(path.join(OUT, 'framecap.json'), JSON.stringify({ trace, errors }, null, 1));
for (const t of trace) {
  console.log(`${t.step.padEnd(9)} cels=${t.cels} counter=${t.counter} addVisible=${t.addVisibleInReel} activeInView=${t.activeInView} title=${JSON.stringify(t.addTitle)} toast=${JSON.stringify(t.toast)}`);
}
console.log('errors:', errors.slice(0, 3));
await browser.close();
server.kill();
