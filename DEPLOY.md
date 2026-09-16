# Deploying Drawesome — DigitalOcean Droplet via the DO MCP

Production runs the full compose stack (app + pocketbase + cloudflared) on a
DigitalOcean Droplet. Infrastructure actions — creating the droplet, firewall,
SSH keys, snapshots, monitoring — are driven from this machine through
Hermes's DigitalOcean MCP server. App releases are still the two-step
build-then-swap procedure from RUNNING.md, executed over SSH.

The old App Platform static-site spec (`.do/app.yaml`) and the plain-nginx SPA
config (`deploy/` nginx.conf) were removed: they predate the realtime server
and would deploy a site with no `/ws`, no rooms, and no persistence.

## Monthly cost (verified Sep 2026)

| Item | Cost |
|---|---|
| Basic Droplet 1 vCPU / 2 GB / 50 GB / 2 TB transfer (`s-1vcpu-2gb`) | $12.00 |
| Daily droplet backups (30% of droplet) | $3.60 |
| Reserved IP, firewall, IPv4 | $0 |
| Cloudflare tunnel (existing, unchanged) | $0 |
| **Total** | **~$15.60/mo** |

A 1 GB / 25 GB droplet ($6 + $1.20 weekly backups ≈ $7.20/mo) also runs the
stack — measured idle: app 72 MB RSS, pocketbase 8 MB, cloudflared 32 MB —
but 2 GB leaves room for image layers, backups, and busy public-room nights.

## One-time setup

### 1. DO API token (owner, once)

Create a read/write token at https://cloud.digitalocean.com/account/api/tokens
(e.g. `hermes-mcp`) and give it to Hermes as an env secret — never commit it.
The MCP server reads `DIGITALOCEAN_API_TOKEN` from its process environment.

### 2. Connect the DigitalOcean MCP server

Stdio server, services scoped to just what we use (smaller tool surface,
less agent context, fewer things to fat-finger):

```bash
hermes mcp add digitalocean \
  --command npx --args -y @digitalocean/mcp --services droplets,networking,ssh,insights,docs \
  --env DIGITALOCEAN_API_TOKEN=<token>
```

Tools arrive prefixed `mcp_digitalocean_*` (`droplet-list`, `droplet-create`,
`size-list`, `image-list`, firewall/SSH-key tools under networking/ssh,
`docs-search`). Restart the session after adding; verify with
`hermes mcp test digitalocean`.

### 3. Create the droplet (via MCP)

Ask the agent to run, roughly:

- `image-list` (Type=distribution) → `ubuntu-24-04-x64`, or `1-click-list` →
  Docker marketplace image (bakes in Docker + compose, skips step 4's apt)
- `size-list` → confirm `s-1vcpu-2gb` in region
- list/upload this machine's SSH public key (`~/.ssh/id_ed25519.pub`;
  generate one first if there isn't one)
- `droplet-create`: Name=`drawesome`, Size=`s-1vcpu-2gb`, Region=`nyc3`,
  Backup=true, Monitoring=true, Tags=[`drawesome`,`prod`]
- firewall: inbound 22 (from home IP only) + 80 + 443, outbound all, applied
  to tag `drawesome`

Record the droplet ID + IP in `.deploy.json` (below).

### 4. Bootstrap the droplet (SSH, once)

Unless you used the Docker marketplace image:

```bash
ssh root@<droplet-ip>
apt-get update && apt-get install -y docker.io docker-compose-v2 rsync
```

(The DO MCP surface has no droplet-shell/exec tool — MCP covers
create/resize/snapshot/firewall; bootstrap and deploys stay SSH.)

### 5. Seed the droplet (SSH, once)

Order matters: stop the LOCAL stack FIRST (two live tunnel connectors on one
tunnel is the one hard rule), then rsync, then start remote.

```bash
docker compose --profile tunnel down          # local, stops room writes for a clean copy
rsync -a --exclude node_modules --exclude dist --exclude .git \
  ./ root@<ip>:/opt/drawesome/                # code + .env + data dirs, ~1.3 GB
rsync -a coloring-library/ root@<ip>:/opt/drawesome/coloring-library/
ssh root@<ip> 'cd /opt/drawesome && docker compose --profile tunnel up -d --build'
```

The tunnel token reconnects the same Cloudflare tunnel — `drawesome.art` and
`pb.drawesome.art` keep working with zero DNS changes. Google sign-in keeps
working (config lives in `pb_data` + the Google account).

### 6. Verify

```bash
curl https://drawesome.art/healthz
ssh root@<ip> 'cd /opt/drawesome && docker compose ps'   # 3 services, app healthy
```

Then the full RUNNING.md "Verify the release" checklist (anonymous draw in a
fresh private room, second-client replay, coloring sheets, Google sign-in).
Keep this PC's stopped stack as the cold standby — rollback of last resort is
starting it again.

## Routine deploys from this machine

`scripts/deploy-remote.sh` wraps RUNNING.md's procedure over SSH: pre-flight,
rollback image tag, dated `app_data` backup, build, bounded swap, public +
local `/healthz`, container health, and neighbour-container proof. Usage:

```bash
DEPLOY_HOST=root@<droplet-ip> scripts/deploy-remote.sh
# or, once .deploy.json exists:
scripts/deploy-remote.sh
```

(Or just ask the agent: "deploy to the droplet" — it runs the script.)

## `.deploy.json`

Git-ignored, repo root, records the target so nothing re-types the IP:

```json
{ "host": "root@203.0.113.10", "droplet_id": 123456789, "region": "nyc3" }
```

No secrets in it (DO token lives in the Hermes MCP env; tunnel token in `.env`).
Add `.deploy.json` to `.gitignore` when you create it.

## Disaster paths

- **Bad app release**: `ssh root@<ip> 'cd /opt/drawesome && docker image tag happypaint-app:rollback-<date> happypaint-app:latest && docker compose up -d --no-deps --no-build --wait app'`
- **Droplet lost**: droplet backups (enabled at create) or periodic MCP
  `snapshot-droplet`; restore = `droplet-create` from the snapshot image,
  re-seed `.env`, `docker compose up`.
- **Everything**: this machine's local stack is the cold standby.

## Notes

- Cloudflare tunnel/DNS and Google OAuth are account-side; unchanged by the move.
- `hermes mcp remove digitalocean` disconnects automation without touching the droplet.
- Cost watch: DO console → Billing, or add the `accounts` service to the MCP
  config for balance/invoice tools.
