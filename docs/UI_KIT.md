# UI kit

The single source in code is `shell/Formcraft.Shell/Theme/FmcTheme.xaml`. The "Build-ready UI kit" board on the central
canvas shows the same values.

| Token | Value |
|---|---|
| Navy | `#1B2532`: primary, active, selected |
| Orange | `#FFAE61`: brand line under the header, AI tag |
| Ink / Muted | `#1A1D21` / `#5B6270` |
| Line / Header / Footer | `#C9CED6` / `#F1F3F5` / `#F8F9FA` |
| Module accents | Flow `#7FC7BE`, Model `#6FA8FF`, Build `#E8C27A` |
| States | Good `#1E8E3E`, Warning `#E0A100`, Critical `#D93025`; chips use the paired light backgrounds |
| Font | IBM Plex Sans (Segoe UI fallback); IBM Plex Mono for paths and codes |
| Sizes | 13 header · 12.5 body · 11.5 controls · 10.5 hints |
| Spacing | 4 · 6 · 8 · 10 · 16 |
| Radius | 3 buttons · 4 inputs · 5 nav · 8 pane and dialogs |
| Pane width | 320 to 560 px; compact layout below 400 px |
| Targets | 26 px in the pane; 44 px when Touch is on |

Styles: `FmcButton.Primary`, `FmcButton.Secondary`, `FmcNav.Group`, `FmcNav.Section`, `FmcTextBox`, `FmcText.*`, `FmcGroup`.
To add: `FmcToggle`, `FmcSegmented`, `FmcChip.{State}`, `FmcDocBanner`, dialogs.
