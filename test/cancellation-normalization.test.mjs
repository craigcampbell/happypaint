// Regression: canonical US cancellation value ("canceled") with backward-read
// compatibility for the legacy UK spelling ("cancelled") across the wire
// (wipe outcomes), URLs (Stripe checkout cancel), checkpoint error reasons,
// and mobile event/deletion statuses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CANCELED, LEGACY_CANCELLED, isCanceled, normalizeCanceled } from '../src/utils/cancellation.js';
import * as mobile from '../mobile/src/cancellation.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('canonical constants', () => {
  assert.equal(CANCELED, 'canceled');
  assert.equal(LEGACY_CANCELLED, 'cancelled');
});

test('normalizeCanceled maps the legacy spelling and passes everything else through', () => {
  assert.equal(normalizeCanceled('cancelled'), 'canceled');
  assert.equal(normalizeCanceled('canceled'), 'canceled');
  for (const other of ['failed', 'left', 'blocked', 'wiped', 'success', 'draft', 'live', '', 'CANCELLED', 'Cancelled']) {
    assert.equal(normalizeCanceled(other), other, `passthrough: ${JSON.stringify(other)}`);
  }
  assert.equal(normalizeCanceled(undefined), undefined);
  assert.equal(normalizeCanceled(null), null);
});

test('isCanceled accepts both spellings and nothing else', () => {
  assert.equal(isCanceled('canceled'), true);
  assert.equal(isCanceled('cancelled'), true);
  for (const other of ['failed', 'left', 'success', '', undefined, null, 'CANCELLED']) {
    assert.equal(isCanceled(other), false, `rejected: ${JSON.stringify(other)}`);
  }
});

test('mobile helper mirrors the web contract', () => {
  assert.equal(mobile.CANCELED, CANCELED);
  assert.equal(mobile.LEGACY_CANCELLED, LEGACY_CANCELLED);
  assert.equal(mobile.normalizeCanceled('cancelled'), 'canceled');
  assert.equal(mobile.normalizeCanceled('canceled'), 'canceled');
  assert.equal(mobile.normalizeCanceled('live'), 'live');
  assert.equal(mobile.isCanceled('cancelled'), true);
  assert.equal(mobile.isCanceled('ended'), false);
});

test('checkout cancel URLs: old (?checkout=cancelled) and new (?checkout=canceled) both recognized', () => {
  // The exact comparison FamilyPage performs on the Stripe return URL.
  const familyMessage = (search) => {
    const result = new URLSearchParams(search).get('checkout');
    if (result === 'success') return 'activating';
    if (isCanceled(result)) return 'not-charged';
    return '';
  };
  assert.equal(familyMessage('?checkout=cancelled'), 'not-charged');
  assert.equal(familyMessage('?checkout=canceled'), 'not-charged');
  assert.equal(familyMessage('?checkout=success'), 'activating');
  assert.equal(familyMessage('?drops=canceled'), '');
  assert.equal(familyMessage(''), '');
});

test('wipe outcomes: legacy and canonical cancel outcomes match, other outcomes do not', () => {
  // The exact branch App.jsx takes on a wipe_req `ended` payload.
  assert.equal(isCanceled('cancelled'), true, 'legacy server outcome');
  assert.equal(isCanceled('canceled'), true, 'canonical server outcome');
  for (const outcome of ['failed', 'left', 'blocked', 'cleared', 'wiped']) {
    assert.equal(isCanceled(outcome), false, `outcome ${outcome} untouched`);
  }
});

test('checkpoint reasons: the decoder emits "canceled" and readers tolerate both', () => {
  const src = readFileSync(`${ROOT}/src/utils/checkpointClient.js`, 'utf8');
  assert.match(src, /fail\("canceled", "checkpoint superseded by a newer baseline"\)/);
  assert.doesNotMatch(src, /fail\("cancelled"/);
  // App.jsx readers route through isCanceled (both spellings) rather than a
  // bare string compare that a mixed-version build could slip past.
  const app = readFileSync(`${ROOT}/src/App.jsx`, 'utf8');
  assert.doesNotMatch(app, /error\?\.reason\s*[!=]==?\s*"cancelled"/);
});

test('event status normalization lives at the mobile ingress point', () => {
  const engine = readFileSync(`${ROOT}/mobile/src/eventEngine.ts`, 'utf8');
  // The canonical type no longer carries the legacy spelling…
  assert.match(engine, /"ended" \| "canceled"/);
  assert.doesNotMatch(engine, /"ended" \| "cancelled"/);
  // …normalization is a named ingress helper delegating to the shared mapper…
  assert.match(engine, /export function normalizeTimedEventStatus\(status: string\): TimedEventStatus \{\s*return normalizeCanceled\(status\) as TimedEventStatus;/);
  // …and the surface feed routes records through it (stored status wins).
  assert.match(engine, /export function toSurfaceEvent\(/);
  assert.match(engine, /event\.status \? normalizeTimedEventStatus\(event\.status\) : deriveStatus\(event, atMs\)/);
});

test('account deletion receipt status is normalized on read', () => {
  const src = readFileSync(`${ROOT}/mobile/src/accountDeletion.ts`, 'utf8');
  assert.match(src, /"completed" \| "canceled"/);
  assert.match(src, /status: normalizeCanceled\(parsed\.status\) as DeletionRequest\["status"\]/);
});

test('event status normalization behavior: legacy stored status surfaces as canceled', () => {
  // Behavioral equivalent of mobile toSurfaceEvent's ingress branch, driven
  // through the real shared mapper the TS code calls.
  const stored = { status: 'cancelled' };
  const normalized = mobile.normalizeCanceled(stored.status);
  assert.equal(normalized, 'canceled');
  // A deletion receipt persisted by an older build reads back canonical.
  const receipt = JSON.parse('{"status":"cancelled","note":"old build"}');
  assert.equal(mobile.normalizeCanceled(receipt.status), 'canceled');
});

test('server emits the canonical wipe outcome and Stripe cancel URLs', () => {
  const server = readFileSync(`${ROOT}/server.js`, 'utf8');
  assert.match(server, /endWipeRequest\(room, 'canceled'\)/);
  assert.doesNotMatch(server, /'cancelled'/);
  const billing = readFileSync(`${ROOT}/server/billing.js`, 'utf8');
  assert.match(billing, /family\?checkout=canceled/);
  assert.doesNotMatch(billing, /checkout=cancelled/);
  const economy = readFileSync(`${ROOT}/server/economy.js`, 'utf8');
  assert.match(economy, /\?drops=canceled/);
  assert.doesNotMatch(economy, /drops=cancelled/);
});

test('supabase schema uses the canonical enum label and ships a rename migration', () => {
  const schema = readFileSync(`${ROOT}/backend/supabase/schema.sql`, 'utf8');
  assert.doesNotMatch(schema, /'cancelled'/);
  assert.equal((schema.match(/'canceled'/g) || []).length, 5);
  const migration = readFileSync(`${ROOT}/backend/supabase/migrations/20261001000000_rename_cancelled_to_canceled.sql`, 'utf8');
  for (const type of ['session_status', 'timed_event_status', 'account_deletion_status']) {
    assert.match(migration, new RegExp(`alter type public\\.${type} rename value 'cancelled' to 'canceled'`), type);
  }
  assert.match(migration, /NOT APPLIED TO PRODUCTION/);
});
