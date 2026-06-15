# Happy Paint Economy

Working currency name: **Drops**.

This is a Robux-like economy proposal for Happy Paint. It replaces monthly-first monetization with a wallet, tips, creator assets, paid packs, and guarded creator earnings.

## Core Decision

Do not launch with subscriptions as the main business model.

Launch with:

- Free drawing and free basic collaboration.
- Purchasable Drops.
- Earned non-cash reputation.
- Tips for creators.
- Paid brushes, stamps, palettes, templates, tiny loops, coloring pages, room themes, and safe event packs.
- Optional classroom/club purchases later.
- Creator payouts only after safety, tax, payout, and age/guardian controls are ready.

## Currency Model

Use two balances:

- **Drops**: paid virtual currency bought with real money through platform-approved purchase flows.
- **Kudos**: earned reputation from events, votes, featured posts, moderation-safe participation, and helpful community behavior.

Drops can be spent. Kudos should not be cash-redeemable.

Why two balances:

- Paid currency funds the product.
- Earned reputation gives status without creating child labor or payout pressure.
- Kids can participate meaningfully without needing purchases.
- Fraud and refund handling is cleaner.

## What Users Can Buy With Drops

Safe first purchases:

- Official brush packs.
- Community brush packs after moderation.
- Stamp and sticker packs.
- Meme-safe template packs.
- Tiny loop packs.
- Room themes.
- Paint Space decorations.
- Premium paper textures.
- High-res export tokens.
- Extra cloud storage blocks.
- Event entry bundles for hosts, not vote buying.
- Creator tips.

Do not sell:

- Safety controls.
- Reporting, blocking, leaving rooms, account deletion, or privacy settings.
- Vote wins.
- Random loot boxes.
- Public people search.
- Ability for adults to contact minors.
- Basic drawing.

## Tips

Tips are optional appreciation for:

- Gallery posts.
- Community brush packs.
- Sticker/template packs.
- Event winners.
- Room hosts.

Recommended launch behavior:

- Tips use Drops.
- Tip amounts are fixed presets, for example 10, 25, 50, 100 Drops.
- No free-form message on kid-safe tips.
- Kid-safe tips can use curated reactions only.
- Under-13 accounts cannot receive cash payouts directly.
- Guardian-managed accounts can receive tips into a locked creator balance or non-cash Kudos until payout rules are ready.

Important platform note:

- If a tip is connected to digital content, uses platform currency, or the app keeps a cut, treat it as an in-app digital transaction.
- Pure person-to-person monetary gifts are different on some platforms only when 100% goes to the receiver and nothing digital is unlocked. Happy Paint should not rely on that exception for its main economy.

## Creator Earnings

Creator earnings should be phased.

### Phase 1: No Cash Payouts

- Users can earn Kudos.
- Users can receive tips into a creator balance.
- Creator balance can be spent inside Happy Paint, but cannot be withdrawn.
- Public packs can be free or tip-supported.
- This avoids launching as a payout platform before safety and compliance are ready.

### Phase 2: Guardian-Gated Earnings

- Teen creators can publish paid packs only with guardian approval.
- Payout requires guardian-managed account, tax info, identity checks, and payout terms.
- Under-13 creators cannot independently cash out.
- Every paid asset requires moderation and licensing checks.

### Phase 3: Adult Creator Marketplace

- Verified adult creators can sell packs.
- Happy Paint takes a platform fee.
- Creators can cash out above a threshold.
- Marketplace supports takedowns, refunds, chargeback handling, fraud review, and payout holds.

## Suggested Pricing

Initial Drop packs:

- $0.99: 80 Drops.
- $4.99: 450 Drops.
- $9.99: 1,000 Drops.
- $19.99: 2,200 Drops.

Price examples:

- Small tip: 10 Drops.
- Big tip: 100 Drops.
- Official brush pack: 150 to 300 Drops.
- Community stamp pack: 50 to 200 Drops.
- Tiny loop template pack: 100 to 250 Drops.
- Room theme: 100 to 300 Drops.
- Event host bundle: 250 to 500 Drops.
- Extra storage block: 300 to 700 Drops.

Keep prices legible. Always show the approximate local-money equivalent near purchase moments.

## Platform Rules to Respect

### Apple App Store

- Unlocking in-app features, in-game currencies, premium content, and similar digital functionality must use Apple in-app purchase.
- Apple allows in-app purchase currencies to tip the developer or digital content providers.
- Purchased credits or in-game currencies may not expire.
- User-generated creator content must be moderated and follow App Store UGC rules.
- Kids Category apps cannot include purchasing opportunities or links unless behind a parental gate.

### Google Play

- Sold virtual currency for in-app digital goods generally requires Google Play Billing for Play-distributed apps.
- Earned or awarded points can be issued without Play Billing.
- Pure tips where 100% goes to the creator and no digital content, stickers, badges, or services are granted may be treated as peer-to-peer. Happy Paint tips should still use the safer in-app digital transaction model if the platform takes a fee or uses Drops.

### Children and Teens

- Avoid targeted ads.
- Avoid monetizing child data.
- Use guardian gates for purchases, public publishing, AI, contact discovery, and payouts.
- Keep spending limits and purchase history available to guardians.
- Provide refund/support flows.
- Make spending optional and non-predatory.

## Economy Safety Rules

No loot boxes:

- Do not sell randomized packs unless odds and local laws are reviewed.
- Prefer transparent bundles.

No pay-to-win:

- Drops cannot buy votes, event placement, moderation priority, or access to minors.

No pressure loops:

- Avoid streaks that pressure purchases.
- Avoid limited-time scarcity aimed at kids.
- Avoid dark patterns around bundles.

No cash-like claims:

- Do not imply Drops are an investment.
- Do not allow user-to-user currency transfers at launch.
- Do not allow off-platform trading.
- Do not allow refunds through informal moderator decisions.

## Product Surfaces

Wallet:

- Shows Drops and Kudos.
- Shows purchase history.
- Shows earned and spent activity.
- Shows guardian controls for child/teen accounts.

Store:

- Official packs.
- Featured community packs.
- Event bundles.
- Room themes.
- Storage/export tokens.

Creator Dashboard:

- My packs.
- Tips received.
- Kudos earned.
- Pending moderation.
- Asset performance.
- Payout status, hidden until eligible.

Admin:

- Currency ledger search.
- Purchase/refund review.
- Suspicious tips.
- Vote/tip brigading.
- Creator payout holds.
- Pack moderation.
- Guardian payout approvals.

## Backend Model

Suggested tables:

- `wallets`: profile_id, drops_balance, kudos_balance, creator_balance, locked_balance.
- `wallet_ledger_entries`: profile_id, amount, currency_type, direction, source, source_id, platform, idempotency_key, created_at.
- `drop_products`: sku, platform, drop_amount, price_cents, active.
- `purchase_receipts`: profile_id, platform, receipt_id, sku, amount, status, raw_payload.
- `asset_products`: asset_id, price_drops, creator_profile_id, platform_fee_bps, status.
- `tips`: sender_profile_id, receiver_profile_id, source_type, source_id, amount_drops, status.
- `creator_payout_accounts`: profile_id, guardian_profile_id, status, provider_account_id.
- `creator_payouts`: profile_id, amount_cents, status, provider_transfer_id.
- `economy_admin_actions`: actor_profile_id, action_type, target_table, target_id, note.

Ledger rules:

- The ledger is append-only.
- Balance changes derive from ledger entries.
- Every purchase receipt uses idempotency keys.
- Every tip has a sender, receiver, source, and moderation status.
- Paid Drops do not expire.
- Earned Kudos can be recalculated or removed for abuse.

## Launch Path

### Economy v0: Demo

- Add Drops/Kudos copy to product docs.
- Add wallet mock UI later.
- No real payments.

### Economy v1: Purchases Without Payouts

- Sell Drops through App Store / Google Play / web checkout.
- Spend Drops on official packs, room themes, extra storage, and export tokens.
- Tips convert into locked creator balance or Kudos.
- No cash-out.

### Economy v2: Tip-Supported Creator Packs

- Community packs can receive tips.
- Creator dashboard shows locked balance.
- Guardian approvals and payout terms are prepared.
- Admin can hold or reverse suspicious tips.

### Economy v3: Creator Marketplace

- Eligible creators can price packs.
- Adults and guardian-approved teen creators can cash out.
- Add tax, payout, chargeback, fraud, and takedown workflows.

## Recommendation

Use Drops as the main paid model, not subscriptions.

Keep any future recurring offer optional and secondary, such as classroom plans or storage bundles. The core consumer loop should be:

Create art -> save to Paint Space -> publish or use in rooms -> receive votes/Kudos/tips -> spend Drops on better tools and assets -> create more.

## Source Notes

- Apple App Review Guidelines, especially 1.2 UGC, 1.3 Kids Category, 3.1.1 IAP, and tipping with IAP currency: https://developer.apple.com/app-store/review/guidelines/
- Google Play Payments policy, especially sold virtual currency and tip handling: https://support.google.com/googleplay/android-developer/answer/10281818
- Roblox creator monetization and marketplace reference: https://create.roblox.com/docs/production/monetization and https://create.roblox.com/docs/marketplace/marketplace-fees-and-commissions
- FTC COPPA 2025 update: https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data
