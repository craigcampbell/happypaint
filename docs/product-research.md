# Happy Paint Product Research

Research pass date: 2026-06-15

## Executive Take

Happy Paint should not try to beat Procreate, Clip Studio Paint, or Krita on professional depth. It should win by combining a fast-enough real drawing app with youth-native social creation:

- Draw well enough that people who care about art do not feel trapped in a toy.
- Make rooms easier and safer than professional collaboration tools.
- Turn finished art into reusable personal assets: memes, stickers, animated loops, brushes, palettes, templates, and room props.
- Make discovery about topics, events, rooms, and gallery posts, not public people search.
- Monetize cloud value, premium creative tools, asset packs, storage, exports, classroom/family controls, and creator economies. Avoid monetizing basic drawing or safety.

The biggest missed opportunity is a personal asset and identity layer: "Paint Spaces." This would be the user's creative locker, profile, and reusable kit library. It can hold memes, stickers, loops, brush packs, palettes, templates, room themes, saved prompts, and remix history. That becomes the bridge between solo drawing, collaboration rooms, events, gallery voting, and monetization.

## Research Process

Repeat this every 6 to 8 weeks while the product is young.

1. Desk research
   - Review top drawing, animation, social drawing, template, and UGC tools.
   - Track pricing, free limits, collaboration features, sharing loops, and creator economies.
   - Scan App Store and Play Store reviews for recurring pain: lost work, subscriptions, ads, weak animation, missing layers, poor performance, account friction.

2. User observation
   - Run 5 to 8 sessions with ages 11-14, guardian-approved.
   - Run 5 to 8 sessions with ages 15-18.
   - Run 5 to 8 sessions with ages 19-30.
   - Observe first-drawing, first-room, first-share, and first-remix behavior.
   - For under-13 research, use guardian consent and avoid collecting unnecessary personal data.

3. Prototype cycles
   - Build tiny feature spikes in the browser first when possible.
   - Move performance-sensitive drawing interactions into native mobile once the interaction is proven.
   - Measure first stroke latency, stroke FPS, room join time, invite acceptance, and export completion.

4. Product council
   - Every candidate social, AI, or community feature gets a safety review before build.
   - Every monetized feature gets a "does this make the free app worse?" review.
   - Every performance-sensitive feature gets a device/network budget.

## Market Map

### Real-time collaborative drawing

| Product | What it proves | Notes for Happy Paint |
| --- | --- | --- |
| Magma | Artists will pay for collaboration, storage, larger canvases, layers, version history, voice/chat, and team admin. Free plan supports real-time drawing with meaningful limits. | We need easy rooms, role seats, version history, and storage tiers, but with a friendlier youth surface and stronger kid safety. |
| Drawpile | Free/open-source multiplayer drawing can serve serious artists, including animation, across desktop/Android/web. | There is demand for simultaneous drawing, but setup and UI can be more technical than the target audience wants. |
| Figma/FigJam-like behavior | Multiplayer cursors, comments, sticky notes, and reactions make collaboration legible. | Viewer reactions and lightweight comments can make rooms feel alive without giving everyone drawing rights. |

### Serious drawing and painting apps

| Product | What it proves | Notes for Happy Paint |
| --- | --- | --- |
| Procreate | One-time-purchase, high-performance drawing with layers, imports, custom/imported brushes, timelapse, effects, animation assist, and broad export formats is a gold standard. | We need layers, selection/transform, fill, text, timelapse/replay, and strong brush feel eventually. We should not clone every pro feature. |
| Clip Studio Paint | Deep feature depth: comics, animation, 3D references, material marketplace, asset management, and creator content. | Community brushes/assets are a major unlock. We can simplify this into curated packs and Paint Spaces. |
| Krita | Free tools can still be professional: layers, brush engines, resource bundles, animation timeline, onion skinning, PSD support. | Advanced users will expect layers, animation, brush bundles, and export compatibility even in a youth-friendly app. |
| ibisPaint | Mobile-first drawing can combine an app, online gallery, timelapse/process sharing, brush QR codes, and affordable subscription. | The community/process layer matters. Happy Paint should make process and remix shareable by default. |
| Adobe Fresco | Live brushes and realistic media can be a differentiator. | A few delight brushes can matter more than hundreds of generic brushes. |
| Concepts | Infinite canvas, editable vector strokes, objects, and cross-platform subscription are valuable for thinking/sketching. | Infinite collaborative idea boards could be a future mode, but not the initial drawing hot path. |

### Animation and meme creation

| Product | What it proves | Notes for Happy Paint |
| --- | --- | --- |
| Procreate Dreams | Frame-by-frame, keyframing, performance-based animation, video/audio import, and one-time purchase are compelling. | Happy Paint should start with "tiny loops," not full animation studio complexity. |
| FlipaClip | Beginners and young creators understand frame-by-frame animation, onion skin, frames viewer, and short animated export. | Four-frame and eight-frame loop rooms are an obvious wedge. |
| CapCut | Templates and AI-assisted video tools train users to expect instant shareable output. | We need templates, remix slots, exports, and AI assist that produce share-ready assets. |

### Social drawing games

| Product | What it proves | Notes for Happy Paint |
| --- | --- | --- |
| Gartic Phone | Friends enjoy writing prompts, drawing, guessing, and watching hilarious results together. | We should add room modes where art has a game loop: prompt relay, coloring book, remix chain, vote battle. |
| Skribbl.io | Instant browser rooms and simple draw/guess loops still work. | Joining should be nearly frictionless, but safety and moderation need to be stronger. |
| Gartic.io / Drawize | Themes, custom rooms, private rooms, classroom/event positioning, and large group play are useful. | Timed events and teacher/club modes are viable revenue paths. |

### Community and asset economies

| Product | What it proves | Notes for Happy Paint |
| --- | --- | --- |
| Clip Studio Assets | Searchable, downloadable, publishable materials with free and paid/point economies can create deep lock-in. | Community brushes, stamps, palettes, templates, and room themes should be first-class. |
| Pixilart | A creation tool plus public gallery, profiles, likes/comments/follows, trending/staff picks, and mobile app can build community. | Public discovery should emphasize art and events, not people search for minors. |
| ibisPaint gallery | Process sharing and collaborations matter. | Room replays and timelapse exports could become a signature social mechanic. |
| Roblox UGC | Young users understand earning, spending, identity, and creator status through digital assets. | A creator economy is powerful but should be late-stage, age-gated, moderated, and payout-compliant. |

### Adjacent youth creator products

| Product | What it proves | Notes for Happy Paint |
| --- | --- | --- |
| Canva | Templates, AI, social formats, brand kits, and subscriptions turn casual creators into repeat creators. | Happy Paint needs templates and reusable kits, not just blank canvas. |
| CapCut | People want fast, culture-ready exports and AI-assisted templates. | Animated meme and sticker export is more important than a perfect professional timeline at first. |
| Discord Activities | Friends discover and use lightweight multiplayer apps where they already hang out. | A Discord Activity version of room preview or drawing games could be a major acquisition wedge. |

## Current Happy Paint Position

Already covered:

- Fast web canvas hot path and Skia-native drawing surface.
- Browser studio and native mobile app.
- Invite rooms, share links, planned sessions.
- Discovery hub with room topics/tags, events, gallery voting.
- Host-configured artist/viewer roles.
- Admin moderation, room monitoring, bans, network controls.
- Kid-safe, friends, and future 18+ room gates.
- Backend schema for sessions, discovery snapshots, events, gallery posts, votes, and admin audit.

Current critical gaps:

- No layers yet.
- No selection, transform, crop, lasso, shape, fill/bucket, text, or clipping/masks.
- No animation timeline or GIF export.
- No personal creative locker / Paint Space.
- No community brush/asset submission pipeline.
- No timelapse/replay share.
- No AI assist framework or AI safety policy.
- No real cloud account/sync implementation yet.
- No entitlements/subscriptions/purchase schema yet.
- No creator payout or UGC licensing model.

## Big Missed Opportunities

### 1. Paint Spaces

Paint Spaces should become the product's center of gravity.

A Paint Space is:

- A personal gallery.
- A reusable asset locker.
- A profile-like creative identity without exposing sensitive personal info.
- A place to keep memes, stickers, loops, brushes, palettes, templates, and room themes.
- A publishing surface for safe public packs and event entries.

Recommended objects:

- `space_profile`: display name, avatar art, age band, visibility, guardian controls.
- `space_asset`: sticker, meme template, loop, brush, palette, stamp, paper, room theme.
- `asset_pack`: grouped assets, versioned, private/friends/public/featured.
- `asset_use`: where an asset was used, remixed, copied, or exported.
- `remix_lineage`: parent asset/post/session, child asset/post/session.

Why it matters:

- Personal assets create retention.
- Reusable assets create identity.
- Public packs create creator status.
- Paid storage and premium packs create monetization.
- Safe curated packs let kids participate in current culture without arbitrary web imports.

### 2. Community Brushes and Stamps

Brushes should be treated as social objects, not only settings.

Feature path:

- Brush Studio Lite: create from a few safe presets.
- Brush cards: name, thumbnail stroke, tags, age rating, author space, remix permission.
- Brush packs: private, friends-only, public, featured.
- Admin review: safety, copyright, adult content, spam, misleading names.
- Import/export: eventually support standard formats where technically possible, but start with Happy Paint brush recipes.

Monetization:

- Free community brushes with moderation.
- Premium official packs sold for Drops.
- Creator marketplace later, with payout only for adult or guardian-approved creators.

### 3. Tiny Animation Loops

Animation should start as an approachable social unit:

- 2, 4, or 8 frame loops.
- Onion skin.
- Duplicate previous frame.
- Per-frame duration.
- Export GIF, APNG, MP4, and sticker sheet.
- Room mode: each artist owns one frame.
- Viewer vote: best loop, funniest frame, best color pass.

Why this is big:

- It matches meme/sticker culture.
- It is easier than full video editing.
- It produces shareable output.
- It gives events a repeatable format.

### 4. Meme-Safe Templates

Do not rely on arbitrary meme imports for kids.

Build:

- Caption cards.
- Reaction face blanks.
- Safe speech-bubble layouts.
- Album cover frames.
- Chat sticker formats.
- "Draw this in your style" templates.
- Coloring book line-art challenges.

Allow user uploads in friends/adult surfaces only after moderation and account gates are connected.

### 5. Layer Lite

Layers are table stakes, but the UX should be simpler than pro tools.

MVP layer model:

- Background.
- Sketch.
- Color.
- Detail.
- Sticker/import.

Each layer supports:

- Rename.
- Hide/show.
- Opacity.
- Lock.
- Reorder.
- Merge down.
- Duplicate.

Later:

- Blend modes.
- Clipping mask.
- Alpha lock.
- Group layers.
- Per-layer transform.

### 6. Replay and Process Sharing

Drawing apps win hearts when they show process.

Build:

- Timelapse export.
- Room replay with major events and strokes.
- "Remix from timestamp."
- Before/after snapshots.
- Process cards for gallery posts.

This can power discovery without exposing live rooms.

### 7. Spectator Mode That Is Actually Fun

Viewer-only roles should not feel like punishment.

Viewer tools:

- Vote.
- Emoji or sticker reactions as non-destructive overlay.
- Prompt suggestions.
- Polls.
- "Boost this color."
- Request artist seat.
- Follow gallery result.

Safety:

- Reactions should be curated for kid-safe rooms.
- Viewer input should be rate-limited.
- Hosts and admins can mute viewer reactions.

### 8. AI Assist, Not AI Replacement

AI should help people make art, not replace the reason they came.

Safer AI v1 ideas:

- Generate a color palette from a room theme.
- Generate kid-safe prompt cards.
- Turn a sketch into cleaner line art locally or server-side with consent.
- Background suggestion thumbnails.
- Pose/reference helper from curated internal library.
- Texture/paper generation.
- Caption suggestions for completed art.
- Animation in-between suggestions for tiny loops.
- Brush recipe suggestions from plain language: "scratchy pencil," "soft marker," "glitter gel pen."

Avoid or delay:

- Open-ended image generation in kid-safe rooms.
- Face/person generation.
- Style cloning of living artists.
- AI trained on user art without explicit consent.
- Anything that outputs copyrighted characters as a default flow.

AI monetization:

- Use credits, not unlimited hidden costs.
- Sell optional AI credit bundles for Drops after guardian controls and AI safety review exist.
- Keep basic non-AI creation free.
- Guardian-controlled AI for under-13 users.

### 9. Discord and Share-Surface Strategy

Native mobile apps matter, but the web app can still be an acquisition weapon.

Possible external surfaces:

- Discord Activity: quick collaborative drawing game, room preview, or event battle.
- Share-to-room link: friends can open app, web, or store fallback.
- Export sticker/GIF to iMessage, Discord, TikTok, CapCut, and image roll.
- QR code for classrooms, clubs, conventions, streams.

### 10. Classroom, Clubs, Camps, and Events

This is a natural paid segment:

- Teacher/host dashboard.
- No student accounts required for basic classroom rooms.
- Class code and QR join.
- Safe prompt packs.
- Assignment gallery.
- Export all submissions.
- Locked chat/reactions.
- Timed room sessions.
- Moderation audit.

This can fund the product without making kids watch ads.

## Feature Priority Map

### Foundation: must-have drawing credibility

Priority 0:

- Layers Lite.
- Fill/bucket.
- Selection rectangle/lasso.
- Move/scale/rotate selected content.
- Text tool.
- Shape/line tool.
- Import image into a movable layer.
- Export transparent PNG.
- Timelapse/replay data model.

Priority 1:

- Clipping/alpha lock.
- Blend modes.
- Layer groups.
- Color palettes and palette sharing.
- Brush Studio Lite.
- GIF/tiny loop export.
- PSD import/export research.

### Social creation layer

Priority 0:

- Paint Spaces data model.
- Private asset locker.
- Room-safe asset picker.
- Personal stickers and templates.
- Event entries from gallery posts.
- Room replay snapshots.

Priority 1:

- Public asset packs.
- Pack moderation queue.
- Community brush packs.
- Remix lineage.
- Featured creator spaces for 13+ or guardian-approved profiles.

### Discovery and events

Priority 0:

- Search rooms/events/gallery by topic/tag.
- Safe preview snapshots.
- Event lifecycle and voting windows.
- Vote audit and anti-brigading.
- Host-managed artist/viewer requests.

Priority 1:

- Trending topics.
- Daily/weekly prompts.
- Friend activity, with age gates.
- Staff picks.
- Seasonal event packs.

### AI

Priority 0:

- AI policy and consent model.
- Prompt card generation from approved categories.
- Palette generation.
- Brush recipe suggestions.
- Safety queue for generated assets.

Priority 1:

- Sketch cleanup.
- Background thumbnails.
- In-between suggestions for tiny loops.
- Alt text and accessibility descriptions.

## Monetization Strategy

Principles:

- No targeted ads to children.
- No paywall on basic drawing, safety, blocking/reporting, account deletion, or leaving a room.
- Use a Robux-like paid currency model before subscriptions.
- Monetize optional creative value: tips, official packs, community packs, room themes, exports, storage, event host bundles, and optional AI credits.
- Keep spending legible, guardian-controllable, and non-predatory.

Detailed economy spec: `docs/paint-economy.md`.

### Free Plan

- Core drawing.
- Local gallery.
- Basic room creation.
- Small room limit, for example 4 artists and 20 viewers.
- Limited cloud sync/storage once accounts exist.
- Basic layers.
- Basic exports: PNG/JPEG.
- Public event browsing and voting.

### Drops Currency

Working name: Drops.

Drops are bought with real money and spent on digital creative value inside Happy Paint.

Initial pack ideas:

- $0.99: 80 Drops.
- $4.99: 450 Drops.
- $9.99: 1,000 Drops.
- $19.99: 2,200 Drops.

Spend targets:

- Creator tips.
- Official brushes, papers, stamps, templates, and room themes.
- Community brush/sticker/template packs after moderation.
- Extra cloud storage blocks.
- High-res export or transparent export tokens.
- Tiny loop and GIF export packs.
- Event host bundles.
- AI assist credits after the AI safety model exists.

Rules:

- Purchased Drops do not expire.
- Always show local-money equivalence near purchase moments.
- Use App Store / Google Play in-app purchase for mobile digital currency and digital goods.
- Use web checkout only on the web surface or where platform rules allow.
- Never sell votes, safety, account controls, or access to minors.

### Kudos

Kudos are earned reputation, not paid currency.

Users earn Kudos from:

- Event participation.
- Featured gallery posts.
- Safe community packs.
- Helpful room hosting.
- Moderation-clean creator behavior.

Kudos can unlock status, badges, discovery boosts that do not affect votes, and non-cash recognition. Kudos should not be cash-redeemable.

### Tips

Tips should feel like applause, not pressure.

Rules:

- Tips use Drops.
- Tip presets: 10, 25, 50, 100 Drops.
- No free-form tip messages in kid-safe surfaces.
- Under-13 accounts cannot receive cash payouts directly.
- Guardian-managed accounts can receive tips into locked creator balance or non-cash Kudos until payouts are ready.
- Admin can hold or reverse suspicious tips.

### Creator Earnings

Phase creator earnings carefully:

1. No cash payouts
   - Tips and sales accumulate as locked creator balance or Kudos.
   - Creator balance can be spent inside Happy Paint.
   - No withdrawals.

2. Guardian-gated earnings
   - Teen creators can publish paid packs with guardian approval.
   - Payout requires guardian-managed account, tax info, identity checks, and payout terms.
   - Under-13 creators cannot independently cash out.

3. Adult creator marketplace
   - Verified adult creators can sell packs and cash out above a threshold.
   - Add payout holds, chargeback handling, takedowns, tax workflows, and fraud review.

### Marketplace

Only after safety, moderation, tax, payout, and rights controls exist.

Possible marketplace:

- Brushes.
- Stamps/stickers.
- Palettes.
- Templates.
- Room themes.
- Tiny loop packs.
- Coloring pages.

Rules:

- Under-18 creators can publish free packs with guardian controls.
- Paid creator payouts require adult verification or guardian-managed payout.
- Content must be reviewed before featuring or monetization.
- Every paid asset needs a license and takedown flow.

### Classroom / Club Purchases

Keep this as one-time annual institutional purchasing, not a monthly consumer subscription.

Possible pricing:

- $99/year per teacher for small classrooms/clubs.
- $299/year for a school club or camp pack.
- Larger school pricing later.

Include:

- Teacher rooms.
- QR/class codes.
- Safe event packs.
- Assignment galleries.
- Export all submissions.
- No student account requirement for basic sessions.
- Moderation/audit logs.

### One-Time Packs

Use carefully and preferably sell through Drops:

- Seasonal packs.
- Print/export packs.
- Creator collab packs.
- School/camp prompt packs.

Avoid too many tiny purchases for minors. Bundles should be simple and parent-friendly.

## Safety and Compliance Notes

Current regulatory posture should be conservative:

- COPPA applies to services directed to children under 13 or services with actual knowledge they collect from under-13 users.
- The FTC's 2025 COPPA changes emphasize limits on monetizing children's data and require parental opt-in for third-party advertising.
- Apple's Kids Category and kids guidance require special care around privacy, links, commerce, ads, and analytics.
- Google Play Families policies apply to apps targeting children and include ads/monetization rules.

Product implications:

- Avoid behavioral ads.
- Avoid public people search.
- Keep contact discovery off by default and guardian-gated.
- Do not condition basic participation on collecting unnecessary data.
- Keep AI, community publishing, and paid marketplace features guardian-controlled for children.
- Use age bands and room audience modes everywhere: kid-safe, friends, adult-18.
- Make adult-18 rooms impossible to discover from child-safe surfaces.

## Product Bets

Ranked by likely impact:

1. Paint Spaces
   - Reason: creates retention, identity, reuse, monetization, and social loops.
   - MVP: private asset locker plus gallery.

2. Tiny Loop Rooms
   - Reason: immediately shareable and culturally current.
   - MVP: 4-frame loop with onion skin and GIF export.

3. Layer Lite
   - Reason: baseline credibility for anyone who draws.
   - MVP: sketch/color/detail/import layers.

4. Community Brush Packs
   - Reason: creators love tools that feel like theirs.
   - MVP: shareable Happy Paint brush recipes, admin-reviewed.

5. Event Engine
   - Reason: keeps discovery alive and creates reasons to return.
   - MVP: daily prompt, weekend challenge, voting window, gallery winner.

6. Room Replay and Timelapse
   - Reason: turns process into content.
   - MVP: replay saved stroke stream and export 30-second timelapse.

7. AI Assist
   - Reason: helps casual users start and gives paid value.
   - MVP: palette, prompt, and brush recipe generation with safety controls.

8. Discord Activity Pilot
   - Reason: distribution where older teens and young adults already hang out.
   - MVP: one drawing game mode, not the full studio.

## Suggested 90-Day Roadmap

### Weeks 1-2: Product model

- Add product docs for Paint Spaces and asset packs.
- Add backend schema draft for `paint_spaces`, `space_assets`, `asset_packs`, `asset_uses`, `remix_lineage`.
- Add entitlement schema draft for free/studio/family/classroom.
- Define AI policy, consent, and generated-asset moderation.

### Weeks 3-5: Drawing fundamentals

- Implement Layer Lite on web and mobile.
- Add import image as layer.
- Add fill/bucket and rectangle selection.
- Add transparent PNG export.
- Add per-layer autosave format.

### Weeks 6-8: Culture layer MVP

- Implement private Paint Space.
- Save personal stickers/templates from current canvas.
- Add room-safe asset picker.
- Add event entry from a gallery post.
- Add basic remix lineage.

### Weeks 9-11: Tiny loops

- Add 4-frame loop mode.
- Add onion skin.
- Add duplicate frame.
- Export GIF/APNG where supported.
- Add loop event template.

### Week 12: Economy preparation

- Add entitlement flags.
- Add store copy for Drops, Kudos, tips, and official packs.
- Add non-purchase preview of paid features.
- Add analytics events that avoid child tracking risks.
- Prepare family/classroom landing copy.

## Evaluation Scorecard

Score every new feature 1 to 5 on these axes:

- Drawing credibility: Does it make the app better for people who draw?
- Social pull: Does it help friends create together?
- Culture fit: Does it create shareable, remixable output?
- Safety cost: How much moderation/compliance burden does it add?
- Performance risk: Can it stay smooth on mobile?
- Network cost: Does it work on normal cell connections?
- Monetization fit: Can it fund cloud/storage/AI without hurting free users?
- Differentiation: Does it help Happy Paint become more than a clone?

Priority formula:

`(drawing credibility + social pull + culture fit + monetization fit + differentiation) - (safety cost + performance risk + network cost)`

## Source Notes

Key sources reviewed:

- Magma pricing and collaboration limits: https://magma.com/pricing
- Magma draw-together positioning: https://magma.com/draw-together
- Drawpile collaborative drawing: https://drawpile.net/
- Procreate App Store feature and pricing listing: https://apps.apple.com/us/app/procreate/id425073498
- Procreate product page: https://procreate.com/procreate
- Procreate Dreams FAQ: https://help.procreate.com/articles/znmxbp-procreate-dreams-faq
- Clip Studio Paint features and function list: https://www.clipstudio.net/en/functions/ and https://www.clipstudio.net/en/functional_list/
- Clip Studio Assets publishing/materials: https://assets.clip-studio.com/en-us/help
- Krita features: https://krita.org/en/features/
- ibisPaint premium and community pages: https://ibispaint.com/about.jsp?lang=en and https://ibispaint.com/lecture/index.jsp?lang=en&no=26
- Pixilart community and mobile pages: https://www.pixilart.com/ and https://www.pixilart.com/mobile
- Adobe Fresco product and live brushes: https://www.adobe.com/products/fresco.html and https://helpx.adobe.com/fresco/using/live-brushes.html
- Concepts product and pricing: https://concepts.app/ and https://concepts.app/pricing-explained
- FlipaClip product page: https://flipaclip.com/
- Gartic Phone: https://garticphone.com/
- Skribbl.io: https://skribbl.io/
- Drawize: https://www.drawize.com/
- Canva pricing and AI pages: https://www.canva.com/en/pricing/ and https://www.canva.com/canva-ai/
- CapCut AI/template pages: https://www.capcut.com/tools/ai-video-generator and https://www.capcut.com/explore/ai-templates
- Discord Activities docs: https://docs.discord.com/developers/activities/overview
- Roblox creator marketplace fees: https://create.roblox.com/docs/marketplace/marketplace-fees-and-commissions
- FTC COPPA update: https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data
- Apple kids guidance: https://developer.apple.com/kids/
- Google Play Families policy: https://support.google.com/googleplay/android-developer/answer/9893335
