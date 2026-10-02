# Drops: server-side wallet, purchases and payouts

Status: **server-authoritative wallet + purchase rails implemented and deployed;
client still on the legacy local mock; payouts deliberately OFF.**

Supersedes the "no real-money economy" note in `AGENTS.md:80` for *purchases*
only. Read this before changing anything in `server/economy.js`.

## Why the old model could not carry money

`src/utils/economy.js` was a client-side mock: balances lived in the browser's
IndexedDB (`happypaint:economy:v1`) and the ledger was projected in the tab.
That is fine for a cosmetic play-money counter and fatal for money, any user can
open devtools and mint a balance, so neither a purchase nor a payout against it
can be trusted.

`server/economy.js` now holds the authoritative wallet. Balances are a
*projection* of an append-only ledger, never a stored number, matching
`backend/supabase/schema.sql:1121`.

## The one rule that makes cash-out safe: PROVENANCE

Drops enter a wallet two ways and they are **not** interchangeable:

| source | how | `paid` | cashable |
|---|---|---|---|
| `drop_purchase` | verified Stripe payment | `true` | yes |
| `paint_earn` | 1 Drop per completed stroke, server-throttled to 1/4s | `false` | **no** |
| `quest_earn` | 3 Drops per quest mission (idempotent per key) | `false` | **no** |

`paidDrops` is projected separately from `drops`. **A payout may only ever draw
on `paidDrops`.**

Without this, painting is a money printer: the earn throttle is ~900 Drops/hour
and costs the painter nothing, so cashing earned Drops out would drain real
money nobody paid in. The throttle is politeness, not the safety mechanism -
provenance is.

Tips follow the same rule: `sendTip` spends paid Drops first and credits the
receiver's `payoutableDrops` **only** by the paid portion of the spend. A tip
funded entirely by earned Drops adds creator balance and **zero** cashable
value. Covering tests: `test-economy.mjs` §THE ANTI-FARMING RULE.

## Pricing (decided 2026-09-27)

Anchor is the catalog: 1,000 Drops = $9.99 retail; the best pack (2,200/$19.99)
is 0.909¢/Drop, the same figure `dropsToApproxMoney()` reports to users.

Payout is **65¢ per 100 Drops (0.65¢/Drop)**, `ECONOMY_PAYOUT_CENTS_PER_100_DROPS`.
Derivation: a $9.99 charge nets ~$9.40 after Stripe (~2.9% + 30¢); a 70/30
creator/platform split, the Roblox-style ratio `docs/paint-economy.md` cites -
leaves ~$6.58. So:

- 1,000 Drops → **$6.50**
- minimum cash-out **5,000 Drops → $32.50** (`ECONOMY_PAYOUT_MIN_DROPS`), to keep
  payouts clear of per-transfer costs
- 1099 threshold **$600/yr** (`ECONOMY_TAX_REPORTING_CENTS`); past it, payouts
  hold until tax info is on file

At the earn rate, 1,000 Drops is roughly 1–2 hours of a child's painting, so the
payout is ~$3–$6/hour of effort, fair, and affordable only because it is funded
by money that actually arrived.

## Enabling purchases (revenue in)

Purchases need a Stripe secret key; no pre-created prices are required, because
checkout builds `price_data` inline from the server catalog. Prices are read from
the server, never from the client, so a tampered client cannot buy 1,000 Drops
for a cent.

1. `STRIPE_SECRET_KEY=sk_live_…`
2. `STRIPE_WEBHOOK_SECRET=whsec_…`
3. `PUBLIC_ORIGIN=https://drawesome.art`
4. `STRIPE_CHECKOUT_ENABLED=1`
5. Stripe webhook → `https://drawesome.art/api/economy/webhook`, events
   `checkout.session.completed`, `charge.refunded`
6. Redeploy. `GET /api/economy/config` → `purchasesEnabled: true`.

Crediting is idempotent on the Stripe session id (`state.receipts`), because
webhooks retry and a double credit is free Drops. Refunds claw back the exact
credited amount; a refund after the Drops were spent drives the balance negative,
which is correct, the debt is real.

## Payouts (money out), still OFF

`ECONOMY_PAYOUTS_ENABLED` is unset, and `/api/creator/payouts/onboard` returns
501 by design. Turning payouts on is a policy decision, not a refactor:
`docs/paint-economy.md` §Creator Earnings requires guardian gates for teens, tax
info, identity checks and Stripe Connect, and **under-13 can never cash out**
(COPPA). `GET /api/creator/earnings` reports what is owed and every blocking
reason, so the number is visible rather than hidden.

## Invariants to preserve

- Balances are derived from the ledger; never store one.
- Every ledger entry has a closed-set `source` and an explicit `paid` flag.
- Anything a user can trigger is rate-limited and idempotent.
- Owner keys are client-supplied, so `walletFor()` rejects `__proto__` and
  friends before any bracket assignment on a plain object.
- Wallet population is capped (`ECONOMY_MAX_WALLETS`), an anonymous caller can
  otherwise grow the file by choosing new device keys.
