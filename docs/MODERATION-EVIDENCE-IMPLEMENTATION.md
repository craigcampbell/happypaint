# Immutable moderation evidence, implementation report

Date: 2026-09-28 · Tree: `/home/craig/Projects/happypaint-evidence` (isolated copy, baseline + this feature) · Status: implemented + verified locally, NOT deployed, NOT pushed.

Research basis: `.hermes/cache/scratch/drawesome-moderation-evidence-research.md`. One deliberate deviation from the research: **PNG, not JPEG**, is the default evidence encoding: JPEG q0.8 is lossy and therefore NOT bit-identical to the analyzed pixels; PNG at the 256px classifier resolution is small (~1–40 KB) and lossless. JPEG remains available client-side via `evidenceFormat: 'jpeg'`.

## What was built

When an elected watcher's NSFW scan crosses the flag threshold, the EXACT downscaled frame the classifier read is frozen and bound to the moderation report:

1. **Worker** (`src/workers/nsfwWatcher.worker.js`): every scan gets a generation (`src/workers/evidenceGuard.js`). On a flag, the main thread sends `{type:'encode', id, generation, format, quality}`; the worker `convertToBlob`s its unchanged scan canvas and posts back `{id, ok, evidence:{dataUrl,w,h,model}, generation}`. An encode for any generation but the newest is dropped, so a newer frame can never be bound to an older score. The active detector name (`nsfwjs-mobilenetv2`/`heuristic`) rides along.
2. **Controller** (`src/utils/nsfwWatcher.js`): on `score >= threshold && toOpId > sinceOpId` it SEALS sampling (no new scan can overwrite the frame), requests the encode, and only then fires `onFlag({...flag, evidence})`. A stale/mismatched/failed encode, or a 2.5 s timeout (`evidenceTimeoutMs`), still fires the flag, just without pixels. New opts: `evidenceFormat`, `evidenceQuality`, `evidenceTimeoutMs`, `workerFactory` (test seam). `useMultiplayer.sendFlag` needed no change (spreads the payload).
3. **Server** (`server.js`): the `flag` case accepts `evidence` only when the flag produces a report (Tier-1), only from a server-elected watcher (`room.watchers`), and only after hard validation (`decodeEvidenceImage`): allowlisted data URL, strict base64, 220 KB char / 160 KB byte caps, magic-byte sniff that must MATCH the claimed type, real dimensions equal to declared `w`/`h`, and ≤ `WATCH_MAX_DIM`+32 per side. `toOpId` is clamped to the room's real last opId. Bytes go to `DATA_DIR/.evidence/<reportId>.png|jpg` (tmp+rename, server-minted name) with sha256 + metadata in the report (`trust:'client-captured'`, hashed watcher identity, server-authoritative `receivedAt`). Reports also gain `opIds` for image flags.
4. **Lifecycle**: per-room cap (12) + global caps (400 files / 40 MB) evict oldest (`dropped:'quota'`); report-queue cap (`REPORTS_MAX`, default 500) eviction unlinks files; `closeRoom` (idle or moderator delete) drops room evidence (`dropped:'room-closed'`); resolved reports' evidence expires after 30 days via sweep (`expired:true`, text record stays); account deletion nulls `evidence.watcher` for the profile (pixels stay, they are the room's shared canvas, not the watcher's). `.evidence` added to `LEGACY_ROOT_DATA` for the `.data/` migration. All caps/TTL/sweep are env-tunable for tests.
5. **Retrieval**: `GET /api/admin/evidence/:reportId`, admin key, `no-store`, `nosniff`, id validated against `/^rep_[a-z0-9]{1,40}$/` before any filesystem use, bytes re-sniffed and served with the sniffed type. 404 for missing/refused/evicted/expired. Evidence never appears in non-admin payloads.
6. **Admin UI** (`src/components/LiveAdmin.jsx`): `EvidenceThumb` (fetch-with-admin-key → blob URL, like `RoomThumb`) + metadata line + explicit trust label: "Watcher-captured snapshot, client-supplied corroboration, NOT proof. A modified client can forge pixels…", op range attributed to "the room canvas between ops N–M", authorship stays "suspected, review required". No identity is ever accused from pixels. Refused/dropped/expired states render as text.

`server/moderation/console.js` needed no change (reads text fields only; unknown report fields are ignored). `src/utils/accountDeletion.js` needed no change, the evidence bitmap never touches any client-side store (no localStorage/IDB), which the account-deletion wipe lists cover.

## Tests (all synthetic benign images, solid fills/stripes from `test/harness/syntheticPng.mjs`)

| Suite | Result | Covers |
|---|---|---|
| `node scripts/modevidence-controller-verify.mjs` | **21/21** | generation guard; flag carries frozen frame; sampling paused while sealed; **race: mismatched-generation pixels dropped**; stale/failed/timeout encode → flag without pixels; clean watermark; destroy mid-encode |
| `node scripts/modevidence-verify.mjs` (ports 9001/9002, mock PB ephemeral, scratch DATA_DIRs) | **49/49** | capture→persist→retrieval; immutability across 20-op repaint; restart persistence; 401s + `no-store`/`nosniff` + id traversal (400/404, router-normalized `%2e%2e` never reaches fs); 7 malformed/spoof classes refused (SVG, URL, broken b64, claimed-jpeg-png-bytes, dims mismatch, 300px, oversize) with the flag still processed; non-elected uploader refused; per-room quota eviction; global cap eviction; room deletion; TTL expiry; op-range clamp; report-cap eviction with no orphaned files; account-deletion identity scrub (pixels stay) |
| `node scripts/modevidence-ui-verify.mjs` (Playwright, port 9004, built dist) | **11/11** | evidence block renders in `/admin`; browser decodes the snapshot at captured size via blob URL; trust framing + forge warning + "suspected, review required"; op attribution; evidence-less reports render no snapshot. Screenshot: `.hermes/cache/scratch/modevidence-ui-shots/admin-evidence-report.png` (visually verified) |

Regression gates: `node --check server.js` ✅ · `npm run lint` (zero-warning) ✅ · `npm run build` ✅ · `npm ci` from clean `node_modules` ✅.
Per task instruction, the pre-existing fixed-port suites (`test/harness/run.mjs`, `scripts/safety-verify.mjs`, ports 8929 etc.) were **not** run, deferred to the parent to avoid port collisions with sibling work.

## Files changed

- `server.js`, evidence store/validation/quota/TTL/endpoint/scrub; `REPORTS_MAX` const; flag-case binding + op-range clamp; `autoModerate` returns its report; `closeRoom` evidence drop
- `src/workers/nsfwWatcher.worker.js`, generations, encode handler, detector name
- `src/workers/evidenceGuard.js`: NEW: generation guard (unit-tested)
- `src/utils/nsfwWatcher.js`, seal/pause/encode-request/timeout flow, new opts
- `src/components/LiveAdmin.jsx`, `EvidenceThumb`, `EvidenceNote`, report-row wiring
- `docs/CONTENT_MODERATION.md`, §3 `flag` payload, §5 evidence design/trust/lifecycle
- `test/harness/syntheticPng.mjs`: NEW: minimal PNG encoder for tests
- `scripts/modevidence-verify.mjs`, `scripts/modevidence-controller-verify.mjs`, `scripts/modevidence-ui-verify.mjs`: NEW suites

## Limits / notes

- Evidence is client-captured corroboration, never proof; `trust:'client-captured'` leaves room for a future `server-verified` tier (checkpoint cross-validation).
- Tier-2-only corroboration flags (no new first-alert op) do not bind evidence, evidence attaches to the Tier-1 report, which is exactly the "room changed before review" case.
- A 256px solid-color PNG is ~1 KB, noisy frames tens of KB; quotas bound worst case (400 files / 40 MB).
- Suite ports used: 9001, 9002, 9004 (9003 unused); mock PB binds an ephemeral port. All DATA_DIRs and screenshots under `.hermes/cache/scratch`.
- Not deployed, not pushed. Production tree `/home/craig/Projects/happypaint` untouched.
