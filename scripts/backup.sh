#!/usr/bin/env sh
# One-command backup of all persistent data: PocketBase (accounts + galleries +
# uploaded files) and the app's room murals / saved art / coloring sheets.
#
# Usage:  sh scripts/backup.sh [DEST_DIR]
# Writes a timestamped tarball to ./backups (or DEST_DIR).
#
# For a fully transactional snapshot, stop the stack first (docker compose down),
# back up, then start again — or use PocketBase's built-in scheduled Backups
# (Dashboard -> Settings -> Backups) which can also push to S3.
set -e
cd "$(dirname "$0")/.."
DEST="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
TARGETS=""
[ -d pb_data ] && TARGETS="$TARGETS pb_data"
[ -d app_data ] && TARGETS="$TARGETS app_data"
if [ -z "$TARGETS" ]; then
  echo "Nothing to back up (no pb_data/app_data found). Run from the repo root after the stack has started."
  exit 1
fi
OUT="$DEST/drawesome-backup-$STAMP.tgz"
tar -czf "$OUT" $TARGETS
echo "Backup written: $OUT"
