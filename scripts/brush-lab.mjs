// Brush lab: headless, numbers-and-pixels evaluation of the brush engine.
//
// Spawns the vite dev server on its own port, opens scripts/lab/index.html in
// headless Chromium (Playwright, same launch style as brush-parity-test.mjs),
// runs every scenario through window.lab.runScenario, writes the PNGs + a
// lab-report.json, tears vite down, and exits non-zero on ANY failure
// (scenario throw, determinism mismatch, blank PNG, golden hash mismatch,
// static guard hit). The page drives only the engine's public exports, so
// this keeps working as the engine changes.
//
//   node scripts/brush-lab.mjs [--out <dir>] [--brushes a,b,c] [--port 5199]
//   node scripts/brush-lab.mjs --golden            # guard + mixPrefetch equivalence + golden replay vs golden.json
//   node scripts/brush-lab.mjs --golden-record     # guard + golden replay, REWRITE golden.json
//   node scripts/brush-lab.mjs --guard             # static dab-path guard only (no browser)
//   node scripts/brush-lab.mjs --only strokes,timing   # a subset of the full run's scenarios
//   node scripts/brush-lab.mjs --gpu --only timing     # real-GPU canvas (see GPU_ARGS) — timing only
//   BASE=http://127.0.0.1:5175 node scripts/brush-lab.mjs   # reuse a running dev server
//
// Renderer caveat: headless Chromium rasterises canvas 2D in SOFTWARE
// (SwiftShader), where a rotated bilinear drawImage costs 5-10x a flat arc
// fill per pixel — so the default timing table penalises the sprite dabs
// relative to what every real device (GPU-accelerated 2D canvas) pays.
// `--gpu` launches with the machine's GPU for a representative timing run;
// keep golden / determinism on the default (software) renderer, whose AA is
// what golden.json was recorded with.
//
// Golden (Stage 0 baseline): scripts/lab/golden-ops.json is a frozen op
// fixture (see scripts/lab/make-golden-ops.mjs); every group replays through
// opReplay.replayFrameOnto onto a transparent 4000x2500 canvas and the SHA-256
// of the pixels must equal scripts/lab/golden.json — proof that an engine
// change did not repaint persisted history. Groups flagged
// `deterministic: false` (legacy seedless ops roll Math.random) are hashed
// for information and never gate. The default run verifies too when a
// golden.json exists; `--groups a,b` narrows the replay.
//
// Outputs (in --out): strokes-<brush>.png, mixing-<brush>.png, smudge.png,
// contact-sheet.png, golden-<group>.png, lab-report.json.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAB_PATH = "/scripts/lab/index.html";
const GOLDEN_FILE = path.join(ROOT, "scripts/lab/golden.json");
const FIXTURE_FILE = path.join(ROOT, "scripts/lab/golden-ops.json");
// BRUSH_LAB_GUARD_FILE: point the guard at a scratch copy (self-test only).
const DAB_PATH_FILE = process.env.BRUSH_LAB_GUARD_FILE || path.join(ROOT, "src/utils/brushes.js");
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
const groupFilter = (argValue("--groups") || "").split(",").map((s) => s.trim()).filter(Boolean);
const onlyFilter = (argValue("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);
const port = Number(argValue("--port") || DEFAULT_PORT);
const externalBase = process.env.BASE ? process.env.BASE.replace(/\/$/, "") : null;
const useGpu = args.includes("--gpu");
// A GPU-accelerated 2D canvas in headless Chromium (Windows: ANGLE on D3D11).
const GPU_ARGS = ["--use-angle=d3d11", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--enable-accelerated-2d-canvas"];
const mode = args.includes("--guard")
  ? "guard"
  : args.includes("--golden-record")
    ? "golden-record"
    : args.includes("--golden")
      ? "golden"
      : "full";

function fail(message) {
  console.error(`brush-lab: ${message}`);
  process.exit(1);
}

// ---- Static guard: the per-dab hot path ----------------------------------------
// Scans src/utils/brushes.js between `// DAB-PATH-BEGIN` and `// DAB-PATH-END`
// (Stage 1 adds the markers around emitDab and friends) for calls that must
// never run per dab: pixel readbacks, ctx.filter / shadowBlur, and any
// allocation (canvas, image, typed array). Comments are stripped first so a
// "never a getImageData here" note can't trip it; a trailing `// guard-ok`
// exempts one line (e.g. a `shadowBlur = 0` reset). save/restore are only
// warned about — the brief says "avoid when setTransform will do".
const GUARD_FORBIDDEN = [
  { id: "getImageData", re: /\bgetImageData\s*\(/ },
  { id: "putImageData", re: /\bputImageData\s*\(/ },
  { id: "createImageData", re: /\bcreateImageData\s*\(/ },
  { id: "ctx.filter", re: /\.filter\s*=/ },
  { id: "shadowBlur", re: /\bshadowBlur\b/ },
  { id: "createElement", re: /\bcreateElement\s*\(/ },
  { id: "getContext", re: /\bgetContext\s*\(/ },
  { id: "new Image", re: /\bnew\s+Image\s*\(/ },
  { id: "new ImageData", re: /\bnew\s+ImageData\s*\(/ },
  { id: "new OffscreenCanvas", re: /\bnew\s+OffscreenCanvas\s*\(/ },
  { id: "typed array", re: /\bnew\s+(?:Uint8(?:Clamped)?|Uint16|Uint32|Int8|Int16|Int32|Float32|Float64)Array\s*\(/ },
  { id: "new Array", re: /\bnew\s+Array\s*\(/ },
  { id: "toDataURL", re: /\btoDataURL\s*\(/ },
];
const GUARD_WARN = [
  { id: "save/restore", re: /\.(?:save|restore)\s*\(\s*\)/ },
  { id: "array literal", re: /=\s*\[[^\]]*\]/ },
];

// Blank out comments while keeping line numbers (block comments become the
// same number of newlines). Good enough for this file: no `//` inside strings.
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
  const raw = fs.readFileSync(DAB_PATH_FILE, "utf8");
  const rawLines = raw.split("\n");
  const lines = stripComments(raw).split("\n");
  const regions = [];
  let open = null;
  rawLines.forEach((line, index) => {
    if (/^\s*\/\/\s*DAB-PATH-BEGIN\b/.test(line)) {
      if (open != null) {
        fail(`guard: nested DAB-PATH-BEGIN at ${DAB_PATH_FILE}:${index + 1}`);
      }
      open = index;
    } else if (/^\s*\/\/\s*DAB-PATH-END\b/.test(line)) {
      if (open == null) {
        fail(`guard: DAB-PATH-END without BEGIN at ${DAB_PATH_FILE}:${index + 1}`);
      }
      regions.push({ from: open, to: index });
      open = null;
    }
  });
  if (open != null) {
    fail(`guard: DAB-PATH-BEGIN at line ${open + 1} never closed`);
  }
  if (!regions.length) {
    console.log("brush-lab: guard — no // DAB-PATH-BEGIN / // DAB-PATH-END markers in src/utils/brushes.js yet (Stage 1 adds them); passing");
    return { ok: true, regions: 0, hits: [], warnings: [] };
  }
  const hits = [];
  const warnings = [];
  for (const region of regions) {
    for (let i = region.from + 1; i < region.to; i += 1) {
      if (/\/\/\s*guard-ok\b/.test(rawLines[i])) {
        continue;
      }
      const code = lines[i];
      for (const rule of GUARD_FORBIDDEN) {
        if (rule.re.test(code)) {
          hits.push({ line: i + 1, id: rule.id, code: rawLines[i].trim() });
        }
      }
      for (const rule of GUARD_WARN) {
        if (rule.re.test(code)) {
          warnings.push({ line: i + 1, id: rule.id, code: rawLines[i].trim() });
        }
      }
    }
  }
  const scanned = regions.reduce((n, r) => n + (r.to - r.from - 1), 0);
  console.log(`brush-lab: guard — ${regions.length} DAB-PATH region(s), ${scanned} lines: ${hits.length} forbidden, ${warnings.length} warning(s)`);
  for (const hit of hits) {
    console.error(`  FORBIDDEN ${hit.id.padEnd(16)} brushes.js:${hit.line}  ${hit.code}`);
  }
  for (const warning of warnings) {
    console.log(`  warn      ${warning.id.padEnd(16)} brushes.js:${warning.line}  ${warning.code}`);
  }
  return { ok: hits.length === 0, regions: regions.length, scanned, hits, warnings };
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
// Everything a golden replay passes through — recorded for provenance.
const engineFiles = [
  "src/utils/brushes.js",
  "src/utils/brushSprites.js",
  "src/utils/strokeBuffer.js",
  "src/utils/mixMap.js",
  "src/utils/layers.js",
  "src/utils/opReplay.js",
  "src/utils/symmetry.js",
  "src/utils/shapes.js",
];

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

// ---- Golden compare / record -------------------------------------------------------
// One row per group. Deterministic groups gate: an intra-run wobble
// (`stable: false`) or a hash that differs from golden.json fails the run; a
// fixture file that changed since the recording fails everything (the old
// hashes say nothing about new ops). Nondeterministic groups print INFO.
function readGolden() {
  if (!fs.existsSync(GOLDEN_FILE)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));
}

function verifyGolden(result, { record, failures }) {
  const fixtureSha = sha1(FIXTURE_FILE);
  const engine = Object.fromEntries(engineFiles.map((f) => [f, sha1(path.join(ROOT, f))]));
  const golden = record ? null : readGolden();
  const rows = [];
  if (!record && !golden) {
    console.log("brush-lab: golden — no scripts/lab/golden.json yet; hashes below are unverified (run --golden-record to baseline)");
  }
  if (golden && golden.fixture !== fixtureSha) {
    failures.push({ scenario: "golden", error: `golden-ops.json (${fixtureSha}) is not the fixture golden.json was recorded from (${golden.fixture}) — re-record deliberately` });
  }
  for (const [name, g] of Object.entries(result.report)) {
    let status;
    let detail = "";
    if (!g.deterministic) {
      status = "INFO";
      detail = g.stable ? "nondeterministic group came out stable this run" : "nondeterministic (as flagged)";
    } else if (!g.stable) {
      status = "FAIL";
      detail = `unstable within one run: ${g.hashes.map((h) => h.slice(0, 12)).join(" ≠ ")}`;
      failures.push({ scenario: "golden", error: `${name}: ${detail}` });
    } else if (record || !golden) {
      status = record ? "REC " : "NEW ";
    } else if (!golden.groups[name]) {
      status = "FAIL";
      detail = "group missing from golden.json — re-record";
      failures.push({ scenario: "golden", error: `${name}: ${detail}` });
    } else if (golden.groups[name].hash === g.hash) {
      status = "PASS";
    } else {
      status = "FAIL";
      detail = `expected ${golden.groups[name].hash.slice(0, 12)} (painted ${golden.groups[name].painted})${g.machineBound ? " — machine-bound group (system fonts)" : ""}`;
      failures.push({ scenario: "golden", error: `${name}: hash ${g.hash.slice(0, 12)} ≠ golden ${golden.groups[name].hash.slice(0, 12)}` });
    }
    rows.push({ status, name, g, detail });
  }
  if (record) {
    const out = {
      recordedAt: new Date().toISOString(),
      engine,
      fixture: fixtureSha,
      fixtureSeed: result.fixture?.seed,
      canvas: result.fixture?.canvas,
      groups: Object.fromEntries(
        Object.entries(result.report).map(([name, g]) => [name, { hash: g.hash, deterministic: g.deterministic, machineBound: g.machineBound, painted: g.painted, ops: g.ops }]),
      ),
    };
    fs.writeFileSync(GOLDEN_FILE, `${JSON.stringify(out, null, 2)}\n`);
  }
  return { rows, golden, engine, fixtureSha };
}

function printGolden({ rows, golden, engine }) {
  console.log("\nGOLDEN (opReplay.replayFrameOnto of scripts/lab/golden-ops.json onto a transparent 4000x2500 canvas; SHA-256 of the RGBA readback, 2 replays per group)");
  console.log(`${pad("status", 6)} ${pad("group", 18)} ${pad("hash", 14)} ${pad("det", 4)} ${pad("stable", 6)} ${pad("ops", 5, true)} ${pad("painted", 9, true)} ${pad("ms/run", 7, true)}  note`);
  for (const row of rows) {
    const { g } = row;
    console.log(`${pad(row.status, 6)} ${pad(row.name, 18)} ${pad(g.hash.slice(0, 12), 14)} ${pad(g.deterministic ? "yes" : "NO", 4)} ${pad(g.stable ? "yes" : "NO", 6)} ${pad(g.ops, 5, true)} ${pad(g.painted, 9, true)} ${pad(g.replayMs, 7, true)}  ${row.detail || g.note}`);
  }
  if (golden) {
    const changed = engineFiles.filter((f) => golden.engine?.[f] && golden.engine[f] !== engine[f]);
    console.log(changed.length
      ? `  engine files changed since golden.json (${golden.recordedAt}): ${changed.join(", ")}`
      : `  engine files unchanged since golden.json (${golden.recordedAt})`);
  }
}

// ---- Main -----------------------------------------------------------------------
const failures = [];
const guard = runGuard();
if (!guard.ok) {
  failures.push({ scenario: "guard", error: `${guard.hits.length} forbidden call(s) on the dab path — see above` });
}
if (mode === "guard") {
  process.exit(guard.ok ? 0 : 1);
}

fs.mkdirSync(outDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  mode,
  renderer: useGpu ? "gpu" : "software",
  engine: Object.fromEntries(engineFiles.map((f) => [f, sha1(path.join(ROOT, f))])),
  brushFilter,
  guard: { ok: guard.ok, regions: guard.regions, hits: guard.hits, warnings: guard.warnings },
  scenarios: {},
  images: {},
  failures,
};

const base = externalBase || (await startVite());
console.log(`brush-lab: lab page at ${base}${LAB_PATH}`);
console.log(`brush-lab: output → ${outDir}`);

let goldenResult = null;
const browser = await chromium.launch(useGpu ? { args: GPU_ARGS } : {});
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

  const goldenSpec = { kind: "golden", groups: groupFilter };
  const scenarios = (mode === "full"
    ? [
      { kind: "strokes" },
      { kind: "mixing" },
      { kind: "smudge" },
      { kind: "determinism" },
      { kind: "timing" },
      { kind: "contact" },
      { kind: "mixPrefetch" },
      goldenSpec,
    ]
    : [{ kind: "mixPrefetch" }, goldenSpec]
  ).filter((spec) => mode !== "full" || !onlyFilter.length || onlyFilter.includes(spec.kind));
  if (useGpu) {
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      const info = gl && gl.getExtension("WEBGL_debug_renderer_info");
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown";
    });
    report.gpuRenderer = renderer;
    console.log(`brush-lab: --gpu renderer = ${renderer}`);
  }
  for (const spec of scenarios) {
    const started = Date.now();
    let result;
    try {
      // (page.evaluate has no timeout — the golden replay, 2 x 11 groups on a
      // 40MB canvas, runs to completion.)
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
    if (spec.kind === "mixPrefetch" && result.ok === false) {
      failures.push({ scenario: spec.kind, error: "wet-mix prefetch is not op-order-equivalent to the lazy flush (or the case lost its teeth) — see report.scenarios.mixPrefetch" });
    }
    if (spec.kind === "golden") {
      goldenResult = verifyGolden(result, { record: mode === "golden-record", failures });
      report.golden = { file: GOLDEN_FILE, fixture: goldenResult.fixtureSha, recorded: mode === "golden-record", rows: goldenResult.rows.map((r) => ({ status: r.status.trim(), group: r.name, hash: r.g.hash, detail: r.detail })) };
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
  console.log("\nTIMING (600-point stroke; addPoints median of 5 on a plain ctx, clock stopped after a 1x1 getImageData fence on the buffer + target;");
  console.log("  commit = prepareStrokeCommit + buf.commit + fence; ops from ONE separate untimed Proxy-counted run)");
  console.log(`${pad("brush", 11)} ${pad("size", 4, true)} ${pad("add ms", 8, true)} ${pad("commit", 7, true)} ${pad("ops", 7, true)} ${pad("ops/dab", 7, true)} ${pad("~dabs", 6, true)} ${pad("ms/100dab", 9, true)} ${pad("us/op", 6, true)} ${pad("save", 5, true)} ${pad("gID", 4, true)}`);
  for (const [brush, sizes] of Object.entries(timing)) {
    for (const [size, t] of Object.entries(sizes)) {
      console.log(`${pad(brush, 11)} ${pad(size, 4, true)} ${pad(t.addMsMedian, 8, true)} ${pad(t.commitMsMedian, 7, true)} ${pad(t.ops, 7, true)} ${pad(t.opsPerDab, 7, true)} ${pad(t.dabsEst, 6, true)} ${pad(t.msPer100Dabs ?? "-", 9, true)} ${pad(t.usPerOp ?? "-", 6, true)} ${pad(t.saveCalls, 5, true)} ${pad(t.getImageDataOnDrawPath, 4, true)}`);
    }
  }
}
const strokes = report.scenarios.strokes?.report || {};
if (Object.keys(strokes).length) {
  console.log("\nPEN-UP POP (preview = buffer over the paper at opacity, source-over; commit = prepareStrokeCommit passes + the same commit; on white over the buffer bbox;");
  console.log("  bbox = mean |Δ|/255 over the whole bbox, stroke = over pixels the stroke touched, max = largest channel Δ, moved = stroke px with Δ > 2; worst of the 2 strokes per tile)");
  console.log(`${pad("brush", 11)} ${pad("size", 4, true)} ${pad("bbox", 8, true)} ${pad("stroke", 8, true)} ${pad("max", 4, true)} ${pad("moved", 6, true)} ${pad("stroke px", 10, true)}`);
  for (const [brush, sizes] of Object.entries(strokes)) {
    for (const [size, s] of Object.entries(sizes)) {
      const p = s.penUpPop?.worst;
      if (!p) continue;
      console.log(`${pad(brush, 11)} ${pad(size, 4, true)} ${pad(p.meanDelta, 8, true)} ${pad(p.meanDeltaStroke, 8, true)} ${pad(p.maxDelta, 4, true)} ${pad(p.changedFraction, 6, true)} ${pad(p.strokePixels, 10, true)}`);
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
const mixPrefetch = report.scenarios.mixPrefetch?.report || {};
if (Object.keys(mixPrefetch).length) {
  console.log("\nMIX PREFETCH (idle prefetch + invalidatePrefetch vs the lazy flush, same op script; A = commit → eraser → wet stroke, B = commit → wet → eraser → wet;");
  console.log("  equivalent = prefetch hash == lazy hash (gates), teeth = the naive prefetch (no invalidate) differs from lazy on A (gates))");
  for (const [brush, scripts] of Object.entries(mixPrefetch)) {
    const a = scripts.A;
    const b = scripts.B;
    const flag = a.equivalent && a.teeth && b.equivalent ? "ok  " : "FAIL";
    console.log(`  ${flag} ${pad(brush, 11)} A: equivalent=${a.equivalent} teeth=${a.teeth} [lazy ${a.hashes.lazy} prefetch ${a.hashes.prefetch} naive ${a.hashes.naive}]  B: equivalent=${b.equivalent} [lazy ${b.hashes.lazy} prefetch ${b.hashes.prefetch}]`);
  }
}
if (report.scenarios.smudge) {
  const s = report.scenarios.smudge.report;
  console.log(`\nSMUDGE boundary band mean before=[${s.boundaryMeanBefore}] after=[${s.boundaryMeanAfter}] blended columns@row150=${s.blendedColumnsAtRow150} (${s.pointsFed} points, ${s.ms} ms)`);
}
if (goldenResult) {
  printGolden(goldenResult);
  if (mode === "golden-record") {
    console.log(`  recorded → ${GOLDEN_FILE}`);
  }
}
console.log(`\nIMAGES: ${Object.keys(report.images).length} written to ${outDir}`);
for (const [name, info] of Object.entries(report.images)) {
  console.log(`  ${pad(name, 30)} ${info.width}x${info.height} non-white ${info.nonWhite} (${info.nonWhiteFraction}) ${info.blank ? "BLANK" : "ok"}`);
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
