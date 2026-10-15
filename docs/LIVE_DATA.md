# Keep FMC data filled

The owner decided on 15 Oct 2026 that "all schedules should be automatic as work is done in the model".

Revit schedules are already live. What wasn't automatic were the FMC fields that scripts filled by hand, such as
`05_Scripts/Dynamo/FMC_SyncMasterData.py` copying each type's Keynote into `FMC_Keynote_Code`. **Keep FMC data filled**
fills those fields as people model. It's a Revit dynamic model updater (`IUpdater`) in the Formcraft add-in.

Code:
- `plugin/Fmc/LiveDataUpdater.cs` holds the updater, the kit look-ups and the log.
- `plugin/Fmc/LiveDataRules.cs` holds the pure rules, tested in `tests/shell/LiveDataTests.cs`.
- `plugin/Fmc/LiveDataSwitch.cs` holds the per-project switch.
- `plugin/Shell/RevitLiveData.cs` connects the switch to the pane.

## What it fills
It writes a field only when **the element or its type already has the parameter**. A field that's missing from the
kit or the model is skipped and nothing is added.

| Field | On | From | When |
|---|---|---|---|
| `FMC_Keynote_Code` | type | the type's **Keynote** | empty or different. It's a pure copy, so a stale value is updated |
| `FMC_Code_Description` | type | the code's description in the kit: `03_Master_Data\FMC_Master_Data.json` "codes". For a code that's only in `02_Keynotes\FMC_Keynotes.txt`, that file's description is used | empty or different. It's a kit look-up, treated as a copy |
| `FMC_Code_Group` | type | the code's `group` in `FMC_Master_Data.json` "codes". The keynote file's parent isn't used as a group | empty or different. It's a kit look-up |
| `FMC_Role_Code` | instance and type, wherever the parameter is | the role field of the model's file name, `[Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt`. A workshared model uses the central model's name, and a local copy's `_<user>` is ignored | empty only. A name that doesn't follow the rule gives nothing |
| `FMC_Panel_ID` | Electrical Equipment | the built-in **Panel Name** | empty only |
| `FMC_Circuit_Ref` | devices and fixtures on a power circuit | `<panel>/<circuit number>` from the element's power circuit | empty or different. It's a pure copy. A device on no circuit gets nothing, and an old value isn't cleared |
| `FMC_Data_Sync_Stamp` | any element or type the updater just wrote to | the kit version and date, e.g. `FMC Kit v2.2 2026-10-15`. The version comes from `FMC_Kit.json`; if that's missing, the stamp shows `?` | every time it writes |

The kit folder is the one set in Settings › General › kit (default `Z:\00_Standards`). The kit files are read again when
they change, checked at most every 30 seconds.

**A value a person typed is kept.** The updater overwrites a different value only in a pure copy field: the keynote code,
the code description and group, and the circuit reference. A copy can't be typed differently on purpose; it can only be
out of date.

### When it runs
- An element or type is added in one of the model categories: walls, floors, roofs, ceilings, doors, windows,
  furniture, casework, generic models, columns, structure, stairs and railings, curtain panels and mullions, plumbing,
  specialty, mechanical and electrical equipment, electrical and lighting fixtures and devices, the low-voltage device
  categories, sprinklers, pipes, ducts and their fittings, accessories and terminals, cable trays, conduits, site,
  planting and parking.
- A type's **Keynote** changes.
- An element changes type.
- A board's **Panel Name** changes. In Revit 2024 and later, every device on that board's circuits is updated too.
- A circuit is added or changes. This covers a device joining a circuit, renumbering, and a circuit moved to another board.

Changing one of the fields above doesn't trigger the updater, so it never loops.

## What it never fills
- Sizes, ratings, loads, demand factors, cable specs, structural sections, or anything a professional decides
  (CLAUDE.md rule 5).
- Any field outside the table above.
- Elements in a **group**. A change would apply to every copy of the group, so grouped elements are left to the person.
- In a workshared model, elements **someone else is editing**, or that changed in central since your last reload.
- **Family documents** and linked models.

It never saves and never synchronises with central (rule 6). Its writes are part of the person's own change, so they
undo with one Undo.

## How to switch it on
The switch is **per project**, **off by default**, and saved **in the model**: extensible storage on Project
Information, schema `b49826ed-9229-41a3-85da-570aeca63984` with the fields `Enabled`, `EnabledBy` and `EnabledAt`.

1. Open the project model in Revit, with the Formcraft add-in installed.
2. Go to Formcraft pane › Settings › **Manage** › **Keep FMC data filled**. Search (Ctrl+K) for "keep FMC data filled"
   also takes you there.
3. The BIM Manager (or an admin) presses **Switch on for this project** and confirms. Everyone else sees the state but
   gets no button.
4. In a workshared model, **sync** so the team gets the setting. Formcraft doesn't sync for you.

Switching off works the same way. Values already filled stay as they are.

Nothing is filled until someone adds or changes an element; switching on doesn't run over the whole model. A
whole-model fill would be a separate, dry-run-first tool.

Claude has no MCP tool that switches this on. Only the person in the pane can.

**Rule 1 note.** The live-model lock (CLAUDE.md rule 1) is about tools that change a model. This updater changes data,
never geometry, in live project models. It does so only because the BIM Manager switched it on for that project, and
only in the fields above. That's the owner's decision of 15 Oct. The kit's Manual and rulebook should record it (kit
change request).

The updater is registered as **optional**. Someone opening the model without the add-in gets no warning; their changes
just aren't filled.

## The log
Every value filled is appended to `%APPDATA%\Formcraft\FMC_LiveData_Log.csv`:

```
timestamp,model,element_id,field,old,new
2026-10-15T09:05:00,F26001-FMC-ZZ-ZZ-M3-E-0001,123456,FMC_Keynote_Code,,E.SOC_01
```

Switching on or off is logged as field `Keep FMC data filled` on the Project Information element. The log holds models,
elements and values, never who made a change (Manual 14.5, CLAUDE.md rule 9). Settings › Manage shows how many values
were filled in this Revit session.

## Open points
- The kit should confirm that `FMC_Code_Group`, `FMC_Panel_ID`, `FMC_Circuit_Ref` and `FMC_Data_Sync_Stamp` exist in
  `FMC_SharedParameters.txt` and which categories they're bound to. A missing one is simply never written. Add any that
  are missing through a kit change request (rule 7).
- `FMC_Code_Group` comes only from `FMC_Master_Data.json` "codes". If the kit means the keynote file's parent instead,
  that's a one-line change.
- A read-only `fmc_live_data status` for Claude, through the MCP server, isn't built. The pane shows the state.
