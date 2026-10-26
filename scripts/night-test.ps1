# Night test wrapper (owner 26 Oct): keeps the PC awake only while the test runs (no power settings change), then lets it sleep.
param([string]$Model = "OGL_TEST_Sandbox", [string]$Sandbox = "D:\Fomcraft\FMC_PROJECTS_27\FMC_TEST_SANDBOX\01_WIP\OGL_TEST_Sandbox.rvt", [string]$Pass = "all")
Add-Type -Namespace Fmc -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$out = Join-Path (Split-Path $Sandbox) ("00_AI_Log\night_" + (Get-Date -Format "yyyy-MM-dd_HHmm"))
New-Item -ItemType Directory -Force $out | Out-Null
[Fmc.Power]::SetThreadExecutionState([Convert]::ToUInt32("80000001", 16)) | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no sleep while running
try { node (Join-Path $PSScriptRoot "night-test.mjs") --model $Model --sandbox $Sandbox --out $out --pass $Pass 2>&1 | Tee-Object -FilePath (Join-Path $out "console.txt") }
finally { [Fmc.Power]::SetThreadExecutionState([Convert]::ToUInt32("80000000", 16)) | Out-Null }   # back to normal
Write-Output "OUT=$out"
