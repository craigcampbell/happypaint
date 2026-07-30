// Happy Paint economy — local mock wallet model (docs/paint-economy.md).
//
// This is a MOCK economy surface: NO real payments, NO real purchase flows. It
// mirrors the backend economy tables (backend/supabase/schema.sql §Economy) so
// the same shapes can be wired to Supabase later:
//   - wallets               -> wallet balances (drops/kudos/creator/locked)
//   - wallet_ledger_entries -> append-only ledger (balances derive from it)
//   - drop_products         -> platform SKUs ($ -> Drops grant)
//   - asset_products / store catalog -> spendable Drops items
//   - tips                  -> Drops tips into a locked creator balance
//   - entitlements          -> what owning a pack unlocks (studio tools)
//
// Persisted client-side in the existing IndexedDB "kv" store (idb.js), matching
// the storage hardening done for the gallery and Paint Space lockers. Falls back
// to localStorage when IndexedDB is unavailable (private mode).
//
// Ledger rules mirrored from the doc/schema:
//   - The ledger is append-only; balances are a projection of it.
//   - Every entry has a positive amount, a currency_type, and a direction.
//   - Paid Drops do not expire. No user-to-user currency transfer.
//   - No loot boxes / no randomized packs — every product is a transparent bundle.

import { idbGetKV, idbSetKV, isIdbAvailable } from "./idb";
import { makeId } from "./paintSpace";

// Legacy localStorage key (private-mode fallback store).
export const ECONOMY_STORAGE_KEY = "happypaint:economy:v1";
// Key for the economy record inside the IndexedDB "kv" store.
export const ECONOMY_IDB_KEY = "economy:v1";

// Currency types mirror the backend `currency_type` enum.
export const CURRENCY = {
  drops: "drops", // paid virtual currency (bought with real money)
  kudos: "kudos", // earned reputation, NOT cash-redeemable
  creator: "creator", // tips received into a locked creator balance
};

export const DIRECTION = { credit: "credit", debit: "debit" };

// Mock platforms (mirror backend `drop_platform`). Used for copy only here.
export const PLATFORM = { apple: "apple", google: "google", web: "web" };

// PLAY-MONEY MODE. Drops are a cosmetic, non-cash, non-transferable in-app
// counter you EARN by painting — there is no way to buy them with real money and
// no payout/cash-out. We keep this ON for the family release: real in-app
// purchases + creator payouts carry app-store, COPPA, and money-handling
// obligations that need their own deliberate, reviewed setup. Flipping this to
// false re-exposes the (still-unwired) real-money catalog.
export const PLAY_MONEY_ONLY = true;

// ---- drop_products: $ -> Drops (suggested pricing from the doc) ----
// Purchased Drops never expire (Apple/Play rule + doc). These are catalog rows
// only; the mock "buy" credits Drops without any real payment. In play-money
// mode the catalog is empty so NO surface frames Drops as purchasable with cash.
const REAL_DROP_PRODUCTS = [
  { id: "drops_80", sku: "happypaint.drops.80", platform: PLATFORM.web, drop_amount: 80, price_cents: 99, active: true },
  { id: "drops_450", sku: "happypaint.drops.450", platform: PLATFORM.web, drop_amount: 450, price_cents: 499, active: true },
  { id: "drops_1000", sku: "happypaint.drops.1000", platform: PLATFORM.web, drop_amount: 1000, price_cents: 999, active: true },
  { id: "drops_2200", sku: "happypaint.drops.2200", platform: PLATFORM.web, drop_amount: 2200, price_cents: 1999, active: true },
];
export const DROP_PRODUCTS = PLAY_MONEY_ONLY ? [] : REAL_DROP_PRODUCTS;

// Store catalog — spendable-with-Drops items. Each item is a transparent bundle
// (no randomized contents / loot boxes). `grants` is a mock entitlement key that
// owning the item confers (e.g. "studio" unlocks the studio brush/paper tier).
// Prices use the doc's "Price examples".
export const STORE_CATEGORIES = [
  { id: "packs", label: "Official Packs" },
  { id: "themes", label: "Room Themes" },
  { id: "tokens", label: "Storage & Export" },
  { id: "events", label: "Event Bundles" },
];

export const STORE_ITEMS = [
  {
    id: "creator-brushes",
    category: "packs",
    title: "Creator Brushes",
    description: "Glow neon brush, Night paper, and the Poster palette — unlocks the studio brush tier.",
    price_drops: 150,
    grants: "studio",
  },
  {
    id: "sticker-arcade",
    category: "packs",
    title: "Neon Arcade Stickers",
    description: "An official, moderated sticker pack for galleries and rooms.",
    price_drops: 120,
    grants: "pack:sticker-arcade",
  },
  {
    id: "loop-starter",
    category: "packs",
    title: "Tiny Loop Templates",
    description: "Ready-made tiny-loop templates to remix into your own animations.",
    price_drops: 200,
    grants: "pack:loop-starter",
  },
  {
    id: "theme-midnight",
    category: "themes",
    title: "Midnight Arcade Room Theme",
    description: "A dark neon room theme for your Paint Space and live rooms.",
    price_drops: 250,
    grants: "theme:midnight",
  },
  {
    id: "theme-sunrise",
    category: "themes",
    title: "Sunrise Studio Room Theme",
    description: "A warm, soft room theme for cozy collab sessions.",
    price_drops: 100,
    grants: "theme:sunrise",
  },
  {
    id: "export-hi-res",
    category: "tokens",
    title: "High-Res Export Token",
    description: "Unlock a large, print-ready PNG export. Use it whenever you like.",
    price_drops: 200,
    grants: "token:export-hi-res",
  },
  {
    id: "storage-block",
    category: "tokens",
    title: "Extra Storage Block",
    description: "Add cloud storage room for more saved projects and loops.",
    price_drops: 400,
    grants: "token:storage-block",
  },
  {
    id: "event-host-bundle",
    category: "events",
    title: "Event Host Bundle",
    description: "Host tools for running a safe timed event. Does NOT buy votes or placement.",
    price_drops: 350,
    grants: "event:host-bundle",
  },
];

// Preset tip amounts (doc: fixed presets, no free-form messages on kid-safe tips).
export const TIP_PRESETS = [10, 25, 50, 100];

// Default account kind for the mock surface. Child/teen accounts show guardian
// controls + purchase-history copy. Mirrors backend `profile_kind`.
export const DEFAULT_PROFILE_KIND = "teen";

// ---- Money formatting (local-money equivalence near purchases) ----
export function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Approximate local-money value of a Drops amount, derived from the best
// available $/Drop rate in the catalog (the largest pack — best value). Shown
// near spend moments per the doc ("always show approximate local-money equiv").
export function dropsToApproxMoney(drops) {
  // Play-money mode: Drops have no cash value, so show no money equivalence.
  if (PLAY_MONEY_ONLY || REAL_DROP_PRODUCTS.length === 0) return "";
  const best = REAL_DROP_PRODUCTS.reduce((acc, p) =>
    p.price_cents / p.drop_amount < acc.price_cents / acc.drop_amount ? p : acc,
  );
  const cents = Math.round((drops * best.price_cents) / best.drop_amount);
  return formatPrice(cents);
}

// ---- State shape (mirrors wallets + wallet_ledger_entries + entitlements) ----
function emptyState() {
  return {
    version: 1,
    profile_kind: DEFAULT_PROFILE_KIND,
    wallet: {
      drops_balance: 0,
      kudos_balance: 0,
      creator_balance: 0,
      locked_balance: 0,
    },
    // Append-only ledger. Newest first for display convenience; balances are
    // derived via projectBalances so the two never drift.
    ledger: [],
    // Mock owned store items + the entitlements they grant.
    owned: [], // store item ids
    entitlements: [], // grant keys, e.g. "studio"
    // Tips received (mirror backend `tips`), accumulating into locked creator balance.
    tipsReceived: [],
    questReceipts: [],
  };
}

// Derive balances from the append-only ledger so they stay consistent (schema:
// "Balances are cached projections of the append-only ledger"). drops/kudos use
// the standard balance; creator credits land in BOTH creator_balance and
// locked_balance (tips are locked until payouts are eligible — Phase 1).
export function projectBalances(ledger) {
  const wallet = { drops_balance: 0, kudos_balance: 0, creator_balance: 0, locked_balance: 0 };
  for (const entry of ledger) {
    const sign = entry.direction === DIRECTION.credit ? 1 : -1;
    if (entry.currency_type === CURRENCY.drops) {
      wallet.drops_balance += sign * entry.amount;
    } else if (entry.currency_type === CURRENCY.kudos) {
      wallet.kudos_balance += sign * entry.amount;
    } else if (entry.currency_type === CURRENCY.creator) {
      wallet.creator_balance += sign * entry.amount;
      wallet.locked_balance += sign * entry.amount;
    }
  }
  return wallet;
}

function withDerivedWallet(state) {
  return { ...state, wallet: projectBalances(state.ledger) };
}

// Build one append-only ledger entry (mirrors wallet_ledger_entries columns).
function makeLedgerEntry({ amount, currency_type, direction, source, source_id = null, platform = null }) {
  return {
    id: makeId("ledger"),
    amount: Math.abs(Math.round(amount)),
    currency_type,
    direction,
    source,
    source_id,
    platform,
    idempotency_key: makeId("idem"),
    created_at: new Date().toISOString(),
  };
}

function appendEntries(state, entries) {
  const ledger = [...entries, ...state.ledger];
  return withDerivedWallet({ ...state, ledger });
}

// ---- Load / save (IndexedDB-first, localStorage fallback) ----
function readLocal() {
  try {
    const value = window.localStorage.getItem(ECONOMY_STORAGE_KEY);
    if (value == null) {
      return null;
    }
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalize(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const state = {
    ...base,
    ...raw,
    wallet: { ...base.wallet, ...(raw.wallet || {}) },
    ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
    owned: Array.isArray(raw.owned) ? raw.owned : [],
    entitlements: Array.isArray(raw.entitlements) ? raw.entitlements : [],
    tipsReceived: Array.isArray(raw.tipsReceived) ? raw.tipsReceived : [],
    questReceipts: Array.isArray(raw.questReceipts) ? raw.questReceipts.slice(0, 50) : [],
  };
  return withDerivedWallet(state);
}

// Never throws — load failures resolve to a fresh empty wallet.
export async function loadEconomy() {
  if (isIdbAvailable()) {
    try {
      const stored = await idbGetKV(ECONOMY_IDB_KEY);
      if (stored) {
        return normalize(stored);
      }
      const legacy = readLocal();
      if (legacy) {
        const migrated = normalize(legacy);
        await idbSetKV(ECONOMY_IDB_KEY, migrated);
        try {
          window.localStorage.removeItem(ECONOMY_STORAGE_KEY);
        } catch {
          // Non-fatal.
        }
        return migrated;
      }
      return emptyState();
    } catch {
      return normalize(readLocal());
    }
  }
  return normalize(readLocal());
}

// Persist. Rejects on failure so callers can surface an honest status.
export async function saveEconomy(state) {
  if (isIdbAvailable()) {
    await idbSetKV(ECONOMY_IDB_KEY, state);
    return;
  }
  window.localStorage.setItem(ECONOMY_STORAGE_KEY, JSON.stringify(state));
}

// ---- Pure action helpers (return a new state; never mutate input) ----

// Mock "purchase" of a Drop product: credits Drops via a ledger entry. Real
// purchases would verify an App Store / Google Play / web receipt first.
export function creditDrops(state, product) {
  const entry = makeLedgerEntry({
    amount: product.drop_amount,
    currency_type: CURRENCY.drops,
    direction: DIRECTION.credit,
    source: "drop_purchase",
    source_id: product.sku,
    platform: product.platform,
  });
  return appendEntries(state, [entry]);
}

// Buy a store item with Drops. Returns { ok, state, reason }. Blocked when the
// balance is insufficient. Idempotent on already-owned items (no double charge).
export function spendDrops(state, item) {
  if (state.owned.includes(item.id)) {
    return { ok: false, state, reason: "owned" };
  }
  if (state.wallet.drops_balance < item.price_drops) {
    return { ok: false, state, reason: "insufficient" };
  }
  const entry = makeLedgerEntry({
    amount: item.price_drops,
    currency_type: CURRENCY.drops,
    direction: DIRECTION.debit,
    source: "store_purchase",
    source_id: item.id,
  });
  let next = appendEntries(state, [entry]);
  next = {
    ...next,
    owned: [...next.owned, item.id],
    entitlements: item.grants && !next.entitlements.includes(item.grants)
      ? [...next.entitlements, item.grants]
      : next.entitlements,
  };
  return { ok: true, state: next };
}

// Award earned Kudos (events, votes, featured posts). Not cash-redeemable.
export function awardKudos(state, amount, source = "kudos_award", sourceId = null) {
  const entry = makeLedgerEntry({
    amount,
    currency_type: CURRENCY.kudos,
    direction: DIRECTION.credit,
    source,
    source_id: sourceId,
  });
  return appendEntries(state, [entry]);
}

// Earn-by-painting: the play-money way Drops enter a wallet. A pure credit (no
// purchase, no receipt, no real money) so kids earn Drops just by making art.
// Returns the same state when amount rounds to 0.
export function earnDropsForPainting(state, amount = 1) {
  const amt = Math.max(0, Math.round(amount || 0));
  if (!amt) return state;
  const entry = makeLedgerEntry({
    amount: amt,
    currency_type: CURRENCY.drops,
    direction: DIRECTION.credit,
    source: "paint_earn",
  });
  return appendEntries(state, [entry]);
}

// Cooperative quest reward. Idempotent per device/set/mission and bounded in
// the existing economy record (which account deletion already wipes).
export function earnDropsForQuest(state, setId, missionId, amount = 3) {
  const receipt = `${String(setId || "").slice(0, 48)}:${String(missionId || "").slice(0, 48)}`;
  if (!setId || !missionId || state.questReceipts?.includes(receipt)) return state;
  const entry = makeLedgerEntry({
    amount: Math.max(1, Math.min(5, Math.round(amount || 3))),
    currency_type: CURRENCY.drops,
    direction: DIRECTION.credit,
    source: "quest_earn",
    source_id: receipt,
  });
  return {
    ...appendEntries(state, [entry]),
    questReceipts: [receipt, ...(state.questReceipts || [])].slice(0, 50),
  };
}

// Send a Drops tip. Spends Drops from the sender and records the tip into the
// (mock) creator's locked balance via a creator-currency credit. In this local
// surface the sender IS the creator (single profile), so both sides land in the
// same wallet — the ledger still records the spend and the locked credit
// separately, which is what the backend would do across two profiles.
// Returns { ok, state, reason }.
export function sendTip(state, { amount, sourceType = "gallery_post", sourceId = null, receiverName = "Creator" }) {
  if (state.wallet.drops_balance < amount) {
    return { ok: false, state, reason: "insufficient" };
  }
  const tipId = makeId("tip");
  const debit = makeLedgerEntry({
    amount,
    currency_type: CURRENCY.drops,
    direction: DIRECTION.debit,
    source: "tip_sent",
    source_id: tipId,
  });
  const lockedCredit = makeLedgerEntry({
    amount,
    currency_type: CURRENCY.creator,
    direction: DIRECTION.credit,
    source: "tip_received",
    source_id: tipId,
  });
  let next = appendEntries(state, [debit, lockedCredit]);
  const tip = {
    id: tipId,
    source_type: sourceType,
    source_id: sourceId,
    amount_drops: amount,
    status: "approved",
    receiver_name: receiverName,
    created_at: new Date().toISOString(),
  };
  next = { ...next, tipsReceived: [tip, ...next.tipsReceived] };
  return { ok: true, state: next };
}

// ---- Entitlement / ownership queries ----
export function hasEntitlement(state, key) {
  return Boolean(state?.entitlements?.includes(key));
}

export function ownsItem(state, itemId) {
  return Boolean(state?.owned?.includes(itemId));
}

// True when the account is a minor (child/teen) — drives guardian-control copy.
export function isMinorAccount(state) {
  return state?.profile_kind === "child" || state?.profile_kind === "teen";
}

// One-time migration: an old `studio-pass` boolean (true == studio unlocked)
// becomes ownership of the Creator Brushes pack + the "studio" entitlement, with
// a ledger note so the wallet history reflects the grant honestly. Returns the
// possibly-updated state and whether anything changed.
export function migrateLegacyStudioPass(state, legacyUnlocked) {
  if (!legacyUnlocked || hasEntitlement(state, "studio")) {
    return { state, changed: false };
  }
  const item = STORE_ITEMS.find((i) => i.grants === "studio");
  if (!item) {
    return { state, changed: false };
  }
  const entry = makeLedgerEntry({
    amount: item.price_drops,
    currency_type: CURRENCY.drops,
    direction: DIRECTION.credit,
    source: "legacy_studio_grant",
    source_id: item.id,
  });
  // Credit the Drops the legacy pack was "worth" and immediately mark it owned,
  // so the entitlement is granted without leaving an unexplained balance.
  let next = appendEntries(state, [entry]);
  next = {
    ...next,
    owned: next.owned.includes(item.id) ? next.owned : [...next.owned, item.id],
    entitlements: next.entitlements.includes("studio") ? next.entitlements : [...next.entitlements, "studio"],
  };
  return { state: next, changed: true };
}

// Human-readable label for a ledger source (wallet activity list).
export function describeLedgerSource(entry) {
  const map = {
    drop_purchase: "Bought Drops",
    store_purchase: "Store purchase",
    tip_sent: "Tip sent",
    tip_received: "Tip received",
    kudos_award: "Kudos earned",
    paint_earn: "Earned by painting",
    legacy_studio_grant: "Creator Brushes (migrated)",
  };
  return map[entry.source] || entry.source;
}
