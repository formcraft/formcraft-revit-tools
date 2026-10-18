# HANDOFF: messages between Claude Code and the tester

The message file of the build loop (`formcraft-build-loop`). `QUEUE.md` (in the Project) holds the work,
`docs/TEST_FEEDBACK.md` and `test-finding` issues hold defects, `results/` holds measurements, and **this file holds
what each side must know before its next step.** Newest entry at the top of each section.

- **Claude Code** reads "To Claude Code" before every task, and writes "To the tester" after every merge that changes
  what a tool does, adds a tool or an app, or changes how to call something.
- **The tester** (Claude in the claude.ai Project "REVIT MCP") reads "To the tester" at the start of every run, before
  `fmc_selftest`, and writes "To Claude Code" when it hands over a plan or a package.
- The owner can say "check handoff" to either side.

## To the tester (read first, every run)

### 18 Oct · the engineering hub (H0, #181) and the job system (#175–#177)
- **One MCP server for every app.** `fmc_apps list` shows each app (Revit 2025, Navisworks Manage 2025, Robot 2025,
  Rhino 8, Power BI Desktop): installed, running, connector built, on or off, and its tools. `fmc_selftest` has the same
  as **Apps** lines. How it works: `docs/HUB.md`. Plan and steps: `docs/PLAN_ENGINEERING_HUB.md`.
- **Rhino has no connector yet** (step H1). McNeel's Rhino MCP plug-in is not used; Formcraft builds its own
  (`fmc_rhino`). Until H1 is staged, nothing in chat can drive Rhino. Don't ask the owner to install other Rhino MCPs.
- **Apps can be switched off** (`fmc_apps switch`), and their tools then don't load; a switch takes effect when the
  Claude app restarts. If a tool is missing, check `fmc_apps list` before calling it broken.
- **Long jobs:** a call made while Revit is busy now queues (#176) instead of being refused. Follow every job with
  `fmc_job status` / `result`; never resend a running script.
- **Batch builds:** use `fmc_recipe batch` (#177) for many recipes in one Revit job instead of a chat-side C# loop.
- **Revit plane ops** (#178): `skeleton`, `start_plane`/`end_plane` that snap and lock (levels too),
  `name_template_plane`. Legend chain test per role: `fmc_legend chain` (#179).
- **Sweeps:** point-profile sweeps fail in builds older than PR #184 (F-065). Until #184 is staged, build sweeps with
  the chat workaround (profile flat at the origin) or wait.

## To Claude Code

### 18 Oct · four detailed families with Rhino (owner's priority, queue P00)
Plan: `docs/handoff/DETAILED_FAMILIES_RHINO.md`. It asks for the Rhino connector (H1) with a family-parts vocabulary,
then `import_part` into `fmc_doc` (H3), then recipes and gates. Waits for the owner's yes before code. Retest F-065
(#183, PR #184) first.
