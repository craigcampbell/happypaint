# Persona red-team + blue-team audit — July 2026

Full persona reports + evidence: `docs/safety-audit-2026-07.json`.

## Headline
Drawesome has a genuinely strong safety spine for its PUBLIC surface — kid_safe rooms get text moderation, elected NSFW watchers, host mute/kick, reversible op-hiding, and in-app reporting — and I confirmed several earlier fixes have already landed (non-hosts can no longer lock private rooms; muted users are now notified). But the audit exposes a consistent, dangerous pattern the personas hit independently: every safety control is scoped to `kid_safe` public rooms, and the PRIVATE 'friends' surface a child can be lured into has none of them — no text scan, no image scan, no watcher, and no required grown-up owner (server.js:918, 944, 437-443). Layered on top are two confirmed data-exposure defects specific to minors: an unauthenticated cross-room @mention 'watch' channel that leaks full message text out of any room by code (server.js:673-687, 570-577), and an account-deletion flow that wipes the device and PocketBase but never scrubs the durable server chatlog, so a deleted child's name+messages persist in plaintext forever (accountDeletion.js:125 vs server.js:933). The socket auth token still rides in the WS URL (task #40, still open). These are the things to fix before telling any parent their 10-year-old is safe unattended.

## A. Critical / things not thought about (child-safety first)

### 1. [CRITICAL] Private 'friends' rooms are a fully unmoderated surface a child can be lured into — no text scan, no image scan, no watcher
- **Why:** This is the single most-corroborated finding (3 personas independently). Every defense the app advertises is gated on room.audience==='kid_safe'. A predator who gets a child into a 6-char-code friends room has unrestricted chat AND an unscanned canvas with them, invisible to discovery and to moderators until a human report happens. The public rooms being safe creates false confidence about a surface that is wide open.
- **Evidence:** server.js:918 (chat scan only if audience==='kid_safe', comment 'Private rooms are unfiltered'); server.js:437-443 (electWatchers clears all watchers for non-kid_safe rooms — image scanning off); server.js:847,855 (drawn-text + smudge gates also kid_safe-only). Confirmed live in current code.
- **Fix:** Extend text scan (scan() at server.js:919) and NSFW watcher election to friends rooms that any non-owner joins, OR require every private room to have a signed-in grown-up owner before a second user can draw/chat. At minimum, run the SEVERE-tier text filter in ALL rooms (it already exists and is cheap) and show a prominent 'this room is not auto-moderated' banner on invite/join.

### 2. [CRITICAL] NSFW image watcher silently does not run when no client is 'watcher-capable' (all-mobile kid rooms) — no server-side fallback
- **Why:** Two personas hit this. The core user base is kids on phones/tablets, which self-report watcherCapable=false. A kid_safe room full of tablets elects ZERO watchers, so explicit imagery drawn on the canvas is broadcast with no scan and no auto-flag — it just appears. The room looks protected but isn't, which is worse than an obvious gap.
- **Evidence:** server.js:445-447 (candidates = users.filter(watcherCapable); if empty, chosen is empty, no watcher elected, drawing still broadcasts); nsfwWatcher.js isWatcherCapable() returns false for touch-first/iPad/<4 cores/<4GB. No server-side inference backstop anywhere.
- **Fix:** Add a guaranteed server-side backstop: periodically downsample the room canvas and run a lightweight NSFW check in Node (or an off-device inference endpoint) for any kid_safe room with zero elected watchers. Cheaper interim: if a kid_safe room has 0 capable watchers, throttle non-owner drawing and surface a visible 'a grown-up hasn't verified this room yet' state, and prioritize such rooms in the admin queue.

### 3. [CRITICAL] Unauthenticated cross-room 'watch' channel leaks full @mention message text (incl. from private rooms) and enables stranger contact
- **Why:** Three personas converged here. The notify socket requires NO auth: anyone sends {type:'watch', rooms:[codes], name} and is attached to any existing room by code; the mention payload includes the FULL message text plus roomTitle. Combined with guessable/known room codes and visible display names in userLists, a stranger can (a) read private-room conversations that @mention a target, and (b) repeatedly ping a named child from any room to pull them toward isolation. Direct child-contact + data-leak vector.
- **Evidence:** server.js:673-687 (watch handler: no token/membership check, attaches to any rooms.get(code)); server.js:561-580 notifyMentions sends {type:'mention', roomTitle, from, text: message} — full text; server.js:725 spectate/userList also exposes names with no auth.
- **Fix:** (1) Only deliver mention notifications to a watcher who is an actual member of that room, or holds a valid token whose profileId is in the room — reject watch subscriptions to rooms the socket can't otherwise access. (2) Strip message text from the notification payload — send 'You were mentioned in {room}', never the text. (3) Default cross-room @mention notifications OFF for guests/child accounts; require opt-in.

### 4. [CRITICAL] Account deletion never scrubs the durable server chatlog — a deleted minor's name + messages persist in plaintext forever
- **Why:** Two personas, and I confirmed the scrub is entirely unimplemented despite comments promising it. Deletion wipes the device and the PocketBase user (cascading gallery), but .chatlog/<ROOM>.jsonl lives on the Node filesystem, holds {name, message, profileId}, and nothing touches it on deletion. A child (or parent on their behalf) 'deletes' the account believing their data is gone; their real display name and conversation content — potentially school names, whereabouts — remain re-identifiable indefinitely. This is a COPPA/GDPR-erasure failure specific to minors.
- **Evidence:** server.js:144-145 + 933 (audit log stores name+message+profileId 'so a FUTURE account-deletion scrub can redact by id' — aspirational); accountDeletion.js:125 only calls pb.collection('users').delete(id); grep confirms NO chatlog/scrub/redact/purge code anywhere in server.js.
- **Fix:** Add a server-side deletion endpoint (authenticated by the user's token) that rewrites every .chatlog/*.jsonl, replacing lines matching the deleted profileId with '[deleted]' name and redacted message. Call it from fileServerDeletion() before/after the PocketBase delete. Add a time-based purge (e.g., chatlogs older than 90 days) as defense-in-depth. Stop storing display name in the audit log at all — profileId alone suffices for scrubbing.

### 5. [HIGH] No age gate or parental consent anywhere; any adult can create a signed-in account and host/contact kids
- **Why:** Three personas. There is no birthdate prompt, no 'under 13' handling, no verifiable parental consent, and no email verification. An adult creates an account with any email, hosts public rooms (which requires only sign-in, not age), then pivots to private rooms/@mentions. For a self-described kids' app this is both the top App Store rejection risk and the enabling condition for adult-to-minor contact.
- **Evidence:** SignupPage.jsx (email/password + OAuth with zero age check); server.js:1531 (kid_safe room creation requires identity but no age verification); AiAssistPanel 'profileKind' self/child is a label with no enforcement.
- **Fix:** Add a birthdate/age-attestation on first sign-in; for under-13 require a verifiable-parental-consent flow (parent email + click confirmation) before the account is active, and gate public-room OWNERSHIP/hosting to 13+ or verified adults. Publish the minimum-age + consent statement on the Safety/Privacy pages (App Store reviewers look for exactly this).

### 6. [HIGH] Private rooms auto-create on WebSocket connect with no required grown-up owner or moderation
- **Why:** Two personas. Joining any 6-char code lazily creates a 'friends' room with no owner, so there is no host to lock it, hide ops, mute, or kick — and (per finding #1) no auto-moderation. An adult can stand up an ownerless, unmoderated room and funnel kids into it with zero friction and no accountable party.
- **Evidence:** server.js:295 (private rooms default to 'friends' audience); getRoom() lazily creates on first WS connect with no ownership requirement; server.js:1518-1539 (only kid_safe creation requires auth). Confirmed audience!=='kid_safe' disables watchers + scan.
- **Fix:** Require the first signed-in user to become owner of any private room, and refuse drawing/chat by a second participant until an owner exists (or auto-close ownerless rooms after a short timeout). Combine with running at least the SEVERE text filter in all rooms.

### 7. [HIGH] Auth token transmitted in the WebSocket URL query string (PocketBase JWT) — leaks to proxy/CDN logs and browser history
- **Why:** FOUR personas flagged this and it is already tracked as open task #40. The token is a PocketBase JWT carrying the user's profileId and grants room ownership/host powers; in the URL it lands in Cloudflare/proxy access logs, browser history, and DevTools. A leaked token can be replayed to impersonate the child. Widely-confirmed, concrete, and already scoped.
- **Evidence:** server.js:751 (const token = url.searchParams.get('token')); src/hooks/useMultiplayer.js:16 (&token=${encodeURIComponent(token)} appended to WS URL). Task #40 'Harden WS auth transport (token not in URL)' still pending.
- **Fix:** Connect anonymously, then send {type:'auth', token} as the first WS message and validate there (the handler structure already supports first-message auth via the notify path). Move to short-lived tokens with refresh. This is a bounded, high-confidence fix — prioritize task #40.

### 8. [HIGH] Admin key is plaintext-on-disk, printed to stdout, single shared secret with no rotation or per-admin audit
- **Why:** Two personas. One leak of .admin-key (git commit, shared log, container image) grants permanent, irrevocable full admin: delete rooms, clear chat, read all reports and chatlogs (which contain minors' messages). No rotation, no expiry, no rate limit, no record of who did what.
- **Evidence:** server.js:1297-1305 (randomBytes(12).toString('hex'), persisted to .admin-key, printed on startup); admin endpoints have no rate limit; modLog is in-memory only.
- **Fix:** Read ADMIN_KEY from env only (never persist/print it); chmod 0600 if a file is unavoidable; add rate limiting on /api/admin/*; move to per-admin tokens with expiry and a persisted audit log of admin actions.

### 9. [HIGH] Reports have no SLA, receipt, or escalation path for urgent (grooming/CSAM) content
- **Why:** Two personas. A child who reports an adult's sexual message gets 'Report sent' but the report lands in an in-memory queue (only a periodic file persists) with no acknowledgement, no urgency triage, and no guaranteed human review — a single admin behind a static key is the whole pipeline. For the abuse scenarios above, response latency is the harm.
- **Evidence:** server.js:1386-1394 (POST /api/report stores to array + .reports.json, admin-key to resolve; no SLA/escalation); modLog in-memory (line 1361).
- **Fix:** Send a report receipt; add urgency triage (keyword flags like sexual/image/meet/address → URGENT tier); on an URGENT report naming a profileId, auto-shadow-mute that account's chat pending review; route URGENT reports to a secondary alerting channel and document an external escalation path (e.g., NCMEC CyberTipline).

### 10. [HIGH] Free-form display-name rename has no content filter or impersonation guard
- **Why:** Two personas. rename validates only type+length; no scan, no impersonation block. A signed-in user can set their name to 'Teacher Dave', 'admin', or copy another kid's auto-generated name, then leverage authority/identity to lure or instruct kids ('finish drawing with me in room COACH1'). Cheap and effective social-engineering surface.
- **Evidence:** server.js rename handler validates only string/length/slice(0,20), never calls scan(); chat by contrast calls scan() at line 919; names broadcast in userList and chat.
- **Fix:** Run scan() on new names; reject names containing authority terms (teacher/coach/parent/admin/mod/officer) and names matching/near-matching another current room participant (edit distance); visually badge guest vs signed-in names; broadcast a 'X renamed to Y' notice on rename.

## B. Would help users (impact / effort)

### 1. Live reactions / applause on strokes (emoji reactions near a peer's drawing) — high impact / quick effort
The teen persona's strongest point: friends can paint together but have no way to celebrate a peer's stroke except cluttering chat. Add a reaction picker (thumbs up / flame / heart) that broadcasts {type:'reaction', userId, emoji, position} and floats near the target stroke, expiring after a couple seconds. ~100 lines, no persistence needed, and it converts 'painting near friends' into 'painting WITH friends'. Highest impact-per-effort social feature in the whole audit.

### 2. One-tap share of a finished painting (image + copy-to-clipboard + rejoin link) — high impact / medium effort
Export today is a raw file download with no preview, no clipboard, no link back to the room. Add a 'Share' button that produces a static thumbnail (for iMessage/WhatsApp previews), a copy-to-clipboard image, and a 'come paint more' room-code link. This is how a 15-year-old shows off — the core motivation for the age group — and it drives organic re-invites. Reuses existing canvas export in App.jsx.

### 3. Opt-in Saved Friends roster with two-way add — high impact / medium effort
Kids currently can't reliably rejoin the same friends next week — recentRooms stores only codes, no people. When two signed-in users draw together, let each tap 'friend' to form a two-way link; show saved friends in the lobby with 'draw with me' and a notification when a saved friend opens a public room. This is the retention backbone. Gate to signed-in users and route through the consent model so it doesn't reopen the stranger-contact vector.

### 4. Client-side personal block/hide for kids ('hide this person's messages/cursor') — high impact / quick effort
A parent-persona finding that doubles as a genuinely fun/agency feature: today only hosts can mute. Let any kid locally hide a specific user's chat and cursor (stored in browser storage, no server change). Gives kids immediate agency over annoyance without waiting for a host or filing a report — and it's a safety win too.

### 5. Personal coloring-sheet library (save your own outlines, reuse across rooms) — medium impact / medium effort
Sheets are admin-uploaded and room-baked; kids can't save a favorite or carry an outline they drew into a new room. Let signed-in users save personal sheets (POST /api/sheets, per-account cap) and a '+ New sheet' button to draw an outline, save it, and reuse next week — high creative-reuse value, moderate effort on the existing sheet plumbing.

### 6. Lightweight collaborative games (exquisite corpse / quick Pictionary) on top of theme voting — medium impact / large effort
Theme voting already exists; extend it into structured low-stakes games (pass-the-drawing exquisite corpse, guess-the-word) that give friends a reason to return. Higher effort but strong for the teen social loop; sequence it AFTER reactions + share + friends, which deliver more per unit effort.

### 7. Optional Family Mode: guardian email digest + remote room controls — medium impact / large effort
Two personas want parental visibility. Let a child link a guardian email that receives a periodic activity digest (rooms joined, chats sent, art saved) and can toggle room access. This is table-stakes trust for kid-app store placement and pairs naturally with the age-gate/consent work in the critical list.

## C. Quick wins (<1 day each)
1. Run the existing SEVERE-tier text filter (scan() at server.js:919) in ALL rooms, not just kid_safe — a one-condition change that closes the worst of the unmoderated-private-room chat gap today.
2. Strip message text from @mention notifications (server.js:570-577): send 'You were mentioned in {room}' instead of the full `text`. One-line payload change that stops private-room content leaking to unauthenticated watchers.
3. Reject 'watch' subscriptions to rooms the socket isn't a member of (server.js:673-687) — add a membership/token check before r.notifiers.add(ws), closing the enumerate-and-eavesdrop path.
4. Stop printing ADMIN_KEY to stdout and read it from env only; chmod 0600 the .admin-key file (server.js:1297-1305). Minutes of work, removes a permanent-compromise vector.
5. Add scan() + an authority-term/near-duplicate blocklist to the rename handler so users can't set names like 'Teacher Dave' or copy a kid's name (server.js rename case). Reuses the existing filter.
6. Add a client-side 'hide this person' toggle (chat + cursor) stored in browser storage — pure frontend, gives kids immediate agency with zero server change.
7. Ship task #40 (token out of the WS URL): connect anonymously, send {type:'auth', token} as the first frame, validate there. Scoped, already-tracked, and closes a 4-persona finding.
8. Cap spectators per room and hide participant NAMES from spectators (show only a count) — server.js:715-725. Small change that removes the presence/name-harvesting surface on the homepage viewer.
9. Send a report receipt on POST /api/report and flag reports containing sexual/image/meet/address keywords as URGENT in the admin queue — no full pipeline needed, just triage + acknowledgement.
