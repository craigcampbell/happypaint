import AsyncStorage from "@react-native-async-storage/async-storage";

import { makeId } from "./ids";

// Happy Paint economy — local mock wallet model (docs/paint-economy.md).
//
// This is a MOCK economy surface: NO real payments, NO real purchase SDK, NO
// network. It mirrors the backend economy tables (backend/supabase/schema.sql
// §Economy) so the same shapes can be wired to Supabase + real IAP later:
//   - wallets               -> wallet balances (drops/kudos/creator/locked)
//   - wallet_ledger_entries -> append-only ledger (balances derive from it)
//   - drop_products         -> platform SKUs ($ -> Drops grant)
//   - asset_products / store catalog -> spendable-with-Drops items
//   - tips                  -> Drops tips into a locked creator balance
//   - entitlements          -> what owning a pack unlocks (studio tools)
//
// Persisted client-side in AsyncStorage following storage.ts / paintSpace.ts.
//
// Ledger rules mirrored from the doc/schema:
//   - The ledger is append-only; balances are a projection of it.
//   - Every entry has a positive amount, a currency_type, and a direction.
//   - Paid Drops do not expire. No user-to-user currency transfer.
//   - No loot boxes / no randomized packs — every product is a transparent bundle.

const ECONOMY_KEY = "happy-paint:economy:v1";

// Currency types mirror the backend `currency_type` enum.
export type CurrencyType = "drops" | "kudos" | "creator";
export type LedgerDirection = "credit" | "debit";
// Mock platforms (mirror backend `drop_platform`). Used for copy/metadata only.
export type DropPlatform = "apple" | "google" | "web";
// Mirror backend `profile_kind` subset that drives guardian-control copy.
export type ProfileKind = "child" | "teen" | "adult";

// Mirror of wallet_ledger_entries columns.
export type WalletLedgerEntry = {
  id: string;
  amount: number;
  currency_type: CurrencyType;
  direction: LedgerDirection;
  source: string;
  source_id: string | null;
  platform: DropPlatform | null;
  idempotency_key: string;
  created_at: string;
};

// Mirror of wallets cached balances.
export type WalletBalances = {
  drops_balance: number;
  kudos_balance: number;
  creator_balance: number;
  locked_balance: number;
};

// Mirror of drop_products.
export type DropProduct = {
  id: string;
  sku: string;
  platform: DropPlatform;
  drop_amount: number;
  price_cents: number;
  active: boolean;
};

export type StoreCategory = "packs" | "themes" | "tokens" | "events";

// Store catalog row — spendable-with-Drops items. Each item is a transparent
// bundle (no randomized contents / loot boxes). `grants` is a mock entitlement
// key that owning the item confers (e.g. "studio" unlocks the studio tier).
export type StoreItem = {
  id: string;
  category: StoreCategory;
  title: string;
  description: string;
  price_drops: number;
  grants: string;
};

// Mirror of tips (single-profile local surface: receiver is the local creator).
export type TipRecord = {
  id: string;
  source_type: "gallery_post" | "asset_pack" | "space_asset" | "timed_event" | "paint_session";
  source_id: string | null;
  amount_drops: number;
  status: "pending" | "approved" | "held" | "reversed" | "blocked";
  receiver_name: string;
  created_at: string;
};

export type EconomyState = {
  version: 1;
  profile_kind: ProfileKind;
  wallet: WalletBalances;
  // Append-only ledger; newest first for display. Balances derive from this.
  ledger: WalletLedgerEntry[];
  owned: string[]; // store item ids
  entitlements: string[]; // grant keys, e.g. "studio"
  tipsReceived: TipRecord[];
};

export type SpendResult = { ok: true; state: EconomyState } | { ok: false; state: EconomyState; reason: "owned" | "insufficient" };

// ---- drop_products: $ -> Drops (suggested pricing from the doc) ----
// Purchased Drops never expire (Apple/Play rule + doc). Catalog rows only; the
// mock "buy" credits Drops without any real payment.
export const DROP_PRODUCTS: DropProduct[] = [
  { id: "drops_80", sku: "happypaint.drops.80", platform: "web", drop_amount: 80, price_cents: 99, active: true },
  { id: "drops_450", sku: "happypaint.drops.450", platform: "web", drop_amount: 450, price_cents: 499, active: true },
  { id: "drops_1000", sku: "happypaint.drops.1000", platform: "web", drop_amount: 1000, price_cents: 999, active: true },
  { id: "drops_2200", sku: "happypaint.drops.2200", platform: "web", drop_amount: 2200, price_cents: 1999, active: true }
];

export const STORE_CATEGORIES: Array<{ id: StoreCategory; label: string }> = [
  { id: "packs", label: "Official Packs" },
  { id: "themes", label: "Room Themes" },
  { id: "tokens", label: "Storage & Export" },
  { id: "events", label: "Event Bundles" }
];

// Prices use the doc's "Price examples". Owning "studio" unlocks the studio
// brush/paper tier (Glow brush + Night paper) in the studio.
export const STORE_ITEMS: StoreItem[] = [
  {
    id: "creator-brushes",
    category: "packs",
    title: "Creator Brushes",
    description: "Glow neon brush, Night paper, and the Poster palette — unlocks the studio brush tier.",
    price_drops: 150,
    grants: "studio"
  },
  {
    id: "sticker-arcade",
    category: "packs",
    title: "Neon Arcade Stickers",
    description: "An official, moderated sticker pack for galleries and rooms.",
    price_drops: 120,
    grants: "pack:sticker-arcade"
  },
  {
    id: "loop-starter",
    category: "packs",
    title: "Tiny Loop Templates",
    description: "Ready-made tiny-loop templates to remix into your own animations.",
    price_drops: 200,
    grants: "pack:loop-starter"
  },
  {
    id: "theme-midnight",
    category: "themes",
    title: "Midnight Arcade Room Theme",
    description: "A dark neon room theme for your Paint Space and live rooms.",
    price_drops: 250,
    grants: "theme:midnight"
  },
  {
    id: "theme-sunrise",
    category: "themes",
    title: "Sunrise Studio Room Theme",
    description: "A warm, soft room theme for cozy collab sessions.",
    price_drops: 100,
    grants: "theme:sunrise"
  },
  {
    id: "export-hi-res",
    category: "tokens",
    title: "High-Res Export Token",
    description: "Unlock a large, print-ready PNG export. Use it whenever you like.",
    price_drops: 200,
    grants: "token:export-hi-res"
  },
  {
    id: "storage-block",
    category: "tokens",
    title: "Extra Storage Block",
    description: "Add cloud storage room for more saved projects and loops.",
    price_drops: 400,
    grants: "token:storage-block"
  },
  {
    id: "event-host-bundle",
    category: "events",
    title: "Event Host Bundle",
    description: "Host tools for running a safe timed event. Does NOT buy votes or placement.",
    price_drops: 350,
    grants: "event:host-bundle"
  }
];

// Preset tip amounts (doc: fixed presets, no free-form messages on kid-safe tips).
export const TIP_PRESETS = [10, 25, 50, 100];

// Default account kind for the mock surface. Child/teen accounts show guardian
// controls + purchase-history copy. Mirrors backend `profile_kind`.
export const DEFAULT_PROFILE_KIND: ProfileKind = "teen";

// ---- Money formatting (local-money equivalence near purchases) ----
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Approximate local-money value of a Drops amount, derived from the best $/Drop
// rate in the catalog (largest pack — best value). Shown near spend moments per
// the doc ("always show approximate local-money equivalent").
export function dropsToApproxMoney(drops: number): string {
  const best = DROP_PRODUCTS.reduce((acc, product) =>
    product.price_cents / product.drop_amount < acc.price_cents / acc.drop_amount ? product : acc
  );
  const cents = Math.round((drops * best.price_cents) / best.drop_amount);
  return formatPrice(cents);
}

// ---- State shape helpers ----
export function emptyState(): EconomyState {
  return {
    version: 1,
    profile_kind: DEFAULT_PROFILE_KIND,
    wallet: { drops_balance: 0, kudos_balance: 0, creator_balance: 0, locked_balance: 0 },
    ledger: [],
    owned: [],
    entitlements: [],
    tipsReceived: []
  };
}

// Derive balances from the append-only ledger so they stay consistent (schema:
// "Balances are cached projections of the append-only ledger"). drops/kudos use
// the standard balance; creator credits land in BOTH creator_balance and
// locked_balance (tips are locked until payouts are eligible — Phase 1).
export function projectBalances(ledger: WalletLedgerEntry[]): WalletBalances {
  const wallet: WalletBalances = { drops_balance: 0, kudos_balance: 0, creator_balance: 0, locked_balance: 0 };
  for (const entry of ledger) {
    const sign = entry.direction === "credit" ? 1 : -1;
    if (entry.currency_type === "drops") {
      wallet.drops_balance += sign * entry.amount;
    } else if (entry.currency_type === "kudos") {
      wallet.kudos_balance += sign * entry.amount;
    } else if (entry.currency_type === "creator") {
      wallet.creator_balance += sign * entry.amount;
      wallet.locked_balance += sign * entry.amount;
    }
  }
  return wallet;
}

function withDerivedWallet(state: EconomyState): EconomyState {
  return { ...state, wallet: projectBalances(state.ledger) };
}

// Build one append-only ledger entry (mirrors wallet_ledger_entries columns).
function makeLedgerEntry(input: {
  amount: number;
  currency_type: CurrencyType;
  direction: LedgerDirection;
  source: string;
  source_id?: string | null;
  platform?: DropPlatform | null;
}): WalletLedgerEntry {
  return {
    id: makeId("ledger"),
    amount: Math.abs(Math.round(input.amount)),
    currency_type: input.currency_type,
    direction: input.direction,
    source: input.source,
    source_id: input.source_id ?? null,
    platform: input.platform ?? null,
    idempotency_key: makeId("idem"),
    created_at: new Date().toISOString()
  };
}

function appendEntries(state: EconomyState, entries: WalletLedgerEntry[]): EconomyState {
  const ledger = [...entries, ...state.ledger];
  return withDerivedWallet({ ...state, ledger });
}

// ---- Load / save (AsyncStorage; never throws on load) ----
function normalize(raw: unknown): EconomyState {
  const base = emptyState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const partial = raw as Partial<EconomyState>;
  const state: EconomyState = {
    ...base,
    ...partial,
    version: 1,
    profile_kind: partial.profile_kind ?? base.profile_kind,
    wallet: { ...base.wallet, ...(partial.wallet ?? {}) },
    ledger: Array.isArray(partial.ledger) ? partial.ledger : [],
    owned: Array.isArray(partial.owned) ? partial.owned : [],
    entitlements: Array.isArray(partial.entitlements) ? partial.entitlements : [],
    tipsReceived: Array.isArray(partial.tipsReceived) ? partial.tipsReceived : []
  };
  return withDerivedWallet(state);
}

export async function loadEconomy(): Promise<EconomyState> {
  const raw = await AsyncStorage.getItem(ECONOMY_KEY);
  if (!raw) {
    return emptyState();
  }
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

export async function saveEconomy(state: EconomyState): Promise<void> {
  await AsyncStorage.setItem(ECONOMY_KEY, JSON.stringify(state));
}

// ---- Pure action helpers (return a new state; never mutate input) ----

// Mock "purchase" of a Drop product: credits Drops via a ledger entry. Real
// purchases would verify an App Store / Google Play / web receipt first.
export function creditDrops(state: EconomyState, product: DropProduct): EconomyState {
  const entry = makeLedgerEntry({
    amount: product.drop_amount,
    currency_type: "drops",
    direction: "credit",
    source: "drop_purchase",
    source_id: product.sku,
    platform: product.platform
  });
  return appendEntries(state, [entry]);
}

// Buy a store item with Drops. Blocked when the balance is insufficient.
// Idempotent on already-owned items (no double charge).
export function spendDrops(state: EconomyState, item: StoreItem): SpendResult {
  if (state.owned.includes(item.id)) {
    return { ok: false, state, reason: "owned" };
  }
  if (state.wallet.drops_balance < item.price_drops) {
    return { ok: false, state, reason: "insufficient" };
  }
  const entry = makeLedgerEntry({
    amount: item.price_drops,
    currency_type: "drops",
    direction: "debit",
    source: "store_purchase",
    source_id: item.id
  });
  let next = appendEntries(state, [entry]);
  next = {
    ...next,
    owned: [...next.owned, item.id],
    entitlements:
      item.grants && !next.entitlements.includes(item.grants)
        ? [...next.entitlements, item.grants]
        : next.entitlements
  };
  return { ok: true, state: next };
}

// Award earned Kudos (events, votes, featured posts). Not cash-redeemable.
export function awardKudos(
  state: EconomyState,
  amount: number,
  source = "kudos_award",
  sourceId: string | null = null
): EconomyState {
  const entry = makeLedgerEntry({
    amount,
    currency_type: "kudos",
    direction: "credit",
    source,
    source_id: sourceId
  });
  return appendEntries(state, [entry]);
}

// Send a Drops tip. Spends Drops from the sender and records the tip into the
// (mock) creator's locked balance via a creator-currency credit. In this local
// surface the sender IS the creator (single profile), so both sides land in the
// same wallet — the ledger still records the spend and the locked credit
// separately, which is what the backend would do across two profiles.
export function sendTip(
  state: EconomyState,
  input: {
    amount: number;
    sourceType?: TipRecord["source_type"];
    sourceId?: string | null;
    receiverName?: string;
  }
): SpendResult {
  const { amount, sourceType = "gallery_post", sourceId = null, receiverName = "Creator" } = input;
  if (state.wallet.drops_balance < amount) {
    return { ok: false, state, reason: "insufficient" };
  }
  const tipId = makeId("tip");
  const debit = makeLedgerEntry({
    amount,
    currency_type: "drops",
    direction: "debit",
    source: "tip_sent",
    source_id: tipId
  });
  const lockedCredit = makeLedgerEntry({
    amount,
    currency_type: "creator",
    direction: "credit",
    source: "tip_received",
    source_id: tipId
  });
  let next = appendEntries(state, [debit, lockedCredit]);
  const tip: TipRecord = {
    id: tipId,
    source_type: sourceType,
    source_id: sourceId,
    amount_drops: amount,
    status: "approved",
    receiver_name: receiverName,
    created_at: new Date().toISOString()
  };
  next = { ...next, tipsReceived: [tip, ...next.tipsReceived] };
  return { ok: true, state: next };
}

// ---- Entitlement / ownership queries ----
export function hasEntitlement(state: EconomyState | null | undefined, key: string): boolean {
  return Boolean(state?.entitlements?.includes(key));
}

export function ownsItem(state: EconomyState | null | undefined, itemId: string): boolean {
  return Boolean(state?.owned?.includes(itemId));
}

// True when the account is a minor (child/teen) — drives guardian-control copy.
export function isMinorAccount(state: EconomyState | null | undefined): boolean {
  return state?.profile_kind === "child" || state?.profile_kind === "teen";
}

// One-time migration: the old `premiumPreview` boolean (true == studio tier
// unlocked) becomes ownership of the Creator Brushes pack + the "studio"
// entitlement, with a ledger note so the wallet history reflects the grant
// honestly. Returns the possibly-updated state and whether anything changed.
export function migrateLegacyStudioPass(
  state: EconomyState,
  legacyUnlocked: boolean
): { state: EconomyState; changed: boolean } {
  if (!legacyUnlocked || hasEntitlement(state, "studio")) {
    return { state, changed: false };
  }
  const item = STORE_ITEMS.find((candidate) => candidate.grants === "studio");
  if (!item) {
    return { state, changed: false };
  }
  // Credit the Drops the legacy pack was "worth" and immediately mark it owned,
  // so the entitlement is granted without leaving an unexplained balance.
  const entry = makeLedgerEntry({
    amount: item.price_drops,
    currency_type: "drops",
    direction: "credit",
    source: "legacy_studio_grant",
    source_id: item.id
  });
  let next = appendEntries(state, [entry]);
  next = {
    ...next,
    owned: next.owned.includes(item.id) ? next.owned : [...next.owned, item.id],
    entitlements: next.entitlements.includes("studio") ? next.entitlements : [...next.entitlements, "studio"]
  };
  return { state: next, changed: true };
}

// Human-readable label for a ledger source (wallet activity list).
export function describeLedgerSource(entry: WalletLedgerEntry): string {
  const map: Record<string, string> = {
    drop_purchase: "Bought Drops",
    store_purchase: "Store purchase",
    tip_sent: "Tip sent",
    tip_received: "Tip received",
    kudos_award: "Kudos earned",
    legacy_studio_grant: "Creator Brushes (migrated)"
  };
  return map[entry.source] ?? entry.source;
}
