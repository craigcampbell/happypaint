// Trace-a-photo verification. The story: a user photo becomes the room's traced
// underlay for everyone — but ONLY where there's an accountable uploader
// (private "friends" rooms, or the host of an owned public room). The hostless
// public rooms (MAIN) must refuse it. Non-raster payloads (SVG) are rejected.
// Part A drives raw WS (the security-critical gate + validation + serve); Part B
// is a browser pass for the button gating + end-to-end overlay.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import { WebSocket } from "ws";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "trace-verify-data");
const PORT = 8923;
const BASE = `http://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const ADMIN_KEY = "trace-test-admin";
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, ADMIN_KEY }, stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");

// Connect a raw WS to a room, collect messages, expose a sender.
function connect(room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on("open", () => setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 400));
  });
}
const lastSheet = (msgs) => [...msgs].reverse().find((m) => m.type === "sheet");

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // ---- Part A: server gate + validation (raw WS) --------------------------
  // 1) Private "friends" code room: any member may set a trace photo.
  const priv = await connect("ZZTRACE");
  priv.msgs.length = 0;
  priv.send({ type: "set_trace_photo", image: PNG });
  await sleep(500);
  const sheetMsg = lastSheet(priv.msgs);
  const traceId = sheetMsg && sheetMsg.sheetId;
  check("private room: valid photo becomes the room sheet", !!traceId && traceId.startsWith("trace_"), `sheetId=${traceId}`);

  // 2) The photo is served through the normal /api/sheets path.
  let served = null;
  if (traceId) served = await fetch(`${BASE}/api/sheets/${traceId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  check("trace photo is served via /api/sheets/:id", !!served && typeof served.image === "string" && served.image.startsWith("data:image"));

  // 3) SVG (executable → XSS) is rejected with a trace_rejected notice.
  priv.msgs.length = 0;
  priv.send({ type: "set_trace_photo", image: SVG });
  await sleep(500);
  check("SVG photo is rejected (no stored XSS)", priv.msgs.some((m) => m.type === "trace_rejected") && !lastSheet(priv.msgs));

  // 4) Non-image bytes labelled image/png are rejected (magic-byte check).
  priv.msgs.length = 0;
  priv.send({ type: "set_trace_photo", image: "data:image/png;base64," + Buffer.from("not a png").toString("base64") });
  await sleep(500);
  check("non-image bytes rejected", priv.msgs.some((m) => m.type === "trace_rejected"));

  // 5) SAFETY GATE: a hostless public room (MAIN, kid_safe) must REFUSE it.
  const pub = await connect("MAIN");
  pub.msgs.length = 0;
  pub.send({ type: "set_trace_photo", image: PNG });
  await sleep(600);
  const pubSheet = lastSheet(pub.msgs);
  check("hostless public room refuses trace photos (no accountable host)", !pubSheet || !String(pubSheet.sheetId || "").startsWith("trace_"));

  // 6) A host can't re-broadcast another room's photo by pointing set_sheet at
  //    its trace_ id (cross-room privacy).
  const priv2 = await connect("ZZTRACE2");
  priv2.msgs.length = 0;
  priv2.send({ type: "set_sheet", sheetId: traceId });
  await sleep(500);
  check("set_sheet refuses a trace_ id (no cross-room photo replay)", !lastSheet(priv2.msgs) || lastSheet(priv2.msgs).sheetId !== traceId);
  priv2.ws.close();

  // 7) The public lobby never leaks a trace_ id (it's the access token).
  const lobby = await fetch(`${BASE}/api/rooms/public`).then((r) => r.json()).catch(() => ({ rooms: [] }));
  check("public lobby never exposes a trace_ sheetId", !(lobby.rooms || []).some((r) => String(r.sheetId || "").startsWith("trace_")));

  // 8) Rate-limit: 8 rapid uploads yield at most 6 accepted photos.
  const spammer = await connect("ZZTRACE3");
  spammer.msgs.length = 0;
  for (let i = 0; i < 8; i += 1) spammer.send({ type: "set_trace_photo", image: PNG });
  await sleep(900);
  const accepted = new Set(spammer.msgs.filter((m) => m.type === "sheet" && String(m.sheetId || "").startsWith("trace_")).map((m) => m.sheetId));
  check("rapid uploads are rate-limited (<= 6/min)", accepted.size <= 6, `accepted=${accepted.size}`);
  spammer.ws.close();

  // 9) Admin takedown removes the photo AND clears it from its room.
  const rm = await fetch(`${BASE}/api/admin/trace/${traceId}/remove`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY } });
  const gone = await fetch(`${BASE}/api/sheets/${traceId}`);
  check("admin takedown removes a reported trace photo", rm.ok && gone.status === 404);

  priv.ws.close(); pub.ws.close();

  // ---- Part B: browser (button gating + end-to-end overlay) ---------------
  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errors = [];
  for (const [tag, page] of [["A", pageA], ["B", pageB]]) {
    page.on("pageerror", (e) => errors.push(`${tag}: ${e}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${tag}: ${m.text()}`); });
  }

  // Button hidden in the hostless public room…
  await pageA.goto(`${BASE}/join/MAIN`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  check("Trace-a-photo button hidden in the hostless public room", !(await pageA.locator(".sheet-trace-btn").isVisible().catch(() => false)));

  // …and shown in a private "friends" room.
  await pageA.goto(`${BASE}/join/ZZTRACEB`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await pageB.goto(`${BASE}/join/ZZTRACEB`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  check("Trace-a-photo button shown in a private room", await pageA.locator(".sheet-trace-btn").isVisible().catch(() => false));

  // A uploads a real photo → B receives the traced overlay.
  // Write a small PNG to disk and set it on the hidden input.
  const pngFile = path.join(SCRATCH, "photo.png");
  const { writeFileSync } = await import("fs");
  writeFileSync(pngFile, Buffer.from(PNG.split(",")[1], "base64"));
  await pageA.locator(".sheet-trace-btn").click();
  await pageA.locator("input[type=file][accept='image/*']").setInputFiles(pngFile);
  await sleep(2500); // NSFW pre-check (returns null/low headless) + relay
  // B's sheet overlay is active once the sheet message arrives and its image
  // loads — the "Lines on top" toggle only renders when a sheet is set.
  const bHasSheet = await pageB.waitForFunction(() => {
    // the client stores the loaded sheet; a re-render draws it. Probe the toggle
    // that only appears once a sheet is active.
    return document.querySelector(".sheet-toggle") !== null;
  }, { timeout: 6000 }).then(() => true).catch(() => false);
  check("uploaded photo becomes a traced overlay for the other client", bHasSheet);

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
