// Admin two-factor login: admin key (something you know) + a 6-digit TOTP code
// from an authenticator app (something you have), exchanged for a short-lived
// session token; remembered devices use opaque HttpOnly cookies. Nothing here touches
// kids' accounts or the anonymous app: it only gates /admin, /watch and
// /api/admin/*.
//
// Files (both under DATA_DIR, 0600):
//   .admin-totp.json      { version, issuer, label, secret (base32), createdAt,
//                           recovery: [sha256 hex of each unused code],
//                           lastCounter }  written by scripts/admin-2fa-setup.mjs,
//                           updated here when a code is used (replay guard) or a
//                           recovery code is burned.
//   .admin-sessions.json  v2: hashed devices, second-factor grants and per-tab
//                         tokens, fixed expiries and an enrollment/key fingerprint.
//
// Until .admin-totp.json exists (fresh checkout, test harnesses), the raw admin
// key still works exactly as before, so nothing fails closed on a dev box. Once
// it exists, the raw key alone is refused everywhere: a leaked key no longer
// opens the console. ADMIN_TOTP_SECRET in the environment overrides the file's
// secret (Docker secrets), the file still carries the mutable state.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'fs';
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

// Fixed lifetimes are policy, not an environment override. A device remembers
// only the key check; a separate four-hour grant proves the second factor.
export const ADMIN_AUTH_MS = 4 * 3600_000;
export const ADMIN_DEVICE_MS = 7 * 24 * 3600_000;

export function createAdminAuth({ dataDir, now = Date.now, keyEpoch = () => '' } = {}) {
  const configFile = totpConfigPath(dataDir);
  const stateFile = join(dataDir, '.admin-sessions.json');
  const devices = new Map();
  const grants = new Map();
  const sessions = new Map();
  let config;
  let epoch;
  let unavailable = false;
  let wasEnrolled = false;
  let invalidationPending = false;

  // Atomic replacement and restrictive permissions: never acknowledge a login,
  // replay-counter consumption or revocation that failed to reach disk.
  function atomic(file, value) {
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  }
  function readConfig() {
    try {
      const raw = JSON.parse(readFileSync(configFile, 'utf8'));
      const secret = String(process.env.ADMIN_TOTP_SECRET || raw.secret || '').replace(/[^A-Za-z2-7]/g, '').toUpperCase();
      if (!secret || !Number.isSafeInteger(Number(raw.lastCounter ?? -1)) || Number(raw.lastCounter ?? -1) < -1) throw new Error('invalid enrollment');
      return { ...raw, secret, recovery: Array.isArray(raw.recovery) ? raw.recovery : [], lastCounter: Number(raw.lastCounter ?? -1) };
    } catch (error) {
      if (error.code === 'ENOENT' && !config && !wasEnrolled) return null;
      throw error;
    }
  }
  function generation(fresh) {
    return hashToken(JSON.stringify([keyEpoch(), fresh?.secret, fresh?.createdAt, fresh?.issuer, fresh?.label]));
  }
  function persistNow() {
    atomic(stateFile, { version: 2, enrolled: wasEnrolled, epoch, devices: [...devices], grants: [...grants], sessions: [...sessions] });
  }
  function refresh() {
    let fresh;
    try { fresh = readConfig(); } catch { unavailable = true; return false; }
    const next = generation(fresh);
    if (epoch && epoch !== next) {
      devices.clear(); grants.clear(); sessions.clear();
      invalidationPending = true;
    }
    epoch = next;
    config = fresh;
    wasEnrolled ||= !!fresh;
    if (invalidationPending) {
      try { persistNow(); invalidationPending = false; }
      catch { unavailable = true; return false; }
    }
    unavailable = wasEnrolled && !fresh;
    return !unavailable;
  }
  refresh();
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    wasEnrolled ||= state.enrolled === true;
    if (wasEnrolled && !config) unavailable = true;
    // Legacy twelve-hour sessions deliberately do not migrate.
    if (state.version === 2 && state.epoch === epoch) {
      for (const [name, map] of [['devices', devices], ['grants', grants], ['sessions', sessions]]) {
        for (const [hash, row] of state[name] || []) {
          if (/^[a-f0-9]{64}$/.test(hash) && row.exp > now()) map.set(hash, row);
        }
      }
    }
  } catch { /* no valid persisted sessions */ }

  function enrolled() { refresh(); return !!config || unavailable; }
  function lookup(map, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = map.get(hashToken(token));
    return row && row.exp > now() ? row : null;
  }
  function remembered(deviceToken) {
    if (!refresh() || !config) return null;
    return lookup(devices, deviceToken);
  }
  function grantValid(hash) {
    const grant = grants.get(hash);
    if (!grant || grant.exp <= now()) return null;
    if (grant.device && (!devices.has(grant.device) || devices.get(grant.device).exp <= now())) return null;
    return grant;
  }
  function issueSession(grantHash) {
    const grant = grantValid(grantHash);
    const token = randomBytes(32).toString('hex');
    sessions.set(hashToken(token), { exp: grant.exp, grant: grantHash });
    return { token, expiresAt: grant.exp };
  }
  function sweep() {
    for (const [hash, device] of devices) if (device.exp <= now()) devices.delete(hash);
    for (const [hash] of grants) if (!grantValid(hash)) grants.delete(hash);
    for (const [hash, session] of sessions) if (session.exp <= now() || !grantValid(session.grant)) sessions.delete(hash);
  }
  function login({ key, code, deviceToken, keyMatches }) {
    if (!refresh()) return { ok: false, reason: 'unavailable' };
    const device = remembered(deviceToken);
    // Supplying a wrong key never falls back to the remembered credential.
    if (key ? !keyMatches(key) : !device) return { ok: false, reason: 'bad_key' };
    let method = 'key';
    if (config) {
      const clean = String(code || '').trim();
      if (!clean) return { ok: false, reason: 'code_required' };
      const next = { ...config, recovery: [...config.recovery] };
      if (/^\d{6}$/.test(clean.replace(/\s+/g, ''))) {
        const counter = verifyTotp(config.secret, clean, { nowMs: now(), lastCounter: config.lastCounter });
        if (counter < 0) return { ok: false, reason: 'bad_code' };
        next.lastCounter = counter;
        method = 'totp';
      } else {
        const idx = next.recovery.findIndex((stored) => digitsEqual(stored, hashRecovery(clean)));
        if (idx < 0) return { ok: false, reason: 'bad_code' };
        next.recovery.splice(idx, 1);
        method = 'recovery';
      }
      try {
        const disk = JSON.parse(readFileSync(configFile, 'utf8'));
        atomic(configFile, { ...disk, recovery: next.recovery, lastCounter: next.lastCounter });
      } catch { return { ok: false, reason: 'unavailable' }; }
      config = next;
    }
    sweep();
    const previous = [new Map(devices), new Map(grants), new Map(sessions)];
    const t = now();
    const rememberedToken = config ? (device ? deviceToken : randomBytes(32).toString('hex')) : null;
    const deviceHash = rememberedToken ? hashToken(rememberedToken) : null;
    const deviceExpiresAt = device?.exp || t + ADMIN_DEVICE_MS;
    if (deviceHash && !device) devices.set(deviceHash, { exp: deviceExpiresAt });
    // Reauthorization replaces the old grant for this device, never extends it.
    for (const [hash, grant] of grants) if (deviceHash && grant.device === deviceHash) grants.delete(hash);
    const authorizationToken = randomBytes(32).toString('hex');
    const grantHash = hashToken(authorizationToken);
    grants.set(grantHash, { device: deviceHash, exp: Math.min(t + ADMIN_AUTH_MS, config ? deviceExpiresAt : Infinity) });
    const session = issueSession(grantHash);
    try { persistNow(); } catch {
      for (const [index, map] of [devices, grants, sessions].entries()) {
        map.clear();
        for (const [hash, row] of previous[index]) map.set(hash, row);
      }
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, method, ...session, deviceToken: rememberedToken, deviceExpiresAt: config ? deviceExpiresAt : null, authorizationToken, recoveryLeft: config?.recovery.length ?? null };
  }
  function resume({ deviceToken, authorizationToken }) {
    if (!refresh()) return { ok: false, reason: 'unavailable' };
    sweep();
    if (!remembered(deviceToken)) return { ok: false, reason: 'key_required' };
    const grant = lookup(grants, authorizationToken);
    if (!grant || grant.device !== hashToken(deviceToken) || !grantValid(hashToken(authorizationToken))) return { ok: false, reason: 'code_required' };
    // Per-tab tokens are fixed to the original grant deadline, not refreshed.
    // Refuse excess resumes rather than evicting a token an open watch uses.
    const grantHash = hashToken(authorizationToken);
    if ([...sessions.values()].filter((row) => row.grant === grantHash).length >= 128) return { ok: false, reason: 'rate_limited' };
    const result = issueSession(grantHash);
    try { persistNow(); } catch {
      sessions.delete(hashToken(result.token));
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, ...result };
  }
  function sessionValid(token) {
    if (!refresh()) return null;
    const session = lookup(sessions, token);
    return session && grantValid(session.grant) ? { expiresAt: session.exp } : null;
  }
  function revoke(token, { deviceToken, authorizationToken, forget = false } = {}) {
    if (!refresh()) throw new Error('admin auth unavailable');
    const session = lookup(sessions, token);
    const device = lookup(devices, deviceToken);
    const grant = lookup(grants, authorizationToken);
    const grantHashes = new Set();
    if (session && grantValid(session.grant)) grantHashes.add(session.grant);
    if (grant && device && grant.device === hashToken(deviceToken)) grantHashes.add(hashToken(authorizationToken));
    for (const hash of grantHashes) grants.delete(hash);
    if (forget && device) {
      const hash = hashToken(deviceToken);
      devices.delete(hash);
      for (const [id, row] of grants) if (row.device === hash) grants.delete(id);
    }
    sweep();
    try { persistNow(); } catch (error) {
      invalidationPending = true;
      unavailable = true;
      throw error;
    }
    return grantHashes.size > 0;
  }
  function status() {
    return { totp: enrolled(), sessionHours: 4, rememberDays: 7, recoveryLeft: config?.recovery.length ?? null, sessions: sessions.size };
  }
  return { enrolled, login, resume, remembered, sessionValid, revoke, status, persistNow, sweep };
}
