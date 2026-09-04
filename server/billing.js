import express from 'express';
import Stripe from 'stripe';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const FAMILY_STATUSES = new Set(['active', 'trialing', 'past_due']);

function cleanOrigin(value) {
  const origin = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(origin) ? origin : 'http://localhost:8787';
}

function periodEnd(subscription) {
  const direct = Number(subscription?.current_period_end) || 0;
  if (direct) return direct;
  const itemEnds = subscription?.items?.data?.map((item) => Number(item.current_period_end) || 0) || [];
  return Math.max(0, ...itemEnds);
}

function priceIdFrom(subscription) {
  return subscription?.items?.data?.[0]?.price?.id || null;
}

export function createBilling({ dataDir, verifyAccessToken }) {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const prices = {
    monthly: process.env.STRIPE_PRICE_FAMILY_MONTHLY || '',
    yearly: process.env.STRIPE_PRICE_FAMILY_YEARLY || '',
  };
  const configuredOrigin = process.env.PUBLIC_ORIGIN || process.env.APP_ORIGIN || '';
  const publicOrigin = cleanOrigin(configuredOrigin);
  const originConfigured = /^https?:\/\//i.test(String(configuredOrigin).trim());
  const stripe = secretKey ? new Stripe(secretKey) : null;
  const file = join(dataDir, '.billing.json');
  let records = {};

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    records = parsed?.records && typeof parsed.records === 'object' ? parsed.records : {};
  } catch {
    records = {};
  }

  function persist() {
    try {
      writeFileSync(file, JSON.stringify({ version: 1, records }, null, 2));
    } catch {
      // Billing webhooks are retried by Stripe. A later delivery can repair a
      // transient disk failure without taking drawing or rooms offline.
    }
  }

  async function identityFrom(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return token ? verifyAccessToken(token) : null;
  }

  function findProfileForObject(object) {
    const fromMeta = String(object?.metadata?.profile_id || '').slice(0, 64);
    if (fromMeta) return fromMeta;
    const subscriptionId = typeof object?.subscription === 'string' ? object.subscription : object?.id;
    const customerId = typeof object?.customer === 'string' ? object.customer : object?.customer?.id;
    return Object.keys(records).find((profileId) =>
      (subscriptionId && records[profileId]?.subscriptionId === subscriptionId) ||
      (customerId && records[profileId]?.customerId === customerId),
    ) || null;
  }

  function syncSubscription(profileId, subscription) {
    if (!profileId || !subscription) return;
    const previous = records[profileId] || {};
    records[profileId] = {
      profileId,
      customerId: typeof subscription.customer === 'string' ? subscription.customer : previous.customerId || null,
      subscriptionId: subscription.id || previous.subscriptionId || null,
      status: subscription.status || 'inactive',
      priceId: priceIdFrom(subscription) || previous.priceId || null,
      currentPeriodEnd: periodEnd(subscription),
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
      updatedAt: Date.now(),
    };
    persist();
  }

  function publicStatus(profileId) {
    const record = records[profileId];
    if (!record) return { active: false, status: 'none', interval: null, renewsAt: null, cancelAtPeriodEnd: false };
    const interval = record.priceId === prices.yearly ? 'yearly' : record.priceId === prices.monthly ? 'monthly' : null;
    return {
      active: FAMILY_STATUSES.has(record.status),
      status: record.status,
      interval,
      renewsAt: record.currentPeriodEnd ? record.currentPeriodEnd * 1000 : null,
      cancelAtPeriodEnd: !!record.cancelAtPeriodEnd,
    };
  }

  async function handleWebhook(req, res) {
    if (!stripe || !webhookSecret) return res.status(503).json({ error: 'billing_not_configured' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch (error) {
      return res.status(400).json({ error: 'invalid_signature', detail: error?.message || 'invalid webhook' });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const profileId = findProfileForObject(session) || String(session.client_reference_id || '').slice(0, 64);
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        if (profileId && subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          syncSubscription(profileId, subscription);
        }
      } else if (event.type.startsWith('customer.subscription.')) {
        const subscription = event.data.object;
        const profileId = findProfileForObject(subscription);
        if (profileId) syncSubscription(profileId, subscription);
      }
      return res.json({ received: true });
    } catch (error) {
      return res.status(500).json({ error: 'webhook_failed', detail: error?.message || 'sync failed' });
    }
  }

  function registerWebhook(app) {
    // Must be registered before the app-wide JSON parser: Stripe verifies the
    // signature against these exact raw bytes.
    app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);
  }

  function registerRoutes(app) {
    app.get('/api/billing/config', (_req, res) => {
      res.json({
        configured: Boolean(stripe && webhookSecret && originConfigured && (prices.monthly || prices.yearly)),
        plans: { monthly: Boolean(prices.monthly), yearly: Boolean(prices.yearly) },
        display: { monthly: '$4.99/month', yearly: '$39/year' },
      });
    });

    app.get('/api/billing/me', async (req, res) => {
      const identity = await identityFrom(req);
      if (!identity?.profileId) return res.status(401).json({ error: 'unauthorized' });
      return res.json(publicStatus(identity.profileId));
    });

    app.post('/api/billing/checkout', async (req, res) => {
      if (!stripe || !webhookSecret || !originConfigured) return res.status(503).json({ error: 'billing_not_configured' });
      const identity = await identityFrom(req);
      if (!identity?.profileId) return res.status(401).json({ error: 'sign_in_required' });
      if (req.body?.adultConfirmed !== true) return res.status(400).json({ error: 'adult_confirmation_required' });
      const interval = req.body?.interval === 'yearly' ? 'yearly' : 'monthly';
      const price = prices[interval];
      if (!price) return res.status(503).json({ error: 'plan_not_configured' });
      const existing = records[identity.profileId];
      if (existing && FAMILY_STATUSES.has(existing.status)) return res.status(409).json({ error: 'already_subscribed' });

      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          ...(existing?.customerId ? { customer: existing.customerId } : {}),
          client_reference_id: identity.profileId,
          line_items: [{ price, quantity: 1 }],
          allow_promotion_codes: true,
          success_url: `${publicOrigin}/family?checkout=success`,
          cancel_url: `${publicOrigin}/family?checkout=cancelled`,
          metadata: { profile_id: identity.profileId },
          subscription_data: { metadata: { profile_id: identity.profileId } },
        });
        return res.json({ url: session.url });
      } catch (error) {
        return res.status(502).json({ error: 'checkout_failed', detail: error?.message || 'Stripe unavailable' });
      }
    });

    app.post('/api/billing/portal', async (req, res) => {
      if (!stripe) return res.status(503).json({ error: 'billing_not_configured' });
      const identity = await identityFrom(req);
      if (!identity?.profileId) return res.status(401).json({ error: 'sign_in_required' });
      const record = records[identity.profileId];
      if (!record?.customerId) return res.status(404).json({ error: 'no_subscription' });
      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: record.customerId,
          return_url: `${publicOrigin}/family`,
        });
        return res.json({ url: session.url });
      } catch (error) {
        return res.status(502).json({ error: 'portal_failed', detail: error?.message || 'Stripe unavailable' });
      }
    });
  }

  async function cancelAndDeleteProfile(profileId) {
    const record = records[profileId];
    if (!record) return { removed: false, cancelled: false };
    let cancelled = false;
    if (stripe && record.subscriptionId && record.status !== 'canceled') {
      try {
        await stripe.subscriptions.cancel(record.subscriptionId);
        cancelled = true;
      } catch {
        // Erasure still removes the local mapping. Stripe also retains its own
        // legally required transaction records independently of this app.
      }
    }
    delete records[profileId];
    persist();
    return { removed: true, cancelled };
  }

  return {
    registerWebhook,
    registerRoutes,
    isProfileEntitled: (profileId) => Boolean(profileId && publicStatus(profileId).active),
    cancelAndDeleteProfile,
    storageFileExists: () => existsSync(file),
  };
}
