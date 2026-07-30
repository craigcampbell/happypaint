# Drawesome Creative Five — Product and QA Review

Independent product, safety, feasibility, mobile, performance, and release
review of [creative-five-feature-plan.md](creative-five-feature-plan.md).

Review basis: the current `server.js` room model and WebSocket protocol,
`src/App.jsx` canvas/scene implementation, the Fridge Wall, replay tools,
play-money economy, account deletion flow, and the constraints in
`ARCHITECTURE.md`, `AGENTS.md`, and `ROADMAP.md`.

## Post-implementation review outcome

The bounded MVP for all five ideas is now implemented. The gates identified
below were applied as implementation constraints, not waived:

- Kaleido is fixed to four-way symmetry in the public room, while private-room
  hosts can select other modes. Live rendering and history replay share the
  same deterministic transform utility.
- Remix lineage is derived and validated by the server. Creator opt-in defaults
  off, the source is pinned to the room, and hidden or deleted parents fail
  closed for new remix publication.
- Quest completion uses exact active-member quorum, ephemeral nominations,
  persisted daily completion, and a bounded local play-Drops receipt.
- Paint Orchestra stays silent until a per-session user gesture, caps active
  voices, throttles stroke events, and has no effect on the network protocol.
- Storybook launches a fresh private project room rather than a global public
  book. Captions are filtered and bounded, page locks are authoritative on the
  server, and export is client-side.

The implementation received an anonymous two-client protocol test, restart
persistence coverage, 21 focused automated tests, a production build, lint, and
a 375 px visual pass. That pass also caught and resolved an overlong featured
room code plus mobile overlay collisions. The staged release recommendation
still stands: these are separable capabilities and should be enabled/observed
independently in production.

## Executive decision

The five ideas are differentiated and worth pursuing, but they should not be
implemented as one release. Two are ready for bounded implementation, two need
specific lifecycle/state corrections, and Storybook needs a project-room
decision before production work.

| Feature | Decision | Product rationale | Required gate |
|---|---|---|---|
| Kaleido Jam | **GO with MVP cuts** | Immediate delight, anonymous by default, and no new user-generated content surface | Prove deterministic parity across every renderer and acceptable radial-mode mobile performance |
| Paint Orchestra | **GO with MVP cuts** | Isolated client-side enhancement with graceful silent fallback | Sound must be session-opt-in, voice-bounded, and effectively zero-cost while off |
| Remix Trails | **CONDITIONAL GO** | Strong create-to-share-to-create loop and clearly distinct from the existing local “Remix from here” replay action | Persist a server-derived remix source on the room so every collaborator/rejoin sees the same base |
| Canvas Quests | **CONDITIONAL GO** | Good cooperative retention mechanic without image recognition | Define public-room rollover, ephemeral voting, exact quorum, and one bounded reward receipt per device/set |
| Storybook Expeditions | **NO-GO as currently scoped; GO after redesign gate** | Strong flagship concept, but one always-open featured book has no coherent owner, ending, or reset lifecycle | Featured entry must launch a fresh project room; page locks must guard every page mutation; mobile export must be bounded |

No finding requires abandoning an idea. “No-go” means do not merge the current
Storybook interpretation into production until the stated product container is
resolved.

## What is new versus what already exists

- Drawesome already has shared animation frames, scene paging, scene/frame
  presence, host-only scene creation/deletion, film export, and a storyboard for
  multi-room productions. Storybook should be a constrained presentation over
  that machinery, not a parallel canvas document system.
- The replay player already offers **Remix from here**, which restores a local
  snapshot into the current studio. Remix Trails is still a meaningful new
  feature because it starts from a public Wall post, records creator consent,
  and preserves server-derived public lineage. The UI must distinguish “remix
  this Wall artwork” from replay snapshot restoration.
- The Fridge Wall already has anonymous posting, immutable raster frame
  endpoints, text filtering, reports, auto-hide, owner deletion, and admin
  removal. Remix should extend those controls rather than introduce a second
  publication path.
- Drawesome already has play-money earning while painting. Quest rewards are a
  new earning reason, not a new currency system.
- The server already treats homepage spectators as read-only sockets outside
  `room.users`; quest quorum can use that existing boundary.
- Featured public rooms are deliberately hostless. Any design requiring a host
  in a featured room is invalid unless the feature supplies an alternative.

## Prioritized findings

### P0 — must resolve before feature implementation or merge

1. **Storybook cannot be one persistent, always-open featured book.**
   `STORYBOOK` would be hostless like every other featured public room, while
   the MVP requires host locks and reordering. Four shared pages would also be
   permanently “finished” or continually overwritten by unrelated visitors.
   Make the featured card a launcher that creates a fresh private
   storybook-mode room with four pages. Anonymous creators already receive a
   session-scoped guest host in private rooms, so this remains anonymous-first.

2. **Remix context must be canonical room state.** Carrying a post id only in
   the launching browser does not make the source appear for collaborators,
   reconnects, or server restarts. Add a sanitized `remixSource` room field,
   established by the server from an eligible Wall post and included in the
   join handshake. Use frame `0` only for MVP. Never accept source image data,
   `rootPostId`, or public attribution metadata directly from the client.

3. **Storybook page locks need server enforcement across all mutation paths.**
   Reject non-host `op`, `clear`, relevant frame mutations, and any base/sheet
   change targeting a locked page. Hiding a button is not a lock. Admin
   moderation and an explicit host unlock remain valid recovery paths.

4. **Quest votes cannot be durable connection ids.** WebSocket connection ids
   expire on disconnect and are meaningless after restart. Persist only the
   selected set and completed missions. Keep pending votes in memory, remove
   them on disconnect, and recalculate quorum only when a participant votes or
   leaves. A reconnect must not create a durable second vote.

5. **The featured Quest room needs a rollover rule.** Without one, its three
   persisted missions eventually remain complete forever. Use a UTC-daily
   deterministic `setId` in the featured room. Reset incomplete votes and
   completion at the day boundary. Private rooms use a server-minted set id and
   a host reset.

6. **Define mode compatibility before adding independent booleans.** Existing
   animation, Draw & Guess, and Draw Phone modes already have mutual-exclusion
   logic. Use a canonical primary mode for structured experiences
   (`normal`, `animation`, `game`, `phone`, `storybook`) and capability flags
   for discovery. For MVP, Kaleido, Orchestra, and Quests are fixed featured
   experiences or explicit room enhancements; do not allow arbitrary
   combinations until the combinations are tested.

### P1 — release blockers for the affected feature

1. **Kaleido must update every operation consumer.** Local stroke rendering,
   remote live rendering in `App.jsx`, standalone replay in `opReplay.js`, and
   spectator/timelapse rendering must resolve identical transforms. A helper
   used in only the live client will produce correct-looking sessions but
   incorrect reconnects, homepage previews, or exports.

2. **Eight-way textured brushes are an unproven mobile budget.** The canvas is
   4000×2500 and buffered strokes already have memory caps. Radial mode can
   multiply brush work by eight and span the whole document. The first release
   should support marker, pencil, crayon, paint, and eraser; hold spray,
   watercolor/gouache, smudge, imported stamp tips, and other expensive/custom
   brushes until a 375px low-end-mobile stress pass succeeds.

3. **Kaleido normalization must have one source of truth.** A `{mode, copies}`
   pair can contradict itself. Persist `mode` and derive copy count, or reject
   every mismatched pair server-side. Old and normal-room operations should not
   gain a redundant `symmetry: none` field.

4. **Remix permission needs a revocation story.** At minimum, owner deletion
   prevents new remixes because hidden/deleted sources return 404. Prefer an
   owner-only “Allow new remixes” update so a creator can revoke future use
   without deleting the art. Existing descendants remain intact and show
   “Source unavailable” if the parent is removed.

5. **Remix publication needs a deletion/race policy.** If a source becomes
   hidden, opted out, or deleted after the room opens, publishing a new
   descendant must fail with a clear “source is no longer available” message or
   publish as an unlinked original after explicit confirmation. It must never
   accept stale client lineage.

6. **Quest quorum must be exact and understandable.** Define quorum as
   `floor(activePainters / 2) + 1`, with one vote sufficient only when exactly
   one painter is present. For two painters, both must agree. Muted painters
   still count; homepage spectators do not. Show “2 of 3 agreed” rather than the
   abstract word “quorum.”

7. **Quest reward receipts must be bounded.** Award once per device per
   server-minted `setId`, enforce a daily Drops cap, retain only a rolling window
   of receipt ids, and add any new local key to `accountDeletion.js`. A forged
   local wallet is acceptable in play-money mode; unbounded ledger/storage
   growth is not.

8. **Orchestra opt-in is per page session.** Persist mute and volume if desired,
   but never restore “enabled” into audible playback. Every load requires a user
   gesture. Muting must cancel scheduled notes, stop active voices, and suspend
   or close the context.

9. **Orchestra needs separate local and remote feed rules.** Local points should
   sound from the pointer path; remote points should sound only from live
   incoming `op` messages. History, scene hydration, resync, exports, and the
   sender's own state must stay silent. Use one client-wide note throttle and a
   hard active-voice cap.

10. **Storybook captions need a canonical edit policy.** Use a short explicit
    save action or debounced revisioned updates, a 160-character cap, and
    server-side filtering. For an all-ages book artifact, reject any filter hit
    consistently rather than allowing private-chat language rules to leak into
    saved captions. Resolve concurrent saves as server-ordered last-write-wins
    and show the resulting canonical caption.

11. **Storybook export must be designed for phone memory.** Do not hold four
    full 4000×2500 data URLs plus hydrated scenes at once. Hydrate one page at a
    time, render a bounded print image (for example 1200×750), release the scene
    canvas/blob, and then continue. Individual full-resolution PNG export may
    be an explicit desktop follow-up.

### P2 — polish and follow-up

- Name mirror modes in child-friendly language and show a tiny icon: “Mirror,”
  “Four corners,” and “Magic wheel.” The technical mode remains available to
  screen readers.
- Radial strokes that meet at the center/axis can overpaint and look darker.
  De-duplicate exact transformed segments and include center/axis cases in
  golden-image tests.
- Show a static visual pulse for Orchestra notes so muted users receive the
  same collaborative cue; do not couple it to reduced-motion users by default.
- A remixed animated Wall post uses its first frame in MVP and labels that
  choice before room creation.
- Wall lineage cards should say “Remixed from…” but must not imply endorsement
  or collaboration by the source artist.
- Quest copy should avoid tasks that depend on color perception or a timer in
  the default deck. Those belong in optional accessible/themed decks.
- Storybook title and page prompts must not use animation terminology in the
  storybook UI even though scenes/frames power it internally.

## Concrete MVP cuts

### Kaleido Jam

Ship:

- Featured `KALEIDO` room with fixed four-way symmetry.
- Host setting in private rooms for none, vertical mirror, four-way, and
  radial-eight.
- Marker, pencil, crayon, basic paint, and eraser only in mirrored rendering.
- Fixed center, non-destructive guide, descriptor stamped at stroke start.
- Pure transform unit tests and visual hashes for live/replay parity.

Cut until the performance follow-up:

- Expensive scatter/wet/custom brushes in radial mode.
- Movable origin, rotating symmetry, more than eight copies, per-user modes.
- Symmetry on shape, fill, text, smudge, or image operations.

### Remix Trails

Ship:

- Remix opt-in on Wall publication, default **off**.
- Remix action on eligible non-hidden Wall posts.
- A server-created private room with persisted `{postId, frame: 0}` source.
- Source rendered as an immutable underlay, distinct from editable paint.
- Server-derived `parentPostId` and `rootPostId` at descendant publication.
- Parent attribution and “Source unavailable” orphan state.
- Anonymous draw, save, publish, report, and delete behavior.

Cut:

- Tree visualization, notifications, relay timers, source animation, arbitrary
  frame selection, and creator profile links.

### Canvas Quests

Ship:

- Featured daily `QUEST` room and opt-in private-room quest set.
- Three repository-owned, non-timed, accessibility-safe prompts.
- One “We did it” vote per live participant and visible agreement count.
- Persisted completed ids; ephemeral pending votes.
- Small capped play-money award once per device/set.
- Host reset for private rooms; UTC rollover for the featured room.

Cut:

- Computer vision, timed/color-restriction prompts, classroom-authored text,
  leaderboards, streaks, cross-device reward reconciliation, and global scores.

### Paint Orchestra

Ship:

- Featured `ORCHSTRA` room (Paint Orchestra) and explicit per-session “Hear the painting” action.
- Four instrument families, one pentatonic scale, mute, and volume.
- Pitch from horizontal position; timbre/register from vertical position;
  velocity affects bounded gain.
- Maximum 10 note starts/second per client and 12 simultaneous voices.
- Silent history/resync/export and no-audio fallback.

Cut:

- Room conductor controls, mood selection, recorded soundtrack, audio export,
  microphones/uploads, and persisted enabled state.

### Storybook Expeditions

Ship only after the P0 redesign gate:

- A `STORYBOOK` discovery card that creates a fresh private room, rather than a
  shared public anchor room.
- Exactly four pages, one scene and one frame per page.
- Four fixed curated prompt ids, 160-character captions, and page presence.
- Anonymous guest host with lock/unlock and reorder controls.
- Bounded page-turn preview and print-quality low-memory export.
- Anonymous room persistence and local artifact save.

Cut:

- Six-page books, extra frames per page, public book discovery, Wall
  publication, PDF generation, narration, branching, AI text, and
  multi-production storybooks.

## Feature acceptance tests

These are product acceptance gates in addition to build, lint, server syntax,
and focused unit/integration coverage.

### Shared and anonymous baseline

| ID | Test | Setup | Required result |
|---|---|---|---|
| S-01 | Cloud-unconfigured launch | Unset `PB_URL` and `VITE_PB_URL`; use a clean browser profile | Home, Wall, ordinary studio, private room creation, and all released creative modes load without account UI blocking the task |
| S-02 | Old room compatibility | Start with a persisted room JSON containing none of the new fields | Room loads with all new modes off and its existing history unchanged |
| S-03 | Malformed state | Send unknown modes, oversized ids/text, mismatched values, and forbidden state changes | Server rejects or normalizes them; no crash, persistence corruption, or broadcast |
| S-04 | Ordinary-room parity | Capture normal-room ops before and after feature code | Draw-op shape remains unchanged; rendering, reconnect, and export are visually identical |
| S-05 | Mode conflicts | Attempt every unsupported pairing with animation, game, phone, and storybook | Server remains canonical and broadcasts one valid resulting state |
| S-06 | Mobile shell | Exercise controls at 375×667 with keyboard open, chat open, and quickbar visible | Canvas remains drawable; feature panel can collapse; primary controls are reachable without horizontal overflow |
| S-07 | Account deletion | Enable every new local preference/receipt, then delete account/data | Every new durable key is wiped; anonymous base functionality still works afterward |

### Kaleido Jam

| ID | Test | Setup | Required result |
|---|---|---|---|
| K-01 | Live anonymous parity | Two anonymous clients, each draws in every supported mode | Both clients show the same copies in the same positions |
| K-02 | Stroke-time capture | Start a stroke, change room symmetry from another host client, then end it | Whole stroke keeps its start-time mode; the next stroke uses the new mode |
| K-03 | Replay/restart parity | Draw, reconnect, restart server, view via homepage spectator, and export | All rendered results match the live mural |
| K-04 | Unsupported operations | Use shape, fill, text, image, and smudge while symmetry is active | Each remains single-copy and does not corrupt subsequent brush strokes |
| K-05 | Input validation | Forge mode/copy values and mutate a featured room setting as a non-host | Invalid state is rejected; unauthorized setting does not change |
| K-06 | Axis/center behavior | Draw across center, exactly on each axis, and outside expected bounds | No duplicate dark seam from exact copies, clipping crash, or non-finite coordinate |
| K-07 | Performance gate | 60-second radial-eight stress with maximum supported brush size and two remote painters on target mobile hardware | No runaway buffers; pointer remains responsive; no sustained severe frame degradation or crash |

### Remix Trails

| ID | Test | Setup | Required result |
|---|---|---|---|
| R-01 | Consent default | Publish a Wall post without changing remix settings | Post is not remixable |
| R-02 | Anonymous full flow | Publish opt-in source, open Remix signed out, draw, save, and publish | No sign-in required; descendant displays correct parent attribution |
| R-03 | Shared source | Invite a second anonymous client, reconnect both, then restart server | Same immutable source underlay appears to both clients every time |
| R-04 | Server-derived lineage | Forge parent/root ids and attempt a cycle | Server ignores supplied roots, derives the real root, and rejects invalid sources |
| R-05 | Moderation/deletion race | Hide, opt out, and delete a source after a remix room opens | New publishing follows the defined fail/unlinked-confirmation policy; no hidden image is newly served |
| R-06 | Orphan behavior | Delete a parent that already has descendants | Descendants remain reportable and load with “Source unavailable”; no identifying metadata is copied forward |
| R-07 | Source isolation | Erase/clear the remix room and inspect export | Editable paint can clear; source stays immutable during editing and appears exactly once in the intended export |
| R-08 | Animated source | Remix a multi-frame Wall post | MVP clearly uses frame 0 only and does not silently animate or fetch all frames |

### Canvas Quests

| ID | Test | Setup | Required result |
|---|---|---|---|
| Q-01 | Exact quorum | Test one, two, three, and four active painters | Required votes are 1, 2, 2, and 3 respectively and UI shows the count |
| Q-02 | Spectator exclusion | Connect homepage spectators and attempt to send votes | Spectators neither vote nor increase quorum |
| Q-03 | Disconnect/reconnect | Vote, disconnect before completion, reconnect with a new socket | Old pending vote is removed and is not persisted or duplicated |
| Q-04 | Canonical progress | Three clients vote nearly simultaneously | Mission completes once; all clients receive one canonical completion |
| Q-05 | Persistence boundary | Restart with pending votes and completed missions | Pending votes are gone; completed missions and set id remain |
| Q-06 | Featured rollover | Cross the UTC day boundary in the featured room | A new deterministic set replaces the old set once; no mixed progress |
| Q-07 | Reward cap | Replay completion broadcasts, reconnect, reload, change clock, and use two tabs | One device/set credit only; daily cap holds; receipt store remains bounded |
| Q-08 | Disabled regression | Ordinary room with quests off | No panel, quest traffic, economy writes, or drawing-path cost |

### Paint Orchestra

| ID | Test | Setup | Required result |
|---|---|---|---|
| O-01 | Consent | Fresh load and returning load with saved volume | No sound or audio context playback until this session’s user gesture |
| O-02 | Immediate mute | Hold a long local/remote stroke and press mute | Scheduled notes cancel and all active voices release immediately |
| O-03 | Silent hydration | Join a busy room, switch scenes, resync, reconnect, and export | History and non-live operations produce no sound |
| O-04 | No sender double-play | Draw locally while connected to another client | Local note sounds once; server traffic never echoes a second local note |
| O-05 | Resource cap | Four users generate dense spray-like point traffic for 60 seconds | Note-start and active-voice caps hold; no growing oscillator/node count |
| O-06 | Disabled cost | Profile drawing with Orchestra off/muted | Only a constant-time disabled branch is added; drawing latency is materially unchanged |
| O-07 | Platform fallback | Block Web Audio or force context creation failure | A clear silent-state message appears and the canvas remains fully functional |
| O-08 | Accessibility | Screen reader, keyboard-only, reduced motion, and mute | Controls have labels/state; visual pulse does not flash; mute is always reachable |

### Storybook Expeditions

| ID | Test | Setup | Required result |
|---|---|---|---|
| B-01 | Fresh project lifecycle | Launch Storybook twice from discovery while signed out | Two distinct private rooms/books are created; no global shared book is reused |
| B-02 | Anonymous ownership | First anonymous creator invites another painter | Creator has session host controls; collaborator can draw/caption but not lock/reorder |
| B-03 | Page isolation | Put two clients on different pages and draw concurrently | Ops land only on their target pages; presence shows the correct page |
| B-04 | Authoritative page lock | Lock a page and forge op/clear/frame/sheet/caption messages as non-host | Every content mutation is rejected while other unlocked pages still work |
| B-05 | Caption safety/concurrency | Submit mild/severe terms and near-simultaneous valid edits | Filter policy is consistent; canonical last-write result appears on all clients |
| B-06 | Reorder and restart | Reorder pages, reconnect late, and restart server | Order, captions, locks, prompts, presence target, and art restore correctly |
| B-07 | Export integrity | Export after visiting only one of four pages locally | Export hydrates all four in canonical order, contains each caption once, and does not mutate room state |
| B-08 | Mobile memory | Repeated preview/export on target mobile hardware | Memory returns after each page; no tab crash, frozen canvas, or retained four-page full-resolution data-URL set |
| B-09 | Host departure | Anonymous session host leaves while collaborators remain | Existing guest-host reassignment provides a clear recovery path without unlocking pages implicitly |

## Regression-risk register

| Risk | Features | Likelihood / impact | Mitigation and gate |
|---|---|---|---|
| Live, replay, spectator, and export render different pixels | Kaleido | High / high | One pure transform contract; parity fixtures exercised in all renderers |
| Stroke CPU/memory multiplies beyond mobile limits | Kaleido | High / high | Supported-brush allowlist, copy cap, buffer accounting, hardware stress gate |
| Ordinary draw ops or legacy room JSON change | All room modes | Medium / high | Optional sanitized defaults and normal-room byte-shape regression test |
| Conflicting room booleans create impossible UI/server state | Kaleido, Quests, Orchestra, Storybook | High / high | Canonical primary mode plus explicit enhancement compatibility matrix |
| Hidden/deleted art is still fetched as a remix source | Remix | Medium / high | Resolve eligibility server-side on room creation and again on descendant publish |
| Source removal deletes or deanonymizes descendants | Remix | Medium / high | Store opaque post ids only; orphan descendants; never copy owner keys/profile ids |
| Wall pruning frequently breaks lineage | Remix | Medium / medium | Render orphan state; consider excluding referenced roots from automatic age pruning only if storage budget permits |
| Reconnect or multi-tab voting completes quests unfairly | Quests | High / medium | Ephemeral connection vote plus disconnect cleanup; rewards remain local play money |
| Quest completion/reward broadcast is processed twice | Quests | Medium / medium | Idempotent `setId:missionId` completion and bounded local receipt |
| Audio node leak or note storm degrades drawing | Orchestra | Medium / high | Global throttle, hard voice cap, release/disconnect cleanup, stress instrumentation |
| Browser resumes audio unexpectedly | Orchestra | Medium / high | Never persist enabled state; explicit gesture each page session |
| Page lock is client-only or bypassed via alternate mutation | Storybook | High / high | Central server `canMutatePage` guard used by every mutation case |
| Multi-page export crashes mobile | Storybook | High / high | Sequential hydration/render/release and bounded export resolution |
| Caption text creates a new unsafe durable surface | Storybook | Medium / high | Server-side length/filter policy, reporting context, account scrub coverage |
| New local keys survive account deletion | Quests, Orchestra | Medium / high | Deletion test must fail until keys are in the centralized wipe lists |
| Feature panels crowd chat/quickbar on 375px | All | High / medium | One collapsed status chip; one modal/drawer open at a time; keyboard-open QA |

## Recommended release sequence

### Phase 0 — shared safety rails

- Add server-owned mode/capability normalization and backward-compatible room
  defaults.
- Define the compatibility matrix and make the server authoritative.
- Establish WebSocket integration fixtures for anonymous join, host/guest-host
  authorization, reconnect, restart, invalid messages, and old room JSON.
- Capture an ordinary-room operation/replay baseline before feature changes.
- Keep every new featured entry disabled until its feature-specific gate passes.

### Phase 1 — Kaleido pilot

- Release fixed four-way symmetry in `KALEIDO` with the limited brush allowlist.
- Enable private-room mirror/four-way controls.
- Add radial-eight only after target-mobile stress and replay parity pass.
- Watch event-loop lag, client responsiveness, room-file size, and crash reports.

### Phase 2 — Paint Orchestra

- Release as an explicit session opt-in in `ORCHSTRA`.
- Start with four sounds and fixed mapping; verify real iOS Safari and Android
  Chrome behavior before exposing it as a private-room enhancement.
- This phase can reuse feature-discovery work without changing persisted art.

### Phase 3 — Remix Trails

- First ship consent metadata, owner revocation, canonical source-room creation,
  and orphan-safe attribution behind an unlisted test route.
- Then expose the Wall CTA after anonymous two-client/restart and moderation-race
  tests pass.
- Do not ship a lineage tree in this phase.

### Phase 4 — Canvas Quests

- Launch private-room quest sets first to validate quorum language and reward
  idempotency with small groups.
- Add the daily public `QUEST` room once rollover and disconnect cases are
  proven.
- Assess whether the reward improves completion or distracts from collaboration;
  the quests must remain satisfying with the reward removed.

### Phase 5 — Storybook project pilot

- Build only after the fresh-project launcher and authoritative page-lock
  design are accepted.
- Pilot as private invite books with four pages and bounded export.
- Add a featured discovery card only as a launcher. Public discovery or Wall
  publication is a later moderation project, not part of this release.

## Release sign-off checklist

A feature is releasable only when:

- its decision-table gate and every applicable acceptance row pass;
- `npm run build`, `npm run lint`, and `node --check server.js` pass;
- server protocol changes pass spawned-server multi-client integration tests;
- 375px mobile visual/interaction QA is recorded;
- reconnect and server-restart behavior is verified;
- the full cloud-unconfigured anonymous baseline passes;
- unsupported/forged protocol messages fail closed;
- account deletion wipes every new durable client key;
- no copy suggests money value, endorsement, automatic public sharing, or a
  requirement to sign in;
- a host/admin has a recovery action for every new persistent collaborative
  state; and
- the feature can be disabled without changing the normal studio experience.
