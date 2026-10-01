# Drawesome Painted Planet release

Released from hp-dev-one, UTC 2026-09-29 (local CDT Sep 28 evening).

## Source and artifact
- Feature commit: 5684cb6 (+ ab3f704 release note), fast-forward merged to main and pushed; `git ls-remote origin main` matches. Canonical repo: git@github.com:craigcampbell/happypaint.git.
- Production source: /home/craig/Projects/happypaint — synced paths: server.js, src/App.jsx, src/Router.jsx, src/components/SiteNav.jsx, src/components/PlanetPage.jsx (new), src/components/planet.css (new), src/data/world-paths.json (new), public/flags-lineart/*.png (257, new), scripts/planet-verify.mjs (new), scripts/seasonal-marketing-verify.mjs; removed src/components/PaintJarPage.jsx. Pre-sync drift check: every touched prod path matched main byte-for-byte.
- New running image: sha256:acb7d861eda1d2c320b6569355143cd58ee7699297ff84fd19593ae0a87ca967
- Previous image / rollback tag: happypaint-app:pre-planet-20260929T031051Z -> sha256:3314ce12c1af8964c43f2368aec96febe2507abd6c6afdf0fb69ea42882beba5 (earlier rollback tags untouched)
- Container server.js SHA-256: 84258608e0abf440c67ecd14b426dadd56569d3bc08bde826ca4ecddbbaade63 (matches prod + release tree)
- Public entry: /assets/index-kbKFyW2j.js (was index-CC9LMOrj.js); page chunk PlanetPage-W0twY9QT.js
- Data backup: backups/pre-deploy-planet-20260929T031051Z.tar, SHA-256 046608474840fc29c2c83f881376e1a24cd67340c210de2092072fb747ee3e14 (app_data; code-only release, no schema change)

## Shipped
- /planet (and /paintjar alias; nav label "Planet"): paint-by-country world map (Natural Earth 110m via world-atlas), tinted by recorded session count, hover/tap card with numbers + live headcount, click -> /join/FLAGxx.
- Flag rooms FLAG+ISO2: public kid_safe, derived title/prompt/sheet (flag:XX, pinned; set_sheet and sheet-swap wipe requests refused), exempt from idle sweep, on the 3-day refresh (refresh re-pins the flag), listed in the lobby once visited, /join/FLAGxx OG card.
- GET /api/planet: paintjar aggregates + flag set + per-flag-room live counts (headcounts only).
- Growing nature scene with 15 illustrative stroke milestones; copy labels everything illustrative, not measured savings.
- 257 flag line-art sheets generated from flag-icons (MIT) by render -> palette quantise -> edge trace.

## Verification
- Release tree (Playwright 1.61 container): planet-verify 28/28, seasonal-marketing-verify 44/44, modwatch 28/28, eslint 0 warnings, vite build green. daily-verify fails identically on the stashed baseline (hardcoded /usr/bin/node) — pre-existing.
- Image inspection before swap: PlanetPage chunk, 257 flag PNGs, src/data/world-paths.json present; server.js hash matches.
- Swap: docker compose -p happypaint up -d --no-deps --no-build --wait app -> Recreated, Healthy; running image == acb7d861….
- Blast radius: pocketbase (62bf14b3…, started 2026-09-25T23:54:33Z) and cloudflared (80fcb2da…, started 2026-09-25T23:55:29Z) unchanged.
- Live: /healthz 200; /planet + /paintjar serve the Painted Planet title; /join/FLAGBR unfurls "Color the Brazil flag together"; entry asset 200 text/javascript and equals the one in the image; /flags-lineart/MX.png 200 image/png; /api/planet 47,395 strokes / 44 groups / 257 flags; /api/paintjar unchanged contract; no flag rooms listed before any visit. Browser: 174 country paths, all clickable, scene 8/15, nav link present. No writes to any shared room.

## Rollback
```
docker image tag happypaint-app:pre-planet-20260929T031051Z happypaint-app:latest
cd /home/craig/Projects/happypaint && docker compose -p happypaint up -d --no-deps --no-build --wait app
```
Do NOT restore the app_data tar as part of a code rollback.
