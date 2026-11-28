<#
  Formcraft MCP service supervisor. No admin rights. Runs the Streamable HTTP server
  (node index.js --http) for the current user, restarts it if it exits, and stays down while the updater
  is swapping in a new build (mcp\revit-fmc\build.incoming). The bearer token is never passed on the
  command line and is never written to this log.
#>
param([string]$IndexJs = '')

$ErrorActionPreference = 'Stop'
$state = Join-Path $env:APPDATA 'Formcraft'
$log = Join-Path $state 'mcp-http.log'
$index = if ($IndexJs) { $IndexJs } else { Join-Path $env:USERPROFILE 'mcp\revit-fmc\build\index.js' }
# index.js lives in <mcp>\build\index.js. The updater fills <mcp>\build.incoming, then renames it into place.
$incoming = Join-Path (Split-Path (Split-Path $index -Parent) -Parent) 'build.incoming'

New-Item -ItemType Directory -Force $state | Out-Null
function Log([string]$m) {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) {
        $bak = "$log.1"
        if (Test-Path $bak) { Remove-Item $bak -Force }
        Rename-Item $log $bak
    }
    Add-Content -Path $log -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m) -Encoding UTF8
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\FormcraftMcpHttp')
if (-not $mutex.WaitOne(0)) { Log 'The MCP service supervisor is already running'; exit 0 }

$node = $null
try { $node = (Get-Command node -ErrorAction Stop).Source } catch { Log 'Node.js was not found on PATH'; exit 1 }

function Stamp {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($f in @(
        (Join-Path $state 'installed.json'),
        (Join-Path $state 'mcp-http.reload'),
        (Join-Path (Split-Path $index -Parent) 'build-info.json'),
        $index
    )) {
        if (Test-Path $f) {
            $item = Get-Item $f
            $parts.Add($item.FullName + ':' + $item.LastWriteTimeUtc.Ticks + ':' + $item.Length)
        }
    }
    return ($parts -join '|')
}

try {
    Log "Supervisor started for $index"
    while ($true) {
        if (Test-Path $incoming) {
            Log 'A new build is incoming: leaving the server stopped until the updater finishes the swap'
            Start-Sleep -Seconds 1
            continue
        }
        if (-not (Test-Path $index)) {
            Log "No server at $index yet"
            Start-Sleep -Seconds 5
            continue
        }
        $stamp = Stamp
        $errLog = Join-Path $state 'mcp-http.err.log'
        if ((Test-Path $errLog) -and (Get-Item $errLog).Length -gt 1MB) {
            if (Test-Path "$errLog.1") { Remove-Item "$errLog.1" -Force }
            Rename-Item $errLog "$errLog.1"
        }
        $proc = Start-Process -FilePath $node -ArgumentList @("`"$index`"", '--http') -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $state 'mcp-http.out.log') `
            -RedirectStandardError (Join-Path $state 'mcp-http.err.log')
        Log "Started the MCP service pid $($proc.Id)"
        while (-not $proc.HasExited) {
            Start-Sleep -Seconds 2
            if ((Test-Path $incoming) -or ((Stamp) -ne $stamp)) {
                Log "Build changed: stopping pid $($proc.Id) so it loads the new files"
                try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
                break
            }
        }
        if ($proc.HasExited -and -not (Test-Path $incoming)) { Log "MCP service exited $($proc.ExitCode); restarting" }
        Start-Sleep -Seconds 1
    }
}
catch { Log ("Supervisor stopped on an error: {0}" -f $_.Exception.Message) }
finally { $mutex.ReleaseMutex() }
