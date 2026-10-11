// Admin two-factor login: admin key (something you know) + a 6-digit TOTP code
// from an authenticator app (something you have), exchanged for a short-lived
// session token that the console keeps in sessionStorage. Nothing here touches
// kids' accounts or the anonymous app: it only gates /admin, /watch and
// /api/admin/*.
//
// Files (both under DATA_DIR, 0600):
//   .admin-totp.json      { version, issuer, label, secret (base32), createdAt,
//                           recovery: [sha256 hex of each unused code],
//                           lastCounter }  written by scripts/admin-2fa-setup.mjs,
//                           updated here when a code is used (replay guard) or a
//                           recovery code is burned.
//   .admin-sessions.json  { sessions: [[sha256(token), expiresAt, createdAt]] }
//
// Until .admin-totp.json exists (fresh checkout, test harnesses), the raw admin
// key still works exactly as before, so nothing fails closed on a dev box. Once
// it exists, the raw key alone is refused everywhere: a leaked key no longer
// opens the console. ADMIN_TOTP_SECRET in the environment overrides the file's
// secret (Docker secrets), the file still carries the mutable state.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1; // accept the previous / next step (clock drift)
export const RECOVERY_CODES = 10;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// RFC 4226 HOTP with SHA-1 (what Google Authenticator and friends implement).
export function hotp(secret, counter, digits = TOTP_DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[19] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

// RFC 6238 TOTP for the step containing `nowMs`.
export function totp(secretB32, nowMs = Date.now(), stepSec = TOTP_STEP_SEC) {
  return hotp(base32Decode(secretB32), Math.floor(nowMs / 1000 / stepSec));
}

function digitsEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Returns the matched step counter, or -1. A counter at or below
// `lastCounter` is refused so a code can never be replayed inside its window.
export function verifyTotp(secretB32, code, { nowMs = Date.now(), window = TOTP_WINDOW, lastCounter = -1 } = {}) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return -1;
  const secret = base32Decode(secretB32);
  if (!secret.length) return -1;
  const center = Math.floor(nowMs / 1000 / TOTP_STEP_SEC);
  for (let d = -window; d <= window; d += 1) {
    const counter = center + d;
    if (counter <= lastCounter) continue;
    if (digitsEqual(hotp(secret, counter), clean)) return counter;
  }
  return -1;
}

export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

// Recovery codes: 10 groups of "xxxxx-xxxxx" from an alphabet with no 0/O/1/I/L.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generateRecoveryCodes(count = RECOVERY_CODES) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let s = '';
    for (let j = 0; j < 10; j += 1) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return codes;
}
export function normalizeRecovery(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
export function hashRecovery(code) {
  return createHash('sha256').update(`drawesome-admin-recovery:${normalizeRecovery(code)}`).digest('hex');
}

export function otpauthUrl({ secret, issuer = 'Drawesome', label = 'admin' }) {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SEC}`;
}

export function totpConfigPath(dataDir) {
  return join(dataDir, '.admin-totp.json');
}

// Write a fresh enrollment (the setup script calls this). Returns the plain
// recovery codes, which exist nowhere else after this call.
export function writeTotpConfig(dataDir, { issuer = 'Drawesome', label = 'admin', secret = generateSecret() } = {}) {
  const codes = generateRecoveryCodes();
  const config = {
    version: 1,
    issuer,
    label,
    secret,
    createdAt: Date.now(),
    recovery: codes.map(hashRecovery),
    lastCounter: -1,
  };
  writeFileSync(totpConfigPath(dataDir), JSON.stringify(config, null, 2), { mode: 0o600 });
  return { config, codes };
}

const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

export function createAdminAuth({ dataDir, sessionHours = Number(process.env.ADMIN_SESSION_HOURS || 12), now = Date.now } = {}) {
  const configFile = totpConfigPath(dataDir);
  const sessionsFile = join(dataDir, '.admin-sessions.json');
  const sessionMs = Math.max(0.25, sessionHours) * 3600_000;
  let config = null;
  // tokenHash -> { exp, createdAt }
  const sessions = new Map();

  function loadConfig() {
    try {
      const raw = JSON.parse(readFileSync(configFile, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      const secret = String(process.env.ADMIN_TOTP_SECRET || raw.secret || '').replace(/[^A-Za-z2-7]/g, '').toUpperCase();
      if (!secret) return null;
      return {
        issuer: raw.issuer || 'Drawesome',
        label: raw.label || 'admin',
        secret,
        createdAt: Number(raw.createdAt) || 0,
        recovery: Array.isArray(raw.recovery) ? raw.recovery.filter((h) => typeof h === 'string') : [],
        lastCounter: Number.isFinite(Number(raw.lastCounter)) ? Number(raw.lastCounter) : -1,
      };
    } catch {
      return null;
    }
  }

  function saveConfig() {
    if (!config) return;
    try {
      const onDisk = (() => { try { return JSON.parse(readFileSync(configFile, 'utf8')); } catch { return {}; } })();
      writeFileSync(configFile, JSON.stringify({
        ...onDisk,
        version: 1,
        issuer: config.issuer,
        label: config.label,
        // Never copy an env-provided secret into the file.
        secret: onDisk.secret || (process.env.ADMIN_TOTP_SECRET ? undefined : config.secret),
        recovery: config.recovery,
        lastCounter: config.lastCounter,
      }, null, 2), { mode: 0o600 });
    } catch {
      // A failed write only weakens the replay guard until the next save.
    }
  }

  function loadSessions() {
    try {
      const raw = JSON.parse(readFileSync(sessionsFile, 'utf8'));
      const t = now();
      for (const row of Array.isArray(raw.sessions) ? raw.sessions : []) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
        const exp = Number(row[1]) || 0;
        if (exp > t) sessions.set(row[0], { exp, createdAt: Number(row[2]) || 0 });
      }
    } catch {
      // none yet
    }
  }

  function saveSessions() {
    try {
      writeFileSync(sessionsFile, JSON.stringify({ sessions: [...sessions.entries()].map(([h, s]) => [h, s.exp, s.createdAt]) }), { mode: 0o600 });
    } catch {
      // ignore: sessions then simply end at the next restart
    }
  }

  function sweep() {
    const t = now();
    let changed = false;
    for (const [h, s] of sessions) if (s.exp <= t) { sessions.delete(h); changed = true; }
    if (changed) saveSessions();
  }

  config = loadConfig();
  loadSessions();

  // Re-read the enrollment file when it appears or changes, so the setup
  // script can enroll (or rotate) without a server restart.
  let lastConfigCheck = 0;
  function refreshConfig() {
    const t = now();
    if (t - lastConfigCheck < 5000) return;
    lastConfigCheck = t;
    const fresh = loadConfig();
    if (!fresh) { config = null; return; }
    if (!config || fresh.secret !== config.secret || fresh.createdAt !== config.createdAt) {
      config = fresh;
    } else {
      // Keep our in-memory replay counter if it is ahead of the file's.
      config.recovery = fresh.recovery;
      config.lastCounter = Math.max(config.lastCounter, fresh.lastCounter);
    }
  }

  function enrolled() {
    refreshConfig();
    return !!config;
  }

  function issueSession() {
    sweep();
    const token = randomBytes(32).toString('hex');
    const t = now();
    sessions.set(hashToken(token), { exp: t + sessionMs, createdAt: t });
    saveSessions();
    return { token, expiresAt: t + sessionMs };
  }

  // `keyMatches(key)` is the server's constant-time admin-key check.
  function login({ key, code, keyMatches }) {
    if (!keyMatches(key)) return { ok: false, reason: 'bad_key' };
    if (!enrolled()) return { ok: true, method: 'key', ...issueSession() };
    const clean = String(code || '').trim();
    if (!clean) return { ok: false, reason: 'code_required' };
    if (/^\d{6}$/.test(clean.replace(/\s+/g, ''))) {
      const counter = verifyTotp(config.secret, clean, { nowMs: now(), lastCounter: config.lastCounter });
      if (counter < 0) return { ok: false, reason: 'bad_code' };
      config.lastCounter = counter;
      saveConfig();
      return { ok: true, method: 'totp', ...issueSession() };
    }
    const h = hashRecovery(clean);
    const idx = config.recovery.findIndex((stored) => digitsEqual(stored, h));
    if (idx < 0) return { ok: false, reason: 'bad_code' };
    config.recovery.splice(idx, 1); // one use only
    saveConfig();
    return { ok: true, method: 'recovery', recoveryLeft: config.recovery.length, ...issueSession() };
  }

  function sessionValid(token) {
    if (!token || typeof token !== 'string' || token.length !== 64) return null;
    const s = sessions.get(hashToken(token));
    if (!s) return null;
    if (s.exp <= now()) { sessions.delete(hashToken(token)); saveSessions(); return null; }
    return { expiresAt: s.exp };
  }

  function revoke(token) {
    if (!token) return false;
    const had = sessions.delete(hashToken(String(token)));
    if (had) saveSessions();
    return had;
  }

  function status() {
    return {
      totp: enrolled(),
      sessionHours: sessionMs / 3600_000,
      recoveryLeft: config ? config.recovery.length : null,
      sessions: sessions.size,
    };
  }

  return { enrolled, login, sessionValid, revoke, status, persistNow: saveSessions, sweep };
}
