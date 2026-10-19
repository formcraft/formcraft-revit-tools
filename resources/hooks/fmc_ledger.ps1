<#
  Formcraft ledger hook for PowerShell (5.1 or 7) and batch files. docs/AUTOMATION_BALANCE.md
  Records one run in %APPDATA%\Formcraft\ledger\external-YYYY-MM.jsonl: kind, script, ok, ms. No names, no data.
  It never fails the caller: any problem writing the line is ignored. The ledger stays on this PC.

  From PowerShell:  & .\fmc_ledger.ps1 -Kind powershell -Script MyScript -Ok $true -Ms 1200
  From a batch file (see fmc_ledger.cmd for the one line to paste):
      powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fmc_ledger.ps1" -Kind batch -Script "%~n0" -Ok %ERRORLEVEL%

  The same as one line, to paste at the end of a .ps1 (set the script name; $? is whether the last command worked):
  $ok=$?; try { $d=if($env:FMC_LEDGER_DIR){$env:FMC_LEDGER_DIR}else{"$env:APPDATA\Formcraft\ledger"}; $n=(Get-Date).ToUniversalTime(); New-Item -ItemType Directory -Force $d | Out-Null; Add-Content -Encoding UTF8 -Path "$d\external-$($n.ToString('yyyy-MM')).jsonl" -Value (@{at=$n.ToString('yyyy-MM-ddTHH:mm:ssZ');kind='powershell';script='MyScript';ok=$ok;ms=0;started_by=$(if($env:FMC_STARTED_BY){$env:FMC_STARTED_BY}else{'person'})} | ConvertTo-Json -Compress) } catch {}
#>
param(
  [string]$Kind = 'powershell',
  [string]$Script = '(unnamed)',
  # $true / $false, or a batch file's %ERRORLEVEL% (0 is ok)
  [string]$Ok = 'True',
  [double]$Ms = 0,
  [string]$Project = ''
)
try {
  $dir = if ($env:FMC_LEDGER_DIR) { $env:FMC_LEDGER_DIR } else { Join-Path $env:APPDATA 'Formcraft\ledger' }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $now = (Get-Date).ToUniversalTime()
  # a number is an exit code (0 is ok); otherwise anything but false / error is ok
  if ($Ok -match '^-?\d+$') { $good = ([int]$Ok -eq 0) } else { $good = $Ok -notmatch '^(false|\$false|error|no)$' }
  $line = [ordered]@{
    at = $now.ToString('yyyy-MM-ddTHH:mm:ssZ'); kind = $Kind; script = $Script; ok = [bool]$good; ms = [int]$Ms; project = $Project
    started_by = $(if ($env:FMC_STARTED_BY) { $env:FMC_STARTED_BY } else { 'person' })
  } | ConvertTo-Json -Compress
  [System.IO.File]::AppendAllText((Join-Path $dir "external-$($now.ToString('yyyy-MM')).jsonl"), $line + "`n", (New-Object System.Text.UTF8Encoding $false))
} catch {
  # never fail the caller
}
