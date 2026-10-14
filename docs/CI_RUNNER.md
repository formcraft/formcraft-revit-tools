# CI on the pilot PC (self-hosted runner)

From 14 Oct 2026 the checks in `.github/workflows/build.yml` (shell, server, add-in) run on the pilot PC instead of
GitHub's hosted Windows runners. The repo is private on GitHub Free: its free Actions minutes ran out, and GitHub refuses
paid minutes without a payment method on file. A self-hosted runner costs nothing and builds next to the Revit it targets.

## How it behaves
- Jobs run one after another on the PC while it's on, and wait in the queue while it's off or asleep.
- A pull request is checked once per push. A newer push cancels the older run. `main` is checked on merge.
- The runner never opens, closes or installs anything in Revit. It builds in its own folder (`D:\actions-runner\_work`)
  and doesn't stage builds: staging is still `scripts/fmc-stage.ps1` after a merge.
- The PC needs Git, Node 22, and the .NET 8 and 10 SDKs on PATH. They were all there on 14 Oct.
- Steps run in Windows PowerShell 5.1 (`powershell`), because PowerShell 7 isn't installed.
- Build artifacts are kept for 3 days, and a full storage quota doesn't fail the checks.
- **To go back to hosted runners** (after adding a payment method, for example): Settings › Secrets and variables ›
  Actions › Variables › New repository variable `CI_RUNNER` = `hosted`.

## How it was installed (14 Oct, no admin rights)
The runner is `D:\actions-runner` (v2.337.0, hash checked against GitHub's), registered as `formcraft-pc` with the
labels `self-hosted, Windows, X64`. It runs in the owner's own account, not as a service: the checks then see the same
PATH (Git, Node, .NET) and have a desktop for the WPF snapshots.

```powershell
cd D:\actions-runner
$t = gh api -X POST repos/formcraft/formcraft-revit-tools/actions/runners/registration-token --jq .token
.\config.cmd --unattended --url https://github.com/formcraft/formcraft-revit-tools --token $t --name formcraft-pc --labels self-hosted,Windows,X64 --work _work
```

**Starting it.** By hand: run `D:\actions-runner\run.cmd` (it stays running until the window is closed or the PC
restarts). To start it at every logon, hidden, the owner registers a logon task once (no admin needed):

```powershell
$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "D:\actions-runner\run.cmd"' -WorkingDirectory 'D:\actions-runner'
$g = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Formcraft CI Runner' -Action $a -Trigger $g -Settings $s -Description 'GitHub Actions runner for formcraft-revit-tools. Never touches Revit.'
Start-ScheduledTask -TaskName 'Formcraft CI Runner'
```

On the repo's **Settings › Actions › Runners** page, `formcraft-pc` shows **Idle** when it's ready.

## Safety
- Keep the repo private. On a public repo, anyone's pull request could run code on this PC.
- To stop the runner, close its window, or `Stop-ScheduledTask 'Formcraft CI Runner'`.
- To remove it: `Unregister-ScheduledTask 'Formcraft CI Runner'`, then `.\config.cmd remove --token <removal token>` in
  `D:\actions-runner` (`gh api -X POST repos/formcraft/formcraft-revit-tools/actions/runners/remove-token --jq .token`).
