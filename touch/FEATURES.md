# Formcraft TouchKit — Feature Spec (draft)

Status: design. Decisions marked **(decided)** are agreed; everything else is a proposal to confirm.
Every behaviour choice is a user setting with a default **(decided)**, defined once in a settings schema, grouped Basic/Advanced, with presets, export/import and live apply.

**Sticky defaults (decided):** tools open with the values you last used. The "factory defaults" in this spec only apply on first use or after a reset.
- Remembered per project, falling back to your last values from any project (so a project with 4 m wall-tag spacing doesn't change another project's 6 m).
- Each tool has "Reset to factory" and "Save as preset".
- Exceptions that always start safe and are never remembered: the touch master switch and input blocking, and any option that deletes or replaces existing tags/views.

## Modules

| Module | What | Needs touch? |
|---|---|---|
| Touch Navigation | Gestures, per-view takeover badge + frame, master switch | Yes |
| **Sheet Layout** | Align / distribute viewports, schedules, legends, notes on sheets; Smart Crop | No (touch-friendly) |
| **Tag Tidy** | Align, stack and clean up tags and leaders in views | No (touch-friendly) |
| **Tag Assist** | Smart tag placement: multi-tag floors, wall tags every X m, rule sets | No |
| **Section Box Tool** | Level-aware section box from a dragged area, optional new 3D view | No (touch-friendly) |
| Review Mode | Radial menu, info cards, pen markups | Later |

Build order (proposed): Sheet Layout → Tag Tidy → Section Box Tool, in parallel with the touch probe results.

---

## 1. Sheet Layout

Illustrator-style Align panel for sheets.

**Works on:** viewports (plans, sections, 3D, legends, drafting), schedules, images, text notes. Title blocks are references only, never moved.

**Commands**
- Align: left, H-centre, right, top, V-centre, bottom
- Distribute: left edges / centres / right edges; top / centres / bottoms
- Distribute spacing: equal gaps, or a fixed gap (e.g. 10 mm)
- Match position across sheets: put matching viewports at the same spot on a set of sheets
- Stack: arrange selected items in a row or column with a gap

**Align to**
- Selection (bounds of everything selected)
- Key object (tap/click one item; it stays still, others align to it)
- Sheet drawing area (title block bounds minus margins)
- Layout grid (from settings/firm standard)

**Extents: which box defines an item's edges** (user-selectable, shown on screen)
| Extents mode | Source | Use when |
|---|---|---|
| Viewport box | `Viewport.GetBoxOutline()` | Default, matches what Revit selects |
| Crop region | View crop region transformed to sheet coordinates via view scale | Align the drawn area, ignoring annotation spill |
| Model reference | A grid intersection or chosen point projected to the sheet | Plans on different sheets must line up on grids |
| Title / label | `Viewport.GetLabelOutline()` | Aligning viewport titles |
| Schedule | `ScheduleSheetInstance` bounding box on the sheet | Schedules |

**Show extents overlay:** draws each item's active extents rectangle and the alignment reference over the sheet while the panel is open (on-screen overlay, nothing written to the model).

**Settings (defaults)**
| Setting | Default |
|---|---|
| Extents mode | Viewport box |
| Align to | Selection |
| Fixed spacing | 10 mm |
| Sheet margins (L/R/T/B) | 10 mm |
| Show extents overlay | On |
| Ignore pinned items | On |
| One undo step per command | On |

### 1b. Smart Crop (content-aware aspect ratios)

Crop a view to a preset aspect ratio while keeping all relevant content inside it.

**Steps:** measure content extents → add margin → expand (never shrink) to the chosen ratio → centre on content → optionally round the crop to tidy paper sizes.

**Ratio presets:** 1:1, 4:3, 3:2, 16:9, √2 (A-series), Match another view, Fit a sheet slot (a rectangle on a sheet; also suggests a scale), Custom.

**What counts as content** (setting):
| Source | Notes |
|---|---|
| Visible model elements (default) | Ignores levels, grids, scope boxes, reference planes |
| Chosen categories | e.g. walls + floors only |
| Rooms / areas | Crop to the occupied footprint |
| Current selection | Crop to what you selected |
| Grids extents | For structural / GA plans |

**Outlier rejection:** ignores small items far from the main mass (stray site elements, a lost family at the origin), with a sensitivity setting and a preview of what was ignored.

**Match crop across views:** give a series of plans (Level 1–5) the same crop size and position, so they also line up on sheets. This pairs with "Match position across sheets".

**Settings (defaults)**
| Setting | Default |
|---|---|
| Ratio | √2 landscape |
| Content source | Visible model elements |
| Margin (paper) | 10 mm |
| Outlier rejection | Medium |
| Round crop to paper size multiple | 5 mm |
| Annotation crop offset | 10 mm |
| Preview before applying | On |

---

## 2. Tag Tidy

Make tags in a view neat without moving the tagged elements.

**Works on:** element tags, multi-category tags, room/space/area tags, keynote tags, text notes (optional).

**Category scope (decided):** all tags eventually, for a full BIM workflow. **Start with architectural:** doors, windows, walls, floors, ceilings, roofs, rooms, areas, curtain panels, stairs/railings, furniture, casework, plumbing fixtures, generic models. Then structural, then MEP.

**Commands**
- Align heads: left, centre, right, top, middle, bottom
- Distribute heads: equal spacing along a row or column
- Stack: put tags in a column or row with a fixed gap, **sorted by host position so leaders never cross**
- Push to edge: move tags into tidy columns just outside the crop region or a chosen boundary
- Straighten leaders: make leaders horizontal/vertical, consistent elbow, or remove leaders when the tag sits on its host
- Leader on/off for the selection
- Resolve overlaps: nudge tags apart by a minimum gap

**Settings (defaults)**
| Setting | Default |
|---|---|
| Categories included | All tags in selection |
| Gap between tags | 2 mm (paper) |
| Leader style after stacking | Elbow |
| Sort stacked tags by | Host position (avoids crossings) |
| Turn leader off when tag is within | 0 mm of host (off) |
| Include text notes | Off |
| Ignore pinned tags | On |

**Notes:** Positions are in paper space (scaled by view scale) so gaps look the same at every scale. Tag extents come from the tag's bounding box in the view; text width is approximate, so gaps are a minimum, not exact.

---

## 2b. Tag Assist (smart tag placement)

Places new tags, not only tidies existing ones.

**Multi-tag large elements (floors, ceilings, roofs, areas)**
- How many: fixed count, or **1 tag per X m²**, or a placement grid every X m.
- Where: only inside the element's real outline (handles L and U shapes), inside the view crop, at least X mm from edges, away from other tags.
- One tag only: placed at the visual centre of the shape (works for odd shapes where the centroid falls outside).

**Wall tags along length**
- One tag every X m along the wall, or a fixed count per wall.
- Skip walls shorter than X m; walls that are joined in a straight run can count as one run.
- Avoid door/window openings and wall junctions; tag side (interior/exterior/left/right); offset from wall; rotate with wall.
- Works on curved walls (spaced along the arc).

**Other assists**
- Tag untagged only: tag every element of a category in the view that has no tag yet (no duplicates).
- Consistent door tags: same side relative to swing, same offset.
- Audit: list untagged elements, duplicate tags, and tags on hidden or deleted hosts.
- **Tag rule sets:** save a recipe per view type, e.g. "GA plan: doors at swing side, walls every 6 m, floors 1 per 50 m², rooms at centre". Run it on one view or many. Export/import so it can be part of a firm's BIM standard.

**Settings (defaults)**
| Setting | Default |
|---|---|
| Floor tags: rule | 1 per 50 m² (min 1, max 6) |
| Floor tags: min distance from edge | 5 mm (paper) |
| Wall tags: spacing | Every 6 m |
| Wall tags: skip walls shorter than | 1 m |
| Wall tags: treat straight joined walls as one run | On |
| Wall tags: avoid openings/junctions | On |
| Wall tags: side / offset | Exterior / 3 mm (paper) |
| Leaders for new tags | Off |
| Skip elements already tagged in this view | On |
| Tag type | Category default, overridable per rule |

---

## 3. Section Box Tool

Level-aware section box from an area dragged in a plan, with mouse or finger.

**Flow**
1. Turn on the tool (ribbon or touch badge).
2. Level comes from the active plan (or pick one).
3. Set **bottom offset** (below the level) and **top offset** (above the level, or to the next level ± offset).
4. Drag a rectangle in the plan.
5. Result:
   - apply to the target 3D view, or
   - **create a new 3D view from the selection** (named by pattern, optional view template, opens it).

**Settings (defaults)**
| Setting | Default |
|---|---|
| Bottom offset | −300 mm below level |
| Top mode | Next level |
| Top offset | +300 mm |
| Plan margin added to dragged area | 0 mm |
| Output | Create new 3D view |
| New view name pattern | `3D - {Level} - {yyyyMMdd-HHmm}` |
| View template for new views | None |
| Open new view after creating | On |
| Tile plan and 3D after creating | Off |
| Target view (if updating) | Last used 3D view |

**Notes:** Rotated plans and project vs true north are handled through the plan view's orientation, so the box matches what you dragged. Dragging uses Revit's own box pick for mouse; touch uses TouchKit's gesture layer. Live preview in a tiled 3D view while dragging is a stretch goal.

---

## Open questions
1. Smart Crop: should content measurement include linked models by default?
2. Sheet Layout: should "Match position across sheets" use a grid intersection, or the crop region centre, by default?
3. Section Box: should the plan's crop region optionally limit the box?
