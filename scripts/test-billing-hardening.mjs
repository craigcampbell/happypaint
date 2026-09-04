import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBilling } from '../server/billing.js';

const originalEnv = { ...process.env };
const dataDir = await mkdtemp(join(tmpdir(), 'drawesome-billing-hardening-'));
const badDataDir = await mkdtemp(join(tmpdir(), 'drawesome-billing-bad-catalog-'));
const badPortalDataDir = await mkdtemp(join(tmpdir(), 'drawesome-billing-bad-portal-'));
let server;
let badServer;
let badPortalServer;
let appOrigin;

process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.STRIPE_PRODUCT_FAMILY = 'prod_family';
process.env.STRIPE_PRICE_FAMILY_MONTHLY = 'price_monthly';
process.env.STRIPE_PRICE_FAMILY_YEARLY = 'price_yearly';
process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_family';
process.env.PUBLIC_ORIGIN = 'https://drawesome.art';
process.env.STRIPE_ALLOW_PROMOTION_CODES = 'false';
process.env.STRIPE_AUTOMATIC_TAX = 'false';
process.env.STRIPE_PAST_DUE_GRACE_DAYS = '3';
process.env.FAMILY_TERMS_VERSION = 'test-terms-v1';

let currentTime = Date.UTC(2026, 8, 4, 12, 0, 0);
let customerCreates = 0;
let checkoutCreates = 0;
let checkoutExpires = 0;
let subscriptionRetrieves = 0;
let cancellationCalls = 0;
let failCancellation = true;
let lastCheckoutParams;
let lastCheckoutOptions;
let lastPortalParams;
const subscriptions = new Map();
const sessions = new Map();
const customersByProfile = new Map();

function familySubscription(id, profileId, customerId, overrides = {}) {
  return {
    id,
    customer: customerId,
    status: 'active',
    current_period_end: Math.floor(currentTime / 1000) + 3600,
    cancel_at_period_end: false,
    metadata: { profile_id: profileId },
    items: {
      data: [{
        quantity: 1,
        current_period_end: Math.floor(currentTime / 1000) + 3600,
        price: { id: 'price_monthly', product: { id: 'prod_family', active: true } },
      }],
    },
    latest_invoice: { status: 'paid' },
    ...overrides,
  };
}

function makeStripe({ badCatalog = false, badPortal = false } = {}) {
  return {
    prices: {
      async retrieve(id) {
        const monthly = id === 'price_monthly';
        return {
          id,
          active: true,
          currency: 'usd',
          unit_amount: badCatalog ? 1 : (monthly ? 499 : 3900),
          recurring: { interval: monthly ? 'month' : 'year' },
          product: { id: 'prod_family', active: true },
        };
      },
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 'valid' || secret !== 'whsec_mock') throw new Error('bad signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
    customers: {
      async search({ query }) {
        const profileId = /:'([^']+)'$/.exec(query)?.[1];
        const customerId = customersByProfile.get(profileId);
        return { data: customerId ? [{ id: customerId }] : [] };
      },
      async create(params, options) {
        customerCreates += 1;
        assert.match(options.idempotencyKey, /^drawesome-family-customer-v1-/);
        const id = `cus_${params.metadata.profile_id.replace(/_profile$/, '')}`;
        customersByProfile.set(params.metadata.profile_id, id);
        return { id };
      },
    },
    subscriptions: {
      async list({ customer }) {
        return { data: [...subscriptions.values()].filter((sub) => sub.customer === customer) };
      },
      async retrieve(id) {
        subscriptionRetrieves += 1;
        const subscription = subscriptions.get(id);
        if (!subscription) {
          const error = new Error('missing');
          error.code = 'resource_missing';
          throw error;
        }
        return structuredClone(subscription);
      },
      async cancel(id) {
        cancellationCalls += 1;
        if (failCancellation) throw new Error('temporary Stripe outage');
        const subscription = subscriptions.get(id);
        if (!subscription) {
          const error = new Error('missing');
          error.code = 'resource_missing';
          throw error;
        }
        subscription.status = 'canceled';
        return structuredClone(subscription);
      },
    },
    checkout: {
      sessions: {
        async create(params, options) {
          checkoutCreates += 1;
          lastCheckoutParams = params;
          lastCheckoutOptions = options;
          await new Promise((resolve) => setTimeout(resolve, 30));
          const session = {
            id: `cs_${params.client_reference_id}`,
            status: 'open',
            url: `https://checkout.stripe.test/${params.client_reference_id}`,
            expires_at: Math.floor(currentTime / 1000) + 86400,
            client_reference_id: params.client_reference_id,
            customer: params.customer,
            metadata: params.metadata,
          };
          sessions.set(session.id, session);
          return structuredClone(session);
        },
        async retrieve(id) {
          return structuredClone(sessions.get(id));
        },
        async expire(id) {
          checkoutExpires += 1;
          const session = sessions.get(id);
          session.status = 'expired';
          return structuredClone(session);
        },
      },
    },
    billingPortal: {
      configurations: {
        async retrieve() {
          return {
            active: true,
            features: {
              payment_method_update: { enabled: true },
              subscription_cancel: { enabled: true, mode: badPortal ? 'immediately' : 'at_period_end' },
              subscription_update: {
                enabled: true,
                products: [{
                  product: 'prod_family',
                  prices: ['price_monthly', 'price_yearly'],
                  adjustable_quantity: { enabled: false },
                }],
              },
            },
          };
        },
      },
      sessions: {
        async create(params) {
          lastPortalParams = params;
          return { url: 'https://billing.stripe.test/portal' };
        },
      },
    },
  };
}

async function listen(billing) {
  const app = express();
  billing.registerWebhook(app);
  app.use(express.json());
  billing.registerRoutes(app);
  const httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return { httpServer, origin: `http://127.0.0.1:${httpServer.address().port}` };
}

function auth(profileId) {
  return { Authorization: `Bearer ${profileId}` };
}

async function postJson(origin, path, profileId, body = {}) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { ...auth(profileId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendEvent(origin, event, signature = 'valid') {
  return fetch(`${origin}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: JSON.stringify(event),
  });
}

function event(id, type, object, created) {
  return { id, type, created, data: { object } };
}

try {
  const stripe = makeStripe();
  const billing = createBilling({
    dataDir,
    stripeClient: stripe,
    verifyAccessToken: async (token) => ({ profileId: token }),
    now: () => currentTime,
    startMaintenance: false,
  });
  ({ httpServer: server, origin: appOrigin } = await listen(billing));

  const config = await fetch(`${appOrigin}/api/billing/config`).then((res) => res.json());
  assert.equal(config.configured, true);
  assert.equal(config.termsVersion, 'test-terms-v1');

  const missingTerms = await postJson(appOrigin, '/api/billing/checkout', 'parent_profile', {
    interval: 'monthly', adultConfirmed: true, termsVersion: 'stale',
  });
  assert.equal(missingTerms.status, 400, 'server rejects stale/missing adult terms');

  const checkoutBody = { interval: 'monthly', adultConfirmed: true, termsVersion: 'test-terms-v1' };
  const [checkoutA, checkoutB] = await Promise.all([
    postJson(appOrigin, '/api/billing/checkout', 'parent_profile', checkoutBody),
    postJson(appOrigin, '/api/billing/checkout', 'parent_profile', checkoutBody),
  ]);
  assert.equal(checkoutA.status, 200);
  assert.equal(checkoutB.status, 200);
  assert.equal(customerCreates, 1, 'concurrent checkout reuses one customer');
  assert.equal(checkoutCreates, 1, 'concurrent checkout reuses one session');
  assert.equal((await checkoutA.json()).url, (await checkoutB.json()).url);
  assert.equal(lastCheckoutParams.customer, 'cus_parent');
  assert.deepEqual(lastCheckoutParams.subscription_data.billing_mode, { type: 'flexible' });
  assert.match(lastCheckoutParams.success_url, /\{CHECKOUT_SESSION_ID\}/);
  assert.equal(lastCheckoutParams.allow_promotion_codes, false);
  assert.match(lastCheckoutOptions.idempotencyKey, /^drawesome-family-checkout-v1-/);

  const changedPlan = await postJson(appOrigin, '/api/billing/checkout', 'parent_profile', {
    interval: 'yearly', adultConfirmed: true, termsVersion: 'test-terms-v1',
  });
  assert.equal(changedPlan.status, 200);
  assert.equal(checkoutExpires, 1, 'switching plan expires the prior open session');
  assert.equal(checkoutCreates, 2, 'switching plan creates one fresh session');

  const parentSub = familySubscription('sub_parent', 'parent_profile', 'cus_parent');
  subscriptions.set(parentSub.id, parentSub);
  Object.assign(sessions.get('cs_parent_profile'), {
    status: 'complete',
    payment_status: 'paid',
    subscription: parentSub.id,
  });
  const wrongOwner = await postJson(appOrigin, '/api/billing/checkout/confirm', 'other_profile', {
    sessionId: 'cs_parent_profile',
  });
  assert.equal(wrongOwner.status, 403, 'a Checkout Session cannot be claimed by another profile');
  const confirmed = await postJson(appOrigin, '/api/billing/checkout/confirm', 'parent_profile', {
    sessionId: 'cs_parent_profile',
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).active, true, 'return-page confirmation repairs a delayed webhook');
  const operational = await billing.getOperationalStatus();
  assert.equal(operational.mode, 'ready');
  assert.equal(operational.activeFamilies, 1);
  assert.equal(operational.pendingCheckouts, 0);

  const paidEvent = event('evt_paid', 'invoice.paid', {
    customer: 'cus_parent',
    parent: { subscription_details: { subscription: 'sub_parent' } },
  }, 200);
  assert.equal((await sendEvent(appOrigin, paidEvent)).status, 200);
  const paid = await fetch(`${appOrigin}/api/billing/me`, { headers: auth('parent_profile') }).then((res) => res.json());
  assert.equal(paid.active, true, 'invoice.paid grants paid-through access');

  const retrievesBeforeDuplicate = subscriptionRetrieves;
  const duplicate = await sendEvent(appOrigin, paidEvent);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(subscriptionRetrieves, retrievesBeforeDuplicate, 'duplicate event does no Stripe work');

  const portal = await postJson(appOrigin, '/api/billing/portal', 'parent_profile');
  assert.equal(portal.status, 200);
  assert.equal(lastPortalParams.configuration, 'bpc_family', 'portal uses dedicated configuration');

  currentTime += 2 * 3600000;
  const expired = await fetch(`${appOrigin}/api/billing/me`, { headers: auth('parent_profile') }).then((res) => res.json());
  assert.equal(expired.active, false, 'status alone never outlives paid-through');
  currentTime -= 2 * 3600000;

  const badSub = familySubscription('sub_bad', 'bad_profile', 'cus_bad', {
    items: { data: [{ quantity: 1, price: { id: 'price_other', product: { id: 'prod_other', active: true } } }] },
  });
  subscriptions.set(badSub.id, badSub);
  await sendEvent(appOrigin, event('evt_bad_product', 'invoice.paid', {
    customer: 'cus_bad', parent: { subscription_details: { subscription: 'sub_bad' } },
  }, 210));
  const badStatus = await fetch(`${appOrigin}/api/billing/me`, { headers: auth('bad_profile') }).then((res) => res.json());
  assert.equal(badStatus.active, false, 'wrong product/price never grants Family');
  assert.equal(badStatus.status, 'invalid_product');

  parentSub.status = 'canceled';
  await sendEvent(appOrigin, event('evt_deleted', 'customer.subscription.deleted', structuredClone(parentSub), 300));
  parentSub.status = 'canceled';
  const staleActiveSnapshot = { ...structuredClone(parentSub), status: 'active' };
  await sendEvent(appOrigin, event('evt_stale_active', 'customer.subscription.updated', staleActiveSnapshot, 100));
  const afterStale = await fetch(`${appOrigin}/api/billing/me`, { headers: auth('parent_profile') }).then((res) => res.json());
  assert.equal(afterStale.active, false, 'out-of-order active snapshot cannot revive canceled access');
  assert.equal(afterStale.status, 'canceled');

  const deleteSub = familySubscription('sub_delete', 'delete_profile', 'cus_delete');
  const duplicateDeleteSub = familySubscription('sub_delete_duplicate', 'delete_profile', 'cus_delete');
  subscriptions.set(deleteSub.id, deleteSub);
  subscriptions.set(duplicateDeleteSub.id, duplicateDeleteSub);
  await sendEvent(appOrigin, event('evt_delete_paid', 'invoice.paid', {
    customer: 'cus_delete', parent: { subscription_details: { subscription: 'sub_delete' } },
  }, 400));
  assert.equal(billing.isProfileEntitled('delete_profile'), true);
  const deletion = await billing.cancelAndDeleteProfile('delete_profile');
  assert.equal(deletion.pending, true, 'failed cancellation is retained for retry');
  assert.equal(billing.isProfileEntitled('delete_profile'), false, 'pending deletion revokes access');

  await sendEvent(appOrigin, event('evt_delete_race', 'invoice.paid', {
    customer: 'cus_delete', parent: { subscription_details: { subscription: 'sub_delete' } },
  }, 410));
  assert.equal(billing.isProfileEntitled('delete_profile'), false, 'webhook race cannot undo deletion');
  let stored = JSON.parse(await readFile(join(dataDir, '.billing.json'), 'utf8'));
  assert.equal(stored.pendingCancellations.delete_profile.subscriptionId, 'sub_delete');

  failCancellation = false;
  await billing.runMaintenance();
  stored = JSON.parse(await readFile(join(dataDir, '.billing.json'), 'utf8'));
  assert.equal(stored.records.delete_profile, undefined);
  assert.equal(stored.pendingCancellations.delete_profile, undefined);
  assert.equal(cancellationCalls, 3, 'maintenance retries and cancels every duplicate Family subscription');
  assert.equal(subscriptions.get('sub_delete_duplicate').status, 'canceled');
  await sendEvent(appOrigin, event('evt_after_erasure', 'customer.subscription.deleted', deleteSub, 420));
  stored = JSON.parse(await readFile(join(dataDir, '.billing.json'), 'utf8'));
  assert.equal(stored.records.delete_profile, undefined, 'late webhooks cannot recreate erased profile mappings');
  assert.equal((await readdir(dataDir)).some((name) => name.endsWith('.tmp')), false, 'atomic temp files are cleaned');

  const openCheckout = await postJson(appOrigin, '/api/billing/checkout', 'checkout_delete_profile', checkoutBody);
  assert.equal(openCheckout.status, 200);
  const checkoutDeletion = await billing.cancelAndDeleteProfile('checkout_delete_profile');
  assert.equal(checkoutDeletion.removed, true, 'account deletion safely expires an open Checkout Session');
  assert.equal(checkoutExpires, 2);

  const freeDeletion = await billing.cancelAndDeleteProfile('free_delete_profile');
  assert.equal(freeDeletion.removed, true, 'configured billing confirms no Stripe subscription before free-account erasure');

  customersByProfile.set('lost_profile', 'cus_lost');
  subscriptions.set('sub_lost', familySubscription('sub_lost', 'lost_profile', 'cus_lost'));
  const lostMappingDeletion = await billing.cancelAndDeleteProfile('lost_profile');
  assert.equal(lostMappingDeletion.removed, true, 'Stripe metadata recovers a lost local mapping during erasure');
  assert.equal(subscriptions.get('sub_lost').status, 'canceled');

  const invalidSignature = await sendEvent(appOrigin, paidEvent, 'invalid');
  assert.equal(invalidSignature.status, 400);
  assert.deepEqual(await invalidSignature.json(), { error: 'invalid_signature' });

  const badCatalogBilling = createBilling({
    dataDir: badDataDir,
    stripeClient: makeStripe({ badCatalog: true }),
    verifyAccessToken: async (token) => ({ profileId: token }),
    now: () => currentTime,
    startMaintenance: false,
  });
  const bad = await listen(badCatalogBilling);
  badServer = bad.httpServer;
  const badConfig = await fetch(`${bad.origin}/api/billing/config`).then((res) => res.json());
  assert.equal(badConfig.configured, false, 'catalog mismatch fails checkout closed');
  assert.equal((await badCatalogBilling.getOperationalStatus()).mode, 'misconfigured');

  const badPortalBilling = createBilling({
    dataDir: badPortalDataDir,
    stripeClient: makeStripe({ badPortal: true }),
    verifyAccessToken: async (token) => ({ profileId: token }),
    now: () => currentTime,
    startMaintenance: false,
  });
  const unsafePortal = await listen(badPortalBilling);
  badPortalServer = unsafePortal.httpServer;
  const badPortalConfig = await fetch(`${unsafePortal.origin}/api/billing/config`).then((res) => res.json());
  assert.equal(badPortalConfig.configured, false, 'unsafe portal cancellation settings fail checkout closed');

  console.log('billing hardening integration: ok');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (badServer) await new Promise((resolve) => badServer.close(resolve));
  if (badPortalServer) await new Promise((resolve) => badPortalServer.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
  await rm(badDataDir, { recursive: true, force: true });
  await rm(badPortalDataDir, { recursive: true, force: true });
  process.env = originalEnv;
}
