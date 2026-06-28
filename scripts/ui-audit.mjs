// Automated UI audit for Drawesome across phone / tablet / large-tablet / desktop.
//
// Drives a headless Chromium (Playwright) over the key public routes at several
// viewports and runs a battery of objective checks that catch the bugs that
// actually bite a mobile-first kids app: horizontal overflow, tiny tap targets,
// off-screen controls, broken images, console errors, and "wrong layout for the
// device" (the large-tablet-should-feel-mobile rule the owner cares about).
//
// Output (all under audit-results/):
//   - findings.json   structured list the bug-list + fixer + verifier agents read
//   - screenshots/*.png   one full-page shot per (device, route, state)
//   - summary.txt     human-readable tally
//
// Usage:
//   BASE_URL=http://localhost:8787 node scripts/ui-audit.mjs
//   AUDIT_FILTER=studio node scripts/ui-audit.mjs      # only routes matching
// The server must already be serving the CURRENT build (npm run build first).

// This script mixes Node (the runner) with browser code that runs inside
// page.evaluate(), so it needs both global sets. `cssPath` is injected into the
// page via eval(CSS_PATH_FN) before each check.
/* eslint-env node, browser */
/* global cssPath */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'audit-results');
const SHOTS = join(OUT, 'screenshots');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const FILTER = process.env.AUDIT_FILTER || '';

// Viewports. `mobileUX` = the app should show its touch/drawer experience here.
// The owner wants LARGE TABLETS to feel mobile, so those are mobileUX:true even
// though they're wide — the audit flags it if the desktop chrome shows instead.
const DEVICES = [
  { id: 'phone',                 width: 390,  height: 844,  touch: true,  mobileUX: true },
  { id: 'tablet',                width: 820,  height: 1180, touch: true,  mobileUX: true },
  { id: 'large-tablet-portrait', width: 1024, height: 1366, touch: true,  mobileUX: true },
  { id: 'large-tablet-landscape',width: 1366, height: 1024, touch: true,  mobileUX: true },
  { id: 'desktop',               width: 1440, height: 900,  touch: false, mobileUX: false },
];

// Public routes worth auditing. `setup` runs after load to reach a real UI state
// (e.g. dismiss the first-run welcome so we audit the studio, not the modal).
const ROUTES = [
  { path: '/',        name: 'marketing', waitFor: 'body' },
  { path: '/studio',  name: 'studio',    waitFor: '.studio-shell, .mobile-quickbar, .topbar', setup: 'dismissWelcome' },
  { path: '/studio',  name: 'studio-tools-open', waitFor: '.studio-shell', setup: 'openTools' },
  { path: '/safety',  name: 'safety',    waitFor: 'body' },
];

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const findings = [];
function addFinding(f) {
  const id = `${f.device}-${f.route}-${f.type}-${hash(`${f.selector || ''}${f.detail || ''}`)}`;
  findings.push({ id, status: 'open', ...f });
}

// ---- In-page check helpers (run via page.evaluate) ------------------------

// A short, mostly-stable CSS-ish path for a node, for humans + the fixer agent.
const CSS_PATH_FN = `
function cssPath(el) {
  if (!el || el.nodeType !== 1) return '';
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 4) {
    let part = node.tagName.toLowerCase();
    if (node.id) { part += '#' + node.id; parts.unshift(part); break; }
    const cls = (node.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}`;

async function checkOverflow(page, vw) {
  return page.evaluate(({ vw, CSS_PATH_SRC }) => {
    eval(CSS_PATH_SRC);
    const docW = document.documentElement.scrollWidth;
    const clientW = document.documentElement.clientWidth;
    const overflowPx = docW - clientW;
    if (overflowPx <= 2) return { overflowPx, offenders: [] };
    const over = [];
    for (const el of document.querySelectorAll('body *')) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 2 || r.left < -2) over.push(el);
    }
    // Keep only the deepest offenders (those with no overflowing descendant) to
    // isolate the real culprit instead of every ancestor.
    const set = new Set(over);
    const leaves = over.filter((el) => ![...el.querySelectorAll('*')].some((c) => set.has(c)));
    return {
      overflowPx,
      offenders: leaves.slice(0, 12).map((el) => {
        const r = el.getBoundingClientRect();
        return { sel: cssPath(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
      }),
    };
  }, { vw, CSS_PATH_SRC: CSS_PATH_FN });
}

async function checkTapTargets(page, minPx) {
  return page.evaluate(({ minPx, CSS_PATH_SRC }) => {
    eval(CSS_PATH_SRC);
    const sels = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]';
    const out = [];
    for (const el of document.querySelectorAll(sels)) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Only count controls actually on screen.
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (r.width < minPx || r.height < minPx) {
        out.push({ sel: cssPath(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 28) });
      }
    }
    return out.slice(0, 40);
  }, { minPx, CSS_PATH_SRC: CSS_PATH_FN });
}

async function checkBrokenImages(page) {
  return page.evaluate(({ CSS_PATH_SRC }) => {
    eval(CSS_PATH_SRC);
    const out = [];
    for (const img of document.images) {
      if (img.complete && img.naturalWidth === 0) {
        out.push({ sel: cssPath(img), src: (img.currentSrc || img.src || '').slice(0, 120) });
      }
    }
    return out.slice(0, 20);
  }, { CSS_PATH_SRC: CSS_PATH_FN });
}

async function checkLayoutMode(page) {
  return page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    };
    return {
      hasQuickbar: !!document.querySelector('.mobile-quickbar'),
      quickbarVisible: vis('.mobile-quickbar'),
      hasTopbar: !!document.querySelector('.topbar'),
      topbarVisible: vis('.topbar'),
    };
  });
}

async function runSetup(page, setup) {
  if (setup === 'dismissWelcome') {
    await page
      .locator('.welcome-go, .welcome-modal button')
      .first()
      .click({ timeout: 2500 })
      .catch(() => {});
  } else if (setup === 'openTools') {
    await page
      .locator('.welcome-go')
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
    // Open the mobile tools drawer if the quickbar is present, else the desktop
    // rail is already visible.
    await page
      .locator('.mobile-quickbar .qb-btn', { hasText: 'Tools' })
      .click({ timeout: 2500 })
      .catch(() => {});
  }
  await page.waitForTimeout(500);
}

async function auditOne(browser, device, route) {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    hasTouch: device.touch,
    isMobile: device.id === 'phone',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));

  const tag = `${device.id}__${route.name}`;
  try {
    await page.goto(`${BASE_URL}${route.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(route.waitFor, { timeout: 15000 }).catch(() => {});
    if (route.setup) await runSetup(page, route.setup);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);

    const base = { device: device.id, route: route.name, viewport: `${device.width}x${device.height}` };

    // 1) Horizontal overflow (the #1 mobile layout bug)
    const ov = await checkOverflow(page, device.width);
    if (ov.overflowPx > 2) {
      addFinding({
        ...base,
        type: 'horizontal-overflow',
        severity: 'high',
        selector: ov.offenders[0]?.sel || '(unknown)',
        detail: `Page scrolls ${ov.overflowPx}px horizontally. Likely culprits: ${ov.offenders.map((o) => `${o.sel} (right=${o.right}, w=${o.w})`).join(' | ') || 'n/a'}`,
        screenshot: `screenshots/${tag}.png`,
      });
    }

    // 2) Tap targets too small on touch devices
    if (device.touch) {
      const small = await checkTapTargets(page, 40);
      // Group into one finding per route/device to avoid 30 separate rows.
      const tiny = small.filter((s) => s.w < 28 || s.h < 28);
      if (small.length) {
        addFinding({
          ...base,
          type: 'small-tap-target',
          severity: tiny.length ? 'medium' : 'low',
          selector: small[0].sel,
          detail: `${small.length} interactive element(s) below 40px on a touch viewport${tiny.length ? ` (${tiny.length} below 28px)` : ''}: ${small.slice(0, 8).map((s) => `${s.sel}[${s.w}x${s.h}${s.text ? ` "${s.text}"` : ''}]`).join(' | ')}`,
          screenshot: `screenshots/${tag}.png`,
        });
      }
    }

    // 3) Broken images
    const broken = await checkBrokenImages(page);
    if (broken.length) {
      addFinding({
        ...base,
        type: 'broken-image',
        severity: 'medium',
        selector: broken[0].sel,
        detail: `${broken.length} image(s) failed to load: ${broken.map((b) => b.src).join(' | ')}`,
        screenshot: `screenshots/${tag}.png`,
      });
    }

    // 4) Wrong layout for the device (large tablets should feel mobile)
    if (route.name === 'studio') {
      const lay = await checkLayoutMode(page);
      if (device.mobileUX && lay.hasQuickbar && !lay.quickbarVisible) {
        addFinding({
          ...base,
          type: 'mobile-ux-missing',
          severity: 'high',
          selector: '.mobile-quickbar',
          detail: `This ${device.id} (${device.width}px) should show the touch/quick-bar experience, but the mobile quick bar is hidden (desktop layout is showing). The owner wants large tablets to feel mobile.`,
          screenshot: `screenshots/${tag}.png`,
        });
      }
      if (!device.mobileUX && lay.hasTopbar && !lay.topbarVisible) {
        addFinding({
          ...base,
          type: 'desktop-ux-missing',
          severity: 'medium',
          selector: '.topbar',
          detail: `Desktop (${device.width}px) is showing the mobile layout (top bar hidden).`,
          screenshot: `screenshots/${tag}.png`,
        });
      }
    }

    // 5) Console / page errors
    if (consoleErrors.length) {
      const uniq = [...new Set(consoleErrors)];
      addFinding({
        ...base,
        type: 'console-error',
        severity: 'medium',
        selector: '(page)',
        detail: `${uniq.length} console/page error(s): ${uniq.slice(0, 6).join(' || ')}`,
        screenshot: `screenshots/${tag}.png`,
      });
    }

    await page.screenshot({ path: join(SHOTS, `${tag}.png`), fullPage: false }).catch(() => {});
  } catch (err) {
    addFinding({
      device: device.id,
      route: route.name,
      viewport: `${device.width}x${device.height}`,
      type: 'audit-error',
      severity: 'medium',
      selector: '(navigation)',
      detail: `Audit could not complete for ${route.path}: ${String(err).slice(0, 160)}`,
      screenshot: `screenshots/${tag}.png`,
    });
  } finally {
    await context.close();
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const routes = ROUTES.filter((r) => !FILTER || r.name.includes(FILTER) || r.path.includes(FILTER));
  const browser = await chromium.launch();
  console.log(`UI audit → ${BASE_URL}  (${DEVICES.length} devices × ${routes.length} routes)`);
  for (const device of DEVICES) {
    for (const route of routes) {
      process.stdout.write(`  ${device.id} ${route.name} … `);
      const before = findings.length;
      await auditOne(browser, device, route);
      console.log(`${findings.length - before} finding(s)`);
    }
  }
  await browser.close();

  const bySeverity = findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const byType = findings.reduce((m, f) => ((m[f.type] = (m[f.type] || 0) + 1), m), {});
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    devices: DEVICES.map((d) => `${d.id} ${d.width}x${d.height}`),
    routes: routes.map((r) => r.path + ' (' + r.name + ')'),
    summary: { total: findings.length, bySeverity, byType },
    findings,
  };
  writeFileSync(join(OUT, 'findings.json'), JSON.stringify(report, null, 2));

  const lines = [
    `Drawesome UI audit — ${report.generatedAt}`,
    `Base: ${BASE_URL}`,
    `Total findings: ${findings.length}  (${JSON.stringify(bySeverity)})`,
    `By type: ${JSON.stringify(byType)}`,
    '',
    ...findings.map((f) => `[${f.severity}] ${f.device}/${f.route} ${f.type} — ${f.selector}\n    ${f.detail}`),
  ];
  writeFileSync(join(OUT, 'summary.txt'), lines.join('\n'));
  console.log(`\n${findings.length} findings → audit-results/findings.json`);
  console.log(`Severity: ${JSON.stringify(bySeverity)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
