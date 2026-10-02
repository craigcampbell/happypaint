# Artist rooms, implementation contract

Status: accepted implementation design, not a claim of delivery. Build after seasonal shared-file owners finish. Existing production remains untouched.

## Product
- Anonymous drawing in commons remains available. Accounts required for app download/share exports, with no Drops charges.
- Artist studio creation requires a verified account even if cloud auth is unconfigured (then return accounts_required; do not fake identities).
- Audience artist_public means publicly viewable, not publicly editable. Only verified owner and approved painter accounts draw. coHosts are existing moderators and retain host rights. Approved painters do not acquire moderator rights.
- Publishing to searchable gallery is an explicit action. Existing private rooms do not change audience/visibility on load. Creating an artist room does not implicitly list it.
- Unpublish removes discovery but the URL remains public; label this explicitly. Do not silently convert a public room back to private.
- Gallery search: title, short description, hashtags. Plain text only, bounded lengths/counts; profanity/moderation pipeline. No public account directory, profile IDs, email addresses, or location data.
- Optional Inktober participation applies ink/pencil constraints to that artist room too. Show warm-up before Oct, current prompt/date in October, no invented challenge date. Artist's mural is not auto-wiped on rollover.

## Data
Extend room load/create/persist together:
audience:'artist_public'; painters:[] verified opaque account IDs; gallery:{listed:false,description:'',tags:[],publishedAt:null,event:null,moderationHidden:false}.
Event identity when opted in: 'inktober-2026'; dates/prompts server-derived. Never accept client-supplied eventDay/eventPrompt as fact. Approved IDs survive restart; no guest or first-arrival ownership fallback for artist_public, including orphaned rooms.

## REST
POST /api/rooms accepts audience:'artist_public', title, description, tags, inktober:boolean. Verified owner assigned by server. Inktober eligibility is separate from gallery publication.
GET /api/rooms/gallery?q=&tag=&event=&offset=&limit= -> {rooms:[{code,title,description,tags,users,ops,event,canWatch:true}],total,topTags}. Limit <=60; sort deterministically. Only explicitly listed nonhidden artist rooms. Source root must include persisted rooms, not just rooms currently in memory. No per-user details.
POST /api/rooms/:code/publish with {description,tags,inktober?} and /unpublish: verified owner-only. Existing friends conversion requires explicit confirmed publish UI; do not convert implicitly through GET or join.
POST /api/admin/rooms/:code/unpublish and /restore: admin, explicit moderationHidden state distinct from owner-listed flag. Owner cannot override moderation hidden.
Public report uses current report flow with abuse-resistant distinct reporter counting, or at minimum existing moderator review; document implemented path accurately.

## WS
connected includes canPaint and roomProfile:{description,tags,event}; role_changed includes canPaint. All viewers still receive history; view-only can be client membership with no painting, while spectator previews remain invisible/count-free.
paint_request: authenticated viewer requests access; owner-only paint_requests list uses session target IDs, requests expire and are bounded/rate-limited.
paint_approve {targetId}: owner resolves live verified account and grants; paint_revoke {targetId} resolves similarly. Owner should also be able to revoke persisted approved accounts that are offline through owner-only ACL UI/API; expose opaque IDs ONLY to owner if needed. No name/email-based approval, no friend access by URL possession.
Broad defense: before mutation switch, artist room users without canPaint may only use explicit read/social/request message allowlist. Then existing host/layer/frame/lock guards still apply for painters. This prevents bypass through clear, wipe, sheet, imports, animation structures, votes or helper setters. Treat public chat as kid-safe. Paint-only approval does not grant clear-other-art, room management or moderation powers. Handle rejection/client state without optimistic divergent drawings.
Spectator admission allows artist_public viewable by code; gallery listing is discoverability, not authorization. Do not expose private rooms. Keep spectator inbound mutation denial and sanitized roster.

## Lifecycle
Account deletion unpublishes owned artist rooms and removes deleted account from painter/coHost lists including persisted/offline rooms; do not permit ownership takeover. Artist rooms protected from ordinary short idle sweeps to avoid deleting posted artwork; storage remains bounded by creation/publish quotas and documented retention, no unbounded uploads.
Moderation cache invalidation hides removed work immediately in previews/gallery. Signed-in export gating is not DRM and does not promise to prevent screenshots.

## Verification
Use isolated DATA_DIR scratch, mock PocketBase identities, ports outside prod 8787. Prove guest/stranger denied painting; approved friend accepted without host powers; revocation immediate and persists; forged identity/approval ignored; no ownerless takeover; ALL mutation bypasses denied; private room untouched; publishing/search/filter/unpublish moderation correctness; no PII in gallery; account deletion includes offline data; Inktober artist-room tool restrictions; browser guest view/request/owner approve/live unlock and revoke; account required export across entry points.
