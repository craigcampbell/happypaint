// Seasonal server verification (Inktober / Spooky / Paint Jar / seasonal wall).
//
// Isolated: real server.js booted on port 8951 with a throwaway DATA_DIR and a
// test clock file (INKTOBER_CLOCK_FILE, test-only hook) so upcoming / active /
// ended phases and the LIVE day rollover are exercised without waiting for
// real dates. Never points at port 8787 or the production app_data.
//
// Covers the seasonal contract's backend surface:
//   GET /api/inktober shape + phases (no false day stamping before October)
//   FEATURED order MAIN, INKTOBER, …; SPOOKY replaces DINOS discovery;
//   DINOS files protected from the idle sweep; DINOS/INKTOBER off the wipe cycle
//   INKTOBER room: inkOnly handshake + event state, ink/pencil-only ops
//     (native v3 inline dabs allowed, forged dabs rejected, eraser allowed,
//     shape/text/image/sheet/wipe-sheet-substitution/animation bypasses denied)
//   live UTC rollover -> seasonal_prompt broadcast, mural NOT destroyed,
//     reconnect/reload sees new prompt + full history
//   wall: server-assigned event/day/prompt/challenge/tag, ?event&day filters,
//     tag-spoof rejection, event metadata preserved in reads
//   GET /api/paintjar aggregate shape, <5 country suppression, no client-trusted
//     location, privacy-safe response keys
//   SEO: /inktober + /paintjar head overrides
import { spawn } from "child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, copyFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRATCH = path.join(process.env.TMPDIR || "/tmp", "seasonal-server-verify-data");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const PORT = 8951;
const BASE = `http://localhost:${PORT}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });

// Pre-seed an OLD DINOS room file: a retired room's art must survive the idle
// auto-close sweep (files protected) even though DINOS leaves public discovery.
mkdirSync(path.join(SCRATCH, ".rooms"), { recursive: true });
writeFileSync(path.join(SCRATCH, ".rooms", "DINOS.json"), JSON.stringify({
  audience: "kid_safe", listed: true, title: "Dino World", opCount: 1,
  savedAt: Date.now() - 40 * 86400000, createdAt: Date.now() - 60 * 86400000,
}));
writeFileSync(path.join(SCRATCH, ".rooms", "DINOS.history.json"), JSON.stringify({
  history: [{ kind: "draw", strokeId: "dino1", points: [{ x: 1, y: 1 }], userId: "u_old", opId: 1 }],
}));

const setClock = (iso) => writeFileSync(CLOCK_FILE, iso);
setClock("2026-09-15T12:00:00.000Z"); // before October: the warm-up phase

// A stub dist/ so the SPA fallback (and its per-route SEO head rewrite) exists
// without building the app. Removed afterwards only if WE created it.
const distDir = path.join(ROOT, "dist");
const madeStubDist = !existsSync(path.join(distDir, "index.html"));
if (madeStubDist) {
  mkdirSync(distDir, { recursive: true });
  copyFileSync(path.join(ROOT, "index.html"), path.join(distDir, "index.html"));
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: SCRATCH,
    INKTOBER_CLOCK_FILE: CLOCK_FILE,
    INKTOBER_TICK_MS: "150",
    AUTO_CLOSE_SWEEP_MS: "700",
    AUTO_CLOSE_BASE_MS: "1000",
  },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

let WebSocket;
const clients = [];
async function connect(room, { headers = {}, spectate = false } = {}) {
  const qs = spectate ? `room=${room}&spectate=1` : `room=${room}`;
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?${qs}`, { headers });
  const c = { ws, msgs: [], room };
  ws.on("message", (raw) => { try { c.msgs.push(JSON.parse(raw.toString())); } catch { /* binary/gz */ } });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  if (!spectate) ws.send(JSON.stringify({ type: "auth", token: null, userKey: `dk_${Math.random().toString(36).slice(2, 12)}` }));
  await sleep(350); // let the join + history land (see skill: raw clients shake hands first)
  clients.push(c);
  return c;
}
const lastOf = (c, type) => [...c.msgs].reverse().find((m) => m.type === type);
const allOf = (c, type) => c.msgs.filter((m) => m.type === type);
async function waitFor(c, pred, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = c.msgs.find(pred);
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}
async function wallPost(body) {
  return fetch(`${BASE}/api/wall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frames: [PNG], durationMs: 400, artist: "Testy", ...body }),
  }).then((r) => r.json());
}

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }
  ({ WebSocket } = await import("ws"));

  // ---- /api/inktober: warm-up phase (September clock) ----------------------
  const api0 = await fetch(`${BASE}/api/inktober`).then((r) => r.json());
  check("/api/inktober returns the contracted shape", !!api0
    && api0.year === 2026 && api0.room === "INKTOBER"
    && api0.source === "https://inktober.com/rules"
    && Array.isArray(api0.prompts) && api0.prompts.length === 31
    && api0.prompts.every((p) => Number.isInteger(p.day) && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.prompt === "string"),
    JSON.stringify(api0).slice(0, 140));
  check("before October the phase is upcoming with NO false day stamp",
    api0.phase === "upcoming" && api0.day === null && /^\d{4}-\d{2}-\d{2}$/.test(api0.date)
    && typeof api0.prompt === "string" && api0.prompt.length > 0
    && api0.nextChangeAt === "2026-10-01T00:00:00.000Z",
    `phase=${api0.phase} day=${api0.day} next=${api0.nextChangeAt}`);

  // ---- Lobby discovery ------------------------------------------------------
  const lobby = await fetch(`${BASE}/api/rooms/public`).then((r) => r.json());
  const codes = (lobby.rooms || []).map((r) => r.code);
  check("FEATURED order leads MAIN then INKTOBER", codes[0] === "MAIN" && codes[1] === "INKTOBER", codes.slice(0, 4).join(","));
  check("SPOOKY (friendly Halloween) is discoverable", codes.includes("SPOOKY"));
  check("DINOS is excluded from public discovery", !codes.includes("DINOS"));
  const inkLobby = (lobby.rooms || []).find((r) => r.code === "INKTOBER");
  check("INKTOBER lobby card: Ink & Pencil title, warm-up prompt, no wipe cycle",
    !!inkLobby && inkLobby.title === "Ink & Pencil" && typeof inkLobby.prompt === "string"
    && inkLobby.prompt.includes(api0.prompt) && !inkLobby.wipeAt,
    inkLobby && `${inkLobby.title} | ${inkLobby.prompt} | wipeAt=${inkLobby.wipeAt}`);

  // ---- DINOS: files protected, still joinable, off the wipe cycle ----------
  await sleep(1600); // let a couple of idle sweeps run (AUTO_CLOSE_SWEEP_MS=700)
  check("retired DINOS room files survive the idle sweep",
    existsSync(path.join(SCRATCH, ".rooms", "DINOS.json")) && existsSync(path.join(SCRATCH, ".rooms", "DINOS.history.json")));
  const dino = await connect("DINOS");
  check("DINOS still joins directly (old mural loads, no auto wipe)",
    !!lastOf(dino, "connected") && lastOf(dino, "connected").wipe == null
    && (lastOf(dino, "history")?.ops || []).length === 1,
    `ops=${(lastOf(dino, "history")?.ops || []).length}`);

  // ---- INKTOBER handshake ----------------------------------------------------
  const a = await connect("INKTOBER");
  const b = await connect("INKTOBER");
  const conn = lastOf(a, "connected");
  check("connected handshake carries inkOnly + the same event state",
    !!conn && conn.inkOnly === true && conn.event && conn.event.phase === "upcoming"
    && conn.event.year === 2026 && conn.event.room === "INKTOBER"
    && typeof conn.prompt === "string" && conn.prompt.includes(api0.prompt),
    conn && `inkOnly=${conn.inkOnly} phase=${conn.event && conn.event.phase}`);
  check("INKTOBER has no 3-day wipe countdown", conn && conn.wipe == null);

  // ---- Ink/pencil enforcement -------------------------------------------------
  let strokeSeq = 0;
  const sendDraw = (c, settings, points = [{ x: 10, y: 10 }, { x: 20, y: 20 }], end = true) => {
    strokeSeq += 1;
    c.ws.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: `s${strokeSeq}`, settings, points, end } }));
    return `s${strokeSeq}`;
  };
  const gotOp = async (c, strokeId, ms = 900) => waitFor(c, (m) => m.type === "op" && m.op && m.op.strokeId === strokeId, ms);

  sendDraw(a, { brush: "ink", v: 2, color: "#111111", size: 6 });
  check("plain ink stroke relays", !!(await gotOp(b, `s${strokeSeq}`)));

  sendDraw(a, { brush: "pencil", v: 3, color: "#333333", size: 4, dab: { spacing: 0.16, minSize: 0.12, flow: 0.72, shape: "graphite", scatter: 0.05, aspect: 1.15, grain: 0.14, blend: "multiply" } });
  check("native v3 pencil inline dab relays", !!(await gotOp(b, `s${strokeSeq}`)));

  sendDraw(a, { brush: "eraser", color: "#000000", size: 20 });
  check("eraser (tool draw eraser settings) is NOT blocked", !!(await gotOp(b, `s${strokeSeq}`)));

  sendDraw(a, { brush: "marker", v: 2, color: "#ff0000", size: 6 });
  check("marker stroke is rejected in the ink room", !(await gotOp(b, `s${strokeSeq}`)));

  sendDraw(a, { brush: "ink", v: 3, color: "#111111", size: 30, dab: { spacing: 0.13, minSize: 0.34, flow: 0.17, shape: "wash", blend: "multiply", mixModel: "km" } });
  check("forged non-ink dab settings (ink brush + watercolor wash dab) rejected", !(await gotOp(b, `s${strokeSeq}`)));

  sendDraw(a, { brush: "pencil", v: 3, color: "#333333", size: 30, dab: { spacing: 0.1, minSize: 0.3, flow: 1, shape: "glow" } });
  check("forged dab shape on pencil (glow) rejected", !(await gotOp(b, `s${strokeSeq}`)));

  sendDraw(a, { brush: "pencil", v: 3, color: "#333333", size: 6, dab: { shape: "stamp", stampDataUrl: PNG } });
  check("imported stamp dab rejected", !(await gotOp(b, `s${strokeSeq}`)));

  // settings-less continuation of an allowed stroke still relays (legacy repair path)
  strokeSeq += 1;
  const contId = `s${strokeSeq}`;
  a.ws.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: contId, settings: { brush: "ink", v: 2, color: "#111", size: 5 }, points: [{ x: 1, y: 1 }] } }));
  a.ws.send(JSON.stringify({ type: "op", op: { kind: "draw", strokeId: contId, points: [{ x: 2, y: 2 }], end: true } }));
  check("settings-less continuation batch of an ink stroke relays",
    (await waitFor(b, (m) => m.type === "op" && m.op && m.op.strokeId === contId, 1200), allOf(b, "op").filter((m) => m.op.strokeId === contId).length) >= 1);

  // settings-less stroke with NO known ink/pencil origin is refused
  sendDraw(a, null);
  check("draw op with no settings and no stroke origin rejected", !(await gotOp(b, `s${strokeSeq}`)));

  // ---- Bypass op kinds ---------------------------------------------------------
  a.ws.send(JSON.stringify({ type: "op", op: { kind: "shape", shape: "rect", x: 0, y: 0, w: 10, h: 10 } }));
  a.ws.send(JSON.stringify({ type: "op", op: { kind: "text", text: "hello", x: 5, y: 5 } }));
  a.ws.send(JSON.stringify({ type: "op", op: { kind: "image", dataUrl: PNG, x: 0, y: 0 } }));
  await sleep(500);
  check("shape / text / image ops are all rejected in the ink room",
    !b.msgs.some((m) => m.type === "op" && m.op && ["shape", "text", "image"].includes(m.op.kind)));

  a.ws.send(JSON.stringify({ type: "set_sheet", sheetId: "lib:some-sheet" }));
  await sleep(400);
  check("set_sheet is rejected in the ink room", !b.msgs.some((m) => m.type === "sheet"));
  const freshJoin = await connect("INKTOBER");
  check("a fresh joiner is not handed a sheet either", !freshJoin.msgs.some((m) => m.type === "sheet"));

  a.ws.send(JSON.stringify({ type: "wipe_request", sheetId: "lib:other-sheet" }));
  await sleep(500);
  check("wipe_request sheet substitution is rejected", !allOf(b, "wipe_req").length);

  a.ws.send(JSON.stringify({ type: "set_animation", enabled: true }));
  await sleep(400);
  check("animation opt-in is rejected in the ink room", !allOf(b, "room_animation").length);

  // ---- Live rollover: Sep 30 -> Oct 1 -> Oct 2, mural preserved -----------------
  const spec = await connect("INKTOBER", { spectate: true });
  setClock("2026-10-01T12:00:00.000Z");
  const roll1 = await waitFor(a, (m) => m.type === "seasonal_prompt", 3000);
  check("live rollover into October broadcasts seasonal_prompt to members",
    !!roll1 && roll1.prompt === "Apple" && roll1.event && roll1.event.phase === "active" && roll1.event.day === 1,
    roll1 && `${roll1.prompt} day=${roll1.event && roll1.event.day}`);
  const specRoll = await waitFor(spec, (m) => m.type === "seasonal_prompt", 3000);
  check("…and to connected spectators (homepage previews)", !!specRoll && specRoll.prompt === "Apple");

  setClock("2026-10-02T00:30:00.000Z");
  const roll2 = await waitFor(a, (m) => m.type === "seasonal_prompt" && m.event && m.event.day === 2, 3000);
  check("the UTC day flip rolls the prompt live (day 2)", !!roll2 && roll2.prompt === "Relic",
    roll2 && roll2.prompt);

  const apiActive = await fetch(`${BASE}/api/inktober`).then((r) => r.json());
  check("/api/inktober agrees mid-event (active, day 2, next midnight)",
    apiActive.phase === "active" && apiActive.day === 2 && apiActive.prompt === "Relic"
    && apiActive.nextChangeAt === "2026-10-03T00:00:00.000Z",
    `${apiActive.phase} day=${apiActive.day} next=${apiActive.nextChangeAt}`);

  // Reconnect/reload: full history + new prompt, mural NOT destroyed by rollover
  const c2 = await connect("INKTOBER");
  const hist2 = lastOf(c2, "history");
  const conn2 = lastOf(c2, "connected");
  check("reconnect after rollover: ink history intact + fresh prompt/day",
    !!hist2 && hist2.ops.some((m) => m.strokeId === "s1") && hist2.ops.some((m) => m.kind === "draw")
    && !!conn2 && conn2.inkOnly === true && conn2.event.day === 2 && conn2.prompt.includes("Relic"),
    `ops=${hist2 ? hist2.ops.length : "?"} day=${conn2 && conn2.event && conn2.event.day}`);

  // ---- Wall: server-assigned event metadata -------------------------------------
  setClock("2026-10-05T09:00:00.000Z");
  await sleep(400); // one tick so the event state is active day 5
  const inkPost = await wallPost({ title: "Ink day 5", tags: ["fun"], userKey: "dk_inkposter1", room: "INKTOBER" });
  check("wall post from INKTOBER accepted", !!inkPost.ok, JSON.stringify(inkPost));
  const byId = await fetch(`${BASE}/api/wall/${inkPost.id}`).then((r) => r.json());
  check("event metadata is server-assigned + preserved in reads",
    byId.post && byId.post.event === "inktober-2026" && byId.post.eventDay === 5
    && byId.post.eventPrompt === "Smack" && byId.post.challenge === "2026-10-05"
    && byId.post.tags.includes("inktober"),
    byId.post && `event=${byId.post.event} day=${byId.post.eventDay} prompt=${byId.post.eventPrompt} challenge=${byId.post.challenge}`);

  const evFeed = await fetch(`${BASE}/api/wall?event=inktober-2026&sort=new`).then((r) => r.json());
  check("?event=inktober-2026 filters the feed", (evFeed.posts || []).some((p) => p.id === inkPost.id));
  const dayFeed = await fetch(`${BASE}/api/wall?event=inktober-2026&day=5&sort=new`).then((r) => r.json());
  check("?event&day=5 filters to that prompt day", (dayFeed.posts || []).some((p) => p.id === inkPost.id));
  const otherDay = await fetch(`${BASE}/api/wall?event=inktober-2026&day=6&sort=new`).then((r) => r.json());
  check("?event&day=6 excludes day-5 art", !(otherDay.posts || []).some((p) => p.id === inkPost.id));

  const spoof = await wallPost({ title: "Not ink", tags: ["inktober"], userKey: "dk_spoof1", room: "MAIN" });
  const spoofById = await fetch(`${BASE}/api/wall/${spoof.id}`).then((r) => r.json());
  check("a non-INKTOBER post cannot forge the inktober tag or event",
    !!spoof.ok && spoofById.post && !spoofById.post.tags.includes("inktober") && spoofById.post.event == null,
    spoofById.post && JSON.stringify(spoofById.post.tags));
  const evFeed2 = await fetch(`${BASE}/api/wall?event=inktober-2026&sort=new&limit=60`).then((r) => r.json());
  check("event filter is not spoofable through the tag", !(evFeed2.posts || []).some((p) => p.id === spoof.id));

  // Upcoming phase: event still stamped, but no day / no challenge date.
  setClock("2026-09-20T09:00:00.000Z");
  await sleep(400);
  const warmPost = await wallPost({ title: "Warm-up ink", tags: [], userKey: "dk_inkposter2", room: "INKTOBER" });
  const warmById = await fetch(`${BASE}/api/wall/${warmPost.id}`).then((r) => r.json());
  check("warm-up wall post: event stamped, day + challenge null",
    !!warmPost.ok && warmById.post && warmById.post.event === "inktober-2026"
    && warmById.post.eventDay === null && warmById.post.challenge == null,
    warmById.post && `day=${warmById.post.eventDay} challenge=${warmById.post.challenge}`);

  // Ended phase: /api/inktober reports ended.
  setClock("2026-11-02T09:00:00.000Z");
  await sleep(400);
  const apiEnd = await fetch(`${BASE}/api/inktober`).then((r) => r.json());
  check("after October the phase is ended (day null, no next change)",
    apiEnd.phase === "ended" && apiEnd.day === null && apiEnd.nextChangeAt === null && typeof apiEnd.prompt === "string",
    `phase=${apiEnd.phase}`);
  setClock("2026-10-05T09:00:00.000Z"); // back inside the event for the rest
  await sleep(400);

  // ---- Paint Jar -----------------------------------------------------------------
  const jar0 = await fetch(`${BASE}/api/paintjar`).then((r) => r.json());
  check("/api/paintjar aggregate shape + illustrative paper equivalent",
    !!jar0 && Number.isInteger(jar0.strokes) && jar0.strokes >= 1
    && Number.isInteger(jar0.sessions) && jar0.sessions >= 1
    && Array.isArray(jar0.countries)
    && jar0.paperEquivalent && jar0.paperEquivalent.strokesPerSheet === 1000
    && jar0.paperEquivalent.sheets === Math.floor(jar0.strokes / 1000)
    && typeof jar0.disclaimer === "string" && /not unique people/i.test(jar0.disclaimer)
    && typeof jar0.updatedAt === "string",
    `strokes=${jar0.strokes} sessions=${jar0.sessions}`);
  check("paintjar leaks no sessions/users/IDs/room metadata",
    ["sessions", "users", "rooms", "ids"].every((k) => k === "sessions" || jar0[k] === undefined)
    && Object.keys(jar0).sort().join(",") === "countries,disclaimer,paperEquivalent,sessions,strokes,updatedAt",
    Object.keys(jar0).join(","));

  // Country aggregation: 5 proxy-header NZ visitors surface; 1 AQ visitor is
  // suppressed (<5); a client-SUPPLIED country is never trusted.
  for (let i = 0; i < 5; i += 1) await connect("MAIN", { headers: { "cf-ipcountry": "NZ" } });
  await connect("MAIN", { headers: { "cf-ipcountry": "AQ" } });
  const spoofer = await connect("MAIN");
  spoofer.ws.send(JSON.stringify({ type: "client_info", country: "US", timezone: "America/Chicago" }));
  await sleep(400);
  const jar1 = await fetch(`${BASE}/api/paintjar`).then((r) => r.json());
  const nz = (jar1.countries || []).find((c) => c.code === "NZ");
  check("proxy-country groups of 5+ surface", !!nz && nz.count >= 5, JSON.stringify(jar1.countries));
  check("country groups under 5 are omitted", !(jar1.countries || []).some((c) => c.code === "AQ"));
  check("client-supplied location is never trusted", !(jar1.countries || []).some((c) => c.code === "US"));

  // ---- SEO -------------------------------------------------------------------------
  const inkHtml = await fetch(`${BASE}/inktober`).then((r) => r.text());
  check("/inktober serves a route-specific SEO head",
    /<title[^>]*>[^<]*[Ii]nktober/.test(inkHtml) && inkHtml.includes('data-seo="canonical"')
    && /inktober/i.test(inkHtml.match(/data-seo="canonical"[^>]*|href="[^"]*"[^>]*data-seo="canonical"/)?.[0] || "inktober"),
    (inkHtml.match(/<title[^>]*>[^<]*<\/title>/) || ["?"])[0]);
  check("inktober SEO copy claims independence (no endorsement)",
    /not affiliated|independent|no endorsement|unofficial/i.test(inkHtml));
  const jarHtml = await fetch(`${BASE}/paintjar`).then((r) => r.text());
  check("/paintjar serves a route-specific SEO head", /<title[^>]*>[^<]*[Pp]aint ?[Jj]ar/.test(jarHtml),
    (jarHtml.match(/<title[^>]*>[^<]*<\/title>/) || ["?"])[0]);

  // ---- Anonymous path intact ---------------------------------------------------------
  const anon = await fetch(`${BASE}/api/rooms/public`).then((r) => r.json());
  check("anonymous-first lobby still healthy after seasonal changes", (anon.rooms || []).length > 3);
};

run().catch((e) => { console.error("VERIFY CRASHED:", e); results.push({ name: "run", ok: false }); })
  .finally(async () => {
    for (const c of clients) { try { c.ws.close(); } catch { /* gone */ } }
    server.kill("SIGTERM");
    await sleep(400);
    try { server.kill("SIGKILL"); } catch { /* gone */ }
    if (madeStubDist) {
      try { rmSync(distDir, { recursive: true, force: true }); } catch { /* leave */ }
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
