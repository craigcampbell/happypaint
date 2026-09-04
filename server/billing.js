import express from 'express';
import Stripe from 'stripe';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';

const BILLING_VERSION = 2;
const STRIPE_API_VERSION = '2026-08-26.dahlia';
const PROCESSED_EVENT_LIMIT = 2048;
const BLOCKING_SUBSCRIPTION_STATUSES = new Set([
  'active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete',
]);
const FAMILY_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
]);
const EXPECTED_PRICES = {
  monthly: { amount: 499, interval: 'month' },
  yearly: { amount: 3900, interval: 'year' },
};

function cleanOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function cleanProfileId(value) {
  const id = String(value || '').slice(0, 64);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

function cleanCheckoutSessionId(value) {
  const id = String(value || '').slice(0, 128);
  return /^cs_[A-Za-z0-9_]{3,125}$/.test(id) ? id : null;
}

function periodEnd(subscription) {
  const direct = Number(subscription?.current_period_end) || 0;
  if (direct) return direct;
  const itemEnds = subscription?.items?.data?.map((item) => Number(item.current_period_end) || 0) || [];
  return Math.max(0, ...itemEnds);
}

function firstItem(subscription) {
  return subscription?.items?.data?.[0] || null;
}

function priceIdFrom(subscription) {
  return firstItem(subscription)?.price?.id || null;
}

function productIdFrom(subscription) {
  const product = firstItem(subscription)?.price?.product;
  return typeof product === 'string' ? product : product?.id || null;
}

function subscriptionIdFromInvoice(invoice) {
  const legacy = invoice?.subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy?.id) return legacy.id;
  const parent = invoice?.parent?.subscription_details?.subscription;
  return typeof parent === 'string' ? parent : parent?.id || null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return { version: BILLING_VERSION, records: {}, processedEvents: {}, pendingCancellations: {}, deletedProfileHashes: {} };
}

function errorCode(error) {
  return String(error?.code || error?.type || error?.message || error?.name || 'stripe_error').slice(0, 80);
}

class BillingHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function createBilling({
  dataDir,
  verifyAccessToken,
  stripeClient = null,
  now = () => Date.now(),
  startMaintenance = true,
}) {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const familyProductId = process.env.STRIPE_PRODUCT_FAMILY || '';
  const portalConfigurationId = process.env.STRIPE_PORTAL_CONFIGURATION_ID || '';
  const prices = {
    monthly: process.env.STRIPE_PRICE_FAMILY_MONTHLY || '',
    yearly: process.env.STRIPE_PRICE_FAMILY_YEARLY || '',
  };
  const publicOrigin = cleanOrigin(process.env.PUBLIC_ORIGIN || process.env.APP_ORIGIN || '');
  const allowPromotionCodes = /^(1|true|yes)$/i.test(process.env.STRIPE_ALLOW_PROMOTION_CODES || '');
  const automaticTax = /^(1|true|yes)$/i.test(process.env.STRIPE_AUTOMATIC_TAX || '');
  const graceDaysValue = Number(process.env.STRIPE_PAST_DUE_GRACE_DAYS);
  const graceDays = Number.isFinite(graceDaysValue) ? graceDaysValue : 3;
  const pastDueGraceMs = Math.max(0, Math.min(14, graceDays)) * 86400000;
  const termsVersion = String(process.env.FAMILY_TERMS_VERSION || '2026-09-04').slice(0, 40);
  const stripe = stripeClient || (secretKey ? new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION }) : null);
  const file = join(dataDir, '.billing.json');
  let state = emptyState();
  let catalogValidation = { checked: false, checkedAt: 0, ok: false, error: null };
  const profileLocks = new Map();
  const rateHits = new Map();

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const records = parsed?.records && typeof parsed.records === 'object' ? parsed.records : {};
    // v1 stored currentPeriodEnd but not paidThrough. Preserve existing paid
    // families during migration; every subsequent Stripe sync validates product.
    for (const record of Object.values(records)) {
      if (!record || typeof record !== 'object') continue;
      if (!Number(record.paidThrough)) record.paidThrough = Number(record.currentPeriodEnd) || 0;
      if (record.familyProductValid == null) record.familyProductValid = true;
    }
    state = {
      version: BILLING_VERSION,
      records,
      processedEvents: parsed?.processedEvents && typeof parsed.processedEvents === 'object' ? parsed.processedEvents : {},
      pendingCancellations: parsed?.pendingCancellations && typeof parsed.pendingCancellations === 'object' ? parsed.pendingCancellations : {},
      deletedProfileHashes: parsed?.deletedProfileHashes && typeof parsed.deletedProfileHashes === 'object' ? parsed.deletedProfileHashes : {},
    };
  } catch {
    state = emptyState();
  }

  function persistState(next) {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let fd = null;
    try {
      fd = openSync(temp, 'w', 0o600);
      writeFileSync(fd, JSON.stringify(next, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, file);
    } catch (error) {
      try { if (fd != null) closeSync(fd); } catch { /* best effort */ }
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  function commit(mutator) {
    const next = clone(state);
    const result = mutator(next);
    next.version = BILLING_VERSION;
    persistState(next);
    state = next;
    return result;
  }

  function rateOk(key, max, windowMs) {
    const at = now();
    const hits = (rateHits.get(key) || []).filter((value) => at - value < windowMs);
    if (hits.length >= max) {
      rateHits.set(key, hits);
      return false;
    }
    hits.push(at);
    rateHits.set(key, hits);
    return true;
  }

  function profileHash(profileId) {
    return createHash('sha256').update(`drawesome-deleted-profile-v1:${profileId}`).digest('hex');
  }

  function markProfileDeleted(draft, profileId) {
    draft.deletedProfileHashes[profileHash(profileId)] = now();
    delete draft.pendingCancellations[profileId];
    delete draft.records[profileId];
  }

  async function withProfileLock(profileId, fn) {
    const prior = profileLocks.get(profileId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = prior.catch(() => {}).then(() => gate);
    profileLocks.set(profileId, queued);
    await prior.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (profileLocks.get(profileId) === queued) profileLocks.delete(profileId);
    }
  }

  async function identityFrom(req) {
    const auth = req.headers.authorization || '';
    const token = /^Bearer /i.test(auth) ? auth.slice(7) : '';
    try {
      return token ? await verifyAccessToken(token) : null;
    } catch {
      return null;
    }
  }

  function findProfileForObject(object, records = state.records) {
    const fromMeta = cleanProfileId(object?.metadata?.profile_id);
    const subscriptionId = typeof object?.subscription === 'string' ? object.subscription : object?.subscription?.id || object?.id;
    const customerId = typeof object?.customer === 'string' ? object.customer : object?.customer?.id;
    const boundProfile = Object.keys(records).find((profileId) =>
      (subscriptionId && records[profileId]?.subscriptionId === subscriptionId) ||
      (customerId && records[profileId]?.customerId === customerId),
    );
    // Once a Stripe object is bound, its durable server-side relationship wins
    // over mutable metadata. Metadata is only the bootstrap link for first sync.
    return boundProfile || fromMeta || null;
  }

  function subscriptionIsFamily(subscription) {
    const item = firstItem(subscription);
    const priceId = priceIdFrom(subscription);
    const productId = productIdFrom(subscription);
    return Boolean(
      item && Number(item.quantity || 1) === 1 &&
      familyProductId && productId === familyProductId &&
      (priceId === prices.monthly || priceId === prices.yearly),
    );
  }

  function latestInvoicePaid(subscription) {
    return subscription?.latest_invoice && typeof subscription.latest_invoice === 'object' && subscription.latest_invoice.status === 'paid';
  }

  function syncSubscriptionDraft(draft, profileId, subscription, options = {}) {
    if (!profileId || !subscription) return false;
    const previous = draft.records[profileId] || {};
    const eventCreated = Number(options.eventCreated) || 0;
    if (!options.freshFromStripe && eventCreated && eventCreated < Number(previous.lastEventCreated || 0)) return false;
    const familyProductValid = subscriptionIsFamily(subscription);
    const end = periodEnd(subscription);
    let paidThrough = Number(previous.paidThrough) || 0;
    if (familyProductValid && (options.invoicePaid || latestInvoicePaid(subscription))) {
      paidThrough = Math.max(paidThrough, end);
    }
    if (!familyProductValid) paidThrough = 0;
    draft.records[profileId] = {
      ...previous,
      profileId,
      customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id || previous.customerId || null,
      subscriptionId: subscription.id || previous.subscriptionId || null,
      status: familyProductValid ? (subscription.status || 'inactive') : 'invalid_product',
      productId: productIdFrom(subscription),
      priceId: priceIdFrom(subscription),
      familyProductValid,
      currentPeriodEnd: end,
      paidThrough,
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
      lastEventCreated: Math.max(eventCreated, Number(previous.lastEventCreated) || 0),
      lastEventId: options.eventId || previous.lastEventId || null,
      updatedAt: now(),
    };
    delete draft.records[profileId].pendingCheckout;
    return true;
  }

  function publicStatus(profileId) {
    const record = state.records[profileId];
    if (!record) return { active: false, status: 'none', interval: null, renewsAt: null, cancelAtPeriodEnd: false, manageable: false };
    const at = now();
    const paidThroughMs = (Number(record.paidThrough) || 0) * 1000;
    const active = record.familyProductValid !== false && (
      (record.status === 'active' && paidThroughMs > at) ||
      (record.status === 'past_due' && paidThroughMs + pastDueGraceMs > at)
    );
    const interval = record.priceId === prices.yearly ? 'yearly' : record.priceId === prices.monthly ? 'monthly' : null;
    return {
      active,
      status: record.status || 'none',
      interval,
      renewsAt: paidThroughMs || null,
      cancelAtPeriodEnd: !!record.cancelAtPeriodEnd,
      manageable: Boolean(record.customerId && record.subscriptionId && !['canceled', 'incomplete_expired'].includes(record.status)),
    };
  }

  function baseConfigured() {
    return Boolean(
      stripe && webhookSecret && publicOrigin && familyProductId && portalConfigurationId &&
      prices.monthly && prices.yearly,
    );
  }

  async function ensureCatalogValidated() {
    if (!baseConfigured()) return false;
    if (catalogValidation.checked && (catalogValidation.ok || now() - catalogValidation.checkedAt < 5 * 60000)) {
      return catalogValidation.ok;
    }
    try {
      for (const [interval, priceId] of Object.entries(prices)) {
        const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
        const expected = EXPECTED_PRICES[interval];
        const productId = typeof price.product === 'string' ? price.product : price.product?.id;
        if (
          price.active !== true || price.currency !== 'usd' || Number(price.unit_amount) !== expected.amount ||
          price.recurring?.interval !== expected.interval || productId !== familyProductId ||
          (typeof price.product === 'object' && price.product.active === false)
        ) {
          throw new Error(`invalid_${interval}_price`);
        }
      }
      const portal = await stripe.billingPortal.configurations.retrieve(portalConfigurationId);
      const features = portal.features || {};
      if (
        portal.active !== true ||
        features.payment_method_update?.enabled !== true ||
        features.subscription_cancel?.enabled !== true ||
        features.subscription_cancel?.mode !== 'at_period_end'
      ) {
        throw new Error('invalid_portal_configuration');
      }
      if (features.subscription_update?.enabled) {
        const products = features.subscription_update.products || [];
        const configuredProduct = products.length === 1 ? products[0] : null;
        const configuredPrices = new Set(configuredProduct?.prices || []);
        if (
          configuredProduct?.product !== familyProductId ||
          configuredPrices.size !== 2 ||
          !configuredPrices.has(prices.monthly) ||
          !configuredPrices.has(prices.yearly) ||
          configuredProduct.adjustable_quantity?.enabled === true
        ) {
          throw new Error('unsafe_portal_products');
        }
      }
      catalogValidation = { checked: true, checkedAt: now(), ok: true, error: null };
    } catch (error) {
      catalogValidation = { checked: true, checkedAt: now(), ok: false, error: errorCode(error) };
      console.error('[billing] Stripe catalog validation failed:', errorCode(error));
    }
    return catalogValidation.ok;
  }

  async function getOperationalStatus() {
    const configured = await ensureCatalogValidated();
    const anyConfiguration = Boolean(
      secretKey || webhookSecret || familyProductId || portalConfigurationId ||
      prices.monthly || prices.yearly,
    );
    const profiles = Object.keys(state.records);
    const statuses = profiles.map((profileId) => publicStatus(profileId));
    const processedAt = Object.values(state.processedEvents)
      .map((value) => Number(value) || 0)
      .filter(Boolean);
    return {
      mode: configured ? 'ready' : anyConfiguration ? 'misconfigured' : 'disabled',
      configured,
      validationError: configured ? null : catalogValidation.error,
      activeFamilies: statuses.filter((status) => status.active).length,
      needsAttention: statuses.filter((status) => status.manageable && !status.active).length,
      cancelAtPeriodEnd: statuses.filter((status) => status.cancelAtPeriodEnd).length,
      pendingCheckouts: profiles.filter((profileId) => state.records[profileId]?.pendingCheckout).length,
      pendingCancellations: Object.keys(state.pendingCancellations).length,
      processedEvents: processedAt.length,
      lastStripeEventAt: processedAt.length ? Math.max(...processedAt) * 1000 : null,
    };
  }

  async function retrieveSubscription(subscriptionId) {
    return stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.product', 'latest_invoice'],
    });
  }

  function markProcessed(draft, event) {
    draft.processedEvents[event.id] = Number(event.created) || Math.floor(now() / 1000);
    const ids = Object.keys(draft.processedEvents);
    if (ids.length > PROCESSED_EVENT_LIMIT) {
      ids.sort((a, b) => draft.processedEvents[a] - draft.processedEvents[b]);
      ids.slice(0, ids.length - PROCESSED_EVENT_LIMIT).forEach((id) => delete draft.processedEvents[id]);
    }
  }

  async function resolveEvent(event) {
    const object = event.data.object;
    let profileId = findProfileForObject(object);
    let subscriptionId = null;
    let invoicePaid = false;

    if (event.type.startsWith('checkout.session.')) {
      profileId = profileId || cleanProfileId(object.client_reference_id);
      subscriptionId = typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
    } else if (event.type.startsWith('customer.subscription.')) {
      subscriptionId = object.id;
      profileId = profileId || findProfileForObject(object);
    } else if (event.type.startsWith('invoice.')) {
      subscriptionId = subscriptionIdFromInvoice(object);
      invoicePaid = event.type === 'invoice.paid';
    }

    if (!subscriptionId) return { profileId, subscription: null, invoicePaid, freshFromStripe: false };
    try {
      const subscription = await retrieveSubscription(subscriptionId);
      profileId = profileId || findProfileForObject(subscription);
      return { profileId, subscription, invoicePaid, freshFromStripe: true };
    } catch (error) {
      if (event.type === 'customer.subscription.deleted') {
        profileId = profileId || findProfileForObject(object);
        return { profileId, subscription: object, invoicePaid: false, freshFromStripe: false };
      }
      throw error;
    }
  }

  async function handleWebhook(req, res) {
    if (!stripe || !webhookSecret) return res.status(503).json({ error: 'billing_not_configured' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch {
      return res.status(400).json({ error: 'invalid_signature' });
    }
    if (!event?.id || !event?.type) return res.status(400).json({ error: 'invalid_event' });
    if (state.processedEvents[event.id]) return res.json({ received: true, duplicate: true });

    try {
      if (!FAMILY_EVENT_TYPES.has(event.type)) {
        commit((draft) => markProcessed(draft, event));
        return res.json({ received: true, ignored: true });
      }
      const resolved = await resolveEvent(event);
      commit((draft) => {
        if (draft.processedEvents[event.id]) return;
        if (resolved.profileId && resolved.subscription) {
          const deleted = draft.deletedProfileHashes[profileHash(resolved.profileId)];
          const cancellationPending = draft.pendingCancellations[resolved.profileId];
          if (deleted) {
            // A late Stripe retry must never recreate a profile mapping after
            // account erasure. The one-way hash is retained only for this gate.
          } else if (cancellationPending && resolved.subscription.status === 'canceled') {
            markProfileDeleted(draft, resolved.profileId);
          } else if (!cancellationPending) {
            syncSubscriptionDraft(draft, resolved.profileId, resolved.subscription, {
              eventCreated: event.created,
              eventId: event.id,
              invoicePaid: resolved.invoicePaid,
              freshFromStripe: resolved.freshFromStripe,
            });
          }
        }
        markProcessed(draft, event);
      });
      return res.json({ received: true });
    } catch (error) {
      console.error('[billing] Webhook processing failed:', event.id, errorCode(error));
      return res.status(500).json({ error: 'webhook_failed' });
    }
  }

  function registerWebhook(app) {
    // Must be registered before the app-wide JSON parser: Stripe verifies the
    // signature against these exact raw bytes.
    app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);
  }

  function customerIdempotencyKey(profileId) {
    const hash = createHash('sha256').update(profileId).digest('hex').slice(0, 32);
    return `drawesome-family-customer-v1-${hash}`;
  }

  async function findBlockingSubscription(customerId) {
    const listed = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
    for (const candidate of listed.data || []) {
      if (!BLOCKING_SUBSCRIPTION_STATUSES.has(candidate.status)) continue;
      const subscription = await retrieveSubscription(candidate.id);
      if (subscriptionIsFamily(subscription)) return subscription;
    }
    return null;
  }

  async function getOrCreateCustomer(profileId) {
    const existing = state.records[profileId];
    if (existing?.customerId) return existing.customerId;
    if (typeof stripe.customers.search === 'function') {
      const found = await stripe.customers.search({
        query: `metadata['profile_id']:'${profileId}'`,
        limit: 2,
      });
      if (found.data?.[0]?.id) {
        commit((draft) => {
          const previous = draft.records[profileId] || {};
          draft.records[profileId] = {
            ...previous,
            profileId,
            customerId: found.data[0].id,
            status: previous.status || 'none',
            updatedAt: now(),
          };
        });
        return found.data[0].id;
      }
    }
    const customer = await stripe.customers.create(
      { metadata: { profile_id: profileId } },
      { idempotencyKey: customerIdempotencyKey(profileId) },
    );
    commit((draft) => {
      const previous = draft.records[profileId] || {};
      draft.records[profileId] = {
        ...previous,
        profileId,
        customerId: customer.id,
        status: previous.status || 'none',
        updatedAt: now(),
      };
    });
    return customer.id;
  }

  function recordTermsAcceptance(profileId) {
    commit((draft) => {
      const previous = draft.records[profileId] || {};
      draft.records[profileId] = {
        ...previous,
        profileId,
        adultTermsVersion: termsVersion,
        adultTermsAcceptedAt: now(),
        updatedAt: now(),
      };
    });
  }

  function registerRoutes(app) {
    app.get('/api/billing/config', async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      const configured = await ensureCatalogValidated();
      res.json({
        configured,
        plans: { monthly: configured, yearly: configured },
        display: { monthly: '$4.99/month', yearly: '$39/year' },
        termsVersion,
      });
    });

    app.get('/api/billing/me', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const identity = await identityFrom(req);
      if (!identity?.profileId) return res.status(401).json({ error: 'unauthorized' });
      return res.json(publicStatus(identity.profileId));
    });

    app.post('/api/billing/checkout', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!(await ensureCatalogValidated())) return res.status(503).json({ error: 'billing_not_configured' });
      const identity = await identityFrom(req);
      const profileId = cleanProfileId(identity?.profileId);
      if (!profileId) return res.status(401).json({ error: 'sign_in_required' });
      if (!rateOk(`checkout:${profileId}`, 6, 60000)) return res.status(429).json({ error: 'slow_down' });
      if (req.body?.adultConfirmed !== true || req.body?.termsVersion !== termsVersion) {
        return res.status(400).json({ error: 'adult_confirmation_required' });
      }
      const interval = req.body?.interval === 'yearly' ? 'yearly' : 'monthly';
      const price = prices[interval];

      try {
        const result = await withProfileLock(profileId, async () => {
          if (state.deletedProfileHashes[profileHash(profileId)]) {
            throw new BillingHttpError(410, 'account_deleted');
          }
          recordTermsAcceptance(profileId);
          const customerId = await getOrCreateCustomer(profileId);
          const blocking = await findBlockingSubscription(customerId);
          if (blocking) {
            commit((draft) => syncSubscriptionDraft(draft, profileId, blocking, { freshFromStripe: true }));
            throw new BillingHttpError(409, 'subscription_exists');
          }

          const record = state.records[profileId] || {};
          let pending = record.pendingCheckout;
          if (pending?.sessionId && Number(pending.expiresAtMs) > now()) {
            const existingSession = await stripe.checkout.sessions.retrieve(pending.sessionId);
            if (existingSession.status === 'open' && pending.priceId === price && existingSession.url) {
              return { url: existingSession.url };
            }
            if (existingSession.subscription) {
              const subscriptionId = typeof existingSession.subscription === 'string' ? existingSession.subscription : existingSession.subscription.id;
              const subscription = await retrieveSubscription(subscriptionId);
              commit((draft) => syncSubscriptionDraft(draft, profileId, subscription, { freshFromStripe: true }));
              throw new BillingHttpError(409, 'subscription_exists');
            }
            if (existingSession.status === 'open' && pending.priceId !== price) {
              await stripe.checkout.sessions.expire(existingSession.id);
            }
            commit((draft) => { delete draft.records[profileId].pendingCheckout; });
            pending = null;
          }
          if (pending && pending.priceId !== price && Number(pending.expiresAtMs) > now()) {
            throw new BillingHttpError(409, 'checkout_in_progress');
          }
          if (pending && Number(pending.expiresAtMs) <= now()) {
            commit((draft) => { delete draft.records[profileId].pendingCheckout; });
            pending = null;
          }

          const idempotencyKey = pending?.priceId === price && pending?.idempotencyKey
            ? pending.idempotencyKey
            : `drawesome-family-checkout-v1-${randomUUID()}`;
          commit((draft) => {
            const previous = draft.records[profileId] || {};
            draft.records[profileId] = {
              ...previous,
              pendingCheckout: {
                priceId: price,
                interval,
                idempotencyKey,
                createdAt: now(),
                expiresAtMs: now() + 24 * 3600000,
              },
            };
          });

          const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            client_reference_id: profileId,
            line_items: [{ price, quantity: 1 }],
            allow_promotion_codes: allowPromotionCodes,
            automatic_tax: { enabled: automaticTax },
            ...(automaticTax ? { customer_update: { address: 'auto' } } : {}),
            success_url: `${publicOrigin}/family?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${publicOrigin}/family?checkout=cancelled`,
            metadata: { profile_id: profileId },
            subscription_data: {
              metadata: { profile_id: profileId },
              billing_mode: { type: 'flexible' },
            },
          }, { idempotencyKey });
          if (!session.url) throw new Error('checkout_session_missing_url');
          commit((draft) => {
            const previous = draft.records[profileId] || {};
            draft.records[profileId] = {
              ...previous,
              pendingCheckout: {
                ...previous.pendingCheckout,
                sessionId: session.id,
                url: session.url,
                expiresAtMs: Number(session.expires_at) ? session.expires_at * 1000 : now() + 24 * 3600000,
              },
              updatedAt: now(),
            };
          });
          return { url: session.url };
        });
        return res.json(result);
      } catch (error) {
        if (error instanceof BillingHttpError) return res.status(error.status).json({ error: error.code });
        console.error('[billing] Checkout creation failed:', errorCode(error));
        return res.status(502).json({ error: 'checkout_failed' });
      }
    });

    app.post('/api/billing/checkout/confirm', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!(await ensureCatalogValidated())) return res.status(503).json({ error: 'billing_not_configured' });
      const identity = await identityFrom(req);
      const profileId = cleanProfileId(identity?.profileId);
      if (!profileId) return res.status(401).json({ error: 'sign_in_required' });
      if (!rateOk(`confirm:${profileId}`, 12, 60000)) return res.status(429).json({ error: 'slow_down' });
      const sessionId = cleanCheckoutSessionId(req.body?.sessionId);
      if (!sessionId) return res.status(400).json({ error: 'invalid_checkout_session' });

      try {
        const status = await withProfileLock(profileId, async () => {
          if (state.deletedProfileHashes[profileHash(profileId)]) {
            throw new BillingHttpError(410, 'account_deleted');
          }
          if (state.pendingCancellations[profileId]) {
            throw new BillingHttpError(409, 'account_deletion_pending');
          }

          const session = await stripe.checkout.sessions.retrieve(sessionId);
          if (!session?.id) throw new BillingHttpError(404, 'checkout_session_not_found');
          const sessionProfileId = cleanProfileId(session.client_reference_id) || cleanProfileId(session.metadata?.profile_id);
          if (sessionProfileId !== profileId) throw new BillingHttpError(403, 'checkout_session_not_owned');

          const record = state.records[profileId] || {};
          const sessionCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
          if (record.customerId && (!sessionCustomerId || sessionCustomerId !== record.customerId)) {
            throw new BillingHttpError(403, 'checkout_session_not_owned');
          }
          if (session.status !== 'complete') throw new BillingHttpError(409, 'checkout_not_complete');

          const subscriptionId = typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
          if (!subscriptionId) throw new BillingHttpError(409, 'subscription_pending');
          const subscription = await retrieveSubscription(subscriptionId);
          const subscriptionCustomerId = typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id;
          if (!sessionCustomerId || subscriptionCustomerId !== sessionCustomerId) {
            throw new BillingHttpError(403, 'checkout_session_not_owned');
          }

          commit((draft) => syncSubscriptionDraft(draft, profileId, subscription, { freshFromStripe: true }));
          return publicStatus(profileId);
        });
        return res.json(status);
      } catch (error) {
        if (error instanceof BillingHttpError) return res.status(error.status).json({ error: error.code });
        if (error?.code === 'resource_missing') return res.status(404).json({ error: 'checkout_session_not_found' });
        console.error('[billing] Checkout confirmation failed:', errorCode(error));
        return res.status(502).json({ error: 'checkout_confirmation_failed' });
      }
    });

    app.post('/api/billing/portal', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!(await ensureCatalogValidated())) return res.status(503).json({ error: 'billing_not_configured' });
      const identity = await identityFrom(req);
      const profileId = cleanProfileId(identity?.profileId);
      if (!profileId) return res.status(401).json({ error: 'sign_in_required' });
      if (!rateOk(`portal:${profileId}`, 12, 60000)) return res.status(429).json({ error: 'slow_down' });
      const record = state.records[profileId];
      if (!record?.customerId) return res.status(404).json({ error: 'no_subscription' });
      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: record.customerId,
          configuration: portalConfigurationId,
          return_url: `${publicOrigin}/family`,
        });
        return res.json({ url: session.url });
      } catch (error) {
        console.error('[billing] Portal creation failed:', errorCode(error));
        return res.status(502).json({ error: 'portal_failed' });
      }
    });
  }

  async function retryCancellation(profileId, pending) {
    if (!stripe) return false;
    let current = { ...pending };
    try {
      const subscriptionIds = new Set([
        ...(Array.isArray(current.subscriptionIds) ? current.subscriptionIds : []),
        ...(current.subscriptionId ? [current.subscriptionId] : []),
      ]);
      const customerIds = new Set(current.customerId ? [current.customerId] : []);
      if (current.checkoutSessionId) {
        try {
          const session = await stripe.checkout.sessions.retrieve(current.checkoutSessionId);
          if (session.status === 'open') await stripe.checkout.sessions.expire(session.id);
          const sessionSubscriptionId = typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
          if (sessionSubscriptionId) subscriptionIds.add(sessionSubscriptionId);
        } catch (error) {
          if (error?.code !== 'resource_missing') throw error;
        }
        current.checkoutSessionId = null;
      }

      // Search by the server-authenticated profile metadata as well as the
      // locally stored customer. This catches an old duplicate subscription or
      // a locally lost mapping before erasing the account that could manage it.
      if (typeof stripe.customers.search === 'function') {
        const found = await stripe.customers.search({
          query: `metadata['profile_id']:'${profileId}'`,
          limit: 20,
        });
        for (const customer of found.data || []) customerIds.add(customer.id);
      }
      for (const customerId of customerIds) {
        const listed = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
        for (const candidate of listed.data || []) {
          if (['canceled', 'incomplete_expired'].includes(candidate.status)) continue;
          const subscription = await retrieveSubscription(candidate.id);
          if (subscriptionIsFamily(subscription)) subscriptionIds.add(subscription.id);
        }
      }
      current.subscriptionIds = [...subscriptionIds];
      current.subscriptionId = current.subscriptionIds[0] || null;
      for (const subscriptionId of current.subscriptionIds) {
        try {
          await stripe.subscriptions.cancel(subscriptionId);
        } catch (error) {
          if (error?.code !== 'resource_missing') throw error;
        }
      }
      commit((draft) => {
        markProfileDeleted(draft, profileId);
      });
      return true;
    } catch (error) {
      commit((draft) => {
        const saved = draft.pendingCancellations[profileId] || current;
        draft.pendingCancellations[profileId] = {
          ...saved,
          ...current,
          attempts: Number(saved.attempts || 0) + 1,
          lastAttemptAt: now(),
          lastError: errorCode(error),
        };
      });
      return false;
    }
  }

  async function cancelAndDeleteProfile(profileIdValue) {
    const profileId = cleanProfileId(profileIdValue);
    if (!profileId) return { removed: false, cancelled: false, pending: false };
    return withProfileLock(profileId, async () => {
      const record = state.records[profileId];
      if (!record && !stripe) return { removed: false, cancelled: false, pending: false };
      if (!record) {
        const lookupPending = {
          customerId: null,
          subscriptionId: null,
          subscriptionIds: [],
          checkoutSessionId: null,
          requestedAt: now(),
          attempts: 0,
        };
        commit((draft) => {
          draft.records[profileId] = {
            profileId,
            status: 'cancellation_pending',
            paidThrough: 0,
            updatedAt: now(),
          };
          draft.pendingCancellations[profileId] = lookupPending;
        });
        const cancelled = await retryCancellation(profileId, lookupPending);
        return { removed: cancelled, cancelled, pending: !cancelled };
      }
      const checkoutSessionId = record.pendingCheckout?.sessionId || null;
      if ((!record.subscriptionId || record.status === 'canceled') && !checkoutSessionId) {
        commit((draft) => {
          markProfileDeleted(draft, profileId);
        });
        return { removed: true, cancelled: record.status === 'canceled', pending: false };
      }

      const pending = {
        customerId: record.customerId || null,
        subscriptionId: record.status === 'canceled' ? null : record.subscriptionId || null,
        subscriptionIds: record.status === 'canceled' || !record.subscriptionId ? [] : [record.subscriptionId],
        checkoutSessionId,
        requestedAt: now(),
        attempts: 0,
      };
      // Revoke access and durably retain the cancellation target before calling
      // Stripe. Account deletion may proceed because retries no longer need PB.
      commit((draft) => {
        draft.records[profileId] = {
          ...draft.records[profileId],
          status: 'cancellation_pending',
          paidThrough: 0,
          updatedAt: now(),
        };
        draft.pendingCancellations[profileId] = pending;
      });
      const cancelled = await retryCancellation(profileId, pending);
      return { removed: cancelled, cancelled, pending: !cancelled };
    });
  }

  async function runMaintenance() {
    const tombstoneCutoff = now() - 90 * 86400000;
    if (Object.values(state.deletedProfileHashes).some((value) => Number(value) < tombstoneCutoff)) {
      commit((draft) => {
        for (const [hash, deletedAt] of Object.entries(draft.deletedProfileHashes)) {
          if (Number(deletedAt) < tombstoneCutoff) delete draft.deletedProfileHashes[hash];
        }
      });
    }
    for (const [profileId, pending] of Object.entries(clone(state.pendingCancellations))) {
      await withProfileLock(profileId, () => retryCancellation(profileId, pending));
    }
    if (!stripe || !(await ensureCatalogValidated())) return;
    for (const [profileId, record] of Object.entries(clone(state.records))) {
      if (!record.subscriptionId || state.pendingCancellations[profileId]) continue;
      try {
        const subscription = await retrieveSubscription(record.subscriptionId);
        commit((draft) => syncSubscriptionDraft(draft, profileId, subscription, { freshFromStripe: true }));
      } catch (error) {
        console.error('[billing] Subscription reconciliation failed:', profileId, errorCode(error));
      }
    }
  }

  if (startMaintenance) {
    setTimeout(() => { runMaintenance().catch(() => {}); }, 5000).unref?.();
    setInterval(() => { runMaintenance().catch(() => {}); }, 30 * 60000).unref?.();
  }

  return {
    registerWebhook,
    registerRoutes,
    isProfileEntitled: (profileId) => Boolean(profileId && publicStatus(profileId).active),
    getOperationalStatus,
    cancelAndDeleteProfile,
    runMaintenance,
    storageFileExists: () => existsSync(file),
  };
}
