<#
  Installs (or removes with -Remove) the "Formcraft Updater" logon task for the current user: no admin rights needed.
  The updater script is copied to %LOCALAPPDATA%\Formcraft\Updater, so switching branches in the repo never changes
  what runs. Run again after changing scripts/fmc-update.ps1.
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$name = 'Formcraft Updater'
$home_ = Join-Path $env:LOCALAPPDATA 'Formcraft\Updater'

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
if ($Remove) { Write-Output "Removed the $name task."; return }

New-Item -ItemType Directory -Force $home_ | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'fmc-update.ps1') $home_ -Force
$script = Join-Path $home_ 'fmc-update.ps1'

$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Installs a staged Formcraft build when Revit is closed. Never closes Revit. Log: %APPDATA%\Formcraft\updater.log' | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Registered and started $name ($script)."
