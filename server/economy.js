// Drawesome economy — SERVER-AUTHORITATIVE wallet + append-only ledger.
//
// Why this file exists
// -------------------
// The original economy was a purely client-side mock: balances lived in the
// browser's IndexedDB (`happypaint:economy:v1`, see src/utils/economy.js) and the
// ledger was projected in the tab. That is fine for a cosmetic play-money counter
// and fatal for money: any user can open devtools and mint a balance. Real
// purchases and any future payout must be backed by a balance the user cannot
// edit, so the authoritative copy lives here and the client becomes a view of it.
//
// Balances are a PROJECTION of an append-only ledger, never a mutable number —
// the same invariant the documented backend schema uses
// (backend/supabase/schema.sql:1121 "Balances are cached projections of the
// append-only ledger. No user-to-user currency transfer.").
//
// PROVENANCE IS THE POINT
// -----------------------
// Drops are fungible inside the wallet, but a payout may only ever be funded by
// money that actually arrived. Drops are therefore earned two ways:
//
//   * BOUGHT  — a verified Stripe payment (source "drop_purchase", paid: true)
//   * EARNED  — painting (1 Drop per completed stroke, throttled to one per 4s)
//               and quest missions (source "paint_earn" / "quest_earn", paid: false)
//
// `paidDrops` is projected separately from `drops` and is the ONLY balance a
// payout may draw on. Without that split, painting would be a money printer:
// ~900 Drops/hour at the throttle costs the painter nothing, so cashing them out
// would drain real money nobody ever paid in. This is why provenance, not the
// earn throttle, is what makes cash-out safe.
//
// Scope of THIS module: purchases (safe, revenue in) are fully wired. Payouts
// (money out) are modeled, priced and readable, but hard-gated behind
// ECONOMY_PAYOUTS_ENABLED + a Stripe Connect account, and default OFF. The
// documented phase plan (docs/paint-economy.md §Creator Earnings) requires
// verified adults, tax info and guardian gates before money goes out; that is a
// deliberate policy switch, not a flag to flip in a refactor.

import express from 'express';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

const ECONOMY_VERSION = 1;
// Must match server/billing.js — one Stripe SDK version across the process.
const STRIPE_API_VERSION = '2026-08-26.dahlia';

// ---- Catalog (must mirror src/utils/economy.js REAL_DROP_PRODUCTS) ---------
// price_cents is authoritative HERE: the client may display it but never supply
// it. A checkout session is built from this table, so a tampered client cannot
// buy 1,000 Drops for $0.01.
export const DROP_PRODUCTS = [
  { id: 'drops_80', sku: 'drawesome.drops.80', drop_amount: 80, price_cents: 99, active: true },
  { id: 'drops_450', sku: 'drawesome.drops.450', drop_amount: 450, price_cents: 499, active: true },
  { id: 'drops_1000', sku: 'drawesome.drops.1000', drop_amount: 1000, price_cents: 999, active: true },
  { id: 'drops_2200', sku: 'drawesome.drops.2200', drop_amount: 2200, price_cents: 1999, active: true },
];

// Spendable catalog. Prices are authoritative here for the same reason.
export const STORE_ITEMS = [
  { id: 'creator-brushes', title: 'Creator Brushes', price_drops: 150, grants: 'studio' },
  { id: 'neon-arcade-stickers', title: 'Neon Arcade Stickers', price_drops: 120, grants: null },
  { id: 'room-theme-glow', title: 'Glow Room Theme', price_drops: 180, grants: null },
  { id: 'storage-block', title: 'Extra Storage Block', price_drops: 300, grants: null },
];

export const TIP_PRESETS = [10, 25, 50, 100];

// ---- Payout pricing --------------------------------------------------------
// Payout is funded by real money only. At the mid pack rate 1,000 Drops = $9.99
// retail; after Stripe processing (~2.9% + 30c = $0.59 on a $9.99 charge) and a
// 30% platform fee, a creator's share is ~$6.58, i.e. 0.65c per Drop. Rounded
// to 65 cents per 100 Drops for legibility. Retune in one place.
const PAYOUT_CENTS_PER_100_DROPS = Number(process.env.ECONOMY_PAYOUT_CENTS_PER_100_DROPS || 65);
const PAYOUT_MIN_DROPS = Number(process.env.ECONOMY_PAYOUT_MIN_DROPS || 5000); // ~$32.50
// Annual earnings above this need a 1099 (US). Payouts are held past it until tax
// info is on file — enforced by the (disabled) payout path.
const TAX_REPORTING_CENTS = Number(process.env.ECONOMY_TAX_REPORTING_CENTS || 60000);

// Every ledger entry is one of these. Kept as a closed set so a typo cannot
// silently create an unprojectable balance.
const SOURCE = {
  purchase: 'drop_purchase',
  paint: 'paint_earn',
  quest: 'quest_earn',
  store: 'store_purchase',
  tipOut: 'tip_sent',
  tipIn: 'tip_received',
  refund: 'purchase_refund',
  adjust: 'admin_adjustment',
};

const CURRENCY = { drops: 'drops', kudos: 'kudos', creator: 'creator' };

const MAX_WALLETS = Number(process.env.ECONOMY_MAX_WALLETS || 5000);
const LEDGER_PER_WALLET_CAP = Number(process.env.ECONOMY_LEDGER_CAP || 500);
const PAINT_EARN_MIN_MS = 4000; // mirrors the client throttle (one Drop / 4s)
const EARN_MAX_PER_REQUEST = 5;
const RATE_WINDOW_MS = 60000;
const RATE_MAX_WRITES = Number(process.env.ECONOMY_RATE_MAX_WRITES || 120);

export function createEconomy({
  dataDir,
  resolveOwner,           // async (req) => ownerKey | null (null = 401)
  resolveOwnerOptional,   // async (req) => ownerKey | null (null = anonymous)
  stripeClient = null,
  now = () => Date.now(),
}) {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const publicOrigin = String(process.env.PUBLIC_ORIGIN || process.env.APP_ORIGIN || '').replace(/\/+$/, '');
  const purchasesEnabled = /^(1|true|yes)$/i.test(process.env.STRIPE_CHECKOUT_ENABLED || '');
  // Money OUT. Deliberately separate from purchases so buying Drops can be live
  // while payouts stay shut (docs/paint-economy.md §Phase 1).
  const payoutsEnabled = /^(1|true|yes)$/i.test(process.env.ECONOMY_PAYOUTS_ENABLED || '');
  const stripe = stripeClient || (secretKey ? new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION }) : null);

  const file = join(dataDir, '.economy.json');
  let state = { version: ECONOMY_VERSION, wallets: {}, receipts: {} };
  const rateHits = new Map();
  const saveLocks = new Map();

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      state = {
        version: ECONOMY_VERSION,
        wallets: parsed.wallets && typeof parsed.wallets === 'object' ? parsed.wallets : {},
        // receiptId -> ownerKey. Makes crediting idempotent: Stripe retries
        // webhooks, and a double credit would be free Drops.
        receipts: parsed.receipts && typeof parsed.receipts === 'object' ? parsed.receipts : {},
      };
    }
  } catch {
    state = { version: ECONOMY_VERSION, wallets: {}, receipts: {} };
  }

  function persist(next) {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let fd = null;
    try {
      fd = openSync(temp, 'w', 0o600);
      writeFileSync(fd, JSON.stringify(next));
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

  // Owner keys are client-supplied (anonymous device keys) or token-derived, so a
  // key like "__proto__" must never reach a bracket assignment on a plain object
  // — that would set the prototype rather than a wallet.
  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  function walletFor(ownerKey, create = true) {
    if (typeof ownerKey !== 'string' || !ownerKey || DANGEROUS_KEYS.has(ownerKey)) return null;
    let wallet = state.wallets[ownerKey];
    if (wallet) return wallet;
    if (!create) return null;
    // Device keys are client-chosen, so wallet creation is a disk-write primitive
    // an anonymous caller can drive. Cap the population and refuse new wallets
    // past it rather than letting a flood grow the file without bound.
    if (Object.keys(state.wallets).length >= MAX_WALLETS) return null;
    wallet = { ownerKey, createdAt: now(), lastSeen: now(), ledger: [], owned: [], entitlements: [], lastPaintEarnAt: 0, questReceipts: [] };
    state.wallets[ownerKey] = wallet;
    return wallet;
  }

  // Balances are derived, never stored — the ledger is the only truth, so a
  // partial write can never leave a balance that disagrees with its history.
  function project(wallet) {
    const b = { drops: 0, paidDrops: 0, kudos: 0, creator: 0, locked: 0 };
    for (const e of wallet.ledger) {
      const sign = e.direction === 'credit' ? 1 : -1;
      const amt = sign * e.amount;
      if (e.currency === CURRENCY.drops) {
        b.drops += amt;
        // Only paid Drops are convertible. Earned Drops spend the same, but can
        // never become cash.
        if (e.paid) b.paidDrops += amt;
      } else if (e.currency === CURRENCY.kudos) {
        b.kudos += amt;
      } else if (e.currency === CURRENCY.creator) {
        b.creator += amt;
        b.locked += amt;
      }
    }
    // payoutableDrops is bounded by BOTH the creator balance received and the
    // paid Drops that funded it. A tip paid with paint-earned Drops adds creator
    // balance but no payoutable value — that asymmetry is the anti-farming rule.
    b.payoutableDrops = Math.max(0, Math.min(b.creator, wallet.payoutableDrops || 0));
    b.payoutableCents = Math.floor((b.payoutableDrops * PAYOUT_CENTS_PER_100_DROPS) / 100);
    return b;
  }

  function entry(currency, direction, amount, source, sourceId = null, paid = false) {
    return { id: randomUUID(), at: now(), currency, direction, amount: Math.round(amount), source, sourceId, paid };
  }

  function append(wallet, entries) {
    const clean = entries.filter(Boolean);
    if (!clean.length) return wallet;
    wallet.ledger = [...clean, ...wallet.ledger].slice(0, LEDGER_PER_WALLET_CAP);
    wallet.lastSeen = now();
    return wallet;
  }

  function rateLimited(ownerKey) {
    const t = now();
    const hits = (rateHits.get(ownerKey) || []).filter((h) => t - h < RATE_WINDOW_MS);
    if (hits.length >= RATE_MAX_WRITES) return true;
    hits.push(t);
    rateHits.set(ownerKey, hits);
    return false;
  }

  function save() {
    const snapshot = { version: ECONOMY_VERSION, wallets: state.wallets, receipts: state.receipts };
    persist(snapshot);
  }

  // Serialize writes per owner: two concurrent requests must not both observe
  // the same pre-write balance and each pass an affordability check.
  async function withLock(ownerKey, fn) {
    const prior = saveLocks.get(ownerKey) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    saveLocks.set(ownerKey, prior.then(() => gate));
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (saveLocks.get(ownerKey) === prior.then(() => gate)) saveLocks.delete(ownerKey);
    }
  }

  function publicWallet(ownerKey) {
    const wallet = walletFor(ownerKey, false);
    if (!wallet) {
      return {
        balances: { drops: 0, paidDrops: 0, kudos: 0, creator: 0, locked: 0, payoutableDrops: 0, payoutableCents: 0 },
        owned: [], entitlements: [], ledger: [],
      };
    }
    return {
      balances: project(wallet),
      owned: wallet.owned,
      entitlements: wallet.entitlements,
      ledger: wallet.ledger.slice(0, 50).map((e) => ({
        id: e.id, at: e.at, currency: e.currency, direction: e.direction, amount: e.amount, source: e.source, paid: !!e.paid,
      })),
    };
  }

  // ---- money in -----------------------------------------------------------

  // Credit a verified purchase. Idempotent on the Stripe receipt id, because
  // webhooks are retried and a double credit is free money.
  function creditPurchase(ownerKey, product, receiptId) {
    if (state.receipts[receiptId]) return { ok: false, reason: 'duplicate' };
    const wallet = walletFor(ownerKey);
    if (!wallet) return { ok: false, reason: 'capacity' };
    state.receipts[receiptId] = ownerKey;
    append(wallet, [entry(CURRENCY.drops, 'credit', product.drop_amount, SOURCE.purchase, receiptId, true)]);
    save();
    return { ok: true };
  }

  function refundPurchase(receiptId) {
    const ownerKey = state.receipts[receiptId];
    if (!ownerKey) return { ok: false, reason: 'unknown_receipt' };
    const wallet = walletFor(ownerKey, false);
    if (!wallet) return { ok: false, reason: 'no_wallet' };
    const credited = wallet.ledger.find((e) => e.source === SOURCE.purchase && e.sourceId === receiptId);
    if (!credited) return { ok: false, reason: 'not_credited' };
    if (wallet.ledger.some((e) => e.source === SOURCE.refund && e.sourceId === receiptId)) {
      return { ok: false, reason: 'already_refunded' };
    }
    // Claw back the exact credited amount. A refund can drive `drops` negative
    // if the Drops were already spent, which is correct: the platform is out the
    // money and the debt is real. It is visible as a negative balance.
    append(wallet, [entry(CURRENCY.drops, 'debit', credited.amount, SOURCE.refund, receiptId, true)]);
    save();
    return { ok: true };
  }

  // ---- spending -----------------------------------------------------------

  function buyStoreItem(ownerKey, itemId) {
    const item = STORE_ITEMS.find((i) => i.id === itemId);
    if (!item) return { ok: false, reason: 'unknown_item' };
    const wallet = walletFor(ownerKey);
    if (!wallet) return { ok: false, reason: 'capacity' };
    if (wallet.owned.includes(item.id)) return { ok: false, reason: 'owned' };
    const balances = project(wallet);
    if (balances.drops < item.price_drops) return { ok: false, reason: 'insufficient' };
    append(wallet, [entry(CURRENCY.drops, 'debit', item.price_drops, SOURCE.store, item.id, false)]);
    wallet.owned = [...wallet.owned, item.id];
    if (item.grants && !wallet.entitlements.includes(item.grants)) {
      wallet.entitlements = [...wallet.entitlements, item.grants];
    }
    save();
    return { ok: true, item: item.id };
  }

  // Tip a creator. The sender's Drops are debited and the receiver's creator
  // balance credited. Payoutable value is added ONLY in proportion to how much of
  // the spend was funded by paid Drops — see the anti-farming note in project().
  function sendTip(fromOwner, toOwner, amount, sourceId = null) {
    const amt = Math.round(Number(amount) || 0);
    if (!TIP_PRESETS.includes(amt)) return { ok: false, reason: 'bad_amount' };
    if (!toOwner || toOwner === fromOwner) return { ok: false, reason: 'bad_recipient' };
    const sender = walletFor(fromOwner);
    const receiver = walletFor(toOwner);
    if (!sender || !receiver) return { ok: false, reason: 'capacity' };
    if (project(sender).drops < amt) return { ok: false, reason: 'insufficient' };

    const sendBal = project(sender);
    // Spend paid Drops first: a tip is only backed by real money up to the paid
    // Drops still held. Once only earned Drops remain, a tip spends them but
    // carries no payoutable value.
    const paidAvailable = Math.max(0, sendBal.paidDrops);
    const paidPortion = Math.min(paidAvailable, amt);

    append(sender, [entry(CURRENCY.drops, 'debit', amt, SOURCE.tipOut, sourceId, false)]);
    append(receiver, [
      { ...entry(CURRENCY.creator, 'credit', amt, SOURCE.tipIn, sourceId, false) },
    ]);
    receiver.payoutableDrops = (receiver.payoutableDrops || 0) + paidPortion;
    save();
    return { ok: true, cashBacked: paidPortion };
  }

  // ---- earning (never payoutable) ----------------------------------------

  function earnFromPainting(ownerKey, amount = 1) {
    const wallet = walletFor(ownerKey);
    if (!wallet) return { ok: false, reason: 'capacity' };
    const t = now();
    if (t - (wallet.lastPaintEarnAt || 0) < PAINT_EARN_MIN_MS) return { ok: false, reason: 'throttled' };
    const amt = Math.max(1, Math.min(EARN_MAX_PER_REQUEST, Math.round(Number(amount) || 1)));
    wallet.lastPaintEarnAt = t;
    append(wallet, [entry(CURRENCY.drops, 'credit', amt, SOURCE.paint, null, false)]);
    save();
    return { ok: true, credited: amt };
  }

  function earnFromQuest(ownerKey, questKey, amount = 3) {
    const wallet = walletFor(ownerKey);
    if (!wallet) return { ok: false, reason: 'capacity' };
    if (!questKey || wallet.questReceipts.includes(questKey)) return { ok: false, reason: 'duplicate' };
    const amt = Math.max(1, Math.min(5, Math.round(Number(amount) || 3)));
    wallet.questReceipts = [questKey, ...wallet.questReceipts].slice(0, 50);
    append(wallet, [entry(CURRENCY.drops, 'credit', amt, SOURCE.quest, questKey, false)]);
    save();
    return { ok: true, credited: amt };
  }

  // ---- routes -------------------------------------------------------------

  // Must be registered BEFORE the app-wide JSON parser: Stripe verifies the
  // signature against these exact raw bytes, and express.json() would consume
  // them first (body-parser sets req._body, so a later express.raw() no-ops and
  // req.body would be a parsed object, not the Buffer the SDK needs). Mirrors
  // server/billing.js registerWebhook — that ordering is why the two are split.
  function registerWebhook(app) {
    app.post('/api/economy/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
      if (!stripe || !webhookSecret) return res.status(503).json({ error: 'not_configured' });
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret);
      } catch (error) {
        return res.status(400).json({ error: 'bad_signature' });
      }
      try {
        const type = event.type;
        const object = event.data && event.data.object ? event.data.object : {};
        if (type === 'checkout.session.completed') {
          const meta = object.metadata || {};
          const product = DROP_PRODUCTS.find((p) => p.id === meta.productId);
          const ownerKey = String(meta.ownerKey || '');
          // A paid session is the receipt. Never trust an unpaid one, and never
          // credit a product id that is not in the authoritative catalog.
          if (product && ownerKey && object.payment_status === 'paid') {
            creditPurchase(ownerKey, product, String(object.id));
          }
        } else if (type === 'charge.refunded' || type === 'refund.created') {
          const receipt = String((object.metadata && object.metadata.sessionId) || object.payment_intent || '');
          if (receipt) refundPurchase(receipt);
        }
        res.json({ received: true });
      } catch {
        res.status(500).json({ error: 'webhook_failed' });
      }
    });
  }

  function registerRoutes(app) {
    app.get('/api/economy/config', (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        purchasesEnabled: purchasesEnabled && Boolean(secretKey),
        payoutsEnabled,
        dropProducts: DROP_PRODUCTS.filter((p) => p.active).map((p) => ({
          id: p.id, drop_amount: p.drop_amount, price_cents: p.price_cents,
        })),
        storeItems: STORE_ITEMS,
        tipPresets: TIP_PRESETS,
        payout: {
          centsPer100Drops: PAYOUT_CENTS_PER_100_DROPS,
          minDrops: PAYOUT_MIN_DROPS,
          taxReportingCents: TAX_REPORTING_CENTS,
        },
      });
    });

    app.get('/api/economy/wallet', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const owner = await resolveOwnerOptional(req);
      if (!owner) return res.json(publicWallet(''));
      res.json(publicWallet(owner));
    });

    app.post('/api/economy/earn', async (req, res) => {
      const owner = await resolveOwner(req);
      if (!owner) return res.status(401).json({ error: 'auth_required' });
      if (rateLimited(owner)) return res.status(429).json({ error: 'rate_limited' });
      const kind = String((req.body && req.body.kind) || 'paint');
      const result = kind === 'quest'
        ? earnFromQuest(owner, String(req.body.questKey || ''), req.body.amount)
        : earnFromPainting(owner, req.body && req.body.amount);
      return res.status(result.ok ? 200 : 200).json({ ...result, wallet: publicWallet(owner) });
    });

    app.post('/api/economy/store/purchase', async (req, res) => {
      const owner = await resolveOwner(req);
      if (!owner) return res.status(401).json({ error: 'auth_required' });
      if (rateLimited(owner)) return res.status(429).json({ error: 'rate_limited' });
      const itemId = String((req.body && req.body.itemId) || '');
      const result = await withLock(owner, async () => buyStoreItem(owner, itemId));
      return res.status(result.ok ? 200 : 400).json({ ...result, wallet: publicWallet(owner) });
    });

    app.post('/api/economy/tips', async (req, res) => {
      const owner = await resolveOwner(req);
      if (!owner) return res.status(401).json({ error: 'auth_required' });
      if (rateLimited(owner)) return res.status(429).json({ error: 'rate_limited' });
      const toOwner = String((req.body && req.body.toOwnerKey) || '');
      const amount = Number((req.body && req.body.amount) || 0);
      const sourceId = String((req.body && req.body.sourceId) || '') || null;
      const result = await withLock(owner, async () => sendTip(owner, toOwner, amount, sourceId));
      return res.status(result.ok ? 200 : 400).json({ ...result, wallet: publicWallet(owner) });
    });

    // Buy Drops with real money. price_cents comes from the server catalog, so a
    // tampered client cannot choose its own price. price_data is used inline so
    // enabling purchases needs only a secret key — no pre-created Stripe prices.
    app.post('/api/economy/drops/checkout', async (req, res) => {
      if (!purchasesEnabled || !secretKey || !stripe) {
        return res.status(503).json({ error: 'purchases_disabled' });
      }
      const owner = await resolveOwner(req);
      if (!owner) return res.status(401).json({ error: 'auth_required' });
      const product = DROP_PRODUCTS.find((p) => p.id === String((req.body && req.body.productId) || ''));
      if (!product || !product.active) return res.status(400).json({ error: 'unknown_product' });
      if (!publicOrigin) return res.status(503).json({ error: 'public_origin_unset' });
      try {
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          line_items: [{
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: product.price_cents,
              product_data: { name: `${product.drop_amount} Drops` },
            },
          }],
          metadata: { productId: product.id, ownerKey: owner, kind: 'drops' },
          payment_intent_data: { metadata: { productId: product.id, ownerKey: owner, kind: 'drops' } },
          success_url: `${publicOrigin}/?drops=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${publicOrigin}/?drops=cancelled`,
        });
        res.json({ url: session.url, id: session.id });
      } catch (error) {
        res.status(502).json({ error: 'stripe_error', code: String(error?.code || error?.type || 'unknown').slice(0, 60) });
      }
    });

    // Creator earnings surface. Read-only while payouts are off: it reports what
    // is owed and why it cannot be withdrawn yet, rather than hiding the number.
    app.get('/api/creator/earnings', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const owner = await resolveOwner(req);
      if (!owner) return res.status(401).json({ error: 'auth_required' });
      const wallet = walletFor(owner, false);
      const balances = wallet ? project(wallet) : { creator: 0, payoutableDrops: 0, payoutableCents: 0 };
      const blockers = [];
      if (!payoutsEnabled) blockers.push('payouts_disabled');
      if (balances.payoutableDrops < PAYOUT_MIN_DROPS) blockers.push('below_minimum');
      if (balances.payoutableCents > TAX_REPORTING_CENTS) blockers.push('tax_info_required');
      blockers.push('identity_verification_required'); // adults only (phase 3)
      res.json({
        creatorBalance: balances.creator,
        payoutableDrops: balances.payoutableDrops,
        payoutableCents: balances.payoutableCents,
        minimumDrops: PAYOUT_MIN_DROPS,
        centsPer100Drops: PAYOUT_CENTS_PER_100_DROPS,
        withdrawable: payoutsEnabled && blockers.length === 0,
        blockers,
      });
    });

    app.post('/api/creator/payouts/onboard', async (req, res) => {
      const owner = await resolveOwner(req);
      if (!owner) return res.status(401).json({ error: 'auth_required' });
      if (!payoutsEnabled) return res.status(503).json({ error: 'payouts_disabled' });
      // Deliberately unimplemented: Stripe Connect Express onboarding, KYC, tax
      // forms and guardian gates are a policy decision, not a code path to slip
      // in behind a flag. See docs/paint-economy.md §Phase 2/3.
      return res.status(501).json({ error: 'not_implemented', see: 'docs/paint-economy.md' });
    });
  }

  return {
    registerRoutes,
    registerWebhook,
    get mode() {
      return {
        purchases: purchasesEnabled && Boolean(secretKey) ? 'ready' : 'disabled',
        payouts: payoutsEnabled ? 'enabled' : 'disabled',
        stripeKeyPresent: Boolean(secretKey),
        origin: publicOrigin || null,
        wallets: Object.keys(state.wallets).length,
        receipts: Object.keys(state.receipts).length,
      };
    },
    // exposed for tests
    _internals: { project, walletFor, creditPurchase, refundPurchase, buyStoreItem, sendTip, earnFromPainting, earnFromQuest, save },
  };
}

export { SOURCE, CURRENCY, PAYOUT_CENTS_PER_100_DROPS, PAYOUT_MIN_DROPS };
