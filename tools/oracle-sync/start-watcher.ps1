<#
  Starts the oracle-sync watcher (every local save is uploaded to the Foundry server).

    start-watcher.ps1            run it here and WAIT (what the login task uses — the task owns its lifetime)
    start-watcher.ps1 -Detach    start it hidden and return immediately

  Safe to run twice: the watcher keeps a heartbeat lock and a second copy exits at once.
  Output goes to tools/oracle-sync/oracle-sync.log (errors: oracle-sync.err.log) — both gitignored.
#>
param([switch]$Detach)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$log = Join-Path $PSScriptRoot 'oracle-sync.log'
$err = Join-Path $PSScriptRoot 'oracle-sync.err.log'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) { throw "node.exe not found (looked on PATH and at $node)" }

$watchArgs = @('tools/oracle-sync/oracle-sync.mjs', 'watch')
$common = @{
    FilePath               = $node
    ArgumentList           = $watchArgs
    WorkingDirectory       = $repo
    RedirectStandardOutput = $log
    RedirectStandardError  = $err
}
if ($Detach) { Start-Process @common -WindowStyle Hidden }
else { Start-Process @common -NoNewWindow -Wait }
