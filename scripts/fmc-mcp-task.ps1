<#
  Installs (or removes with -Remove) the "Formcraft MCP" logon task for the current user. No admin rights.
  The supervisor script is copied to %LOCALAPPDATA%\Formcraft\McpService. It restarts the HTTP MCP server
  and reloads it when the updater swaps in a new build.
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$name = 'Formcraft MCP'
$home_ = Join-Path $env:LOCALAPPDATA 'Formcraft\McpService'

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match 'fmc-mcp-service\.ps1'
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
if ($Remove) { Write-Output "Removed the $name task."; return }

New-Item -ItemType Directory -Force $home_ | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'fmc-mcp-service.ps1') $home_ -Force
$script = Join-Path $home_ 'fmc-mcp-service.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$revive = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $revive) -Settings $settings -Principal $principal `
    -Description 'Runs the Formcraft MCP service on 127.0.0.1. Restarts it if it stops, and reloads it after an update. Log: %APPDATA%\Formcraft\mcp-http.log' | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Registered and started $name ($script)."
