# Drawesome Remix Rooms: product and feasibility review

Date: 2026-10-02
Status: research/recommendation only; no implementation or deployment.

## Decision

Build a **private, invite-link spatial Remix Board** with a **Figma/FigJam interaction model**: friends freely place movable pictures, memes and text, then draw **on top of and around them** in a shared pan/zoom workspace. Images are objects on the board, not the dimensions of the document. Photoshop-like crop, transform and cutout tools are secondary to the open-board feeling.

**Scope correction from the user:** this supersedes the earlier finite-canvas, Photoshop-lite interpretation. A fixed painting page with stickers added is an intermediate prototype, not the requested finished experience.

The differentiator should be **making something funny together**, not being another online image editor. This follows the youth-native social creation direction in `docs/product-research.md`, but narrows its broad meme/asset ideas to one concrete experience. It does not replace the painting studio or the Creative Five plan. The older creative-engine roadmap explicitly scoped vectors as immutable; this proposal intentionally requires a new retained-object contract rather than pretending those immutable operations already support editing.

## Evidence and confidence

| Finding | Evidence label | Implication |
| --- | --- | --- |
| The homepage positions Drawesome as an instant shared canvas with friend invitations. | Verified live page.[6] | A collaborative remix mode fits the existing entry point. |
| Image files are already imported into the active raster layer and relayed to friends. | Verified source: `src/App.jsx:3498–3570`; `relayOp:10018–10030`. | Reuse room entry, invitations, brushes and image decoding, not the current image state model. |
| Shared layer structure, ordering, visibility, opacity and locks already exist. | Verified source: `LayerPanel.jsx`; server layer handlers around `server.js:6465`; `ARCHITECTURE.md:67–77`. | This is an extension of an existing multiplayer studio, not a blank-slate application. |
| Imported images are painted immediately into pixels; they are not separately editable objects. | Verified source: `App.jsx:3541–3545`; image replay branch. | Movable stickers and editable captions require retained objects with stable IDs. |
| Remote arbitrary image URLs are deliberately refused. | Verified source: `safeImage.js`; `server.js:5253–5261`. | Do not relax this check to implement URL imports. Add an ingestion path. |
| Photopea supports clipboard paste, file drag/drop, and opening an image as a new Smart Object layer. | Verified primary documentation, not independently exercised.[1] | Borrow these familiar import interactions. |
| Photopea documents separate-layer movement/rotation, visibility, opacity, locks and reordering. | Verified primary documentation.[2] | This is the useful subset of “Photoshop-esque.” |
| Canva markets photo collages with free placement, crop, effects and invitations to design together. | Company claim.[4] | Generic collaborative collage editing is not a unique category. |
| Kapwing markets simultaneous editing and shared media libraries. | Company claim.[3] | “Multiplayer editor” alone is insufficient positioning. |

Grounding check: the project server file hashes identically to the running container. All 23 compared built JS/CSS assets match the container; `dist/index.html` does not match. The container does not include `src/App.jsx`. These checks support the inspected deployment context but are not a browser behavior test. No room content, private user records, or customer analytics were read.

## The experience

Example: one friend pastes a cat photograph anywhere on the board. Another drops in a transparent UFO above it and adds a caption. A third draws a tractor beam on top of the picture, arrows and jokes around it, then pans to a clear area beside it to start another composition. Everyone sees the same spatial arrangement; newcomers can join midway without receiving a flattened document.

### Figma/FigJam feel: required behavior

Figma describes FigJam as a collaborative whiteboard with an infinite, freeform canvas.[13] The user wants that spatial interaction model, not Figma’s complete professional feature set.

- **An open, infinite-feeling workspace:** pan/zoom to surrounding empty space and keep making things. No mandatory white page or clipping at the imported image edge. Practical coordinate, object, asset and rendering budgets may exist, but they must not be disguised as a giant preallocated bitmap.
- **Select, draw and hand modes:** pointer selection and transform handles for objects; drawing directly over images or anywhere around them; familiar wheel/trackpad/pinch zoom and space-to-pan. Object interaction must not accidentally paint.
- **Movable images and editable text:** drag/drop into the current view, independent transforms, multi-select, grouping and sensible duplication. Grouping an image with its doodles lets them move together; otherwise nearby drawing remains independent.
- **Visible collaboration:** live cursors, selection outlines and a clear “being edited by” state. Friends can work in separate regions without forcing everyone to share a camera. Fit-content and jump-to-friend help them reunite.
- **Lightweight chrome:** a compact tool strip and selection-specific controls. A Photoshop-style layer sidebar is optional, not the central interaction.
- **Optional composition frames:** users can mark an exportable meme/poster region, but drawing is not constrained to that frame. Export selection, a frame or a bounded content region rather than an unbounded canvas.
- **Drawing above and around content is foundational**, not an eventual upgrade. A freely panning camera over the current fixed page does not satisfy it.

This does not imply auto-layout, components, developer handoff, plugin infrastructure or full Figma file compatibility.

### Entry

- Start a room → **Draw / Remix**.
- Remix opens privately with a short invitation link. **Correction from the technical audit:** production private rooms currently require sign-in; account-free invite guests would be a new, explicit board access capability, not behavior already provided by the room backend. Keep existing private-room policy intact unless deliberately extending it.
- First-run instruction: **“Paste a picture. Add a caption. Invite someone to make it worse.”**
- Desktop: clipboard paste and file drag/drop. Phone/tablet: a large Add Image button, file/photo picker, and paste where the browser supplies image bytes.
- Selecting an image shows handles plus a small contextual toolbar, not a wall of Photoshop menus.
- Start in selection mode; choose Draw for marks anywhere in board space. Keep each participant’s camera local. Add Fit content and a way to jump to a friend’s working area.

### Essential interactions

1. **Paste/upload** PNG, JPEG and WebP, including transparent cutouts.
2. **Move, resize, rotate and flip** without losing the original asset.
3. **Add editable captions** with outlined meme text, plain text, and speech bubbles.
4. **Bring forward/send backward**, with a simple stack panel.
5. **Draw over the composition** using the existing brushes.
6. **Lock a background** while friends add material above it.
7. **Undo my action**, rather than resetting everyone’s document.
8. **Export a PNG and copy/share an invitation** separately. Exporting an image and publishing to a public gallery must be separate choices.
9. **Multi-select and group an image with selected doodles/text** so the composition moves together without moving unrelated surrounding content.

A newly dropped image should go above the current selection by default, with a visible placement preview. A late-arriving friend should start with the top editable paint layer selected so their doodle does not silently disappear under an opaque background.

## Ranked room ideas

| Rank | Experience | Why try it | Incremental complexity |
| --- | --- | --- | --- |
| 1 | **Meme Jam**: images, captions and doodles on one shared canvas | Closest to the requested behavior; easy to explain and invite friends into | Medium-high: new retained-object foundation |
| 2 | **Collage Club**: moodboards, scrapbook pages, posters and album covers | Extends the same tools beyond humor; useful for people who do not draw | Low after the foundation: templates and preset styles |
| 3 | **Remix Relay**: each friend adds one thing, then reveal the result | Adds a social/game loop rather than more editing controls | Medium: turn state, checkpoints and reveal UI |

Follow-up ideas: a shared tray of images already uploaded to the room; “make an album cover” prompts; saved user-owned stickers; transparent PNG export; crop/mask tools; optional background removal. Background removal should be evaluated independently for device performance, model/license terms and privacy. It need not imply AI-generated artwork.

Do not start with PSD import/export, pen/path tooling, professional color management, video timelines, open-web image search or an unrestricted public meme feed.

## Bringing material from other websites

The promise should be **“bring pictures you can access and use,”** not “paste any website and we will scrape it.” An image file URL, a webpage URL, a copied image, and a social post URL are different inputs.

| Input | Recommendation | Failure/fallback |
| --- | --- | --- |
| Copied image bytes | Launch path; treat as a normal upload | If clipboard provides only HTML/URL, offer Upload or Paste image link |
| Downloaded file dragged onto the canvas | Launch path | Respect format, file-size and decoded-pixel caps |
| Direct image URL | Next stage, through controlled ingestion | If blocked, ask the user to save and upload the image |
| Ordinary webpage/social post URL | Not universal support | Explain that it is a webpage; support named providers only after reviewing their access and usage terms |
| Curated stickers/templates | Best launch library | Use owner-created or explicitly licensed material; preserve provenance |

Loading external images directly into the collaborative canvas can taint it and prevent pixel reads or export; MDN documents this restriction.[7] The current `safeImage.js` also explains the privacy issue: letting every peer load a stranger’s URL exposes each visitor’s network address to that host.

For URL ingestion, fetch once on the server into a quarantined asset path, verify format and dimensions, strip metadata by re-encoding, and make the normalized result available through authorized same-origin asset delivery. Keep source URL and license/provenance separate from rendered pixels. Do not forward user cookies, site credentials or arbitrary upstream responses. Enforce time, download-size, decoded-pixel and per-room storage caps.

A URL-fetch service introduces SSRF risk. OWASP specifically names externally hosted image downloads as a common example and recommends application/network defenses and control of redirects.[11] Prefer allowlisted providers at first; reject private, loopback, link-local and reserved destinations, and guard actual connections against DNS rebinding. Disable redirects initially or validate every redirect destination with the same connection-level rules.

### Meme library candidate

Imgflip documents a free popular-template endpoint and premium full-catalog search.[8] It is a potential provider to evaluate, not approval to copy or publicly redistribute every template. Its caption API creates externally accessible image URLs with no private option.[8] Do not send private room captions or uploaded personal pictures through that API. Keep caption rendering inside Drawesome; review provider terms, caching rights, attribution and source-image rights before enabling any catalog. A curated original/cleared library is the safest first release.

Private rooms still need reporting and moderation; privacy is not a rights clearance or a safety guarantee. Imported personal photos should not automatically appear in public previews, room discovery, Wall posts or saved public templates.

## Technical limitations: Figma/FigJam follow-up

Assessment basis: current source, a filtered inspection of the running container’s relevant non-secret configuration, live host/container resource snapshots, calculated raster backing-store sizes, and an isolated browser probe of the actual `layers.js` module. Durable probe results, source hashes and calculations are in [board-feasibility-evidence-2026-10-02.json](board-feasibility-evidence-2026-10-02.json). This is not a production-room test or a throughput/FPS benchmark. Figma’s FigJam page confirms the collaborative whiteboard positioning used as the interaction reference.[12]

### Client/document blockers

| Limitation | What we have now | Consequence for the requested board | Required change |
| --- | --- | --- | --- |
| **Finite world** | `layers.js:10–23` allocates 4000×2500 canvases. `App.jsx:1937–1988` clamps zoom and keeps the fixed page reachable. | Panning outside the page reveals a backdrop, not more durable drawing space. Removing the camera clamp does not extend the raster. | Separate board world coordinates from viewport pixels; use sparse/tiled or bounded drawable objects. Keep old painting rooms finite. |
| **Rasterized content** | Image import paints into the active layer (`App.jsx:3498–3570`); text uses a prompt and `drawText` (`4192–4235`). | No separately movable image, editable caption or selectable stroke/group after commit. | Retained image/text/ink identities, transforms, geometry/bounds, hit-testing, multi-selection and groups. |
| **Full-world compositing** | `renderDisplay` composites the full page (`2240–2270`); stroke rendering blits below/active/above full-size canvases (`2282–2386`). | An enlarged “infinite canvas” increases raster and draw bandwidth even for a mostly empty board. | Render the viewport and visible objects/tiles; maintain dirty regions, spatial indexing and bounded decoded-asset/raster caches. |
| **Expensive snapshot undo** | `snapshotActiveLayer` clones the active canvas (`layers.js:119–133`); undo depth is 8 on coarse-pointer devices, 18 otherwise (`App.jsx:199–205`). | Bitmap undo cost grows with page size and cannot express revision-aware object transforms. | Canonical object-command undo; compressed/dirty-region or checkpointed paint undo. Preserve current friend-stroke replay behavior, but do not reuse snapshots as board transactions. |
| **No board interaction layer** | `TOOLS` lists brush/fill/rect/ellipse/line/text (`App.jsx:460–467`); pointer paths prioritize painting and pen/palm handling. | Select/drag/marquee/resize/group interactions need their own state machine. Two editors listening on the same surface can double-handle gestures. | A dedicated Board tool controller sharing one camera; selection handles and touch hit targets; preserve pen priority and explicit draw/hand modes. |
| **Fixed-page presence** | Cursor send normalizes by page dimensions (`App.jsx:3856`); remote cursors decode through the same constants (`10334–10368`). | Existing normalized cursor protocol is tied to a finite page; following a distant board collaborator needs more than a pointer. | Versioned world-space presence, transient selections and optional viewport broadcasts; leave cameras independent unless the user follows someone. |
| **Raster-based saves and exports** | Draft v4 serializes layer PNGs (`App.jsx:2790–2832`); `composeCanvas` flattens a fixed region (`2718–2741`). | A preview or PNG cannot preserve board object editability, and “export all” becomes unsafe for unbounded space. | Durable scene state plus asset references and ink source; preview as derived data; capped frame/selection/content-region exports. |
| **Text consistency** | `shapes.js:48–65` renders system-font text directly to pixels. | Editable text needs bounds, reflow, editing focus and stable fonts across peers. | Bundle/pin supported fonts, await font readiness, define wrapping/layout and make text revisions part of shared state. |
| **Rich brush semantics** | Smudge/goo sample an existing raster (`brushes.js`, `makeStrokeEntryCore` and `makeSmudgeRenderer`); fill reads whole-layer ImageData (`fill.js:32–63`); stroke buffers cap at 2048×2048 (`strokeBuffer.js:30–31`). | Infinite flood-fill has no natural boundary. Wet sampling, erasing, tile edges and moving already-painted objects cannot be solved by placing an SVG overlay on top. | Keep rich painting in explicit bounded paint surfaces or implement and test tile-aware sampling/seams. Eraser cuts ink, not photos; photo cutouts use masks. Preserve seeded source-space brush rendering when transforming groups. |
| **Remote responsiveness** | Stroke batches flush after 150 ms or 256 queued points (`App.jsx:221–227`, `3739–3758`); remote cursors update on a 120 ms timer (`10334–10369`); remote buffered strokes cap at four (`215–217`). | Existing live painting transport is not automatically a smooth object-drag/selection channel. More simultaneous rich strokes may take a different renderer path. | Separate disposable drag/presence previews from durable changes; coalesce/interpolate previews; explicitly benchmark multi-participant drawing and dragging. These intervals are source settings, not measured end-to-end latency. |

**Browser probe:** loaded the actual layer-module code into an isolated blank browser page, created its default canvas, painted at `(20,20)` and outside the right boundary at `(4010,20)`, and read the pixels. Inside was opaque red; outside was transparent. The undo snapshot was still 4000×2500. This demonstrates the source module’s finite raster behavior, not a full live-app interaction test. No production room was joined or changed.

### Server/protocol/storage blockers

The parent rechecked the independent server review against source and a filtered live-container inspection. Relevant `MAX_*`, op-rate, compaction, queue and ordinary auto-close settings are not overridden; `/app/.env` is absent, so the defaults below apply to the running image whose `server.js` hash matches the inspected source. The container runs Node `v24.20.0` (distinct from the host Node version). Checkpoints are **configured enabled**; no new checkpoint build was triggered during this assessment.

| Limitation | Verified current behavior | What must change for a durable board |
| --- | --- | --- |
| **Append-only painting protocol, not mutable scene state** | The op path appends paint/image/text operations (`server.js:5185–5332`); it has no board object registry/revision/transform/group contract. Layer structure is canonical but each layer is a whole painting surface. | Add server-issued object identities, authoritative scene state, revision-aware mutations, order/groups and tombstones. Keep movement deltas small. The existing single-room authority is useful; a CRDT or a new distributed system is not required for the first version. |
| **Inline image payloads** | `image` ops require an inline raster `dataUrl`; cap is 8,000,000 characters (`1901`, `5253–5261`). Accepted payloads ride history, broadcast, persistence and catch-up serialization. | Upload/dedupe normalized assets once and reference IDs in scene state. Authorize asset delivery and apply per-room byte/decoded-pixel budgets. Never resend the image bytes during each transform. Gzip does not remove the need for asset references; no compression ratio was measured. Existing trace-photo/audio/brush facilities are examples, not a generic board asset lifecycle. |
| **History caps can delete source content** | Single-frame history FIFO-trims at 20,000 operations, or 12,000 for ordinary public rooms (`76–80`, `2288–2322`, `5323–5327`). | Store materialized current object/ink state independently of a bounded command/undo log. Log compaction must preserve complete live content, including old off-screen objects. Off-screen LRU eviction may remove a derived bitmap/decode cache, **never the canonical artwork**. |
| **Existing checkpoints do not preserve editability** | `ENABLE_TRUSTED_CHECKPOINTS=1` and a Chromium path are set. The service derives per-layer PNG caches from a frozen prefix, keeps them memory-only, and falls back when unusable (`175–205`; `server/checkpoints.js:151–161`, `198–212`). | Reuse the generation/watermark/catch-up discipline, not the bitmap as authoritative scene state. A board snapshot must retain objects, groups, text, asset references and ink source. The raster cache does not make FIFO-trim safe for retained objects. |
| **Drag previews need a separate lane** | Durable op token bucket is 30/s sustained, burst 120 (`85–86`, `1258–1269`). Cursors are disposable, but the current handler simply relays coordinates (`5367–5375`) and is not a validated object-edit channel. | Add validated, rate-limited and coalesced transient object previews, with a durable revisioned commit at gesture end. Bound acceptable world coordinates without clamping every point into 0..1. Do not increase op caps merely to persist every pointer move. |
| **Network/backpressure budgets** | Inbound WS cap is 16 MiB (`321–329`); catch-up queues cap at 2,048 messages/16 MiB; outgoing durable queues at 2,048 messages/32 MiB after a 1 MiB send soft limit (`114–125`, `3568–3592`). Queue overflow disconnects for resync. Room members cap at 30 (`136`, `4828–4831`). | Keep these safety bounds. Add board-aware state catch-up and asset fetching, prioritizing viewport assets while preserving complete canonical structure. Measure slow-client joins and bursty concurrent edits. A 30-member policy cap is not proof of smooth 30-person performance; the 16 MiB inbound cap is not a universal outbound-history cap. |
| **Persistence still has whole-history work** | Most ops append to a JSONL log; when accumulated log ops exceed 2,000 or history changes generation, `saveRoomNow` serializes the whole history. Save scheduling is debounced 2.5 seconds (`135`, `1593–1624`, `1692–1712`). Disk writes are asynchronous, but `JSON.stringify` is synchronous. | Remove asset bytes from the command log first, then measure serialization/event-loop lag. Add canonical scene persistence plus bounded logs; chunk/worker serialization or a transactional store only if measurements justify it. Define a durability acknowledgment—“broadcast accepted” does not mean “safely on disk.” |
| **Room expiry is not saved-document lifetime** | Ordinary idle rooms are deleted, including files (`2792–2886`). Unowned idle budget defaults to a 12-hour floor/30-day ceiling; account-owned rooms use a 30-day floor/90-day ceiling (`216–233`). Complexity/engagement affects the actual timeout. Sketchbook pages have a separate exemption. | Define board lifetime, owner/save status, quota and deletion rules explicitly. Do not inherit room cleanup or ordinary public mural refresh accidentally. Keep a persistent saved board distinct from temporary session resources. |
| **Current private-room sign-in gate** | Production has `PB_URL` configured; `pocketbaseConfigured()` tests that configuration (`server/pocketbaseAuth.js:17–24`), and private `friends` joins without identity are rejected (`server.js:4807–4823`). | Either keep signed-in private collaborators or deliberately add scoped invite-guest capabilities for boards. An invite URL is not evidence that anonymous guests already have access. Check object mutations, downloads, previews, export and revocation through the same policy. |
| **Moderation and one-process authority** | Text is scanned on the op path; public image scanning uses elected browser watchers (`155–158`, `5199–5208`). Room content/order/participants live in one Node process (`334`); current moderation refers to op identities. | Moderate complete retained object/group dependencies and new image uploads. Review off-screen images, not only a visible viewport screenshot. Keep one-process room authority initially; horizontal scaling later needs room routing/shared durable state, not simply another container behind a load balancer. |

**Reuse versus replacement:** rooms, token validation, invitations, canonical structural echoes, reconnect ordering, backpressure and checkpoint generation discipline are reusable infrastructure. The new work is scene state, spatial rendering/residency, asset lifecycle, editing transactions, retained-object moderation and board lifetime. No current code review or resource snapshot establishes a maximum image/object count; that limit must come from an actual board prototype benchmark.

### Browser memory is the immediate scaling constraint

Calculated from source dimensions using four bytes per RGBA pixel. These are nominal raw backing-store estimates, **not measured browser RSS/VRAM**; engines may allocate lazily, retain additional copies, or incur other overhead. Do not add all rows together as a universal actual memory measurement.

| Allocation/scenario | Nominal raster storage |
| --- | ---: |
| One 4000×2500 paint layer | 40,000,000 bytes ≈ 38.15 MiB |
| Six live paint layers | ≈ 228.88 MiB |
| Eight active-layer undo snapshots | ≈ 305.18 MiB |
| Eighteen active-layer undo snapshots | ≈ 686.65 MiB |
| Two full-size below/above composite caches | ≈ 76.29 MiB |
| Four maximum 2048×2048 remote stroke buffers | 64 MiB |
| Double both page dimensions: one 8000×5000 layer | ≈ 152.59 MiB |
| Ten times both dimensions: one 40000×25000 layer | ≈ 3.73 GiB |

Image decode buffers, the document/display canvases, local stroke buffers, fill readbacks, export canvases and browser overhead are additional. This is why **making the canvas bigger or giving every imported image a raster layer is the wrong architecture**. Large-coordinate bounds are affordable only when content residency is sparse and viewport-dependent. The old six-layer cap is not a six-object limit for the new board.

### Host versus product constraints

Observed at `2026-10-02T23:50:29-05:00`: host memory `62 GiB` total / approximately `40 GiB` available; filesystem approximately `314 GiB` free. The Drawesome app container snapshot used `55.59 MiB` and reported no Docker hard CPU or memory limit. This is an idle/light-load snapshot, not evidence of how many boards or users the server supports.

Conclusion: no observed need to buy a larger server before prototyping. The hard blockers are document/rendering architecture and collaborative semantics; additional server RAM does not increase a phone’s canvas budget. Load-test a real board model before deciding infrastructure changes. Disk availability is not a substitute for per-room upload quotas and asset retention/garbage collection.

### Implementation isolation

The current client component is 13,685 lines and `server.js` is 12,109 lines at the inspected hashes. Those counts are not themselves performance defects; they make a second interaction/rendering model risky to weave through the existing painting and animation paths. Add board-specific document, tool-controller, renderer, asset and protocol modules behind a room capability/route. Reuse lower-level room/brush services, with explicit regression gates for the ordinary studio.

### Architecture decision

**Feasible, but this is a new board document/rendering mode—not a small layer-panel enhancement.** A page-bound prototype is useful to prove controls and asset transforms, but must not be called the finished FigJam-like experience. The minimum architecture spike must prove persistent drawing outside the existing page, independently movable objects and grouped ink, independent cameras, reconnect and viewport-bounded rendering.

The highest-risk unresolved choice is rich-paint residency: retained simple ink plus bounded rich-paint objects versus a tiled rich-paint engine. Neither approach should promise full wet/smudge/fill equivalence until seam, ordering, moving-group and replay tests establish it. A separate Board frontend can deliver the spatial interaction without changing the existing painting brushes or weakening old-room fidelity.

## Technical direction

### Reuse the room backend; add an object model

**Revised recommendation: add a separate Board room renderer, reusing Drawesome’s room identity, invitations, presence, access controls and brush primitives where compatible. Do not turn every existing painting room into a board or graft a second camera/object system into the current studio component.**

Use a retained scene graph for images, text, groups, optional frames and drawable content, with spatial indexing and viewport culling. Keep drawing source data and bounded/sparse raster caches; load/decode only needed assets. Preserve mixed image/text/ink ordering through one composition model.

For board-wide drawing, choose and prove a rendering path: retained lightweight ink for ordinary sketching, with bounded paint objects/patches for rich Drawesome brushwork; or a tiled rich-paint renderer with explicit seam and residency budgets. Rich painting must be possible above images and in surrounding board space. A finite patch may bound a special paint operation, but the board itself must not become one fixed 4000×2500 page. Existing full-size raster layers can remain unchanged in the ordinary painting mode.

**Do not allocate one full-size canvas per object, increase the global canvas dimensions, or treat a flat checkpoint PNG as the source of editable board state.**

A proposed object record includes stable server-issued identity, kind, asset reference or text content, transform, opacity, owner/author, lock state and revision. The server owns shared structure and canonical order. Clients submit validated intents, and every client—including the sender—adopts the accepted result. IDs and revisions survive restart.

Upload image bytes once and reuse an immutable asset reference; do not rebroadcast large base64 image data for every drag. Separate transient drag previews from durable transform commits. A short-lived per-object editing lease with expiration/reconnect recovery is a practical first conflict policy. It lets two people work on different objects while avoiding a tug-of-war over the same image.

**Undo is collaborative state, not a local bitmap snapshot.** Record inverse commands against object IDs and revisions. If somebody else subsequently edited an object, do not silently overwrite their changes when undoing an earlier transform; reject or offer a conflict-aware action. Validate undo on the server like any other mutation.

### The important paint-over distinction

“Paint on top” and “paint into the image” must be separate operations:

- Board brushwork lives in world space in an ordered ink/paint object or patch above the relevant objects; it can extend around the image. Moving an image alone does not move nearby doodles.
- To make the doodle move with the image, provide explicit grouping in the board foundation. A bounded mask/paint attachment is another rendering option, not automatic behavior.
- Erasing a paint layer removes brushwork, not the underlying photo. Cropping or cutting out a photo requires an explicit crop/mask tool.

Start with clearly labeled draw-over behavior. Preserve ordering consistently in live rendering, rejoin, thumbnails and export. An overlay-only implementation that always places every image above every brush stroke would not satisfy the requested experience.

### Library options

Fabric.js documents object manipulation controls, on-canvas text editing, image filters, clipping, grouping and serialization.[10] It is a sensible candidate for an isolated interaction prototype, but does not remove the need for Drawesome’s own authoritative synchronization, ACLs, history and moderation. The prototype must prove compatibility with existing pan/zoom and brush interaction before adopting it.

tldraw has a self-hosted multiplayer starter kit with room authority, persistence and asset management.[5] However, its SDK requires a production license; it is source-available rather than permissively open-source.[9] Its official starter uses Cloudflare Durable Objects and R2.[5] That makes it an alternative if building a separate whiteboard product, not the default for extending this self-hosted painting studio.

Recommendation: preserve the ordinary painting renderer and backend services, but use a dedicated Board frontend/data model. Evaluate Fabric.js versus a focused native retained scene graph in a throwaway prototype. An object library handles controls, not sparse rich-paint residency, authoritative collaboration or object-aware moderation. No editor library choice is established by this research alone.

### Moderation and compatibility are prerequisites

The existing op-based moderation can hide individual operations. Retained objects introduce dependent edits: hiding the original image but leaving later transform/mask operations can resurrect it or leave dangling state. Index the whole object’s creation and edits, and hide/remove them atomically. Preserve existing image validation rather than replacing it with arbitrary URLs.

Add an explicit room capability/schema version so old clients cannot join and silently render only half the document. Audit viewing, thumbnail, asset-download, export, moderation and deletion routes. An unlisted room URL is not a private-content access policy; asset delivery must follow the room’s actual access model.

## Recommended first batch and cost shape

1. **Architecture spike:** two independent cameras, movable images/text, ink on top of and around pictures, and drawing beyond the old page bounds. Measure culling/residency, zoom behavior and brush fidelity; include an off-screen region and a reconnect. A fixed-page transform demo alone is insufficient.
2. **Durable board foundation:** canonical retained state, object revisions, uploads/assets, group-aware moderation, collaborative undo, capability negotiation and current-state catch-up. Required before calling a shared board reliable.
3. **Private Remix Board MVP:** paste/upload, selection/transform, grouping, draw/pan tools, live presence, mixed z-order, reconnect/restart, and bounded region/frame export. Medium-high to high engineering scope: a new document/rendering model, not a toolbar change.
4. **Convenience upgrades:** controlled direct-image URLs, cropping and original/cleared sticker packs. Provider costs/terms are not established.
5. **Later:** background removal, Remix Relay and personal reusable asset trays. Evaluate separately after actual group usage.

Do not charge for basic paste, friend joining, exporting or safety. Any future monetization should add convenience/storage/packs rather than make the core shared experience worse.

## Acceptance checks before release

- Two browsers add different objects concurrently, transform separately, reorder, lock and see the same result.
- Images, text and ink remain editable outside the old 4000×2500 page, including negative world coordinates. Pan/zoom to an off-screen composition, reconnect and recover it.
- Draw both on top of a picture and around it; group picture plus selected drawing, move the group, and verify untouched unrelated content.
- Independent cameras, select/draw/hand modes, fit-content and jump-to-friend work without accidental strokes.
- Off-screen content does not require full-board raster allocation or image decoding; the chosen rich-brush path has measured memory, seam and replay-fidelity gates.
- A late join, reload and server restart preserve editable images/text, object order, paint-layer content and room access.
- A friend’s first doodle appears above the composition, not invisibly underneath it.
- On phone/tablet, moving an object does not steal pinch-zoom or accidentally draw a stroke.
- Cropping a photo and erasing paint are visibly different actions.
- PNG export and thumbnails match the live composite, including hidden objects, opacity and mixed raster/object order.
- Undo cannot remove or rewind another person’s unrelated work; concurrent-edit conflicts are explicit.
- Moderator hide/remove cannot be undone by a transform, reconnect, cached preview or old asset reference.
- Invalid URLs, redirect tricks, forbidden destinations, malformed images, oversized files and viewers attempting edits are rejected server-side.
- Room/private asset permissions are checked independently of UI visibility; private imports are absent from public discovery/Wall routes.
- The board follows an explicit access policy. Preserve current signed-in private-room behavior; if invite-link guests are enabled, verify their scoped capability, host revocation and room/asset access without weakening other private rooms.

## Success metrics

Measure rooms with contributions from at least two distinct participants, time from first import to a friend’s contribution, successful invite joins, exports after collaboration, repeat group sessions, and import failure by input type. Exclude labeled self-tests. These are proposed measurements, not current demand evidence.

## Not established by this review

Customer demand, market size, retention uplift, implementation timeline, measured browser memory/FPS under realistic load, network capacity, cross-browser clipboard behavior, a chosen editor library, provider integration rights, legal conclusions, and background-removal costs were not established. The technical follow-up below adds source-derived memory estimates and a small isolated browser canvas probe; neither is a production load test. Vendor functionality was checked against documentation, not exercised in logged-in editors. No production room was edited and no feature was built.

## Sources

[1] https://www.photopea.com/learn/opening-saving
[2] https://www.photopea.com/learn/layers
[3] https://www.kapwing.com/video-editor/collaboration
[4] https://www.canva.com/create/photo-collages
[5] https://tldraw.dev/starter-kits/multiplayer
[6] https://drawesome.art
[7] https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image
[8] https://imgflip.com/api
[9] https://tldraw.dev/community/license
[10] https://fabricjs.com
[11] https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
[12] https://www.figma.com/figjam
[13] https://www.figma.com/resource-library/visual-collaboration-tools
