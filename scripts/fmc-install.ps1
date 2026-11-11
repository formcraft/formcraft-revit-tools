<#
  One command: stage the build that is already compiled, install it, print a health summary.

  The server is swapped in without closing Revit. The add-in waits until Revit is closed.
  A failed health check rolls the server back (the updater does that) and this script says so.

    powershell -File scripts/fmc-install.ps1

  Build first, on Windows, from the repo root:
    dotnet build plugin/RevitMCPPlugin.csproj -c "Release R25"
    npm run build --prefix server
#>
param([switch]$ServerOnly)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$bundle = Join-Path $repo 'plugin\bin\AddIn 2025 Release R25\Formcraft.addin'
$onlyServer = $ServerOnly -or -not (Test-Path $bundle)
if ($onlyServer) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fmc-stage.ps1') -ServerOnly -AllowLocal
} else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fmc-stage.ps1') -AllowLocal
}
if ($LASTEXITCODE) { throw "stage failed ($LASTEXITCODE)" }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'fmc-update.ps1') -Once
if ($LASTEXITCODE) { throw "install failed ($LASTEXITCODE)" }

$summary = Join-Path $env:APPDATA 'Formcraft\last-install.txt'
Write-Output ''
Write-Output '---- Formcraft install ----'
if (Test-Path $summary) { Get-Content $summary | ForEach-Object { Write-Output $_ } }
else { Write-Output 'ADD-IN  unknown'; Write-Output 'SERVER  unknown  (no last-install.txt)' }

$tokenFile = Join-Path $env:APPDATA 'Formcraft\mcp-http.token'
if (-not (Test-Path $tokenFile)) {
    Write-Output 'HEALTH  fail  no token file yet (the service has not started)'
    exit 1
}
$token = (Get-Content $tokenFile -Raw).Trim()
$port = 8787
$cfg = Join-Path $env:APPDATA 'Formcraft\fmc_http.json'
if (Test-Path $cfg) { try { $port = [int](Get-Content $cfg -Raw | ConvertFrom-Json).port } catch { } }
try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:${port}/health")
    $req.Timeout = 3000
    $req.Headers.Add('Authorization', "Bearer $token")
    $resp = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $reader.ReadToEnd() | ConvertFrom-Json
    $reader.Close(); $resp.Close()
    $queue = 0
    if ($body.queue) { foreach ($q in $body.queue) { $queue += [int]$q.waiting } }
    Write-Output ("HEALTH  pass  build {0}  listen {1}  revit {2}  queue {3}  tools failed {4}" -f $body.build, $body.listen, @($body.instances).Count, $queue, @($body.registration.failed).Count)
    exit 0
} catch {
    Write-Output 'HEALTH  fail  the service did not answer on 127.0.0.1 (token not printed)'
    exit 1
}
