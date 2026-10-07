<#
  Registers (or removes) a Windows scheduled task that starts the oracle-sync watcher
  whenever the current user logs in, so local saves keep syncing to the Foundry server
  without anyone remembering to start it.

    install-login-task.ps1             create / replace the task, then start it
    install-login-task.ps1 -Uninstall  remove it

  Runs as the current user, no admin needed, hidden window. If the watcher dies it is
  restarted (3 tries, 1 minute apart). Task name: MapShineAdvanced-OracleSync.
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$name = 'MapShineAdvanced-OracleSync'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        "Removed scheduled task $name."
    }
    else { "No scheduled task named $name." }
    return
}

$script = Join-Path $PSScriptRoot 'start-watcher.ps1'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT30S'   # let the network come up first
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Uploads Map Shine Advanced saves to the Foundry server (tools/oracle-sync).' -Force | Out-Null
Start-ScheduledTask -TaskName $name
"Registered and started $name for $user (starts at every login, 30s after)."
