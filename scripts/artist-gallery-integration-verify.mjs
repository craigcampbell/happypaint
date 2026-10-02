// Artist gallery route/nav + Inktober discoverability: INTEGRATION verify.
/* global window */
//
// Unlike scripts/artist-gallery-ui-verify.mjs (SYNTHETIC fixtures), this suite
// uses ONLY the real stack:
//   * mock PocketBase (throwaway port), the only endpoint server.js calls is
//     POST /api/collections/users/auth-refresh; the browser never calls PB
//     because the session is seeded into localStorage as the SDK's own record.
//   * real server.js on :8966 with an isolated DATA_DIR, rooms are created
//     and PUBLISHED through the real REST API (docs/ARTIST-ROOMS-CONTRACT.md).
//   * real Vite dev server on :8967 serving the REAL Router (/gallery route),
//     SiteNav, InktoberPage and ArtistGalleryPage. Playwright proxies /api/**
//     to the real server (Vite has no proxy config), no route is stubbed.
//
// Covers:
//   /gallery route renders real published studios; search/tag/event filters
//   hit the real API; deep link /gallery?event=inktober-2026 pre-filters;
//   guests get the sign-in note and CANNOT create (UI + real 401);
//   an authenticated browser (real session -> real Bearer token) creates a
//   REAL artist room, which the server then knows but does NOT list;
//   SiteNav links Gallery; Inktober page lists participating artist studios
//   from the real event-filtered gallery and its browse link lands on a
//   pre-filtered /gallery.
//
// Never prod: server :8966, vite :8967, mock PB ephemeral (prod is :8787).
// Run: node scripts/artist-gallery-integration-verify.mjs
import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import http from "http";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRATCH = path.join(os.tmpdir(), "artist-gallery-integration-data");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const API_PORT = 8966;
const UI_PORT = 8967;
const API = `http://127.0.0.1:${API_PORT}`;
const UI = `http://127.0.0.1:${UI_PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(CLOCK_FILE, "2026-10-05T09:00:00.000Z"); // active October

// ---- mock PocketBase --------------------------------------------------------
// HS256-shaped JWT (only shape + exp matter to the client SDK; the server
// delegates verification to this mock via auth-refresh).
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const OWNER_JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id: "artist_owner1", type: "authRecord", collectionId: "_pb_users_auth_", exp })}.integsig`;
const OWNER_RECORD = {
  id: "artist_owner1", collectionId: "_pb_users_auth_", collectionName: "users",
  email: "olivia@example.test", name: "Olivia Owner", verified: true,
  created: "2026-09-01T00:00:00.000Z", updated: "2026-09-01T00:00:00.000Z",
};
const TOKENS = { [OWNER_JWT]: { id: OWNER_RECORD.id, name: OWNER_RECORD.name } };

const mock = http.createServer((req, res) => {
  if (req.url === "/api/collections/users/auth-refresh" && req.method === "POST") {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const rec = TOKENS[raw];
    if (rec) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ record: rec }));
      return;
    }
    res.writeHead(401).end("{}");
    return;
  }
  res.writeHead(404).end("{}");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const PB = `http://127.0.0.1:${mock.address().port}`;

// ---- processes ----------------------------------------------------------------
const procs = [];
const spawnProc = (args, opts, tag) => {
  const p = spawn(args[0], args.slice(1), { cwd: ROOT, stdio: "pipe", ...opts });
  p.stderr.on("data", (d) => process.stderr.write(`[${tag}] ` + d));
  procs.push(p);
  return p;
};
for (const port of [API_PORT, UI_PORT]) { // squatters from a crashed run
  try { execSync(`fuser -k ${port}/tcp`, { stdio: "pipe" }); } catch { /* free */ }
}
spawnProc([process.execPath, "server.js"], {
  env: {
    ...process.env,
    PORT: String(API_PORT),
    DATA_DIR: SCRATCH,
    PB_URL: PB,
    INKTOBER_CLOCK_FILE: CLOCK_FILE,
    INKTOBER_TICK_MS: "150",
  },
}, "srv");
spawnProc([process.execPath, path.join(ROOT, "node_modules/vite/bin/vite.js"),
  "--port", String(UI_PORT), "--strictPort", "--host", "127.0.0.1"], {
  env: { ...process.env, VITE_PB_URL: PB },
}, "vite");

// ---- harness ------------------------------------------------------------------
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ": " + String(detail).slice(0, 220) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* boot */ }
    await sleep(250);
  }
  return false;
}
async function api(pathname, { method = "GET", token = null, body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method, headers, body: body == null ? null : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* gone */ }
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  try { mock.close(); } catch { /* gone */ }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
};
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

const run = async () => {
  if (!(await waitUp(API + "/healthz"))) throw new Error("server.js did not boot on " + API_PORT);
  if (!(await waitUp(UI + "/"))) throw new Error("vite dev did not boot on " + UI_PORT);

  // ---- eslint on the owned files --------------------------------------------
  let lintOut = "";
  try {
    execSync("npx eslint src/Router.jsx src/components/SiteNav.jsx src/components/InktoberPage.jsx src/components/ArtistGalleryRoute.jsx src/components/ArtistGalleryPage.jsx --max-warnings 0", { cwd: ROOT, stdio: "pipe" });
  } catch (e) { lintOut = String(e.stdout || e.message).slice(0, 400); }
  check("eslint zero-warnings on owned files", lintOut === "", lintOut);

  // ================= real API setup: create + publish studios =================
  const anonCreate = await api("/api/rooms", { method: "POST", body: { audience: "artist_public", title: "Nope" } });
  check("real API: guest creation refused (accounts_required)",
    anonCreate.status === 401 && anonCreate.json?.error === "accounts_required", JSON.stringify(anonCreate));

  const mk = await api("/api/rooms", {
    method: "POST", token: OWNER_JWT,
    body: { audience: "artist_public", title: "Coastal Studies", description: "Slow seascapes in ink.", tags: ["seascape", "ink"] },
  });
  check("real API: verified owner creates studio A", mk.status === 200 && /^[A-Z0-9]{6}$/.test(mk.json?.code || ""), JSON.stringify(mk));
  const RA = mk.json.code;
  const pubA = await api(`/api/rooms/${RA}/publish`, { method: "POST", token: OWNER_JWT, body: { description: "Slow seascapes in ink.", tags: ["seascape", "ink"] } });
  check("real API: studio A published", pubA.status === 200 && pubA.json?.listed === true, JSON.stringify(pubA));

  const mkInk = await api("/api/rooms", {
    method: "POST", token: OWNER_JWT,
    body: { audience: "artist_public", title: "Ink Corner", description: "Inktober pages all month.", inktober: true },
  });
  check("real API: inktober studio B created", mkInk.status === 200 && !!mkInk.json?.code, JSON.stringify(mkInk));
  const RB = mkInk.json.code;
  const pubB = await api(`/api/rooms/${RB}/publish`, { method: "POST", token: OWNER_JWT, body: { description: "Inktober pages all month.", tags: ["inktober", "ink"], inktober: true } });
  check("real API: studio B published with inktober opt-in", pubB.status === 200 && pubB.json?.inktober === true, JSON.stringify(pubB));

  const galAll = await api("/api/rooms/gallery");
  check("real gallery lists both published studios",
    [RA, RB].every((c) => (galAll.json?.rooms || []).some((r) => r.code === c)), JSON.stringify(galAll.json));
  const galEv = await api("/api/rooms/gallery?event=inktober-2026");
  check("real event filter returns only the inktober studio",
    (galEv.json?.rooms || []).length === 1 && galEv.json.rooms[0].code === RB && galEv.json.rooms[0].event === "inktober-2026",
    JSON.stringify(galEv.json));

  // ================= browser: every /api/** proxies to the REAL server =========
  browser = await chromium.launch();
  const wireProxy = async (ctx) => ctx.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const reqHeaders = route.request().headers();
    const headers = { "content-type": reqHeaders["content-type"] || "application/json" };
    if (reqHeaders.authorization) headers.authorization = reqHeaders.authorization;
    try {
      const upstream = await fetch(API + url.pathname + url.search, {
        method, headers,
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? route.request().postData() : undefined,
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      return route.fulfill({ status: upstream.status, body: buf, contentType: upstream.headers.get("content-type") || "application/json" });
    } catch {
      return route.fulfill({ status: 502, body: "proxy error", contentType: "text/plain" });
    }
  });

  // ------------------------------ guest session ------------------------------
  const guestCtx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await wireProxy(guestCtx);
  const page = await guestCtx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  await page.goto(`${UI}/gallery`, { waitUntil: "domcontentloaded" });
  await page.locator(".ag-card").first().waitFor({ timeout: 20000 });
  check("/gallery route renders the real published studios",
    (await page.locator(".ag-card").count()) === 2
    && /Coastal Studies/.test(await page.locator(".artist-gallery").innerText())
    && /Ink Corner/.test(await page.locator(".artist-gallery").innerText()));
  check("gallery marks the inktober studio with its event badge",
    /Inktober 2026/.test(await page.locator(".ag-card-event").innerText()));

  // search against the real API
  await page.fill("#ag-search", "coastal");
  await page.locator(".ag-filters button.primary-action").click();
  await page.waitForTimeout(700);
  check("search narrows real results to the matching studio",
    (await page.locator(".ag-card").count()) === 1
    && /Coastal Studies/.test(await page.locator(".ag-card").first().innerText()));

  // event filter against the real API
  await page.fill("#ag-search", "");
  await page.selectOption("#ag-event", "inktober-2026");
  await page.waitForTimeout(700);
  check("event filter shows only the real inktober studio",
    (await page.locator(".ag-card").count()) === 1
    && /Ink Corner/.test(await page.locator(".ag-card").first().innerText()));
  await page.locator(".ag-clear-filters").click();
  await page.waitForTimeout(700);
  check("clear filters restores both studios", (await page.locator(".ag-card").count()) === 2);

  // deep link pre-filtering
  await page.goto(`${UI}/gallery?event=inktober-2026`, { waitUntil: "domcontentloaded" });
  await page.locator(".ag-card").first().waitFor({ timeout: 20000 });
  check("deep link /gallery?event=inktober-2026 lands pre-filtered",
    (await page.locator(".ag-card").count()) === 1
    && /Ink Corner/.test(await page.locator(".ag-card").first().innerText())
    && (await page.locator("#ag-event").inputValue()) === "inktober-2026");

  // guests cannot create
  check("guest sees the sign-in note instead of a create form",
    (await page.locator(".ag-signin-note").count()) === 1
    && (await page.locator("button", { hasText: "Create an artist studio" }).count()) === 0);
  check("guest nav offers Sign in (cloud configured via VITE_PB_URL)",
    (await page.locator(".site-nav-signin").count()) === 1);

  // ------------------------- Inktober discoverability -------------------------
  await page.goto(`${UI}/inktober`, { waitUntil: "domcontentloaded" });
  await page.locator(".ink-studios").waitFor({ timeout: 20000 });
  await page.waitForTimeout(900);
  check("inktober page lists the participating artist studio from the real gallery",
    /Ink Corner/.test(await page.locator(".ink-studios").innerText())
    && /Inktober pages all month/.test(await page.locator(".ink-studios").innerText()));
  const visitHref = await page.locator(".ink-studio-card a").first().getAttribute("href");
  check("studio card links into the real studio room", visitHref === `/join/${RB}`, visitHref || "none");
  await page.locator(".ink-studios-more").click();
  await page.waitForTimeout(1000);
  check("'Browse all Inktober artist studios' lands on the pre-filtered gallery",
    page.url().includes("/gallery?event=inktober-2026")
    && (await page.locator(".ag-card").count()) === 1
    && /Ink Corner/.test(await page.locator(".ag-card").first().innerText()), page.url());

  // site nav link
  await page.locator(".sn-menu a", { hasText: "Gallery" }).click();
  await page.waitForTimeout(1000);
  check("site nav 'Gallery' link routes to /gallery (unfiltered, both studios)",
    page.url().endsWith("/gallery") && (await page.locator(".ag-card").count()) === 2, page.url());

  await guestCtx.close();

  // --------------------------- authenticated session --------------------------
  const authCtx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await wireProxy(authCtx);
  await authCtx.addInitScript(({ token, record }) => {
    window.localStorage.setItem("pocketbase_auth", JSON.stringify({ token, record }));
  }, { token: OWNER_JWT, record: OWNER_RECORD });
  const apage = await authCtx.newPage();
  apage.on("pageerror", (e) => console.log("[pageerror:auth]", e.message));

  await apage.goto(`${UI}/gallery`, { waitUntil: "domcontentloaded" });
  await apage.locator(".ag-card").first().waitFor({ timeout: 20000 });
  check("signed-in nav shows the account label (reactive session reached the route)",
    /Olivia Owner/.test(await apage.locator(".site-nav").innerText()));
  const createBtn = apage.locator("button", { hasText: "Create an artist studio" });
  await createBtn.waitFor({ timeout: 10000 });
  check("authenticated session gets the create form, not the sign-in note",
    (await apage.locator(".ag-signin-note").count()) === 0);

  await createBtn.click();
  await apage.fill("#ag-new-title", "Browser Studio");
  await apage.fill("#ag-new-desc", "Made by the integration browser");
  await apage.fill("#ag-new-tags", "browser, verify");
  await apage.locator("button", { hasText: "Create studio" }).click();
  await apage.locator(".ag-created").waitFor({ timeout: 10000 });
  const createdText = await apage.locator(".ag-created").innerText();
  const codeMatch = createdText.match(/room code ([A-Z0-9]{6})/);
  check("authenticated browser creates a REAL artist room (code returned)",
    !!codeMatch, createdText.slice(0, 140));
  const RNEW = codeMatch ? codeMatch[1] : null;

  if (RNEW) {
    const info = await api(`/api/rooms/${RNEW}/artist`, { token: OWNER_JWT });
    check("the browser-created room exists server-side and is owned by the session account",
      info.status === 200 && info.json?.listed === false, JSON.stringify(info));
    check("creation did NOT list it in the gallery (publish stays explicit)",
      !(await api("/api/rooms/gallery")).json?.rooms?.some((r) => r.code === RNEW));
  }

  await authCtx.close();
};

run().catch((e) => { console.error("VERIFY CRASHED:", e); results.push({ name: "run", ok: false }); })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
