# fmc_visibility: why is this element (not) visible in this view

`fmc_visibility` explains, for each element id you give, whether the element is visible in one view and why. It is
read only: no transaction, nothing is hidden, unhidden, isolated, overridden or saved. The suggested fixes are text
only and are never applied.

## Call

| field | |
|---|---|
| `element_ids` | 1 to 50 element ids (required) |
| `view_id` | the view; omit for the active view of the document on screen (the document must be the active one) |
| `document` | title or full path; omit for the active document. It is never opened in the background for this tool |
| `link_instance_id` | the Revit link instance in the host, when the element ids are ids inside that link |

A view template, schedule, sheet or browser is refused (`FMC-VIS-VIEW`): it displays no elements.

## Reply

Per element: `visible` (`yes`, `no`, `unknown`), `reasons`, `passed`, `not_applicable`, `unknown_checks`,
`suggested_fixes`, `explanation` (plain text). The summary counts yes / no / unknown.

- `visible` is **no** when any reason has status `hides`; **unknown** when none hides but one is `likely` or `unknown`;
  otherwise **yes**. The server recomputes it from the reasons, so a reply can't say yes while a reason hides.
- Reason status: `hides` (alone hides it), `likely` (best effort, probably hides it), `unknown` (could not be decided,
  with the reason), `info` (context, for example the view template, that changes the fix).
- Each reason has `check`, `reason`, `evidence` (filter name, workset name, phase names, offsets in mm) and `fix`.
- A check that does not apply to the element or view is listed in `not_applicable` with why. A check that throws is
  reported as `unknown` with the error. Nothing is skipped silently.

## The checks, in the order they are reported

| check | what it looks at |
|---|---|
| `element_hidden` | `Element.IsHidden(view)`, `CanBeHidden(view)` |
| `temporary_hide` | Temporary Hide/Isolate on the view and whether the element is among the visible ones |
| `category` | the category (and its parents) hidden in the view's Visibility/Graphics; `Category.Visible(view)` |
| `subcategory` | the subcategory the element is drawn in (lines), and hidden subcategories of its category (partial) |
| `filter` | each view filter that the element passes: visibility off (`hides`), 100% transparency (`likely`) |
| `view_template` | the template, which settings it controls; the fix of V/G reasons then names the template |
| `workset` | the view's setting for the element's workset, or the workset's default visibility |
| `design_option` | the element's design option against the view's option setting and the active option |
| `phase` | created / demolished phase, the view's phase and phase filter, as Revit's phase status presentation |
| `crop_region` | the element's box against the crop box (and a note if the crop has a custom shape) |
| `view_range` | plan views: the box against the top clip and the lower of bottom clip and view depth |
| `section_box` | 3D views: the box against the section box |
| `far_clip` | section, elevation and detail views: the box against the far clip depth |
| `detail_level` | no geometry at the view's detail level but geometry at another (best effort) |
| `link` | link instance hidden, Revit Links category, link workset, link display settings (By Host / By Linked View / Custom) |
| `owner_view` | a view-specific element owned by another view |
| `discipline` | the view's discipline (context only; the API does not give an element's discipline) |
| `underlay` | the element's level is the plan's underlay (shown faded only) |
| `revit_verdict` | Revit's own view collector for the view, and `IsHidden` / `CanBeHidden` |

Limits: for an element inside a link the filter, workset, design option, phase and detail-level checks are
reported `unknown` (they are evaluated per link instance in Revit), not guessed. The view collector does not apply the
crop, view range, section box or far clip, so `revit_verdict` can say "returned" while one of those hides the element
(it then adds an `info` line).

Example: `element_ids: ["1234567"]`, `view_id: "89012"`.
