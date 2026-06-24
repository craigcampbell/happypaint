# Content Moderation + Multiple Public Rooms — Architecture Contract

Status: **built + verified** on branch `content-moderation` (server: 6/6 in
`test/harness/run.mjs`; text filter: 40/40 in `server/moderation/textFilter.test.mjs`;
SPA build + studio smoke green). The one remaining piece is swapping the watcher's
**placeholder heuristic detector** for a real model (NSFWJS/TF.js or an admin-opt-in
cloud-escalation tier) — the whole pipeline around it is real and tested.
This is the single source of truth for the feature. Server code, client code, the
test harness, and every subagent build against the names and rules below. If an
implementation disagrees with this doc, the doc wins (or the doc is updated first).

> Read [ARCHITECTURE.md](../ARCHITECTURE.md) for the system map and
> [AGENTS.md](../AGENTS.md) for house conventions before touching code.

---

## 0. Non-negotiable: the drawing experience comes first

Moderation must be **invisible to the person drawing.** Every reviewer and every
agent treats this as the top priority — a correct feature that adds jank to the
canvas is a failed feature.

**The drawing hot path (NEVER block, read, or call into it for moderation):**

```
pointerdown/move/up  →  stroke point buffer  →  scheduleStrokeFrame()
   →  requestAnimationFrame  →  renderStrokeFrame()  →  blitToDisplay()
   (stroke flush) →  mp.sendOp({kind:'draw', strokeId, points})
   (remote op)    →  applyRemoteOp()  →  scheduleStrokeFrame()/renderDisplay()
```
Defined in `src/App.jsx` (`renderStrokeFrame` ~752, `scheduleStrokeFrame` ~786,
`renderDisplay` ~692, `handleMpMessage` ~3191). `activePointerRef.current != null`
means a local stroke is live.

**Hard rules for the in-browser watcher (Phase 4):**

1. Runs **only** when the server elects this client (`watcher_role.active`) and
   **only** in `kid_safe` rooms.
2. **Never** samples while `activePointerRef.current != null`. A live stroke
   always wins; the sample is deferred to the next idle window.
3. Sampling is throttled to **at most once per `intervalMs` (default 8000 ms)**,
   scheduled via `requestIdleCallback` (fallback `setTimeout`), and skipped unless
   a dirty flag says the canvas changed since the last sample.
4. The snapshot is a **single `drawImage`** of the document canvas downscaled to
   **≤ 256 px** longest side, handed to the worker via **`createImageBitmap`**
   (async, off the main thread). No `getImageData`/pixel loops on the main thread.
5. **All inference runs in a Web Worker** (`OffscreenCanvas`). The main thread only
   posts an `ImageBitmap` and receives a number. The model is lazy-loaded inside
   the worker after first idle, never during page load.
6. **Capability gate:** a client declines watcher election if
   `navigator.hardwareConcurrency < 4` or `navigator.deviceMemory < 4`. Weak
   devices never scan.
7. The server elects **at most 2 watchers per room** (most-capable, signed-in
   preferred). Everyone else only draws.

Server-side moderation (text scan, opId tagging, flag handling) must be O(1)–O(small)
per message and must not add synchronous work to the `op` relay broadcast beyond a
single integer increment.

---

## 1. Room audience model (server-authoritative)

New persisted room fields (added to `loadRoom` / `persistRoom` / `getRoom` together,
per AGENTS.md). All default safely so existing rooms keep working.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `audience` | `'kid_safe' \| 'friends' \| 'adult_18'` | `'kid_safe'` for `MAIN`; `'friends'` otherwise | server-enforced audience gate |
| `listed` | `boolean` | `true` when `kid_safe`, else `false` | appears in public discovery |
| `hiddenOpIds` | `number[]` | `[]` | ops hidden by moderation (reversible) |
| `opSeq` | `number` (in-memory, derived) | `0` | monotonic per-room op id counter |

Audience semantics:

- **`kid_safe`** — discoverable; the only audience that auto-moderation runs in;
  default for `MAIN` and rooms created public.
- **`friends`** — invite-only (today's `/join/CODE` rooms). Not discoverable, not
  auto-moderated (out of scope per "public spaces only"). This is the default for a
  lazily-created room reached by code.
- **`adult_18`** — **defined but creation-disabled.** Real adult verification does
  not exist in this stack and must not ship for a kid-directed app without legal
  review. The server **rejects** `audience:'adult_18'` on create (`403`) and never
  lists it in discovery. The gate exists so the model is complete and future-safe;
  no normal user can make one. (Matches `docs/social-backend.md`.)

Audience is decided at **creation**, not per-connect:
- `MAIN` is `kid_safe` (a hardcoded default for the legacy room id).
- A room created via `POST /api/rooms` gets the requested audience (subject to the
  adult_18 rejection) + creator becomes `ownerProfileId`.
- A room reached by `/join/CODE` that does not yet exist is created lazily as
  `friends` (private), exactly as today.

### opId tagging
In the `op` WS case, after the existing author tag, assign a stable id:
`op.opId = (room.opSeq = (room.opSeq || 0) + 1)`. Persisted history keeps `opId`s.
On load, `room.opSeq = max(opId in history)`. opId enables selective hide/restore.

---

## 2. REST endpoints

### `POST /api/rooms`  → create a room
Body: `{ audience, title, listed }`. Auth: `Authorization: Bearer <pb token>`
(validated via existing `verifyAccessToken`).
- `audience` defaults `kid_safe`. `audience:'adult_18'` → `403 { error:'adult_disabled' }`.
- Creating a **`kid_safe` (public)** room **requires a signed-in user** (grown-up
  ownership) → anonymous → `401`. `friends` rooms don't need this endpoint (lazy
  create still works for invite codes).
- Generates a unique 6-char code (alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`),
  writes the room file with `ownerProfileId`, `audience`, `title`, `listed`.
- Returns `{ code }`. Client then navigates to `/join/CODE`.
- Rate-limited per token/IP (basic in-memory token bucket).

### `GET /api/rooms/public`  → sanitized discovery list
Returns live, `listed`, `kid_safe` rooms only:
```
{ rooms: [ { code, title, users, sheetId, lastActivity, hasHost } ] }
```
**Never** returns participant names, chat, raw strokes, owner ids, or `friends`/
`adult_18` rooms (per `docs/social-backend.md` discovery rules). Sorted by activity,
capped (e.g. 60). `Cache-Control: no-store`.

---

## 3. WebSocket protocol additions

Existing protocol is in [ARCHITECTURE.md](../ARCHITECTURE.md). Additions:

### Client → Server
| Type | Who | Payload | Effect |
|---|---|---|---|
| `flag` | any client (acted on only in `kid_safe`) | `{ kind:'image'\|'text', score, sinceOpId, toOpId }` | record a moderation flag; corroboration may trigger Tier 1/2 |
| `mod_hide` | host/admin | `{ opIds:number[] }` | hide ops (reversible) → rebroadcast filtered history |
| `mod_restore` | host/admin | `{ opIds:number[] }` | unhide ops → rebroadcast history |
| `mod_remove` | host/admin | `{ opIds:number[] }` | permanently splice ops from history |
| `watcher_ack` | elected client | `{ capable:boolean }` | accept/decline watcher role |

### Server → Client
| Type | Payload | Effect |
|---|---|---|
| `history` *(existing)* | `{ ops, restored? }` | full canvas rebuild — **reused** for hide/restore/remove (server sends history minus `hiddenOpIds`) |
| `watcher_role` | `{ active:boolean, intervalMs, maxDim }` | start/stop local scanning |
| `mod_alert` | `{ level:'info'\|'warn', reason, opIds?, author?, source:'auto'\|'host'\|'admin' }` | toast to **hosts + admins only**; drives the HostControlPanel moderation list |
| `mod_state` | `{ flags:[...], hidden:[...] }` | snapshot of open flags + hidden ops for host UI (sent to hosts on connect + on change) |

Note: `op` payloads now carry `opId`. Clients should keep the latest seen `opId`
(the watcher needs `sinceOpId`/`toOpId`); no other client behavior changes.

---

## 4. Text moderation (`server/moderation/textFilter.js`)

Pure, dependency-free, synchronous, unit-tested.

```
normalize(s)  → lowercased, diacritics stripped, common leetspeak folded
                (4→a 3→e 1→i/l 0→o 5→s @→a $→s), separators between repeated
                letters collapsed (b.a.d → bad, b a d → bad).
scan(s)       → { hit:boolean, severity:'severe'|'mild'|null, terms:string[] }
```
- Two curated lists: **`severe`** (slurs, sexual terms) and **`mild`** (light
  profanity). Boundary/whole-token matching to avoid the **Scunthorpe problem**
  (`class`, `grass`, `assassin`, `Scunthorpe`, `analysis`, `cockpit`, `Dick` as a
  name, etc. must NOT trip). Adversarially reviewed.
- Lists live in a small data module; easy to extend. Documented as
  best-effort, not exhaustive.

Server hooks (only when `room.audience === 'kid_safe'`):
- **`chat`** case: `scan(message)`. `severe` → drop the message + auto-report +
  `mod_alert`. `mild` → mask (`****`) and deliver, no report.
- **`op` where `kind === 'text'`**: `scan(op.text)`. `severe` → do **not** append/
  broadcast; auto-report + `mod_alert`. `mild` → allow (drawn text is softer than
  chat; tune later).

In `friends` / `adult_18` rooms text moderation does **not** run.

---

## 5. Enforcement ladder (decision: report + alert + reversible hide)

Conservative by default because false positives on a child's real art are harmful.

- **Tier 1 — report + alert (single signal):** auto-create a report
  (`source:'auto'`) and `mod_alert` hosts + admins. **Non-destructive.** Fires on a
  single image flag or a `severe` text hit.
- **Tier 2 — reversible hide + mute (corroborated, or severe text):** auto-hide the
  implicated ops (`hiddenOpIds`, reversible) and mute the author in chat. Triggers
  on **(≥2 independent watcher flags in a window)** OR **(1 watcher flag + 1 human
  report)** OR a `severe` drawn-text/chat hit. Host/admin sees a Restore action.
- **Tier 3 — kick / permanent remove:** **never automatic.** A host/admin does it
  with one click in HostControlPanel / LiveAdmin. (A future admin opt-in may allow
  full-auto Tier 3; off by default.)

For an image flag, the hidden op set = ops with `sinceOpId < opId ≤ toOpId` (the
delta that turned a clean canvas lewd). The watcher tracks `lastCleanOpId`.

All actions append to an in-memory `room.modLog` (capped) and the global reports
store gains a `source` field. Reversible by design end-to-end.

---

## 6. Corroboration & watcher election (server)

- Server tracks per-room `watchers` (elected client ids) and `flags` (recent, with
  ts, kind, score, sinceOpId/toOpId, reporterId). 
- On join/leave, server (re)elects up to 2 watchers among capable, preferably
  signed-in clients, and sends `watcher_role`. If a watcher leaves, re-elect.
- Flags older than the window (e.g. 30 s) are pruned. Tier 2 needs the corroboration
  rule in §5. A single client cannot, by itself, cause destructive (even reversible)
  action unless it also has a human report — defends against a tampered client
  spamming flags **and** against a tampered client suppressing them (other watchers
  + human reports still catch it).

---

## 7. Surfaces

- **HostControlPanel** (`src/components/HostControlPanel.jsx`): a "Moderation"
  section — open flags + hidden strokes with **Restore** / **Remove permanently** /
  **Remove painter**; live `mod_alert` toasts.
- **LiveAdmin** (`src/components/LiveAdmin.jsx`): moderation queue (auto-reports +
  flags + hidden ops), an `audience` column on rooms, and the public-room list.
- **Discovery/lobby**: a browse surface listing `GET /api/rooms/public`, with a
  "Create a public room" entry (the New-room modal). Reuses the `DiscoveryHub` shell.

---

## 8. Phasing

0. Room audience model + opId (server). 1. Public rooms + discovery (REST + UI).
2. Text moderation. 3. Reversible hide / selective undo + host/admin surfaces.
4. In-browser NSFW watcher + corroboration. Phases 0–3 are deterministic and
independent of the image-model choice; Phase 4 is the only one with model unknowns
and ships with a pluggable detector (heuristic default + NSFWJS/cloud seam).

## 9. Verification

`node test/harness/run.mjs` boots `server.js` with a mock PocketBase auth endpoint
and simulated WS clients, asserting: audience gating on join, `POST /api/rooms` +
`GET /api/rooms/public`, text auto-report + hide, `mod_hide`/`mod_restore`/
`mod_remove` by opId, and watcher election + flag corroboration. `npm run build`
and `node --check server.js` must pass. The anonymous (PocketBase-unset) path must
not regress.
