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

## One-time install (the owner, about 10 minutes)
1. On GitHub, open the repo's **Settings › Actions › Runners › New self-hosted runner** and choose **Windows**, **x64**.
   The page shows the exact commands, including a one-hour registration token. Copy them from there; nobody needs to
   paste the token anywhere else.
2. Open **PowerShell as administrator**. Running as administrator is needed only to install the service. Run:
   `mkdir D:\actions-runner; cd D:\actions-runner`
   Then run the page's *Download* commands (download, optional hash check, extract).
3. Run the page's *Configure* command (`./config.cmd --url … --token …`) and answer its prompts:
   - **runner group:** Enter (Default)
   - **runner name:** `formcraft-pc`
   - **labels:** Enter (keeps `self-hosted, Windows, X64`, which the workflow asks for)
   - **work folder:** Enter (`_work`)
   - **run as service:** `Y`
   - **service account:** Enter (`NT AUTHORITY\NETWORK SERVICE`)
4. Back on the Runners page, `formcraft-pc` should show **Idle**. Queued checks start within a minute.

## Safety
- Keep the repo private. On a public repo, anyone's pull request could run code on this PC.
- To stop the runner, use Windows Services › "GitHub Actions Runner (…formcraft-pc)" › Stop.
- To remove it, run `./config.cmd remove` in `D:\actions-runner` with a removal token from the same Runners page.
