# Happy Paint Social Backend

Happy Paint should stay useful without an account. Accounts unlock cross-device sync, friend invites, planned sessions, and live painting.

## Routes

- `/` marketing website with future App Store and Google Play links.
- `/#discover` public room/topic browse, timed events, and reviewed group gallery voting.
- `/studio` browser drawing app.
- `/join/:code` invite-link entry point for a room or planned session.
- `/admin` staff console for moderation, library approval, room review, discovery review, events, gallery votes, verification, and audit actions.

## Recommended Backend

Start with Supabase:

- Auth for email, phone, magic links, and Apple/Google sign-in.
- Postgres for profiles, sessions, invites, and stroke events.
- Row Level Security to prevent public people search.
- Realtime channels for live stroke events.
- Edge Functions for SMS/email invite sending, contact hashing, and guardian flows.

Reference schema: `backend/supabase/schema.sql`.

Future economy schema should add append-only wallet records for Drops and Kudos:

- `wallets`: current Drops, Kudos, locked creator balance, and payout eligibility.
- `wallet_ledger_entries`: every earn, purchase, spend, tip, reversal, refund, hold, and admin adjustment.
- `drop_products`: platform SKUs and Drop amounts.
- `purchase_receipts`: App Store, Google Play, and web receipt verification records.
- `asset_products`: priced packs and platform fee settings.
- `tips`: sender, receiver, source artwork/pack/event, amount, moderation status.
- `creator_payout_accounts` and `creator_payouts`: only after guardian/adult eligibility, tax, and fraud controls exist.

## Social Model

- No public people directory.
- Public discovery is for approved rooms, topics, tags, events, and gallery posts, not for finding individual kids.
- Users create a room code or invite link.
- Friends join by code, link, QR, or native share sheet.
- Email and phone are optional identifiers, stored as normalized hashes for lookup.
- Contact discovery is off by default and should require explicit opt-in.
- Under-13 users should use guardian-managed accounts before email, phone, contact matching, chat, or friend lists.

## Discovery, Roles, Events, and Gallery

Public browse should use sanitized data, not raw room subscriptions.

- `room_discovery_snapshots` is the public browse source for titles, topics, tags, approved preview images, role counts, and featured scores.
- Public discovery excludes `adult_18` rooms, live child presence, participant names, chat, invite codes that can join, unreviewed uploads, and raw strokes.
- Search indexes topics and tags. It should not index emails, phone numbers, real names, contact lists, or child profile identifiers.
- Preview actions can open approved snapshots or spectator-safe playback. Joining still requires a code, accepted invite, non-expired link, or host approval.
- Kid-safe discovery should only use curated templates, prompt packs, stickers, and reviewed gallery snapshots.

Room roles:

- `host`: owns room settings, seats, locks, and role promotion.
- `artist`: can draw and add allowed media.
- `viewer`: can preview, watch, vote, and react, but cannot draw or upload media.
- `teacher` and `guardian` can be used for supervised rooms.

The backend should default self-joins to `viewer` or `guest`. Host/admin actions or a trusted server function should promote a participant to `artist`, set `role_approved_at`, and write a `moderation_actions` or `room_event_log` row. Stroke and media insert policies should only allow `host`, `artist`, and `teacher`.

Timed events:

- Lifecycle: `draft` -> `upcoming` -> `live` -> `voting` -> `ended`.
- Events can collect rooms while live and gallery posts while voting.
- Adult events should stay draft/cancelled until there is a separate adult-only surface.
- Events need start/end/voting windows so stale contests do not stay on the front page forever.

Gallery voting:

- Gallery posts should be pending until reviewed or automatically checked.
- Public posts require approved safety status and non-adult source rooms/events.
- Votes should be one per profile, optionally one per device hash for anonymous/device friction if that model is used.
- Store suspicious bursts in `gallery_vote_audit_events`; review mobile-carrier spikes carefully before network blocks.
- Admins need actions for featuring/unfeaturing posts, resetting suspicious votes, and suppressing unsafe gallery posts.

## Room Audience Gates

Rooms should use server-enforced audience modes, not a client-only label.

- `kid_safe`: visible to child and guardian-managed profiles. Media must come from the approved Happy Paint library.
- `friends`: invite-only rooms for known friends. User uploads, GIFs, and links can be allowed after moderation checks are connected.
- `adult_18`: hidden from child profiles and blocked unless the host and participant profiles are verified adults.

Kid-safe rooms should never load arbitrary HTML, unknown iframes, unmoderated GIF search, public links, or user uploads. They can still feel current by using curated meme-like templates: caption cards, safe reaction stickers, drawing prompts, album-cover frames, and challenge packs.

For 18+ rooms, keep the surface separate:

- No public discovery.
- No child account access.
- No invitations from adults to child accounts.
- Require adult verification before sharing or joining.
- Keep reporting, blocking, moderation logs, and room takedown flows before launch.

The reference schema includes `paint_sessions.audience`, `media_library_items`, and `session_media_assets` so the backend can enforce these gates.

## Admin Console

The admin app should be staff-only and server-authorized. Do not rely on a hidden route as the security boundary.

Initial admin jobs:

- Review and resolve user reports.
- Approve, reject, or tag safe-library media.
- Lock rooms, block media, and remove participants.
- Review listed room topics, tags, preview snapshots, role-seat settings, and discovery suppression.
- Schedule timed events, lock events, and close voting windows.
- Audit gallery submissions, featured posts, vote spikes, and contest resets.
- Review adult verification, guardian consent, and classroom approval.
- Inspect invite abuse, contact-discovery abuse, and blocked join attempts.
- Maintain an immutable moderation action log.

Recommended staff roles:

- `owner`: manage staff access and all safety settings.
- `trust_safety`: review reports, lock rooms, block media, escalate incidents.
- `library_curator`: approve kid-safe prompts, stickers, GIFs, and templates.
- `support`: view support cases and account state without broad moderation powers.
- `moderator`: day-to-day room/report triage.

Every admin write should create a `moderation_actions` row with actor, action type, target, report link when relevant, note, and timestamp. Adult-room access, kid-room media approvals, and account verification decisions should be auditable before launch.

## Admin Monitoring and Logging

Admins need an observe mode for live rooms, especially kid-safe rooms and reported rooms. The observer should not appear in participant presence, because a bad actor may stop before staff can confirm what is happening. That observe mode still must be disclosed in privacy/safety policies and must be fully auditable.

Server behavior:

- Admin observers subscribe to room presence, strokes, media, and event logs through staff-only authorization.
- Admin observers do not insert into `session_participants` and are not broadcast in user-facing presence.
- Starting observation creates a `room_observation_sessions` row and a `room_event_log` event.
- Ending observation writes `ended_at` and creates an `admin_observe_end` event.
- Exporting logs creates a `moderation_actions` row with `export_room_log`.
- Locking a room, blocking media, and removing a participant all create `moderation_actions` rows.

Logging layers:

- `stroke_events`: durable drawing actions for replay and dispute review.
- `session_media_assets`: uploaded, linked, GIF, embed, and library media attached to a room.
- `room_event_log`: room timeline: joins, blocked joins, media adds/removals, staff observe start/end, reports, locks, exports.
- `moderation_reports`: user/system reports waiting for staff review.
- `moderation_actions`: immutable staff action history.
- `room_observation_sessions`: who observed, when, why, and whether the session ended.

Retention should be policy-driven. Kid-safe moderation logs should last long enough to investigate abuse, appeals, and safety incidents, but avoid keeping raw creative data forever by default.

## Bans, IP Blocks, and DDoS

Use different controls for different problems:

- Profile bans: stop a known account from rooms, uploads, social features, adult rooms, or all access.
- Device/session friction: slow repeat abuse without over-blocking a family, school, or mobile carrier.
- Network blocks: short-lived `deny`, `challenge`, or `rate_limit` rules for abusive IPs or CIDR ranges.
- WAF/CDN protection: volumetric DDoS mitigation before requests reach the app, Supabase, or storage.

IP bans should be a safety tool, not the main identity system. Schools, libraries, homes, VPNs, and mobile carriers can put many legitimate users behind the same IP. Prefer short expirations, challenge/rate-limit first, and permanent account-level enforcement for confirmed behavior.

Recommended launch setup:

- Put the marketing site and web app behind Cloudflare or Vercel WAF.
- Add rate limits for `/join/:code`, room creation, media upload, auth attempts, and invite sending.
- Store app-level bans in `profile_bans`.
- Store edge rules and CIDR blocks in `network_blocks` with provider rule IDs.
- Store aggregated request spikes in `network_abuse_events`, using IP hashes for routine logs when a raw CIDR is not needed for enforcement.
- Write every ban/block/unblock/challenge/rate-limit decision to `moderation_actions`.

The database can stop banned profiles after a request reaches Supabase. It cannot absorb a DDoS by itself. DDoS traffic needs edge filtering, caching, and rate limiting upstream.

## Realtime Protocol

Clients should sync drawing as stroke events, not image streams.

```json
{
  "type": "stroke.commit",
  "sessionId": "uuid",
  "clientEventId": "device-uuid-0001",
  "brush": "marker",
  "color": "#111827",
  "opacity": 0.86,
  "size": 24,
  "payload": {
    "points": [{ "x": 120, "y": 84, "pressure": 0.72 }]
  }
}
```

Session clients subscribe to:

- `presence`: who is in the room.
- `stroke.commit`: durable finished strokes.
- `stroke.preview`: optional ephemeral live preview, not stored.
- `media.add`: approved library media or moderated user media, depending on room audience.
- `media.remove`: host or moderation removal.
- `session.state`: room open, planned, ended, or cancelled.
- `role.changed`: host/admin promotion or demotion between artist and viewer.
- `gallery.posted`: reviewed group artwork ready for gallery moderation.
- `gallery.vote`: a vote event or local optimistic state before backend confirmation.

Kid-safe `media.add` events should reference an approved `media_library_items.id`. Friend rooms can later carry moderated uploads, links, GIFs, and trusted embeds as object metadata. Adult rooms should not be delivered to child clients at all.

## Invite Mechanics

Use this order:

1. Room code for in-person or classroom use.
2. Share link through native share sheet for SMS, email, AirDrop, Discord, or chat.
3. QR code for same-room joining.
4. Friend request link.
5. Contact matching only for older or guardian-approved users.

## Monetization

Preferred launch model: Drops currency, not monthly subscriptions.

Drops are paid virtual currency. Kudos are earned reputation.

Good Drops sinks:

- Tips for gallery posts, community packs, event winners, and room hosts.
- Official brush, paper, palette, stamp, template, and room-theme packs.
- Community packs after moderation.
- Tiny loop and GIF export packs.
- Cloud storage blocks.
- High-res or transparent export tokens.
- Event host bundles.
- AI assist credits after AI safety controls exist.

Good earned Kudos:

- Event participation.
- Featured gallery posts.
- Safe community contributions.
- Helpful room hosting.
- Non-cash status and discovery recognition.

Creator earnings should phase in:

1. No cash payouts: tips accumulate as locked creator balance or Kudos.
2. Guardian-gated earnings: teen creators need guardian approval, identity checks, tax info, and payout terms.
3. Adult creator marketplace: verified adults can sell packs and cash out above a threshold.

Detailed economy spec: `docs/paint-economy.md`.

Avoid monetizing:

- Basic drawing.
- Safety features.
- Account deletion.
- Privacy controls.
- Ability to leave or block a room.
- Votes, rankings, or event wins.
- Access to minors or public people search.

## Store Review Notes

- Keep login optional until the user chooses sync or social features.
- Add in-app account deletion before release.
- Provide a test account for App Review once account-gated features are enabled.
- Keep child-directed analytics, ads, contacts, and identifiers conservative.
