# Hardware and memory (`fmc_hw`)

`fmc_hw` is one tool. It reports the PC and Revit's graphics settings, and it can close spare views when memory is short. It does not move the Revit model onto the graphics card.

## What the GPU cannot do

These stay on the CPU and in system RAM. No action in this tool changes that.

- The model database.
- Regeneration.
- Transactions.
- Every Revit API call, including `ExportImage`, screenshots and view export. The GPU draws the view only when hardware acceleration is on. The call itself is still on the CPU.
- `fmc_trace` verdicts. Walking the connectors stays on the API. Only a numeric point or clash sample can use a GPU kernel, and only when that kernel matches the CPU result.
- `fmc_coord` transforms. The 4×4 stays on the CPU. Only a point-distance sample can use the kernel.
- `fmc_joins` pressure_test. That command is not in this build. The ray/voxel sample does not read an open model.

Video memory is for drawn views. It is not a substitute for system RAM. A full page file or a dedicated GPU does not shrink the model.

## What can use the GPU

- View drawing, when Use hardware acceleration is on (`Revit.ini` `[Graphics] UseHardwareAcceleration=1`).
- Anti-aliasing of that drawing (`Antialiasing=1`), which also uses view memory.
- View navigation, when optimize view navigation is on. The ini key is `OptimizeViewNavigation` or, when the file already has it, `DisableOptimizedViewNavigation=0`. If this Revit build ignores the key, the checkbox is still in Options > Graphics.
- Views follow Use hardware acceleration. There is no separate published switch. This tool does not invent `UseHardwareAccelerationForViews` unless the ini already contains it.
- Plugin sampling (point distance, axis-aligned clash, ray through a box) on an optional GPU library, and only when the numbers match the CPU kernel. Otherwise the CPU kernel's numbers are kept.

`see_view` and image export are not a compute shader. They stay `ExportImage`.

## Actions

`dry_run` defaults to true for `gpu_prefer`, `free` and `offload`. `gpu_prefer` and `offload` also need `confirm:true` before they write. The bearer token is never printed. There is no new key in `fmc_guard.json`.

| Action | What it does |
|---|---|
| `scan` | Every GPU (name, vendor, dedicated VRAM, driver version and date). VRAM size prefers DXGI dedicated memory when the collector has it, otherwise `Win32_VideoController.AdapterRAM`. Per-process VRAM is the Windows GPU process memory counter, the process view of DXGI `QueryVideoMemoryInfo`. Also RAM, page file path, size and use, free disk on the system and page-file drives, CPU cores, and the Revit process working set, private bytes and commit. Hardware acceleration comes from `Revit.ini` and, when Revit is open, from the add-in. Flags a dedicated GPU left idle while Revit sits on the integrated one, including the Windows per-app preference `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`. |
| `gpu_prefer` | Plans `GpuPreference=2` (high performance) for `Revit.exe`. Apply writes that registry value only. It takes effect the next time Revit starts. It does not write `Revit.ini`. The reply says which graphics checkbox to set instead. |
| `memory` | A per-document estimate when the add-in can count elements: a share of the process working set by element count, marked as not a measurement. Open views, linked models, images, and undo depth when the API exposes it (it does not today). The working-set trend, and the pause tier and reason. |
| `free` | Closes non-active, non-pinned views beyond `keep` (default 2) on each document. Never closes the last view. Skips a document a person is working in unless the memory pause is active. Drops plugin-side image buffers. Does not delete exported PNGs. A save is included only when the existing autosave would save that file anyway, and never during the pause. A local save does not clear Revit's undo stack; the reply says so. |
| `advice` | A short list. Each line has the effect to expect: page file too small, page file on a full drive, old driver, integrated GPU in use, graphics settings. |
| `offload` | Reports the graphics values and the recommended ones. With `confirm:true` and `dry_run` false, writes the graphics keys. Revit reads them at the next start. An open Revit may rewrite the ini when it closes. Also runs the sampling kernels and names the backend (`cpu`, or `directml` / `directcompute` only on a match). |

## Tiers

Both tiers use `ram_pause_free_mb` (default 1024) and the resume line at 1.5× (1536). `0` turns the pause off.

- **Soft** (`FMC-MEMORY-SOFT`). Free memory is between the two lines, and the hard latch is not on. Reads and small writes continue. Heavy writes, Dynamo and script jobs are queued, not failed. New batch leases wait.
- **Hard** (`FMC-MEMORY-HARD`). Free memory is below 1024 MB. It stays hard until free memory is above 1536 MB, so a lease does not flap. Every model-changing call waits. Reads still run. When this tier is on and Revit is idle, `free` runs once a minute. It does not add a save.

`/health` shows `memory.tier`, `memory.code` and `memory.reason`, and `hw` from the scan cached when the server starts.

## Add-in

The command is `fmc_hw` in the Revit 2025 command set. It reads `Revit.ini`, counts views, links and images, and closes the views the server named after checking the same rules again. `Formcraft.Gpu.dll`, if someone places it beside the command set, is loaded late for the sampling kernel. The add-in builds and runs without it, and without ONNX Runtime or ComputeSharp. The server's optional DirectML probe does the same: a missing `onnxruntime-node` stays on the CPU.
