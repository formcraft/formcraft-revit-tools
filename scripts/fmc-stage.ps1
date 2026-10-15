<#
  Stages the built add-in and server for the Formcraft updater (scripts/fmc-update.ps1).

  Run from the repo root after building on an up-to-date main:
    dotnet build plugin/RevitMCPPlugin.csproj -c "Release R25"   (and the commandset)
    npm run build --prefix server
    powershell -File scripts/fmc-stage.ps1
  A newer staged build replaces one not yet installed. ready.json is written last, so the updater never installs a
  half-copied build. Builds from uncommitted changes ("+local") are refused unless -AllowLocal.
#>
param([string]$RevitYear = '2025', [switch]$AllowLocal)

$ErrorActionPreference = 'Stop'
$repo   = Split-Path $PSScriptRoot -Parent
$bundle = Join-Path $repo "plugin\bin\AddIn $RevitYear Release R$($RevitYear.Substring(2))"
$server = Join-Path $repo 'server\build'
$next   = Join-Path $env:LOCALAPPDATA 'Formcraft\Staging\next'

if (-not (Test-Path (Join-Path $bundle 'Formcraft.addin'))) { throw "No add-in bundle at ${bundle}: build the plugin first" }
if (-not (Test-Path (Join-Path $server 'build-info.json'))) { throw "No server build at ${server}: npm run build --prefix server" }

$commit = (git -C $repo rev-parse --short HEAD).Trim()
if ((git -C $repo status --porcelain --untracked-files=no) -and -not $AllowLocal) { throw "Uncommitted changes: stage builds from a clean main (or pass -AllowLocal)" }
$serverCommit = (Get-Content (Join-Path $server 'build-info.json') -Raw | ConvertFrom-Json).commit
if ($serverCommit.Replace('+local', '') -ne $commit) { Write-Warning "Server build is ${serverCommit}, the repo is at ${commit}: rebuild the server" }

if (Test-Path $next) { Remove-Item $next -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $next 'addin'), (Join-Path $next 'server') | Out-Null
Copy-Item (Join-Path $bundle 'revit_mcp_plugin') (Join-Path $next 'addin') -Recurse
Copy-Item (Join-Path $bundle 'Formcraft.addin') (Join-Path $next 'addin')
Copy-Item $server (Join-Path $next 'server') -Recurse
# The Robot connector (connectors/robot), built where Robot is installed: it travels beside the server.
$robot = Join-Path $repo 'server\robot'
if (Test-Path (Join-Path $robot 'fmc-robot.exe')) { Copy-Item $robot (Join-Path $next 'server') -Recurse }
# The Navisworks add-in (connectors/navisworks), built where Navisworks is installed: the updater installs it when
# Navisworks is closed.
$navis = Join-Path $repo 'connectors\navisworks\bin\Release\Formcraft.Navis'
if (Test-Path (Join-Path $navis 'Formcraft.Navis.dll')) {
    New-Item -ItemType Directory -Force (Join-Path $next 'navis') | Out-Null
    Copy-Item $navis (Join-Path $next 'navis') -Recurse
}

[ordered]@{ commit = $commit; staged_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); revit = $RevitYear } |
    ConvertTo-Json | Set-Content -Path (Join-Path $next 'ready.json') -Encoding UTF8
Write-Output "Staged $commit in $next. It installs the next time Revit is closed."
