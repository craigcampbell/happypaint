# Drawesome monetization launch

The implementation is deliberately anonymous-first. With every value below
empty, drawing, rooms, invitations, saves, and games behave exactly as before.

## Family subscriptions

1. In Stripe, create one recurring product named **Drawesome Family** with:
   - monthly price: **$4.99 USD**
   - yearly price: **$39 USD**
2. Copy the two `price_...` ids into `.env` as
   `STRIPE_PRICE_FAMILY_MONTHLY` and `STRIPE_PRICE_FAMILY_YEARLY`.
3. Put the restricted production secret in `STRIPE_SECRET_KEY`.
4. Create a Stripe webhook for
   `https://drawesome.art/api/billing/webhook`, listening for:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the webhook signing secret to `STRIPE_WEBHOOK_SECRET`.
6. Enable/configure Stripe's Customer Portal so parents can cancel and update
   payment details, then rebuild/restart the app.

Checkout is adult-confirmed and hosted by Stripe. The application stores only
opaque Stripe ids, subscription state, and the PocketBase profile id in
`DATA_DIR/.billing.json`; it does not store card data or billing email.

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
- With Google test inventory: open chat and confirm the sponsor slot; shorten
  `VITE_AD_BREAK_MINUTES` only in a local build to exercise natural breaks.
