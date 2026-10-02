// Artist gallery + room settings UI verification.
/* global window */
//
// Components under test (owned by this task, standalone):
//   src/components/ArtistGalleryPage.jsx
//   src/components/ArtistRoomSettings.jsx
//   src/components/artist-rooms.css
//
// The artist-room REST endpoints from docs/ARTIST-ROOMS-CONTRACT.md are NOT
// implemented in the backend yet, so:
//   * GET /api/rooms/gallery and POST /api/rooms {audience:'artist_public'}
//     are fulfilled by Playwright with fixtures clearly labeled SYNTHETIC,
//     shaped exactly after the contract.
//   * ArtistRoomSettings never fetches directly (callbacks props by design),
//     so its "API" is the harness's recording stubs, also SYNTHETIC.
// A REAL server.js still boots on :8962 (scratch DATA_DIR) so the script can
// report whether the real endpoints have landed (INFO lines; not failures)
// and proxy every unrelated API call. Final integration against the real API
// is owned by the parent.
//
// No production ports: Vite UI on :8961, API on :8962 (prod is :8787).
// The script writes two throwaway Vite entry files at the repo root
// (__artist-rooms-harness.html/.jsx) and deletes them in cleanup: Router.jsx
// and main.jsx are owned by other agents and stay untouched.
//
// Run: node scripts/artist-gallery-ui-verify.mjs
import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import path from "path";
import os from "os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCRATCH = path.join(os.tmpdir(), "artist-gallery-ui-verify-data");
const API_PORT = 8962;
const UI_PORT = 8961;
const API = `http://127.0.0.1:${API_PORT}`;
const UI = `http://127.0.0.1:${UI_PORT}`;
const HARNESS_HTML = path.join(ROOT, "__artist-rooms-harness.html");
const HARNESS_JSX = path.join(ROOT, "__artist-rooms-harness.jsx");

// ---------------------------------------------------------------- fixtures --
// SYNTHETIC: shaped after docs/ARTIST-ROOMS-CONTRACT.md
// (GET /api/rooms/gallery → {rooms:[{code,title,description,tags,users,ops,event,canWatch}],total,topTags}).
// No account ids, emails, or location fields anywhere, the contract forbids them.
const GALLERY_ROOMS = [ // SYNTHETIC
  { code: "ARTAAA", title: "Coastal Studies", description: "Slow seascapes in ink, one horizon a day.", tags: ["seascape", "ink"], users: 3, ops: 412, event: null, canWatch: true },
  { code: "ARTBBB", title: "Pixel Meadow", description: "", tags: ["pixel-art"], users: 0, ops: 87, event: null, canWatch: true },
  { code: "ARTINK", title: "Ink Daily", description: "Inktober pages all month.", tags: ["inktober", "ink"], users: 1, ops: 1204, event: "inktober-2026", canWatch: true },
];
const SETTINGS_INFO_UNLISTED = { // SYNTHETIC (owner-only publish info)
  listed: false, description: "", tags: [], inktober: false, publishedAt: null, moderationHidden: false,
};

// Throwaway Vite entry (deleted in cleanup). Mounts the components with
// URL-param-controlled props and records navigation + settings callbacks on
// window for assertions. No Router/main.jsx involvement.
writeFileSync(HARNESS_HTML, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>artist rooms harness</title></head>
<body><div id="root"></div><script type="module" src="/__artist-rooms-harness.jsx"></script></body>
</html>
`);
writeFileSync(HARNESS_JSX, `// THROWAWAY harness entry, written and deleted by scripts/artist-gallery-ui-verify.mjs.
import React from "react";
import { createRoot } from "react-dom/client";
import "./src/index.css";
import "./src/App.css";
import "./src/drawesome-theme.css";
import "./src/homepage-redesign.css";
import ArtistGalleryPage from "./src/components/ArtistGalleryPage.jsx";
import ArtistRoomSettings from "./src/components/ArtistRoomSettings.jsx";

const params = new URLSearchParams(window.location.search);
const view = params.get("view") || "gallery";
const sessionKind = params.get("session") || "guest";
const roomCode = params.get("room") || "ARTXYZ";

// window.__fx is read at CALL time, so tests can flip modes with page.evaluate.
const DEFAULT_FX = {
  loadMode: "ok", // ok | error
  info: { listed: false, description: "", tags: [], inktober: false, publishedAt: null, moderationHidden: false },
  publishMode: "ok", // ok | error
  unpublishMode: "ok",
};
let initial = {};
try { initial = JSON.parse(params.get("fx") || "{}"); } catch { initial = {}; }
window.__fx = { ...DEFAULT_FX, ...initial, info: { ...DEFAULT_FX.info, ...(initial.info || {}) } };

window.__navCalls = [];
window.__settingsCalls = [];
const onNavigate = (p) => { window.__navCalls.push(p); };

const sessions = {
  guest: null,
  viewer: { access_token: "harness-token-unverified", verified: false, user: { id: "u1", name: "Harness" } },
  verified: { access_token: "harness-token-verified", verified: true, user: { id: "u1", name: "Harness" } },
};

const settingsApi = {
  loadPublishInfo: async ({ roomCode: rc, token }) => {
    window.__settingsCalls.push({ fn: "loadPublishInfo", roomCode: rc, token });
    if (window.__fx.loadMode === "error") throw new Error("Load blew up (SYNTHETIC)");
    return { ...window.__fx.info };
  },
  publish: async (args) => {
    window.__settingsCalls.push({ fn: "publish", ...args });
    if (window.__fx.publishMode === "error") throw new Error("profanity: that description is not allowed (SYNTHETIC)");
    window.__fx.info = { ...window.__fx.info, listed: true, description: args.description, tags: args.tags, inktober: args.inktober, publishedAt: "2026-09-27T00:00:00.000Z" };
    return { ...window.__fx.info };
  },
  unpublish: async (args) => {
    window.__settingsCalls.push({ fn: "unpublish", ...args });
    if (window.__fx.unpublishMode === "error") throw new Error("unpublish failed (SYNTHETIC)");
    window.__fx.info = { ...window.__fx.info, listed: false };
    return { ...window.__fx.info };
  },
};

function Harness() {
  if (view === "settings") {
    return React.createElement(ArtistRoomSettings, {
      roomCode, session: sessions[sessionKind], onNavigate, ...settingsApi,
    });
  }
  return React.createElement(ArtistGalleryPage, {
    onNavigate, session: sessions[sessionKind], pageSize: 2,
  });
}
createRoot(document.getElementById("root")).render(React.createElement(Harness));
`);

// ------------------------------------------------------------------ harness --
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const procs = [];
const spawnProc = (args, opts, tag) => {
  const p = spawn(args[0], args.slice(1), { cwd: ROOT, stdio: "pipe", ...opts });
  p.stderr.on("data", (d) => process.stderr.write(`[${tag}] ` + d));
  procs.push(p);
  return p;
};
spawnProc([process.execPath, "server.js"], {
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: SCRATCH },
}, "srv");
spawnProc([process.execPath, path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(UI_PORT), "--strictPort", "--host", "127.0.0.1"], {
  env: { ...process.env },
}, "vite");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
};

async function waitUp(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* boot */ }
    await sleep(250);
  }
  return false;
}

let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* gone */ }
  for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
  for (const f of [HARNESS_HTML, HARNESS_JSX]) { try { rmSync(f, { force: true }); } catch { /* temp */ } }
};
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

const run = async () => {
  if (!(await waitUp(API + "/healthz"))) throw new Error("server.js did not boot on " + API_PORT);
  if (!(await waitUp(UI + "/__artist-rooms-harness.html"))) throw new Error("vite dev did not boot on " + UI_PORT);

  // Informational: has the backend agent landed the artist endpoints yet?
  let realGallery = false;
  try { realGallery = (await fetch(API + "/api/rooms/gallery")).ok; } catch { /* absent */ }
  console.log(`INFO  real /api/rooms/gallery on server: ${realGallery ? "yes" : "no, using SYNTHETIC fixtures"}`);

  // ---- static ownership / hygiene checks ------------------------------------
  const gallerySrc = readFileSync(path.join(ROOT, "src/components/ArtistGalleryPage.jsx"), "utf8");
  const settingsSrc = readFileSync(path.join(ROOT, "src/components/ArtistRoomSettings.jsx"), "utf8");
  check("components import no auth/store modules (session comes via props)",
    !/utils\/auth|localStorage|sessionStorage|indexedDB/.test(gallerySrc + settingsSrc));
  let lintOut = "";
  try {
    execSync("npx eslint src/components/ArtistGalleryPage.jsx src/components/ArtistRoomSettings.jsx --max-warnings 0", { cwd: ROOT, stdio: "pipe" });
  } catch (e) { lintOut = String(e.stdout || e.message).slice(0, 300); }
  check("eslint zero-warnings on both new components", lintOut === "", lintOut);

  // ---- browser ---------------------------------------------------------------
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 760 } }); // phone-first
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  // Node-side mutable gallery fixture state (read by the route handler).
  const fx = {
    galleryMode: "ok", // ok | empty | fail | slow
    lastGalleryQuery: null,
    createMode: "ok", // ok | verify_email | accounts_required | profanity
    createPosted: null,
  };

  // One catch-all API route: artist endpoints get SYNTHETIC fixtures, every
  // other API call proxies to the real scratch server.js.
  await ctx.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/rooms/gallery" && method === "GET") {
      fx.lastGalleryQuery = url.search;
      if (fx.galleryMode === "slow") await sleep(1200);
      if (fx.galleryMode === "fail") return route.fulfill({ status: 500, body: "boom", contentType: "text/plain" });
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const tag = url.searchParams.get("tag") || "";
      const event = url.searchParams.get("event") || "";
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Math.min(Number(url.searchParams.get("limit") || 12), 60);
      let pool = fx.galleryMode === "empty" ? [] : GALLERY_ROOMS; // SYNTHETIC
      if (q) pool = pool.filter((r) => r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q)));
      if (tag) pool = pool.filter((r) => r.tags.includes(tag));
      if (event) pool = pool.filter((r) => r.event === event);
      const topTags = [...new Set(GALLERY_ROOMS.flatMap((r) => r.tags))];
      return route.fulfill({ json: { rooms: pool.slice(offset, offset + limit), total: pool.length, topTags } });
    }
    if (url.pathname === "/api/rooms" && method === "POST") {
      fx.createPosted = {
        body: JSON.parse(route.request().postData() || "{}"),
        auth: route.request().headers()["authorization"] || null,
      };
      if (fx.createMode === "verify_email") return route.fulfill({ status: 403, json: { error: "verify_email" } });
      if (fx.createMode === "accounts_required") return route.fulfill({ status: 401, json: { error: "accounts_required" } });
      if (fx.createMode === "profanity") return route.fulfill({ status: 400, json: { error: "profanity", message: "That description didn't pass the language check." } });
      return route.fulfill({ json: { code: "ARTNEW", audience: "artist_public", listed: false, title: fx.createPosted.body.title || null, mode: null } }); // SYNTHETIC
    }
    try {
      const upstream = await fetch(API + url.pathname + url.search, {
        method,
        headers: { "content-type": route.request().headers()["content-type"] || "application/json" },
        body: ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? route.request().postData() : undefined,
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      return route.fulfill({ status: upstream.status, body: buf, contentType: upstream.headers.get("content-type") || "application/json" });
    } catch {
      return route.fulfill({ status: 502, body: "harness proxy error", contentType: "text/plain" });
    }
  });

  const harnessUrl = (qs) => `${UI}/__artist-rooms-harness.html?${qs}`;
  const navCalls = () => page.evaluate(() => window.__navCalls);
  const settingsCalls = () => page.evaluate(() => window.__settingsCalls);

  // =========================== gallery: guest ================================
  await page.goto(harnessUrl("view=gallery&session=guest"), { waitUntil: "domcontentloaded" });
  await page.locator(".ag-card").first().waitFor({ timeout: 15000 });

  check("gallery renders studio cards (page 1 of pageSize=2)", (await page.locator(".ag-card").count()) === 2);
  const firstCard = (await page.locator(".ag-card").first().innerText()).replace(/\s+/g, " ");
  check("card shows title, code, plain description, live counts",
    firstCard.includes("Coastal Studies") && firstCard.includes("ARTAAA") && firstCard.includes("Slow seascapes in ink") && firstCard.includes("3 here now"),
    firstCard.slice(0, 90));
  check("gallery count line reads 'Showing 1–2 of 3'",
    /Showing 1.2 of 3 studios/.test((await page.locator(".ag-count").innerText()).replace(/\s+/g, " ")));
  check("top tag chips render from API topTags", (await page.locator(".ag-toptags .ag-tag-chip").count()) >= 3);
  check("no PII anywhere in gallery markup (no emails / account ids)",
    !/@[a-z0-9.-]+\.[a-z]{2,}|profileId|ownerId/i.test(await page.locator(".artist-gallery").innerText()));

  // Card → /join/CODE
  await page.locator(".ag-card").first().locator("button.primary-action").click();
  check("card 'Visit studio' navigates to /join/ARTAAA", (await navCalls()).includes("/join/ARTAAA"));
  check("card 'Watch live' offered (canWatch) and navigates to /live/CODE",
    (await page.locator(".ag-watch").count()) > 0);
  await page.locator(".ag-card").first().locator(".ag-watch").click();
  check("'Watch live' navigates to /live/ARTAAA", (await navCalls()).includes("/live/ARTAAA"));

  // Pagination
  fx.lastGalleryQuery = null;
  await page.locator(".ag-pager button", { hasText: "Older" }).click();
  await page.waitForTimeout(600);
  check("pagination requests offset=2&limit=2", /offset=2/.test(fx.lastGalleryQuery || "") && /limit=2/.test(fx.lastGalleryQuery || ""), fx.lastGalleryQuery || "none");
  check("page 2 shows the Inktober studio with event badge",
    (await page.locator(".ag-card").count()) === 1 &&
    /Inktober 2026/.test(await page.locator(".ag-card-event").innerText()));
  await page.locator(".ag-pager button", { hasText: "Newer" }).click();
  await page.waitForTimeout(600);
  check("pagination returns to page 1", (await page.locator(".ag-card").count()) === 2);

  // Search
  fx.lastGalleryQuery = null;
  await page.fill("#ag-search", "meadow");
  await page.locator(".ag-filters button.primary-action").click();
  await page.waitForTimeout(600);
  check("search sends ?q=meadow", /(^|[?&])q=meadow(&|$)/.test(fx.lastGalleryQuery || ""), fx.lastGalleryQuery || "none");
  check("search narrows results to the matching studio",
    (await page.locator(".ag-card").count()) === 1 && /Pixel Meadow/.test(await page.locator(".ag-card").first().innerText()));

  // Tag chip filter
  fx.lastGalleryQuery = null;
  await page.locator(".ag-clear-filters").click();
  await page.waitForTimeout(400);
  await page.locator(".ag-toptags .ag-tag-chip", { hasText: "#ink" }).first().click();
  await page.waitForTimeout(600);
  check("tag chip sends ?tag=ink", /(^|[?&])tag=ink(&|$)/.test(fx.lastGalleryQuery || ""), fx.lastGalleryQuery || "none");

  // Event filter
  fx.lastGalleryQuery = null;
  await page.selectOption("#ag-event", "inktober-2026");
  await page.waitForTimeout(600);
  check("event filter sends ?event=inktober-2026", /event=inktober-2026/.test(fx.lastGalleryQuery || ""), fx.lastGalleryQuery || "none");
  check("event filter shows only the Inktober studio",
    (await page.locator(".ag-card").count()) === 1 && /Ink Daily/.test(await page.locator(".ag-card").first().innerText()));

  // Honest empty state
  fx.lastGalleryQuery = null;
  await page.fill("#ag-search", "zzzznothing");
  await page.locator(".ag-filters button.primary-action").click();
  await page.waitForTimeout(600);
  check("empty result shows honest empty state (no fake cards)",
    (await page.locator(".ag-card").count()) === 0 && /No studios match/i.test(await page.locator(".ag-empty").innerText()));

  // Error + retry
  await page.locator(".ag-clear-filters").click();
  await page.waitForTimeout(400);
  fx.galleryMode = "fail";
  await page.locator(".ag-filters button.primary-action").click();
  await page.waitForTimeout(600);
  check("gallery error state shows message + retry",
    (await page.locator(".ag-error").count()) === 1 && (await page.locator(".ag-error button").count()) === 1);
  fx.galleryMode = "ok";
  await page.locator(".ag-error button").click();
  await page.waitForTimeout(600);
  check("retry recovers the gallery", (await page.locator(".ag-card").count()) === 2);

  // Loading state
  fx.galleryMode = "slow";
  const slowLoad = page.locator(".ag-filters button.primary-action").click();
  await page.waitForTimeout(300);
  check("loading state announced (role=status, aria-busy)",
    (await page.locator('.ag-status[role="status"]').count()) === 1 &&
    (await page.locator('.ag-results[aria-busy="true"]').count()) === 1);
  await slowLoad;
  await page.waitForTimeout(1400);
  fx.galleryMode = "ok";

  // Guest creation gating, no fake identity
  check("guest sees sign-in note, no create form", (await page.locator(".ag-create-form").count()) === 0 && /verified account/i.test(await page.locator(".ag-create").innerText()));
  fx.createPosted = null;
  check("guest fired no POST /api/rooms", fx.createPosted === null);

  // ========================= gallery: unverified =============================
  await page.goto(harnessUrl("view=gallery&session=viewer"), { waitUntil: "domcontentloaded" });
  await page.locator(".ag-card").first().waitFor({ timeout: 15000 });
  check("unverified session sees verify-account notice, no create form",
    (await page.locator(".ag-create-form").count()) === 0 && /isn’t verified/i.test(await page.locator(".ag-create").innerText()));

  // ========================== gallery: verified ==============================
  await page.goto(harnessUrl("view=gallery&session=verified"), { waitUntil: "domcontentloaded" });
  await page.locator(".ag-card").first().waitFor({ timeout: 15000 });
  await page.locator(".ag-create button.primary-action").click();
  await page.locator("#ag-new-title").waitFor({ timeout: 5000 });
  check("create form submit disabled with empty title",
    await page.locator('.ag-create-form button[type="submit"]').isDisabled());
  await page.fill("#ag-new-title", "Night Trains");
  await page.fill("#ag-new-desc", "Watercolor trains after dark.");
  await page.fill("#ag-new-tags", "Trains!, pixel art, cats, trains");
  await page.locator(".ag-inktober-opt input").check();
  fx.createPosted = null;
  await page.locator('.ag-create-form button[type="submit"]').click();
  await page.waitForTimeout(600);
  const posted = fx.createPosted;
  check("create posts audience=artist_public with bearer token",
    posted && posted.body.audience === "artist_public" && posted.auth === "Bearer harness-token-verified",
    posted ? `${posted.body.audience} / ${posted.auth}` : "nothing posted");
  check("create sends plain parsed tags (deduped, stripped, lowercase)",
    posted && JSON.stringify(posted.body.tags) === JSON.stringify(["trains", "pixelart", "cats"]), posted ? posted.body.tags.join(",") : "none");
  check("create sends title/description/inktober", posted && posted.body.title === "Night Trains" && posted.body.inktober === true);
  const createdText = (await page.locator(".ag-created").innerText()).replace(/\s+/g, " ");
  check("creation success shows room code + honest 'not listed yet' note",
    /ARTNEW/.test(createdText) && /not.*listed/i.test(createdText), createdText.slice(0, 120));
  await page.locator(".ag-created button.primary-action").click();
  check("'Open your studio' navigates to /join/ARTNEW", (await navCalls()).includes("/join/ARTNEW"));

  // Server-side rejection (verified session, unverified account per server).
  // "Create another" returns straight to the still-open form.
  fx.createMode = "verify_email";
  await page.locator(".ag-created button.ag-secondary").click();
  await page.locator("#ag-new-title").waitFor({ timeout: 5000 });
  await page.fill("#ag-new-title", "Night Trains 2");
  await page.locator('.ag-create-form button[type="submit"]').click();
  await page.waitForTimeout(600);
  check("server rejection (verify_email) shown verbatim-ish, no fake success",
    /isn't verified yet/i.test((await page.locator(".ag-form-error").innerText()).replace(/’/g, "'")) && (await page.locator(".ag-created").count()) === 0);
  fx.createMode = "ok";

  // =========================== settings: guest ===============================
  await page.goto(harnessUrl("view=settings&session=guest&room=ARTXYZ"), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  check("settings guest: sign-in notice, zero callbacks fired",
    /Sign in as this studio’s owner/i.test(await page.locator(".artist-settings").innerText()) && (await settingsCalls()).length === 0);

  // ========================== settings: unlisted =============================
  await page.goto(harnessUrl(`view=settings&session=verified&room=ARTXYZ&fx=${encodeURIComponent(JSON.stringify({ info: SETTINGS_INFO_UNLISTED }))}`), { waitUntil: "domcontentloaded" });
  await page.locator(".ars-form").waitFor({ timeout: 10000 });
  const calls0 = await settingsCalls();
  check("settings loads via loadPublishInfo callback with roomCode + token",
    calls0.length === 1 && calls0[0].fn === "loadPublishInfo" && calls0[0].roomCode === "ARTXYZ" && calls0[0].token === "harness-token-verified",
    JSON.stringify(calls0[0] || {}));
  check("unlisted state copy: not listed + 'link still works' honesty",
    /Not listed/.test(await page.locator(".ars-state").innerText()) &&
    /anyone with the room link can still view/i.test((await page.locator(".ars-note").innerText()).replace(/\s+/g, " ")));

  // Publish requires the explicit confirm step
  await page.fill("#ars-desc", "Ink trains, nightly.");
  await page.fill("#ars-tags", "trains, ink");
  await page.locator(".ag-inktober-opt input").check();
  await page.locator('.ars-actions button[type="submit"]').click();
  check("publish opens a confirm step before any mutation",
    (await page.locator(".ars-confirm").count()) === 1 && (await settingsCalls()).length === 1);
  await page.locator(".ars-confirm button.ag-secondary").click();
  check("confirm cancel fires no publish callback", (await settingsCalls()).length === 1);
  await page.locator('.ars-actions button[type="submit"]').click();
  await page.locator(".ars-confirm button.primary-action").click();
  await page.waitForTimeout(500);
  const calls1 = await settingsCalls();
  const publishCall = calls1.find((c) => c.fn === "publish");
  check("publish callback receives {roomCode, token, description, tags, inktober}",
    publishCall && publishCall.roomCode === "ARTXYZ" && publishCall.token === "harness-token-verified" &&
    publishCall.description === "Ink trains, nightly." && JSON.stringify(publishCall.tags) === JSON.stringify(["trains", "ink"]) && publishCall.inktober === true,
    publishCall ? publishCall.description : "no publish call");
  check("after publish the panel shows listed state",
    /Listed in the public gallery/.test(await page.locator(".ars-state").innerText()));

  // Unpublish with the explicit 'link keeps working' warning
  await page.locator(".ars-actions button.ars-danger").click();
  const unpubConfirm = (await page.locator(".ars-confirm").innerText()).replace(/\s+/g, " ");
  check("unpublish confirm states the link keeps working", /link keeps working/i.test(unpubConfirm), unpubConfirm.slice(0, 110));
  await page.locator(".ars-confirm button.ars-danger").click();
  await page.waitForTimeout(500);
  const calls2 = await settingsCalls();
  check("unpublish callback fired with {roomCode, token}",
    calls2.some((c) => c.fn === "unpublish" && c.roomCode === "ARTXYZ" && c.token === "harness-token-verified"));
  check("after unpublish the panel shows unlisted state",
    /Not listed/.test(await page.locator(".ars-state").innerText()));

  // Publish error: message verbatim, no state flip
  await page.evaluate(() => { window.__fx.publishMode = "error"; });
  await page.fill("#ars-desc", "Fresh attempt");
  await page.locator('.ars-actions button[type="submit"]').click();
  await page.locator(".ars-confirm button.primary-action").click();
  await page.waitForTimeout(500);
  check("publish error shown verbatim (profanity/moderation), state unchanged",
    /profanity: that description is not allowed/.test(await page.locator(".ag-form-error").innerText()) &&
    /Not listed/.test(await page.locator(".ars-state").innerText()));

  // ====================== settings: moderation hidden ========================
  await page.goto(harnessUrl(`view=settings&session=verified&room=ARTXYZ&fx=${encodeURIComponent(JSON.stringify({ info: { ...SETTINGS_INFO_UNLISTED, moderationHidden: true } }))}`), { waitUntil: "domcontentloaded" });
  await page.locator(".ars-moderation").waitFor({ timeout: 10000 });
  check("moderationHidden shows notice and disables publish controls",
    /Moderators have hidden/i.test(await page.locator(".ars-moderation").innerText()) &&
    await page.locator('.ars-actions button[type="submit"]').isDisabled());

  // ========================== settings: load error ===========================
  await page.goto(harnessUrl(`view=settings&session=verified&room=ARTXYZ&fx=${encodeURIComponent(JSON.stringify({ loadMode: "error" }))}`), { waitUntil: "domcontentloaded" });
  await page.locator(".ars-error").waitFor({ timeout: 10000 });
  check("settings load error shows message + retry",
    /Load blew up/.test(await page.locator(".ars-error").innerText()) && (await page.locator(".ars-error button").count()) === 1);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ": FAILURES:" : ""}`);
  for (const f of failed) console.log("  ✗ " + f.name);
  process.exitCode = failed.length ? 1 : 0;
};

run().catch((err) => {
  console.error("HARNESS ERROR:", err);
  process.exitCode = 2;
}).finally(cleanup);
