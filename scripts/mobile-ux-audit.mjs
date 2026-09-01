// Mobile UX audit — "does this feel like an app on a phone/iPad?"
//
// Read-only. Drives the real server + real build across Pixel 7, iPad Pro 11
// (portrait AND landscape) and iPhone SE, and measures the things that decide
// whether a web app reads as native: tap-target size, chrome that collides,
// text you can't read, 100vh under a shrinking URL bar, iOS keyboard zoom,
// how many taps stand between "open the site" and "first stroke", and stray
// page scroll.
//
// Every finding prints as `PASS/WARN/FAIL  name — detail` and is backed by a
// screenshot in the ux/ scratch dir.
import { chromium, devices } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync, readFileSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "mobile-ux-audit-data");
const SHOTS =
  "C:/Users/CRAIGC~1/AppData/Local/Temp/claude/C--Users-Craig-Campbell-Projects-happypaint/4dc41c61-f491-4f84-9c89-8b730e65f50c/scratchpad/ux";
const PORT = 8931;
const BASE = `http://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH }, stdio: "pipe",
});
server.stderr.on("data", (d) => { if (/error/i.test(String(d))) process.stderr.write("[srv] " + d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (level, name, detail = "") => {
  results.push({ level, name, detail });
  console.log(`${level}  ${name}${detail ? " — " + detail : ""}`);
};

const shot = async (page, device, pageName, full = false) => {
  const file = `${device}-${pageName}.png`;
  await page.screenshot({ path: path.join(SHOTS, file), fullPage: full }).catch(() => {});
  return file;
};

// ---------------------------------------------------------------- probes ---
// U1 — tap targets. Anything a finger is meant to hit under 44x44 CSS px.
const TAP_PROBE = () => {
  const out = [];
  const nodes = document.querySelectorAll("button, a, [role=button], input");
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) continue;
    // Off-viewport elements aren't tappable right now; measured separately.
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    if (r.width >= 44 && r.height >= 44) continue;
    const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.type || "")
      .trim().replace(/\s+/g, " ").slice(0, 34);
    const sel = el.tagName.toLowerCase() +
      (el.id ? "#" + el.id : "") +
      (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "");
    out.push({ sel: sel.slice(0, 90), label, w: Math.round(r.width), h: Math.round(r.height), area: r.width * r.height });
  }
  out.sort((a, b) => a.area - b.area);
  return out;
};

// U2 — chrome collisions + unreachable chrome.
const CHROME_SELECTORS = [".mobile-quickbar", ".cc-pill", ".cc-panel", ".studio-rooms-fab",
  ".room-prompt-chip", ".wipe-chip", ".reaction-picker", ".zoom-controls", ".tool-rail",
  ".game-hud", ".phone-banner", ".vote-card"];

const OVERLAP_PROBE = (sels) => {
  const found = [];
  for (const s of sels) {
    for (const el of document.querySelectorAll(s)) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // A closed sheet is parked wholly outside the viewport by a transform —
      // that's the design, not a layout bug. Only chrome that is at least
      // partly on screen counts. (Centering transforms like translateX(-50%)
      // keep the rect on screen, so they still count.)
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      found.push({ sel: s, pos: cs.position, z: cs.zIndex, r: { l: r.left, t: r.top, rt: r.right, b: r.bottom, w: r.width, h: r.height } });
    }
  }
  const pairs = [];
  for (let i = 0; i < found.length; i += 1) {
    for (let j = i + 1; j < found.length; j += 1) {
      const a = found[i].r; const b = found[j].r;
      const ow = Math.min(a.rt, b.rt) - Math.max(a.l, b.l);
      const oh = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (ow > 2 && oh > 2) {
        pairs.push({
          a: found[i].sel, b: found[j].sel,
          overlap: `${Math.round(ow)}x${Math.round(oh)}px`,
          pctOfSmaller: Math.round((ow * oh) / Math.min(a.w * a.h, b.w * b.h) * 100),
        });
      }
    }
  }
  const offscreen = found.filter((f) => f.r.b < 0 || f.r.t > innerHeight || f.r.rt < 0 || f.r.l > innerWidth
    || f.r.b > innerHeight + 1 || f.r.t < -1)
    .map((f) => ({ sel: f.sel, top: Math.round(f.r.t), bottom: Math.round(f.r.b), vh: innerHeight }));
  // Canvas-edge encroachment: chrome sitting on top of the drawing surface.
  const canvas = document.querySelector(".draw-canvas, canvas");
  let onCanvas = [];
  if (canvas) {
    const c = canvas.getBoundingClientRect();
    onCanvas = found.filter((f) => {
      const ow = Math.min(c.right, f.r.rt) - Math.max(c.left, f.r.l);
      const oh = Math.min(c.bottom, f.r.b) - Math.max(c.top, f.r.t);
      return ow > 2 && oh > 2;
    }).map((f) => ({ sel: f.sel, coverPct: Math.round(f.r.w * f.r.h / (c.width * c.height) * 100) }));
  }
  return { present: found.map((f) => f.sel), pairs, offscreen, onCanvas };
};

// U3 — legibility. Small text, plus contrast of chrome text against what is
// actually behind it (compositing rgba layers down onto the white canvas).
const TEXT_PROBE = () => {
  const parse = (c) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c || "");
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  const small = []; const low = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.nodeValue || "").trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.top > innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) < 0.05) continue;
    const fs = parseFloat(cs.fontSize);
    const sel = el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
    if (fs < 12) small.push({ sel: sel.slice(0, 70), text: t.slice(0, 28), fs: +fs.toFixed(1) });

    // Composite every ancestor background down onto white (the canvas).
    const fg = parse(cs.color); if (!fg) continue;
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const c = parse(getComputedStyle(a).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      if (c && c.a === 1) break;
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) bg = over(stack[i], bg);
    const cr = ratio(over(fg, bg), bg);
    const big = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    const need = big ? 3 : 4.5;
    if (cr < need) low.push({ sel: sel.slice(0, 70), text: t.slice(0, 24), fs: +fs.toFixed(1), ratio: +cr.toFixed(2), need });
  }
  small.sort((a, b) => a.fs - b.fs);
  low.sort((a, b) => a.ratio - b.ratio);
  return { small, low };
};

const SCROLL_PROBE = () => ({
  scrollHeight: document.documentElement.scrollHeight,
  innerHeight: window.innerHeight,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  bodyScrollWidth: document.body.scrollWidth,
  widest: (() => {
    let worst = null;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 2 && r.width > 8) {
        const sel = el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
        if (!worst || r.right > worst.right) worst = { sel: sel.slice(0, 60), right: Math.round(r.right) };
      }
    }
    return worst;
  })(),
});

// ------------------------------------------------------------------- run ---
const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  const browser = await chromium.launch({ headless: true });

  const iphoneSE = devices["iPhone SE"]
    ? { ...devices["iPhone SE"] }
    : { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

  const PROFILES = [
    { key: "pixel7", label: "Pixel 7", opts: { ...devices["Pixel 7"] }, touch: true },
    { key: "ipad-portrait", label: "iPad Pro 11 portrait", opts: { ...devices["iPad Pro 11"] }, touch: true },
    {
      key: "ipad-landscape", label: "iPad Pro 11 landscape",
      opts: { ...devices["iPad Pro 11"], viewport: { width: 1194, height: 834 } }, touch: true,
    },
    { key: "iphonese", label: "iPhone SE", opts: iphoneSE, touch: true },
  ];

  const tapWorst = [];        // U1 accumulator
  const smallText = [];       // U3
  const lowContrast = [];     // U3
  let firstStroke = null;     // U6
  let landscape = null;       // U7

  for (const prof of PROFILES) {
    const ctx = await browser.newContext({ ...prof.opts, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    // ---------------- homepage ----------------
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    const homeShot = await shot(page, prof.key, "home", true);
    const homeTaps = await page.evaluate(TAP_PROBE);
    tapWorst.push(...homeTaps.map((t) => ({ ...t, device: prof.label, page: "/", shot: homeShot })));
    const homeText = await page.evaluate(TEXT_PROBE);
    smallText.push(...homeText.small.map((t) => ({ ...t, device: prof.label, page: "/", shot: homeShot })));
    lowContrast.push(...homeText.low.map((t) => ({ ...t, device: prof.label, page: "/", shot: homeShot })));
    const homeScroll = await page.evaluate(SCROLL_PROBE);
    log(homeScroll.scrollWidth <= homeScroll.innerWidth + 2 ? "PASS" : "FAIL",
      `U8 no horizontal overflow on / (${prof.label})`,
      `scrollWidth=${homeScroll.scrollWidth} vw=${homeScroll.innerWidth}` +
      (homeScroll.widest ? ` worst=${homeScroll.widest.sel}@${homeScroll.widest.right}px` : "") + ` [${homeShot}]`);

    // U5 — the homepage room-code input (iOS zooms in when font-size < 16px).
    const codeInput = await page.evaluate(() => {
      const el = document.querySelector('.home-page input, input[placeholder*="ode" i], input');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { fs: parseFloat(cs.fontSize), h: Math.round(r.height), radius: cs.borderRadius, ph: el.placeholder || "" };
    });
    if (codeInput) {
      log(codeInput.fs >= 16 ? "PASS" : "FAIL",
        `U5 homepage room-code input font-size (${prof.label})`,
        `${codeInput.fs}px${codeInput.fs < 16 ? " — iOS will zoom the page on focus" : ""}, height=${codeInput.h}px [${homeShot}]`);
    }

    // U6 — first-stroke friction, measured once on the phone profile.
    if (prof.key === "pixel7") {
      const steps = [];
      const blockers = await page.evaluate(() => {
        const sels = [".modal-backdrop", ".welcome-modal", ".consent", "[role=dialog]", ".cookie", ".age-gate"];
        return sels.flatMap((s) => [...document.querySelectorAll(s)]
          .filter((e) => e.getBoundingClientRect().width > 40)
          .map((e) => s));
      });
      // Tap the first primary CTA on the homepage.
      const cta = page.locator(".primary-action, .home-viewer-cta").first();
      let ok = false;
      if (await cta.count()) {
        const label = (await cta.innerText().catch(() => "")).trim();
        await cta.click({ timeout: 5000 }).catch(() => {});
        steps.push(`tap "${label || "primary action"}"`);
        await sleep(3000);
        ok = await page.evaluate(() => !!document.querySelector("canvas"));
      }
      const strokeShot = await shot(page, prof.key, "first-stroke");
      // Does anything sit between arriving and drawing?
      const gate = await page.evaluate(() => {
        const d = [...document.querySelectorAll(".modal-backdrop, [role=dialog]")]
          .filter((e) => e.getBoundingClientRect().width > 40);
        return d.map((e) => (typeof e.className === "string" ? e.className : "dialog").slice(0, 60));
      });
      firstStroke = { steps, ok, blockers, gate, shot: strokeShot };
      // A canvas you can't touch yet isn't a drawable canvas — an interstitial
      // sitting over it counts as another tap before the first stroke.
      const taps = steps.length + gate.length;
      log(ok && taps <= 1 ? "PASS" : ok ? "WARN" : "FAIL",
        "U6 taps from / to a drawable canvas",
        `${taps} tap(s): ${[...steps, ...gate.map(() => "dismiss interstitial")].join(" → ") || "none"}; canvas=${ok}` +
        `; interrupting dialogs=${gate.length ? gate.join(",") : "none"}` +
        `; on-load dialogs=${blockers.length ? [...new Set(blockers)].join(",") : "none"} [${strokeShot}]`);
    }

    // ---------------- studio ----------------
    await page.goto(`${BASE}/join/ZZUXAUDIT`, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    const studioShot = await shot(page, prof.key, "studio");
    const studioTaps = await page.evaluate(TAP_PROBE);
    tapWorst.push(...studioTaps.map((t) => ({ ...t, device: prof.label, page: "/join", shot: studioShot })));
    const studioText = await page.evaluate(TEXT_PROBE);
    smallText.push(...studioText.small.map((t) => ({ ...t, device: prof.label, page: "/join", shot: studioShot })));
    lowContrast.push(...studioText.low.map((t) => ({ ...t, device: prof.label, page: "/join", shot: studioShot })));

    // U1 — call out the quickbar specifically; it's the primary tool surface.
    const qb = await page.evaluate(() => {
      const bar = document.querySelector(".mobile-quickbar");
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      const btns = [...bar.querySelectorAll("button")].map((b) => {
        const br = b.getBoundingClientRect();
        return { label: (b.textContent || "").trim().slice(0, 12), w: Math.round(br.width), h: Math.round(br.height) };
      });
      return { visible: r.width > 2, bottom: Math.round(r.bottom), vh: innerHeight, h: Math.round(r.height), btns };
    });
    if (qb && qb.visible) {
      const bad = qb.btns.filter((b) => b.w < 44 || b.h < 44);
      log(bad.length ? "FAIL" : "PASS", `U1 quickbar tap targets (${prof.label})`,
        `${qb.btns.length} buttons, bar ${qb.h}px tall; under-44px: ` +
        (bad.map((b) => `${b.label} ${b.w}x${b.h}`).join(", ") || "none") + ` [${studioShot}]`);
      log(qb.bottom <= qb.vh + 1 ? "PASS" : "FAIL", `U2 quickbar sits inside the viewport (${prof.label})`,
        `bottom=${qb.bottom} vh=${qb.vh} [${studioShot}]`);
    } else {
      log("WARN", `U1 quickbar not rendered (${prof.label})`, `no .mobile-quickbar at this width [${studioShot}]`);
    }

    // U2 — chrome collisions.
    const ov = await page.evaluate(OVERLAP_PROBE, CHROME_SELECTORS);
    log(ov.pairs.length ? "WARN" : "PASS", `U2 chrome overlaps (${prof.label})`,
      `visible chrome: ${[...new Set(ov.present)].join(" ") || "none"}; collisions: ` +
      (ov.pairs.map((p) => `${p.a}×${p.b} ${p.overlap} (${p.pctOfSmaller}% of smaller)`).join("; ") || "none") +
      ` [${studioShot}]`);
    log(ov.offscreen.length ? "FAIL" : "PASS", `U2 chrome fully on-screen (${prof.label})`,
      (ov.offscreen.map((o) => `${o.sel} top=${o.top} bottom=${o.bottom} vh=${o.vh}`).join("; ") || "all inside") +
      ` [${studioShot}]`);
    log(ov.onCanvas.length > 3 ? "WARN" : "PASS", `U2 chrome over the canvas (${prof.label})`,
      `${ov.onCanvas.length} element(s) sit on the drawing surface: ` +
      (ov.onCanvas.map((o) => `${o.sel} ${o.coverPct}%`).join(", ") || "none") + ` [${studioShot}]`);

    // U8 — the studio must not scroll like a document.
    const ss = await page.evaluate(SCROLL_PROBE);
    log(ss.scrollHeight <= ss.innerHeight + 2 ? "PASS" : "FAIL",
      `U8 studio does not scroll vertically (${prof.label})`,
      `scrollHeight=${ss.scrollHeight} innerHeight=${ss.innerHeight} (+${ss.scrollHeight - ss.innerHeight}px) [${studioShot}]`);
    log(ss.scrollWidth <= ss.innerWidth + 2 ? "PASS" : "FAIL",
      `U8 studio has no horizontal overflow (${prof.label})`,
      `scrollWidth=${ss.scrollWidth} vw=${ss.innerWidth}` +
      (ss.widest ? ` worst=${ss.widest.sel}@${ss.widest.right}px` : "") + ` [${studioShot}]`);

    // U7 — landscape iPad: how much of that width becomes drawing surface?
    if (prof.key === "ipad-landscape") {
      landscape = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        const cr = c ? c.getBoundingClientRect() : null;
        const rail = document.querySelector(".tool-rail, .studio-rail, .mobile-quickbar");
        const rr = rail ? rail.getBoundingClientRect() : null;
        return {
          vw: innerWidth, vh: innerHeight,
          canvas: cr ? { w: Math.round(cr.width), h: Math.round(cr.height), l: Math.round(cr.left), t: Math.round(cr.top) } : null,
          canvasPct: cr ? Math.round((cr.width * cr.height) / (innerWidth * innerHeight) * 100) : 0,
          rail: rr ? { sel: rail.className.slice(0, 40), w: Math.round(rr.width), h: Math.round(rr.height), t: Math.round(rr.top), l: Math.round(rr.left) } : null,
        };
      });
      log(landscape.canvasPct >= 55 ? "PASS" : "WARN", "U7 iPad landscape canvas uses the width",
        `canvas ${landscape.canvas ? landscape.canvas.w + "x" + landscape.canvas.h : "none"} = ${landscape.canvasPct}% of the ${landscape.vw}x${landscape.vh} viewport; ` +
        `primary tool surface: ${landscape.rail ? landscape.rail.sel + " " + landscape.rail.w + "x" + landscape.rail.h + " @" + landscape.rail.l + "," + landscape.rail.t : "none"} [${studioShot}]`);
    }

    // ---- open chat via quickbar 💬 ----
    const chatBtn = page.locator(".mobile-quickbar button", { hasText: "Chat" }).first();
    let chatShot = null;
    if (await chatBtn.count()) {
      await chatBtn.click({ timeout: 4000 }).catch(() => {});
      await sleep(900);
      chatShot = await shot(page, prof.key, "studio-chat");
      const chatTaps = await page.evaluate(TAP_PROBE);
      tapWorst.push(...chatTaps.map((t) => ({ ...t, device: prof.label, page: "/join chat", shot: chatShot })));

      // U5 — chat input: font-size and does focusing it push the field off-screen.
      const input = page.locator(".cc-form input").first();
      if (await input.count()) {
        const before = await input.evaluate((el) => ({ fs: parseFloat(getComputedStyle(el).fontSize) }));
        await input.click({ timeout: 3000 }).catch(() => {});
        await input.type("hi", { delay: 20 }).catch(() => {});
        await sleep(500);
        const after = await input.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { bottom: Math.round(r.bottom), top: Math.round(r.top), vh: innerHeight, h: Math.round(r.height) };
        });
        const kbShot = await shot(page, prof.key, "studio-chat-focus");
        log(before.fs >= 16 ? "PASS" : "FAIL", `U5 chat input font-size (${prof.label})`,
          `${before.fs}px${before.fs < 16 ? " — iOS Safari zooms the whole page on focus" : ""} [${kbShot}]`);
        log(after.bottom <= after.vh + 1 && after.top >= -1 ? "PASS" : "FAIL",
          `U5 focused chat input stays in the viewport (${prof.label})`,
          `top=${after.top} bottom=${after.bottom} vh=${after.vh} [${kbShot}]`);
      } else {
        log("WARN", `U5 chat input not found (${prof.label})`, `.cc-form input missing [${chatShot || "n/a"}]`);
      }
      // Close chat again so the tools drawer isn't measured behind it.
      await chatBtn.click({ timeout: 3000 }).catch(() => {});
      await sleep(500);
    } else {
      log("WARN", `U5 chat button not in quickbar (${prof.label})`, "no 💬 Chat button");
    }

    // ---- open the tools drawer via quickbar 🎨 ----
    const toolsBtn = page.locator(".mobile-quickbar button", { hasText: "Tools" }).first();
    if (await toolsBtn.count()) {
      await toolsBtn.click({ timeout: 4000 }).catch(() => {});
      await sleep(900);
      const toolsShot = await shot(page, prof.key, "studio-tools");
      const toolTaps = await page.evaluate(TAP_PROBE);
      tapWorst.push(...toolTaps.map((t) => ({ ...t, device: prof.label, page: "/join tools", shot: toolsShot })));
      const drawer = await page.evaluate(() => {
        const el = document.querySelector(".tools-sheet, .tool-drawer, .studio-tools, .tools-panel, .brush-panel");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          sel: el.className.slice(0, 50), top: Math.round(r.top), bottom: Math.round(r.bottom),
          vh: innerHeight, scrollable: el.scrollHeight > el.clientHeight + 4,
          overflowY: getComputedStyle(el).overflowY,
        };
      });
      if (drawer) {
        log(drawer.bottom <= drawer.vh + 1 && drawer.top >= -1 ? "PASS" : "FAIL",
          `U2 tools drawer fits the viewport (${prof.label})`,
          `${drawer.sel} top=${drawer.top} bottom=${drawer.bottom} vh=${drawer.vh} overflowY=${drawer.overflowY} [${toolsShot}]`);
      } else {
        log("WARN", `U2 tools drawer element not identified (${prof.label})`, `screenshot only [${toolsShot}]`);
      }
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(300);
    } else {
      log("WARN", `U1 Tools button not in quickbar (${prof.label})`, "no 🎨 Tools button");
    }

    // ---------------- /wall ----------------
    await page.goto(`${BASE}/wall`, { waitUntil: "domcontentloaded" });
    await sleep(1800);
    const wallShot = await shot(page, prof.key, "wall", true);
    const wallTaps = await page.evaluate(TAP_PROBE);
    tapWorst.push(...wallTaps.map((t) => ({ ...t, device: prof.label, page: "/wall", shot: wallShot })));
    const wallText = await page.evaluate(TEXT_PROBE);
    smallText.push(...wallText.small.map((t) => ({ ...t, device: prof.label, page: "/wall", shot: wallShot })));
    const ws = await page.evaluate(SCROLL_PROBE);
    log(ws.scrollWidth <= ws.innerWidth + 2 ? "PASS" : "FAIL",
      `U8 no horizontal overflow on /wall (${prof.label})`,
      `scrollWidth=${ws.scrollWidth} vw=${ws.innerWidth}` +
      (ws.widest ? ` worst=${ws.widest.sel}@${ws.widest.right}px` : "") + ` [${wallShot}]`);

    // ---------------- /rooms ----------------
    await page.goto(`${BASE}/rooms`, { waitUntil: "domcontentloaded" });
    await sleep(1600);
    const roomsShot = await shot(page, prof.key, "rooms", true);
    const roomTaps = await page.evaluate(TAP_PROBE);
    tapWorst.push(...roomTaps.map((t) => ({ ...t, device: prof.label, page: "/rooms", shot: roomsShot })));
    const rs = await page.evaluate(SCROLL_PROBE);
    log(rs.scrollWidth <= rs.innerWidth + 2 ? "PASS" : "FAIL",
      `U8 no horizontal overflow on /rooms (${prof.label})`,
      `scrollWidth=${rs.scrollWidth} vw=${rs.innerWidth}` +
      (rs.widest ? ` worst=${rs.widest.sel}@${rs.widest.right}px` : "") + ` [${roomsShot}]`);

    // U9 evidence — app-shell tells that show up in computed styles.
    if (prof.key === "pixel7") {
      const polish = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const bodyCs = getComputedStyle(document.body);
        const inputs = [...document.querySelectorAll("input")].slice(0, 6).map((el) => {
          const s = getComputedStyle(el);
          return { radius: s.borderRadius, appearance: s.webkitAppearance || s.appearance, fs: s.fontSize };
        });
        return {
          tapHighlight: bodyCs.webkitTapHighlightColor || "unset",
          userSelect: bodyCs.webkitUserSelect || bodyCs.userSelect,
          overscroll: bodyCs.overscrollBehavior + " / " + cs.overscrollBehavior,
          touchAction: bodyCs.touchAction,
          scrollbarWidth: cs.scrollbarWidth || "auto",
          textSizeAdjust: cs.webkitTextSizeAdjust || "unset",
          inputs,
          hasFocusVisibleRule: [...document.styleSheets].some((sh) => {
            try { return [...sh.cssRules].some((r) => /focus-visible/.test(r.cssText)); } catch { return false; }
          }),
        };
      });
      log("INFO", "U9 app-shell computed styles (Pixel 7)",
        `tap-highlight=${polish.tapHighlight}; user-select=${polish.userSelect}; ` +
        `overscroll-behavior=${polish.overscroll}; touch-action=${polish.touchAction}; ` +
        `scrollbar-width=${polish.scrollbarWidth}; text-size-adjust=${polish.textSizeAdjust}; ` +
        `:focus-visible styling=${polish.hasFocusVisibleRule}; inputs=` +
        polish.inputs.map((i) => `r${i.radius}/${i.fs}`).join(",") + ` [${roomsShot}]`);
    }

    await ctx.close();
  }

  // -------------------------------------------------- aggregate reporting ---
  // U1 — the 15 worst tap targets across every device/page.
  const dedup = new Map();
  for (const t of tapWorst) {
    const k = `${t.sel}|${t.w}x${t.h}|${t.device}`;
    if (!dedup.has(k)) dedup.set(k, t);
  }
  const worst = [...dedup.values()].sort((a, b) => a.area - b.area).slice(0, 15);
  log(worst.length ? "FAIL" : "PASS", "U1 tap targets under 44x44 CSS px",
    `${dedup.size} distinct under-sized controls; worst 15 follow`);
  worst.forEach((t, i) => console.log(
    `        ${String(i + 1).padStart(2)}. ${t.w}x${t.h}px  ${t.sel}  "${t.label}"  [${t.device} ${t.page}] ${t.shot}`));

  // U3 — small text.
  const smallDedup = new Map();
  for (const t of smallText) if (!smallDedup.has(t.sel + t.fs)) smallDedup.set(t.sel + t.fs, t);
  const smalls = [...smallDedup.values()].sort((a, b) => a.fs - b.fs);
  log(smalls.length ? "WARN" : "PASS", "U3 text under 12px",
    `${smalls.length} distinct; smallest: ` +
    smalls.slice(0, 8).map((s) => `${s.fs}px ${s.sel} "${s.text}"`).join(" | ") +
    (smalls[0] ? ` [${smalls[0].shot}]` : ""));

  // U3 — contrast.
  const lcDedup = new Map();
  for (const t of lowContrast) if (!lcDedup.has(t.sel + t.ratio)) lcDedup.set(t.sel + t.ratio, t);
  const lcs = [...lcDedup.values()].sort((a, b) => a.ratio - b.ratio);
  log(lcs.length ? "WARN" : "PASS", "U3 contrast below WCAG AA over the white canvas",
    `${lcs.length} distinct; worst: ` +
    lcs.slice(0, 8).map((s) => `${s.ratio}:1 (need ${s.need}) ${s.sel} "${s.text}"`).join(" | ") +
    (lcs[0] ? ` [${lcs[0].shot}]` : ""));

  // U4 — layout units, straight from the stylesheets.
  const css = ["src/App.css", "src/studio-layout.css", "src/drawesome-theme.css", "src/index.css", "src/homepage-redesign.css"]
    .map((f) => { try { return { f, t: readFileSync(path.join(ROOT, f), "utf8") }; } catch { return null; } })
    .filter(Boolean);
  const vhHits = [];
  for (const { f, t } of css) {
    t.split("\n").forEach((line, i) => {
      if (/\b\d+vh\b/.test(line) && !/dvh|svh|lvh/.test(line)) vhHits.push(`${f}:${i + 1} ${line.trim().slice(0, 78)}`);
    });
  }
  const dvhCount = css.reduce((n, { t }) => n + (t.match(/\d+dvh/g) || []).length, 0);
  const safeCount = css.reduce((n, { t }) => n + (t.match(/safe-area-inset/g) || []).length, 0);
  const safeBottom = css.reduce((n, { t }) => n + (t.match(/safe-area-inset-bottom/g) || []).length, 0);
  log(vhHits.length > dvhCount ? "WARN" : "PASS", "U4 100vh vs dvh in the stylesheets",
    `${vhHits.length} raw vh declarations vs ${dvhCount} dvh; raw-vh sites that affect full-height layout: ` +
    vhHits.filter((h) => /height/.test(h)).slice(0, 10).join(" || "));
  log(safeBottom > 0 ? "PASS" : "FAIL", "U4 bottom chrome honours env(safe-area-inset-bottom)",
    `${safeBottom} of ${safeCount} safe-area references target the bottom inset`);

  // U5 — viewport meta.
  const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
  const meta = /content="([^"]*width=device-width[^"]*)"/.exec(html);
  const mc = meta ? meta[1] : "(not found)";
  log(/interactive-widget=resizes-content/.test(mc) ? "PASS" : "FAIL",
    "U5 viewport meta has interactive-widget=resizes-content", mc);
  log(/user-scalable=no|maximum-scale=1/.test(mc) ? "WARN" : "PASS",
    "U5 viewport blocks pinch-zoom",
    /user-scalable=no|maximum-scale=1/.test(mc)
      ? "user-scalable=no / maximum-scale=1 — app-like, but ignored by iOS Safari 10+ and an a11y trade-off"
      : "pinch-zoom allowed");
  log(/viewport-fit=cover/.test(mc) ? "PASS" : "WARN", "U5 viewport-fit=cover (notch/home-indicator)", mc);

  // Manifest — the "no download" install path.
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(path.join(ROOT, "dist/manifest.webmanifest"), "utf8")); } catch { /* none */ }
  log(manifest && manifest.display && manifest.display !== "browser" ? "PASS" : "WARN",
    "U9 PWA manifest display mode",
    manifest ? `display=${manifest.display} name=${manifest.name} icons=${(manifest.icons || []).length}` : "no manifest found");

  await browser.close();
  server.kill();

  const fails = results.filter((r) => r.level === "FAIL").length;
  const warns = results.filter((r) => r.level === "WARN").length;
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(`${fails + warns} findings (${fails} FAIL, ${warns} WARN, ${results.length} checks)`);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
