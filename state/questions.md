# Open questions (loop)
- Placeholders resolved by orchestrator (skill default): 3 cycles, 5 auto-patches/day, iteration branch loop/social-growth, dev port 5173 (spec said 3000). Correct me in this file if wrong.

## Loop complete (3/3 cycles) — RESOLVED 2026-09-16: owner approved moderation stance (011/012 unblocked) and CARD-008. Original questions:
- CARD-011 (watchers+emotes) & CARD-012 (public spectate): minors' moderation policy owner? Blocked until decided.
- CARD-008 (live painter counts on /rooms, effort 3): approve expanding effort gate? Pairs strongly with landed CARD-002.
- End-to-end regression of CARD-001+013+002 on one bundle before merging PR #2.
- Next auto-patch day: CARD-003/004/005/006/007 remain ready.

## Cycle 5 close (loop halted: 5/5 patches today, 5 of 6 cycles used)
Decisions I made without you (reversible, logged here):
- /live/<CODE> is the published public watch address; the admin glass room stays at /watch/<CODE>, key-gated. Tell me if non-admins hitting /watch should be redirected to /live.
- The /rooms "Watch live" affordance was reverted after the verifier rejected it on a real 45px row-alignment regression; CARD-019 re-adds it with a class-based (App.css) treatment instead of inline styles.
- Loop stopped at the 5-patch/day budget rather than starting cycle 6.

Answers I still need:
1. Should the public watch page show the room's live banter (read-only, same allowlist the homepage already shows), or stay canvas-only for the tightest surface?
2. Watchability currently inherits from "public + listed" with no extra opt-in. Keep that default, or require explicit per-room opt-in (that reorders CARD-018 ahead of CARD-016)?
3. If a public-room host wants to stop being watched without unlisting, that is CARD-018 (persisted room field, human-reviewed). Move it ahead of counted watchers (CARD-016)?
4. CARD-014 was verified by me (sub-agents were rate-limited that cycle). Want a second independent pass on it, alongside the end-to-end regression of cycles 1-5, before PR #2 merges?
5. Next patch window: CARD-016 (counted watchers) first, or the ready content cards CARD-003..007?

## Moderation console (built + verified 2026-09-16) — decisions I made, and what still needs you

Shipped: /admin/rooms (Room Radar), /admin/users, /admin/gallery, global block.
Verified: 22/22 unit checks, real chat digest, urgent-report row tint, block closes
live sockets + refuses rejoin, gallery thumbnails + lightbox.

I decided these (reversible, tell me if wrong):
- Block = indefinite until manually unblocked (no auto-expiry). It matches the
  console being manual and is the safe default for a defacer.
- Blocking a guest needed a handle, so the WS auth frame now carries the device's
  random id (localStorage `drawesome:userkey:v1`). IP blocking exists as a fallback
  key but the console does NOT block by IP by default — a school NAT would take out
  a whole classroom.
- The chat synopsis is deterministic by default; no LLM call happens until you set
  MOD_SYNOPSIS_URL (optional MOD_SYNOPSIS_KEY). Nothing but flags and already-clipped
  flagged lines would be sent to it.

Questions:
1. Block duration: indefinite (chosen) vs timed (e.g. 24h) vs escalating?
2. Do you want an audit trail for moderation Actions (who blocked/hid/removed what,
   when)? Right now blocks store `by: admin:<hash>` + reason but nothing lists them.
3. Gallery removal is silent to the owner. Should a removed save notify them, or is
   silence the right call for kid-safe moderation?
4. Should /admin/* require the same key for all four pages (it does), or should
   gallery/removal power sit behind a stronger/second key?
5. LLM synopsis: want me to wire one to your existing provider, and if so which?

## Animation decisions (owner, 2026-09-16)
- Cartoon mode = PRIVATE invite-only rooms; FLIPBOOK stays the shared public animation room.
- Animation mode may restrict colours/brushes/layers (approved) as long as normal drawing/colouring rooms are unaffected.
- Private rooms require a registered account (shipped): invited-only rooms are now gated at the join, env-gated on PB_URL so self-hosted/no-account installs still work anonymously.
- Plan queued as CARD-020 (fps presets) -> CARD-021 (scene auto-chaining) -> CARD-022 (restricted cartoon studio) -> CARD-023 (FLIPBOOK rollover) -> CARD-024 (export end-card).
- Still unanswered: where exactly the "6 frames" was seen (the caps are 8 public / 60 private; the only 6s are layer caps).
