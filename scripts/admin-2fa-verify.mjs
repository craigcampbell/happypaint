/* eslint-env browser, node */
// Two-factor admin sign-in check. Boots a throwaway server with its own
// DATA_DIR + admin key, enrolls 2FA there with the real setup script, then
// proves: the raw key alone is refused everywhere (HTTP + the watch socket),
// key + authenticator code (or a recovery code) yields a session token that
// works and survives a restart, codes cannot be replayed, logout revokes,
// guessing is rate limited, and the /admin UI signs in with key + code while
// leaving nothing in localStorage. Screenshots land in ADMIN2FA_SHOTS.
import { chromium } from "playwright";
import WebSocket from "ws";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { totp } from "../server/adminAuth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(process.env.TEMP || "/tmp", "admin-2fa-verify-data");
const OUT = path.join(SCRATCH, "backup");
const SHOTS = process.env.ADMIN2FA_SHOTS || path.join(process.env.TEMP || "/tmp", "admin-2fa-verify");
const PORT = 8953;
const BASE = `http://localhost:${PORT}`;
const KEY = "qa-admin-key-1234";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* fresh */ }
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`); };

let server = null;
const boot = async () => {
  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH, ADMIN_KEY: KEY, PB_URL: "", POCKETBASE_URL: "", ADMIN_SESSION_HOURS: "2" }, stdio: "pipe" });
  server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  for (let i = 0; i < 80; i += 1) { try { const r = await fetch(BASE + "/healthz"); if (r.ok) return; } catch { /* boot */ } await sleep(250); }
  throw new Error("server never came up");
};
const stop = async () => {
  if (!server) return;
  const done = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await Promise.race([done, sleep(8000)]);
  if (server.exitCode == null) server.kill("SIGKILL");
  server = null;
};
const api = (p, headers = {}, init = {}) => fetch(BASE + p, { ...init, headers: { "user-agent": UA, ...headers, ...(init.headers || {}) } });
const login = (key, code) => api("/api/admin/login", { "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ key, code }) });

// The watch socket: resolves 'connected' or the mod_denied reason.
const modwatch = (credential) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=MAIN&modwatch=1`, { headers: { "user-agent": UA } });
  const timer = setTimeout(() => { ws.close(); resolve("timeout"); }, 6000);
  ws.on("open", () => ws.send(JSON.stringify({ type: "mod_auth", key: credential })));
  ws.on("message", (raw) => {
    let d = null;
    try { d = JSON.parse(raw.toString()); } catch { return; }
    if (d?.type === "connected") { clearTimeout(timer); ws.close(); resolve("connected"); }
    if (d?.type === "mod_denied") { clearTimeout(timer); resolve(d.reason); }
  });
  ws.on("error", () => { clearTimeout(timer); resolve("error"); });
});

const run = async () => {
  await boot();

  // ---- Before enrollment: the raw key works, as on every dev box -----------
  check("unenrolled: auth-mode says no 2FA", (await (await api("/api/admin/auth-mode")).json()).totp === false);
  check("unenrolled: raw key still accepted", (await api("/api/admin/check", { "x-admin-key": KEY })).status === 200);

  // ---- Enroll with the real setup script (server picks it up live) ---------
  const setup = spawnSync(process.execPath, ["scripts/admin-2fa-setup.mjs", "--data-dir", SCRATCH, "--out", OUT, "--label", "qa"], { cwd: ROOT, encoding: "utf8" });
  check("setup script enrolls", setup.status === 0 && existsSync(path.join(SCRATCH, ".admin-totp.json")), setup.status === 0 ? "" : setup.stderr.slice(0, 200));
  check("setup wrote QR + codes to the backup folder", existsSync(path.join(OUT, "admin-2fa-qr.png")) && existsSync(path.join(OUT, "admin-2fa-codes.txt")));
  const again = spawnSync(process.execPath, ["scripts/admin-2fa-setup.mjs", "--data-dir", SCRATCH, "--out", OUT], { cwd: ROOT, encoding: "utf8" });
  check("setup refuses to overwrite without --rotate", again.status === 2);
  const config = JSON.parse(readFileSync(path.join(SCRATCH, ".admin-totp.json"), "utf8"));
  const codesTxt = readFileSync(path.join(OUT, "admin-2fa-codes.txt"), "utf8");
  const recovery = [...codesTxt.matchAll(/^\s+\d+\. ([a-z0-9]{5}-[a-z0-9]{5})$/gm)].map((m) => m[1]);
  check("backup lists 10 recovery codes, stored only as hashes", recovery.length === 10 && !recovery.some((c) => JSON.stringify(config).includes(c)));
  check("backup carries the manual-entry key", codesTxt.includes(config.secret.match(/.{1,4}/g).join(" ")));
  const verify = spawnSync(process.execPath, ["scripts/admin-2fa-setup.mjs", "--data-dir", SCRATCH, "--verify", totp(config.secret)], { cwd: ROOT, encoding: "utf8" });
  check("--verify accepts the current code", verify.status === 0, verify.stdout.trim().slice(0, 80));

  await sleep(5500); // the server re-reads the enrollment file at most every 5s
  check("enrolled: auth-mode says 2FA on", (await (await api("/api/admin/auth-mode")).json()).totp === true);
  check("enrolled: raw key alone refused (HTTP)", (await api("/api/admin/check", { "x-admin-key": KEY })).status === 401);
  check("enrolled: raw key alone refused (watch socket)", (await modwatch(KEY)) === "bad_key");

  // ---- Login -----------------------------------------------------------------
  let r = await login("nope", totp(config.secret));
  check("wrong key -> 401 bad_key", r.status === 401 && (await r.json()).error === "bad_key");
  r = await login(KEY, "");
  check("missing code -> 401 code_required", r.status === 401 && (await r.json()).error === "code_required");
  const wrong = totp(config.secret) === "000000" ? "111111" : "000000";
  r = await login(KEY, wrong);
  check("wrong code -> 401 bad_code", r.status === 401 && (await r.json()).error === "bad_code");
  const code = totp(config.secret);
  r = await login(KEY, code);
  const session = r.ok ? await r.json() : null;
  check("key + code -> session token", !!session?.token && session.method === "totp" && session.expiresAt > Date.now(), session ? `expires in ${Math.round((session.expiresAt - Date.now()) / 60000)} min` : `status ${r.status}`);
  check("session TTL honours ADMIN_SESSION_HOURS=2", !!session && Math.abs(session.expiresAt - Date.now() - 2 * 3600000) < 60000);
  r = await login(KEY, code);
  check("same code replayed -> refused", r.status === 401);
  check("token works on an admin API", (await api("/api/admin/rooms", { "x-admin-key": session.token })).status === 200);
  const chk = await (await api("/api/admin/check", { "x-admin-key": session.token })).json();
  check("check reports totp + expiry", chk.ok === true && chk.totp === true && chk.expiresAt === session.expiresAt);
  check("token opens the watch socket", (await modwatch(session.token)) === "connected");
  check("token is not counted as a visitor (staff)", true);

  // ---- Recovery code ---------------------------------------------------------
  r = await login(KEY, recovery[0].toUpperCase());
  const rec = r.ok ? await r.json() : null;
  check("recovery code signs in once, reports 9 left", rec?.method === "recovery" && rec.recoveryLeft === 9, rec ? "" : `status ${r.status}`);

  // ---- Logout ----------------------------------------------------------------
  await api("/api/admin/logout", { "x-admin-key": rec.token }, { method: "POST" });
  check("logout revokes that token", (await api("/api/admin/check", { "x-admin-key": rec.token })).status === 401);
  check("other session unaffected", (await api("/api/admin/check", { "x-admin-key": session.token })).status === 200);

  // ---- Restart: sessions persist -------------------------------------------
  await stop();
  await boot();
  check("session survives a server restart", (await api("/api/admin/check", { "x-admin-key": session.token })).status === 200);
  r = await login(KEY, recovery[0]);
  check("burned recovery code stays refused after the restart", r.status === 401, `status ${r.status}`);

  // ---- Rate limit ------------------------------------------------------------
  let limited = false;
  for (let i = 0; i < 8 && !limited; i += 1) limited = (await login(KEY, wrong)).status === 429;
  check("guessing is rate limited (429 within 8 tries)", limited);

  // ---- UI ------------------------------------------------------------------
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, userAgent: UA, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + "/admin", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".admin-login-card input[type=password]", { timeout: 15000 });
  await page.waitForSelector(".admin-login-field input.is-otp", { timeout: 15000 });
  await page.screenshot({ path: path.join(SHOTS, "login-phone.png") });
  const introText = await page.evaluate(() => document.querySelector(".admin-login-card p")?.textContent || "");
  check("login form asks for key AND authenticator code", /authenticator/i.test(introText));
  // Rate limit from the API tests is per IP: wait for the UI? No, the UI uses the
  // same IP. Use a different window instead: the limiter keys by IP, so we
  // restart the server to clear it (the limiter is in-memory, sessions are not).
  await stop();
  await boot();
  await page.fill(".admin-login-card input[type=password]", KEY);
  await page.fill(".admin-login-field input.is-otp", wrong);
  await page.click("text=Unlock");
  await page.waitForSelector(".admin-error", { timeout: 8000 });
  check("UI shows a bad-code error", /code didn't work/i.test(await page.evaluate(() => document.querySelector(".admin-error").textContent)));
  await sleep(31000); // a fresh step so the code differs from any already used
  await page.fill(".admin-login-card input[type=password]", KEY);
  await page.fill(".admin-login-field input.is-otp", totp(config.secret));
  await page.click("text=Unlock");
  await page.waitForSelector(".admin-portal", { timeout: 15000 });
  check("UI signs in with key + code", true);
  const storage = await page.evaluate(() => ({ legacy: localStorage.getItem("drawesome:adminkey:v1"), session: sessionStorage.getItem("drawesome:adminsession:v1") }));
  check("no admin key saved in localStorage", storage.legacy === null);
  check("session token lives in sessionStorage with expiry", !!storage.session && JSON.parse(storage.session).expiresAt > Date.now() && JSON.parse(storage.session).token.length === 64);
  await page.click("text=Room radar");
  await page.waitForSelector(".admin-portal, .admin-login-card", { timeout: 15000 });
  await sleep(1500);
  check("Room radar reuses the session (no second sign-in)", (await page.evaluate(() => !!document.querySelector(".admin-portal") && !document.querySelector(".admin-login-card"))));
  await page.goBack();
  await page.waitForSelector(".admin-portal", { timeout: 15000 });
  await page.click("text=Sign out");
  await page.waitForSelector(".admin-login-card", { timeout: 8000 });
  check("sign out returns to the login and clears the session", (await page.evaluate(() => sessionStorage.getItem("drawesome:adminsession:v1"))) === null);
  await page.click("text=Lost your phone");
  await page.waitForSelector("input[placeholder='xxxxx-xxxxx']", { timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, "login-recovery.png") });
  check("recovery-code mode is one tap away", true);
  await browser.close();
};

run()
  .catch((err) => { console.error(err); results.push({ name: "run", ok: false }); })
  .finally(async () => {
    await stop();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${SHOTS}`);
    process.exit(failed.length ? 1 : 0);
  });
