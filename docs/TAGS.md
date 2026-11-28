# Door, window and room tags (`fmc_tags`)

`fmc_tags` tags every untagged door, window and room on floor plans that are placed on issued sheets. A sheet is issued when one of its revisions is issued, or when Sheet Issue Date is filled. `views` is `all_sheets` or a list of sheet numbers, sheet names or plan names. `categories` defaults to Doors, Windows and Rooms. `tag_types` names a loaded type per category. Empty, or `first`, uses the first loaded tag type of that category, sorted by name.

Leaders are off. A new tag that would sit on an existing tag box is shifted through a short list of offsets. If every offset overlaps, the element is `FMC-TAGS-OVERLAP` and is not tagged. An element that already has an `IndependentTag` or a `RoomTag` in that view is `FMC-TAGS-ALREADY`. The match includes a link instance id.

`dry_run` defaults to true and returns the point per element. It does not create a tag. A real write is `fmc_tags_apply`, one transaction, one subtransaction per tag. It needs `batch_lease` plus `references.kit`, `references.standards` and `references.rulebook`. The answer lists the placed tag ids per view. The full JSON is under `%LOCALAPPDATA%\Formcraft\tags`. There are no pictures.

## Issued Level 1

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "views": "all_sheets",
  "categories": ["Doors", "Windows", "Rooms"],
  "dry_run": true
}
```

## Why a similar script returned tags 0

A `send_code` script that counts `IndependentTag.Create` successes can return 0 while untagged doors are visible on the sheet. The causes, and what this tool does instead:

- `FilteredElementCollector(document, view)` does not return elements that live in a link. Doors and windows in a loaded link are collected from the link document, transformed into the host, and tagged with `Reference.CreateLinkReference`. A room in a link uses `NewRoomTag(new LinkElementId(linkInstanceId, roomId), uv, viewId)`.
- Model doors, windows and rooms have `OwnerViewId` equal to `InvalidElementId`. A filter `OwnerViewId == view` returns 0. This tool uses the view collector for host elements and does not filter model elements by owner view. The tag, not the door, is view-owned.
- The view on screen is often the sheet. Doors are not elements of the sheet. This tool tags the floor plan the viewport shows. A section, a 3D view or the sheet itself is `FMC-TAGS-NOT-PLAN`.
- `IndependentTag.Create` does not tag a room. Rooms use `Document.Create.NewRoomTag`. A script that only calls `IndependentTag.Create`, and swallows the exception, counts 0.
- `new Reference(element)` is refused when the element belongs to a link document. The host needs `CreateLinkReference`.

A linked room tag is matched back by room number and the nearest tag head within 2 m. A phase filter inside a link is not rebuilt: an element outside the view crop, in a hidden link, or in a hidden category is left out, and the reply says so in `diagnosis`.

## API limits

- Revit will not tag an unplaced or unenclosed room (`FMC-TAGS-UNPLACED`).
- A category with no loaded tag type is `FMC-TAGS-NO-TYPE`. The category overload of `IndependentTag.Create` is tried for doors and windows when a type id did not resolve.
- `GetTaggedElementIds` supplies the link id. `GetTaggedLocalElementIds` does not, which is another way a script tags the same linked door forever, or tags none.
- The model is not saved or synchronised.

## Tagging upgrades (bulk, overlap, scale, audit)

- **Bulk.** `views` takes many sheets and plans in one call: sheet numbers, sheet names, plan names or ids, mixed. `scope` picks which plans qualify: `issued_sheets` (default, the rule above), `any_sheet` (every floor plan on a sheet, issued or not), `any_plan` (every floor plan). `max_views` caps one call (default 200); views past it are `FMC-TAGS-TOO-MANY-VIEWS`, never dropped silently.
- **Overlap.** The tag box is the kit's paper size (`paper_box_mm`, else 9 x 4.5 mm) times the view scale. Candidate shifts grow with the scale. A spot is free when it overlaps no existing tag, no tag placed earlier in the call, no text note, and no other door or window box (`avoid_elements`, default true), and stays inside the active crop. Each placement says `moved` and `offset_mm`. No free spot is `FMC-TAGS-OVERLAP`, or `FMC-TAGS-OUT-OF-CROP` when the crop is the only reason.
- **Tag type by scale.** With no `tag_types` for a category, the kit file `03_Master_Data\FMC_TagScale.json` picks the tag type by view scale (`scale_rules_file` or `FMC_TAG_SCALE_FILE` names another file). A kit type that is not loaded is `FMC-TAGS-KIT-TYPE-MISSING`: there is no fallback to another type. With no file the first loaded type is used and the reply says `scale_rules.source: none`, which is a kit change request. There is no built-in table (rule 7). Each placement says `type_source`: `argument`, `kit_scale` or `first`.
- **Audit.** `mode: "audit"` is read only. Per view it lists `missing` (elements in scope with no tag, `FMC-TAGS-MISSING`), `blank` (tags whose text is empty or `?`, `FMC-TAGS-BLANK`: the Mark, Type Mark, Number or Name is empty) and `unplaced_rooms`. Values are never invented.
- **Preview.** `mode: "plan"` returns what would be tagged and never writes the model or a report, even with `dry_run: false`. `mode: "tag"` with `dry_run` true (default) is the dry run; `dry_run: false` applies.
- **Per item.** Every element in scope has one row in `items` (`planned` or `skipped` with a code; an element listed twice is `FMC-TAGS-DUPLICATE`). After a write `results` has one row per planned tag: `placed` with its tag id, `failed` with a code, or `unknown` when the add-in did not report it. The apply re-reads the view's tags and refuses a second tag on an element tagged since the dry run (`FMC-TAGS-ALREADY`).

`FMC_TagScale.json` (kit data; this example is not shipped):

```json
{
  "schema": "fmc-tag-scale/0.1",
  "status": "PROVISIONAL",
  "rules": [
    { "category": "Rooms", "max_scale": 100, "tag_type": "FMC_TAG_A_Room: With Area" },
    { "category": "Rooms", "min_scale": 101, "tag_type": "FMC_TAG_A_Room: Name+Number" },
    { "category": "Doors", "tag_type": "FMC_TAG_A_Door: Standard" },
    { "category": "Windows", "tag_type": "FMC_TAG_A_Window: Standard" }
  ],
  "paper_box_mm": { "Doors": [10, 5], "Windows": [10, 5], "Rooms": [12, 8] }
}
```

Rules are read in order; the first rule for the category whose `min_scale`/`max_scale` (inclusive, the scale denominator) cover the view wins.
