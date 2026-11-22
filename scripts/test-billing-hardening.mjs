import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBilling } from '../server/billing.js';

const originalEnv = { ...process.env };
const dataDir = await mkdtemp(join(tmpdir(), 'drawesome-billing-hardening-'));
const badDataDir = await mkdtemp(join(tmpdir(), 'drawesome-billing-bad-catalog-'));
const badPortalDataDir = await mkdtemp(join(tmpdir(), 'drawesome-billing-bad-portal-'));
const legacyDataDir = await mkdtemp(join(tmpdir(), 'drawesome-billing-previous-record-'));
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
process.env.STRIPE_CHECKOUT_ENABLED = 'true';
process.env.PUBLIC_ORIGIN = 'https://drawesome.art';
process.env.STRIPE_ALLOW_PROMOTION_CODES = 'false';
process.env.STRIPE_AUTOMATIC_TAX = 'false';
process.env.STRIPE_PAST_DUE_GRACE_DAYS = '3';
process.env.STRIPE_PAST_DUE_GRACE_HOURS = '72';
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
const invoiceHistory = new Map();
const laterInvoiceLines = new Map();

function familySubscription(id, profileId, customerId, overrides = {}) {
  const sub = {
    id,
    livemode: true,
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
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'latest_invoice')) {
    sub.latest_invoice = {
      id: 'in_' + id, livemode: true, status: 'paid', amount_paid: 299,
      parent: { subscription_details: { subscription: id } },
      lines: { data: [{
        amount: 299, parent: { subscription_item_details: { subscription: id } },
        pricing: { price_details: { price: sub.items.data[0].price.id } },
        period: { start: Math.floor(currentTime / 1000) - 3600, end: sub.current_period_end },
      }] },
    };
  }
  return sub;
}

function makeStripe({ badCatalog = false, badPortal = false, monthlyAmount = 299 } = {}) {
  return {
    prices: {
      async retrieve(id) {
        const monthly = id === 'price_monthly';
        return {
          id,
          active: true,
          currency: 'usd',
          unit_amount: badCatalog ? 1 : (monthly ? monthlyAmount : 1500),
          billing_scheme: 'per_unit',
          recurring: { interval: monthly ? 'month' : 'year', interval_count: 1, usage_type: 'licensed' },
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
    invoices: {
      list: ({ subscription }) => invoiceHistory.get(subscription) || [],
      listLineItems: (id, { starting_after }) => {
        assert.equal(starting_after, 'il_adjustment');
        return laterInvoiceLines.get(id) || [];
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
  const entitlementChanges = [];
  const billing = createBilling({
    dataDir,
    stripeClient: stripe,
    verifyAccessToken: async (token) => ({ profileId: token }),
    now: () => currentTime,
    startMaintenance: false,
    onEntitlementChange: (profileId, active) => entitlementChanges.push({ profileId, active }),
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
  assert.match(lastCheckoutOptions.idempotencyKey, /^drawesome-family-checkout-v2-/);
  assert.equal(billing.isProfilePaidForAiColoring('parent_profile'), false, 'opening checkout cannot fund generation');

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
  const confirmedStatus = await confirmed.json();
  assert.equal(confirmedStatus.active, true, 'return-page confirmation repairs a delayed webhook');
  assert.equal(confirmedStatus.aiColoringPaid, true, 'checkout confirmed the real paid Family line');
  assert.equal(billing.aiColoringPaidUntil('parent_profile'), parentSub.current_period_end * 1000);
  assert.deepEqual(entitlementChanges.at(-1), { profileId: 'parent_profile', active: true });
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
  assert.equal(paid.aiColoringPaid, true);

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
  assert.equal(expired.aiColoringPaid, false);
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
  assert.equal(badStatus.aiColoringPaid, false);

  // A Stripe subscription can be active with a zero-dollar invoice. Its
  // general Family benefits still apply. The separately metered AI needs
  // money received for this particular subscription line and service period.
  for (const [name, alter, allowed] of [
    ['coupon', invoice => { invoice.amount_paid = 0; }, false],
    ['discount', invoice => { invoice.amount_paid = 99; invoice.lines.data[0].discount_amounts = [{ amount: 200 }]; }, true],
    ['other_fee', invoice => { invoice.lines.data[0].discount_amounts = [{ amount: 299 }]; }, false],
    ['off_stripe', invoice => { invoice.amount_paid_off_stripe = invoice.amount_paid; }, false],
    ['test_invoice', invoice => { invoice.livemode = false; }, false],
    ['unknown_invoice_mode', invoice => { delete invoice.livemode; }, false],
    ['unfinished', invoice => { invoice.status = 'open'; }, false],
    ['other_sub', invoice => { invoice.parent.subscription_details.subscription = 'sub_other'; }, false],
    ['other_line', invoice => { invoice.lines.data[0].pricing.price_details.price = 'price_else'; }, false],
    ['prior_month', invoice => { invoice.lines.data[0].period.end = Math.floor(currentTime / 1000) - 1; }, false],
  ]) {
    const sub = familySubscription('sub_' + name, name, 'cus_' + name);
    alter(sub.latest_invoice);
    subscriptions.set(sub.id, sub);
    assert.equal((await sendEvent(appOrigin, event('evt_' + name, 'customer.subscription.updated', sub, 214))).status, 200);
    const status = await fetch(appOrigin + '/api/billing/me', { headers: auth(name) }).then(res => res.json());
    assert.equal(status.aiColoringPaid, allowed, name);
    if (name === 'coupon') assert.equal(status.active, true);
  }
  const trial = familySubscription('sub_trial', 'trial', 'cus_trial', { status: 'trialing' });
  subscriptions.set(trial.id, trial);
  await sendEvent(appOrigin, event('evt_trial', 'customer.subscription.updated', trial, 215));
  assert.equal(billing.isProfilePaidForAiColoring('trial'), false);
  const mode = familySubscription('sub_mode', 'mode', 'cus_mode');
  subscriptions.set(mode.id, mode);
  for (const [index, live] of [true, false, undefined].entries()) {
    mode.livemode = live;
    await sendEvent(appOrigin, event('evt_mode_' + index, 'customer.subscription.updated', mode, 216 + index));
    assert.equal(billing.isProfileEntitled('mode'), true, 'Family supports Stripe test checkout');
    assert.equal(billing.isProfilePaidForAiColoring('mode'), live === true, 'only verified live payments fund AI');
  }
  mode.livemode = true;
  mode.latest_invoice = { status: 'open' };
  await sendEvent(appOrigin, event('evt_mode_rebind', 'customer.subscription.updated', mode, 219));
  assert.equal(billing.isProfilePaidForAiColoring('mode'), false, 'mode change cannot transfer the old proof');
  const actualPayment = familySubscription(mode.id, 'mode', mode.customer).latest_invoice;
  await sendEvent(appOrigin, event('evt_real_payment', 'invoice.paid', actualPayment, 220));
  assert.equal(billing.isProfilePaidForAiColoring('mode'), true, 'signed payment can establish coverage despite a newer unpaid adjustment');

  const graceSub = familySubscription('sub_grace', 'grace_profile', 'cus_grace');
  subscriptions.set(graceSub.id, graceSub);
  await sendEvent(appOrigin, event('evt_grace_paid', 'invoice.paid', {
    customer: 'cus_grace', parent: { subscription_details: { subscription: graceSub.id } },
  }, 220));
  currentTime += 2 * 3600000;
  graceSub.status = 'past_due';
  graceSub.latest_invoice = { status: 'open' };
  await sendEvent(appOrigin, event('evt_grace_due', 'customer.subscription.updated', structuredClone(graceSub), 230));
  const inGrace = await fetch(`${appOrigin}/api/billing/me`, { headers: auth('grace_profile') }).then((res) => res.json());
  assert.equal(inGrace.active, true, 'a previously paid family keeps the configured recovery grace');
  assert.equal(inGrace.aiColoringPaid, false, 'grace cannot spend OpenRouter credits');
  assert.equal(billing.aiColoringPaidUntil('grace_profile'), 0);
  currentTime += 73 * 3600000;
  const beyondGrace = await fetch(`${appOrigin}/api/billing/me`, { headers: auth('grace_profile') }).then((res) => res.json());
  assert.equal(beyondGrace.active, false, 'past-due access ends after the grace window');
  const oldInvoice = familySubscription(graceSub.id, 'grace_profile', 'cus_grace').latest_invoice;
  oldInvoice.lines.data[0].period.end = Math.floor(currentTime / 1000) - 3600;
  graceSub.current_period_end += 30 * 86400;
  await sendEvent(appOrigin, event('evt_grace_late_payment', 'invoice.paid', oldInvoice, 231));
  assert.equal(billing.isProfilePaidForAiColoring('grace_profile'), false, 'old paid webhook cannot pay for a later renewal');
  currentTime -= 75 * 3600000;

  const capturedActive = Promise.withResolvers();
  const resumeOldRead = Promise.withResolvers();
  const retrieve = stripe.subscriptions.retrieve;
  stripe.subscriptions.retrieve = async (id, options) => {
    const result = await retrieve(id, options);
    if (id === parentSub.id && result.status === 'active') {
      capturedActive.resolve();
      await resumeOldRead.promise;
    }
    return result;
  };
  const earlierFetch = sendEvent(appOrigin, event('evt_in_flight', 'customer.subscription.updated', parentSub, 299));
  await capturedActive.promise;
  parentSub.status = 'canceled';
  await sendEvent(appOrigin, event('evt_deleted', 'customer.subscription.deleted', structuredClone(parentSub), 300));
  resumeOldRead.resolve();
  assert.equal((await earlierFetch).status, 200);
  stripe.subscriptions.retrieve = retrieve;
  assert.equal(billing.isProfileEntitled('parent_profile'), false, 'old Stripe read completed after terminal cancellation');
  assert.equal(billing.isProfilePaidForAiColoring('parent_profile'), false);
  const staleActiveSnapshot = { ...structuredClone(parentSub), status: 'active' };
  await sendEvent(appOrigin, event('evt_stale_active', 'customer.subscription.updated', staleActiveSnapshot, 100));
  const afterStale = await fetch(`${appOrigin}/api/billing/me`, { headers: auth('parent_profile') }).then((res) => res.json());
  assert.equal(afterStale.active, false, 'out-of-order active snapshot cannot revive canceled access');
  assert.equal(afterStale.status, 'canceled');
  assert.equal(afterStale.aiColoringPaid, false);
  const newSub = familySubscription('sub_resubscribed', 'parent_profile', 'cus_parent');
  subscriptions.set(newSub.id, newSub);
  await sendEvent(appOrigin, event('evt_resubscribed', 'customer.subscription.created', newSub, 301));
  assert.equal(billing.isProfilePaidForAiColoring('parent_profile'), true, 'a newly paid subscription can restore access');

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
  assert.equal(billing.isProfilePaidForAiColoring('delete_profile'), false);

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

  assert.deepEqual(config.display, { monthly: '$2.99/month', yearly: '$15/year' });
  assert.equal(config.yearlySavingsPercent, 58);
  assert.equal(badConfig.display, null, 'never display an unverified price');

  const oldCatalog = await listen(createBilling({
    dataDir: badDataDir, stripeClient: makeStripe({ monthlyAmount: 199 }),
    verifyAccessToken: async token => ({ profileId: token }), startMaintenance: false,
  }));
  try {
    const legacy = await fetch(`${oldCatalog.origin}/api/billing/config`).then(res => res.json());
    assert.equal(legacy.configured, true, 'previous deployment continues selling its configured rate');
    assert.deepEqual(legacy.display, { monthly: '$1.99/month', yearly: '$15/year' });
    assert.equal(legacy.yearlySavingsPercent, 37);
  } finally { await new Promise(resolve => oldCatalog.httpServer.close(resolve)); }

  const legacyPrice = {
    id: 'price_retired', active: false, product: 'prod_family', currency: 'usd', unit_amount: 199,
    billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  };
  const retiredSub = familySubscription('sub_retired', 'legacy_profile', 'cus_retired', {
    items: { data: [{ quantity: 1, price: legacyPrice }] },
  });
  subscriptions.set(retiredSub.id, retiredSub);
  await sendEvent(appOrigin, event('evt_retired_paid', 'invoice.paid', {
    customer: retiredSub.customer, parent: { subscription_details: { subscription: retiredSub.id } },
  }, 500));
  const grandfathered = await fetch(`${appOrigin}/api/billing/me`, { headers: auth('legacy_profile') }).then(res => res.json());
  assert.equal(grandfathered.active, true, 'renewals at the retired $1.99 rate keep Family access');
  assert.equal(grandfathered.interval, 'monthly');
  assert.equal(grandfathered.aiColoringPaid, true);

  // Version 2 tracked a generic paid-through value without the invoice
  // amount or service dates. Re-read the account's own Stripe invoice history.
  const legacySub = familySubscription('sub_migrate', 'migrate', 'cus_migrate');
  const previousInvoice = legacySub.latest_invoice;
  legacySub.latest_invoice = { status: 'paid', amount_paid: 40, lines: { data: [] } };
  subscriptions.set(legacySub.id, legacySub);
  laterInvoiceLines.set(previousInvoice.id, previousInvoice.lines.data);
  const firstPage = { ...previousInvoice, lines: { has_more: true, data: [{ id: 'il_adjustment' }] } };
  invoiceHistory.set(legacySub.id, [legacySub.latest_invoice, firstPage]);
  await writeFile(join(legacyDataDir, '.billing.json'), JSON.stringify({ version: 2, records: { migrate: {
    profileId: 'migrate', subscriptionId: legacySub.id, customerId: legacySub.customer,
    status: 'active', quantity: 1, familyProductValid: true, priceId: 'price_monthly', currentPeriodEnd: legacySub.current_period_end,
  } } }));
  const reload = () => createBilling({ dataDir: legacyDataDir, stripeClient: stripe, startMaintenance: false,
    aiColoringEnabled: true, verifyAccessToken: async token => ({ profileId: token }), now: () => currentTime });
  const old = reload();
  assert.equal(old.isProfileEntitled('migrate'), true);
  assert.equal(old.isProfilePaidForAiColoring('migrate'), false, 'legacy dates alone cannot buy AI access');
  await old.runMaintenance();
  assert.equal(old.isProfilePaidForAiColoring('migrate'), true, 'prior valid Stripe invoice restores a paid legacy account');
  assert.equal(reload().aiColoringPaidUntil('migrate'), legacySub.current_period_end * 1000);

  console.log('billing hardening integration: ok');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (badServer) await new Promise((resolve) => badServer.close(resolve));
  if (badPortalServer) await new Promise((resolve) => badPortalServer.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
  await rm(badDataDir, { recursive: true, force: true });
  await rm(badPortalDataDir, { recursive: true, force: true });
  await rm(legacyDataDir, { recursive: true, force: true });
  process.env = originalEnv;
}
