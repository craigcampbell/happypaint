/* eslint-env node */
// Moderation evidence HARDENING — regression suite for the independent-review
// blockers (SEC-1, LOG-1, LOG-2). Drives the real server.js over WS + HTTP
// with scratch DATA_DIRs, synthetic benign PNGs only.
//
//   SEC-1: guest watcher identity is an HMAC of the client IP keyed by a
//          PERSISTED server secret (.evidence-key, 0600) — never an unsalted,
//          brute-forceable sha256 over the ~2^32 IPv4 space.
//   LOG-1: a flag whose effective (clamped) op range is empty/inverted is
//          rejected outright, and corroboration overlap uses the CLAMPED
//          range — forged watermarks cannot manufacture an auto-hide.
//   LOG-2: .reports.json persists atomically (tmp+rename), and startup
//          reconciles the evidence dir: leftover .tmp staging files and
//          evidence files no loaded report references are deleted.
//
// Ports: 9003 (guest server, no PB) + 9004 (mock-PB server). DATA_DIRs live
// under the Hermes scratch dir.

import { spawn, execSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SimClient } from "../test/harness/client.mjs";
import { makePngBytes } from "../test/harness/syntheticPng.mjs";
import { startMockPocketbase } from "../test/harness/mockPocketbase.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH_BASE = process.env.TMPDIR || "/tmp";
const SCRATCH1 = path.join(SCRATCH_BASE, "modevidence-hardening-data-1");
const SCRATCH2 = path.join(SCRATCH_BASE, "modevidence-hardening-data-2");
const PORT1 = 9003;
const PORT2 = 9004;
const BASE1 = `http://127.0.0.1:${PORT1}`;
const BASE2 = `http://127.0.0.1:${PORT2}`;
const WS1 = `ws://127.0.0.1:${PORT1}`;
const WS2 = `ws://127.0.0.1:${PORT2}`;
const ADMIN_KEY = "modhard-test-admin";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

function goodEvidence(tag = 0) {
  const bytes = makePngBytes(64, 48, (x, y) => [220 - ((x + tag) % 30), 170 - (y % 20), 140]);
  return {
    bytes,
    payload: {
      image: `data:image/png;base64,${bytes.toString("base64")}`,
      w: 64,
      h: 48,
      model: "heuristic",
      threshold: 0.7,
      capturedAt: Date.now(),
    },
  };
}

const children = [];
// Never leak a test server: a timed-out/crashed suite leaves server.js
// squatting on the port, and the next run then asserts against STALE code.
process.on("exit", () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
});
function freePort(port) {
  try {
    execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: "ignore" });
  } catch {
    // nothing listening
  }
}

function bootServer(port, dataDir, extraEnv = {}, { wipe = true } = {}) {
  if (wipe) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_KEY,
      PB_URL: "",
      POCKETBASE_URL: "",
      ...extraEnv,
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(`[srv:${port}] ${d}`));
  children.push(child);
  return child;
}

async function waitReady(base, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) {
      throw new Error(`server at ${base} died at boot (code ${child.exitCode}) — a stale listener is squatting the port`);
    }
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`server at ${base} never became ready`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 3000);
  });
}

const adminGet = (base, p, key = ADMIN_KEY) =>
  fetch(`${base}${p}`, { headers: key ? { "x-admin-key": key } : {}, cache: "no-store" });

async function getReports(base) {
  const r = await adminGet(base, "/api/admin/reports");
  return (await r.json()).reports;
}
async function autoReports(base, room) {
  return (await getReports(base)).filter((r) => r.room === room && r.source === "auto");
}

// Join a room, become the elected watcher, draw one op, flag it with evidence.
async function electedFlag(baseWs, baseHttp, roomCode, evidence, { score = 0.93, token = null, toOpId = 1 } = {}) {
  const client = new SimClient(baseWs, { room: roomCode, token, name: "watcher" });
  await client.connect();
  client.watcherAck(true);
  const role = await client
    .waitFor((m) => m.type === "watcher_role" && m.active === true, { timeoutMs: 4000, label: "watcher_role active" })
    .catch(() => null);
  client.sendOp({ kind: "draw", strokeId: `s${Date.now()}`, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
  await sleep(200);
  client.flag({ kind: "image", score, sinceOpId: 0, toOpId, ...(evidence ? { evidence } : {}) });
  await sleep(350);
  const reports = await autoReports(baseHttp, roomCode);
  return { client, report: reports[0] || null, elected: !!role };
}

const evidenceDirListing = (dataDir) => {
  try {
    return readdirSync(path.join(dataDir, ".evidence"));
  } catch {
    return null; // dir absent
  }
};

async function main() {
  freePort(PORT1);
  freePort(PORT2);

  // ================= SERVER 1 (port 9003): SEC-1 + LOG-2 =====================
  let server = bootServer(PORT1, SCRATCH1);
  await waitReady(BASE1, server);

  // --- H1: guest watcher identity is keyed-HMAC, never unsalted sha256 -------
  const ev1 = goodEvidence(1);
  const t1 = await electedFlag(WS1, BASE1, "HID1", ev1.payload);
  check("H1 watcher elected by server", t1.elected);
  check("H1 report filed with evidence", !!t1.report?.evidence?.file);
  const watcher1 = t1.report?.evidence?.watcher;
  check("H1 guest identity uses ip-hmac scheme", typeof watcher1 === "string" && watcher1.startsWith("ip-hmac:"), watcher1);
  // The pre-fix scheme: bare sha256(ip) truncated to 16 hex — brute-forceable
  // over the ~2^32 IPv4 space. The stored identity must NEVER equal it.
  const legacyCandidates = ["127.0.0.1", "::ffff:127.0.0.1", "::1"].map(
    (ip) => `ip-sha256:${createHash("sha256").update(ip).digest("hex").slice(0, 16)}`
  );
  check("H1 identity is not the reversible unsalted hash", !!watcher1 && !legacyCandidates.includes(watcher1), watcher1);

  // --- H2: the HMAC key is a persisted server secret (.evidence-key) ---------
  const keyFile = path.join(SCRATCH1, ".evidence-key");
  let keyMaterial = "";
  try {
    keyMaterial = readFileSync(keyFile, "utf8").trim();
  } catch {
    keyMaterial = "";
  }
  check("H2 persisted HMAC key file exists (.evidence-key)", keyMaterial.length >= 32, `len=${keyMaterial.length}`);
  const hmacCandidates = ["127.0.0.1", "::ffff:127.0.0.1", "::1"].map(
    (ip) => `ip-hmac:${createHmac("sha256", keyMaterial).update(ip).digest("hex").slice(0, 16)}`
  );
  check(
    "H2 identity matches HMAC of the client IP under the persisted key",
    !!watcher1 && hmacCandidates.includes(watcher1),
    watcher1
  );
  const evFile1 = t1.report?.evidence?.file;

  // --- H4/H6 (setup): plant orphans + a stale reports tmp, then restart ------
  await stopServer(server);
  const evDir = path.join(SCRATCH1, ".evidence");
  writeFileSync(path.join(evDir, "rep_orphan0aa.png"), Buffer.from("orphaned bytes"));
  writeFileSync(path.join(evDir, "rep_orphan0bb.png.tmp"), Buffer.from("half-written staging file"));
  writeFileSync(path.join(SCRATCH1, ".reports.json.tmp"), "{stale interrupted write");
  server = bootServer(PORT1, SCRATCH1, {}, { wipe: false }); // real restart, same DATA_DIR
  await waitReady(BASE1, server);

  const listingAfterReconcile = evidenceDirListing(SCRATCH1) || [];
  check(
    "H4 startup sweep deletes leftover .tmp staging files",
    !listingAfterReconcile.some((f) => f.endsWith(".tmp")),
    JSON.stringify(listingAfterReconcile)
  );
  check(
    "H4 startup sweep deletes evidence files no report references",
    !listingAfterReconcile.includes("rep_orphan0aa.png"),
    JSON.stringify(listingAfterReconcile)
  );
  check(
    "H4 referenced evidence survives the startup sweep",
    !!evFile1 && listingAfterReconcile.includes(evFile1),
    `file=${evFile1}`
  );
  const reportsAfterRestart = await getReports(BASE1);
  check(
    "H4 reports intact despite a stale .reports.json.tmp",
    reportsAfterRestart.some((r) => r.id === t1.report.id)
  );

  // --- H2b: identity is STABLE across a restart (persisted key, not per-boot) -
  const t1b = await electedFlag(WS1, BASE1, "HID2", goodEvidence(2).payload);
  check(
    "H2b same guest identity after restart (key persisted)",
    t1b.report?.evidence?.watcher === watcher1,
    `${t1b.report?.evidence?.watcher} vs ${watcher1}`
  );
  check("H6 no .reports.json.tmp lingers after a persist", !existsSync(path.join(SCRATCH1, ".reports.json.tmp")));

  // --- H5: corrupted .reports.json → reports=[] and ALL evidence reconciled --
  await stopServer(server);
  writeFileSync(path.join(SCRATCH1, ".reports.json"), "{corrupted by a crash");
  server = bootServer(PORT1, SCRATCH1, {}, { wipe: false });
  await waitReady(BASE1, server);
  const reportsCorrupt = await getReports(BASE1);
  check("H5 server boots healthy on a corrupted reports file", Array.isArray(reportsCorrupt) && reportsCorrupt.length === 0);
  const listingCorrupt = evidenceDirListing(SCRATCH1);
  check(
    "H5 orphaned evidence reconciled when reports fail to load",
    listingCorrupt === null || listingCorrupt.length === 0,
    JSON.stringify(listingCorrupt)
  );

  // --- H6: atomic persist — a fresh flag rewrites .reports.json cleanly ------
  const t6 = await electedFlag(WS1, BASE1, "HID3", goodEvidence(3).payload);
  check("H6 flag after corruption files a fresh report", !!t6.report?.evidence?.file);
  let persistedOk = false;
  try {
    const parsed = JSON.parse(readFileSync(path.join(SCRATCH1, ".reports.json"), "utf8"));
    persistedOk = Array.isArray(parsed) && parsed.some((r) => r.id === t6.report.id);
  } catch {
    persistedOk = false;
  }
  check("H6 .reports.json valid JSON containing the new report", persistedOk);
  check("H6 no tmp residue in DATA_DIR or .evidence", !existsSync(path.join(SCRATCH1, ".reports.json.tmp")) && !(evidenceDirListing(SCRATCH1) || []).some((f) => f.endsWith(".tmp")));
  t1.client.close();
  t1b.client.close();
  t6.client.close();
  await stopServer(server);

  // ================= SERVER 2 (port 9004): LOG-1 corroboration ===============
  // Two DISTINCT flagger identities require accounts (guests share one IP key).
  const pb = await startMockPocketbase();
  const server2 = bootServer(PORT2, SCRATCH2, { PB_URL: pb.url, POCKETBASE_URL: pb.url });
  await waitReady(BASE2, server2);

  // --- H3: forged watermarks cannot manufacture corroboration -----------------
  // Room RNG1 gets ONE real op (opId 1). Identity A flags a range entirely
  // beyond the room's history (sinceOpId 50 > lastOpId 1) with a huge toOpId:
  // after clamping the effective range is EMPTY and must be rejected outright.
  // Identity B then flags {0, 1e9}: alone it is Tier-1 only. Pre-fix, A's
  // inverted stored range plus the RAW-toOpId overlap test corroborated B and
  // auto-hid op 1.
  {
    const room = "RNG1";
    const a = new SimClient(WS2, { room, token: "tok_forgea", name: "A" });
    await a.connect();
    a.watcherAck(true);
    await a.waitFor((m) => m.type === "watcher_role" && m.active === true, { timeoutMs: 4000 }).catch(() => null);
    a.sendOp({ kind: "draw", strokeId: "a1", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    await sleep(250);
    const aBase = a.messages.length; // ignore the empty join-time history
    a.flag({ kind: "image", score: 0.99, sinceOpId: 50, toOpId: 1_000_000_000 });
    await sleep(400);
    const b = new SimClient(WS2, { room, token: "tok_forgeb", name: "B" });
    await b.connect();
    await sleep(200);
    const bBase = b.messages.length; // ignore B's join-time history replay
    b.flag({ kind: "image", score: 0.99, sinceOpId: 0, toOpId: 1_000_000_000 });
    await sleep(500);

    // A fresh joiner replays the room: op 1 must still be visible (no auto-hide).
    const c = new SimClient(WS2, { room, token: "tok_forgec", name: "C" });
    await c.connect();
    await sleep(400);
    const history = c.messages.find((m) => m.type === "history");
    const visibleOpIds = (history?.ops || []).map((op) => op.opId);
    check(
      "H3 empty/inverted effective range rejected — no manufactured auto-hide",
      visibleOpIds.includes(1),
      `visible=${JSON.stringify(visibleOpIds)}`
    );
    const rng1Reports = await autoReports(BASE2, room);
    check(
      "H3 only the real flag filed a report (forged range filed none)",
      rng1Reports.length === 1 && JSON.stringify(rng1Reports[0]?.opIds) === "[1]",
      `${rng1Reports.length} reports`
    );
    check(
      "H3 no auto-hide broadcast reached the room after the flags",
      ![...a.messages.slice(aBase), ...b.messages.slice(bBase)].some(
        (m) => m.type === "history" && !(m.ops || []).some((op) => op.opId === 1)
      )
    );
    a.close();
    b.close();
    c.close();
  }

  // --- H3b: legitimate adjacent ranges still corroborate (no over-rejection) --
  // Two identities flag genuinely OVERLAPPING real ranges → Tier-2 still fires.
  {
    const room = "RNG2";
    const a = new SimClient(WS2, { room, token: "tok_legita", name: "LA" });
    await a.connect();
    a.sendOp({ kind: "draw", strokeId: "la1", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    await sleep(250);
    a.flag({ kind: "image", score: 0.99, sinceOpId: 0, toOpId: 1 });
    await sleep(300);
    const b = new SimClient(WS2, { room, token: "tok_legitb", name: "LB" });
    await b.connect();
    b.flag({ kind: "image", score: 0.99, sinceOpId: 0, toOpId: 5 }); // clamps to 1, overlaps A
    await sleep(500);
    const c = new SimClient(WS2, { room, token: "tok_legitc", name: "LC" });
    await c.connect();
    await sleep(400);
    const history = c.messages.find((m) => m.type === "history");
    check(
      "H3b genuine two-party corroboration still auto-hides",
      (history?.ops || []).length === 0,
      `visible=${JSON.stringify((history?.ops || []).map((op) => op.opId))}`
    );
    a.close();
    b.close();
    c.close();
  }

  await stopServer(server2);
  await pb.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
