#!/usr/bin/env bash
# Deploy an app update to the production droplet, from this machine.
#
# Mirrors RUNNING.md's local procedure over SSH: pre-flight, rollback image
# tag, dated app_data backup, build, bounded swap, health verification, and
# proof the pocketbase/tunnel neighbours were NOT restarted.
#
# Usage:
#   DEPLOY_HOST=root@<ip> scripts/deploy-remote.sh
#   scripts/deploy-remote.sh              # reads host from .deploy.json
#
# Requires: ssh access to the droplet, jq (optional, for .deploy.json),
# the repo with a committed-or-workingtree build context, and curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="${REMOTE_DIR:-/opt/drawesome}"
APP_CONTAINER="happypaint-app-1"
STAMP="$(date +%Y%m%d-%H%M)"

# --- resolve target host -------------------------------------------------
if [[ -n "${DEPLOY_HOST:-}" ]]; then
  HOST="$DEPLOY_HOST"
elif command -v jq >/dev/null 2>&1 && [[ -f "$ROOT/.deploy.json" ]]; then
  HOST="$(jq -r .host "$ROOT/.deploy.json")"
elif [[ -f "$ROOT/.deploy.json" ]]; then
  # no jq: pull the "host" value with grep/sed
  HOST="$(grep -o '"host"[[:space:]]*:[[:space:]]*"[^"]*"' "$ROOT/.deploy.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
else
  echo "ERROR: set DEPLOY_HOST=root@<ip> or create .deploy.json ({\"host\": ...})" >&2
  exit 1
fi
echo "==> Deploying to $HOST:$REMOTE_DIR (stamp $STAMP)"

SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"

# --- 1. pre-flight -------------------------------------------------------
echo "==> Pre-flight: current state"
$SSH "$HOST" "cd $REMOTE_DIR && docker compose ps" || {
  echo "ERROR: cannot reach $REMOTE_DIR on $HOST — is the droplet up?" >&2; exit 1; }

echo "==> Capturing rollback image + neighbour container IDs"
$SSH "$HOST" "cd $REMOTE_DIR && \\
  prev=\\\$(docker inspect $APP_CONTAINER --format '{{.Image}}') && \\
  docker image tag \\\$prev happypaint-app:rollback-$STAMP && \\
  docker inspect -f '{{.Name}} {{.Id}} started={{.State.StartedAt}}' happypaint-pocketbase-1 happypaint-cloudflared-1 \\
  > /tmp/deploy-neighbours-$STAMP.txt && cat /tmp/deploy-neighbours-$STAMP.txt"

echo "==> Backing up app_data (dated tar on the droplet)"
$SSH "$HOST" "cd $REMOTE_DIR && mkdir -p backups && \\
  tar -cf backups/pre-deploy-$STAMP.tar app_data && ls -la backups/pre-deploy-$STAMP.tar"

# --- 2. ship the code ----------------------------------------------------
echo "==> Syncing code (excluding data dirs, node_modules, dist, .git)"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude app_data --exclude pb_data --exclude coloring-library \
  --exclude backups --exclude .deploy.json \
  "$ROOT/" "$HOST:$REMOTE_DIR/"
# .env rides along in the sync (it is NOT excluded) so env changes ship with
# the code in the same swap — the local-docker-production-release rule.

# --- 3. build + swap -----------------------------------------------------
echo "==> Building the app image on the droplet"
$SSH "$HOST" "cd $REMOTE_DIR && docker compose build app"

echo "==> Swapping the app container (bounded, --no-deps)"
$SSH "$HOST" "cd $REMOTE_DIR && \\
  docker compose up -d --no-deps --no-build --wait --wait-timeout 60 app; \\
  echo SWAP_EXIT:\\\$?"

# --- 4. verify -----------------------------------------------------------
echo "==> Verifying health (droplet-local + public)"
$SSH "$HOST" "curl -fsS http://127.0.0.1:8787/healthz && echo && \\
  docker inspect $APP_CONTAINER --format '{{.State.Health.Status}}'"

echo "==> Public healthcheck"
curl -fsS https://drawesome.art/healthz && echo

echo "==> Neighbour proof (must be identical StartedAt to pre-flight)"
$SSH "$HOST" "docker inspect -f '{{.Name}} {{.Id}} started={{.State.StartedAt}}' happypaint-pocketbase-1 happypaint-cloudflared-1; \\
  echo '--- pre-flight was:'; cat /tmp/deploy-neighbours-$STAMP.txt"

echo "==> DONE. Rollback if needed:"
echo "    ssh $HOST 'cd $REMOTE_DIR && docker image tag happypaint-app:rollback-$STAMP happypaint-app:latest && docker compose up -d --no-deps --no-build --wait app'"
