# Drawesome — Membership Tiers (PROPOSAL)

Status: **proposal only.** No live billing ships until Craig signs off (standing
decision: real-money economy stays off). Everything here lands behind an
entitlement flag (`users.tier` in PocketBase) so tiers can be granted manually
for testing long before payments exist.

Positioning: *the place where people who love to draw find each other and make
stuff* — a fun-first Toon Boom alternative. Free tier must stay genuinely great
(it's the top of the funnel and the kid-safety story); paid tiers sell
**capability and capacity, never safety**. Safety features are never paywalled.

## The ladder

| | 🎨 **Doodler** (free) | ✨ **Studio** | 🎬 **Animator** | 🏢 **Crew** (per-seat) |
|---|---|---|---|---|
| Who it's for | Kids + everyone starting out | Teens getting serious | Young pros / creators | Small teams, classrooms |
| Price (placeholder) | $0 | ~$4/mo | ~$12/mo | ~$8/seat/mo (min 3) |
| Public rooms | ✅ all | ✅ | ✅ | ✅ |
| Private friends rooms | 1 active | 5 active | Unlimited | Unlimited + team space |
| Gallery saves | 20 | 200 | 1,000 | Pooled |
| **Animation playground (public)** | ✅ play, 12 frames | ✅ | ✅ | ✅ |
| **Private animation rooms** | — | 1 room, 48 frames, 2 tracks | 10 rooms, 240 frames, 6 tracks | Pooled, priority resources |
| Tracks (bg / fx / storyboard) | playground only | art + 1 | all types | all types |
| **Audio track upload** | — | — | ✅ 3 min, 10MB, licensed-content policy | ✅ |
| Export | PNG, GIF w/ watermark | PNG, GIF | + MP4 1080p, no watermark | + batch export |
| **Vector tools** | — | ✅ in private rooms | ✅ everywhere private | ✅ |
| **Brush pack import (.abr/.brushset)** | — | — | ✅ | ✅ shared team library |
| Onion skin | ✅ everywhere | ✅ | ✅ | ✅ |
| Profile page + gallery sharing | ✅ (opt-in, teen+) | ✅ + themes | ✅ + portfolio mode | ✅ |
| Storage quota | 100 MB | 1 GB | 10 GB | 10 GB/seat |

## Why caps are shaped this way (resource math)

Self-hosted single machine. The costly resources are:
- **RAM/disk per animation room**: each frame×track is its own op history. MAIN
  hit 17 MB of JSON for ONE canvas; a 240-frame×6-track room could be orders of
  magnitude more. Frame/track caps ARE the infrastructure budget.
- **Audio files**: pure storage + copyright exposure → Animator+ only, small caps,
  clear DMCA/licensed-content policy, scan-on-upload later.
- **MP4 compositing**: CPU-bound (ffmpeg) → paid tiers only, queued, one at a time.

## Guardrails
- **Kids' accounts never see upsells mid-drawing.** Upgrade surfaces live on the
  site pages (profile, room-create limits), never in the studio canvas.
- Tier flags: `users.tier ∈ {free, studio, animator, crew}` + `users.tierUntil`
  (manual grants now, billing later). Server enforces caps; client only decorates.
- Watermark on free GIF exports is the `drawesome.art` mark — tasteful, corner.
- Education/family discount decision deferred until billing provider chosen.

## Open product decisions (Craig)
1. Price points (the $4/$12/$8 are placeholders).
2. Tier names (Doodler/Studio/Animator/Crew are placeholders — could be paint-ier).
3. Whether the public animation playground allows exports at all (virality vs. cost).
4. Age gate interaction: paid accounts imply payment-holder is an adult — does a
   parent-managed "family" bundle come before Crew?
5. Billing provider (Stripe vs. Paddle vs. LemonSqueezy — Paddle/LS handle VAT as
   merchant-of-record, simpler for a solo operator).
