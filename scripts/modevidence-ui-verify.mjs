/* eslint-env node */
// Moderation evidence — admin UI verification (Playwright, real server +
// built dist, synthetic benign PNG only).
//
// Drives a real flag with frozen evidence over WS, then opens /admin as the
// owner and asserts the report row shows: the frozen snapshot (fetched with
// the admin header, decoded by the browser), the op range, and the explicit
// "client-supplied corroboration, NOT proof" trust framing — never an
// identity accusation. Screenshot saved for eyeballing.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SimClient } from "../test/harness/client.mjs";
import { makePngDataUrl } from "../test/harness/syntheticPng.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = path.join(process.env.TMPDIR || "/tmp", "modevidence-ui-data");
const OUT_DIR = path.join(process.env.TMPDIR || "/tmp", "modevidence-ui-shots");
const PORT = 9004;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const ROOM = "UIT1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, PB_URL: "", POCKETBASE_URL: "" },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
process.on("exit", () => {
  try {
    server.kill("SIGKILL");
  } catch {
    // gone
  }
});

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    if (server.exitCode != null) throw new Error(`server died at boot (code ${server.exitCode}) — stale listener on ${PORT}?`);
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) break;
    } catch {
      // booting
    }
    await sleep(250);
  }
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();

  // -- Fixture: an elected watcher flags a frame with frozen evidence --------
  // Benign synthetic content: soft horizontal stripes, 96x72.
  const evidence = {
    image: makePngDataUrl(96, 72, (x, y) => [200 + (y % 3) * 10, 160 + (x % 4) * 8, 130]),
    w: 96,
    h: 72,
    model: "heuristic",
    threshold: 0.7,
    capturedAt: Date.now(),
  };
  const watcher = new SimClient(WS, { room: ROOM, name: "watcher" });
  await watcher.connect();
  watcher.watcherAck(true);
  const role = await watcher
    .waitFor((m) => m.type === "watcher_role" && m.active === true, { timeoutMs: 4000 })
    .catch(() => null);
  check("fixture: watcher elected", !!role);
  watcher.sendOp({ kind: "draw", strokeId: "ui1", points: [{ x: 5, y: 5 }, { x: 9, y: 9 }] });
  await sleep(250);
  watcher.flag({ kind: "image", score: 0.93, sinceOpId: 0, toOpId: 1, evidence });
  await sleep(400);
  // A second, evidence-less report: the row must render WITHOUT a snapshot.
  await fetch(`${BASE}/api/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room: ROOM, reason: "someone is being mean", reporterName: "kid" }),
  });

  // -- The admin console ------------------------------------------------------
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((key) => {
    window.localStorage.setItem("drawesome:adminkey:v1", key);
  }, adminKey);
  const page = await context.newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });

  const evidenceBlock = page.locator(".admin-evidence");
  await evidenceBlock.first().waitFor({ state: "visible", timeout: 15000 });
  check("admin report row renders an evidence block", (await evidenceBlock.count()) === 1);

  const img = evidenceBlock.locator("img");
  await img.waitFor({ state: "visible", timeout: 10000 });
  const natural = await img.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
  check("frozen snapshot decodes in the browser at captured size", natural.w === 96 && natural.h === 72, JSON.stringify(natural));
  const imgSrc = await img.getAttribute("src");
  check("snapshot is a same-origin blob (fetched WITH the admin key)", (imgSrc || "").startsWith("blob:"));

  const blockText = await evidenceBlock.innerText();
  check(
    "trust framing present: corroboration, NOT proof",
    /client-supplied corroboration, NOT proof/i.test(blockText)
  );
  check("forge warning present", /modified client can forge pixels/i.test(blockText));
  check("no identity accusation — 'suspected — review required'", /suspected — review required/i.test(blockText));
  check("op range attributed to the room canvas, not a person", /room canvas between ops 0–1/.test(blockText));
  check("metadata: score + model + format", /Score 0\.93/.test(blockText) && /heuristic/.test(blockText) && /PNG/.test(blockText), blockText.slice(0, 160));

  const rowText = await page.locator(".admin-report", { has: evidenceBlock }).innerText();
  check("implicated op ids listed", /implicated ops: 1/.test(rowText));

  // The evidence-less report shows no snapshot block.
  const plainRow = page.locator(".admin-report", { hasText: "being mean" });
  check(
    "report without evidence renders no snapshot",
    (await plainRow.locator(".admin-evidence img").count()) === 0
  );

  const shot = path.join(OUT_DIR, "admin-evidence-report.png");
  await page.locator(".admin-report", { has: evidenceBlock }).screenshot({ path: shot });
  console.log(`screenshot: ${shot}`);

  await browser.close();
};

run()
  .then(() => {
    server.kill("SIGTERM");
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    server.kill("SIGKILL");
    process.exit(1);
  });
