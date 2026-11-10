import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAdminAuth, writeTotpConfig, totp } from '../server/adminAuth.js';

const HOUR = 3600_000;
function fixture(run) {
  const dir = mkdtempSync('/home/craig/.hermes/cache/scratch/admin-remember-unit-');
  try {
    let clock = 1800000000000;
    let key = randomBytes(32).toString('hex');
    const enrollment = writeTotpConfig(dir);
    const options = { dataDir: dir, now: () => clock, keyEpoch: () => key };
    const auth = createAdminAuth(options);
    const keyMatches = (candidate) => candidate === key;
    run({ dir, auth, options, config: enrollment.config, codes: enrollment.codes, key, keyMatches,
      advance: (ms) => { clock += ms; }, setClock: (ms) => { clock = ms; },
      rotateKey: () => { key = randomBytes(32).toString('hex'); },
      login: (extra = {}) => auth.login({ key, code: totp(enrollment.config.secret, clock), keyMatches, ...extra }),
      code: () => totp(enrollment.config.secret, clock), now: () => clock });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('remembered device lasts seven days but authorization ends exactly at four hours', () => fixture(({ auth, options, login, advance, setClock, code, keyMatches }) => {
  const signed = login();
  assert.equal(signed.ok, true);
  assert.equal(signed.expiresAt, 1800000000000 + 4 * HOUR);
  assert.equal(signed.deviceExpiresAt, 1800000000000 + 7 * 24 * HOUR);
  const cookies = { deviceToken: signed.deviceToken, authorizationToken: signed.authorizationToken };
  assert.ok(cookies.deviceToken && cookies.authorizationToken);
  assert.equal(auth.resume({ deviceToken: cookies.deviceToken }).ok, false);
  assert.equal(auth.sessionValid(cookies.deviceToken), null);
  const resumed = auth.resume(cookies);
  assert.equal(resumed.expiresAt, signed.expiresAt);
  auth = createAdminAuth(options);
  assert.ok(auth.sessionValid(resumed.token), 'restart retains valid grant');
  advance(4 * HOUR - 1);
  assert.equal(auth.resume(cookies).ok, true);
  advance(1);
  assert.equal(auth.sessionValid(signed.token), null);
  assert.equal(auth.resume(cookies).reason, 'code_required');
  const reauthed = auth.login({ deviceToken: cookies.deviceToken, code: code(), keyMatches });
  assert.equal(reauthed.ok, true, 'no key until seven days');
  assert.equal(reauthed.deviceExpiresAt, signed.deviceExpiresAt, 'device expiry never slides');
  setClock(signed.deviceExpiresAt - 1);
  const last = auth.login({ deviceToken: cookies.deviceToken, code: code(), keyMatches });
  assert.equal(last.ok, true);
  assert.equal(last.expiresAt, signed.deviceExpiresAt, 'authorization cannot outlive device');
  advance(1);
  assert.equal(auth.sessionValid(last.token), null);
  assert.equal(auth.login({ deviceToken: cookies.deviceToken, code: code(), keyMatches }).reason, 'bad_key');
}));

test('replay, bad credentials, cross-device grants, logout and forget-device fail closed', () => fixture(({ auth, options, login, advance, keyMatches, code, codes }) => {
  const first = login();
  assert.equal(login().reason, 'bad_code', 'same TOTP cannot be replayed');
  assert.equal(createAdminAuth(options).login({ key: 'wrong', code: code(), keyMatches }).reason, 'bad_key');
  const cookies = { deviceToken: first.deviceToken, authorizationToken: first.authorizationToken };
  assert.equal(login({ key: 'wrong', deviceToken: first.deviceToken }).reason, 'bad_key');
  assert.equal(login({ deviceToken: first.deviceToken, code: 'not-a-code' }).reason, 'bad_code');
  advance(30000);
  const second = login();
  assert.equal(auth.resume({ deviceToken: second.deviceToken, authorizationToken: first.authorizationToken }).ok, false);
  const tab = auth.resume(cookies);
  auth.revoke(tab.token);
  assert.equal(auth.sessionValid(first.token), null, 'logout revokes all tokens under the grant');
  assert.equal(auth.resume(cookies).ok, false);
  assert.ok(auth.remembered(first.deviceToken), 'normal logout remembers device');
  assert.equal(createAdminAuth(options).sessionValid(tab.token), null, 'revocation survives restart');
  advance(30000);
  const fresh = login({ key: '', deviceToken: first.deviceToken });
  assert.equal(fresh.ok, true);
  auth.revoke(fresh.token, { deviceToken: first.deviceToken, forget: true });
  assert.equal(auth.remembered(first.deviceToken), null);
  assert.equal(createAdminAuth(options).remembered(first.deviceToken), null);
  const recovery = login({ code: codes[0] });
  assert.equal(recovery.ok, true);
  assert.equal(login({ code: codes[0] }).reason, 'bad_code');
}));

test('key and 2FA rotation invalidate devices and active sessions, including after restart', () => fixture(({ dir, auth, options, login, rotateKey, advance }) => {
  const first = login();
  rotateKey();
  assert.equal(auth.sessionValid(first.token), null);
  assert.equal(auth.remembered(first.deviceToken), null);
  advance(30000);
  const second = login();
  assert.equal(second.ok, true);
  writeTotpConfig(dir);
  assert.equal(auth.sessionValid(second.token), null);
  assert.equal(auth.remembered(second.deviceToken), null);
  assert.equal(createAdminAuth(options).sessionValid(second.token), null);
}));

test('persistent state contains hashes only and malformed enrollment never downgrades to raw-key mode', () => fixture(({ dir, auth, login }) => {
  const signed = login();
  const persisted = readFileSync(join(dir, '.admin-sessions.json'), 'utf8');
  for (const secret of [signed.token, signed.deviceToken, signed.authorizationToken]) assert.ok(!persisted.includes(secret));
  assert.equal(statSync(join(dir, '.admin-sessions.json')).mode & 0o777, 0o600);
  writeFileSync(join(dir, '.admin-totp.json'), '{');
  assert.equal(auth.enrolled(), true);
  assert.equal(auth.sessionValid(signed.token), null);
  assert.equal(login().reason, 'unavailable');
}));

test('missing enrollment after restart cannot downgrade an enrolled server to raw-key mode', () => fixture(({ dir, login, options }) => {
  login();
  rmSync(join(dir, '.admin-totp.json'));
  const restarted = createAdminAuth(options);
  assert.equal(restarted.enrolled(), true);
  assert.equal(restarted.login({ key: 'anything', keyMatches: () => true }).reason, 'unavailable');
}));

test('stale tab logout revokes reauthorized cookie grant', () => fixture(({ auth, login, advance, options }) => {
  const a = login(); advance(30000);
  const b = login({ deviceToken: a.deviceToken });
  auth.revoke(a.token, b);
  assert.equal(auth.sessionValid(b.token), null);
  assert.equal(createAdminAuth(options).resume(b).ok, false);
}));

test('rotation persistence failure stays closed, never throws and retries until durable', () => fixture(({ dir, auth, login, rotateKey, options, advance }) => {
  const a = login();
  const temp = join(dir, '.admin-sessions.json.tmp'); mkdirSync(temp);
  rotateKey();
  assert.doesNotThrow(() => auth.sessionValid(a.token));
  assert.equal(auth.sessionValid(a.token), null);
  assert.equal(auth.enrolled(), true);
  assert.equal(login().reason, 'unavailable');
  rmSync(temp, { recursive: true });
  assert.equal(auth.sessionValid(a.token), null);
  assert.equal(createAdminAuth(options).sessionValid(a.token), null);
  advance(30000);
  assert.equal(login().ok, true);
}));

test('failed reauthorization preserves old authorization but consumes the factor', () => fixture(({ dir, auth, login, advance, options }) => {
  const a = login(); advance(30000);
  const before = readFileSync(join(dir, '.admin-sessions.json'), 'utf8');
  const temp = join(dir, '.admin-sessions.json.tmp'); mkdirSync(temp);
  assert.equal(login({ deviceToken: a.deviceToken }).reason, 'unavailable');
  assert.ok(auth.sessionValid(a.token));
  assert.equal(readFileSync(join(dir, '.admin-sessions.json'), 'utf8'), before);
  assert.ok(createAdminAuth(options).sessionValid(a.token));
  rmSync(temp, { recursive: true });
  assert.equal(login({ deviceToken: a.deviceToken }).reason, 'bad_code');
}));

test('resume stress bounds sessions without evicting existing watch tabs and sweeps expiry', () => fixture(({ dir, auth, login, advance }) => {
  const a = login(); const tokens = [];
  for (let i = 0; i < 512; i++) {
    const result = auth.resume(a);
    if (result.ok) tokens.push(result.token);
    else assert.equal(result.reason, 'rate_limited');
  }
  assert.ok(tokens.length >= 32, 'many simultaneous watch tabs supported');
  assert.ok(auth.status().sessions <= 128);
  for (const token of tokens) assert.ok(auth.sessionValid(token));
  assert.ok(JSON.parse(readFileSync(join(dir, '.admin-sessions.json'), 'utf8')).sessions.length <= 128);
  advance(4 * HOUR);
  auth.resume(a);
  assert.equal(auth.status().sessions, 0);
}));

test('failed resume never retains an unacknowledged token; failed revoke retries durably', () => fixture(({ dir, auth, login, options }) => {
  const a = login();
  const before = auth.status().sessions;
  const temp = join(dir, '.admin-sessions.json.tmp'); mkdirSync(temp);
  assert.equal(auth.resume(a).reason, 'unavailable');
  assert.equal(auth.status().sessions, before);
  assert.throws(() => auth.revoke(a.token, a));
  assert.equal(auth.sessionValid(a.token), null);
  assert.equal(auth.resume(a).reason, 'unavailable');
  rmSync(temp, { recursive: true });
  assert.equal(auth.sessionValid(a.token), null);
  assert.equal(createAdminAuth(options).sessionValid(a.token), null);
}));

test('unenrolled development keeps raw-key login without remembered cookies', () => {
  const dir = mkdtempSync('/home/craig/.hermes/cache/scratch/admin-dev-unit-');
  try {
    const auth = createAdminAuth({ dataDir: dir });
    const signed = auth.login({ key: 'synthetic-development-key', keyMatches: (key) => key === 'synthetic-development-key' });
    assert.equal(signed.ok, true);
    assert.equal(signed.deviceToken, null);
    assert.ok(auth.sessionValid(signed.token));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
