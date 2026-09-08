# Drawesome launch review — September 8, 2026

The app is ready for a small adult-led product test, not a claim of profitability
or a broad classroom rollout. This pass spent **$0**, changed local code, and
prepared a [cited launch plan](LAUNCH_PLAN.md). No external promotion, deployment,
account changes, or real payments were made during the original audit.

**Deployment update:** the owner subsequently authorized deployment. The reviewed
build is now live at https://drawesome.art, with billing and experimental snapshots
still disabled. See [the deployment record](DEPLOYMENT_2026-09-08.md).

## Improvements implemented

| Area | Problem and resulting change |
| --- | --- |
| Homepage performance | The homepage eagerly downloaded the entire studio and every route. `src/Router.jsx` now loads those routes on demand, with loading and recoverable error screens. |
| Live previews | The homepage allocated a full-size painting canvas and opened a spectator socket below the fold. Both now start near the viewport and stop when offscreen or hidden. |
| Phone invitation | The main phone view hid invitations inside other panels. A visible Invite button now shares the current room; notifications remain in Tools. |
| Accessibility | Public pages allow browser zoom/context menus; the mobile menu supports Escape, and the public-room dialog contains keyboard focus. |
| Conversion | The homepage explains shared art time and the invite steps. The parents page has three concrete free activities. Account links respect cloud availability. |
| Billing experience | Unavailable Family checkout no longer sends guests into sign-in or shows server setup instructions. A working free private-canvas action remains available. Free room creation and guest access are described accurately. |
| Offline use | The service worker now stores the actual app shell and entry dependencies. A previously visited studio can reopen offline. The worker caches only same-origin static assets, excluding APIs, billing, ads and user art. Realtime collaboration still requires a connection. |
| Server resilience | JSON primitives can no longer crash the WebSocket message handler. Missing JS/assets return 404, and stable filenames such as the service worker revalidate rather than caching immutably for a year. |
| Safety and privacy claims | Site pages, deletion messages, SEO and FAQ structured data now describe actual moderation, public previews, storage and deletion limits. An unimplemented scheduled full purge is no longer promised. |

## Measurements and verification

Compared with the working tree at the start of this review, using production
Vite builds with cloud accounts and ad-unit variables empty:

| Build output | Before | After |
| --- | ---: | ---: |
| Initial JavaScript, minified | 621.20 KB | 170.32 KB including shared JSX runtime |
| Initial JavaScript, gzip estimate | 189.52 KB | 55.24 KB |
| Shared CSS, minified | 216.59 KB | 218.77 KB |

This is about **73% less initial JavaScript**, not a claim of a 73% faster page
or a measured improvement in field Core Web Vitals. The studio's tools still
download when a canvas is opened. The large shared CSS remains an optimization
opportunity. The moderation model remains separate and is not a first-view
homepage download.

- `npm run build`, zero-warning `npm run lint`, and `node --check server.js`: pass.
- `node scripts/launch-ui-verify.mjs`: **22 checks pass** in real Chromium with
  isolated server data and no accounts. Covers 375px/1440px layouts, deferred
  preview/socket lifecycle, two-browser painted-stroke relay, visible phone
  invitation and correct URL, PNG export, unavailable billing/free fallback,
  offline reopening, and absence of ad/account service requests.
- `node scripts/launch-reliability-verify.mjs`: **31 checks pass** in isolated
  anonymous and mock-auth servers, including malformed messages, asset caching,
  and experimental snapshot validation/default-off behavior.
- `node scripts/seo-verify.mjs`: **30 checks pass**, including factual structured
  data, private route indexing, public post cards and hostile title/path handling.
- `npm run test:family`: entitlement and billing-hardening integration suites pass.
- `npm audit --omit=dev`: reports **0 known production dependency vulnerabilities**
  at the time of this review. This is not a security certification.

Screenshots and the UI result JSON are generated in `output/playwright/`.
The OS share sheet is replaced by a test stub; invitations were not sent to
anyone. Drawing relay and PNG download use the actual application behavior.
Native iPad/Safari pressure handling, production payment lifecycle and
high-concurrency load were not revalidated in this pass. The brush engine was
not modified by this review.

## Launch blockers and limits

1. **No live checkout:** the production billing configuration reported disabled
   monthly/yearly plans. Complete the existing operator-run setup and test flow
   in `MONETIZATION.md` before advertising a purchasable subscription.
2. **Deletion coverage needs engineering:** guest server saves, some historical
   chat/report copies and shared content are outside complete erasure. See the
   explicit findings in `LAUNCH_PLAN.md`. Correct wording does not repair those
   mechanics. Address them before actively recruiting classrooms.
3. **Demand and costs are unproven:** adult repeat sessions, genuine paid uptake,
   real service costs and support time must establish viability. Existing
   anonymous connection counts cannot establish unique-user retention.
4. **Experimental snapshot optimization:** the snapshot experiment captures
   live pixels with an unreliable operation watermark. This review hardens its
   transport and leaves it disabled unless `ENABLE_CLIENT_SNAPSHOTS=1`. Keep that
   variable unset. Deterministic snapshots from an authoritative frozen operation
   list are needed before enabling it; ordinary history replay stays available.
5. **Released, demand unverified:** the reviewed build was deployed and verified
   on September 8; production uptime, return sessions, and paid demand still
   require observation before a broad launch or profitability claim.

The independent launch commit passed build, lint and 22 browser checks before
integration. The subsequent uncommitted-work review corrected unsafe animation
resizing and settings omission, then integrated the brush, replay, export, and
server changes. The combined build passes 24 browser checks, including pixel
preservation through animation toggles. See [INTEGRATION_REVIEW.md](INTEGRATION_REVIEW.md)
for scope, validation, and the remaining snapshot limitation.

The practical next experiment is five adult organizers trying a ten-minute
shared art activity, followed by a second session within a week. The launch plan
contains ready-to-review outreach copy, measurements, a $0 schedule, and explicit
stop/reinvest criteria. No paid acquisition is justified by the evidence yet.
