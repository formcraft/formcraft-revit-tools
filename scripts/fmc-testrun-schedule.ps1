<#
.SYNOPSIS
    Registers (or removes) the Task Scheduler task that starts the unattended Revit tests (F75). The owner runs this
    once; nothing in the repo or CI registers it.

.DESCRIPTION
    The task runs scripts\fmc-testrun.ps1 -Mode auto (resume an unfinished run, or start a new one once the last is old
    enough) for the signed-in user, on the desktop (Revit needs it), at below-normal priority:
      - at logon,
      - after the PC wakes from sleep (System log, Power-Troubleshooter event 1), two minutes later,
      - nightly at -NightlyAt (a missed night starts when the PC is next on).
    It starts only on mains power and never wakes the PC. If the PC goes onto battery during a run, the runner pauses
    itself (it isn't stopped); when the PC sleeps, the run stops with it and resumes at the next trigger.

.PARAMETER NightlyAt
    The nightly start, 24-hour time. Default 02:00.

.PARAMETER Remove
    Removes the task.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\fmc-testrun-schedule.ps1
    powershell -ExecutionPolicy Bypass -File scripts\fmc-testrun-schedule.ps1 -NightlyAt 01:30
    powershell -ExecutionPolicy Bypass -File scripts\fmc-testrun-schedule.ps1 -Remove
#>
param(
    [string]$TaskName = 'Formcraft Unattended Revit Tests',
    [string]$NightlyAt = '02:00',
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the task '$TaskName'."
    return
}

$script = Join-Path $PSScriptRoot 'fmc-testrun.ps1'
if (-not (Test-Path $script)) { throw "Not found: $script" }
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$script`" -Mode auto" `
    -WorkingDirectory (Split-Path $PSScriptRoot -Parent)

$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$nightly = New-ScheduledTaskTrigger -Daily -At $NightlyAt

# After wake: the System log's Power-Troubleshooter event 1 ("The system has returned from a low power state")
$class = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$wake = New-CimInstance -CimClass $class -ClientOnly
$wake.Enabled = $true
$wake.Delay = 'PT2M'
$wake.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">' +
    "*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]" +
    '</Select></Query></QueryList>'

# Mains power only to start; not stopped when the PC goes onto battery (the runner pauses itself); never wakes the PC;
# one at a time; no time limit (a batch can take hours); below-normal priority (7).
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 7
$settings.DisallowStartIfOnBatteries = $true
$settings.WakeToRun = $false

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $nightly, $wake) -Settings $settings `
    -Principal $principal -Force `
    -Description 'Formcraft unattended Revit tests (F75): scripts\fmc-testrun.ps1 -Mode auto. Its own Revit, scratch documents only, pauses on battery saver or battery, never keeps the PC awake.' | Out-Null

Write-Host "Registered '$TaskName': at logon, after wake and nightly at $NightlyAt, on mains power only."
Write-Host "Results: <reports_dir>\testrun\<run>\summary.md; progress: %APPDATA%\Formcraft\testrun\runner.log"
