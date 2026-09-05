# Drawesome monetization launch

The implementation is deliberately anonymous-first. With every value below
empty, drawing, rooms, invitations, saves, and games behave exactly as before.

## Family subscriptions

1. In Stripe, create one recurring product named **Drawesome Family** with:
   - monthly price: **$4.99 USD**
   - yearly price: **$39 USD**
2. Copy the `prod_...` id to `STRIPE_PRODUCT_FAMILY` and the two `price_...`
   ids to `STRIPE_PRICE_FAMILY_MONTHLY` and
   `STRIPE_PRICE_FAMILY_YEARLY`. The server verifies that both prices are
   active, USD, exactly 499/3900 cents, monthly/yearly, and belong to that
   product before checkout is enabled.
3. Put a restricted production secret in `STRIPE_SECRET_KEY`. It needs only the
   permissions used here: read Prices; read/write Customers, Checkout Sessions,
   Subscriptions, and Billing Portal Sessions. Keep sandbox and live keys,
   product/price ids, portal configuration ids, and webhook secrets strictly
   paired by mode.
4. Create a Stripe webhook for
   `https://drawesome.art/api/billing/webhook`, listening for:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.paused`
   - `customer.subscription.resumed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   Pin the endpoint to API version `2026-08-26.dahlia`, matching the server's
   Stripe client, and update both deliberately when upgrading Stripe.
5. Copy the webhook signing secret to `STRIPE_WEBHOOK_SECRET`.
6. Create a dedicated Customer Portal configuration that exposes only the two
   Drawesome Family prices, payment-method updates, and cancellation at period
   end, with quantity adjustment disabled. Put its `bpc_...` id in
   `STRIPE_PORTAL_CONFIGURATION_ID`; the server validates these safety settings
   before enabling checkout.
7. In Billing revenue recovery, enable Smart Retries, failed-payment emails,
   and automatic card updates. The app grants a three-day past-due grace period
   by default (`STRIPE_PAST_DUE_GRACE_DAYS`); the optional
   `STRIPE_PAST_DUE_GRACE_HOURS` value overrides it for finer control. Access
   never extends beyond the last paid period plus that grace.
8. Assign the correct digital-services tax category and enable Stripe Tax
   threshold monitoring. Leave `STRIPE_AUTOMATIC_TAX=false` until registrations
   are confirmed; then enable it to collect tax in Checkout.
9. Leave `STRIPE_ALLOW_PROMOTION_CODES=false` unless a campaign is planned. If
   enabled, constrain every promotion code by duration, redemption count,
   expiration, and first-time-customer rules in Stripe.
10. Set `FAMILY_TERMS_VERSION` to the version shown with the adult purchase
    attestation, then rebuild/restart the app.
11. Complete the test-mode Checkout, webhook, and Portal smoke tests, then set
    `STRIPE_CHECKOUT_ENABLED=true`. Turning the flag off later blocks only new
    purchases; webhooks, existing entitlements, and Portal management continue.

Checkout is adult-confirmed and hosted by Stripe. The application stores only
opaque Stripe ids, subscription state, adult-attestation timestamp/version,
processed webhook ids, and the PocketBase profile id in
`DATA_DIR/.billing.json`; it does not store card data or billing email. Writes
are atomic, and failed account-deletion cancellations stay in a durable retry
queue so an erased account cannot remain silently billed.

After Stripe returns to `/family`, the signed-in client confirms that exact
Checkout Session with the server. The server verifies both the owning profile
and Stripe customer before refreshing entitlement, so a delayed webhook does
not leave a paid family waiting. Webhooks remain the durable source of truth.
The admin overview shows catalog readiness, active/attention counts, the last
processed Stripe event, and any deletion-cancellation retries without exposing
keys or customer identifiers.

An active Family entitlement belongs to the signed-in owner of a private room.
Every anonymous or signed-in friend joining that room inherits its ad-free
status. Public communal rooms remain free/ad-supported.

## Advertising

Use Google Ad Manager only after the site and creatives are approved for a
child-directed experience. Create:

- a responsive display unit for the open chat panel (300x50, 300x100, 320x50);
- an H5 game manual interstitial unit (a limited-access format).

Set their full unit paths in `VITE_GAM_AD_UNIT_CHAT` and
`VITE_GAM_AD_UNIT_INTERSTITIAL`, then rebuild. Every GPT request is tagged as
child-directed, under-age-of-consent, non-personalized, and restricted-data-
processing. Empty unit paths mean the GPT script is never requested.

Interstitials are prefetched but can display only at natural breaks after at
least ten minutes: a save, PNG export, or completed Draw & Guess round. The app
also caps them at three per hour; Google applies its own fill and frequency
rules. No ad interrupts an active stroke or pauses the shared WebSocket room.

## Smoke test

- With all billing/ad variables blank: open a fresh private room anonymously,
  draw, invite another browser, save/export, and confirm there are no ad calls.
- With Stripe test keys: subscribe from `/family`, replay the webhook, reopen
  the owner's private room, and confirm both owner and guest receive
  `adFree: true` in the WebSocket `connected` payload.
- Create a signed-in public room and confirm it remains ad-supported even when
  its owner has Family.
- Use a Stripe test clock to exercise renewal success, payment failure, the
  past-due grace boundary, cancellation at period end, and webhook retries.
- With Google test inventory: open chat and confirm the sponsor slot; shorten
  `VITE_AD_BREAK_MINUTES` only in a local build to exercise natural breaks.
