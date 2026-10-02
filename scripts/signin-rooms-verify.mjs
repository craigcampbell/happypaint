/* eslint-env browser, node */
// Sign-in loop + "My rooms" + longer films, end to end, with NO real account.
//
// A mock PocketBase answers the server's token checks (tokens are fake JWTs;
// a payload id starting "BAD" is rejected). The browser gets the same fake
// sign-in seeded where the PocketBase SDK keeps it (localStorage
// "pocketbase_auth"), and every request to the real pb.drawesome.art is
// blocked, so nothing here ever touches production.
//
//   A. Signed in, opening a private room: ONE socket, the token in its very
//      first frame, no "needs an account" gate (the race that caused the loop).
//   B. A token the server rejects: "sign in again", not the sign-UP pitch.
//   C. A guest at a private room: both sign-in exits carry return=/join/CODE.
//   D. /rooms for a signed-in person: their rooms first, owner badge, their
//      OWN last chat line, never someone else's words.
//   E. /signup while signed in: continue / new room / sign out, no dead end.
//   F. API: 401 without a token, a stranger sees none of your private rooms or
//      their pictures.
//   G. Films: the public FLIPBOOK offers 240 frames, and a big private film
//      (> the old 20k reload trim) reloads with every op, frame 1 intact.
import { chromium } from "playwright";
import WebSocket from "ws";
import http from "http";
import { spawn } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(process.env.TEMP || "/tmp", "signin-rooms-verify-data");
const PORT = 8953;
const MOCK_PORT = 8954;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SIGNIN_SHOTS=<dir> saves screenshots of the gate, /rooms and the Rooms modal.
const SHOTS = process.env.SIGNIN_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const fakeToken = (id) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ id, type: "auth", collectionId: "users", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const idOf = (token) => { try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()).id; } catch { return null; } };

// ---- Mock PocketBase: just the token check the server makes -----------------
const mock = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/api/collections/users/auth-refresh")) {
    const id = idOf(req.headers.authorization);
    if (id && !id.startsWith("BAD")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: req.headers.authorization, record: { id, name: `Tester ${id}` } }));
      return;
    }
  }
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end("{}");
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

// ---- A big private film on disk, before boot (G) ----------------------------
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(path.join(SCRATCH, ".rooms"), { recursive: true });
{
  const frames = [];
  const history = [];
  for (let f = 0; f < 50; f += 1) {
    frames.push({ id: `f${100 + f}`, durationMs: 120, sceneId: "s0", layers: [{ id: "L0", name: "Canvas", visible: true, opacity: 1, locked: false }] });
    for (let k = 0; k < 500; k += 1) {
      history.push({ kind: "draw", frameId: `f${100 + f}`, layerId: "L0", strokeId: `b${f}-${k}`, points: [{ x: 10 + k, y: 10 + f }, { x: 20 + k, y: 20 + f }], settings: { brush: "marker", color: "#111827", size: 8 }, end: true, userId: "seed", opId: history.length + 1 });
    }
  }
  writeFileSync(path.join(SCRATCH, ".rooms", "ZZBIGANM.json"), JSON.stringify({ audience: "friends", listed: false, animation: true, frames, scenes: [{ id: "s0", name: "Scene 1" }], opCount: history.length, savedAt: Date.now() }));
  writeFileSync(path.join(SCRATCH, ".rooms", "ZZBIGANM.history.json"), JSON.stringify({ history }));
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, PB_URL: `http://127.0.0.1:${MOCK_PORT}`, POCKETBASE_URL: "", ADMIN_KEY: "signin-rooms-test-key" },
  stdio: "pipe",
});
server.stderr.on("data", (d) => { if (process.env.SRV_LOG) process.stderr.write("[srv] " + d); });

function connectRaw(room, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
    const msgs = [];
    ws.on("message", (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* binary */ } });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token: token || null, userKey: `dk_signin${Math.random().toString(36).slice(2, 10)}` }));
      setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 900);
    });
  });
}
const api = async (p, token) => {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

const run = async () => {
  for (let i = 0; i < 60; i += 1) { try { if ((await fetch(BASE + "/")).ok) break; } catch { /* boot */ } await sleep(250); }
  const U1 = fakeToken("u1test");
  const U2 = fakeToken("u2test");
  const U3 = fakeToken("u3test");
  const BAD = fakeToken("BADtoken");

  const browser = await chromium.launch({ headless: true });
  const newPage = async (token) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.route(/pb\.drawesome\.art/, (route) => route.abort()); // never touch production
    if (token) {
      await ctx.addInitScript(([t, id]) => {
        window.localStorage.setItem("pocketbase_auth", JSON.stringify({ token: t, record: { id, collectionId: "users", collectionName: "users", name: `Tester ${id}`, email: `${id}@example.test` } }));
      }, [token, idOf(token)]);
    }
    const page = await ctx.newPage();
    return { ctx, page };
  };
  const gateText = async (page) => (await page.locator(".studio-modal h2").allTextContents()).join(" | ");

  // ---- A. signed in → private room: one socket, token first, no gate --------
  {
    const { ctx, page } = await newPage(U1);
    const sockets = [];
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws?")) return;
      const entry = { url: ws.url(), sent: [] };
      sockets.push(entry);
      ws.on("framesent", (f) => entry.sent.push(f.payload));
    });
    await page.goto(`${BASE}/join/ZZPRIVA`, { waitUntil: "domcontentloaded" });
    await sleep(4500);
    const first = sockets[0] ? JSON.parse(sockets[0].sent[0] || "{}") : {};
    check("A: a signed-in person opens exactly ONE room socket (no guest-first attempt)", sockets.length === 1, `sockets=${sockets.length}`);
    check("A: its very first frame carries the sign-in token", first.type === "auth" && first.token === U1);
    const gate = await gateText(page);
    check("A: no 'needs an account' gate over the private room", !/Private rooms need|sign you in again/i.test(gate), gate || "(none)");
    await ctx.close();
  }

  // Seed chat + visits for D/F: u1 owns ZZPRIVA (first signed-in in) and chats;
  // u2 chats there too; u1 also paints in public MAIN.
  const a1 = await connectRaw("ZZPRIVA", U1);
  a1.send({ type: "chat", message: "hello from u1" });
  const a2 = await connectRaw("ZZPRIVA", U2);
  a2.send({ type: "chat", message: "secret from u2" });
  const m1 = await connectRaw("MAIN", U1);
  m1.send({ type: "chat", message: "u1 in main" });
  await sleep(800);
  a1.ws.close(); a2.ws.close(); m1.ws.close();
  await sleep(600);

  // ---- B. a rejected token → "sign in again" ------------------------------
  {
    const { ctx, page } = await newPage(BAD);
    await page.goto(`${BASE}/join/ZZPRIVB`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".studio-modal h2", { timeout: 8000 }).catch(() => {});
    await shot(page, "gate-sign-in-again.png");
    const gate = await gateText(page);
    check("B: a rejected sign-in gets 'sign in again', not the sign-up pitch", /sign you in again/i.test(gate), gate);
    await ctx.close();
  }

  // ---- C. guest → the exits come back to this room -------------------------
  {
    const { ctx, page } = await newPage(null);
    await page.goto(`${BASE}/join/ZZPRIVC`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Private rooms need a free account", { timeout: 8000 }).catch(() => {});
    await shot(page, "gate-guest.png");
    check("C: a guest at a private room sees the account gate", /Private rooms need/i.test(await gateText(page)));
    await page.click("text=I already have an account");
    await page.waitForURL(/\/signup/, { timeout: 8000 }).catch(() => {});
    const url = new URL(page.url());
    check("C: 'I already have an account' opens LOG IN with a way back to this room",
      url.searchParams.get("mode") === "login" && url.searchParams.get("return") === "/join/ZZPRIVC", url.pathname + url.search);
    const h1 = await page.locator("h1").first().textContent();
    check("C: …and the page says 'Welcome back'", /Welcome back/i.test(h1 || ""), h1);
    await ctx.close();
  }

  // ---- D. /rooms: my rooms first, my own words only -------------------------
  {
    const { ctx, page } = await newPage(U1);
    await page.goto(`${BASE}/rooms`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".myroom", { timeout: 10000 }).catch(() => {});
    const body = await page.locator("body").innerText();
    const cards = await page.locator(".myroom").allInnerTexts();
    const priv = cards.find((c) => c.includes("ZZPRIVA")) || "";
    check("D: /rooms opens with 'Pick up where you left off'", body.includes("Pick up where you left off"));
    check("D: my private room is there, marked as mine", /👑 Yours/.test(priv) && /Private/.test(priv), priv.replace(/\n/g, " ").slice(0, 160));
    check("D: it shows MY last chat line there", priv.includes("hello from u1"));
    check("D: never someone else's words", !body.includes("secret from u2"));
    check("D: rooms I painted in publicly are listed too", cards.some((c) => c.includes("MAIN")));
    await shot(page, "rooms-explorer.png");
    // The studio Rooms modal shows the same list (compact rows).
    await page.goto(`${BASE}/join/MAIN`, { waitUntil: "domcontentloaded" });
    await sleep(3500);
    await page.locator(".mp-room-switch").first().click().catch(() => {}); // the room-name pill opens the lobby on desktop
    await page.waitForSelector(".lobby-modal .myroom", { timeout: 8000 }).catch(() => {});
    const modal = await page.locator(".lobby-modal").innerText().catch(() => "");
    check("D: the studio Rooms modal lists my rooms with Continue", modal.includes("ZZPRIVA") && modal.includes("Continue"));
    await shot(page, "rooms-modal.png");
    await ctx.close();
  }

  // ---- E. /signup while signed in: no dead end -------------------------------
  {
    const { ctx, page } = await newPage(U1);
    await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Continue to my rooms", { timeout: 8000 }).catch(() => {});
    const text = await page.locator("main").innerText();
    check("E: signed-in /signup offers continue + sign out", /You.re signed in/.test(text) && /Continue to my rooms/.test(text) && /Sign out/.test(text));
    await ctx.close();
  }

  // ---- F. the API's gates ---------------------------------------------------
  {
    const anon = await api("/api/me/rooms");
    check("F: /api/me/rooms needs a sign-in", anon.status === 401, `status=${anon.status}`);
    const mine = await api("/api/me/rooms", U1);
    const priv = (mine.body?.rooms || []).find((r) => r.code === "ZZPRIVA");
    check("F: the owner's list has the room as 'owner' with their own chat", priv?.role === "owner" && priv?.myLastChat?.message === "hello from u1", JSON.stringify(priv || {}).slice(0, 160));
    const theirs = await api("/api/me/rooms", U2);
    const seen = (theirs.body?.rooms || []).find((r) => r.code === "ZZPRIVA");
    check("F: a visitor's list has it as 'visited' with THEIR line", seen?.role === "visited" && seen?.myLastChat?.message === "secret from u2");
    const stranger = await api("/api/me/rooms", U3);
    check("F: a stranger sees none of it", stranger.status === 200 && !(stranger.body?.rooms || []).some((r) => r.code === "ZZPRIVA"));
    const pic = await api("/api/me/rooms/ZZPRIVA/thumb", U3);
    check("F: …nor its picture", pic.status === 404, `status=${pic.status}`);
    const badTok = await api("/api/me/rooms", BAD);
    check("F: a rejected token is a 401", badTok.status === 401);
  }

  // ---- G. films -------------------------------------------------------------
  {
    const flip = await connectRaw("FLIPBOOK", null);
    const hello = flip.msgs.find((m) => m.type === "connected");
    check("G: the public FLIPBOOK offers 240 frames", hello?.animMaxFrames === 240, `animMaxFrames=${hello?.animMaxFrames}`);
    flip.ws.close();
    const big = await connectRaw("ZZBIGANM", U1);
    await sleep(1500);
    const hist = big.msgs.filter((m) => Array.isArray(m.ops)).sort((x, y) => y.ops.length - x.ops.length)[0];
    const ops = hist ? hist.ops : [];
    check("G: a 25,000-op private film reloads WHOLE (the old reload trim kept 20,000)", ops.length === 25000, `ops=${ops.length}`);
    check("G: …frame 1 still has its drawing", ops.filter((o) => o.frameId === "f100").length === 500);
    big.ws.close();
  }

  await browser.close();
};

run()
  .catch((e) => check("harness", false, String(e && e.stack || e).slice(0, 400)))
  .finally(() => {
    server.kill();
    mock.close();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  });
