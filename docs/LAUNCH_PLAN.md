# Drawesome: launch, demand validation, and cash discipline

Research date: **September 8, 2026**. Prepared from the current source, existing
monetization documents, a read-only production billing check, and the primary
sources linked below. **New spending: $0.** No outreach was sent, accounts changed,
ads purchased, or subscriptions enabled by this work. The owner's $50 limit is a
ceiling, not a spending target.

## Decision

Drawesome is worth a small, focused demand test. It is not yet a demonstrated
profitable business. The application already does enough to test whether people
enjoy creating together; the next uncertainty is repeated use and willingness to
pay, not whether another large feature can be built.

Lead with **“Make something together in ten minutes. Open a canvas, invite a
friend, and paint in your browser.”** The strongest initial experiment is an
adult-organized activity for friends and families: a shared coloring page, a
two-person doodle, or a short art-club warm-up. Teachers can evaluate the product
as adults before arranging any student pilot through their school's process.

Do not frame the service as a professional drawing replacement, a guaranteed safe
place for unsupervised children, or an AI education platform. Those claims exceed
what this launch can demonstrate. Keep the mission of supporting students and
teachers; earn the resources to pursue it through a useful, repeatable experience.

## What the market actually offers

These are product/pricing observations, not evidence of competitor profitability,
market size, or Drawesome's likely conversion rate. Prices may change.

| Alternative | Verified offer | Implication for Drawesome |
| --- | --- | --- |
| Magma | Free Spark lists 30 people per drawing, 60 layers and 1 GB storage. Blaze lists $9.99/month. `aggie.io` now redirects to Magma. | Free browser collaboration is already well served. Compete on getting a small group into an enjoyable activity quickly, rather than tool counts. [Pricing](https://magma.com/pricing), [Aggie redirect](https://aggie.io/) |
| Drawpile | Free, open-source simultaneous painting and animation, with a browser version including iPad support. | Being free and working in a browser are expectations, not a unique moat. [Drawpile](https://drawpile.net/) |
| Drawize | Free drawing/guessing entry point; a $9 three-day party pass for up to 20 people and a $29 three-day classroom pass for up to 40. Invited guests need no accounts. | An adult host paying for a whole group is an established offer structure. It still needs validation for Drawesome's free-form painting use case. [Premium plans](https://www.drawize.com/premium) |

The recommended niche is a hypothesis: **lightweight shared art time with people
you already know**. The coloring library supplies a useful answer to blank-canvas
hesitation. Show two cursors contributing to one finished drawing in a real
15–25 second demonstration, with captions. A screenshot of a busy toolbar does
not explain that benefit as quickly. Use only owner-created or explicitly
permissioned artwork; no children's names, live chat, or public invite codes in
promotional captures.

## Product and commercial readiness

The current code is more complete than several architecture/roadmap passages.
Use `src/App.jsx`, `src/components/HomePage.jsx`, `server.js`, and
`MONETIZATION.md` to check shipped behavior; `docs/pricing-tiers.md` is an older
proposal and must not become customer-facing pricing.

| Area | Observed state on this pass | Launch action |
| --- | --- | --- |
| Free experience | Anonymous drawing, private room codes, shared canvas, exports, and coloring sheets exist. Current server code can elect a temporary guest host for an unowned private room. | Prove create → invite → both draw → export on real target devices. Lead with this path. |
| Paid plan | Family code supports adult-attested Stripe checkout, portal management, durable webhook state, and ad-free benefits inherited by guests of the subscribed owner's private room. | Preserve the $4.99/month and $39/year offer while validating it; do not add four speculative tiers. |
| Production checkout | On September 8, `GET https://drawesome.art/api/billing/config` returned `configured:false`, with both monthly and yearly plans false. | Payments were unavailable at this check. Operator setup and Stripe test-mode lifecycle verification remain necessary; code existence is not live revenue. See `MONETIZATION.md`. |
| Paid differentiation | The implemented Family entitlement removes ads. Guest access and ordinary hosting are already available free. | Do not describe these free features as exclusive unlocks. When ads are absent, describe any support proposition honestly; do not create interruptions just to make removal valuable. |
| Search foundations | The server already generates route metadata, `robots.txt`, a sitemap, and social cards. Private join links are excluded from the sitemap. | Improve useful entry-page content and inspect actual indexing; buying an SEO tool or regenerating thousands of pages is unnecessary. |
| Measurement | Server analytics count drawing sessions, usage, saves, and operational activity. Anonymous analytics identifiers are per connection. | A connection is not a unique person. These data do not establish anonymous retention or an acquisition-to-payment funnel. Use aggregate pilot records below. |
| Claims and trust | Privacy and Account copy now describe session statistics, public previews and deletion limits. The previous scheduled-purge claim was only a local receipt, not a server job. | Keep marketing aligned with the implemented controls; do not claim total erasure or guaranteed safety. Resolve the deletion gaps below before classroom marketing. |

Revenue cannot be verified from public pages. This review did not access customer
billing, financial accounts, search-console data, or authenticated production
analytics. No current revenue, traffic, retention, operating-cost, or classroom
compliance claim is inferred.

Keep ads off during the initial adult pilot. Advertising needs approval and
operational work, and there is no measured fill or revenue baseline to put in a
profit model. A possible later offer is an adult-hosted activity package with
reusable original prompts and convenient session organization. Interview hosts
about that need before building it; it is not a shipped paid feature.

## Economics: illustrative assumptions, not a forecast

For a **US Stripe account accepting domestic cards**, this illustration assumes
2.9% + $0.30 payment processing and 0.7% Stripe Billing. Confirm the actual account
schedule; international cards, currency conversion, taxes, disputes and optional
products can add costs. [Stripe Billing and Payments pricing](https://stripe.com/billing/pricing)

Our calculation is `price × (1 − 0.029 − 0.007) − 0.30`:

| Plan | Gross charge | After assumed payment + Billing fees | Monthly equivalent |
| --- | ---: | ---: | ---: |
| Monthly | $4.99 | $4.5104 | $4.5104 |
| Annual | $39.00 | $37.2960 | $3.1080 |

Annual payment helps near-term cash but sells twelve months of service. Do not
treat all annual receipts as money available to spend immediately.

Illustrative planning allowances: $25/month fixed cash overhead, $0.25 per active
paying host/month incremental service cost, and a reserve equal to 5% of gross
revenue. These are deliberately explicit placeholders, **not measured costs**.
The $25 must eventually include the cost of serving free users, electricity,
domain renewal, backups, hardware replacement and any other actual obligations.
Paid AI usage is $0 in this model. A 5% reserve is a budgeting choice, not a
prediction of refunds or a substitute for tax reserves.

| Illustrative result | All monthly subscribers | All annual subscribers, allocated by month |
| --- | ---: | ---: |
| Contribution per paying host after fees, 5% reserve and $0.25 allowance | $4.0109 | $2.6955 |
| Cash break-even at $25 fixed cost | 7 subscribers | 10 subscribers |
| Monthly cash remainder at 25 subscribers | $75.27 | $42.39 |
| Remainder after also valuing 4 operator hours at $20/hour | −$4.73 | −$37.61 |
| Subscribers covering that overhead, labor allowance, and a further $20/month tool budget | 32 | 47 |

Those subscriber counts are arithmetic targets, not an estimate of how many
visitors will convert. Free users, abuse, storage growth, support and outages can
change the cost model materially. Self-hosted means there may be no hosting
invoice; it does not mean the service has no costs.

Use this decision formula with actual records:

`Monthly operating remainder = earned subscription revenue − processing fees − refunds − service costs − moderation/support labor − overhead`.

Keep taxes and undelivered annual service obligations reserved. Reinvest in paid
AI tools only after two consecutive months of positive remainder and enough cash
to cover the next three months of committed service costs. Then cap new recurring
tools at 25% of the smaller month's positive remainder. This is a suggested cash
policy, not accounting or tax advice. Do not add usage-based AI calls to every
stroke, guest, or export; an uncapped free feature can erase a small margin.

## Thirty-day experiments: $0 cash, bounded operator time

Target eight hours of operator time for the whole first cycle, excluding fixing
confirmed product bugs. All numbers below are chosen experiment targets, not
industry benchmarks. Target adults; do not recruit children directly or collect
student rosters. Drafts below are ready for owner review, not already published.

| When | Experiment and deliverable | Time cap | What it should establish |
| --- | --- | ---: | --- |
| Days 1–3 | Run three two-device sessions: desktop + phone, iPad/Safari + another device, and Chromebook if available. Create a private room, copy the invite, draw on both, disconnect/rejoin, and save/export. Make one original demo capture. | 90 min | Both painters can participate and keep their work. Log failures and fix them before a larger invitation. |
| Days 4–10 | Invite five adult organizers through existing relationships or an explicitly permitted community feedback thread. Ask each to try a ten-minute session with another consenting adult. Teachers test without students first. | 90 min | Watch whether the invitation and first shared drawing are understandable; record unprompted confusion. |
| Days 11–17 | Publish one useful, owner-reviewed resource on the existing parent/teacher entry page: “Three ten-minute collaborative drawing activities,” with real screenshots and exact steps. Share one demonstration on an existing owner-controlled social account and at most two relevant, promotion-permitted community threads. | 120 min | Determine whether the activity, not a feature list, produces an actual completed session. |
| Days 18–24 | Ask consenting pilot organizers whether they chose to repeat a session within seven days and which activity they repeated. Show the real Family description and price. If checkout is ready and verified, offer it without incentives; otherwise record interest separately from sales. | 90 min | Establish voluntary repeat use and willingness to pay for the benefit actually offered. |
| Days 25–30 | Review results, costs, support time and product failures. Optional: prepare one Product Hunt launch only if the pilot works and the owner has an eligible account. | 90 min | Choose one audience/use case to continue, revise the offer, or stop acquisition work. |

Channel execution:

- **Existing relationships:** a relevant parent, adult art-club organizer,
  librarian, or teacher the owner already knows. Request feedback on a concrete
  activity. No scraped contacts, school bulk mail, or unsolicited child outreach.
- **Communities:** contribute in a community where the owner actually
  participates; use its designated showcase/feedback thread and disclose being
  the maker. Reddit prohibits repeated or unsolicited mass engagement and points
  users to community-specific rules. Permission for one community does not cover
  another. [Reddit spam policy](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)
- **Search:** publish the three original activities below on existing relevant
  routes before creating new ones. Have the owner inspect the sitemap in Search
  Console using an existing verified property, or verify via an available
  non-DNS method themselves. Sitemap submission helps discovery but is not a
  ranking or indexing guarantee. Google recommends useful original content,
  rather than mass-produced pages made to attract searches.
  [Sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap),
  [Content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- **Product Hunt:** optional developer/maker feedback, lower priority than adult
  activity hosts. Regular launches are free; promoted placements are separate.
  The current account rule requires a personal account at least one week old.
  Do not buy votes, followers, reviews, or a launch package.
  [Free launches](https://help.producthunt.com/en/articles/1444961-how-do-i-get-my-product-promoted),
  [Account rules](https://help.producthunt.com/en/articles/771527-personal-account-vs-company-account)

No paid ads, SEO subscriptions, social scheduling subscriptions, contests with
cash prizes, or app-store fees are needed for this experiment. Keep the full $50
unspent while the revenue and retention questions are unresolved.

## Measurement and decisions

Use an aggregate weekly tally, with a separate voluntary adult pilot cohort. Do
not add persistent child identifiers, cross-site trackers, or personal
information to invite URLs just to measure growth. Record outreach source in the
owner's tally or ask adults where they heard about it; do not pretend arbitrary
UTM tags are already captured by the current server analytics.

Definitions:

- **Qualified trial:** an adult organizer attempts a real activity with another
  participant. Exclude development/test clients and duplicate retries.
- **Activation:** both participants make visible marks in the same private room
  within two minutes of the organizer pressing Start, with no assistance from the
  maker.
- **Completed activity:** both contribute and successfully save/export once.
- **Seven-day repeat:** the organizer voluntarily runs another shared session
  within seven days; ask only adults who agreed to that follow-up. Report
  `repeated / eligible organizers`, not a percentage with an unknown denominator.
- **Paid conversion:** a real, successful, non-refunded adult subscription for the
  stated benefit. A survey “yes,” sign-in, checkout click or test payment is not a
  sale. Thirty days cannot establish long-term churn or lifetime value.

Weekly tally columns:

`Week | source | qualified trials | activated | completed | repeat-eligible | repeated | adults shown offer | paid subscribers | refunds | cash cost | operator minutes | top failure`.

Decision thresholds for this pilot:

1. **Before broader sharing:** all three scripted device sessions must complete
   without lost artwork, and at least 4 of the first 5 independent adult pairs
   should activate without the maker steering. If not, fix onboarding/reliability
   and rerun only the failed path.
2. **Retention signal:** aim for at least 3 of the first 10 eligible organizers
   repeating within seven days. Fewer than 10 is inconclusive; fewer than 3 repeats
   means interview those who stopped and revise the activity before expanding.
3. **Commercial signal:** after at least 10 independent adult organizers have
   completed an activity and seen the actual offer, aim for 3 genuine paying
   organizers, including at least one outside the owner's immediate circle.
   This is an early signal, not profitability or product-market fit. If checkout
   stays unavailable, the revenue experiment remains incomplete.
4. **Stop and repair:** any reproducible lost-art defect, exposed private-room
   content, broken cancellation, or unresolved serious abuse report pauses new
   promotion of the affected flow until addressed.
5. **Stop spending effort on a channel:** after its allotted time, zero qualified
   trials means pause that channel. A failed audience/offer gets one small revised
   test; do not respond by buying traffic or building a broad platform.

## Ready-to-review copy for adult channels

**Short demo post**

> I built Drawesome so friends can paint on the same canvas in a browser. Open a
> private room, send the invite, and make a small drawing together—guests do not
> need accounts. Try a ten-minute doodle with someone you know:
> https://drawesome.art
>
> I'm looking for feedback from adult organizers. Was it easy to get both people
> drawing, and could you save the result? I'm the maker, and this is an early
> product, so honest reports of what broke are useful.

**Personal invitation to a teacher or club organizer already known to the owner**

> I've built a shared browser canvas called Drawesome and would value your view
> as an adult activity organizer. Would you try it with another adult for ten
> minutes? Guests can draw without accounts. I'd like to learn whether the join
> link, drawing tools and export are clear before proposing student activities.
>
> A simple prompt: each person adds an imaginary plant to one shared garden.
> Product details are at https://drawesome.art/parents. Please use your school's
> usual approval process before involving students. No need to send student
> names or artwork; feedback about the workflow is enough.

**Family plan description, only after billing is enabled and tested**

> Drawesome Family is an optional subscription owned by an adult: $4.99/month or
> $39/year. It removes advertising from your account's private rooms for everyone
> you invite. Drawing and joining stay free; guests do not need subscriptions.
> Manage or cancel renewal through the billing page. Details:
> https://drawesome.art/family

Do not claim ads are currently present unless verified. If promoting voluntary
support while ads are absent, say so plainly rather than implying an immediate
functional upgrade. Do not imply charitable tax deductibility, guaranteed school
outcomes, or that future AI tools are included in today's subscription.

**Three original activity cards**

1. **Shared garden, ten minutes:** one person draws stems; the other invents
   flowers. Swap roles halfway through, add a creature together, and export the
   garden. Both people work on the same picture.
2. **Two-color city, ten minutes:** each participant chooses one color and adds
   buildings, paths and vehicles. Join two drawings with a shared bridge. A host
   can use this to discuss how people coordinate a plan.
3. **Color together, ten minutes:** select an owner-provided coloring sheet,
   choose a small palette together, and color different areas. Save the result
   before changing the sheet, since changing the room sheet can clear artwork.

## Do no harm, in this launch

Do not label a code-shared room as access-controlled against everyone: people who
receive its link/code can attempt to join, and host availability matters. Keep
basic drawing, invitations, moderation tools and deletion available free. Offer
short activities with a satisfying finish rather than pressure to preserve a
streak or keep painting indefinitely. Obtain permission before publishing other
people's artwork; do not use live user material as an advertisement by default.

Anonymous access reduces friction but does not itself settle child-privacy
requirements. The FTC includes persistent identifiers in its guidance and
describes limits on school authorization; its 2025 rule changes address data
retention and third-party disclosures. Before a student deployment or ad rollout,
map the actual data practices and required notices/consents to that use case.
This review does not certify COPPA or FERPA compliance. Marketing should state
specific implemented controls and their limitations.
[FTC compliance guidance](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions),
[FTC rule update](https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data)

The immediate owner decisions are operational: finish and verify existing billing
when ready, confirm the support/safety mailboxes receive mail, identify the first
five adult organizers, and record actual costs. No purchase is required to start
the free pilot. A profitable, useful service is the objective; repeat usage,
successful payments and measured costs are the evidence needed to claim it.

## Verified deletion limits: priority before classroom marketing

Follow-up source inspection of `src/utils/accountDeletion.js`, `server.js` and
`server/billing.js` found important limits that the former customer copy hid:

- Guest deletion clears selected local stores but makes no server deletion
  request. Guest server saves and shared-room content remain. Several browser
  identifiers/preferences are outside the explicit wipe list.
- Signed-in deletion removes account-owned server art and wall posts and invokes
  account deletion, but does not remove the person's strokes from shared canvas
  history. Durable chat-audit redaction replaces the name/message but retains the
  opaque account identifier; loaded room buffers are redacted using currently
  connected session identifiers. The handler does not sweep historical chat from
  every offline room file, and report context copies are not scrubbed there.
- Account-linked analytics are detached/redacted; usage totals and session
  records are not all erased. Analytics limits are count-based, not a uniform
  time-to-deletion policy.
- The default 90-day chat-log sweep is based on the whole log file's last
  modification time. It does not guarantee that every message in an active log,
  persisted room buffer or report is gone after 90 days.
- The client records a local `scheduled_purge_at` date, but the current flow has
  no matching scheduled server purge. Customer copy now labels this a deletion
  attempt, without promising a later full wipe. Billing cancellation has a
  separate durable retry process.

The privacy and Account panel changes disclose these boundaries; they do not
repair the underlying deletion coverage. Treat complete data mapping, explicit
retention decisions, and verifiable server erasure for stored personal content
as prerequisites to actively recruiting classrooms. Do not turn a public-code
review into a privacy-compliance certification or promise an automatic future
cleanup that does not exist. Continue small adult-only product evaluation while
these issues are addressed.
