// Moderator watch UI check: the glass room as the owner will actually meet it.
// Boots the real server with a throwaway DATA_DIR, opens a painter in one tab
// and /watch/<code> in another, and asserts what the admin can and cannot do:
// no drawing tools, the stroke list attributes work to its author, flag/hide and
// wipe land on the painter's screen, and the admin never appears in the room's
// roster. Screenshots land in output/modwatch/ for eyeballing.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, readFileSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const OUT = path.join(ROOT, "output", "modwatch");
const SCRATCH = path.join(process.env.TEMP || "/tmp", "modwatch-ui-data");
const PORT = 8944;
const BASE = `http://localhost:${PORT}`;
const ROOM = "WATCHDE1";

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH }, stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  const adminKey = readFileSync(path.join(SCRATCH, ".admin-key"), "utf8").trim();

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // ---- The gate: no key, no watch ---------------------------------------
  const gate = await context.newPage();
  await gate.goto(`${BASE}/watch/${ROOM}`, { waitUntil: "domcontentloaded" });
  await sleep(1200);
  const gateText = await gate.innerText("body");
  check("a watch link without a key shows the key prompt", /Watch a room/i.test(gateText) && /admin key/i.test(gateText));

  // ---- A painter in the room -------------------------------------------
  const painter = await context.newPage();
  await painter.goto(`${BASE}/join/${ROOM}`, { waitUntil: "domcontentloaded" });
  await sleep(4000);
  // Dismiss the "Your canvas is ready!" onboarding so the canvas takes input.
  const okBtn = painter.locator('button:has-text("paint")').first();
  if (await okBtn.count()) { await okBtn.click(); await sleep(1200); }
  const box = await painter.locator("canvas").first().boundingBox();
  await painter.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35);
  await painter.mouse.down();
  for (let i = 0; i < 20; i += 1) {
    await painter.mouse.move(box.x + box.width * (0.3 + i * 0.02), box.y + box.height * (0.35 + (i % 2 ? 0.08 : -0.02)));
    await sleep(16);
  }
  await painter.mouse.up();
  await sleep(1500);
  // Chat lives behind a pill ("Open chat") in the studio; open it, then type.
  const chatPill = painter.locator('button[aria-label="Open chat"]').first();
  if (await chatPill.count()) {
    await chatPill.click();
    await sleep(800);
    const composer = painter.locator('input[placeholder="Type a message…"]').first();
    if (await composer.count()) {
      await composer.fill("hello, painting something");
      await composer.press("Enter");
      await sleep(800);
    }
  }
  await painter.screenshot({ path: path.join(OUT, "1-painter.png") });

  // ---- The admin watches it --------------------------------------------
  const watch = await context.newPage();
  await watch.addInitScript((key) => {
    try { window.localStorage.setItem("drawesome:adminkey:v1", key); } catch { /* ignore */ }
  }, adminKey);
  await watch.goto(`${BASE}/watch/${ROOM}`, { waitUntil: "domcontentloaded" });
  await sleep(3500);
  const body = await watch.innerText("body");
  check("the watch view opens straight into observer mode", /Observer mode/i.test(body) && /Watching WATCHDE1/i.test(body));
  check("the watcher is told they are invisible", /nobody in this room can see you/i.test(body));
  // The room itself must not learn about the watcher — check the painter's own
  // screen before any moderation happens, while the only thing to notice would
  // be a join/roster entry.
  const painterBefore = await painter.innerText("body");
  check("the painter's screen never mentions a moderator joining",
    !/moderator/i.test(painterBefore.split("Private room")[0]), painterBefore.slice(0, 90));
  const painterHeadsEarly = await painter.evaluate(() => {
    const m = document.body.innerText.match(/(\d+) painting together/);
    return m ? Number(m[1]) : null;
  });
  check("the painter still counts one person in the room while watched", painterHeadsEarly === 1, `heads=${painterHeadsEarly}`);
  await watch.screenshot({ path: path.join(OUT, "2-watch-initial.png"), fullPage: false });

  // The mural arrived (the stroke list attributes work to its author).
  await watch.click('button:has-text("Strokes")');
  await sleep(900);
  const strokesText = await watch.innerText(".watch-panel");
  check("the stroke list attributes the paint to its author", /brush/i.test(strokesText) && /pts/i.test(strokesText),
    strokesText.split("\n").slice(0, 3).join(" / ").slice(0, 120));

  // No drawing tools anywhere on the watch page — not even hidden.
  const tools = await watch.evaluate(() => ({
    brushButtons: document.querySelectorAll('.brush-grid button, .brush-selector, [class*="quickbar"]').length,
    studioShell: document.querySelectorAll(".studio-shell").length,
    textInputs: Array.from(document.querySelectorAll("input, textarea")).filter((el) => el.type !== "password").length,
    canvasCount: document.querySelectorAll("canvas").length,
  }));
  check("the watch page has no studio shell or drawing tools",
    tools.studioShell === 0 && tools.brushButtons === 0, JSON.stringify(tools));
  check("the watch page has only the read-only mural canvas", tools.canvasCount === 1, `canvases=${tools.canvasCount}`);
  check("the watch page has no chat box to type into (only the key prompt is an input)",
    tools.textInputs === 0, `inputs=${tools.textInputs}`);

  // The room's chat is readable, and the roster is there when it's wanted.
  await watch.click('button:has-text("Chat")');
  await sleep(600);
  const chatPanel = await watch.innerText(".watch-panel");
  check("the watcher reads the room's live chat", /hello, painting something/.test(chatPanel));

  await watch.click('button:has-text("People")');
  await sleep(600);
  const peoplePanel = await watch.innerText(".watch-panel");
  check("the roster lists the room's painter with their account state",
    /guest|signed in/i.test(peoplePanel) && !/Nobody is in this room/.test(peoplePanel),
    peoplePanel.replace(/\n/g, " / ").slice(0, 110));

  // ---- Flag & hide ------------------------------------------------------
  await watch.click('button:has-text("Strokes")');
  await sleep(600);
  watch.once("dialog", (d) => d.accept("test: NSFW-ish scribble"));
  await watch.click('button:has-text("Flag & hide")');
  await sleep(1600);
  const afterHide = await watch.innerText(".watch-panel");
  check("flag & hide records the takedown in the watch view", /You hid \d+ op/.test(afterHide));
  await watch.screenshot({ path: path.join(OUT, "3-watch-flagged.png") });

  const reports = await fetch(`${BASE}/api/admin/reports`, { headers: { "x-admin-key": adminKey } }).then((r) => r.json());
  const mine = (reports.reports || []).find((r) => r.source === "admin" && r.room === ROOM);
  check("the flag is in the admin reports queue with its reason", !!mine && /NSFW-ish/.test(mine.reason || ""),
    mine ? mine.reason : "no report");

  // The painter's screen really lost the stroke.
  await sleep(800);
  await painter.screenshot({ path: path.join(OUT, "4-painter-after-hide.png") });

  // ---- Wipe -------------------------------------------------------------
  const canvasBox = await painter.locator("canvas").first().boundingBox();
  const before = await painter.screenshot({ clip: { x: canvasBox.x + 20, y: canvasBox.y + 20, width: canvasBox.width - 60, height: canvasBox.height - 60 } });
  watch.once("dialog", (d) => d.accept());
  await watch.click('button:has-text("Wipe room")');
  await sleep(2000);
  const after = await painter.screenshot({ clip: { x: canvasBox.x + 20, y: canvasBox.y + 20, width: canvasBox.width - 60, height: canvasBox.height - 60 } });
  check("a wipe from the watch view clears the painter's canvas", Buffer.compare(before, after) !== 0);
  await painter.screenshot({ path: path.join(OUT, "5-painter-after-wipe.png") });
  await watch.screenshot({ path: path.join(OUT, "6-watch-after-wipe.png") });

  // ---- The room never learned there was a watcher -----------------------
  // A wipe is meant to be visible; what must NOT leak is who did it. The room
  // gets the neutral "a moderator" label and nothing else.
  const painterBody = await painter.innerText("body");
  check("the wipe is announced to the room as 'a moderator', never as a person",
    /a moderator cleared the canvas/i.test(painterBody) && !/🕵|admin/i.test(painterBody),
    painterBody.split("\n").filter((l) => /moderator/i.test(l)).join(" | ").slice(0, 120));
  const painterHeads = await painter.evaluate(() => {
    const m = document.body.innerText.match(/(\d+) painting together/);
    return m ? Number(m[1]) : null;
  });
  check("the painter still counts one person in the room", painterHeads === 1, `heads=${painterHeads}`);

  await browser.close();
};

run()
  .catch((err) => { console.error("HARNESS ERROR:", err); results.push({ name: "harness", ok: false }); })
  .finally(() => {
    server.kill();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log("FAILED:", failed.map((f) => f.name).join(" | "));
    console.log(`screenshots: ${OUT}`);
    setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
  });
