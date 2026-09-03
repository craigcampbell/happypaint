// Sprite lab: headless, numbers-and-pixels evaluation of src/utils/brushSprites.js.
//
// Spawns the vite dev server on its own port (5203 — the brush lab holds
// 5199), opens scripts/lab/sprites.html in headless Chromium (Playwright,
// same launch style as brush-lab.mjs), and:
//   - asserts the module's BUILD code uses only the allowed math (static scan:
//     no atan2/cos/sin/pow/exp/tan/log, no canvas arcs/ellipses/gradients);
//   - page A: cold prebuild time, tint-ring allocation count over 5000 rotating
//     lookups (must be 0), wash rim/core ratios (> 1.3 per variant), the
//     sprite sheet + close-ups, the strokes preview, release/rebuild;
//   - page B (a FRESH page): rebuilds every atlas and hashes the pixels —
//     the SHA-256 must equal page A's (determinism across builds);
//   - writes the PNGs + sprite-lab-report.json to --out and exits non-zero on
//     any failure.
//
//   node scripts/sprite-lab.mjs [--out <dir>] [--port 5203]
//   BASE=http://127.0.0.1:5175 node scripts/sprite-lab.mjs   # reuse a running dev server
//
// Outputs (in --out): sprites.png, sprite-<family>.png, strokes-preview.png,
// sprite-lab-report.json.
/* global window */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAB_PATH = "/scripts/lab/sprites.html";
const MODULE_FILE = path.join(ROOT, "src/utils/brushSprites.js");
const DEFAULT_PORT = 5203; // 5175 = vite.config strictPort, 5199 = brush-lab
// Default output: this session's scratchpad (override with --out).
const DEFAULT_OUT = "C:/Users/CRAIGC~1/AppData/Local/Temp/claude/C--Users-Craig-Campbell-Projects-happypaint/66293c84-59a3-4ed7-ad44-97f3771b84dc/scratchpad/sprites";
const BUILD_MS_TARGET = 30; // desktop headless target from the spec
const BUILD_MS_FAIL = 80; // headless timing is noisy; only a big miss fails
const RIM_RATIO_MIN = 1.3;

// ---- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) {
    fail(`${flag} needs a value`);
  }
  return value;
};
const outDir = path.resolve(argValue("--out") || DEFAULT_OUT);
const port = Number(argValue("--port") || DEFAULT_PORT);
const externalBase = process.env.BASE ? process.env.BASE.replace(/\/$/, "") : null;

function fail(message) {
  console.error(`sprite-lab: ${message}`);
  process.exit(1);
}

// ---- Static guard: build math ---------------------------------------------------
// The atlases must be byte-identical on every client, so the build may use
// only + - * / sqrt, integer ops and smoothstep. Anything routed through libm
// or the rasteriser is banned in the WHOLE module (there is no dab-path
// region here: the module never draws a dab, it only builds and tints).
const BANNED = [
  { id: "Math.atan2/cos/sin/tan/pow/exp/log", re: /\bMath\.(?:atan2|atan|acos|asin|cos|sin|tan|pow|exp|expm1|log|log2|log10|log1p|cbrt|hypot|random)\s*\(/ },
  { id: "ctx.arc/ellipse", re: /\.(?:arc|arcTo|ellipse)\s*\(/ },
  { id: "gradients", re: /\bcreate(?:Radial|Linear|Conic)Gradient\s*\(/ },
  { id: "ctx.filter", re: /\.filter\s*=/ },
  { id: "shadowBlur", re: /\bshadowBlur\b/ },
  { id: "\\*\\* (exponent)", re: /\*\*/ },
];

function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

function runGuard() {
  const raw = fs.readFileSync(MODULE_FILE, "utf8");
  const rawLines = raw.split("\n");
  const lines = stripComments(raw).split("\n");
  const hits = [];
  lines.forEach((code, index) => {
    for (const rule of BANNED) {
      if (rule.re.test(code)) {
        hits.push({ line: index + 1, id: rule.id, code: rawLines[index].trim() });
      }
    }
  });
  // putImageData must appear exactly as often as an atlas/tile build site
  // (one per canvas build): 2 = atlas + paper tile.
  const putCount = (stripComments(raw).match(/\bputImageData\s*\(/g) || []).length;
  return { ok: hits.length === 0, hits, putImageDataSites: putCount };
}

// ---- Vite dev server (child process) ----------------------------------------
const portFree = (p) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => resolve(false));
  probe.once("listening", () => probe.close(() => resolve(true)));
  probe.listen(p, "127.0.0.1");
});

let vite = null;
const viteLog = [];
async function startVite() {
  if (!(await portFree(port))) {
    fail(`port ${port} is busy — stop whatever holds it, pass --port <n>, or BASE=<url> to reuse a running dev server`);
  }
  // Spawn node directly (not `npm run dev`) so kill() reaches the real process.
  const bin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  vite = spawn(process.execPath, [bin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  vite.stdout.on("data", (chunk) => viteLog.push(String(chunk)));
  vite.stderr.on("data", (chunk) => viteLog.push(String(chunk)));
  let exited = false;
  vite.on("exit", (code) => {
    exited = true;
    viteLog.push(`[vite exited with code ${code}]`);
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (exited) {
      fail(`vite exited before serving:\n${viteLog.join("")}`);
    }
    try {
      const res = await fetch(base + LAB_PATH);
      const text = await res.text();
      if (res.ok && text.includes("Sprite lab")) {
        return base;
      }
      if (res.status === 404 || res.status === 403) {
        fail(`vite served ${res.status} for ${LAB_PATH} — is scripts/lab/sprites.html under the project root?`);
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`vite did not come up on ${base} within 40s:\n${viteLog.join("")}`);
}

function stopVite() {
  if (!vite || vite.exitCode != null) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    vite.kill("SIGTERM");
  }
}

// ---- Helpers ------------------------------------------------------------------
const writeImage = (image) => {
  const match = /^data:image\/png;base64,(.+)$/.exec(image.dataUrl);
  if (!match) {
    throw new Error(`${image.name}: not a PNG data URL`);
  }
  const file = path.join(outDir, image.name);
  fs.writeFileSync(file, Buffer.from(match[1], "base64"));
  return file;
};

async function openLabPage(browser, pageErrors) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (msg) => {
    if (/willReadFrequently/.test(msg.text())) {
      return;
    }
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log(`[page ${msg.type()}] ${msg.text()}`);
    }
  });
  await page.goto(base + LAB_PATH, { waitUntil: "load" });
  await page.waitForFunction(() => window.lab && (window.lab.ready || window.lab.error), null, { timeout: 30_000 });
  const labError = await page.evaluate(() => window.lab.error);
  if (labError) {
    fail(`lab page failed to load the module:\n${labError}`);
  }
  return page;
}

// ---- Main -----------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const failures = [];
const report = { generatedAt: new Date().toISOString(), guard: null, pageA: {}, pageB: {}, images: {}, failures };

report.guard = runGuard();
if (!report.guard.ok) {
  for (const hit of report.guard.hits) {
    failures.push({ scenario: "guard", error: `${hit.id} at brushSprites.js:${hit.line}: ${hit.code}` });
  }
}
console.log(`sprite-lab: static guard ${report.guard.ok ? "clean" : `${report.guard.hits.length} HIT(S)`} (${report.guard.putImageDataSites} putImageData sites)`);

const base = externalBase || (await startVite());
console.log(`sprite-lab: lab page at ${base}${LAB_PATH}`);
console.log(`sprite-lab: output → ${outDir}`);

const browser = await chromium.launch();
try {
  const pageErrors = [];
  // Page A: everything. `build` runs FIRST so it measures a cold prebuild.
  const pageA = await openLabPage(browser, pageErrors);
  for (const kind of ["build", "hash", "alloc", "rim", "sheet", "strokes", "release"]) {
    const started = Date.now();
    let result;
    try {
      result = await pageA.evaluate((k) => window.lab.run(k), kind);
    } catch (error) {
      failures.push({ scenario: kind, error: String(error?.message || error) });
      console.error(`sprite-lab: scenario ${kind} THREW: ${error?.message || error}`);
      continue;
    }
    const { images, ...rest } = result;
    report.pageA[kind] = rest;
    for (const image of images || []) {
      const file = writeImage(image);
      report.images[image.name] = { file, width: image.width, height: image.height, bytes: fs.statSync(file).size };
    }
    console.log(`sprite-lab: ${kind} done (${Date.now() - started} ms, ${(images || []).length} image(s))`);
  }
  await pageA.context().close();

  // Page B: a fresh page, atlases rebuilt from scratch, hashed again.
  const pageB = await openLabPage(browser, pageErrors);
  try {
    const result = await pageB.evaluate(() => window.lab.run("hash"));
    report.pageB.hash = { hash: result.hash, bytes: result.bytes, perFamily: result.perFamily };
  } catch (error) {
    failures.push({ scenario: "hash-B", error: String(error?.message || error) });
  }
  await pageB.context().close();

  if (pageErrors.length) {
    failures.push({ scenario: "page", error: pageErrors.join("\n") });
  }
} finally {
  await browser.close();
  stopVite();
}

// ---- Assertions ------------------------------------------------------------------
const a = report.pageA;
const hashA = a.hash?.hash;
const hashB = report.pageB.hash?.hash;
if (!hashA || !hashB) {
  failures.push({ scenario: "determinism", error: "missing a hash (see scenario errors)" });
} else if (hashA !== hashB) {
  failures.push({ scenario: "determinism", error: `atlas pixels differ between two fresh builds: ${hashA} vs ${hashB}` });
}
if (a.alloc) {
  if (a.alloc.canvasesAllocated !== 0) {
    failures.push({ scenario: "alloc", error: `getTintedSprite allocated ${a.alloc.canvasesAllocated} canvas(es) across 5000 lookups (must be 0)` });
  }
  if (!a.alloc.hitReturnsSameCanvas) {
    failures.push({ scenario: "alloc", error: "hit path returned a different canvas for the same key" });
  }
  const [pr, pg, pb, pa] = a.alloc.probeCentreRgba;
  // #1e88e5 through the module's 5-bit quantization: q5(c) = (c*31+127)/255,
  // expand5(q) = (q*255+15)/31 -> 30->33, 136->140, 229->230.
  if (Math.abs(pr - 33) > 1 || Math.abs(pg - 140) > 1 || Math.abs(pb - 230) > 1 || pa < 240) {
    failures.push({ scenario: "alloc", error: `tinted slot centre is rgba(${pr},${pg},${pb},${pa}), expected ~rgba(33,140,230,>=240)` });
  }
}
if (a.build) {
  if (a.build.ms > BUILD_MS_FAIL) {
    failures.push({ scenario: "build", error: `cold prebuild took ${a.build.ms} ms (> ${BUILD_MS_FAIL} ms)` });
  }
}
if (a.rim) {
  for (const [variant, r] of Object.entries(a.rim.report)) {
    if (!(r.ratio > RIM_RATIO_MIN)) {
      failures.push({ scenario: "rim", error: `wash ${variant} rim/core ratio ${r.ratio} <= ${RIM_RATIO_MIN}` });
    }
  }
}
if (a.release) {
  for (const [key, ok] of Object.entries(a.release)) {
    if (key !== "kind" && key !== "ms" && ok !== true) {
      failures.push({ scenario: "release", error: `${key} = ${ok}` });
    }
  }
}
if (a.sheet && a.sheet.report && a.sheet.report.scratchOk !== true) {
  failures.push({ scenario: "sheet", error: "scratch canvases are not two distinct 256^2 singletons" });
}

fs.writeFileSync(path.join(outDir, "sprite-lab-report.json"), JSON.stringify(report, null, 2));

// ---- Console summary ---------------------------------------------------------
console.log("");
if (a.build) {
  const flag = a.build.ms <= BUILD_MS_TARGET ? "ok" : "SLOW";
  console.log(`BUILD  cold prebuildBrushSprites(): ${a.build.ms} ms [${flag}, target < ${BUILD_MS_TARGET}]  (${a.build.fencedMs} ms incl. GPU upload fence; cached re-call ${a.build.cachedMs} ms; ${a.build.canvasesAllocated} canvases allocated)`);
  console.log(`       atlases: ${Object.entries(a.build.atlasSizes).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}
if (hashA) {
  console.log(`HASH   page A ${hashA}`);
  console.log(`       page B ${hashB || "(missing)"}  ${hashA === hashB ? "IDENTICAL" : "DIFFERENT"}  (${a.hash.bytes} bytes; per family: ${Object.entries(a.hash.perFamily).map(([k, v]) => `${k}=${v}`).join(" ")})`);
}
if (a.alloc) {
  console.log(`ALLOC  ${a.alloc.canvasesAllocated} canvases over ${a.alloc.lookups} rotating lookups (${a.alloc.distinctKeys} distinct keys, ${a.alloc.usPerRotatingLookup} us each incl. re-tints); hit path ${a.alloc.usPerHit} us, same canvas = ${a.alloc.hitReturnsSameCanvas}; probe centre rgba(${a.alloc.probeCentreRgba})`);
}
if (a.rim) {
  console.log(`RIM    wash rim(0.75-0.92)/core(0-0.5) mean alpha: ${Object.entries(a.rim.report).map(([k, r]) => `${k}=${r.ratio} (${r.core}->${r.rim})`).join("  ")}`);
}
if (a.strokes) {
  console.log("STROKE preview timings (blue + red strokes per cell):");
  for (const [name, cols] of Object.entries(a.strokes.report)) {
    console.log(`       ${name.padEnd(11)} ${Object.entries(cols).map(([t, r]) => `${t}: ${r.dabs} dabs ${r.ms} ms`).join(" | ")}`);
  }
}
if (a.release) {
  console.log(`RELEASE ${Object.entries(a.release).filter(([k]) => k !== "kind" && k !== "ms").map(([k, v]) => `${k}=${v}`).join(" ")}`);
}
console.log(`\nIMAGES: ${Object.keys(report.images).length} written to ${outDir}`);
for (const [name, info] of Object.entries(report.images)) {
  console.log(`  ${name.padEnd(24)} ${info.width}x${info.height} ${info.bytes} bytes`);
}
console.log(`report: ${path.join(outDir, "sprite-lab-report.json")}`);

if (failures.length) {
  console.error(`\nsprite-lab: ${failures.length} failure(s):`);
  for (const f of failures) {
    console.error(`  [${f.scenario}] ${f.error}`);
  }
  process.exit(1);
}
console.log("\nsprite-lab: all checks passed");
process.exit(0);
