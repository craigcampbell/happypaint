/* eslint-env node */
// Moderation evidence, real-server verification (drives the actual server.js
// over WS + HTTP with a scratch DATA_DIR, synthetic benign PNGs only).
//
// Covers: capture→persist→admin retrieval, immutability across repaint,
// restart persistence, admin auth + transport hardening + id traversal,
// malformed/spoofed upload refusal, non-elected-watcher refusal, per-room and
// global quota eviction, report-cap eviction, room deletion, TTL expiry, and
// account-deletion identity scrub.
//
// Ports: 9001 (main server) + 9002 (lifecycle server). Mock PocketBase is
// ephemeral-port. DATA_DIRs live under the Hermes scratch dir.

import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SimClient } from "../test/harness/client.mjs";
import { makePngBytes, makePngDataUrl } from "../test/harness/syntheticPng.mjs";
import { startMockPocketbase } from "../test/harness/mockPocketbase.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH_BASE = process.env.TMPDIR || "/tmp";
const SCRATCH1 = path.join(SCRATCH_BASE, "modevidence-verify-data-1");
const SCRATCH2 = path.join(SCRATCH_BASE, "modevidence-verify-data-2");
const PORT1 = 9001;
const PORT2 = 9002;
const BASE1 = `http://127.0.0.1:${PORT1}`;
const BASE2 = `http://127.0.0.1:${PORT2}`;
const WS1 = `ws://127.0.0.1:${PORT1}`;
const WS2 = `ws://127.0.0.1:${PORT2}`;
const ADMIN_KEY = "modev-test-admin";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
};
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// A benign synthetic evidence frame: soft peach/tan gradient blocks.
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
      throw new Error(`server at ${base} died at boot (code ${child.exitCode}), a stale listener is squatting the port`);
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
async function findAutoReport(base, room, pred = () => true) {
  const reports = await getReports(base);
  return reports.find((r) => r.room === room && r.source === "auto" && pred(r)) || null;
}

// Join a room, become the elected watcher, draw one op, flag it with evidence.
// Returns { client, report } once the report is visible to admin.
async function electedFlag(baseWs, baseHttp, roomCode, evidence, { score = 0.93, token = null, toOpId = 1 } = {}) {
  const client = new SimClient(baseWs, { room: roomCode, token, name: "watcher" });
  await client.connect();
  client.watcherAck(true);
  const role = await client.waitFor((m) => m.type === "watcher_role" && m.active === true, {
    timeoutMs: 4000,
    label: "watcher_role active",
  }).catch(() => null);
  client.sendOp({ kind: "draw", strokeId: `s${Date.now()}`, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
  await sleep(200);
  client.flag({ kind: "image", score, sinceOpId: 0, toOpId, ...(evidence ? { evidence } : {}) });
  await sleep(350);
  const report = await findAutoReport(baseHttp, roomCode);
  return { client, report, elected: !!role };
}

async function main() {
  freePort(PORT1);
  freePort(PORT2);
  // ================= SERVER 1 (port 9001): capture/auth/validation/quota =====
  let server = bootServer(PORT1, SCRATCH1, {
    EVIDENCE_PER_ROOM_MAX: "3",
    EVIDENCE_GLOBAL_MAX: "4",
    EVIDENCE_TTL_MS: "0", // resolved reports expire on the next sweep
    EVIDENCE_SWEEP_MS: "400",
  });
  await waitReady(BASE1, server);

  // --- T1: capture → persist → admin retrieval; immutability across repaint --
  const ev1 = goodEvidence(1);
  const t1 = await electedFlag(WS1, BASE1, "EVD1", ev1.payload);
  check("T1 watcher elected by server", t1.elected);
  check("T1 report filed for the flag", !!t1.report);
  const rep1 = t1.report;
  check(
    "T1 report carries opIds (real op range)",
    Array.isArray(rep1?.opIds) && rep1.opIds.length === 1 && rep1.opIds[0] === 1,
    JSON.stringify(rep1?.opIds)
  );
  const evm1 = rep1?.evidence || {};
  check(
    "T1 evidence metadata bound to report",
    typeof evm1.file === "string" &&
      evm1.file.endsWith(".png") &&
      evm1.sha256 === sha256(ev1.bytes) &&
      evm1.w === 64 &&
      evm1.h === 48 &&
      evm1.mime === "image/png" &&
      evm1.model === "heuristic" &&
      evm1.score === 0.93 &&
      evm1.sinceOpId === 0 &&
      evm1.toOpId === 1 &&
      evm1.trust === "client-captured" &&
      typeof evm1.receivedAt === "number",
    JSON.stringify({ file: evm1.file, sha: (evm1.sha256 || "").slice(0, 12) })
  );
  check(
    "T1 watcher identity keyed HMAC, never raw IP / unsalted hash",
    typeof evm1.watcher === "string" && evm1.watcher.startsWith("ip-hmac:"),
    evm1.watcher
  );
  const evFile1 = path.join(SCRATCH1, ".evidence", evm1.file || "none");
  check("T1 evidence file on disk under DATA_DIR/.evidence", !!evm1.file && existsSync(evFile1));

  const fetchEv1 = await adminGet(BASE1, `/api/admin/evidence/${rep1.id}`);
  const ev1Body = Buffer.from(await fetchEv1.arrayBuffer());
  check("T1 admin retrieval 200 + sniffed PNG content-type", fetchEv1.status === 200 && (fetchEv1.headers.get("content-type") || "").includes("image/png"));
  check("T1 served bytes bit-identical to captured frame", sha256(ev1Body) === sha256(ev1.bytes));

  // Repaint heavily, the live room changes; the frozen evidence must not.
  for (let i = 0; i < 20; i += 1) {
    t1.client.sendOp({ kind: "draw", strokeId: `repaint${i}`, points: [{ x: i, y: i }, { x: i + 1, y: i + 1 }] });
  }
  await sleep(400);
  const fetchEv1b = await adminGet(BASE1, `/api/admin/evidence/${rep1.id}`);
  const ev1BodyB = Buffer.from(await fetchEv1b.arrayBuffer());
  check("T1 evidence immutable after 20-op repaint", fetchEv1b.status === 200 && sha256(ev1BodyB) === sha256(ev1.bytes));

  // --- T2: survives a server restart on the same DATA_DIR --------------------
  await stopServer(server);
  server = bootServer(
    PORT1,
    SCRATCH1,
    {
      EVIDENCE_PER_ROOM_MAX: "3",
      EVIDENCE_GLOBAL_MAX: "4",
      EVIDENCE_TTL_MS: "0",
      EVIDENCE_SWEEP_MS: "400",
    },
    { wipe: false } // a real restart: same DATA_DIR, nothing wiped
  );
  await waitReady(BASE1, server);
  const rep1Restart = await findAutoReport(BASE1, "EVD1");
  const fetchEvRestart = await adminGet(BASE1, `/api/admin/evidence/${rep1.id}`);
  check(
    "T2 evidence + report survive a server restart",
    fetchEvRestart.status === 200 && rep1Restart?.evidence?.file,
    `status=${fetchEvRestart.status}`
  );
  check(
    "T2 sha256 stable across restart",
    rep1Restart?.evidence?.sha256 === sha256(Buffer.from(await fetchEvRestart.arrayBuffer()))
  );

  // --- T3: auth, transport hardening, id traversal, no public leak -----------
  const noKey = await fetch(`${BASE1}/api/admin/evidence/${rep1.id}`);
  const wrongKey = await adminGet(BASE1, `/api/admin/evidence/${rep1.id}`, "nope");
  check("T3 evidence GET 401 without / with wrong admin key", noKey.status === 401 && wrongKey.status === 401);
  const authed = await adminGet(BASE1, `/api/admin/evidence/${rep1.id}`);
  check(
    "T3 no-store + nosniff headers on evidence",
    (authed.headers.get("cache-control") || "").includes("no-store") &&
      authed.headers.get("x-content-type-options") === "nosniff"
  );
  const traversal = [
    // %2e%2e is normalized by the router to /api/admin/ BEFORE our handler -
    // rejected there (503 from the catch-all), never near the filesystem.
    ["%2e%2e", [400, 404, 503]],
    ["rep_x%2f..", [400]],
    ["wp_abc", [400]],
    ["rep_doesnotexist", [404]],
  ];
  let traversalOk = true;
  for (const [id, want] of traversal) {
    const r = await adminGet(BASE1, `/api/admin/evidence/${id}`);
    if (!want.includes(r.status)) {
      traversalOk = false;
      check(`T3 id ${id} → ${want.join("/")}`, false, `got ${r.status}`);
    }
  }
  if (traversalOk) check("T3 id validation: traversal/bad-shape 400, unknown 404", true);
  const publicRooms = await (await fetch(`${BASE1}/api/rooms/public`)).text();
  check(
    "T3 evidence never leaks into public payloads",
    !publicRooms.includes("evidence") && !publicRooms.includes("sha256")
  );

  // --- T4: malformed / spoofed uploads are refused, flag still processed -----
  const pngB64 = makePngDataUrl(64, 48, [200, 160, 130]).split(",")[1];
  const malformed = [
    ["svg data url", { image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", w: 64, h: 48 }],
    ["http URL string", { image: "http://evil.example/x.png", w: 64, h: 48 }],
    ["broken base64", { image: "data:image/png;base64,!!!", w: 64, h: 48 }],
    ["claimed jpeg, png bytes", { image: `data:image/jpeg;base64,${pngB64}`, w: 64, h: 48 }],
    ["declared dims ≠ actual", { image: makePngDataUrl(64, 48, [200, 160, 130]), w: 65, h: 48 }],
    ["over-sized frame (300px)", { image: makePngDataUrl(300, 300, [200, 160, 130]), w: 300, h: 300 }],
    ["over-size string", { image: `data:image/png;base64,${"A".repeat(230_000)}`, w: 64, h: 48 }],
  ];
  for (let i = 0; i < malformed.length; i += 1) {
    const [label, evidence] = malformed[i];
    const room = `MAL${i}`;
    const { report } = await electedFlag(WS1, BASE1, room, evidence);
    const refused = report?.evidence?.refused === "invalid";
    check(`T4 malformed refused: ${label}`, !!report && refused, JSON.stringify(report?.evidence));
    if (report) {
      const g = await adminGet(BASE1, `/api/admin/evidence/${report.id}`);
      if (g.status !== 404) check(`T4 no file for refused: ${label}`, false, `got ${g.status}`);
    }
  }
  check("T4 flags without valid evidence still produced reports", true);

  // --- T5: a non-elected client cannot deposit pixels -------------------------
  {
    const room = "NE1";
    const c1 = new SimClient(WS1, { room, name: "c1" });
    const c2 = new SimClient(WS1, { room, name: "c2" });
    await c1.connect();
    await c2.connect();
    c1.watcherAck(true);
    c2.watcherAck(true);
    await c1.waitFor((m) => m.type === "watcher_role" && m.active === true, { timeoutMs: 4000 }).catch(() => null);
    const c3 = new SimClient(WS1, { room, name: "c3" });
    await c3.connect();
    c3.watcherAck(true);
    await sleep(400);
    const c3Elected = c3.messages.some((m) => m.type === "watcher_role" && m.active === true);
    c3.sendOp({ kind: "draw", strokeId: "c3s", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
    await sleep(200);
    c3.flag({ kind: "image", score: 0.9, sinceOpId: 0, toOpId: 1, evidence: goodEvidence(3).payload });
    await sleep(350);
    const report = await findAutoReport(BASE1, room);
    check("T5 third client never elected", !c3Elected);
    check("T5 non-elected evidence refused", report?.evidence?.refused === "not-watcher", JSON.stringify(report?.evidence));
    const g = report ? await adminGet(BASE1, `/api/admin/evidence/${report.id}`) : null;
    check("T5 no file from non-elected uploader", !g || g.status === 404);
    c1.close();
    c2.close();
    c3.close();
  }

  // --- T6: per-room quota evicts the oldest evidence --------------------------
  {
    const room = "QTA1";
    const d = new SimClient(WS1, { room, name: "quota" });
    await d.connect();
    d.watcherAck(true);
    await d.waitFor((m) => m.type === "watcher_role" && m.active === true, { timeoutMs: 4000 }).catch(() => null);
    for (let i = 1; i <= 4; i += 1) {
      d.sendOp({ kind: "draw", strokeId: `q${i}`, points: [{ x: i, y: i }] });
      await sleep(150);
      d.flag({ kind: "image", score: 0.9, sinceOpId: i - 1, toOpId: i, evidence: goodEvidence(10 + i).payload });
      await sleep(250);
    }
    const reports = (await getReports(BASE1)).filter((r) => r.room === room && r.source === "auto").sort((a, b) => a.ts - b.ts);
    check("T6 four flags filed four reports", reports.length === 4, `got ${reports.length}`);
    check("T6 oldest evidence evicted at per-room cap (3)", reports[0]?.evidence?.dropped === "quota", JSON.stringify(reports[0]?.evidence));
    const gOld = await adminGet(BASE1, `/api/admin/evidence/${reports[0].id}`);
    check("T6 evicted file 404s", gOld.status === 404);
    const newerOk = await Promise.all(reports.slice(1).map((r) => adminGet(BASE1, `/api/admin/evidence/${r.id}`).then((g) => g.status)));
    check("T6 newest three keep their evidence", newerOk.every((s) => s === 200), newerOk.join(","));
    d.close();
  }

  // --- T7: global cap evicts the oldest evidence across rooms -----------------
  {
    // State: EVD1 (1 file) + QTA1 (3 files) = 4 = EVIDENCE_GLOBAL_MAX.
    const room = "GLB1";
    const { report } = await electedFlag(WS1, BASE1, room, goodEvidence(20).payload);
    check("T7 evidence stored under global pressure", !!report?.evidence?.file);
    const evd1 = await findAutoReport(BASE1, "EVD1");
    check("T7 oldest global evidence (EVD1) evicted", evd1?.evidence?.dropped === "quota", JSON.stringify(evd1?.evidence));
    const g = await adminGet(BASE1, `/api/admin/evidence/${evd1.id}`);
    check("T7 evicted global file 404s", g.status === 404);
  }

  // --- T8: TTL, a resolved report's evidence expires on the sweep ------------
  {
    const room = "TTL1";
    const { report } = await electedFlag(WS1, BASE1, room, goodEvidence(30).payload);
    check("T8 evidence stored before resolve", !!report?.evidence?.file);
    await fetch(`${BASE1}/api/admin/reports/${report.id}/resolve`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY } });
    await sleep(1200); // EVIDENCE_SWEEP_MS=400, TTL=0 → next sweep expires it
    const after = await findAutoReport(BASE1, room);
    check("T8 resolved report's evidence expired by sweep", after?.evidence?.expired === true && !after.evidence.file, JSON.stringify(after?.evidence));
    const g = await adminGet(BASE1, `/api/admin/evidence/${report.id}`);
    check("T8 expired evidence 404s", g.status === 404);
  }

  // --- T9: watermark beyond real history is clamped ----------------------------
  {
    const room = "CLM1";
    const { report } = await electedFlag(WS1, BASE1, room, goodEvidence(40).payload, { toOpId: 999 });
    check(
      "T9 toOpId clamped to the room's real last op",
      report?.evidence?.toOpId === 1 && JSON.stringify(report?.opIds) === "[1]",
      JSON.stringify({ to: report?.evidence?.toOpId, ops: report?.opIds })
    );
  }

  await stopServer(server);

  // ============ SERVER 2 (port 9002): lifecycle (delete/cap/scrub) ===========
  // PB is CONFIGURED here (mock), and with accounts configured, a guest is
  // refused entry to a 'friends'-audience room (the default for a code-join),
  // so every WS client below signs in with a mock token.
  const pb = await startMockPocketbase();
  const server2 = bootServer(PORT2, SCRATCH2, { REPORTS_MAX: "5", PB_URL: pb.url, POCKETBASE_URL: pb.url });
  await waitReady(BASE2, server2);

  // --- T10: room deletion drops the room's evidence files ---------------------
  {
    const { report } = await electedFlag(WS2, BASE2, "DEL1", goodEvidence(50).payload, { token: "tok_del1" });
    check("T10 evidence stored pre-delete", !!report?.evidence?.file);
    const del = await fetch(`${BASE2}/api/admin/rooms/DEL1/delete`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY } });
    check("T10 room delete accepted", del.status === 200);
    await sleep(200);
    const g = await adminGet(BASE2, `/api/admin/evidence/${report.id}`);
    const after = await findAutoReport(BASE2, "DEL1");
    check("T10 evidence file gone + marked room-closed", g.status === 404 && after?.evidence?.dropped === "room-closed", JSON.stringify(after?.evidence));
  }

  // --- T11: account deletion scrubs watcher identity, keeps the pixels --------
  {
    const { report } = await electedFlag(WS2, BASE2, "SCR1", goodEvidence(60).payload, { token: "tok_evid1" });
    check("T11 signed-in watcher's profile recorded", report?.evidence?.watcher === "profile:evid1", report?.evidence?.watcher);
    const scrub = await fetch(`${BASE2}/api/account/scrub-chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok_evid1" },
      body: "{}",
    });
    const body = await scrub.json();
    check("T11 scrub endpoint reports evidenceScrubbed", scrub.status === 200 && body.evidenceScrubbed === 1, JSON.stringify(body));
    const after = await findAutoReport(BASE2, "SCR1");
    check("T11 watcher identity nulled", after?.evidence?.watcher === null, JSON.stringify(after?.evidence?.watcher));
    const g = await adminGet(BASE2, `/api/admin/evidence/${report.id}`);
    check("T11 pixels stay (they are the room's canvas, not the watcher's)", g.status === 200);
  }

  // --- T12: report-queue cap eviction unlinks the evidence file ---------------
  {
    const { report } = await electedFlag(WS2, BASE2, "FLD1", goodEvidence(70).payload, { token: "tok_fld1" });
    check("T12 evidence stored pre-flood", !!report?.evidence?.file);
    for (let i = 0; i < 6; i += 1) {
      await fetch(`${BASE2}/api/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: `F${i}`, reason: "flood test", reporterName: "kid" }),
      });
    }
    await sleep(300);
    const reports = await getReports(BASE2);
    check("T12 reports capped at REPORTS_MAX=5", reports.length <= 5, `got ${reports.length}`);
    const still = reports.find((r) => r.id === report.id);
    check("T12 evicted report left the queue", !still);
    const g = await adminGet(BASE2, `/api/admin/evidence/${report.id}`);
    check("T12 evicted report's evidence file unlinked (404)", g.status === 404);
    check(
      "T12 no orphaned files in .evidence",
      (() => {
        try {
          const files = readdirSync(path.join(SCRATCH2, ".evidence"));
          const referenced = new Set(reports.map((r) => r.evidence?.file).filter(Boolean));
          return files.every((f) => referenced.has(f));
        } catch {
          return true; // dir gone is fine
        }
      })()
    );
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
