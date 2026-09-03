// Brush lab: headless, numbers-and-pixels evaluation of the brush engine.
//
// Spawns the vite dev server on its own port, opens scripts/lab/index.html in
// headless Chromium (Playwright, same launch style as brush-parity-test.mjs),
// runs every scenario through window.lab.runScenario, writes the PNGs + a
// lab-report.json, tears vite down, and exits non-zero on ANY failure
// (scenario throw, determinism mismatch, blank PNG). The page drives only the
// engine's public exports, so this keeps working as the engine changes.
//
//   node scripts/brush-lab.mjs [--out <dir>] [--brushes a,b,c] [--port 5199]
//   BASE=http://127.0.0.1:5175 node scripts/brush-lab.mjs   # reuse a running dev server
//
// Outputs (in --out): strokes-<brush>.png, mixing-<brush>.png, smudge.png,
// contact-sheet.png, lab-report.json.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAB_PATH = "/scripts/lab/index.html";
const DEFAULT_PORT = 5199; // vite.config.js pins 5175 strictPort — stay off it
// Default output: this session's scratchpad (override with --out).
const DEFAULT_OUT = "C:/Users/CRAIGC~1/AppData/Local/Temp/claude/C--Users-Craig-Campbell-Projects-happypaint/66293c84-59a3-4ed7-ad44-97f3771b84dc/scratchpad/lab";

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
const brushFilter = (argValue("--brushes") || "").split(",").map((s) => s.trim()).filter(Boolean);
const port = Number(argValue("--port") || DEFAULT_PORT);
const externalBase = process.env.BASE ? process.env.BASE.replace(/\/$/, "") : null;

function fail(message) {
  console.error(`brush-lab: ${message}`);
  process.exit(1);
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
      if (res.ok && text.includes("Brush lab")) {
        return base;
      }
      if (res.status === 404 || res.status === 403) {
        fail(`vite served ${res.status} for ${LAB_PATH} — is scripts/lab/index.html under the project root?`);
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
    // vite spawns esbuild etc.; take the whole tree down.
    spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    vite.kill("SIGTERM");
  }
}

// ---- Helpers ------------------------------------------------------------------
const sha1 = (file) => createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
const engineFiles = ["src/utils/brushes.js", "src/utils/strokeBuffer.js", "src/utils/mixMap.js", "src/utils/layers.js"];

const writeImage = (image) => {
  const match = /^data:image\/png;base64,(.+)$/.exec(image.dataUrl);
  if (!match) {
    throw new Error(`${image.name}: not a PNG data URL`);
  }
  const file = path.join(outDir, image.name);
  fs.writeFileSync(file, Buffer.from(match[1], "base64"));
  return file;
};

// Non-blank check: decode with sharp (a devDependency) and count pixels that
// are not paper-white, plus sample a handful of them. Falls back to a size
// check if sharp can't load on this machine.
let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  sharp = null;
}
async function inspectPng(file) {
  const bytes = fs.statSync(file).size;
  if (!sharp) {
    return { bytes, nonWhite: null, samples: [], blank: bytes < 2_000 };
  }
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let nonWhite = 0;
  const samples = [];
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
      nonWhite += 1;
      if (samples.length < 4 && nonWhite % 997 === 1) {
        const px = (i / ch) % info.width;
        const py = Math.floor(i / ch / info.width);
        samples.push({ x: px, y: py, rgb: [data[i], data[i + 1], data[i + 2]] });
      }
    }
  }
  const total = info.width * info.height;
  return { bytes, width: info.width, height: info.height, nonWhite, nonWhiteFraction: +(nonWhite / total).toFixed(4), samples, blank: nonWhite < total * 0.002 };
}

const pad = (value, width, right = false) => {
  const s = String(value);
  return right ? s.padStart(width) : s.padEnd(width);
};

// ---- Main -----------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const failures = [];
const report = {
  generatedAt: new Date().toISOString(),
  engine: Object.fromEntries(engineFiles.map((f) => [f, sha1(path.join(ROOT, f))])),
  brushFilter,
  scenarios: {},
  images: {},
  failures,
};

const base = externalBase || (await startVite());
console.log(`brush-lab: lab page at ${base}${LAB_PATH}`);
console.log(`brush-lab: output → ${outDir}`);

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (msg) => {
    // The lab's own getImageData readbacks trigger Chrome's willReadFrequently
    // hint on every canvas — noise, not an engine problem.
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
    fail(`lab page failed to load the engine:\n${labError}`);
  }
  const brushes = await page.evaluate((filter) => window.lab.listBrushes(filter), brushFilter);
  if (!brushes.length) {
    fail(`no brushes match --brushes ${brushFilter.join(",")}`);
  }
  console.log(`brush-lab: brushes = ${brushes.join(", ")}`);

  const scenarios = [
    { kind: "strokes" },
    { kind: "mixing" },
    { kind: "smudge" },
    { kind: "determinism" },
    { kind: "timing" },
    { kind: "contact" },
  ];
  for (const spec of scenarios) {
    const started = Date.now();
    let result;
    try {
      result = await page.evaluate((s) => window.lab.runScenario(s), { ...spec, brushes: brushFilter });
    } catch (error) {
      failures.push({ scenario: spec.kind, error: String(error?.message || error) });
      console.error(`brush-lab: scenario ${spec.kind} THREW: ${error?.message || error}`);
      continue;
    }
    const { images, ...rest } = result;
    report.scenarios[spec.kind] = rest;
    for (const image of images || []) {
      const file = writeImage(image);
      const info = await inspectPng(file);
      report.images[image.name] = { file, ...info };
      if (info.blank) {
        failures.push({ scenario: spec.kind, error: `${image.name} looks blank (${info.nonWhite} non-white px)` });
      }
    }
    if (spec.kind === "determinism" && result.ok === false) {
      failures.push({ scenario: spec.kind, error: "determinism mismatch — see report.scenarios.determinism" });
    }
    console.log(`brush-lab: ${spec.kind} done (${Date.now() - started} ms, ${(images || []).length} image(s))`);
  }
  if (pageErrors.length) {
    failures.push({ scenario: "page", error: pageErrors.join("\n") });
  }
} finally {
  await browser.close();
  stopVite();
}

fs.writeFileSync(path.join(outDir, "lab-report.json"), JSON.stringify(report, null, 2));

// ---- Console summary ---------------------------------------------------------
const timing = report.scenarios.timing?.report || {};
if (Object.keys(timing).length) {
  console.log("\nTIMING (600-point stroke; addPoints median of 5, plain ctx; commit = prepareStrokeCommit + buf.commit)");
  console.log(`${pad("brush", 11)} ${pad("size", 4, true)} ${pad("add ms", 8, true)} ${pad("commit", 7, true)} ${pad("ops", 7, true)} ${pad("ops/dab", 7, true)} ${pad("~dabs", 6, true)} ${pad("ms/100dab", 9, true)} ${pad("us/op", 6, true)} ${pad("save", 5, true)} ${pad("gID", 4, true)}`);
  for (const [brush, sizes] of Object.entries(timing)) {
    for (const [size, t] of Object.entries(sizes)) {
      console.log(`${pad(brush, 11)} ${pad(size, 4, true)} ${pad(t.addMsMedian, 8, true)} ${pad(t.commitMsMedian, 7, true)} ${pad(t.ops, 7, true)} ${pad(t.opsPerDab, 7, true)} ${pad(t.dabsEst, 6, true)} ${pad(t.msPer100Dabs ?? "-", 9, true)} ${pad(t.usPerOp ?? "-", 6, true)} ${pad(t.saveCalls, 5, true)} ${pad(t.getImageDataOnDrawPath, 4, true)}`);
    }
  }
}
const determinism = report.scenarios.determinism?.report || {};
if (Object.keys(determinism).length) {
  console.log("\nDETERMINISM (size 32: rerun = two fresh renderers, same seed, per-point flow; batch = 1-point vs 7-point feeding into pre-sized buffers;");
  console.log("  growCopy = per-point-grow flow vs pre-sized buffer — informational: a buffer grow's drawImage copy is not pixel-lossless)");
  for (const [brush, d] of Object.entries(determinism)) {
    const flag = d.rerunIdentical && d.batchIdentical ? "ok  " : "FAIL";
    const batchNote = d.batchIdentical ? "" : ` (diff ${d.batching.differingPixels}px, max delta ${d.batching.maxChannelDelta})`;
    const grow = d.growCopy.lossless ? "lossless" : `${d.growCopy.differingPixels}px raw<=${d.growCopy.maxChannelDelta} visible<=${d.growCopy.maxVisibleDelta}`;
    console.log(`  ${flag} ${pad(brush, 11)} rerun=${d.rerunIdentical} batch=${d.batchIdentical}${batchNote} painted=${d.paintedPixels} growCopy=${grow}`);
  }
}
const mixing = report.scenarios.mixing?.report || {};
if (Object.keys(mixing).length) {
  console.log("\nMIXING overlap mean RGB on white (yellow #f9d423 × blue #1e88e5, size 40)");
  for (const [brush, cells] of Object.entries(mixing)) {
    console.log(`  ${pad(brush, 11)} ${Object.entries(cells).map(([k, v]) => `${k}=[${v.overlapMeanRgb}]`).join("  ")}`);
  }
}
if (report.scenarios.smudge) {
  const s = report.scenarios.smudge.report;
  console.log(`\nSMUDGE boundary band mean before=[${s.boundaryMeanBefore}] after=[${s.boundaryMeanAfter}] blended columns@row150=${s.blendedColumnsAtRow150} (${s.pointsFed} points, ${s.ms} ms)`);
}
console.log(`\nIMAGES: ${Object.keys(report.images).length} written to ${outDir}`);
for (const [name, info] of Object.entries(report.images)) {
  console.log(`  ${pad(name, 26)} ${info.width}x${info.height} non-white ${info.nonWhite} (${info.nonWhiteFraction}) ${info.blank ? "BLANK" : "ok"}`);
}
console.log(`report: ${path.join(outDir, "lab-report.json")}`);

if (failures.length) {
  console.error(`\nbrush-lab: ${failures.length} failure(s):`);
  for (const f of failures) {
    console.error(`  [${f.scenario}] ${f.error}`);
  }
  process.exit(1);
}
console.log("\nbrush-lab: all scenarios passed");
process.exit(0);
