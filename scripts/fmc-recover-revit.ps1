<#
  Recover crashed or hung Revit when the Formcraft MCP server is down.
  This script does not start the HTTP service. It runs the same planner as fmc_recover_revit.

  plan   read-only report (the default)
  apply  close crashed or hung Revit, start Revit 2025, reopen the documents

  Needs the add-in (not this script):
  - the plugin heartbeat in %APPDATA%\Formcraft\instances\<pid>.json
  - the port the plugin leases (8080-8089)
  - fmc_document_info to prove each reopened title and path
  - re-registering the instance (the add-in writes the instance file when it connects)

  Does not need the add-in:
  - seeing that a Revit process is gone, not responding, or named by WerFault
  - graceful close, then taskkill /F
  - starting Revit.exe with the file paths
  Workshared files are left for Revit to open as a new local. This script does not write originals on D:.

  Usage:
    powershell -File scripts\fmc-recover-revit.ps1
    powershell -File scripts\fmc-recover-revit.ps1 -Action apply -Confirm <token> -ForceUnsaved
#>
param(
    [ValidateSet("plan", "apply")][string]$Action = "plan",
    [string]$Confirm = "",
    [switch]$ForceUnsaved
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path (Join-Path $root "server\package.json"))) { $root = Split-Path -Parent $PSScriptRoot }
$cli = Join-Path $root "server\build\fmc\recover-cli.js"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error "node is not on PATH. The MCP server process is not required, but node is."; exit 2 }
if (-not (Test-Path $cli)) { Write-Error "Missing $cli. Build the server (npm run build --prefix server) once. The HTTP service does not have to be running."; exit 2 }

$argList = @($cli, $Action)
if ($Action -eq "apply") {
    if (-not $Confirm) { Write-Error "apply needs -Confirm, the token printed by plan."; exit 2 }
    $argList += $Confirm
    if ($ForceUnsaved) { $argList += "--force-unsaved" }
}
& $node @argList
exit $LASTEXITCODE
