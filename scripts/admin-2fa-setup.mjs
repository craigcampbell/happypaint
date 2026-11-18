// Enroll (or rotate) two-factor sign-in for /admin.
//
//   node scripts/admin-2fa-setup.mjs                      # production data dir (./app_data)
//   node scripts/admin-2fa-setup.mjs --data-dir ./.data   # a local dev server
//   node scripts/admin-2fa-setup.mjs --rotate             # replace an existing enrollment
//   node scripts/admin-2fa-setup.mjs --verify 123456      # check a code from your phone
//   node scripts/admin-2fa-setup.mjs --status             # enrolled? recovery codes left?
//
// Writes DATA_DIR/.admin-totp.json (the server picks it up within seconds, no
// restart) and a private backup folder (default ~/Desktop/drawesome-admin-2fa)
// holding the QR code to scan, the manual-entry key and the ten one-time
// recovery codes. The recovery codes are stored only as hashes on the server,
// so that folder is the only place they exist: keep it somewhere safe.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { otpauthUrl, totp, totpConfigPath, verifyTotp, writeTotpConfig } from "../server/adminAuth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dataDir = path.resolve(ROOT, opt("--data-dir", process.env.DATA_DIR || "app_data"));
const outDir = path.resolve(opt("--out", path.join(homedir(), "Desktop", "drawesome-admin-2fa")));
const issuer = opt("--issuer", "Drawesome");
const label = opt("--label", "admin@drawesome.art");
const configFile = totpConfigPath(dataDir);

const readConfig = () => {
  try { return JSON.parse(readFileSync(configFile, "utf8")); } catch { return null; }
};

if (flag("--status")) {
  const c = readConfig();
  if (!c) {
    console.log(`Not enrolled: ${configFile} does not exist. The raw admin key still signs in.`);
  } else {
    console.log(`Enrolled ${new Date(c.createdAt).toLocaleString()} as ${c.issuer}:${c.label}`);
    console.log(`Recovery codes left: ${Array.isArray(c.recovery) ? c.recovery.length : "?"}`);
  }
  process.exit(0);
}

if (flag("--verify")) {
  const c = readConfig();
  if (!c) { console.error(`Not enrolled (${configFile} missing).`); process.exit(2); }
  const code = opt("--verify", "");
  const counter = verifyTotp(c.secret, code, { lastCounter: -1 });
  if (counter >= 0) {
    console.log("OK: that code is valid right now. Your authenticator is set up correctly.");
    process.exit(0);
  }
  console.log(`Not valid. The server expects ${totp(c.secret)} this half-minute. If your phone shows something else, its clock is off or the wrong entry was scanned.`);
  process.exit(1);
}

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (existsSync(configFile) && !flag("--rotate")) {
  console.error(`Already enrolled: ${configFile} exists.`);
  console.error("Re-run with --rotate to replace it (the old authenticator entry and recovery codes stop working).");
  process.exit(2);
}

const { config, codes } = writeTotpConfig(dataDir, { issuer, label });
const url = otpauthUrl({ secret: config.secret, issuer, label });

mkdirSync(outDir, { recursive: true });
try { chmodSync(outDir, 0o700); } catch { /* best effort */ }
const stamp = new Date().toISOString().slice(0, 10);
const pngPath = path.join(outDir, "admin-2fa-qr.png");
const txtPath = path.join(outDir, "admin-2fa-codes.txt");
const svgPath = path.join(outDir, "admin-2fa-qr.svg");
await QRCode.toFile(pngPath, url, { width: 480, margin: 2, errorCorrectionLevel: "M" });
await QRCode.toFile(svgPath, url, { margin: 2, errorCorrectionLevel: "M" });
const manualKey = config.secret.match(/.{1,4}/g).join(" ");
writeFileSync(txtPath, [
  `Drawesome /admin two-factor sign-in  (enrolled ${stamp})`,
  "",
  "KEEP THIS FILE PRIVATE. Anyone holding it plus the admin key can sign in.",
  "",
  "1. Google Authenticator: + → Scan a QR code → admin-2fa-qr.png (same folder).",
  "   Or: + → Enter a setup key:",
  `     Account name: ${issuer} (${label})`,
  `     Key:          ${manualKey}`,
  "     Type of key:  Time based",
  "",
  "2. Check it:  node scripts/admin-2fa-setup.mjs --verify <6 digits from the app>",
  "",
  "3. Sign in at https://drawesome.art/admin with the admin key AND the 6-digit code.",
  "",
  "RECOVERY CODES, each works ONCE, use when the phone is lost:",
  ...codes.map((c, i) => `   ${String(i + 1).padStart(2, " ")}. ${c}`),
  "",
  "Lost everything?  On the server host:  node scripts/admin-2fa-setup.mjs --rotate",
  "(needs shell access to the box, which is the point).",
  "",
  `otpauth URL (same thing the QR encodes): ${url}`,
  "",
].join("\n"), { mode: 0o600 });
try { chmodSync(pngPath, 0o600); chmodSync(svgPath, 0o600); } catch { /* best effort */ }

console.log(`Enrolled. Server config: ${configFile}`);
console.log(`Backup folder:          ${outDir}`);
console.log("  admin-2fa-qr.png     scan this with Google Authenticator");
console.log("  admin-2fa-codes.txt  manual-entry key + 10 one-time recovery codes");
console.log("");
console.log(await QRCode.toString(url, { type: "terminal", small: true }));
console.log(`Manual entry key: ${manualKey}`);
console.log(`Current code (should match your phone once scanned): ${totp(config.secret)}`);
console.log("");
console.log("Next: scan, then run  node scripts/admin-2fa-setup.mjs --verify <code>");
