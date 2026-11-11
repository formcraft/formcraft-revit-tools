<#
  Formcraft updater: installs a staged build the moment Revit is closed. It never closes Revit.

  Claude Code stages a build after each merge (scripts/fmc-stage.ps1) into
    %LOCALAPPDATA%\Formcraft\Staging\next\  (addin\, server\build\, ready.json written last)
  When ready.json is there and no Revit is running, this script:
    1. backs up the installed add-in to %APPDATA%\Autodesk\Revit\Addins\_FormcraftBackup\<date>_before-<commit>
    2. copies the add-in into %APPDATA%\Autodesk\Revit\Addins\2025 and the server into %USERPROFILE%\mcp\revit-fmc\build
       (the old server is kept as build.bak-<date>)
    3. writes %APPDATA%\Formcraft\installed.json (commit, time, backup), which fmc_selftest and Connect show; when an
       MCP server process (started by the Claude app) still runs the old build, the log and installed.json say the
       Claude app must be restarted (F-042). The updater never stops that process.
    4. moves the staged build to Staging\_installed\
  Every step is logged to %APPDATA%\Formcraft\updater.log.

  Run by the "Formcraft Updater" logon task (scripts/fmc-updater-task.ps1), or by hand with -Once.
#>
param([switch]$Once, [int]$PollSeconds = 3, [string]$RevitYear = '2025')

$ErrorActionPreference = 'Stop'
$root    = Join-Path $env:LOCALAPPDATA 'Formcraft\Staging'
$next    = Join-Path $root 'next'
$ready   = Join-Path $next 'ready.json'
$addins  = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$RevitYear"
$backups = Join-Path $env:APPDATA 'Autodesk\Revit\Addins\_FormcraftBackup'
$mcp     = Join-Path $env:USERPROFILE 'mcp\revit-fmc'
$state   = Join-Path $env:APPDATA 'Formcraft'
$log     = Join-Path $state 'updater.log'

New-Item -ItemType Directory -Force $state, $root | Out-Null

# The CI runner (a service account) stages merged builds of main here; the updater moves the drop into the person's
# staging folder, newest wins. See .github/workflows/build.yml, job "stage".
$drop = Join-Path $env:ProgramData 'Formcraft\Staging\next'
function PullDrop {
    if (-not (Test-Path (Join-Path $drop 'ready.json'))) { return }
    $info = Get-Content (Join-Path $drop 'ready.json') -Raw | ConvertFrom-Json
    if (Test-Path $next) { Remove-Item $next -Recurse -Force }
    Copy-Item $drop $root -Recurse -Force
    Remove-Item $drop -Recurse -Force
    Log "Took the CI build $($info.commit) from $drop"
}

function Log([string]$m) {
    $max = 1MB
    if ((Test-Path $log) -and (Get-Item $log).Length -gt $max) {
        $bak = "$log.1"
        if (Test-Path $bak) { Remove-Item $bak -Force }
        Rename-Item $log $bak
    }
    Add-Content -Path $log -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m) -Encoding UTF8
}

# The commit is the one just installed (ready.json), and the file list is what is on disk after the copy.
# A previous install left this file saying an older commit; nothing else updates it.
function Write-InstalledFiles([string]$commit, [string]$serverState = 'installed', [string]$addinState = 'installed') {
    $files = New-Object System.Collections.Generic.List[string]
    $serverBuild = Join-Path $mcp 'build'
    if (Test-Path $serverBuild) {
        Get-ChildItem $serverBuild -Recurse -File | ForEach-Object {
            $files.Add(('server\build\' + $_.FullName.Substring($serverBuild.Length).TrimStart('\', '/')))
        }
    }
    foreach ($name in @('Formcraft.addin')) {
        if (Test-Path (Join-Path $addins $name)) { $files.Add('addin\' + $name) }
    }
    $addinDir = Join-Path $addins 'revit_mcp_plugin'
    if (Test-Path $addinDir) {
        Get-ChildItem $addinDir -Recurse -File | ForEach-Object {
            $files.Add(('addin\revit_mcp_plugin\' + $_.FullName.Substring($addinDir.Length).TrimStart('\', '/')))
        }
    }
    $manifest = [ordered]@{
        commit       = $commit
        installed_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        server       = $serverState
        addin        = $addinState
        files        = @($files)
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $state 'installed-files.json') -Encoding UTF8
    Log "installed-files.json records $commit ($($files.Count) files)"
}

# F-042: the Claude app starts the Formcraft MCP server itself and keeps it running. Replacing the files doesn't
# change the running process: it keeps the code it started with until the app (or its connector) restarts. The
# updater never stops it; it lists it, so the log and installed.json say a restart is due (fmc_selftest fails too).
function RunningServers {
    $build = (Join-Path $mcp 'build').ToLowerInvariant()
    try {
        @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.CommandLine -and $_.CommandLine.Replace('/', '\').ToLowerInvariant().Contains($build) -and $_.CommandLine -match 'index\.js'
        } | ForEach-Object { '{0} (pid {1})' -f $_.Name, $_.ProcessId })
    } catch { @() }
}
function RevitRunning { [bool](Get-Process -Name 'Revit' -ErrorAction SilentlyContinue) }
function NavisRunning { [bool](Get-Process -Name 'Roamer' -ErrorAction SilentlyContinue) }
function RhinoRunning { [bool](Get-Process -Name 'Rhino' -ErrorAction SilentlyContinue) }

# The Formcraft add-in for Navisworks Manage 2025, per user (no admin rights). Navisworks locks it while open.
$navisNext    = Join-Path $root 'navis-next'
$navisPlugins = Join-Path $env:APPDATA 'Autodesk Navisworks Manage 2025\Plugins'

function InstallNavis {
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
    $target = Join-Path $navisPlugins 'Formcraft.Navis'
    if (Test-Path $target) {
        $backup = Join-Path $backups ("{0}_navis" -f $stamp)
        New-Item -ItemType Directory -Force $backup | Out-Null
        Copy-Item $target $backup -Recurse -Force
    }
    New-Item -ItemType Directory -Force $navisPlugins | Out-Null
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Move-Item $navisNext $target
    Log "Installed the Navisworks add-in into $target"
}

# The Formcraft add-in for Rhino 8, per user, as a Rhino package (Rhino loads every package at start). Rhino locks it
# while open.
$rhinoNext    = Join-Path $root 'rhino-next'
$rhinoPackage = Join-Path $env:APPDATA 'McNeel\Rhinoceros\packages\8.0\Formcraft.Rhino'

function InstallRhino {
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
    $target = Join-Path $rhinoPackage '1.0.0'
    if (Test-Path $target) {
        $backup = Join-Path $backups ("{0}_rhino" -f $stamp)
        New-Item -ItemType Directory -Force $backup | Out-Null
        Copy-Item $target $backup -Recurse -Force
        Remove-Item $target -Recurse -Force
    }
    New-Item -ItemType Directory -Force $rhinoPackage | Out-Null
    Move-Item $rhinoNext $target
    Set-Content -Path (Join-Path $rhinoPackage 'manifest.txt') -Value '1.0.0' -NoNewline -Encoding ascii
    Log "Installed the Rhino add-in into $target"
}

function Stop-HttpServer {
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        $pids = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -and $_.CommandLine -match 'index\.js' -and $_.CommandLine -match '--http'
        } | ForEach-Object { $_.ProcessId })
        if ($pids.Count -eq 0) { return }
        foreach ($procId in $pids) { try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch { } }
        Start-Sleep -Milliseconds 300
    }
}

# Copy the new server beside the live one, stop the service, swap, then ask /health.
# A failed health check puts the previous build back. Returns a short status, never the token.
function Install-ServerBuild([string]$commit, [string]$stamp) {
    New-Item -ItemType Directory -Force $mcp | Out-Null
    $incoming = Join-Path $mcp 'build.incoming'
    if (Test-Path $incoming) { Remove-Item $incoming -Recurse -Force }
    Copy-Item (Join-Path $next 'server\build') $incoming -Recurse -Force
    Set-Content -Path (Join-Path $state 'mcp-http.reload') -Value "swap $commit" -Encoding ascii
    Stop-HttpServer
    $live = Join-Path $mcp 'build'
    $bak = Join-Path $mcp "build.bak-$stamp"
    if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
    if (Test-Path $live) { Rename-Item $live $bak }
    Rename-Item $incoming $live
    if (Test-Path (Join-Path $next 'server\robot')) {
        if (Test-Path (Join-Path $mcp 'robot')) { Rename-Item (Join-Path $mcp 'robot') ("robot.bak-{0}" -f $stamp) }
        Copy-Item (Join-Path $next 'server\robot') $mcp -Recurse -Force
    }
    Set-Content -Path (Join-Path $state 'mcp-http.reload') -Value $commit -Encoding ascii
    $health = Test-McpHealth $commit
    if ($health.ok) { return 'pass' }
    Log "SERVER health failed ($($health.detail)). Rolling back."
    Stop-HttpServer
    $failed = Join-Path $mcp "build.failed-$stamp"
    if (Test-Path $live) { Rename-Item $live $failed }
    if (Test-Path $bak) { Copy-Item $bak $live -Recurse }
    Set-Content -Path (Join-Path $state 'mcp-http.reload') -Value "rollback $commit" -Encoding ascii
    return 'fail: rolled back'
}

function Test-McpHealth([string]$commit) {
    $tokenFile = Join-Path $state 'mcp-http.token'
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $tokenFile) {
            try {
                $token = (Get-Content $tokenFile -Raw).Trim()
                $port = 8787
                $cfg = Join-Path $state 'fmc_http.json'
                if (Test-Path $cfg) { try { $port = [int](Get-Content $cfg -Raw | ConvertFrom-Json).port } catch { } }
                $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:${port}/health")
                $req.Timeout = 2000
                $req.Headers.Add('Authorization', "Bearer $token")
                $resp = $req.GetResponse()
                $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
                $body = $reader.ReadToEnd() | ConvertFrom-Json
                $reader.Close(); $resp.Close()
                $got = [string]$body.build
                $bare = $got.Replace('+local', '')
                if ($bare.StartsWith($commit) -or $commit.StartsWith($bare)) { return @{ ok = $true; detail = "health $got" } }
                return @{ ok = $false; detail = "health build $got, expected $commit" }
            } catch { }
        }
        Start-Sleep -Milliseconds 400
    }
    return @{ ok = $false; detail = 'health did not answer' }
}

function Install {
    $info  = Get-Content $ready -Raw | ConvertFrom-Json
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
    $backup = Join-Path $backups ("{0}_before-{1}" -f $stamp, $info.commit)
    New-Item -ItemType Directory -Force $backup | Out-Null
    if (Test-Path (Join-Path $addins 'revit_mcp_plugin')) { Copy-Item (Join-Path $addins 'revit_mcp_plugin') $backup -Recurse -Force }
    if (Test-Path (Join-Path $addins 'Formcraft.addin'))  { Copy-Item (Join-Path $addins 'Formcraft.addin') $backup -Force }

    # The server does not need Revit closed. The add-in DLLs do.
    $serverState = 'not in this drop'
    $addinState = 'not in this drop'
    $serverDone = $false
    if ((Test-Path (Join-Path $next 'server\build\index.js')) -and -not (Test-Path (Join-Path $next 'server.installed'))) {
        $health = Install-ServerBuild $info.commit $stamp
        $serverDone = $true
        $serverState = $health
        New-Item -ItemType File -Force (Join-Path $next 'server.installed') | Out-Null
        Log "SERVER $health ($($info.commit))"
    } elseif (Test-Path (Join-Path $next 'server.installed')) { $serverState = 'installed'; $serverDone = $true }

    $addinWaiting = $false
    if ((Test-Path (Join-Path $next 'addin\Formcraft.addin')) -and -not (Test-Path (Join-Path $next 'addin.installed'))) {
        if (RevitRunning) {
            $addinWaiting = $true
            $addinState = 'waiting: Revit is open'
            Log "ADD-IN waiting: Revit is open. The server is handled separately. Close Revit to install the add-in. This updater will not close Revit."
        } else {
            Copy-Item (Join-Path $next 'addin\revit_mcp_plugin') $addins -Recurse -Force
            Copy-Item (Join-Path $next 'addin\Formcraft.addin') $addins -Force
            New-Item -ItemType File -Force (Join-Path $next 'addin.installed') | Out-Null
            $addinState = 'installed'
            Log "ADD-IN installed $($info.commit)"
        }
    } elseif (Test-Path (Join-Path $next 'addin.installed')) { $addinState = 'installed' }

    # The Navisworks add-in waits in Staging\navis-next and goes in when Navisworks is closed (InstallNavis).
    if (Test-Path (Join-Path $next 'navis\Formcraft.Navis')) {
        if (Test-Path $navisNext) { Remove-Item $navisNext -Recurse -Force }
        Copy-Item (Join-Path $next 'navis\Formcraft.Navis') $navisNext -Recurse
    }
    # The Rhino add-in waits in Staging\rhino-next and goes in when Rhino is closed (InstallRhino).
    if (Test-Path (Join-Path $next 'rhino\Formcraft.Rhino')) {
        if (Test-Path $rhinoNext) { Remove-Item $rhinoNext -Recurse -Force }
        Copy-Item (Join-Path $next 'rhino\Formcraft.Rhino') $rhinoNext -Recurse
    }

    $stale = @()
    if ($serverDone) {
        $stale = @(RunningServers)
        if ($stale.Count) {
            Log ("Server files are now {0}, but {1} still run the server it started with: restart the Claude app (or its Formcraft connector) to load build {0}. fmc_selftest fails until then." -f $info.commit, ($stale -join ', '))
        }
    }

    $record = [ordered]@{
        commit       = $info.commit
        staged_at    = $info.staged_at
        installed_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        backup       = $backup
        server       = $serverDone
        # F-042: MCP server processes still running the previous build when the files were replaced
        server_restart_needed = ($stale.Count -gt 0)
        server_processes      = $stale
    }
    $record | ConvertTo-Json | Set-Content -Path (Join-Path $state 'installed.json') -Encoding UTF8
    # installed-files.json used to keep an old commit (81627a6 after a later install). Rewrite it from this install.
    Write-InstalledFiles $info.commit $serverState $addinState
    @(
        "SERVER  $serverState  $($info.commit)"
        "ADD-IN  $addinState"
    ) | Set-Content -Path (Join-Path $state 'last-install.txt') -Encoding UTF8

    # A newer updater came with the build: it replaces this script's copy and runs from the next start (the logon task
    # starts it again within 5 minutes).
    $newUpdater = Join-Path $next 'updater\fmc-update.ps1'
    $selfUpdated = $false
    if ((Test-Path $newUpdater) -and $PSCommandPath -and ((Get-FileHash $newUpdater).Hash -ne (Get-FileHash $PSCommandPath).Hash)) {
        Copy-Item $newUpdater $PSCommandPath -Force
        $selfUpdated = $true
        Log "Updater script updated from $($info.commit)"
    }

    if ($addinWaiting) {
        Log "Install of $($info.commit) is partial: server $serverState, add-in still waiting for Revit to close."
        if ($selfUpdated) { $script:restart = $true }
        return
    }
    $done = Join-Path $root '_installed'
    New-Item -ItemType Directory -Force $done | Out-Null
    Move-Item $next (Join-Path $done ("{0}_{1}" -f $stamp, $info.commit))
    Log "Installed $($info.commit) (server: $serverState, add-in: $addinState); backup $backup"
    if ($selfUpdated) { $script:restart = $true }
}

# One updater at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Local\FormcraftUpdater')
if (-not $mutex.WaitOne(0)) { Log 'Another updater is running: this one exits'; exit 0 }
try {
    Log ("Updater started (poll {0}s{1})" -f $PollSeconds, $(if ($Once) { ', once' } else { '' }))
    while ($true) {
        try { PullDrop } catch { Log ("Couldn't take the CI drop: {0}" -f $_.Exception.Message) }
        if (Test-Path $ready) {
            try { Install } catch { Log ("Install failed: {0}" -f $_.Exception.Message) }
        }
        if ((Test-Path $navisNext) -and -not (NavisRunning)) {
            try { InstallNavis } catch { Log ("Navisworks add-in install failed: {0}" -f $_.Exception.Message) }
        }
        if ((Test-Path $rhinoNext) -and -not (RhinoRunning)) {
            try { InstallRhino } catch { Log ("Rhino add-in install failed: {0}" -f $_.Exception.Message) }
        }
        if ($Once -or $script:restart) { break }
        Start-Sleep -Seconds $PollSeconds
    }
}
catch { Log ("Updater stopped on an error: {0}" -f $_.Exception.Message) }
finally {
    if (-not $Once) { Log 'Updater stopped (the logon task starts it again within 5 minutes)' }
    $mutex.ReleaseMutex()
}
