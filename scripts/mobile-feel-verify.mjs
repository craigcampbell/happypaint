// Native-app feel on phones and iPads.
//
// Reported bug: while kids are DRAWING, the platform's long-press UI keeps
// interrupting — Android Chrome's "Save image / Copy image" sheet, iOS's
// "Copy · Look Up · Translate" callout, a drag-ghost peeling off an image,
// the page zooming on a double tap or an input focus.
//
// index.css already sets user-select/touch-callout/tap-highlight none on
// html/body/#root and touch-action on *, and index.html pins the viewport.
// This harness asks whether that is ENOUGH by driving REAL long presses at
// every element a finger can land on over the canvas, plus a synthetic
// contextmenu probe per target that isolates which elements have a handler.
//
// Runs the same suite on three devices: Pixel 7 (Chromium / Android Chrome),
// iPad Pro 11 and iPhone 14 (WebKit / iOS Safari engine).
import { chromium, webkit, devices } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "mobile-feel-data");
const PORT = 8930;
const BASE = `http://localhost:${PORT}`;
const ROOM = "/join/ZZMOBILE";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });

// Seed the public wall so /wall and the homepage strip actually render <img>
// tiles — an empty wall would silently SKIP every image check, which is
// exactly where "Save image / Copy image" bites. The server loads these at
// boot from DATA_DIR/.wall; nothing in the app is modified.
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoz2NkYPjPQApgYhhVMKpgVMGoAtIUAABuVQEBSk1DPQAAAABJRU5ErkJggg==";
const WALL_DIR = path.join(SCRATCH, ".wall");
mkdirSync(WALL_DIR, { recursive: true });
for (let i = 0; i < 4; i += 1) {
  const id = `wp_seed${i}`;
  const meta = {
    id, title: `Seed drawing ${i}`, tags: ["rainbow", "cats"], artist: "Test Kid",
    ownerKey: "seed", createdAt: Date.now() - i * 1000, votedBy: {}, reportedBy: {},
    frameCount: 1, durationMs: 400, reports: 0, hidden: false, challenge: null,
    allowRemix: true, parentPostId: null, rootPostId: null,
  };
  writeFileSync(path.join(WALL_DIR, `${id}.json`), JSON.stringify(meta));
  writeFileSync(path.join(WALL_DIR, `${id}.frames.json`), JSON.stringify([PNG_1PX]));
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH }, stdio: "pipe",
});
server.stderr.on("data", (d) => { if (process.env.SRV_LOG) process.stderr.write("[srv] " + d); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let device = "";
const check = (name, ok, detail = "") => {
  results.push({ device, name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const skip = (name, detail = "") => {
  results.push({ device, name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? " — " + detail : ""}`);
};
// One crash in a probe must never hide the rest of the suite.
const guard = async (name, fn) => {
  try { await fn(); } catch (e) { check(name, false, "harness threw: " + String(e).slice(0, 160)); }
};

// Everything a finger can land on while aiming at the canvas, per page.
const HOT = {
  room: [
    ".overlay-canvas", ".display-canvas", ".canvas-paper", ".brush-cursor",
    ".remote-cursor-layer", ".reaction-layer", ".hype-layer", ".room-prompt-chip",
    ".wipe-chip", ".mobile-quickbar", ".tool-rail", ".status-line",
    ".cc-pill", ".cc-ambient", ".cc-doodle", ".topbar-brand", ".studio-workspace",
  ],
  home: [
    ".home-viewer", ".home-wall-tile img", ".home-wall-tile", ".home-code",
    ".home-hero", ".home-paper", ".home-banter", ".site-nav", "h1",
  ],
  wall: [
    ".wall-card", ".wall-art img", ".wall-art", ".wall-title", ".wall-tag",
    ".wall-artist", ".wall-hero", ".wall-main", "h1",
  ],
};

// Capture + bubble listeners. The bubble one reads defaultPrevented in a
// setTimeout so it reports the state AFTER every handler on the page ran —
// that is what the browser itself consults before showing the callout.
const INIT = () => {
  window.__cm = [];
  window.__cmSeq = 0;
  const rec = (e, phase) => {
    const cls = (typeof e.target?.className === "string" && e.target.className)
      || e.target?.tagName || "?";
    const entry = {
      seq: (window.__cmSeq += 1), phase, target: String(cls).slice(0, 60),
      preventedAtCapture: e.defaultPrevented, prevented: e.defaultPrevented,
    };
    window.__cm.push(entry);
    setTimeout(() => { entry.prevented = e.defaultPrevented; }, 0);
  };
  document.addEventListener("contextmenu", (e) => rec(e, "capture"), true);
  document.addEventListener("contextmenu", (e) => rec(e, "bubble"), false);
};

async function targetBox(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { present: false };
    let r = el.getBoundingClientRect();
    // A finger can reach anything below the fold — scroll it up before probing.
    if (r.height > 1 && (r.bottom <= 0 || r.top >= window.innerHeight)) {
      el.scrollIntoView({ block: "center" });
      r = el.getBoundingClientRect();
    }
    if (r.width < 2 || r.height < 2) return { present: true, sized: false };
    const cx = Math.round(Math.min(Math.max(r.left + r.width / 2, 2), window.innerWidth - 2));
    const cy = Math.round(Math.min(Math.max(r.top + r.height / 2, 2), window.innerHeight - 2));
    const onScreen = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    const top = document.elementFromPoint(cx, cy);
    const topCls = top ? (typeof top.className === "string" && top.className ? top.className : top.tagName) : "none";
    return { present: true, sized: true, onScreen, cx, cy, hit: String(topCls).slice(0, 40) };
  }, sel);
}

async function longPressCDP(cdp, x, y, ms) {
  const pt = [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
  await sleep(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// WebKit has no CDP: probe the same question by dispatching a cancelable
// contextmenu and asking whether anything called preventDefault.
async function syntheticContextMenu(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    const notCancelled = el.dispatchEvent(ev);
    return { prevented: !notCancelled, defaultPrevented: ev.defaultPrevented };
  }, sel);
}

async function selectionState(page) {
  return page.evaluate(() => {
    const s = window.getSelection();
    return {
      text: s ? s.toString() : "",
      rangeCount: s ? s.rangeCount : 0,
      collapsed: !s || s.rangeCount === 0 || s.getRangeAt(0).collapsed,
    };
  });
}

async function clearSelection(page) {
  await page.evaluate(() => { try { window.getSelection()?.removeAllRanges(); } catch { /* none */ } });
}

// -webkit-touch-callout is a touch-platform property. Playwright's desktop
// WebKit build may not expose it to getComputedStyle at all — in that case an
// empty computed value means "engine can't report it", NOT "the rule is
// missing". Probe body (which index.css sets to none) to tell the two apart.
async function calloutReportable(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const v = cs.getPropertyValue("-webkit-touch-callout") || cs.webkitTouchCallout || "";
    const supports = typeof CSS !== "undefined" && CSS.supports
      ? CSS.supports("-webkit-touch-callout", "none") : false;
    return { value: String(v).trim(), supports };
  });
}

async function runPage(page, cdp, engine, pageName, url) {
  const errors = [];
  const onErr = (e) => errors.push(String(e));
  page.on("pageerror", onErr);
  console.log(`\n  -- ${pageName} (${url}) --`);
  const settle = pageName === "room" ? 2500 : 1500;
  const ensureOn = async () => {
    if (page.url() === BASE + url) return false;
    await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
    await sleep(settle);
    return true;
  };
  await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
  await sleep(settle);

  const targets = HOT[pageName];
  const P = (n) => `[${pageName}] ${n}`;

  // ---- C1 / C2: real contextmenu at the target, and no selection after ----
  for (const sel of targets) {
    await guard(P(`C1 long-press ${sel}`), async () => {
      // A press can navigate (these are buttons and links); always come back
      // so later targets are still on the page we think we're testing.
      await ensureOn();
      const box = await targetBox(page, sel);
      if (!box.present) { skip(P(`C1 long-press ${sel}`), "not on this page"); return; }
      if (!box.sized) { skip(P(`C1 long-press ${sel}`), "zero-size element"); return; }

      // (a) Synthetic probe — deterministic, isolates THIS element's handler.
      const syn = await syntheticContextMenu(page, sel);
      check(P(`C1 contextmenu prevented (synthetic) ${sel}`), !!syn?.prevented,
        syn?.prevented ? "preventDefault() called" : "NOT prevented — platform menu would open");

      if (!box.onScreen) { skip(P(`C1 long-press ${sel}`), "off-screen; synthetic probe only"); return; }

      // (b) REAL engine-dispatched contextmenu at the element's centre. A
      // mobile long-press and a right button both land on the same Blink /
      // WebKit code path: the engine fires contextmenu, and shows its menu
      // unless a handler prevents it. This is the honest end-to-end probe.
      await page.evaluate(() => { window.__cm.length = 0; });
      await clearSelection(page);
      await page.mouse.click(box.cx, box.cy, { button: "right" });
      await sleep(150);
      let fired = await page.evaluate(() => window.__cm.slice());
      let via = "real engine contextmenu (right button)";

      // (c) Chromium only: also drive a genuine 900ms touch hold through CDP.
      if (!fired.length && engine === "chromium" && cdp) {
        await ensureOn();
        await page.evaluate(() => { window.__cm.length = 0; });
        await longPressCDP(cdp, box.cx, box.cy, 900);
        await sleep(150);
        fired = await page.evaluate(() => window.__cm.slice());
        via = "CDP 900ms touch hold";
        if (!fired.length) {
          try {
            await cdp.send("Input.synthesizeTapGesture", {
              x: box.cx, y: box.cy, duration: 900, tapCount: 1, gestureSourceType: "touch",
            });
            await sleep(150);
            fired = await page.evaluate(() => window.__cm.slice());
            via = "CDP synthesizeTapGesture (900ms)";
          } catch { /* gesture synthesis unavailable headless */ }
        }
      }

      const bubble = fired.filter((f) => f.phase === "bubble");
      // WebKit retargets pointer/mouse events to whatever still holds pointer
      // capture (the overlay canvas grabs it on pointerdown). If the event did
      // not land on the element under the press point, the result says nothing
      // about THIS target — report it as unmeasured rather than a false pass.
      const landed = bubble[0]?.target || "";
      const retargeted = bubble.length
        && !(landed.startsWith(box.hit) || box.hit.startsWith(landed));
      if (retargeted) {
        skip(P(`C1 long-press ${sel}`),
          `event retargeted to "${landed}" (pointer capture) while the press point holds "${box.hit}" — not measurable on this engine`);
      } else if (!bubble.length) {
        skip(P(`C1 long-press ${sel}`), `no contextmenu reached the page (hit=${box.hit})`);
      } else {
        const bad = bubble.filter((f) => !f.prevented);
        check(P(`C1 long-press ${sel}`), bad.length === 0,
          `${via} → contextmenu on "${bubble[0].target}" (hit=${box.hit}) ` +
          `capturePrevented=${bubble[0].preventedAtCapture} finalPrevented=${bubble[0].prevented}` +
          (bad.length ? " → PLATFORM MENU / CALLOUT SHOWS" : ""));
      }

      const selst = await selectionState(page);
      check(P(`C2 no selection after long-press ${sel}`),
        selst.text === "" && (selst.rangeCount === 0 || selst.collapsed),
        selst.text ? `selected ${JSON.stringify(selst.text.slice(0, 40))}` : "clean");
    });
  }
  await ensureOn();

  // ---- C3: computed style sweep ----
  await guard(P("C3 computed style sweep"), async () => {
    const callout = await calloutReportable(page);
    const calloutTestable = engine === "webkit" && !!callout.value;
    if (engine === "webkit" && !calloutTestable) {
      skip(P("C3 -webkit-touch-callout is reportable"),
        `this WebKit build does not expose -webkit-touch-callout to getComputedStyle ` +
        `(body="${callout.value || "(empty)"}", CSS.supports=${callout.supports}) — assertion cannot run`);
    }
    const styles = await page.evaluate((sels) => {
      const out = [];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { out.push({ sel: s, present: false }); continue; }
        const cs = getComputedStyle(el);
        out.push({
          sel: s, present: true, tag: el.tagName,
          callout: (cs.getPropertyValue("-webkit-touch-callout") || cs.webkitTouchCallout || "").trim(),
          userSelect: cs.userSelect || cs.webkitUserSelect,
          touchAction: cs.touchAction,
          draggable: el.draggable,
        });
      }
      return out;
    }, targets);
    for (const s of styles) {
      if (!s.present) { skip(P(`C3 style ${s.sel}`), "not on this page"); continue; }
      const isInput = s.tag === "INPUT" || s.tag === "TEXTAREA";
      const parts = [];
      let ok = true;
      if (calloutTestable) {
        if (!isInput && s.callout !== "none") ok = false;
        parts.push(`-webkit-touch-callout=${s.callout || "(empty)"}`);
      }
      if (!isInput) {
        if (s.userSelect !== "none") ok = false;
        parts.push(`user-select=${s.userSelect}`);
      }
      if (s.sel === ".overlay-canvas" || s.sel === ".display-canvas") {
        if (s.touchAction !== "none") ok = false;
        parts.push(`touch-action=${s.touchAction}`);
      }
      check(P(`C3 style ${s.sel}`), ok, parts.join(" ") || "no assertable property on this engine");
    }
  });

  // ---- C4: dragstart on every image and canvas ----
  await guard(P("C4 dragstart"), async () => {
    const drags = await page.evaluate(() => {
      const els = [...document.querySelectorAll("img, canvas")];
      return els.slice(0, 24).map((el, i) => {
        const cls = (typeof el.className === "string" && el.className) || el.tagName;
        const ev = new Event("dragstart", { bubbles: true, cancelable: true });
        const notCancelled = el.dispatchEvent(ev);
        return {
          i, tag: el.tagName, cls: String(cls).slice(0, 40),
          prevented: !notCancelled, draggable: el.draggable,
        };
      });
    });
    if (!drags.length) { skip(P("C4 dragstart"), "no img/canvas on this page"); return; }
    const bad = drags.filter((d) => !d.prevented && d.draggable !== false);
    check(P("C4 dragstart is blocked on images/canvases"), bad.length === 0,
      bad.length
        ? `${bad.length}/${drags.length} draggable: ` +
          bad.slice(0, 4).map((d) => `${d.tag}.${d.cls}(draggable=${d.draggable},prevented=${d.prevented})`).join(", ")
        : `${drags.length} elements, all blocked`);
    // Images specifically: draggable=false OR prevented.
    const imgs = drags.filter((d) => d.tag === "IMG");
    if (!imgs.length) { skip(P("C4 images not draggable"), "no <img> on this page"); }
    else {
      const badImgs = imgs.filter((d) => d.draggable !== false && !d.prevented);
      check(P("C4 images not draggable"), badImgs.length === 0,
        badImgs.length
          ? badImgs.slice(0, 4).map((d) => `img.${d.cls} draggable=${d.draggable}`).join(", ")
          : `${imgs.length} img(s) safe`);
    }
  });

  // ---- C5: input font-size (iOS auto-zooms below 16px) ----
  await guard(P("C5 input font-size"), async () => {
    const inputs = await page.evaluate(() => {
      const sel = 'input[type="text"], input[type="search"], input:not([type]), textarea';
      return [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      }).map((el) => {
        const cls = (typeof el.className === "string" && el.className) || "";
        const path = `${el.tagName.toLowerCase()}${cls ? "." + cls.trim().split(/\s+/).join(".") : ""}`;
        const parentCls = (typeof el.parentElement?.className === "string" && el.parentElement.className) || "";
        return {
          path, parent: String(parentCls).trim().split(/\s+/)[0] || "",
          size: parseFloat(getComputedStyle(el).fontSize),
          placeholder: el.placeholder || "",
        };
      });
    });
    if (!inputs.length) { skip(P("C5 visible inputs are >= 16px"), "no visible text inputs"); return; }
    const small = inputs.filter((i) => i.size < 16);
    check(P("C5 visible inputs are >= 16px"), small.length === 0,
      small.length
        ? small.map((i) => `${i.parent ? "." + i.parent + " > " : ""}${i.path} = ${i.size}px${i.placeholder ? ` ("${i.placeholder.slice(0, 24)}")` : ""}`).join("; ")
        : `${inputs.length} input(s), smallest ${Math.min(...inputs.map((i) => i.size))}px`);
  });

  // ---- C5b: the same question asked of the shipped stylesheet ------------
  // Only a handful of inputs are mounted at any moment (the chat composer is
  // not even reachable on a phone — .cc-pill is display:none at mobile
  // widths), so a runtime-only sweep silently misses the fields that matter.
  // Read the CSSOM instead: every rule that sets a font-size on an input.
  if (pageName === "room") {
    await guard(P("C5b stylesheet input font-size"), async () => {
      const rules = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        document.body.appendChild(probe);
        const resolve = (v) => { probe.style.fontSize = v; return parseFloat(getComputedStyle(probe).fontSize); };
        const out = [];
        const walk = (list, media) => {
          for (const r of list) {
            if (r.cssRules && (r.media || r.conditionText)) {
              walk(r.cssRules, r.conditionText || (r.media && r.media.mediaText) || media);
            } else if (r.selectorText && r.style && r.style.fontSize) {
              if (/(^|[\s,>+~])(input|textarea)\b|\[type=/i.test(r.selectorText)) {
                out.push({
                  selector: r.selectorText.slice(0, 80),
                  declared: r.style.fontSize,
                  px: resolve(r.style.fontSize),
                  media: media || "",
                });
              }
            }
          }
        };
        for (const sheet of document.styleSheets) {
          try { walk(sheet.cssRules, ""); } catch { /* cross-origin sheet */ }
        }
        probe.remove();
        return out;
      });
      if (!rules.length) { skip(P("C5b stylesheet sets no input font-size below 16px"), "no input font-size rules found"); return; }
      const small = rules.filter((r) => r.px < 16);
      check(P("C5b stylesheet sets no input font-size below 16px"), small.length === 0,
        small.length
          ? small.map((r) => `${r.selector} = ${r.declared} (${r.px}px)${r.media ? ` @media ${r.media.slice(0, 30)}` : ""}`).join("; ")
          : `${rules.length} input font-size rule(s), smallest ${Math.min(...rules.map((r) => r.px))}px`);
    });
  }

  // ---- C6: double tap must not zoom or select ----
  await guard(P("C6 double tap"), async () => {
    const spots = pageName === "room"
      ? [[".overlay-canvas", "canvas"], [".status-line", "chrome label"], [".mobile-quickbar", "quickbar"]]
      : pageName === "home"
        ? [[".home-hero", "hero"], ["h1", "heading"], [".home-viewer", "viewer"]]
        : [[".wall-hero", "hero"], ["h1", "heading"], [".wall-title", "card title"]];
    for (const [sel, label] of spots) {
      await ensureOn();
      const box = await targetBox(page, sel);
      if (!box.present || !box.sized || !box.onScreen) { skip(P(`C6 double-tap ${label}`), `${sel} not tappable here`); continue; }
      await clearSelection(page);
      await page.touchscreen.tap(box.cx, box.cy);
      await sleep(90);
      await page.touchscreen.tap(box.cx, box.cy);
      await sleep(350);
      const st = await page.evaluate(() => ({
        scale: window.visualViewport ? window.visualViewport.scale : 1,
        sel: window.getSelection() ? window.getSelection().toString() : "",
      }));
      check(P(`C6 double-tap ${label} does not zoom or select`),
        Math.abs(st.scale - 1) < 0.01 && st.sel === "",
        `${sel} scale=${st.scale} selection=${JSON.stringify(st.sel.slice(0, 30))}`);
    }
  });

  // ---- C8: page-level shell ----
  await guard(P("C8 shell"), async () => {
    await ensureOn();
    const shell = await page.evaluate(() => {
      const m = document.querySelector('meta[name="viewport"]');
      const cs = getComputedStyle(document.body);
      const overscroll = (cs.getPropertyValue("overscroll-behavior")
        || cs.getPropertyValue("overscroll-behavior-y")
        || cs.overscrollBehavior || "").trim();
      return {
        viewport: m ? m.content : "",
        overscroll,
        overscrollSupported: typeof CSS !== "undefined" && CSS.supports
          ? CSS.supports("overscroll-behavior", "none") : false,
        scrollWidth: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      };
    });
    check(P("C8 viewport meta pins scale"),
      /viewport-fit=cover/.test(shell.viewport) && /user-scalable=no/.test(shell.viewport),
      shell.viewport.slice(0, 110));
    if (!shell.overscroll && !shell.overscrollSupported) {
      skip(P("C8 body overscroll-behavior none"),
        "this engine build does not support/report overscroll-behavior — rubber-band containment untestable here");
    } else {
      check(P("C8 body overscroll-behavior none"), /none/.test(shell.overscroll), shell.overscroll || "(empty)");
    }
    check(P("C8 no horizontal overflow"), shell.scrollWidth <= shell.inner + 1,
      `scrollWidth=${shell.scrollWidth} innerWidth=${shell.inner}`);
  });

  // ---- C9 ----
  const fatal = errors.filter((e) => !/favicon|manifest|ResizeObserver/i.test(e));
  check(P("C9 zero page errors"), fatal.length === 0, fatal.slice(0, 2).join(" | "));
  page.off("pageerror", onErr);
}

// ---- C7: drawing with touch still works ------------------------------------
async function runDrawing(page, cdp, engine) {
  await guard("C7 drawing", async () => {
    console.log(`\n  -- drawing (${ROOM}) --`);
    await page.goto(BASE + ROOM, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    const box = await page.evaluate(() => {
      const el = document.querySelector(".overlay-canvas");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cls: el.className };
    });
    if (!box) { skip("C7 a touch drag draws a stroke", ".overlay-canvas not present"); return; }

    const sample = () => page.evaluate(() => {
      const c = document.querySelector(".display-canvas");
      if (!c) return { err: "no display canvas" };
      try {
        const g = c.getContext("2d", { willReadFrequently: true });
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4 * 37) {
          if (d[i + 3] > 8 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) ink += 1;
        }
        return { ink, w: c.width, h: c.height };
      } catch (e) { return { err: String(e).slice(0, 80) }; }
    });

    const before = await sample();
    const x0 = Math.round(box.x + box.w * 0.3);
    const y0 = Math.round(box.y + box.h * 0.4);
    const x1 = Math.round(box.x + box.w * 0.7);
    const y1 = Math.round(box.y + box.h * 0.6);

    let how = "";
    if (engine === "chromium") {
      how = "CDP touch drag";
      const pt = (x, y) => [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x0, y0) });
      for (let i = 1; i <= 10; i += 1) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: pt(Math.round(x0 + (x1 - x0) * i / 10), Math.round(y0 + (y1 - y0) * i / 10)),
        });
        await sleep(18);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      // WebKit exposes tap only; drive the same pointer handlers with the mouse.
      how = "mouse pointer drag (WebKit has no touch drag)";
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= 10; i += 1) {
        await page.mouse.move(Math.round(x0 + (x1 - x0) * i / 10), Math.round(y0 + (y1 - y0) * i / 10));
        await sleep(18);
      }
      await page.mouse.up();
    }

    let after = before;
    for (let i = 0; i < 24; i += 1) {
      await sleep(150);
      after = await sample();
      if (!after.err && !before.err && after.ink > before.ink) break;
    }
    if (after.err || before.err) {
      check("C7 a touch drag draws a stroke", false, `canvas read failed: ${after.err || before.err}`);
      return;
    }
    check("C7 a touch drag draws a stroke", after.ink > before.ink,
      `${how}: ink ${before.ink} → ${after.ink} on ${after.w}x${after.h} display-canvas ` +
      `(overlay class="${box.cls}")`);

    // The long-press guard must not have eaten the pointer stream either.
    const st = await selectionState(page);
    check("C7 drawing leaves no selection", st.text === "", st.text ? JSON.stringify(st.text.slice(0, 40)) : "clean");
  });
}

async function runDevice(label, engineName, launcher, descriptor, note) {
  device = label;
  console.log(`\n${"=".repeat(72)}\n${label}  [${engineName}${note ? " — " + note : ""}]\n${"=".repeat(72)}`);
  let browser = null;
  try {
    browser = await launcher.launch({ headless: true });
    const ctx = await browser.newContext({ ...descriptor });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    let cdp = null;
    if (engineName === "chromium") {
      try { cdp = await ctx.newCDPSession(page); } catch { cdp = null; }
    }
    check("CDP touch input available", engineName !== "chromium" ? true : !!cdp,
      engineName === "chromium" ? (cdp ? "real long-press via CDP" : "unavailable") : "n/a (synthetic probes)");

    // Drawing goes FIRST, on an untouched app: the long-press sweep taps
    // through the quickbar and can leave the hand/pan tool selected (it is
    // remembered), which would make a stroke check fail for the wrong reason.
    await runDrawing(page, cdp, engineName);
    await runPage(page, cdp, engineName, "room", ROOM);
    await runPage(page, cdp, engineName, "home", "/");
    await runPage(page, cdp, engineName, "wall", "/wall");

    await guard("manifest", async () => {
      const r = await page.request.get(BASE + "/manifest.webmanifest");
      const j = r.ok() ? await r.json().catch(() => null) : null;
      check("C8 manifest.webmanifest is standalone", r.ok() && j?.display === "standalone",
        `status=${r.status()} display=${j?.display}`);
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  const pick = (...names) => {
    for (const n of names) if (devices[n]) return { name: n, d: devices[n] };
    return { name: names[0] + " (missing — using iPhone 12 fallback)", d: devices["iPhone 12"] };
  };
  const pixel = pick("Pixel 7", "Pixel 5");
  const ipad = pick("iPad Pro 11", "iPad Pro 11 landscape", "iPad (gen 7)");
  const iphone = pick("iPhone 14", "iPhone 13");

  // WebKit must really be installed, or the iOS sections are Chromium in a
  // costume and every WebKit-only assertion below is worthless.
  let webkitOk = false;
  let webkitErr = "";
  try {
    const b = await webkit.launch({ headless: true });
    await b.close();
    webkitOk = true;
  } catch (e) { webkitErr = String(e).split("\n")[0].slice(0, 140); }
  device = "setup";
  check("webkit engine available", webkitOk,
    webkitOk ? "playwright webkit installed — iOS sections run on the real WebKit engine"
      : `WebKit could not launch (${webkitErr}); iOS sections RUN IN CHROMIUM with iOS device descriptors — -webkit-touch-callout and the iOS callout itself are NOT tested`);
  const iosEngineName = webkitOk ? "webkit" : "chromium";
  const iosLauncher = webkitOk ? webkit : chromium;
  const iosNote = webkitOk ? "" : "SUBSTITUTED CHROMIUM";

  await runDevice(`Pixel 7 / Android Chrome (${pixel.name})`, "chromium", chromium, pixel.d, "");
  await runDevice(`iPad Pro 11 / iPadOS Safari (${ipad.name})`, iosEngineName, iosLauncher, ipad.d, iosNote);
  await runDevice(`iPhone 14 / iOS Safari (${iphone.name})`, iosEngineName, iosLauncher, iphone.d, iosNote);

  server.kill();
  const byDevice = new Map();
  for (const r of results) {
    if (!byDevice.has(r.device)) byDevice.set(r.device, { pass: 0, fail: 0, skip: 0 });
    const b = byDevice.get(r.device);
    if (r.skipped) b.skip += 1; else if (r.ok) b.pass += 1; else b.fail += 1;
  }
  console.log(`\n${"=".repeat(72)}\nSUMMARY\n${"=".repeat(72)}`);
  for (const [d, b] of byDevice) console.log(`  ${d}: ${b.pass} pass, ${b.fail} FAIL, ${b.skip} skip`);
  const failed = results.filter((r) => !r.ok);
  const graded = results.filter((r) => !r.skipped);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  [${f.device}] ${f.name}`);
  }
  console.log(`\n${graded.length - failed.length}/${graded.length} checks passed (${results.length - graded.length} skipped)`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
