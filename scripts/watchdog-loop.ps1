<#
  Runs watchdog.ps1 every 5 minutes, forever.

  Why a loop instead of a Scheduled Task: registering a task in the root
  folder needs admin, and this runs as Craig's normal (non-elevated) session.
  A Startup-folder shortcut launches this at logon, which covers the two cases
  that actually took the site down:
    - machine reboots  -> logon starts this loop, which brings the stack up
    - Docker crashes   -> the 5-minute tick notices and heals it

  Single-instance guarded by a named mutex, so a second logon (or a manual
  run) will not stack up duplicate loops.

  If you later want the sturdier Scheduled Task version (survives the loop
  process dying mid-session), run this ONCE from an ELEVATED PowerShell:

    $s = "C:\Users\Craig Campbell\Projects\happypaint\scripts\watchdog.ps1"
    $a = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$s`""
    $t1 = New-ScheduledTaskTrigger -AtLogOn
    $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName "Drawesome watchdog" -Action $a -Trigger $t1,$t2 -Force

  ...then delete the Startup shortcut so they do not both run.
#>

$ErrorActionPreference = 'Continue'
$IntervalSeconds = 300
$Watchdog = Join-Path $PSScriptRoot 'watchdog.ps1'

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\DrawesomeWatchdogLoop', [ref]$created)
if (-not $created) { exit 0 }  # another loop already owns it

try {
  while ($true) {
    try {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Watchdog | Out-Null
    } catch {
      # Never let a bad run kill the loop - the next tick tries again.
    }
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
