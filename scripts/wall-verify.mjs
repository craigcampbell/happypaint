// Fridge Wall verification: API contract first (fetch), then a browser pass
// (masonry renders, CTA cards, hearts, search, post-from-studio round trip).
// Drives a LOCAL isolated server with a scratch DATA_DIR.
import { chromium } from "playwright";
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";

const ROOT = "C:/Users/Craig Campbell/Projects/happypaint";
const SCRATCH = path.join(process.env.TEMP || "/tmp", "wall-verify-data");
const PORT = 8921;
const BASE = `http://localhost:${PORT}`;
const ADMIN_KEY = "wall-test-admin-key";

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  // WALL_HIDE_REPORTS=1: report auto-hide now counts DISTINCT reporters (by IP),
  // and this local harness only has one IP — so drop the threshold to 1 to
  // exercise the hide→admin→restore flow with a single reporter.
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, ADMIN_KEY, WALL_HIDE_REPORTS: "1" },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// A tiny real PNG (1x1 white) as a data URL — enough for the API contract.
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const jpost = (url, body, headers = {}) =>
  fetch(BASE + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const run = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // ---- API contract ---------------------------------------------------------
  // 1) Post a static drawing.
  let res = await jpost("/api/wall", {
    userKey: "u_tester1",
    title: "Sunny Cat",
    artist: "Mia",
    tags: ["cat", "sun"],
    frames: [PNG_1PX],
    durationMs: 400,
  });
  const post1 = await res.json();
  check("post a drawing -> ok + id", res.ok && !!post1.id, JSON.stringify(post1));

  // 2) Post an animated drawing (3 frames).
  res = await jpost("/api/wall", {
    userKey: "u_tester2",
    title: "Bouncing Ball",
    artist: "Leo",
    tags: ["ball", "bouncy"],
    frames: [PNG_1PX, PNG_1PX, PNG_1PX],
    durationMs: 250,
  });
  const post2 = await res.json();
  check("post an animation -> ok", res.ok && !!post2.id);

  // 3) Profanity in a tag rejects the whole post.
  res = await jpost("/api/wall", {
    userKey: "u_tester3",
    title: "My art",
    tags: ["shit"],
    frames: [PNG_1PX],
  });
  const badTag = await res.json().catch(() => ({}));
  check("profane tag -> 400 language", res.status === 400 && badTag.error === "language");

  // 4) Profanity in the title rejects too.
  res = await jpost("/api/wall", { userKey: "u_tester3", title: "fuck this", frames: [PNG_1PX] });
  check("profane title -> 400 language", res.status === 400);

  // 4a) SECURITY: an SVG "frame" (executable document → stored XSS) is rejected.
  const SVG = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
  res = await jpost("/api/wall", { userKey: "u_attacker", title: "cute", frames: [SVG] });
  check("SVG frame rejected on upload (no stored XSS)", res.status === 400);
  // 4b) SECURITY: a data:image/png URL whose bytes are NOT a real PNG is rejected (magic-byte check).
  res = await jpost("/api/wall", { userKey: "u_attacker", title: "fake", frames: ["data:image/png;base64," + Buffer.from("not a real png").toString("base64")] });
  check("non-image bytes claiming image/png rejected", res.status === 400);

  // 5) Feed returns both posts; animated one carries frames=3.
  res = await fetch(`${BASE}/api/wall?sort=new&userKey=u_tester1`);
  const feed = await res.json();
  check("feed lists both posts", res.ok && feed.posts.length === 2 && feed.total === 2, `n=${feed.posts?.length}`);
  const animPost = feed.posts.find((p) => p.id === post2.id);
  check("animated post advertises 3 frames", animPost?.frames === 3, `frames=${animPost?.frames}`);
  check("feed exposes top tags", Array.isArray(feed.topTags) && feed.topTags.includes("cat"), JSON.stringify(feed.topTags));
  check("feed never leaks owner keys", !JSON.stringify(feed.posts).includes("u_tester"), "");

  // 6) Frame endpoint serves real image bytes with a SAFE, non-sniffable content-type.
  res = await fetch(`${BASE}/api/wall/${post2.id}/frame/2`);
  const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0;
  check("frame endpoint serves PNG bytes", res.ok && res.headers.get("content-type") === "image/png" && bytes > 40, `bytes=${bytes}`);
  check("frame response carries X-Content-Type-Options: nosniff", res.headers.get("x-content-type-options") === "nosniff");
  check("frame response carries a lockdown CSP", /default-src 'none'/.test(res.headers.get("content-security-policy") || ""));
  res = await fetch(`${BASE}/api/wall/${post2.id}/frame/9`);
  check("out-of-range frame -> 404", res.status === 404);

  // 7) Votes: heart on, sticky, toggle off; feed reflects.
  res = await jpost(`/api/wall/${post1.id}/vote`, { userKey: "u_voter1", on: true });
  const v1 = await res.json();
  check("vote on -> votes=1 liked", res.ok && v1.votes === 1 && v1.liked === true);
  await jpost(`/api/wall/${post1.id}/vote`, { userKey: "u_voter1", on: true }); // same voter again
  res = await fetch(`${BASE}/api/wall?sort=top&userKey=u_voter1`);
  const topFeed = await res.json();
  check("same voter can't double-heart", topFeed.posts.find((p) => p.id === post1.id)?.votes === 1);
  check("top sort puts the hearted post first", topFeed.posts[0]?.id === post1.id);
  check("viewer sees their own heart (liked=true)", topFeed.posts[0]?.liked === true);
  // 7a) SECURITY: anon votes bind to the request IP, not the client userKey —
  // so rotating userKeys from one machine can't forge extra hearts.
  for (const k of ["u_forge1", "u_forge2", "u_forge3"]) {
    await jpost(`/api/wall/${post1.id}/vote`, { userKey: k, on: true });
  }
  res = await fetch(`${BASE}/api/wall?userKey=u_voter1`);
  const forgeFeed = await res.json();
  check("rotating anon userKeys can't inflate votes (IP-bound)", forgeFeed.posts.find((p) => p.id === post1.id)?.votes === 1);
  res = await jpost(`/api/wall/${post1.id}/vote`, { userKey: "u_voter1", on: false });
  const v2 = await res.json();
  check("vote off -> votes back to 0", res.ok && v2.votes === 0);

  // 8) Search: q matches title tokens; tag filters exactly.
  res = await fetch(`${BASE}/api/wall?q=bouncing`);
  const qFeed = await res.json();
  check("search q=bouncing finds the animation", qFeed.posts.length === 1 && qFeed.posts[0].id === post2.id);
  res = await fetch(`${BASE}/api/wall?tag=cat`);
  const tagFeed = await res.json();
  check("tag=cat filters to the cat post", tagFeed.posts.length === 1 && tagFeed.posts[0].id === post1.id);

  // 9) Reports dedup by DISTINCT reporter (CF-Connecting-IP, since the app is
  // behind a tunnel). 3 clicks from one reporter count once; a second distinct
  // reporter increments. With WALL_HIDE_REPORTS=1 the first distinct reporter
  // already hides it.
  const rip = (ip) => ({ "CF-Connecting-IP": ip });
  for (let i = 0; i < 3; i += 1) {
    await jpost(`/api/wall/${post2.id}/report`, { reason: `dup ${i}` }, rip("203.0.113.7"));
  }
  await jpost(`/api/wall/${post2.id}/report`, { reason: "distinct" }, rip("203.0.113.8"));
  res = await fetch(`${BASE}/api/wall?sort=new`);
  const afterReports = await res.json();
  check("report auto-hides the post", !afterReports.posts.some((p) => p.id === post2.id));
  res = await fetch(`${BASE}/api/wall/${post2.id}/frame/0`);
  check("hidden post frames 404 too", res.status === 404);
  res = await fetch(`${BASE}/api/admin/wall`, { headers: { "x-admin-key": ADMIN_KEY } });
  const adminList = await res.json();
  const adminItem = adminList.items?.find((p) => p.id === post2.id);
  check("reports count DISTINCT reporters (3 dup + 1 new => 2)", adminItem?.reports === 2, `reports=${adminItem?.reports}`);
  check("admin sees the hidden post", adminItem?.hidden === true);
  res = await jpost(`/api/wall/${post2.id}/restore`.replace("/api/wall/", "/api/admin/wall/"), {}, { "x-admin-key": ADMIN_KEY });
  check("admin restore -> ok", res.ok);
  res = await fetch(`${BASE}/api/admin/wall`, { headers: { "x-admin-key": ADMIN_KEY } });
  const restored = (await res.json()).items?.find((p) => p.id === post2.id);
  check("restore clears the reporter set (reports back to 0)", restored?.reports === 0 && restored?.hidden === false, `reports=${restored?.reports}`);
  res = await fetch(`${BASE}/api/wall?sort=new`);
  check("restored post is back on the wall", (await res.json()).posts.some((p) => p.id === post2.id));
  // A reporter who reported BEFORE the restore can report again (clean slate),
  // rather than being permanently deduped — proves reportedBy was cleared.
  await jpost(`/api/wall/${post2.id}/report`, { reason: "after restore" }, rip("203.0.113.7"));
  res = await fetch(`${BASE}/api/admin/wall`, { headers: { "x-admin-key": ADMIN_KEY } });
  check("prior reporter counts again after restore", (await res.json()).items?.find((p) => p.id === post2.id)?.reports === 1);
  // Put it back for the remaining tests.
  await jpost(`/api/wall/${post2.id}/restore`.replace("/api/wall/", "/api/admin/wall/"), {}, { "x-admin-key": ADMIN_KEY });

  // 9a) SECURITY: admin delete of an unknown/crafted id is a clean 404 (no path
  // traversal into the filesystem, no crash).
  res = await jpost("/api/admin/wall/" + encodeURIComponent("../../../etc/passwd") + "/delete", {}, { "x-admin-key": ADMIN_KEY });
  check("admin delete of a bogus id -> 404 (no traversal)", res.status === 404);

  // 10) Reports land in the moderation queue.
  res = await fetch(`${BASE}/api/admin/reports`, { headers: { "x-admin-key": ADMIN_KEY } });
  const reps = await res.json();
  check("wall reports reach the admin report queue", (reps.reports || []).some((r) => String(r.reason || "").includes(post2.id)));

  // 11) Owner delete: wrong owner rejected, right owner removes.
  res = await fetch(`${BASE}/api/wall/${post1.id}?userKey=u_impostor`, { method: "DELETE" });
  check("someone else can't delete your post", res.status === 403);
  res = await fetch(`${BASE}/api/wall/${post1.id}?userKey=u_tester1`, { method: "DELETE" });
  check("owner can take their post down", res.ok);

  // 12) Frame caps: 9 frames rejected, oversize frame rejected.
  res = await jpost("/api/wall", { userKey: "u_capper", title: "Too many", frames: Array(9).fill(PNG_1PX) });
  const nineOk = res.ok; // server slices to 8 — accepting-with-cap is fine; assert it capped
  const nine = nineOk ? await res.json() : null;
  if (nineOk) {
    const f = await fetch(`${BASE}/api/wall?q=too+many`);
    const fd = await f.json();
    check("9 frames capped to 8", fd.posts.find((p) => p.id === nine.id)?.frames === 8);
  } else {
    check("9 frames rejected", res.status === 400);
  }
  res = await jpost("/api/wall", { userKey: "u_capper2", title: "Huge", frames: ["data:image/png;base64," + "A".repeat(400_000)] });
  check("oversize frame -> 400", res.status === 400);

  // ---- Browser pass ---------------------------------------------------------
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });

  await page.goto(`${BASE}/wall`, { waitUntil: "domcontentloaded" });
  await sleep(1800);
  check("wall page renders the masonry", await page.locator(".wall-masonry").isVisible().catch(() => false));
  check("wall shows post cards", (await page.locator(".wall-card:not(.wall-cta)").count()) >= 1);
  check("CTA 'add your own' cards are mixed in", (await page.locator(".wall-cta").count()) >= 1);
  check("nav has The Wall link highlighted", await page.locator(".site-nav-links .is-current", { hasText: "The Wall" }).isVisible().catch(() => false));

  // Heart from the browser.
  const heart = page.locator(".wall-card:not(.wall-cta) .wall-heart").first();
  await heart.click();
  await sleep(700);
  check("clicking the heart marks it liked", (await heart.getAttribute("class") || "").includes("is-liked"));

  // Search from the browser.
  await page.locator(".wall-search").fill("bouncing");
  await sleep(900);
  check("search narrows the wall", (await page.locator(".wall-card:not(.wall-cta)").count()) === 1);
  await page.locator(".wall-search").fill("");
  await sleep(900);

  // Animated card cycles frames — sample several times (a single before/after
  // pair can alias with the cycle period and see the same frame twice).
  const animImg = page.locator(".wall-card:has(.wall-anim-badge) .wall-art img").first();
  const seenSrcs = new Set();
  for (let i = 0; i < 5; i += 1) {
    const src = await animImg.getAttribute("src").catch(() => null);
    if (src) seenSrcs.add(src);
    await sleep(310);
  }
  check("animated card cycles its frames", seenSrcs.size >= 2, `${seenSrcs.size} distinct frames seen`);

  // Post from the studio: draw a stroke, open 🧲 Wall, pin it, find it on the wall.
  await page.goto(`${BASE}/join/ZZWALL`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const overlay = page.locator(".overlay-canvas");
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(box.x + box.width * (0.4 + i * 0.02), box.y + box.height * (0.4 + i * 0.015));
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(600);
  await page.locator("button", { hasText: "🧲 Wall" }).first().click();
  await sleep(900);
  check("wall post dialog opens with a preview", await page.locator(".wall-post-modal .wall-post-preview img").isVisible().catch(() => false));
  await page.locator(".wall-post-modal input[placeholder='What did you make?']").fill("Harness Scribble");
  const tagInput = page.locator(".wall-post-tags input");
  await tagInput.fill("scribble");
  await tagInput.press("Enter");
  await page.getByRole("button", { name: /pin it/i }).click();
  await sleep(1200);
  check("post dialog closes after pinning", !(await page.locator(".wall-post-modal").isVisible().catch(() => false)));
  await page.goto(`${BASE}/wall?`, { waitUntil: "domcontentloaded" });
  await sleep(1500);
  await page.locator(".wall-search").fill("harness");
  await sleep(900);
  check("studio post shows up on the wall", (await page.locator(".wall-card", { hasText: "Harness Scribble" }).count()) === 1);

  const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
  check("zero page errors on the wall", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error("harness error:", e); server.kill(); process.exit(1); });
