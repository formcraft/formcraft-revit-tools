<#
.SYNOPSIS
    Starts or resumes the unattended Revit tests (F75) with no AI, at below-normal priority.

.DESCRIPTION
    Runs `node <server>\build\fmc\cli.js fmc_testrun` in this window until the run ends. The runner starts its own
    Revit 2025 (a person's open Revit is left alone; the two run side by side), runs the scenarios in tests\revit in
    scratch documents only, closes its Revit without saving, and writes summary.md, findings.json, one JSON per
    scenario and the pictures to <reports_dir>\testrun\<run>\ (reports_dir from fmc_guard.json, %USERPROFILE%\FMC_Reports
    by default). Its checkpoint is in %APPDATA%\Formcraft\testrun (runner.log there follows the run).

    It pauses while battery saver is on, and while the PC is on battery (pause_on_battery in
    %APPDATA%\Formcraft\testrun\config.json, default on). It never keeps the PC awake: when the PC sleeps or shuts down
    the run stops with it, and the next start (this script, or the scheduled task from fmc-testrun-schedule.ps1) carries
    on from the checkpoint.

.PARAMETER Mode
    auto (default): resume an unfinished run; otherwise start a new one when the last ended more than
              new_run_after_hours (20) ago; otherwise do nothing. The scheduled task uses this.
    resume:   resume the last unfinished run only.
    new:      start a new run.

.PARAMETER Only
    new: run just these scenario ids (e.g. 01_selftest, 05_room_icu).

.PARAMETER Cli
    The server's cli.js. Default: the installed server (%USERPROFILE%\mcp\revit-fmc\build\fmc\cli.js), else this repo's
    server\build\fmc\cli.js.

.PARAMETER Scenarios
    The scenarios folder. Default: tests\revit in this repo.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\fmc-testrun.ps1
    powershell -ExecutionPolicy Bypass -File scripts\fmc-testrun.ps1 -Mode new -Only 01_selftest
#>
param(
    [ValidateSet('auto', 'resume', 'new')][string]$Mode = 'auto',
    [string[]]$Only = @(),
    [string]$Cli = '',
    [string]$Scenarios = '',
    [string]$Node = ''
)
$ErrorActionPreference = 'Stop'

# below normal: this process, and node and Revit started from it, give way to the person's own work
try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch { }

$repo = Split-Path $PSScriptRoot -Parent
if (-not $Scenarios) { $Scenarios = Join-Path $repo 'tests\revit' }
if (-not (Test-Path $Scenarios)) { throw "No scenarios at $Scenarios" }
if (-not $Cli) {
    $installed = Join-Path $env:USERPROFILE 'mcp\revit-fmc\build\fmc\cli.js'
    $fromRepo = Join-Path $repo 'server\build\fmc\cli.js'
    if (Test-Path $installed) { $Cli = $installed }
    elseif (Test-Path $fromRepo) { $Cli = $fromRepo }
    else { throw "No server build: install the latest Formcraft build, or run npm run build --prefix server" }
}
if (-not $Node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'node is not on PATH' }
    $Node = $cmd.Source
}

$request = @{
    action        = $(if ($Mode -eq 'new') { 'run' } else { 'resume' })
    auto          = ($Mode -eq 'auto')
    foreground    = $true
    scenarios_dir = $Scenarios
    only          = @($Only)
} | ConvertTo-Json -Compress

Write-Host "Formcraft unattended Revit tests ($Mode): $Cli"
Write-Host "Scenarios: $Scenarios"
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$request | & $Node $Cli fmc_testrun
exit $LASTEXITCODE
