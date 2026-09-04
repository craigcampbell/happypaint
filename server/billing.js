import express from 'express';
import Stripe from 'stripe';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';

const FAMILY_ACTIVE_STATUSES = new Set(['active', 'trialing']);
const NON_TERMINAL_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']);
const MAX_PROCESSED_EVENTS = 2_000;
const CHECKOUT_PENDING_MS = 15 * 60 * 1000;
const CANCELLATION_RETRY_MS = 5 * 60 * 1000;

function cleanOrigin(value) {
  const origin = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(origin) ? origin : 'http://localhost:8787';
}

function cleanProfileId(value) {
  const id = String(value || '').slice(0, 64);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

function cancellationKeyFor(profileId) {
  return createHash('sha256').update(`drawesome-billing-delete:${profileId}`).digest('hex');
}

function periodEnd(subscription) {
  const direct = Number(subscription?.current_period_end) || 0;
  if (direct) return direct;
  const itemEnds = subscription?.items?.data?.map((item) => Number(item.current_period_end) || 0) || [];
  return Math.max(0, ...itemEnds);
}

function subscriptionLine(subscription) {
  const items = subscription?.items?.data || [];
  if (items.length !== 1) return { priceId: null, quantity: 0 };
  return { priceId: items[0]?.price?.id || null, quantity: Number(items[0]?.quantity) || 0 };
}

function trimProcessedEvents(events) {
  return Object.fromEntries(
    Object.entries(events)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, MAX_PROCESSED_EVENTS),
  );
}

function displayAmount(price) {
  if (!Number.isInteger(price?.unit_amount) || !price?.currency) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: String(price.currency).toUpperCase(),
    minimumFractionDigits: price.unit_amount % 100 === 0 ? 0 : 2,
  }).format(price.unit_amount / 100);
}

export function createBilling({ dataDir, verifyAccessToken, onEntitlementChange = null }) {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const prices = {
    monthly: process.env.STRIPE_PRICE_FAMILY_MONTHLY || '',
    yearly: process.env.STRIPE_PRICE_FAMILY_YEARLY || '',
  };
  const approvedPriceIds = new Set(Object.values(prices).filter(Boolean));
  const configuredOrigin = process.env.PUBLIC_ORIGIN || process.env.APP_ORIGIN || '';
  const publicOrigin = cleanOrigin(configuredOrigin);
  const originConfigured = /^https?:\/\//i.test(String(configuredOrigin).trim());
  const pastDueGraceMs = Math.max(0, Number(process.env.STRIPE_PAST_DUE_GRACE_HOURS || 72)) * 60 * 60 * 1000;
  const checkoutEnabled = process.env.STRIPE_CHECKOUT_ENABLED === 'true';
  const allowPromotionCodes = process.env.STRIPE_ALLOW_PROMOTION_CODES === 'true';
  const automaticTax = process.env.STRIPE_AUTOMATIC_TAX === 'true';
  const portalConfiguration = process.env.STRIPE_PORTAL_CONFIGURATION_ID || '';
  const stripe = secretKey ? new Stripe(secretKey, { apiVersion: '2026-02-25.clover' }) : null;
  const file = join(dataDir, '.billing.json');
  let records = {};
  let processedEvents = {};
  let pendingCheckouts = {};
  let cancellations = {};
  let mutationQueue = Promise.resolve();
  const checkoutInflight = new Set();
  const cancellationInflight = new Set();
  let priceCache = { expiresAt: 0, value: null };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    records = parsed?.records && typeof parsed.records === 'object' ? parsed.records : {};
    processedEvents = parsed?.processedEvents && typeof parsed.processedEvents === 'object' ? parsed.processedEvents : {};
    pendingCheckouts = parsed?.pendingCheckouts && typeof parsed.pendingCheckouts === 'object' ? parsed.pendingCheckouts : {};
    cancellations = parsed?.cancellations && typeof parsed.cancellations === 'object' ? parsed.cancellations : {};
  } catch {
    // First boot, disabled billing, or an unreadable legacy file: fail closed.
  }

  function commit(next = {}) {
    const state = {
      version: 2,
      records: next.records || records,
      processedEvents: next.processedEvents || processedEvents,
      pendingCheckouts: next.pendingCheckouts || pendingCheckouts,
      cancellations: next.cancellations || cancellations,
    };
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
      renameSync(temp, file);
    } finally {
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort temp cleanup */ }
    }
    records = state.records;
    processedEvents = state.processedEvents;
    pendingCheckouts = state.pendingCheckouts;
    cancellations = state.cancellations;
  }

  function serializeMutation(fn) {
    const result = mutationQueue.then(fn, fn);
    mutationQueue = result.catch(() => {});
    return result;
  }

  async function identityFrom(req) {
    const auth = req.headers.authorization || '';
    const token = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    if (!token) return null;
    try { return await verifyAccessToken(token); } catch { return null; }
  }

  function findProfileForObject(object) {
    const fromMeta = cleanProfileId(object?.metadata?.profile_id);
    if (fromMeta) return fromMeta;
    const subscriptionId = typeof object?.subscription === 'string'
      ? object.subscription
      : object?.subscription?.id || object?.parent?.subscription_details?.subscription || object?.id;
    const customerId = typeof object?.customer === 'string' ? object.customer : object?.customer?.id;
    return Object.keys(records).find((profileId) =>
      (subscriptionId && records[profileId]?.subscriptionId === subscriptionId) ||
      (customerId && records[profileId]?.customerId === customerId),
    ) || null;
  }

  function recordMatchesFamily(record) {
    return Boolean(record && approvedPriceIds.size > 0 && approvedPriceIds.has(record.priceId) && record.quantity === 1);
  }

  function publicStatus(profileId) {
    const record = records[profileId];
    if (!record) return { active: false, status: 'none', interval: null, renewsAt: null, cancelAtPeriodEnd: false };
    const interval = record.priceId === prices.yearly ? 'yearly' : record.priceId === prices.monthly ? 'monthly' : null;
    const inPastDueGrace = record.status === 'past_due' && Number(record.pastDueSince) > 0 &&
      Date.now() < Number(record.pastDueSince) + pastDueGraceMs;
    return {
      active: recordMatchesFamily(record) && (FAMILY_ACTIVE_STATUSES.has(record.status) || inPastDueGrace),
      status: record.status,
      interval,
      renewsAt: record.currentPeriodEnd ? record.currentPeriodEnd * 1000 : null,
      cancelAtPeriodEnd: !!record.cancelAtPeriodEnd,
      graceEndsAt: inPastDueGrace ? Number(record.pastDueSince) + pastDueGraceMs : null,
    };
  }

  function subscriptionRecord(profileId, subscription, eventCreated) {
    const previous = records[profileId] || {};
    const stripeCreated = Number(eventCreated) || Math.floor(Date.now() / 1000);
    if (Number(previous.lastStripeEventCreated) > stripeCreated) return previous;
    const line = subscriptionLine(subscription);
    const status = subscription.status || 'inactive';
    return {
      profileId,
      customerId: typeof subscription.customer === 'string' ? subscription.customer : previous.customerId || null,
      subscriptionId: subscription.id || previous.subscriptionId || null,
      status,
      priceId: line.priceId,
      quantity: line.quantity,
      currentPeriodEnd: periodEnd(subscription),
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
      pastDueSince: status === 'past_due'
        ? (previous.status === 'past_due' && previous.pastDueSince ? previous.pastDueSince : stripeCreated * 1000)
        : null,
      lastStripeEventCreated: stripeCreated,
      updatedAt: Date.now(),
    };
  }

  function notifyEntitlement(profileId, before) {
    const after = publicStatus(profileId).active;
    if (before === after || typeof onEntitlementChange !== 'function') return;
    try { onEntitlementChange(profileId, after); } catch { /* reconnect repairs room state */ }
  }

  async function latestSubscription(object, eventType) {
    const subscriptionId = typeof object?.subscription === 'string'
      ? object.subscription
      : object?.subscription?.id || object?.parent?.subscription_details?.subscription ||
        (typeof object?.id === 'string' && object.id.startsWith('sub_') ? object.id : null);
    if (!subscriptionId) return null;
    if (eventType === 'customer.subscription.deleted') return object;
    return stripe.subscriptions.retrieve(subscriptionId);
  }

  async function handleWebhook(req, res) {
    if (!stripe || !webhookSecret) return res.status(503).json({ error: 'billing_not_configured' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch (error) {
      return res.status(400).json({ error: 'invalid_signature', detail: error?.message || 'invalid webhook' });
    }
    if (processedEvents[event.id]) return res.json({ received: true, duplicate: true });

    try {
      const object = event.data.object;
      let subscription = null;
      let profileId = null;
      if (event.type === 'checkout.session.completed') {
        profileId = findProfileForObject(object) || cleanProfileId(object.client_reference_id);
        subscription = await latestSubscription(object, event.type);
      } else if (event.type.startsWith('customer.subscription.')) {
        profileId = findProfileForObject(object);
        subscription = await latestSubscription(object, event.type);
      } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
        profileId = findProfileForObject(object);
        subscription = await latestSubscription(object, event.type);
      }

      let before = false;
      const cancellationKey = profileId ? cancellationKeyFor(profileId) : null;
      await serializeMutation(() => {
        before = profileId ? publicStatus(profileId).active : false;
        const nextRecords = { ...records };
        const nextPending = { ...pendingCheckouts };
        const nextCancellations = { ...cancellations };
        if (profileId && subscription) {
          if (nextCancellations[cancellationKey]) {
            nextCancellations[cancellationKey] = {
              ...nextCancellations[cancellationKey],
              subscriptionId: subscription.id || nextCancellations[cancellationKey].subscriptionId || null,
              customerId: typeof subscription.customer === 'string' ? subscription.customer : nextCancellations[cancellationKey].customerId || null,
              nextAttemptAt: Date.now(),
              completedAt: null,
            };
            delete nextRecords[profileId];
          } else {
            nextRecords[profileId] = subscriptionRecord(profileId, subscription, event.created);
          }
          delete nextPending[profileId];
        }
        const nextEvents = trimProcessedEvents({ ...processedEvents, [event.id]: Number(event.created) || Math.floor(Date.now() / 1000) });
        commit({ records: nextRecords, pendingCheckouts: nextPending, cancellations: nextCancellations, processedEvents: nextEvents });
      });
      if (profileId) notifyEntitlement(profileId, before);
      if (cancellationKey && cancellations[cancellationKey]) void attemptCancellation(cancellationKey);
      return res.json({ received: true });
    } catch (error) {
      // Stripe must retry retrieval or persistence failures; never acknowledge
      // an entitlement update that did not durably reach disk.
      console.error('[billing] webhook failed', event.id, event.type, error?.code || error?.type || 'sync_failed');
      return res.status(500).json({ error: 'webhook_failed' });
    }
  }

  function registerWebhook(app) {
    app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);
  }

  function validPrice(price, interval) {
    const expected = interval === 'yearly' ? 'year' : 'month';
    return Boolean(price?.active && price?.currency === 'usd' && price?.type === 'recurring' &&
      price?.recurring?.interval === expected && Number(price?.recurring?.interval_count || 1) === 1 &&
      Number.isInteger(price?.unit_amount) && price.unit_amount > 0);
  }

  async function getPlanConfig() {
    const fallback = {
      configured: false,
      plans: { monthly: false, yearly: false },
      display: { monthly: '$4.99/month', yearly: '$39/year' },
      yearlySavingsPercent: 35,
    };
    if (!stripe || !webhookSecret || !originConfigured) return fallback;
    if (priceCache.value && priceCache.expiresAt > Date.now()) return priceCache.value;
    const fetched = {};
    await Promise.all(Object.entries(prices).map(async ([interval, id]) => {
      if (!id) return;
      try { fetched[interval] = await stripe.prices.retrieve(id); } catch { fetched[interval] = null; }
    }));
    const plans = { monthly: validPrice(fetched.monthly, 'monthly'), yearly: validPrice(fetched.yearly, 'yearly') };
    if (plans.monthly && plans.yearly && fetched.monthly.product !== fetched.yearly.product) {
      plans.monthly = false;
      plans.yearly = false;
    }
    const monthlyAmount = displayAmount(fetched.monthly);
    const yearlyAmount = displayAmount(fetched.yearly);
    const savings = plans.monthly && plans.yearly
      ? Math.max(0, Math.round((1 - fetched.yearly.unit_amount / (fetched.monthly.unit_amount * 12)) * 100))
      : null;
    const value = {
      configured: Boolean(checkoutEnabled && (plans.monthly || plans.yearly)),
      checkoutEnabled,
      plans,
      display: {
        monthly: monthlyAmount ? `${monthlyAmount}/month` : fallback.display.monthly,
        yearly: yearlyAmount ? `${yearlyAmount}/year` : fallback.display.yearly,
      },
      yearlySavingsPercent: savings,
    };
    priceCache = { value, expiresAt: Date.now() + 10 * 60 * 1000 };
    return value;
  }

  async function saveSubscription(profileId, subscription, eventCreated = Math.floor(Date.now() / 1000)) {
    const before = publicStatus(profileId).active;
    await serializeMutation(() => commit({ records: { ...records, [profileId]: subscriptionRecord(profileId, subscription, eventCreated) } }));
    notifyEntitlement(profileId, before);
  }

  function registerRoutes(app) {
    app.get('/api/billing/config', async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      return res.json(await getPlanConfig());
    });

    app.get('/api/billing/me', async (req, res) => {
      const identity = await identityFrom(req);
      if (!identity?.profileId) return res.status(401).json({ error: 'unauthorized' });
      return res.json(publicStatus(identity.profileId));
    });

    app.post('/api/billing/checkout', async (req, res) => {
      if (!stripe || !webhookSecret || !originConfigured || !checkoutEnabled) return res.status(503).json({ error: 'billing_not_configured' });
      const identity = await identityFrom(req);
      const profileId = cleanProfileId(identity?.profileId);
      if (!profileId) return res.status(401).json({ error: 'sign_in_required' });
      if (req.body?.adultConfirmed !== true) return res.status(400).json({ error: 'adult_confirmation_required' });
      if (!['monthly', 'yearly'].includes(req.body?.interval)) return res.status(400).json({ error: 'invalid_interval' });
      const interval = req.body.interval;
      const planConfig = await getPlanConfig();
      if (!planConfig.plans[interval]) return res.status(503).json({ error: 'plan_misconfigured' });
      const price = prices[interval];
      const existing = records[profileId];
      if (existing?.subscriptionId && NON_TERMINAL_STATUSES.has(existing.status)) {
        return res.status(409).json({ error: 'already_subscribed' });
      }
      if (checkoutInflight.has(profileId)) return res.status(409).json({ error: 'checkout_pending' });
      checkoutInflight.add(profileId);

      try {
        if (existing?.customerId) {
          const subscriptions = await stripe.subscriptions.list({ customer: existing.customerId, status: 'all', limit: 20 });
          const live = subscriptions.data.find((subscription) => {
            const line = subscriptionLine(subscription);
            return approvedPriceIds.has(line.priceId) && line.quantity === 1 && NON_TERMINAL_STATUSES.has(subscription.status);
          });
          if (live) {
            await saveSubscription(profileId, live);
            return res.status(409).json({ error: 'already_subscribed' });
          }
        }

        let pending = pendingCheckouts[profileId];
        if (pending && Number(pending.expiresAt) <= Date.now()) {
          await serializeMutation(() => {
            const next = { ...pendingCheckouts };
            delete next[profileId];
            commit({ pendingCheckouts: next });
          });
          pending = null;
        }
        if (pending?.url) return res.json({ url: pending.url });
        if (pending && pending.interval !== interval) return res.status(409).json({ error: 'checkout_pending' });
        if (!pending) {
          pending = {
            interval,
            idempotencyKey: `family-checkout-${randomUUID()}`,
            createdAt: Date.now(),
            expiresAt: Date.now() + CHECKOUT_PENDING_MS,
          };
          await serializeMutation(() => commit({ pendingCheckouts: { ...pendingCheckouts, [profileId]: pending } }));
        }

        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          ...(existing?.customerId ? { customer: existing.customerId } : {}),
          client_reference_id: profileId,
          line_items: [{ price, quantity: 1 }],
          ...(allowPromotionCodes ? { allow_promotion_codes: true } : {}),
          ...(automaticTax ? { automatic_tax: { enabled: true } } : {}),
          success_url: `${publicOrigin}/family?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${publicOrigin}/family?checkout=cancelled`,
          metadata: { profile_id: profileId },
          subscription_data: { metadata: { profile_id: profileId } },
        }, { idempotencyKey: pending.idempotencyKey });
        await serializeMutation(() => commit({
          pendingCheckouts: { ...pendingCheckouts, [profileId]: { ...pending, sessionId: session.id, url: session.url } },
        }));
        return res.json({ url: session.url });
      } catch (error) {
        console.error('[billing] checkout failed', error?.code || error?.type || 'stripe_unavailable');
        return res.status(502).json({ error: 'checkout_failed' });
      } finally {
        checkoutInflight.delete(profileId);
      }
    });

    app.post('/api/billing/portal', async (req, res) => {
      if (!stripe || !originConfigured) return res.status(503).json({ error: 'billing_not_configured' });
      const identity = await identityFrom(req);
      if (!identity?.profileId) return res.status(401).json({ error: 'sign_in_required' });
      const record = records[identity.profileId];
      if (!record?.customerId) return res.status(404).json({ error: 'no_subscription' });
      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: record.customerId,
          return_url: `${publicOrigin}/family`,
          ...(portalConfiguration ? { configuration: portalConfiguration } : {}),
        });
        return res.json({ url: session.url });
      } catch (error) {
        console.error('[billing] portal failed', error?.code || error?.type || 'stripe_unavailable');
        return res.status(502).json({ error: 'portal_failed' });
      }
    });
  }

  async function attemptCancellation(cancellationKey) {
    if (!stripe || cancellationInflight.has(cancellationKey)) return false;
    const job = cancellations[cancellationKey];
    if (!job?.subscriptionId || Number(job.nextAttemptAt) > Date.now()) return false;
    cancellationInflight.add(cancellationKey);
    try {
      try { await stripe.subscriptions.cancel(job.subscriptionId); } catch (error) {
        if (error?.code !== 'resource_missing') throw error;
      }
      await serializeMutation(() => commit({ cancellations: {
        ...cancellations,
        [cancellationKey]: { ...cancellations[cancellationKey], completedAt: Date.now(), nextAttemptAt: null, lastError: null },
      } }));
      return true;
    } catch (error) {
      await serializeMutation(() => {
        const current = cancellations[cancellationKey];
        if (!current) return;
        const attempts = Number(current.attempts || 0) + 1;
        commit({ cancellations: {
          ...cancellations,
          [cancellationKey]: {
            ...current,
            attempts,
            lastError: String(error?.code || error?.type || 'stripe_unavailable').slice(0, 80),
            nextAttemptAt: Date.now() + Math.min(60 * 60 * 1000, CANCELLATION_RETRY_MS * (2 ** Math.min(attempts, 4))),
          },
        } });
      });
      return false;
    } finally {
      cancellationInflight.delete(cancellationKey);
    }
  }

  async function processCancellationQueue() {
    for (const cancellationKey of Object.keys(cancellations)) {
      const job = cancellations[cancellationKey];
      if (job?.completedAt && Number(job.completedAt) < Date.now() - 30 * 24 * 60 * 60 * 1000) {
        await serializeMutation(() => {
          const next = { ...cancellations };
          delete next[cancellationKey];
          commit({ cancellations: next });
        });
      } else if (!job?.completedAt && Number(job?.nextAttemptAt) <= Date.now()) {
        await attemptCancellation(cancellationKey);
      }
    }
  }

  async function cancelAndDeleteProfile(profileId) {
    const cleanId = cleanProfileId(profileId);
    if (!cleanId) return { removed: false, cancelled: false, pending: false };
    const cancellationKey = cancellationKeyFor(cleanId);
    const record = records[cleanId];
    const pending = pendingCheckouts[cleanId];
    if (!record && !pending && !cancellations[cancellationKey]) return { removed: false, cancelled: false, pending: false };
    const before = publicStatus(cleanId).active;
    await serializeMutation(() => {
      const nextRecords = { ...records };
      const nextPending = { ...pendingCheckouts };
      const nextCancellations = { ...cancellations };
      delete nextRecords[cleanId];
      delete nextPending[cleanId];
      if (record?.subscriptionId) {
        nextCancellations[cancellationKey] = {
          subscriptionId: record.subscriptionId,
          customerId: record.customerId || null,
          createdAt: Date.now(),
          nextAttemptAt: Date.now(),
          attempts: 0,
        };
      }
      commit({ records: nextRecords, pendingCheckouts: nextPending, cancellations: nextCancellations });
    });
    notifyEntitlement(cleanId, before);
    if (stripe && pending?.sessionId) {
      try { await stripe.checkout.sessions.expire(pending.sessionId); } catch { /* completed/expired sessions reject safely */ }
    }
    const cancelled = record?.subscriptionId ? await attemptCancellation(cancellationKey) : false;
    return { removed: true, cancelled, pending: Boolean(record?.subscriptionId && !cancelled) };
  }

  const cancellationTimer = setInterval(() => { void processCancellationQueue(); }, CANCELLATION_RETRY_MS);
  cancellationTimer.unref?.();
  const startupRetry = setTimeout(() => { void processCancellationQueue(); }, 1_000);
  startupRetry.unref?.();

  return {
    registerWebhook,
    registerRoutes,
    isProfileEntitled: (profileId) => Boolean(profileId && publicStatus(profileId).active),
    cancelAndDeleteProfile,
    storageFileExists: () => existsSync(file),
  };
}
