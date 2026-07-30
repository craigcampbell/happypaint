# Drawesome Creative Five

Product scope, technical implementation plan, and release criteria for five
anonymous-first creative features:

1. Kaleido Jam
2. Remix Trails
3. Canvas Quests
4. Paint Orchestra
5. Storybook Expeditions

This plan assumes the current Drawesome architecture: a React/Vite studio, a
single shared multiplayer canvas, an operation-relay WebSocket server, room
persistence under `DATA_DIR`, optional PocketBase accounts, the Fridge Wall,
Paint Space assets, play-money Drops, scenes/frames, and existing export tools.

## Shared product rules

- Drawing, joining, saving, and every new mode must work when PocketBase is
  completely unconfigured.
- Accounts may add attribution or cross-device continuity, but never unlock the
  core creative interaction.
- No real-money rewards, payouts, loot boxes, or cash-equivalent language.
- Public user-generated content uses the existing report/moderation surfaces.
- New durable client storage keys must be added to account-deletion wipe lists.
- Room state must derive from `DATA_DIR`; do not create a second persistence
  root.
- Multiplayer features must remain compatible with the single shared canvas.
- New brush behavior must replay deterministically from the stored operation.
- Sound and motion are optional, locally mutable, and respectful of reduced
  motion and sensory preferences.
- The drawing hot path is the product's performance boundary. Expensive work is
  throttled, capped, deferred, or performed only at stroke commit.

## Release strategy

Each feature ships behind a room capability or explicit user action. Featured
rooms provide immediate discovery while private rooms expose host-controlled
toggles where appropriate. A feature can be released independently; no feature
may make another mode or the anonymous studio unavailable.

---

## 1. Kaleido Jam

### Product idea

Kaleido Jam mirrors each brush stroke around the canvas to create shared
mandalas, snowflakes, creatures, visual spells, and pattern art. It offers an
immediate "that looks amazing" result even to a first-time artist.

### Feature set

#### MVP

- A featured `KALEIDO` room.
- Three symmetry choices: mirror, four-way, and radial eight-way.
- A compact symmetry indicator in the studio.
- Host-selectable symmetry in private rooms.
- Brush and eraser support.
- Deterministic multiplayer replay.
- Existing image and timelapse sharing work unchanged.

#### Follow-up

- Movable symmetry origin.
- Rotating symmetry while drawing.
- Wedge guides that can be hidden.
- Daily pattern prompts.
- Pattern export as a Paint Space template or stamp.

#### Explicitly out of scope for MVP

- Mirroring text, imported images, fill, shapes, or smudge.
- More than eight rendered copies.
- Per-user symmetry settings within the same room.

### Experience

The featured room opens with four-way symmetry and a faint guide. The guide is
non-destructive and never enters room history. In private rooms, the host can
choose the room mode from a small control; everyone receives the change.

### Technical implementation

- Add a normalized symmetry descriptor:

  ```js
  { mode: "none" | "mirror" | "quad" | "radial", copies: 1 | 2 | 4 | 8 }
  ```

- Persist the active room setting and include it in the join handshake.
- Stamp the resolved symmetry descriptor into each `draw` operation at stroke
  start. A later room-setting change must not alter old strokes.
- Transform world-space points around the fixed canvas center during local and
  replay rendering. Do not expand the network payload into eight point sets.
- Keep transformation logic pure and covered by coordinate tests.
- Render the guide in an overlay canvas or CSS layer, not a paint layer.
- Validate/cap symmetry values on both client and server.

### Primary code surfaces

- `server.js`: featured-room capability, persisted room setting, host message.
- `src/hooks/useMultiplayer.js`: symmetry sender.
- `src/App.jsx`: room state, stroke setting, guide, controls.
- `src/utils/symmetry.js`: pure transformations and normalization.

### Acceptance criteria

- Two anonymous clients see identical mirrored strokes after live drawing,
  reconnect, and server restart.
- Changing the mode never changes already-painted strokes.
- Unsupported operations remain single-copy.
- Eight-way mode remains usable on the 375px mobile viewport with spray and
  watercolor brushes.
- Normal rooms produce byte-for-byte equivalent non-symmetry operation shapes.

---

## 2. Remix Trails

### Product idea

Any remix-enabled Fridge Wall post can become the beginning of a new artwork.
Each published descendant links back to its source, forming a visible creative
family tree rather than a feed of isolated pictures.

### Feature set

#### MVP

- A `Remix` action on eligible Wall posts.
- Creator-controlled "Allow remixes" during publishing.
- Opening a remix creates a new private room with the source image as a locked
  visual base.
- Published remixes store `parentPostId` and `rootPostId`.
- Wall cards show "Remixed from …" with a link to the parent.
- Anonymous users can remix, save, and share locally.
- Existing Wall reports and admin removal cover every remix.

#### Follow-up

- A visual remix-tree page.
- Three-person timed remix relays.
- Notifications when a signed-in creator's work is remixed.
- Opt-in remix prompts such as "change the weather" or "100 years later."

#### Explicitly out of scope for MVP

- Automatic public publishing.
- Editing the source Wall record.
- Account-required remixing.
- Copying source artist profile details into room persistence.

### Experience

Tapping Remix shows a short explanation and enters a new room. The original
artwork is visually present but cannot be accidentally erased. The user paints
on top and may later save or publish it. Publishing clearly shows the lineage
and never implies endorsement by the original creator.

### Technical implementation

- Extend Wall post records:

  ```js
  {
    allowRemix: true,
    parentPostId: null,
    rootPostId: null
  }
  ```

- Extend Wall GET responses with the minimal parent card metadata needed for
  attribution.
- Add a safe source-image endpoint or reuse the immutable frame endpoint.
- Carry remix context into the studio via a bounded post id, not a data URL.
- Resolve the source server-side, enforce `allowRemix`, and load it as a
  non-destructive base/trace layer.
- Carry lineage into the existing Wall publishing modal.
- If a parent is removed, retain the descendant but render "Source unavailable."
- Reject cycles and self-supplied parent/root ids; the server derives roots.

### Primary code surfaces

- `server.js`: Wall schema validation, lineage derivation, source lookup.
- `src/components/WallPage.jsx`: Remix CTA and attribution.
- `src/components/WallPostModal.jsx`: opt-in and lineage payload.
- `src/App.jsx`: remix source loading and publish context.

### Safety and ownership

- Remixing is opt-in per post.
- Attribution uses existing public post metadata only.
- Removed/reported posts are not valid new remix sources.
- The source remains visually distinct from editable paint.
- Public descendants remain independently reportable.

### Acceptance criteria

- An anonymous visitor can open, alter, save, and optionally publish a remix.
- The server, not the client, establishes parent/root lineage.
- Opted-out and removed posts cannot start a remix.
- A deleted parent does not corrupt or delete descendants.
- Account deletion removes or anonymizes authored Wall records according to the
  existing policy without leaving identifying lineage data.

---

## 3. Canvas Quests

### Product idea

Canvas Quests gives a room three cooperative creative missions. The group
decides when each is complete; Drawesome does not need image recognition or
competitive judging.

Example missions:

- Hide a tiny frog somewhere.
- Use only three colors for one minute.
- Add something another artist can finish.
- Turn an accidental mark into a character.
- Everyone adds one part to the same creature.

### Feature set

#### MVP

- A curated, repository-owned mission deck.
- A featured `QUEST` room.
- Three deterministic missions per quest set.
- A compact collapsible quest panel.
- Any participant can nominate a mission as complete.
- Majority confirmation completes the mission.
- Shared progress, confetti, and a capped play-money Drops reward.
- Quest progress persists with the room.
- Host-enabled quests in private rooms.

#### Follow-up

- Themed decks: cozy, creatures, space, animation, color theory.
- Accessibility decks without time or color restrictions.
- Classroom deck with teacher-authored prompts.
- Quest recap included in timelapse sharing.

#### Explicitly out of scope for MVP

- Computer-vision completion detection.
- Global leaderboards.
- Cashable or purchasable rewards.
- Free-form public mission text.

### Technical implementation

- Curated mission records:

  ```js
  {
    id: "finish-a-friend-shape",
    text: "Add something another artist can finish.",
    emoji: "🤝",
    durationMs: null
  }
  ```

- Persist room quest state:

  ```js
  {
    setId,
    missionIds,
    completedIds,
    nominations: { [missionId]: [connectionOrProfileKey] }
  }
  ```

- Add `quest_nominate`, `quest_reset`, and `set_quests` messages.
- The server determines quorum from active non-spectator participants and
  broadcasts canonical progress.
- Keep curated text server-side; clients send ids only.
- Drops are awarded locally and capped by quest-set id/device. This is acceptable
  only because Drops remain play money.
- Add any new reward receipt key to the deletion wipe list.

### Primary code surfaces

- `server/questDeck.js`: curated missions and deterministic set selection.
- `server.js`: state, persistence, quorum, WebSocket cases.
- `src/hooks/useMultiplayer.js`: quest messages.
- `src/components/QuestPanel.jsx`: mission UI.
- `src/App.jsx`: progress state, rewards, celebration.
- `src/utils/economy.js`: capped quest reward reason.

### Acceptance criteria

- Three anonymous clients share identical quest progress.
- Reconnecting and restarting retain completed missions.
- A single user cannot complete a multi-user mission alone while others are
  present.
- Spectators cannot vote.
- Quest rewards remain capped and contain no real-money language.
- The ordinary canvas remains fully usable with quests disabled.

---

## 4. Paint Orchestra

### Product idea

Paint Orchestra maps strokes to gentle synthesized sound. Position controls
pitch/tone, movement controls intensity, and brush families sound different.
Friends can hear a collaborative painting become a small improvised song.

### Feature set

#### MVP

- A featured `ORCHSTRA` room (the eight-character protocol code for Paint Orchestra).
- An explicit `Hear the painting` opt-in.
- Persistent local mute and volume controls.
- Deterministic brush-family instrument mapping.
- Horizontal position maps to a kid-safe scale.
- Vertical position changes register or tone.
- Stroke velocity changes volume within a safe cap.
- Local and remote strokes are audible.
- Audio-event throttling to protect performance.

#### Follow-up

- Record a deterministic soundtrack beside timelapse playback.
- Choose a mood/scale: dreamy, arcade, jungle, space.
- A conductor mode that changes tempo and scale for the room.
- Accessible visual note ripples for users who keep sound muted.

#### Explicitly out of scope for MVP

- Microphone recording or uploaded audio.
- Voice chat.
- Server-stored audio.
- Audio embedded in exports.
- Autoplay before a user gesture.

### Suggested sound palette

| Brush family | Sound |
|---|---|
| Marker / pencil | Marimba |
| Watercolor / gouache | Soft pad |
| Crayon | Plucked string |
| Spray | Shaker |
| Oil / acrylic | Warm bass |
| Eraser | Muted percussion |

### Technical implementation

- Implement a small Web Audio engine with lazy `AudioContext` creation after a
  user gesture.
- Map coordinates to a pentatonic scale to avoid harsh note collisions.
- Quantize pitch and throttle to approximately 8–12 notes per second globally.
- Use short oscillator/envelope voices; cap simultaneous voices and disconnect
  them after release.
- Derive notes from the same normalized stroke points used by rendering.
- Do not add audio frames to WebSocket history. Remote draw operations already
  contain enough information to reproduce notes during live activity.
- Do not play history replay or hydration by default.
- Store only local preference values; add keys to the deletion wipe list if
  they are considered account-associated settings.

### Primary code surfaces

- `src/utils/paintOrchestra.js`: pure mapping plus Web Audio voice manager.
- `src/components/PaintOrchestraPanel.jsx`: opt-in/mute/volume.
- `src/App.jsx`: feed live local/remote points without replay audio.
- `server.js`: featured-room capability only.

### Acceptance criteria

- No sound plays before explicit opt-in.
- Muting immediately stops and disconnects active voices.
- A long spray stroke cannot create unbounded oscillators.
- History hydration remains silent.
- Drawing latency and frame rate are materially unchanged when audio is muted.
- Unsupported browsers retain a fully working silent canvas.

---

## 5. Storybook Expeditions

### Product idea

Storybook Expeditions lets a group create a short illustrated book. It reuses
Drawesome's scenes and production infrastructure but presents the experience as
pages, captions, and story prompts instead of animation terminology.

### Feature set

#### MVP

- A featured `STORYBOOK` room.
- Four illustrated pages.
- Curated story structure:
  1. Meet the character.
  2. A surprising problem appears.
  3. The character tries something.
  4. The ending changes everything.
- A short caption per page.
- Page presence showing where collaborators are working.
- Host page lock/unlock and reorder.
- A page-turn preview.
- Export as printable HTML and individual PNG pages.
- Anonymous room persistence and local saving.

#### Follow-up

- Three-, four-, and six-page templates.
- Branching choose-your-own-adventure books.
- Voice narration recorded locally by a guardian.
- Classroom anthology export.
- Publish a safe preview card to the Fridge Wall.

#### Explicitly out of scope for MVP

- Public free-form story discovery.
- Server-side PDF generation.
- AI-written stories.
- Required sign-in.
- Real-time simultaneous editing of different canvases inside one browser.

### Technical implementation

- Build on the existing scene model: one scene equals one page.
- Add a persisted storybook descriptor:

  ```js
  {
    enabled: true,
    title: "Our Story",
    pages: [
      { sceneId, caption, promptId, locked: false }
    ]
  }
  ```

- Curated prompt ids resolve to local safe text.
- Add `storybook_caption`, `storybook_lock`, `storybook_move`, and
  `set_storybook` messages. Host-only mutations are enforced server-side where
  indicated.
- Reuse scene history fetching and presence rather than inventing per-user
  canvases.
- Captions are scanned and length-limited before persistence/broadcast.
- Export composes the existing scene snapshots into a print stylesheet or a
  downloaded set of page images. Avoid introducing a PDF dependency for MVP.
- The normal animation filmstrip is replaced by a page strip while storybook
  mode is active.

### Primary code surfaces

- `server/storybookPrompts.js`: curated structures/prompts.
- `server.js`: capability, persistence, caption and page controls.
- `src/hooks/useMultiplayer.js`: storybook messages.
- `src/components/StorybookPanel.jsx`: page navigation/captions/preview.
- `src/App.jsx`: scene-mode adaptation and export.

### Acceptance criteria

- Anonymous collaborators can complete and revisit a four-page book.
- Page art and captions survive server restart.
- Late joiners see correct page ordering, locks, captions, and presence.
- Non-hosts cannot reorder or lock pages.
- Caption filtering matches existing kid-safe chat behavior.
- Export includes all four pages in order without changing room state.

---

## Cross-feature protocol and persistence plan

Room records gain optional fields with safe defaults so old JSON files continue
to load:

```js
{
  symmetry: { mode: "none", copies: 1 },
  quests: null,
  storybook: null
}
```

Featured-room definitions gain capability flags:

```js
{
  symmetry: true,
  orchestra: true,
  quests: true,
  storybook: true
}
```

Capabilities are included in the existing join handshake. Clients must treat
missing flags and fields as disabled. Persisted structures are sanitized on
load, and unknown future fields are ignored.

Remix lineage belongs to Wall post records rather than room records. Paint
Orchestra remains ephemeral except for a local audio preference.

## Testing plan

### Automated

- Pure coordinate tests for every symmetry mode.
- Paint Orchestra pitch/velocity/throttle tests without a real audio device.
- Server syntax check.
- Build and zero-warning lint.
- WebSocket integration tests using spawned `server.js`:
  - anonymous join and capability handshake;
  - host-only room changes;
  - quest quorum and restart persistence;
  - storybook caption/lock/reorder and late join;
  - unchanged normal room behavior.
- REST tests:
  - remix opt-in;
  - server-derived lineage;
  - removed/invalid source rejection;
  - anonymous Wall behavior.

### Visual and interaction QA

- 375px mobile viewport is primary.
- Two-client live drawing for Kaleido and Orchestra.
- Three-client quest completion.
- Storybook page switching with participants on different pages.
- Wall → Remix → Save → Publish lineage flow.
- Reconnect and restart for all persisted states.
- Reduced-motion, sound-muted, keyboard, and screen-reader-label checks.
- Unsupported Web Audio fallback.

### Anonymous regression

Run with both `PB_URL` and `VITE_PB_URL` unset:

- open home and enter each featured room;
- create a private room;
- draw, save, share, and publish where currently allowed;
- complete a quest;
- create and export a storybook;
- start and save a remix;
- confirm no sign-in prompt blocks the flow.

## Product review checklist

- Does the feature create a result worth sharing within five minutes?
- Is the first useful action obvious on a phone?
- Does the feature still feel collaborative with only two people?
- Can one disruptive participant spoil the mode, and can a host recover?
- Is there any new free-form text or media surface requiring moderation?
- Is progress understandable after reconnecting?
- Does the feature add noise to the normal studio when disabled?
- Does it offer a meaningful anonymous experience?
- Does any reward language imply real monetary value?
- Does the feature strengthen one of Drawesome's loops: create, collaborate,
  return, remix, or share?

## Recommended implementation order

1. Kaleido Jam — smallest technical surface and fastest visible payoff.
2. Paint Orchestra — mostly isolated and a strong featured-room differentiator.
3. Remix Trails — connects the Wall to creation and improves retention.
4. Canvas Quests — adds persistent cooperative progression.
5. Storybook Expeditions — largest scope and best built after the shared room
   capability/state patterns are proven.
