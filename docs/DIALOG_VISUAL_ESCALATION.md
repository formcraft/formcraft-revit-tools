# Dialog visual escalation (tier 3)

Spec only. Nothing in this document is implemented. The flag is optional and **off by default**. No code path may tap a dialog because this file exists.

This is the last resort, after the two quieter tiers:

1. **Add-in.** `DialogBoxShowing` in `commandset/Bridge/FmcAiJob.cs`, with `DialogRules` for the short safe list, and `FmcFailures` so warnings are deleted and errors roll back instead of becoming a modal.
2. **Win32 fallback**, for dialogs Revit does not route through the API: list `#32770` windows on Revit's process, screenshot, and click Close, OK, or Cancel only when the text is allowlisted. Destructive prompts stay up.
3. **This tier.** A dialog that is still up, outside those allowlists or not a standard Close/OK/Cancel box, may be offered to one bot for a single visual tap. The bot does not drive the screen itself. It asks Formcraft Flow's touch engine to tap one point inside that dialog.

## The touch integration

The founder's touchscreen plugin is **TouchKit**, started with Revit.

- Project: `touch/TouchKit` (`TouchKit.csproj`). Settings live in `touch/TouchKit.Core`.
- Started from the add-in: `plugin/Core/Application.cs` calls `TouchKit.App.Start` on `OnStartup`. `plugin/Shell/ShellHost.Touch` holds the app. The pane talks to it through `plugin/Shell/RevitTouch.cs` (`ITouchService`): Settings › Flow › Touch, the Touch quick tool, and the Flow ribbon. Settings are saved under `%APPDATA%\Formcraft\TouchKit`.
- Synthetic clicks already exist: `touch/TouchKit/Navigation/SyntheticInput.cs` sends one mouse click with `SendInput`, marked `dwExtraInfo` signature `TKTK` (`0x544B544B`) so TouchKit's own hook can tell its input from a person's. `ReleaseAll` drops every button it is holding.
- `touch/TouchKit/Input/TouchRouter.cs` decides which fingers TouchKit owns. Today that decision is about a touch landing on a Revit **view** TouchKit has taken over, not about a modal dialog.

Tier 3 does not add a second clicker and does not reuse view takeover. A future implementation would add a dialog-only entry on `TouchKit.App` that calls `SyntheticInput.LeftClick` once, at a point that has already been checked to lie inside one Revit-owned dialog window. `TouchRouter` stays on views.

## Who may use it

**Only Hostel Building Bot.**

The MCP client name or the bot field on the call must be `Hostel Building Bot`, the same identity as the default `batch_schedulers` entry. A discipline bot (architecture, structural, electrical, plumbing, site, or any other name) cannot escalate, even when it holds the lease. If Hostel Building Bot is not the session that holds the lease, the call is refused.

The flag being on is not enough. Hostel Building Bot still needs a per-dialog approval or a founder time window, below.

## Switch

`dialog_visual_escalation` in `fmc_guard.json`.

| Value | Meaning |
| --- | --- |
| absent or `false` | Off. No screenshot for this tier, no tap, no approval prompt. |
| `true` | The tier may be offered to Hostel Building Bot, still subject to every rail below. |

Default is **off**. Turning it on does not allowlist any dialog and does not grant a time window.

## When it may run

All of these are required:

- The flag is on.
- Stop AI is off. Stop AI is `ai_modeller.stop` in `fmc_guard.json` and the pane switch. It is the global kill switch. While Stop AI is on, an in-progress escalation aborts before the next tap and releases any synthetic button (`SyntheticInput.ReleaseAll`).
- A batch lease is **held** (state active) on the document the dialog belongs to, by Hostel Building Bot. A queued lease, a foreign lease, or no lease means the dialog stays up for a person.
- Tier 1 and tier 2 have already left this dialog alone. This tier never overrides an allowlisted Close/OK/Cancel and never races the add-in hook.
- The target is one top-level window of class `#32770` whose process id is the Revit process that holds the lease. Child buttons are tapped only as points inside that window's rectangle.

## Approval

Each dialog needs a fresh yes, unless the founder has set a time window.

- **Per dialog.** Hostel Building Bot asks. A person approves that one dialog (its title and text are shown). The approval names the dialog id or the window handle captured at ask time. It is not reusable for the next dialog.
- **Time window.** Optional. The founder sets `dialog_visual_window` as a start and end in `fmc_guard.json` (UTC). Inside that window, Hostel Building Bot may escalate without a fresh yes. Outside it, each dialog needs approval again. A missing window means every dialog needs approval. The window does not turn the flag on and does not override Stop AI.

A refused or expired approval leaves the dialog up. The batch is not failed by the refusal.

## What may be tapped

The window must pass every check before the first screenshot is taken for a tap, and again before each tap:

- Process id is Revit's.
- Class is `#32770`.
- The window is visible and is owned by that Revit (owner or root is that process). No other process, no desktop, no taskbar, no pane, no view, no other application's window.
- The tap point is inside the dialog's screen rectangle, inset so a tap cannot land on the window frame's system buttons unless the founder approved that exact control.
- The window title and static text do not match the denylist.

**Denylist** (title or text, case-insensitive). These are never tapped, never approved past, and a time window does not cover them:

- delete
- unjoin
- overwrite
- relinquish
- save-as, save as
- upgrade
- license, licence
- sign-in, sign in, log in

If the text matches, the tool returns `left for a person` and the reason. Stop AI is not required for that refusal.

## Steps

One tap, then look again.

1. Record the window identity: process, handle, class, title, rectangle, and a hash of the static text.
2. Screenshot the dialog (the window only) and store the path. This is the "before" image.
3. Ask for one point, or accept one point the bot already proposed from that screenshot. Reject a point outside the rectangle.
4. Re-read the window. If the handle, class, process, title, or text hash changed, **abort**. No tap.
5. If a person is providing input (a real pointer or key that is not TouchKit's `TKTK` signature), **abort**. No tap.
6. One `LeftClick` through `SyntheticInput`. Then `ReleaseAll`.
7. Screenshot again and store the path. This is the "after" image.
8. Re-read the window. Report whether it is still open. That report is the only thing the bot may use to decide a next step.

**Max steps: 3** taps for one dialog. The cap is `dialog_visual_max_steps` and cannot be set above 3. After the cap, stop, even if the dialog is still open. A new approval does not raise the cap for that same window.

There is no drag, no chord, no key, and no second click inside one step.

## Abort

Abort means: `ReleaseAll`, write the audit row, take the after screenshot if a tap already happened, and return the dialog to the person. The lease is not released and the model is not rolled back by this tier.

Abort when:

- Stop AI turns on.
- The lease is no longer held by Hostel Building Bot.
- The window handle, class, process, title, or text changes between the check and the tap.
- A person's input arrives (anything without the `TKTK` signature).
- The tap point falls outside the current rectangle.
- The denylist matches on a re-read.
- `SendInput` is rejected.
- The step cap is reached.

## Audit

Every attempt, including refusals and aborts, appends one JSON line to `%APPDATA%\Formcraft\FMC_DialogVisual.jsonl`:

- time (UTC)
- bot and MCP client
- document title and path
- lease id
- Revit pid, window handle, class, title, text
- approval: `dialog` or `window`, or `refused`
- step number
- before screenshot path, after screenshot path (after is empty when no tap happened)
- tap point, or none
- result: `tapped`, `aborted`, `denied`, `refused`, `cap`
- reason

The log is append-only. A failure to write it aborts the tap.

## What this tier does not do

- It does not click the desktop, the taskbar, the Formcraft pane, or another application.
- It does not accept Delete, Unjoin, overwrite, relinquish, save-as, upgrade, license, or sign-in.
- It does not run while the flag is off, while Stop AI is on, or while no batch lease is held.
- It does not let any bot other than Hostel Building Bot ask for it.
