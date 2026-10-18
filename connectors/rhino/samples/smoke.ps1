# The Rhino bridge's real run, with no AI: a part set through fmc_rhino into the open Rhino (the bridge builds in its
# own memory; the person's drawing is untouched), then the check, a save, renders and the parts for Revit, all under
# <staging>\_Rhino. Needs Rhino 8 open with the Formcraft add-in, and the server built (npm run build).
#   powershell -File connectors\rhino\samples\smoke.ps1 [-Parts <part set .json>]
param([string]$Parts = (Join-Path $PSScriptRoot 'smoke_parts.json'))
$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot '..\..\..\server\build\fmc\cli.js'
$set = Get-Content $Parts -Raw | ConvertFrom-Json
$family = $set.family

function Rhino([hashtable]$a) {
    $a.family = $family
    $json = $a | ConvertTo-Json -Depth 40 -Compress
    $out = $json | node $cli fmc_rhino
    $ok = $LASTEXITCODE -eq 0
    $r = ($out -join "`n") | ConvertFrom-Json
    $state = if ($ok) { 'ok  ' } else { 'FAIL' }
    $note = if ($r.problems) { " problems: $($r.problems -join ' | ')" } elseif ($r.error) { " $($r.error)" } elseif ($r.reasons) { " $($r.reasons -join ' | ')" } else { '' }
    Write-Host "$state $($a.action)$note"
    if (-not $ok) { exit 1 }
    return $r
}

$null = Rhino @{ action = 'status' }
$null = Rhino @{ action = 'new_doc'; replace = $true }
$null = Rhino @{ action = 'part'; parts = $set.parts; envelope = $set.envelope }
$null = Rhino @{ action = 'check'; envelope = $set.envelope }
$null = Rhino @{ action = 'save'; dry_run = $false }
$null = Rhino @{ action = 'render'; dry_run = $false }
$null = Rhino @{ action = 'render'; view = 'front'; dry_run = $false }
$r = Rhino @{ action = 'export_parts'; envelope = $set.envelope; dry_run = $false }
"Parts for Revit: $($r.manifest)"
