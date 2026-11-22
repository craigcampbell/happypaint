# Drawesome monetization launch

The implementation is deliberately anonymous-first. With every value below
empty, drawing, rooms, invitations, saves, and games behave exactly as before.

## Family subscriptions

1. In Stripe, create one recurring product named **Drawesome Family** with:
   - monthly price: **$2.99 USD**
   - yearly price: **$15 USD**
2. Copy the `prod_...` id to `STRIPE_PRODUCT_FAMILY` and the two `price_...`
   ids to `STRIPE_PRICE_FAMILY_MONTHLY` and
   `STRIPE_PRICE_FAMILY_YEARLY`. The server verifies that both prices are
   active, billed per unit in USD, and belong to that product. The Family
   page shows the verified price. An invalid or unavailable catalog suppresses
   the price and disables checkout.

   To move an existing $1.99 monthly offer, add a new $2.99 monthly Price
   to the same Stripe product, update the portal configuration’s allowed
   monthly Price and `STRIPE_PRICE_FAMILY_MONTHLY`, then restart. Existing
   subscriptions keep their original price, including after the old price is
   archived. A deployment still pointing to $1.99 will display and charge
   $1.99. Check checkout, renewal and cancellation in Stripe test mode first.
   [Stripe pricing guide](https://docs.stripe.com/products-prices/manage-prices#edit-a-price)
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

A signed-in subscriber paints ad-free in any drawing room. Private rooms owned
by subscribers also give every invited painter ad-free drawing and the Art
postcard export. The server sends each member their individual `adFree`
status and the separate `familyRoom` flag, including after webhook changes.
Other visitors to a public room keep the ordinary free experience.

## Custom coloring pages

The owner of a private Family drawing room can describe a scene in **Coloring
sheets**, preview the generated line art, and download a PNG or apply the page
for everyone in the room. Creating a preview uses one of five pages per
Family owner per UTC calendar month, shared across their rooms. There is also
a ceiling of twelve generation attempts in that month, including rejected
or interrupted requests. Downloading or applying an existing page is free.

Set `OPENROUTER_API_KEY` and `AI_COLORING_ENABLED=true` in the server
environment, then recreate the app container to apply them. The provider
account pays for generation and safety reviews. The default image model
is Grok Imagine Image 2.0. `AI_COLORING_MODEL` can select another model
that supports the same OpenRouter image request. The standard library
works with all three settings unset.

The server checks the submitted description, generates one image, and checks
its content before releasing a page. Only the description and generated image
are used for these calls. Drawesome keeps the resulting page and usage data
under `DATA_DIR`. The submitted description is omitted from the stored
record. [OpenRouter image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)

## Advertising

Use Google Ad Manager only after the site and creatives are approved for a
child-directed experience. Create:

- a display unit for the free-room canvas banner (300x50, 300x100 or 320x50);
- an H5 game manual interstitial unit (a limited-access format).

Set their full unit paths in `VITE_GAM_AD_UNIT_CHAT` and
`VITE_GAM_AD_UNIT_INTERSTITIAL`, then rebuild. The existing `CHAT` variable now controls the
banner above the canvas. It appears when inventory fills in a connected,
ad-supported room. Private Family rooms, finger-paint rooms, sketchbook pages
and local drawing skip this placement. Every GPT request is tagged as
child-directed, under-age-of-consent, non-personalized, and restricted-data-
processing. Empty unit paths mean the GPT script is never requested.

Set `GAM_ADS_TXT_PUBLISHER_ID` to the full `pub-` ID from Ad Manager so
the server serves `google.com, <id>, DIRECT, f08c47fec0942fa0` at `/ads.txt`.
[Google's ads.txt setup guide](https://support.google.com/admanager/answer/9422161)
Unset, `/ads.txt` returns 404 and no inventory is claimed on the domain.

Interstitials are prefetched but can display only at natural breaks after at
least ten minutes: a save, PNG export, or completed Draw & Guess round. The app
also caps them at three per hour; Google applies its own fill and frequency
rules. No ad interrupts an active stroke or pauses the shared WebSocket room.

## Smoke test

- With all billing/ad variables blank: open a fresh private room anonymously,
  draw, invite another browser, save/export, and confirm there are no ad calls.
- With Stripe test keys: subscribe from `/family`, replay the webhook, reopen
  the owner’s private room, and confirm both owner and invitee receive
  `adFree: true` and `familyRoom: true` in the WebSocket `connected` payload.
- In a public room, confirm the subscriber receives `adFree: true`, another
  visitor receives `adFree: false` and both receive `familyRoom: false`.
- Use a Stripe test clock to exercise renewal success, payment failure, the
  past-due grace boundary, cancellation at period end, and webhook retries.
- With Google test inventory: join an ordinary free room and confirm the banner above the canvas; shorten
  `VITE_AD_BREAK_MINUTES` only in a local build to exercise natural breaks.
- `node scripts/price-ads-verify.mjs`, isolated boot that asserts the served
  Family prices, the `/ads.txt` 404-when-unset / GAM-line-when-set gate, and
  that no stale price leaks into the `/family` HTML.
