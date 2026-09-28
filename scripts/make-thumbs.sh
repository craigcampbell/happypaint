#!/bin/bash
# Generate coloring-library thumbnails with ImageMagick.
#
# The app image installs sharp only as a devDependency, so scripts/regen-thumbs.mjs
# cannot run inside the runtime container; this is the host-side equivalent with
# the same intent: 256px box, shrink only, webp quality 78, alpha preserved.
#
# usage: make-thumbs.sh [SRC_FULL_DIR] [DST_THUMBS_DIR]
set -u

SRC=${1:-/home/craig/wmout/full}
DST=${2:-/home/craig/wmout/thumbs}
JOBS=${JOBS:-8}

mkdir -p "$DST"
cd "$SRC" || { echo "no such dir: $SRC" >&2; exit 1; }

total=$(ls -1 *.png 2>/dev/null | wc -l)
echo "thumbnailing $total sheets from $SRC -> $DST (jobs=$JOBS)"

ls -1 *.png | xargs -P "$JOBS" -I{} sh -c \
  'convert "$1" -resize "256x256>" -quality 78 "$2/${1%.png}.webp"' _ {} "$DST"

made=$(ls -1 "$DST"/*.webp 2>/dev/null | wc -l)
echo "thumbs present: $made / $total"
