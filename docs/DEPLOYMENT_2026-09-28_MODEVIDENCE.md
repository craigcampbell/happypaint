# Drawesome history catch-up and moderation-evidence release

Released from this machine, UTC 2026-09-28 (local CDT September 28).

## Source and artifact
- Feature commit: c9faf31aa594ccf4f10c155209eb0b002050f83a (pushed; `git ls-remote origin main` matches).
- Canonical repo: git@github.com:craigcampbell/happypaint.git, main.
- Release tree: /home/craig/Projects/happypaint-release (16 files, 2748 insertions / 35 deletions; staged set byte-compared against the verified /home/craig/Projects/happypaint-catchup tree; LiveAdmin.jsx normalized CRLF→LF to match repo style).
- Production source: /home/craig/Projects/happypaint, only the 16 committed feature paths synced; compose config untouched (local prod compose intentionally differs from canonical); pre-sync drift check: prod source matched HEAD~1 for every changed path (LiveAdmin.jsx differed only by CRLF).
- New running image: sha256:3314ce12c1af8964c43f2368aec96febe2507abd6c6afdf0fb69ea42882beba5
- Previous image / rollback tag: happypaint-app:pre-modevidence-20260928T030852 → sha256:7f52e5edba6408d894fc9fa929d0a097af3505dc3015aa7e5fbac5bef25a867b (existing pre-seasonal tag untouched)
- Container server.js SHA-256: c9250bb479e391f6143077901f30842078ead2c2903760b7f4456e519a0e4b19 (matches release tree)
- Container server/historyFrame.js SHA-256: e48ba98f4cd687075a4bde47b6fa586aeee5e07640aa5a88db651f2d2303ffdb
- Public entry: /assets/index-CC9LMOrj.js (was index-D95ZH9MA.js); evidence UI in lazy chunk LiveAdmin-D2YX3c95.js
- Data backup: /home/craig/Projects/happypaint/backups/pre-deploy-modevidence-20260928T030852.tar, SHA-256 21bedd74ad8f21628d1cc64216dfbcaa67ea7853db757376f41626198f6d469a (app_data, code-only release, no schema change, no migration)

## Shipped
- Async history catch-up: cold gzip joiners receive ONE prebuilt/lazily-built binary frame plus an op tail instead of thousands of text messages. Join stalls and event-loop spikes during big cold joins are removed; no claim of a faster complete canvas load, the same ops still arrive and render.
- Moderation evidence: an elected watcher may bind the exact classifier frame (validated small PNG/JPEG, magic-byte sniff, dimension match, quota-bounded per room and globally) to an auto-report; admin-only re-sniffed retrieval at /api/admin/evidence/:reportId; LiveAdmin renders it as client-supplied corroboration, NOT proof.
- Independent-review hardening (SEC-1/LOG-1/LOG-2): guest watcher identity is HMAC(ip) keyed by a persisted 0600 server secret (/data/.evidence-key, minted on first boot); empty/inverted clamped flag ranges rejected and corroboration overlap uses the clamped range; .reports.json persists atomically (tmp+rename) and startup reconciles orphaned/.tmp evidence files.

## Verification
- Suites on the release tree: modevidence 49/49, modevidence-hardening 21/21, modevidence-controller 21/21, modevidence-ui 11/11, modwatch 28/28, eslint 0 warnings, vite build green. history-catchup: 26/26 correctness assertions + loop-lag gates green on every run (max loopLag 23.8–43.5ms); the /healthz RTT <100ms perf gate measured ~720ms during the 12k-op cold rebuild on this host across four runs in two trees (parent observed the same 728ms) and is treated as load-sensitive, not a regression, correctness is unaffected.
- Image inspection before swap: server.js hash matches release tree; historyFrame.js, toOpIdEff, createHmac, LiveAdmin evidence chunk and worker bundles all present in the built image.
- Swap: `docker compose -p happypaint up -d --no-deps --no-build --wait app` → Recreated, Healthy; running container image == sha256:3314ce12….
- Blast radius: pocketbase (62bf14b3…, started 2026-09-25T23:54:33Z) and cloudflared (80fcb2da…, started 2026-09-25T23:55:29Z) IDs and start times identical before and after; never restarted.
- Live: local + public /healthz 200; public entry asset index-CC9LMOrj.js serves 200 text/javascript; /api/admin/evidence/* refuses unauthenticated (401) and wrong-key (401); /ads.txt 404 unchanged (ads configured off).
- Read-only public probe (no frames sent, canPaint:false spectator): DAILY, MAIN, CASTLE joined and served history; DOODLE served the new binary gz history frame, inflated to a valid {type:'history', ops:1500} message. No public mutation of any kind; no painting.

## Rollback
```
docker image tag happypaint-app:pre-modevidence-20260928T030852 happypaint-app:latest
cd /home/craig/Projects/happypaint && docker compose -p happypaint up -d --no-deps --no-build --wait app
```
Do NOT restore the app_data tar as part of a code rollback; it would erase data written since 2026-09-28T03:08 CDT.
