# Happy Paint

Happy Paint is an offline-first drawing, painting, and coloring studio for web, iPhone, iPad, and Android.

The web app is a Vite/React marketing site plus browser studio. The native app lives in `mobile/` and uses Expo React Native with Skia for the drawing surface.

## Web

```sh
npm install
npm run dev
npm run build
npm run lint
```

The local web app runs at `http://127.0.0.1:5175/`.

## Mobile

```sh
cd mobile
npm install
npm run ios
npm run android
npm run typecheck
```

## Product Shape

- Marketing homepage at `/`.
- Discovery hub on the homepage for room topics, tags, timed events, and gallery voting.
- Browser studio at `/studio`.
- Invite links at `/join/:code`.
- Staff admin console at `/admin`.
- Pointer, touch, and stylus-friendly drawing on web.
- Skia-backed drawing on iOS, iPadOS, and Android.
- Marker, pencil, paint, spray, eraser, and Studio-gated glow brushes.
- Linen, canvas, smooth, and Studio-gated night paper.
- Local gallery, autosave, PNG export, and sharing.
- Paint Together room codes, share links, and scheduled session planning.
- Host-configured artist seats and viewer seats for planned rooms.
- Public room browse is preview-only; joining still requires a room code, invite, or host approval.
- Timed themed events keep the browse surface changing.
- Public group gallery posts can be voted on after review.
- Room audience gates for kid-safe, invite-only friend, and future verified 18+ rooms.
- Kid-safe rooms surface curated safe library prompts and media instead of arbitrary web embeds.
- Admin review queues for reports, safe-library approvals, room review, discovery listings, timed events, gallery votes, verification, and audit actions.
- Staff observe mode for live rooms with unseen participant presence and explicit audit logging.
- Profile bans, network block queues, and DDoS/rate-limit signal review in the admin console and backend schema.
- Service worker caching for the web app shell and bundled textures.
- Offline native storage through AsyncStorage and Expo FileSystem.
- Drops currency model for tips, packs, room themes, exports, storage, and future creator earnings.

## Performance Priorities

- The web drawing loop uses refs and canvas APIs directly during strokes so React renders do not sit in the hot path.
- The web canvas draws at a stable internal resolution and scales visually for phones, tablets, and desktops.
- Web undo/redo uses canvas snapshots instead of full `getImageData` CPU readbacks during stroke start.
- The mobile app stores strokes as vector data and renders them with memoized Skia nodes.
- Spray brushes are capped and batched into paths so shading does not create thousands of rendered components.
- No network assets or external fonts are required for the core experience.

## Social Backend

The app does not require accounts for solo drawing. Accounts are only needed for sync, friends, planned sessions, and live collaboration.

Reference backend files:

- `docs/paint-economy.md`
- `docs/product-research.md`
- `docs/social-backend.md`
- `backend/supabase/schema.sql`

Recommended first launch path:

- Host the web app at a domain like `happypaint.app`.
- Use `/` for marketing and store links.
- Use `/#discover` for public room/topic browsing, event discovery, and gallery voting.
- Use `/studio` for browser painting.
- Use `/join/:code` for invite links.
- Add Supabase auth/realtime when moving from local demo rooms to real multi-device rooms.
