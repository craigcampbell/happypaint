// SEO/share-layer verification: robots + sitemap + the route-aware <head>
// relinker (per-page titles, per-post wall OG cards, per-room invite cards,
// private-room opacity, HTML-escaping of kid-entered titles).
// Drives a LOCAL isolated server with a scratch DATA_DIR against the built dist/.
import { spawn } from "child_process";
import { mkdirSync, rmSync } from "fs";
import path from "path";
import { SimClient } from "../test/harness/client.mjs";

const ROOT = process.cwd();
const SCRATCH = path.join(process.env.TEMP || "/tmp", "seo-verify-data");
const PORT = 8927;
const BASE = `http://localhost:${PORT}`;
const BASE_WS = `ws://localhost:${PORT}`;

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, ADMIN_KEY: "seo-test-admin" },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const html = async (p) => {
  const res = await fetch(BASE + p);
  return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text() };
};
const unescapeHtml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const titleOf = (body) => unescapeHtml((/<title[^>]*>([\s\S]*?)<\/title>/.exec(body) || [])[1] || "");
const metaContent = (body, marker) => {
  const m = new RegExp(`<[a-z]+[^>]*content="([^"]*)"[^>]*data-seo="${marker}"[^>]*>`).exec(body);
  return m ? m[1] : "";
};

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // ---- robots + sitemap -----------------------------------------------------
  let r = await html("/robots.txt");
  check("robots.txt is real text, not the SPA shell", r.status === 200 && r.type.includes("text/plain") && !r.body.includes("<html"));
  check("robots.txt points at the sitemap + shields /join/", r.body.includes("Sitemap:") && r.body.includes("Disallow: /join/"));

  r = await html("/sitemap.xml");
  check("sitemap.xml serves XML with the static pages", r.status === 200 && r.type.includes("xml") && r.body.includes("<loc>https://drawesome.art/wall</loc>") && r.body.includes("<loc>https://drawesome.art/faq</loc>"));
  check("sitemap.xml has no /join/ links", !r.body.includes("/join/"));

  // ---- default + per-page heads --------------------------------------------
  r = await html("/");
  const defaultTitle = titleOf(r.body);
  check("home serves the default shell + JSON-LD", r.status === 200 && defaultTitle.includes("Drawesome") && r.body.includes("application/ld+json"));

  r = await html("/faq");
  check("/faq gets its own title", titleOf(r.body).includes("Safety & FAQ"), titleOf(r.body));
  check("/faq carries FAQPage JSON-LD", r.body.includes('"FAQPage"'));
  check("/faq canonical points at /faq", r.body.includes('href="https://drawesome.art/faq"'));

  r = await html("/wall");
  check("/wall gets its own title + og:title", titleOf(r.body).includes("Fridge Wall") && metaContent(r.body, "og:title").includes("Fridge Wall"));

  // ---- per-room invite cards ------------------------------------------------
  r = await html("/join/MAIN");
  check("/join/MAIN unfurls as a public room invite", titleOf(r.body).startsWith("Join") && metaContent(r.body, "og:url") === "https://drawesome.art/join/MAIN", titleOf(r.body));

  r = await html("/join/ZZZZ99");
  check("unknown room code unfurls as a generic invite (no room created)", titleOf(r.body).includes("invited"), titleOf(r.body));

  // A live PRIVATE room must stay opaque: no title, no headcount in the card.
  const priv = new SimClient(BASE_WS, { room: "SEOPRIV", name: "secretkid" });
  await priv.connect();
  try {
    await sleep(300);
    r = await html("/join/SEOPRIV");
    check("private room invite is opaque (generic card, no leak)", titleOf(r.body).includes("invited") && !r.body.includes("secretkid") && !/1 drawing right now/.test(r.body), titleOf(r.body));
  } finally {
    await priv.close();
  }

  // ---- wall post cards ------------------------------------------------------
  const jpost = (url, body) =>
    fetch(BASE + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // `$&`/`$'` would splice shell fragments if any replacement were a string
  // replacement; `<script>` probes HTML escaping. Both must come out inert.
  let res = await jpost("/api/wall", {
    userKey: "u_seotester",
    title: `Sunny "Cat" $& $' <script>alert(1)</script>`,
    artist: "Mia",
    tags: ["cat"],
    frames: [PNG_1PX],
    durationMs: 400,
  });
  const post = await res.json();
  check("posted a wall drawing with a hostile title", res.ok && !!post.id, JSON.stringify(post));

  if (post.id) {
    r = await html(`/wall/${post.id}`);
    check("/wall/:id gets a per-post card", titleOf(r.body).includes("Fridge Wall") && metaContent(r.body, "og:image").includes(`/api/wall/${post.id}/frame/0`), titleOf(r.body));
    check("/wall/:id og:type is article", metaContent(r.body, "og:type") === "article");
    check("hostile title is escaped in the head", !r.body.includes("<script>alert(1)</script>"));
    check("$-sequences did not splice the shell (exactly one <title>)", (r.body.match(/<title/g) || []).length === 1 && r.body.includes("$&amp;"));
    check("shell is still valid (root div + entry script present)", r.body.includes('<div id="root">') && r.body.includes("/assets/"));

    const single = await fetch(`${BASE}/api/wall/${post.id}`);
    const data = await single.json().catch(() => ({}));
    check("GET /api/wall/:id returns the post JSON", single.ok && data.post?.id === post.id && typeof data.post?.frames === "number");

    r = await html("/sitemap.xml");
    check("sitemap picks up the new wall post", r.body.includes(`<loc>https://drawesome.art/wall/${post.id}</loc>`));
  }

  r = await html("/wall/does-not-exist");
  check("missing wall post falls back to the wall card (200 shell)", r.status === 200 && titleOf(r.body).includes("Fridge Wall"));

  const missing = await fetch(`${BASE}/api/wall/does-not-exist`);
  check("GET /api/wall/:id 404s for a missing post", missing.status === 404);

  // Traversal/garbage paths must not crash the relinker.
  r = await html("/wall/..%2f..%2fetc");
  check("hostile wall path falls back safely", r.status === 200);

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
};

run()
  .catch((err) => {
    console.error("verify crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 400);
  });
