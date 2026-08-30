<#
  Drawesome uptime watchdog.

  This box IS production: drawesome.art is served by the local Docker stack via
  a Cloudflare tunnel. Compose already restarts containers (restart:
  unless-stopped), but that only helps while the Docker ENGINE is running. If
  Docker Desktop is closed, crashes, or the machine reboots, the site stays
  down until a human notices. On 2026-08-25 that cost ~4 days of downtime
  (drawesome.art served HTTP 530) before anyone spotted it.

  So: check health, heal what can be healed, and shout when it cannot.

  Ladder (cheapest first, each step re-checks before escalating):
    1. /healthz on 127.0.0.1 -> healthy? done.
    2. Docker engine responding? If not, start Docker Desktop and wait.
    3. Stale-socket crash loop (the known Windows failure: orphaned AF_UNIX
       reparse points under Docker\run that Windows refuses to delete) ->
       rename the directory, which works when delete does not, then retry.
    4. docker compose up -d to bring the stack back.
    5. Still down -> write ALERT-drawesome-down.txt to the Desktop.

  Everything is logged to app_data\watchdog.log (trimmed at 1MB).
  Run manually any time:
    powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1
#>

$ErrorActionPreference = 'Continue'
$Root      = Split-Path -Parent $PSScriptRoot
$LogFile   = Join-Path $Root 'app_data\watchdog.log'
# Heartbeat: rewritten on every run so "silent because healthy" is
# distinguishable from "silent because the watchdog itself died".
$StatusFile = Join-Path $Root 'app_data\watchdog-status.txt'
$AlertFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ALERT-drawesome-down.txt'
$LocalUrl  = 'http://127.0.0.1:8787/healthz'
$PublicUrl = 'https://drawesome.art/healthz'
$DockerExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

function Write-Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try {
    $dir = Split-Path -Parent $LogFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) {
      # Keep the newer half so the log can never grow without bound.
      $keep = Get-Content $LogFile -Tail 500
      Set-Content -Path $LogFile -Value $keep -Encoding utf8
    }
    Add-Content -Path $LogFile -Value $line -Encoding utf8
  } catch { }
  Write-Output $line
}

function Write-Status([string]$state) {
  try {
    $dir = Split-Path -Parent $StatusFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Set-Content -Path $StatusFile -Encoding utf8 -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $state)
  } catch { }
}

function Test-Health([string]$url, [int]$timeoutSec = 10) {
  try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec $timeoutSec -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Test-Engine {
  try {
    docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

# --- 1. Fast path: already healthy -----------------------------------------
if (Test-Health $LocalUrl) {
  if (Test-Path $AlertFile) { Remove-Item $AlertFile -Force -ErrorAction SilentlyContinue }
  # The app is up; a public failure now means the TUNNEL is the broken link.
  if (-not (Test-Health $PublicUrl 15)) {
    Write-Log 'WARN  app healthy locally but drawesome.art unreachable - restarting cloudflared'
    Push-Location $Root
    docker compose --profile tunnel up -d cloudflared 2>&1 | Out-Null
    docker restart happypaint-cloudflared-1 2>&1 | Out-Null
    Pop-Location
    Write-Status 'DEGRADED - app up, tunnel was restarted'
    exit 0
  }
  Write-Status 'OK - drawesome.art healthy'
  exit 0
}

Write-Log 'DOWN  /healthz not responding - starting recovery'

# --- 2. Engine down? Start Docker Desktop ----------------------------------
if (-not (Test-Engine)) {
  Write-Log 'INFO  docker engine not responding - launching Docker Desktop'
  if (Test-Path $DockerExe) {
    # More than one instance fighting over the pipe is itself a failure mode.
    $running = @(Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 1) {
      Write-Log ('INFO  {0} Docker Desktop instances running - stopping all first' -f $running.Count)
      $running | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
    }
    if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
      Start-Process $DockerExe | Out-Null
    }
  } else {
    Write-Log ('ERROR Docker Desktop not found at {0}' -f $DockerExe)
  }

  # Wait up to ~3 minutes for the engine.
  $ok = $false
  foreach ($i in 1..36) {
    Start-Sleep -Seconds 5
    if (Test-Engine) { $ok = $true; Write-Log ('INFO  engine up after ~{0}s' -f ($i * 5)); break }
  }

  # --- 3. Known Windows failure: stale sockets under Docker\run ------------
  if (-not $ok) {
    $runDir = Join-Path $env:LOCALAPPDATA 'Docker\run'
    if (Test-Path $runDir) {
      Write-Log 'WARN  engine still down - applying stale-socket fix (rename Docker\run)'
      Get-Process 'Docker Desktop', 'com.docker.backend' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
      wsl --shutdown 2>&1 | Out-Null
      # Windows refuses to DELETE the orphaned reparse points, but renaming the
      # parent directory succeeds - Docker recreates run\ on next start.
      $stamp = Get-Date -Format 'yyyyMMddHHmmss'
      try {
        Rename-Item -Path $runDir -NewName ('run.broken-{0}' -f $stamp) -ErrorAction Stop
        Write-Log 'INFO  renamed Docker\run'
      } catch {
        Write-Log ('ERROR could not rename Docker\run: {0}' -f $_.Exception.Message)
      }
      foreach ($lock in 'backend.lock', 'frontend.lock', 'launcher.lock', 'backend.error.json', 'installer.error.json') {
        Remove-Item (Join-Path $env:LOCALAPPDATA "Docker\$lock") -Force -ErrorAction SilentlyContinue
      }
      if (Test-Path $DockerExe) { Start-Process $DockerExe | Out-Null }
      foreach ($i in 1..36) {
        Start-Sleep -Seconds 5
        if (Test-Engine) { $ok = $true; Write-Log ('INFO  engine up after socket fix (~{0}s)' -f ($i * 5)); break }
      }
    }
  }

  if (-not $ok) {
    Write-Log 'ERROR docker engine would not start - manual help needed'
    Write-Status 'DOWN - docker engine will not start (needs a human)'
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Set-Content -Path $AlertFile -Encoding utf8 -Value @"
drawesome.art is DOWN and the watchdog could not fix it.

Checked: $stamp
The Docker engine would not start, so the site is serving HTTP 530.

Next steps:
  1. Open Docker Desktop and read the error it shows.
  2. See the Docker crash recovery notes in the project.
  3. Do NOT use "Reset to factory defaults" - that deletes app_data
     (all rooms/art) and pb_data (all accounts).

Watchdog log: $LogFile
"@
    exit 1
  }
}

# --- 4. Engine is up: make sure the stack is up ----------------------------
Push-Location $Root
# --no-recreate: a RECOVERY should be minimal - start what is stopped, create
# what is missing, but never tear down healthy containers (recreating
# PocketBase mid-incident would drop live sign-ins for no reason).
Write-Log 'INFO  bringing the stack up (compose up -d --no-recreate)'
docker compose --profile tunnel up -d --no-recreate 2>&1 | ForEach-Object { Write-Log ('      {0}' -f $_) }
Pop-Location

# --- 5. Verify -------------------------------------------------------------
$healthy = $false
foreach ($i in 1..12) {
  Start-Sleep -Seconds 5
  if (Test-Health $LocalUrl) { $healthy = $true; break }
}

if ($healthy) {
  Write-Log 'OK    site recovered'
  Write-Status 'RECOVERED - watchdog restarted the stack'
  if (Test-Path $AlertFile) { Remove-Item $AlertFile -Force -ErrorAction SilentlyContinue }
  if (-not (Test-Health $PublicUrl 15)) {
    Write-Log 'WARN  local OK but drawesome.art still unreachable - check the tunnel'
  }
  exit 0
}

Write-Log 'ERROR stack started but /healthz never came up'
Write-Status 'DOWN - engine up but app not answering /healthz'
$stamp2 = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Set-Content -Path $AlertFile -Encoding utf8 -Value @"
drawesome.art is DOWN and the watchdog could not fix it.

Checked: $stamp2
The Docker engine IS running, but the app never answered /healthz.

Try:
  docker compose ps
  docker compose logs --tail 100 app

Watchdog log: $LogFile
"@
exit 1
