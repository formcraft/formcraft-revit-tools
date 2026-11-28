# Pane commands that only set the status line (F03 FIX-BRANCH 1)

Listed from the code at `cf71214` with `git grep -E 'new RelayCommand\(\(\) => (Status = |_status\()' shell/Formcraft.Shell`
(28 Nov 2026, Builder 2, branch `feat/research-ui-circuits`). "Claims" means the text says something happened that did not.

| Command (file:line at cf71214) | Text says | Claims? | Done on this branch |
|---|---|---|---|
| Header `HelpCommand` (`ShellViewModel.cs:232`) | "opens this section of the guide and the first-run tour" | yes | button hidden (`HelpAvailable` false), text says Help isn't built yet |
| Settings › Help › Guide (`SettingsViewModel.cs:290`) | "opens the Formcraft guide at this section" | yes | text made honest (F10 commit) |
| Settings › Help › Send a support report (`SettingsViewModel.cs:292`) | "Support report made: versions and log rows…" | yes | text made honest (F10 commit) |
| Settings › Updates › Release notes (`SettingsViewModel.cs:283`) | the feed's notes | no (mock feed only) | none |
| Locked section `SeeWhatItDoesCommand` (`ShellViewModel.cs:140`) | "see what it does on the Formcraft account website" | no (points elsewhere) | none |
| Sign-in `ForgotPasswordCommand` (`SetupViewModels.cs:28`) | "the Formcraft account website resets it" | no (points elsewhere) | none |
| Sign-in `AskAdminCommand`, `WorkOfflineCommand` (`SetupViewModels.cs:29-30`) | advice | no | none |
| Admin `OpenTeamFileCommand` (`ShellViewModel.cs:220`) | where the team file is | no | none |
| Admin `SaveAdminCommand`, Settings `SaveSettingsCommand` (`ShellViewModel.cs:221-222`) | "Saved…" (changes save as made) | no | none |
| Admin › Export team file (`AdminViewModel.cs:145`) | "saves FMC_Team.json… (with the team file, U12)" | partly (future tense) | none: Admin/licence area (F08), left for its owner |
| Admin › Open the account website (`AdminViewModel.cs:244`) | where buying happens | no | none |
| Admin › Assign seats (`AdminViewModel.cs:252`) | future feature (U17) | no | none |
| Admin › Make offline licence file (`AdminViewModel.cs:253`) | "Made FMC_Licence_<PC>.lic… (sample)" | yes | none: licence area, listed for Builder 1 / the licence owner |
| Templates › Compare two versions (`TemplatesPage.cs:425`) | future feature | no | none |
| Templates › Publish to library (`TemplatesPage.cs:426`) | explains the people gate | no | none |

Buttons that point to a website or explain a rule were left as they are: the text is true, and hiding them is a design decision.
