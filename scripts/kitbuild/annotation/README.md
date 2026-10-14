# Annotation build scripts (13–14 Oct 2026, hand-run)

These built the staged annotation families in `04_Families\_Staging\<Role>` through `send_code_to_revit`. They are the
reference for phase B4 in `docs/PLAN_ASSET_BUILDER.md`.

| File | What it does |
|---|---|
| `svg2rvt.py` | Turns the research symbol SVGs into `_Build\FMC_SYM_build.txt` (lines, arcs, circles, fills; 0.35 mm per SVG unit) |
| `build_sym.cs`, `build_sym2.cs` | Build the 300 `FMC_SYM_*` generic annotations from that file, reusing one document with SaveAs per symbol (~1 s each) |
| `build_symk.cs` | The 5 kit typed symbols (`FMC_SYM_E_Socket`, `_Switch`, `_Luminaire`, `_FireAlarm`, `FMC_SYM_P_Valve`), with Show_<type> Yes/No and a `Symbol_Text` placeholder |
| `tags_spec.py` | Writes `_Build\FMC_TAG_build.txt` for the 37 tags and heads: geometry, Yes/No params, types, and `<<param;vis;width;align;size>>` label placeholders |
| `build_tags.cs` | Builds the tag and head families from that file |
| `finish_tag.cs`, `finish_label.cs` | After a person places the labels (Revit has no API to create a label): match labels to placeholders by element id order, set the `FMC_Label_<size>` type (Arial, 0.9 width), align, width, visibility, delete the placeholder, save, open the next family |
| `build_di.cs` | The SLD and plumbing detail items (`FMC_DI_E_SLD_Breaker`, `_Board`, `FMC_DI_P_Schematic`), drawn for 1:50 drafting views |

Lessons:
- **Labels can't be created through the API.**
  - The label dialog was driven on screen. Click the Create tab before the Label tool; type parameter names under ~15 characters.
  - The better route: once one label exists, `ElementTransformUtils.CopyElements` copies labels between family documents, with their shared parameters. That was proven on the title block panels and makes a seed-label library possible (phase 2).
- `FailuresProcessing` handlers that delete warnings and resolve errors stop the "can't keep elements joined" dialog from blocking a batch.
- Fills under ~0.8 mm edges fail (`ShortCurveTolerance`); use arcs, not chords, for small sectors.
- Type names can't contain ":".
