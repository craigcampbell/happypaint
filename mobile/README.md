# Happy Paint Mobile

Expo React Native Happy Paint app for iPhone, iPad, and Android.

## Run

```sh
npm install
npm run ios
npm run android
```

## Scripts

- `npm run start` starts Expo.
- `npm run ios` starts Expo and opens iOS Simulator.
- `npm run android` starts Expo and opens Android.
- `npm run typecheck` runs TypeScript.

## Features

- Skia-rendered drawing surface with marker, pencil, paint, spray, eraser, and Studio-gated glow brushes.
- Brush size, opacity, and natural variation controls.
- Linen, canvas, smooth, and Studio-gated night paper options.
- Offline-first local gallery backed by AsyncStorage and Expo FileSystem previews.
- Import an image reference from photos or documents.
- Export PNGs, share artwork, or save to the device photo library.
- Kid-friendly tool labels, large controls, undo, clear, and autosave.
- Paint Together room codes, planned sessions, and native share-sheet invites.
- Discover screen for topic/tag search, room previews, timed events, and gallery voting.
- Host-configured artist seats and viewer seats for planned rooms.
- Public browse is preview-only; drawing access should require invite or host approval once live sync is connected.
- Deep-link join route through `happypaint://join/CODE`.
- Drops wallet placeholders for future tips, brush packs, texture packs, palettes, room themes, and export upgrades.

## Notes

- `npm run typecheck` verifies the TypeScript app.
- `npx expo export --platform ios --output-dir dist-test` can be used as a bundle smoke test.
- The app is offline-first after install; normal drawing and gallery flows do not require a network connection.
