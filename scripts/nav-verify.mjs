// Nav redesign verify: isolated server + Playwright at phone/tablet/desktop widths.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PORT = 8967;
const SCRATCH = mkdtempSync(join(tmpdir(), "nav-"));
const OUT = process.env.SHOTS || "/w/output/nav";
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, extra = "") => { results.push([name, !!ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, HOST: "127.0.0.1" }, stdio: "pipe" });
const UI = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(UI + "/healthz")).ok) break; } catch { /* boot */ } await sleep(250); }

const browser = await chromium.launch();
try {
  const sizes = [[320, 640], [375, 760], [390, 844], [600, 900], [768, 1024], [834, 1112], [899, 800], [900, 800], [1024, 768], [1280, 900], [1440, 900]];
  const pages = ["/", "/gallery", "/parents"];
  for (const path of pages) {
    for (const [w, h] of sizes) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 900, isMobile: w < 900 });
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e)));
      await page.goto(UI + path, { waitUntil: "domcontentloaded" });
      await page.locator(".site-nav").waitFor();
      await sleep(500);
      const tag = `${path === "/" ? "home" : path.slice(1)}-${w}`;
      const desktop = w >= 900;
      const nav = await page.evaluate(() => {
        const n = document.querySelector(".site-nav").getBoundingClientRect();
        const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, vis: cs.display !== "none" && cs.visibility !== "hidden" }; };
        return { h: n.height, docW: document.documentElement.scrollWidth, vw: innerWidth,
          brand: box(".site-brand"), draw: box(".site-nav-paint"), toggle: box(".site-nav-toggle"), menu: box(".sn-menu"),
          signin: box(".site-nav-signin") };
      });
      check(`${tag}: no horizontal overflow`, nav.docW <= nav.vw, `${nav.docW}/${nav.vw}`);
      check(`${tag}: bar is one row (<=80px)`, nav.h <= 80, String(Math.round(nav.h)));
      check(`${tag}: Draw now inside viewport`, nav.draw && nav.draw.vis && nav.draw.r <= nav.vw + 0.5 && nav.draw.h >= 40, JSON.stringify(nav.draw && { r: Math.round(nav.draw.r), h: Math.round(nav.draw.h) }));
      if (desktop) {
        check(`${tag}: hamburger hidden, inline links shown`, nav.toggle && !nav.toggle.vis && nav.menu.vis);
      } else {
        check(`${tag}: hamburger visible ≥44px, links tucked away`, nav.toggle.vis && nav.toggle.w >= 44 && nav.toggle.h >= 44 && !nav.menu.vis, JSON.stringify(nav.toggle));
      }
      check(`${tag}: Sign in present (cloud-configured build)`, !!nav.signin && nav.signin.vis && nav.signin.r <= nav.vw);
      if (w === 320 || w === 375) {
        // brand mark + actions + toggle must not collide
        check(`${tag}: brand does not collide with actions`, nav.brand.r <= (nav.signin?.x ?? nav.draw.x) + 1, `${Math.round(nav.brand.r)} vs ${Math.round(nav.signin?.x ?? nav.draw.x)}`);
      }
      await page.screenshot({ path: `${OUT}/${tag}-closed.png` });

      if (!desktop) {
        await page.locator(".site-nav-toggle").click();
        await sleep(300);
        const open = await page.evaluate(() => {
          const links = [...document.querySelectorAll(".sn-menu a")].map((a) => { const r = a.getBoundingClientRect(); return { t: a.innerText.trim(), h: r.height, x: r.x, r: r.right, b: r.bottom }; });
          const m = document.querySelector(".sn-menu"); const mr = m.getBoundingClientRect();
          return { links, menuBottom: mr.bottom, vh: innerHeight, mW: mr.width, scrollable: m.scrollHeight > m.clientHeight, expanded: document.querySelector(".site-nav-toggle").getAttribute("aria-expanded"), locked: getComputedStyle(document.documentElement).overflow };
        });
        const texts = open.links.map((l) => l.t).join(" | ");
        check(`${tag}: sheet lists every destination`, ["Live rooms", "Gallery", "The Wall", "Inktober", "Painted Planet", "Parent & teacher guide", "Safety & FAQ", "Family plan", "Privacy"].every((t) => texts.includes(t)), texts);
        check(`${tag}: sheet rows are ≥44px tall`, open.links.every((l) => l.h >= 44), String(Math.min(...open.links.map((l) => l.h))));
        check(`${tag}: sheet fits viewport (or scrolls inside itself)`, open.menuBottom <= open.vh + 1, `${Math.round(open.menuBottom)}/${open.vh} scroll=${open.scrollable}`);
        check(`${tag}: aria-expanded true + page scroll locked`, open.expanded === "true" && open.locked === "hidden");
        await page.screenshot({ path: `${OUT}/${tag}-open.png` });
        // Escape closes and returns focus
        await page.keyboard.press("Escape");
        await sleep(150);
        check(`${tag}: Escape closes the sheet, focus back on the button`, (await page.locator(".sn-menu").isVisible()) === false && (await page.evaluate(() => document.activeElement?.classList.contains("site-nav-toggle"))));
        // Tapping outside closes
        await page.locator(".site-nav-toggle").click();
        await sleep(150);
        await page.mouse.click(w / 2, h - 5);
        await sleep(200);
        check(`${tag}: tapping the scrim closes the sheet`, (await page.locator(".sn-menu").isVisible()) === false);
      } else {
        for (const g of ["explore", "parents"]) {
          const btn = page.locator(`[data-group="${g}"] .sn-group-btn`);
          await btn.click();
          await sleep(150);
          const pop = await page.evaluate((id) => { const p = document.querySelector(`[data-group="${id}"] .sn-pop`); const r = p.getBoundingClientRect(); return { vis: getComputedStyle(p).display !== "none", r: r.right, l: r.left, n: p.querySelectorAll("a").length, exp: document.querySelector(`[data-group="${id}"] .sn-group-btn`).getAttribute("aria-expanded") }; }, g);
          check(`${tag}: ${g} dropdown opens inside viewport`, pop.vis && pop.exp === "true" && pop.l >= 0 && pop.r <= nav.vw, JSON.stringify(pop));
          if (g === "parents") await page.screenshot({ path: `${OUT}/${tag}-dropdown.png` });
          await page.keyboard.press("Escape");
          await sleep(100);
          check(`${tag}: ${g} dropdown closes on Escape`, !(await page.locator(`[data-group="${g}"] .sn-pop`).isVisible()));
        }
        // outside click closes
        await page.locator('[data-group="explore"] .sn-group-btn').click();
        await page.mouse.click(w / 2, h - 20);
        await sleep(150);
        check(`${tag}: outside click closes dropdown`, !(await page.locator('[data-group="explore"] .sn-pop').isVisible()));
      }
      check(`${tag}: no page errors`, errs.length === 0, errs.join(";"));
      await ctx.close();
    }
  }

  // Navigation works from the sheet and the dropdown, and marks current page.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(UI + "/", { waitUntil: "domcontentloaded" });
    await page.locator(".site-nav-toggle").click();
    await page.locator(".sn-menu a", { hasText: "Parent & teacher guide" }).click();
    await page.waitForURL("**/parents");
    check("sheet link routes via SPA and closes the sheet", (await page.locator(".sn-menu").isVisible()) === false);
    await page.locator(".site-nav-toggle").click();
    const cur = await page.locator(".sn-menu a.is-current").allInnerTexts();
    check("current page marked in sheet with aria-current", cur.join() === "Parent & teacher guide" && (await page.locator('.sn-menu a[aria-current="page"]').count()) === 1, cur.join());
    await ctx.close();
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await ctx2.newPage();
    await p2.goto(UI + "/", { waitUntil: "domcontentloaded" });
    await p2.locator('[data-group="explore"] .sn-group-btn').click();
    await p2.locator('[data-group="explore"] a', { hasText: "Painted Planet" }).click();
    await p2.waitForURL("**/planet");
    check("desktop dropdown link routes and closes dropdown", !(await p2.locator('[data-group="explore"] .sn-pop').isVisible()));
    check("desktop: Explore button marked current on /planet", (await p2.locator(".sn-group-btn.is-current").innerText()) === "Explore");
    // keyboard: Tab into group button, Enter opens, ArrowKeys not required; Tab past closes
    await p2.goto(UI + "/", { waitUntil: "domcontentloaded" });
    await p2.locator('[data-group="parents"] .sn-group-btn').focus();
    await p2.keyboard.press("Enter");
    check("keyboard: Enter on 'For parents' opens it", await p2.locator('[data-group="parents"] .sn-pop').isVisible());
    await p2.keyboard.press("Tab");
    check("keyboard: Tab moves into the dropdown links", await p2.evaluate(() => !!document.activeElement.closest('[data-group="parents"] .sn-pop')));
    await ctx2.close();
    // rotate across breakpoint with sheet open
    const ctx3 = await browser.newContext({ viewport: { width: 820, height: 1000 }, hasTouch: true });
    const p3 = await ctx3.newPage();
    await p3.goto(UI + "/", { waitUntil: "domcontentloaded" });
    await p3.locator(".site-nav-toggle").click();
    await p3.setViewportSize({ width: 1100, height: 800 });
    await sleep(300);
    check("resizing past 900px with sheet open resets cleanly (no scrim, no scroll lock)", (await p3.evaluate(() => getComputedStyle(document.documentElement).overflow)) !== "hidden" && !(await p3.locator(".sn-scrim.is-on").count()));
    await ctx3.close();
  }
} finally {
  await browser.close();
  server.kill();
}
const fails = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
