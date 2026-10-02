// Inktober share-card + sharing-UX verification (feature/inktober-sharing).
//
// Boots the REAL server (port 8983, throwaway DATA_DIR under the Hermes
// scratch cache, INKTOBER_CLOCK_FILE for a deterministic active phase) plus a
// scratch Vite dev server (port 8984), then drives the real studio in a real
// browser. Two legs:
//
//   A. Module leg — dynamic-imports src/utils/inviteCard.js in the page and
//      asserts the RENDERED PIXELS of the Inktober card: 1080×1080, cream
//      paper, real ink pixels, bundled Caveat lettering loaded, the full art
//      aspect preserved (corner marks survive uncropped), and ZERO ink
//      decoration inside the drawn-art rectangle. Classic theme unchanged.
//   B. Studio leg — draws in a fresh room, opens the Invite sheet, and checks
//      the seasonal default theme + user toggle, the TikTok/Instagram
//      image-native share payload via a navigator.share interception (share
//      BEFORE clipboard, cancellation triggers no download), the "Share
//      image…" native file share (Messages/Mail target) with its
//      cancellation + desktop save fallback, the immediate invalidation of a
//      stale card on theme flip (old blob URL revoked up front), the desktop
//      save-and-upload fallback, Save image, sms:/mailto: link-only payloads
//      with honest attach guidance, the link-only native share with the
//      SEASONAL caption, X intent, mobile 375px layout, and the ended- AND
//      upcoming-phase defaults flipping to Classic.
//   U. Upcoming leg — September clock: the warm-up phase defaults to Classic.
//   G. Pinned leg — mounts ShareInviteSheet standalone with a fixed
//      inktoberPage ({ year, day, prompt }) under a November clock: Inktober
//      default + DAY chip survive after October, /api/inktober is skipped,
//      and invalid metadata falls back to the live event.
//
// Screenshots land in output/inktober-share/.
/* global window, document, createImageBitmap */ // page.evaluate callbacks run in the browser
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { homedir } from "node:os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "output", "inktober-share");
const SCRATCH = path.join(homedir(), ".hermes", "cache", "scratch", "inktober-share");
const VITE_DIR = path.join(SCRATCH, "vite");
const CLOCK_FILE = path.join(SCRATCH, "inktober-clock.txt");
const PORT = 8983; // realtime backend (never 8787)
const VPORT = 8984; // scratch Vite dev server, proxies /ws + /api → backend
const HOME = `http://127.0.0.1:${VPORT}`;
const ROOM = "MAIN"; // public open studio — guests join without an account
const JOIN = `${HOME}/join/${ROOM}`;

const setClock = (iso) => writeFileSync(CLOCK_FILE, iso);

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(VITE_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });
setClock("2026-10-15T12:00:00Z"); // active, day 15

writeFileSync(path.join(VITE_DIR, "vite.config.mjs"), `
import react from ${JSON.stringify(path.join(ROOT, "node_modules", "@vitejs", "plugin-react", "dist", "index.js"))};
export default {
  root: ${JSON.stringify(ROOT)},
  logLevel: "warn",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: ${VPORT},
    strictPort: true,
    fs: { allow: ${JSON.stringify([ROOT, SCRATCH, realpathSync(SCRATCH), realpathSync(path.join(ROOT, "node_modules"))])} },
    proxy: {
      "/ws": { target: "ws://127.0.0.1:${PORT}", ws: true },
      "/api": { target: "http://127.0.0.1:${PORT}" },
    },
  },
};
`);

// Standalone mount harness for the pinned-inktoberPage leg: renders the real
// ShareInviteSheet (JSX-transformed by the same Vite pipeline) with whatever
// props the test hands it — no App.jsx changes needed.
const ENTRY = path.join(SCRATCH, "pinned-entry.jsx");
writeFileSync(ENTRY, `
import React from "react";
import { createRoot } from "react-dom/client";
import ShareInviteSheet from ${JSON.stringify(`/@fs${path.join(ROOT, "src", "components", "ShareInviteSheet.jsx")}`)};
window.__sheetRoots = [];
window.__mountSheet = (props) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(ShareInviteSheet, props));
  window.__sheetRoots.push({ host, root });
};
window.__unmountSheets = () => {
  for (const { host, root } of window.__sheetRoots.splice(0)) {
    root.unmount();
    host.remove();
  }
};
`);

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: SCRATCH,
    PB_URL: "",
    POCKETBASE_URL: "",
    INKTOBER_CLOCK_FILE: CLOCK_FILE,
  },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const vite = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--config", path.join(VITE_DIR, "vite.config.mjs")], {
  cwd: ROOT, env: { ...process.env }, stdio: "pipe",
});
vite.stderr.on("data", (d) => process.stderr.write("[vite] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// Share/clipboard/download/window.open interception. Event order is recorded
// so we can assert navigator.share fires BEFORE any clipboard write.
const INTERCEPT = `
(() => {
  window.__events = [];
  window.__shareBehavior = "ok";      // 'ok' | 'abort' | 'fail'
  window.__canShareFiles = true;      // false → force the desktop fallback
  const record = (e) => { window.__events.push(e); };
  Object.defineProperty(navigator, "canShare", { configurable: true, value: (data) => {
    record({ t: "canShare", files: data && data.files ? data.files.length : 0 });
    return window.__canShareFiles && !!(data && data.files && data.files.length);
  } });
  Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => {
    record({ t: "share",
      files: data && data.files ? data.files.map((f) => ({ name: f.name, type: f.type, size: f.size })) : null,
      text: data && data.text != null ? data.text : null,
      url: data && data.url != null ? data.url : null,
      title: data && data.title != null ? data.title : null });
    if (window.__shareBehavior === "abort") { const e = new Error("cancelled"); e.name = "AbortError"; throw e; }
    if (window.__shareBehavior === "fail") throw new Error("share failed");
  } });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text) => { record({ t: "clipboard", text }); },
  } });
  window.open = (url) => { record({ t: "open", url: String(url) }); return { closed: false, focus() {} }; };
  const origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (u) => { record({ t: "revoke", url: String(u) }); return origRevoke(u); };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click() {
    if (this.download) { record({ t: "download", name: this.download, href: String(this.href).slice(0, 32) }); return; }
    return origClick.call(this);
  };
})();
`;

// Records every fetch URL so the pinned-page leg can prove the live
// /api/inktober fetch is skipped (and that an invalid pin still fetches).
const FETCHSPY = `
(() => {
  window.__fetches = [];
  const origFetch = window.fetch.bind(window);
  window.fetch = (u, o) => { window.__fetches.push(String(u)); return origFetch(u, o); };
})();
`;

const drainEvents = (page) => page.evaluate(() => { const e = window.__events.slice(); window.__events = []; return e; });

// Poll until the preview card (re)renders and returns its pixel stats.
const waitForCard = async (page, timeout = 15000) => {
  const start = Date.now();
  for (;;) {
    const stats = await previewStats(page);
    if (stats) return stats;
    if (Date.now() - start > timeout) return null;
    await sleep(250);
  }
};

// Decode the preview <img> (a blob: URL of the real card PNG) and compute
// pixel stats inside the page.
const previewStats = (page) => page.evaluate(async () => {
  const img = document.querySelector(".share-invite-preview img");
  if (!img) return null;
  const blob = await (await fetch(img.src)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const px = (x, y) => [d[(y * c.width + x) * 4], d[(y * c.width + x) * 4 + 1], d[(y * c.width + x) * 4 + 2]];
  let ink = 0;
  for (let i = 0; i < d.length; i += 16) {
    if (d[i] + d[i + 1] + d[i + 2] < 160) ink += 1;
  }
  // DAY chip zone (top-right stamp, ~x 846–998, y 52–104): dark-pixel count.
  let chip = 0;
  for (let y = 45; y < 110; y += 1) {
    for (let x = 846; x < 1000; x += 1) {
      const o = (y * c.width + x) * 4;
      if (d[o] + d[o + 1] + d[o + 2] < 160) chip += 1;
    }
  }
  return { w: c.width, h: c.height, corners: [px(8, 8), px(c.width - 9, 8), px(8, c.height - 9), px(c.width - 9, c.height - 9)], ink, chip };
});

const openStudioAndSheet = async (page, { draw = true } = {}) => {
  await page.goto(JOIN, { waitUntil: "domcontentloaded" });
  await sleep(2200);
  for (const label of [/keep drawing/i, /start painting/i, /let's paint/i, /jump in/i, /got it/i, /^ok$/i, /continue/i]) {
    const btn = page.getByRole("button", { name: label }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(500); }
  }
  if (draw) {
    const overlay = page.locator(".overlay-canvas");
    const ob = await overlay.boundingBox();
    if (ob) {
      await page.mouse.move(ob.x + ob.width * 0.3, ob.y + ob.height * 0.35);
      await page.mouse.down();
      for (let i = 1; i <= 10; i += 1) {
        await page.mouse.move(ob.x + ob.width * (0.3 + i * 0.035), ob.y + ob.height * (0.35 + i * 0.025));
        await sleep(25);
      }
      await page.mouse.up();
      await sleep(700);
    }
  }
  // The sheet fetches /api/inktober on mount — capture it so the seasonal
  // default has settled before we assert on the toggle.
  const inkResp = page.waitForResponse((r) => r.url().includes("/api/inktober"), { timeout: 15000 }).catch(() => null);
  // The room-loading curtain can demand an OK click after replay completes —
  // wait for it (it appears late), click through, and wait for the curtain
  // to actually detach before reaching for the fab.
  for (let i = 0; i < 60; i += 1) {
    if ((await page.locator(".load-curtain").count()) === 0) break;
    const ok = page.locator("button.load-ok").first();
    if (await ok.isVisible().catch(() => false)) await ok.click().catch(() => {});
    await sleep(500);
  }
  await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
  await page.locator(".share-invite-sheet").waitFor({ timeout: 8000 });
  await inkResp;
  await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
  await waitForCard(page);
  await sleep(300);
};

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${HOME}/api/inktober`); if (r.ok) break; } catch { /* booting */ }
    await sleep(300);
  }

  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];

  // ---- Leg A: module-level rendered-pixel checks -------------------------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    await page.goto(`${HOME}/`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    const a = await page.evaluate(async () => {
      const mod = await import("/src/utils/inviteCard.js");
      const art = document.createElement("canvas");
      art.width = 1280; art.height = 800;
      const ac = art.getContext("2d");
      ac.fillStyle = "#ffffff"; ac.fillRect(0, 0, 1280, 800);
      ac.fillStyle = "#ff0000";
      for (const [x, y] of [[0, 0], [1240, 0], [0, 760], [1240, 760]]) ac.fillRect(x, y, 40, 40);
      ac.fillStyle = "#0000ff";
      ac.beginPath(); ac.arc(640, 400, 120, 0, Math.PI * 2); ac.fill();

      const analyse = (canvas) => {
        const ctx = canvas.getContext("2d");
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const px = (x, y) => [d[(y * canvas.width + x) * 4], d[(y * canvas.width + x) * 4 + 1], d[(y * canvas.width + x) * 4 + 2]];
        let ink = 0; let red = 0;
        const bb = { minX: 1e9, minY: 1e9, maxX: -1, maxY: -1 };
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const o = (y * canvas.width + x) * 4;
            const r = d[o]; const g = d[o + 1]; const b = d[o + 2];
            if (r + g + b < 160) ink += 1;
            if (r > 200 && g < 90 && b < 90) {
              red += 1;
              if (x < bb.minX) bb.minX = x; if (x > bb.maxX) bb.maxX = x;
              if (y < bb.minY) bb.minY = y; if (y > bb.maxY) bb.maxY = y;
            }
          }
        }
        let inkInArt = 0;
        if (red > 0) {
          for (let y = bb.minY; y <= bb.maxY; y += 1) {
            for (let x = bb.minX; x <= bb.maxX; x += 1) {
              const o = (y * canvas.width + x) * 4;
              if (d[o] + d[o + 1] + d[o + 2] < 160) inkInArt += 1;
            }
          }
        }
        // DAY chip zone (top-right stamp, ~x 846–998, y 52–104).
        let chip = 0;
        for (let y = 45; y < 110; y += 1) {
          for (let x = 846; x < 1000; x += 1) {
            const o = (y * canvas.width + x) * 4;
            if (d[o] + d[o + 1] + d[o + 2] < 160) chip += 1;
          }
        }
        return { w: canvas.width, h: canvas.height, corners: [px(8, 8), px(1071, 8), px(8, 1071), px(1071, 1071)], ink, red, bb, inkInArt, chip };
      };

      const inktober = await mod.renderInviteCard({
        art, roomId: "SHAREINK", joinUrl: "http://127.0.0.1:8984/join/SHAREINK",
        title: "My spooky drawing", theme: "inktober", inktober: { phase: "active", day: 15, prompt: "skeleton", year: 2026 },
      });
      const inkStats = analyse(inktober);

      const classic = await mod.renderInviteCard({
        art, roomId: "SHAREINK", joinUrl: "http://127.0.0.1:8984/join/SHAREINK", title: "My spooky drawing",
      });
      const classicStats = analyse(classic);

      const longTitle = await mod.renderInviteCard({
        art, roomId: "ABCDEFGHIJ", joinUrl: "http://127.0.0.1:8984/join/ABCDEFGHIJ",
        title: "An extremely long room title that must never overflow the edges of the invite card no matter what anyone types into the box",
        theme: "inktober", inktober: { phase: "active", day: 15, prompt: "skeleton", year: 2026 },
      });
      const longStats = analyse(longTitle);

      const noArt = await mod.renderInviteCard({ art: null, roomId: "SHAREINK", joinUrl: "http://127.0.0.1:8984/join/SHAREINK", theme: "inktober" });

      // Pinned sketchbook page (inktoberPage prop) — module level.
      const pinnedState = mod.pinnedInktoberState({ year: 2026, day: 7, prompt: "shell" });
      const pinnedCard = pinnedState
        ? await mod.renderInviteCard({
            art, roomId: "PAGE7", joinUrl: "http://127.0.0.1:8984/join/PAGE7",
            title: "Inktober day 7", theme: "inktober", inktober: pinnedState,
          })
        : null;
      const pinnedStats = pinnedCard ? analyse(pinnedCard) : null;
      const pinnedInvalid = [
        mod.pinnedInktoberState(null),
        mod.pinnedInktoberState({ year: 2026, day: 0, prompt: "x" }),
        mod.pinnedInktoberState({ year: 2026, day: 32, prompt: "x" }),
        mod.pinnedInktoberState({ year: "nope", day: 7, prompt: "x" }),
        mod.pinnedInktoberState("active"),
      ];

      // fitLabel truncation contract.
      const probe = document.createElement("canvas").getContext("2d");
      probe.font = '600 46px "Inktober Share Ink", cursive';
      const fitted = typeof mod.fitLabel === "function" ? mod.fitLabel(probe, "x".repeat(200), 400) : null;

      return {
        inkStats, classicStats, longStats,
        noArtSize: noArt ? [noArt.width, noArt.height] : null,
        pinnedState, pinnedStats,
        pinnedInvalidAllNull: pinnedInvalid.every((v) => v === null),
        fontLoaded: document.fonts.check('700 90px "Inktober Share Ink"'),
        faceRegistered: [...document.fonts].some((f) => f.family.includes("Inktober Share Ink") && f.status === "loaded"),
        caveatDistinct: (() => {
          const p1 = document.createElement("canvas").getContext("2d");
          p1.font = '700 90px "Inktober Share Ink"';
          const w1 = p1.measureText("Come draw with me!").width;
          p1.font = "700 90px sans-serif";
          const w2 = p1.measureText("Come draw with me!").width;
          return Math.abs(w1 - w2) > 4;
        })(),
        fitted: fitted ? { text: fitted.slice(-1), width: probe.measureText(fitted).width } : null,
        caption: mod.inviteCaption({ roomId: "SHAREINK", joinUrl: "http://x.test/join/SHAREINK", theme: "inktober" }),
        captionClassic: mod.inviteCaption({ roomId: "SHAREINK", joinUrl: "http://x.test/join/SHAREINK" }),
      };
    });

    const isCream = (c) => Math.abs(c[0] - 0xfb) < 17 && Math.abs(c[1] - 0xf3) < 17 && Math.abs(c[2] - 0xdf) < 18;
    check("A1 inktober card is 1080×1080", a.inkStats.w === 1080 && a.inkStats.h === 1080, `${a.inkStats.w}x${a.inkStats.h}`);
    check("A2 inktober card corners are cream paper", a.inkStats.corners.every(isCream), JSON.stringify(a.inkStats.corners[0]));
    check("A3 inktober card has real ink pixels (banner/frame/splatter)", a.inkStats.ink > 30000, `ink=${a.inkStats.ink}`);
    check("A4 bundled Caveat face loaded for canvas lettering", a.faceRegistered && a.fontLoaded && a.caveatDistinct);
    check("A5 full art preserved: all four red corner marks survive", a.inkStats.red > 2000, `red=${a.inkStats.red}`);
    const artAspect = (a.inkStats.bb.maxX - a.inkStats.bb.minX + 1) / (a.inkStats.bb.maxY - a.inkStats.bb.minY + 1);
    check("A6 art aspect preserved (no crop/stretch)", Math.abs(artAspect - 1240 / 760) < 0.06, `aspect=${artAspect.toFixed(3)}`);
    check("A7 zero ink decoration over the drawing", a.inkStats.inkInArt === 0, `inkInArt=${a.inkStats.inkInArt}`);
    check("A8 classic card unchanged (pastel corner, not cream)", !isCream(a.classicStats.corners[0]) && a.classicStats.w === 1080, JSON.stringify(a.classicStats.corners[0]));
    check("A9 long title + long code render without overflow/crash", a.longStats.w === 1080 && a.longStats.ink > 10000, `ink=${a.longStats.ink}`);
    check("A10 renders with no art (fresh room)", a.noArtSize && a.noArtSize[0] === 1080);
    check("A11 fitLabel truncates to max width with ellipsis", !!a.fitted && a.fitted.text === "…" && a.fitted.width <= 402, a.fitted ? `w=${Math.round(a.fitted.width)}` : "missing");
    check("A12 inktober caption carries #inktober + link", a.caption.includes("#inktober") && a.caption.includes("http://x.test/join/SHAREINK"), a.caption);
    check("A13 classic caption keeps original shape", !a.captionClassic.includes("#inktober") && a.captionClassic.includes("Come draw with me"));
    check("A14 pinnedInktoberState normalizes a valid pinned page",
      !!a.pinnedState && a.pinnedState.phase === "active" && a.pinnedState.day === 7 && a.pinnedState.year === 2026
      && a.pinnedState.prompt === "shell" && a.pinnedState.pinned === true, JSON.stringify(a.pinnedState));
    check("A15 pinnedInktoberState rejects missing/invalid metadata", a.pinnedInvalidAllNull === true);
    check("A16 pinned page renders a cream card with its DAY chip",
      !!a.pinnedStats && a.pinnedStats.w === 1080 && a.pinnedStats.corners.every(isCream) && a.pinnedStats.chip > 60,
      a.pinnedStats ? `chip=${a.pinnedStats.chip}` : "no pinned card");
    await page.close();
  }

  // ---- Leg B: studio sheet UX (active phase) ------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(INTERCEPT);
    const page = await ctx.newPage();
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await openStudioAndSheet(page);

    const themePressed = async (label) => page.locator(`.share-card-theme button:has-text("${label}")`).getAttribute("aria-pressed").catch(() => null);
    check("B1 October default card style is Inktober", (await themePressed("Inktober")) === "true");
    check("B2 sheet carries the ink theme attribute", (await page.locator(".share-invite-sheet").getAttribute("data-card-theme")) === "inktober");

    const stats = await previewStats(page);
    const isCream = (c) => c && Math.abs(c[0] - 0xfb) < 17 && Math.abs(c[1] - 0xf3) < 17 && Math.abs(c[2] - 0xdf) < 18;
    check("B3 preview decodes to a 1080 cream ink card", !!stats && stats.w === 1080 && stats.h === 1080 && stats.corners.every(isCream) && stats.ink > 7500,
      stats ? `ink=${stats.ink} corner=${JSON.stringify(stats.corners[0])}` : "no preview");
    check("B4 room code pill shows the code", (await page.locator(".share-invite-code strong").innerText()) === ROOM);

    const smsHref = await page.locator("a.share-sms").getAttribute("href").catch(() => null);
    const mailHref = await page.locator("a.share-email").getAttribute("href").catch(() => null);
    check("B5 sms: payload carries the join link", !!smsHref && smsHref.startsWith("sms:") && smsHref.includes(encodeURIComponent(JOIN)), smsHref || "missing");
    check("B6 mailto: payload carries the join link", !!mailHref && mailHref.startsWith("mailto:") && mailHref.includes(encodeURIComponent(JOIN)), mailHref ? "ok" : "missing");
    const note = await page.locator(".share-invite-note").innerText();
    check("B7 honest manual-attachment guidance", /attach/i.test(note) && /can.?t|cannot|can’t/i.test(note), note.slice(0, 90));

    // Save image → download only.
    await drainEvents(page);
    await page.locator("button.share-save").click();
    await sleep(400);
    let ev = await drainEvents(page);
    check("B8 Save image downloads the inktober PNG", ev.some((e) => e.t === "download" && e.name === `drawesome-inktober-${ROOM}.png`), JSON.stringify(ev));

    // Reopen: TikTok happy path — share BEFORE clipboard, file payload.
    await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    await drainEvents(page);
    await page.evaluate(() => { window.__shareBehavior = "ok"; });
    await page.locator("button.share-tiktok").click();
    await sleep(500);
    ev = await drainEvents(page);
    const shareIdx = ev.findIndex((e) => e.t === "share");
    const clipIdx = ev.findIndex((e) => e.t === "clipboard");
    check("B9 TikTok shares the card file natively", shareIdx >= 0 && ev[shareIdx].files && ev[shareIdx].files.length === 1
      && ev[shareIdx].files[0].name.endsWith(".png") && ev[shareIdx].files[0].type === "image/png" && ev[shareIdx].files[0].size > 20000,
      shareIdx >= 0 ? JSON.stringify(ev[shareIdx].files) : "no share");
    check("B10 navigator.share fires BEFORE any clipboard write", shareIdx >= 0 && (clipIdx === -1 || shareIdx < clipIdx), `share@${shareIdx} clip@${clipIdx}`);
    check("B11 TikTok caption has link + #inktober, no download fired", shareIdx >= 0 && ev[shareIdx].text.includes(JOIN) && ev[shareIdx].text.includes("#inktober") && !ev.some((e) => e.t === "download"));
    check("B12 sheet closed after a completed share", (await page.locator(".share-invite-sheet").count()) === 0);

    // Reopen: cancellation → no download, no window.open, sheet stays.
    await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    await drainEvents(page);
    await page.evaluate(() => { window.__shareBehavior = "abort"; });
    await page.locator("button.share-tiktok").click();
    await sleep(500);
    ev = await drainEvents(page);
    check("B13 cancelled share: no unsolicited download or site open", ev.some((e) => e.t === "share") && !ev.some((e) => e.t === "download" || e.t === "open"), JSON.stringify(ev.map((e) => e.t)));
    check("B14 sheet stays open after cancellation", await page.locator(".share-invite-sheet").isVisible());

    // Desktop fallback: canShare(files) false → download + open tiktok upload.
    await page.evaluate(() => { window.__shareBehavior = "ok"; window.__canShareFiles = false; });
    await drainEvents(page);
    await page.locator("button.share-instagram").click();
    await sleep(500);
    ev = await drainEvents(page);
    check("B15 Instagram desktop fallback saves card + opens instagram.com",
      ev.some((e) => e.t === "download" && e.name.endsWith(".png")) && ev.some((e) => e.t === "open" && e.url.includes("instagram.com"))
      && ev.some((e) => e.t === "clipboard") && !ev.some((e) => e.t === "share" && e.files), JSON.stringify(ev.map((e) => e.t)));

    // Reopen: native Share… stays link-only (no files).
    await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    await drainEvents(page);
    await page.locator("button.share-native").click();
    await sleep(400);
    ev = await drainEvents(page);
    const nativeShare = ev.find((e) => e.t === "share");
    check("B16 native Share… stays link-only with the seasonal caption",
      !!nativeShare && nativeShare.url === JOIN && nativeShare.files === null
      && typeof nativeShare.text === "string" && nativeShare.text.includes("#inktober") && nativeShare.text.includes(JOIN),
      nativeShare ? nativeShare.text.slice(0, 70) : "no share");

    // Reopen: X intent + theme toggle.
    await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    await drainEvents(page);
    await page.locator("button.share-x").click();
    await sleep(400);
    ev = await drainEvents(page);
    check("B17 X intent carries text + join URL", ev.some((e) => e.t === "open" && e.url.startsWith("https://x.com/intent/post") && e.url.includes(encodeURIComponent(JOIN))));

    await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    const before = await previewStats(page);
    await page.locator('.share-card-theme button:has-text("Classic")').click();
    await page.locator('.share-invite-sheet[data-card-theme="classic"]').waitFor({ timeout: 8000 });
    const after = await waitForCard(page);
    check("B18 toggle to Classic re-renders a pastel card", (await themePressed("Classic")) === "true"
      && !!after && !after.corners.every(isCream), after ? JSON.stringify(after.corners[0]) : "no preview");
    check("B19 toggle actually changed the pixels", !!before && !!after && before.ink !== after.ink, `ink ${before && before.ink} → ${after && after.ink}`);
    await page.locator('.share-card-theme button:has-text("Inktober")').click();
    await page.locator('.share-invite-sheet[data-card-theme="inktober"]').waitFor({ timeout: 8000 });
    const restored = await waitForCard(page);
    check("B20 toggle back to Inktober restores cream card", !!restored && restored.corners.every(isCream), restored ? JSON.stringify(restored.corners[0]) : "no preview");

    // "Share image…" — the native file share (pick Messages/Mail). Happy
    // path: card file + seasonal caption, and the clipboard is NEVER touched.
    // The button renders only when the canShare(files) probe passes, so set
    // the flag BEFORE reopening the sheet (the probe runs at render time).
    await page.evaluate(() => { window.__shareBehavior = "ok"; window.__canShareFiles = true; });
    await page.locator("button.share-invite-close").click();
    await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    await drainEvents(page);
    await page.locator("button.share-image").click();
    await sleep(500);
    ev = await drainEvents(page);
    const imgShare = ev.find((e) => e.t === "share" && e.files && e.files.length === 1);
    check("B21 Share image… sends the card file natively", !!imgShare
      && imgShare.files[0].name === `drawesome-inktober-${ROOM}.png` && imgShare.files[0].type === "image/png"
      && imgShare.text.includes(JOIN) && imgShare.text.includes("#inktober"),
      imgShare ? JSON.stringify(imgShare.files) : "no file share");
    check("B22 Share image… never writes the clipboard", !ev.some((e) => e.t === "clipboard"), JSON.stringify(ev.map((e) => e.t)));
    check("B23 sheet closes after a completed image share", (await page.locator(".share-invite-sheet").count()) === 0);

    // Reopen: cancelled image share is side-effect-free (AbortError).
    await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    await drainEvents(page);
    await page.evaluate(() => { window.__shareBehavior = "abort"; });
    await page.locator("button.share-image").click();
    await sleep(500);
    ev = await drainEvents(page);
    check("B24 cancelled image share: no download, tab or clipboard write",
      ev.some((e) => e.t === "share") && !ev.some((e) => e.t === "download" || e.t === "open" || e.t === "clipboard"),
      JSON.stringify(ev.map((e) => e.t)));
    check("B25 sheet stays open after image-share cancellation", await page.locator(".share-invite-sheet").isVisible());

    // File share unsupported (desktop): honest save-and-attach fallback.
    await page.evaluate(() => { window.__shareBehavior = "ok"; window.__canShareFiles = false; });
    await drainEvents(page);
    await page.locator("button.share-image").click();
    await sleep(500);
    ev = await drainEvents(page);
    check("B26 image-share fallback saves the card (no silent link-only share)",
      ev.some((e) => e.t === "download" && e.name === `drawesome-inktober-${ROOM}.png`)
      && !ev.some((e) => e.t === "share" && e.files && e.files.length), JSON.stringify(ev.map((e) => e.t)));

    // Reopen: flipping the theme invalidates the old card IMMEDIATELY — its
    // blob URL is revoked up front, so no handler can share a stale image.
    await page.locator("button.mp-invite:visible, button.fab-invite:visible").first().click();
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    await waitForCard(page);
    const oldSrc = await page.locator(".share-invite-preview img").getAttribute("src");
    await drainEvents(page);
    await page.locator('.share-card-theme button:has-text("Classic")').click();
    await page.locator('.share-invite-sheet[data-card-theme="classic"]').waitFor({ timeout: 8000 });
    await waitForCard(page);
    ev = await drainEvents(page);
    const newSrc = await page.locator(".share-invite-preview img").getAttribute("src");
    check("B27 theme flip revokes the old card URL before the new card lands",
      !!oldSrc && ev.some((e) => e.t === "revoke" && e.url === oldSrc) && !!newSrc && newSrc !== oldSrc,
      `old=${String(oldSrc).slice(0, 24)} revokes=${ev.filter((e) => e.t === "revoke").length}`);

    // Restore the Inktober theme for the screenshot.
    await page.locator('.share-card-theme button:has-text("Inktober")').click();
    await page.locator('.share-invite-sheet[data-card-theme="inktober"]').waitFor({ timeout: 8000 });
    await waitForCard(page);

    await page.screenshot({ path: path.join(OUT, "sheet-inktober-desktop.png") });
    await ctx.close();
  }

  // ---- Leg C: ended phase defaults to Classic -----------------------------
  {
    setClock("2026-11-05T12:00:00Z");
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(INTERCEPT);
    const page = await ctx.newPage();
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    await openStudioAndSheet(page, { draw: false });
    await sleep(800);
    const classicPressed = await page.locator('.share-card-theme button:has-text("Classic")').getAttribute("aria-pressed").catch(() => null);
    check("C1 outside October the default card style is Classic", classicPressed === "true", `pressed=${classicPressed}`);
    // The native link share must follow the SAME seasonal theme — Classic
    // here, so no #inktober tag leaks into the caption.
    await drainEvents(page);
    await page.locator("button.share-native").click();
    await sleep(400);
    const cev = await drainEvents(page);
    const cshare = cev.find((e) => e.t === "share");
    check("C2 ended-phase native share uses the Classic caption (no #inktober)",
      !!cshare && cshare.url === JOIN && typeof cshare.text === "string" && !cshare.text.includes("#inktober"),
      cshare ? cshare.text.slice(0, 70) : "no share");
    await ctx.close();
    setClock("2026-10-15T12:00:00Z");
  }

  // ---- Leg U: upcoming phase defaults to Classic (regression) -------------
  {
    setClock("2026-09-20T12:00:00Z"); // upcoming warm-up — NOT the season yet
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(INTERCEPT);
    const page = await ctx.newPage();
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    await openStudioAndSheet(page, { draw: false });
    await sleep(800);
    const classicPressed = await page.locator('.share-card-theme button:has-text("Classic")').getAttribute("aria-pressed").catch(() => null);
    check("U1 before October (upcoming) the default card style is Classic", classicPressed === "true", `pressed=${classicPressed}`);
    await ctx.close();
    setClock("2026-10-15T12:00:00Z");
  }

  // ---- Leg D: mobile layout ------------------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 744 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(INTERCEPT);
    const page = await ctx.newPage();
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    await openStudioAndSheet(page, { draw: false });
    const sheet = await page.locator(".share-invite-sheet").boundingBox();
    check("D1 sheet fits a 375px phone", !!sheet && sheet.x >= 0 && sheet.x + sheet.width <= 376, sheet ? `x=${Math.round(sheet.x)} w=${Math.round(sheet.width)}` : "no sheet");
    const overflow = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll(".share-invite-btn, .share-card-theme button")) {
        const r = el.getBoundingClientRect();
        if (r.left < -1 || r.right > 376) bad.push(el.textContent.trim());
      }
      return bad;
    });
    check("D2 every share button fits the phone width", overflow.length === 0, overflow.join(","));
    check("D3 all nine share actions present", (await page.locator(".share-invite-btn").count()) >= 9, `count=${await page.locator(".share-invite-btn").count()}`);
    await page.screenshot({ path: path.join(OUT, "sheet-inktober-mobile.png"), fullPage: true });
    await ctx.close();
  }

  // ---- Leg G: pinned inktoberPage prop (sketchbook integration) ------------
  // The sheet is mounted STANDALONE (no App.jsx changes) with a fixed
  // { year, day, prompt } page while the live clock says November (ended).
  {
    setClock("2026-11-05T12:00:00Z"); // ended — an unpinned sheet would go Classic
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(INTERCEPT);
    await ctx.addInitScript(FETCHSPY);
    const page = await ctx.newPage();
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.goto(HOME, { waitUntil: "domcontentloaded" });
    await sleep(1200);
    await page.evaluate(`(async () => {
      await import(${JSON.stringify(`/@fs${ENTRY}`)});
      window.__fetches = []; // the homepage itself fetched /api/inktober already
      window.__mountSheet({
        roomId: "PAGE7",
        roomTitle: "Inktober day 7",
        inktoberPage: { year: 2026, day: 7, prompt: "shell" },
        getArt: () => {
          const c = document.createElement("canvas");
          c.width = 1280; c.height = 800;
          const x = c.getContext("2d");
          x.fillStyle = "#ffffff"; x.fillRect(0, 0, 1280, 800);
          x.fillStyle = "#123456"; x.fillRect(420, 220, 440, 360);
          return c;
        },
        onClose: () => {},
        showToast: () => {},
      });
    })()`);
    await page.locator(".share-invite-sheet").waitFor({ timeout: 10000 });
    await page.locator(".share-invite-preview img").waitFor({ timeout: 15000 });
    const stats = await waitForCard(page);
    const isCream = (c) => c && Math.abs(c[0] - 0xfb) < 17 && Math.abs(c[1] - 0xf3) < 17 && Math.abs(c[2] - 0xdf) < 18;
    check("G1 pinned page defaults to Inktober even after October",
      (await page.locator(".share-invite-sheet").getAttribute("data-card-theme")) === "inktober"
      && (await page.locator('.share-card-theme button:has-text("Inktober")').getAttribute("aria-pressed")) === "true");
    check("G2 pinned sheet renders the cream ink card", !!stats && stats.w === 1080 && stats.corners.every(isCream) && stats.ink > 7500,
      stats ? `ink=${stats.ink}` : "no preview");
    check("G3 pinned DAY chip is stamped on the card", !!stats && stats.chip > 60, `chip=${stats && stats.chip}`);
    const fetches = await page.evaluate(() => window.__fetches.slice());
    check("G4 pinned page skips the live /api/inktober fetch", !fetches.some((u) => u.includes("/api/inktober")),
      fetches.filter((u) => u.includes("/api/")).join(",") || "no api calls");
    const smsG = await page.locator("a.share-sms").getAttribute("href").catch(() => null);
    check("G5 pinned caption carries the room link + #inktober",
      !!smsG && smsG.includes(encodeURIComponent("/join/PAGE7")) && smsG.includes(encodeURIComponent("#inktober")), smsG ? "ok" : "missing");

    // Invalid pinned metadata → live event fallback (ended → Classic).
    await page.evaluate(() => {
      window.__unmountSheets();
      window.__fetches = [];
      window.__mountSheet({
        roomId: "PAGE7",
        roomTitle: "Inktober day 7",
        inktoberPage: { year: 2026, day: 99, prompt: "shell" },
        getArt: () => { const c = document.createElement("canvas"); c.width = 64; c.height = 64; return c; },
        onClose: () => {},
        showToast: () => {},
      });
    });
    await page.locator(".share-invite-sheet").waitFor({ timeout: 10000 });
    let sawFetch = false;
    for (let i = 0; i < 40; i += 1) {
      sawFetch = await page.evaluate(() => window.__fetches.some((u) => u.includes("/api/inktober")));
      if (sawFetch) break;
      await sleep(300);
    }
    await sleep(600);
    check("G6 invalid pinned metadata falls back to the live event (Classic)",
      sawFetch && (await page.locator(".share-invite-sheet").getAttribute("data-card-theme")) === "classic",
      `fetch=${sawFetch}`);
    await ctx.close();
    setClock("2026-10-15T12:00:00Z");
  }

  check("E1 zero console/page errors end-to-end", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  vite.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); vite.kill(); process.exit(1); });
