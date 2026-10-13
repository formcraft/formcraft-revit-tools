# Resources

| Folder | What | Used by |
|---|---|---|
| `icons/` | Line icons as SVG, 24 px grid, 2 px navy stroke. `pane-*` for pane sections, `ribbon-*` for ribbon buttons | Shell, plugin |
| `icons/png/` | Ribbon icons at 16 and 32 px (Revit ribbon needs bitmaps) | Plugin ribbon |
| `fonts/` | IBM Plex Sans and Mono (SIL Open Font Licence, `OFL.txt`) | Shell theme |
| `brand/` | Pointer to the Formcraft brand files | Splash, about |

Rules: no logo on ribbon buttons (below its minimum size); icons stay single-colour line icons; add a new icon as SVG
first, then export the PNG sizes (`design/generators` has the paths; any SVG-to-PNG tool works).
