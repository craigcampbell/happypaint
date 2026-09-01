// Draft autosave round-trip on REAL WebKit (iPhone 14). WebKit refuses PNG Blobs
// in IndexedDB, so the autosave must fall back to dataURLs, latch that verdict
// (one warning, no repeated Blob attempts), persist across reload, and survive a
// navigate-away mid-tick with zero page errors — the teardown race that used to
// log "Cannot load blob: … due to access control checks".
// Usage: node scripts/draft-roundtrip-verify.mjs   (ROOM env overrides the room)
import { webkit, devices } from "playwright";
import { spawn } from "child_process";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";

const PORT = 8933;
const BASE = `http://localhost:${PORT}`;
const ROOM = process.env.ROOM || "/join/ZZMOBILE";
const ROOT = process.cwd();
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: mkdtempSync(path.join(os.tmpdir(), "drt-")) }, stdio: "pipe",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* booting */ } await sleep(250); }

let fails = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!ok) fails++; };

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices["iPhone 14"] });
const page = await ctx.newPage();
const pageErrors = [];
const warns = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "warning" && /Draft autosave/.test(m.text())) warns.push(m.text()); });

// Every record in every IndexedDB store that looks like a draft, name-agnostic.
const readDrafts = () => page.evaluate(async () => {
  const out = [];
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    for (const store of db.objectStoreNames) {
      const recs = await new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      for (const rec of recs) {
        const v = rec && rec.layers === undefined && rec.value !== undefined ? rec.value : rec;
        if (v && Array.isArray(v.layers)) {
          out.push({ db: name, store, savedAt: v.savedAt, layers: v.layers.map((l) => ({
            hasBlob: !!l.blob, image: typeof l.image === "string" ? l.image.slice(0, 22) + "…len=" + l.image.length : null,
          })) });
        }
      }
    }
    db.close();
  }
  return out;
});
const openRoom = async () => {
  await page.goto(BASE + ROOM, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".overlay-canvas", { timeout: 15000 });
  await sleep(1500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".welcome-modal button")].find((x) => /go|start|got it|draw/i.test(x.textContent));
    if (b) b.click();
  });
  await sleep(400);
  return page.evaluate(() => { const r = document.querySelector(".overlay-canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
};
const stroke = async (box, fx, fy, tx, ty) => {
  await page.mouse.move(box.x + box.w * fx, box.y + box.h * fy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(box.x + box.w * (fx + (tx - fx) * i / 12), box.y + box.h * (fy + (ty - fy) * i / 12)); await sleep(16); }
  await page.mouse.up();
  await sleep(150);
};

const box = await openRoom();
await stroke(box, 0.3, 0.3, 0.7, 0.3);
await stroke(box, 0.3, 0.4, 0.7, 0.4);
await sleep(3500); // > one 2400ms autosave tick once the hands are off
const drafts = await readDrafts();
check("D1 a draft was written to IndexedDB on WebKit", drafts.length > 0, JSON.stringify(drafts).slice(0, 200));
const d = drafts[0];
check("D2 draft layers are dataURL PNGs, no Blob", !!d && d.layers.length > 0 && d.layers.every((l) => !l.hasBlob && l.image && l.image.startsWith("data:image/png")), d ? JSON.stringify(d.layers) : "");
check("D3 fallback warning fired exactly once", warns.length === 1, `${warns.length} warnings`);

await stroke(box, 0.6, 0.6, 0.7, 0.65);
await sleep(3500);
const drafts2 = await readDrafts();
check("D4 second tick overwrote the draft via the latched path", !!drafts2[0] && drafts2[0].savedAt > d.savedAt, `${d?.savedAt} → ${drafts2[0]?.savedAt}`);
check("D5 still exactly one warning after the latched tick", warns.length === 1, `${warns.length}`);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".overlay-canvas", { timeout: 15000 });
await sleep(1500);
const drafts3 = await readDrafts();
check("D6 draft persisted across reload", drafts3.length > 0 && drafts3[0].savedAt === drafts2[0]?.savedAt);

// The teardown race: draw, then navigate away right as the autosave tick lands.
const box2 = await page.evaluate(() => { const r = document.querySelector(".overlay-canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
for (let i = 0; i < 3; i++) {
  await stroke(box2, 0.2, 0.7 + i * 0.05, 0.5, 0.7 + i * 0.05);
  await sleep(2300 + i * 40);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await sleep(800);
  await openRoom();
}
check("D7 zero page errors across three navigate-away-mid-tick races", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));

await browser.close();
server.kill();
console.log(fails ? `\n${fails} FAIL` : "\nALL PASS");
process.exit(fails ? 1 : 0);
