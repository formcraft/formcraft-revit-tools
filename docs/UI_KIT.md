# UI kit

The single source in code is `shell/Formcraft.Shell/Theme/`: colours in `FmcColors.Light.xaml` and
`FmcColors.Dark.xaml` (same keys), sizes and every control style in `FmcTheme.xaml`. The "Build-ready UI kit" board on
the central canvas shows the same light values. Views never hard-code a colour: they read the keys below with
`DynamicResource`, so the theme can switch while the pane is open.

## Theme follows Revit

`Services/ThemeService` holds the theme. The Theme setting (Settings › General, U06) is **Follow Revit** (default),
**Light** or **Dark**. The add-in reports Revit's UI theme (`UIThemeManager.CurrentTheme`) at start-up and on every
`UIApplication.ThemeChanged`, through `ThemeService.SetHostTheme`, so the pane switches with Revit at once, with no restart
(wired in U10). Revit 2020–2023 have no dark theme, so there the pane stays light. Outside Revit (preview app), Follow
Revit uses the Windows app theme. The preview app's "Revit theme" switch stands in for Revit's setting.

Dark values sit with Revit 2025's own dark panels (Properties, Project Browser) rather than a navy page; brand colours
stay as accents. They are checked side by side with the real panels in U10 and adjusted there if needed.

## Colours

| Token | Light | Dark | Use |
|---|---|---|---|
| Navy | `#1B2532` | `#1B2532` | Brand navy: AI tag text, logo |
| Orange | `#FFAE61` | `#FFAE61` | Brand line under the header, AI tag |
| Primary / OnPrimary | `#1B2532` / `#FFFFFF` | `#4A6B96` / `#FFFFFF` | Primary buttons, selected section, switch on |
| TagOnPrimary | `#33465C` | `#3D5A80` | Module tag on a selected section button |
| Accent | `#1B2532` | `#9DBBE3` | Selected group underline, focus ring, active borders |
| Ink / Muted | `#1A1D21` / `#5B6270` | `#F1F3F5` / `#B9C0CB` | Body text / secondary text, hints |
| Tab / SectionInk | `#4A515C` / `#3B424D` | `#C7CDD6` / `#DDE1E6` | Group tab text / section button text |
| Surface / Field | `#FFFFFF` / `#FFFFFF` | `#3B4453` / `#2C333F` | Pane body, cards / inputs |
| Header / Footer | `#F1F3F5` / `#F8F9FA` | `#313845` / `#353C49` | Pane header, table head, read-only / footer |
| Line / Divider | `#C9CED6` / `#E3E6EA` | `#5A6477` / `#4A5363` | Borders, inputs / rules between rows |
| Hover / Selected | `#EEF1F5` / `#E3E9F2` | `#434C5D` / `#4A5A73` | Hover, pressed / selected row |
| Track / ToggleOff | `#EEF0F3` / `#6B7280` | `#2C333F` / `#7A8494` | Segmented track / switch off |
| Scrim, Shadow, Backdrop | | | Dialog overlay, dialog shadow, behind the pane (preview) |
| Module accents | Flow `#7FC7BE`, Model `#6FA8FF`, Build `#E8C27A` | same | |
| States | Good `#1E8E3E`, Warning `#E0A100`, Critical `#D93025` | `#5CC27A`, `#F0B930`, `#F89C93` | |
| Chips (bg / fg) | Good `#E6F4EA`/`#1E6B34` · Warn `#FFF4E0`/`#6B4100` · Bad `#FDECEA`/`#A50E0E` · Info `#E3F2EF`/`#2C6B63` · Grey `#EEF0F3`/`#4A515C` | Good `#203B2A`/`#A6E3B6` · Warn `#3F3214`/`#F6D58A` · Bad `#4A2323`/`#F8B4AD` · Info `#1C3D39`/`#A5DDD4` · Grey `#4E5869`/`#E1E5EA` | |

Each colour `Fmc.X` has a brush `Fmc.XBrush`; chips are `Fmc.Chip.{Good,Warn,Bad,Info,Grey}{Bg,Fg}`. Every text pair is
at least 4.5:1 in both themes and the focus ring at least 3:1 (`tests/shell` checks it).

## Type, sizes and shape

| Token | Value |
|---|---|
| Font | IBM Plex Sans, embedded in `Formcraft.Shell.dll` from `resources/fonts` (Segoe UI fallback); IBM Plex Mono for paths and codes (Consolas fallback) |
| Sizes | 13 header · 12.5 body · 11.5 controls · 10.5 hints (`Fmc.Size.*`) |
| Spacing | 4 · 6 · 8 · 10 · 16 |
| Radius | 3 buttons · 4 inputs · 5 nav · 8 pane and dialogs (`Fmc.Radius.*`) |
| Pane width | 320 to 560 px; compact layout below 400 px |
| Targets | 26 px in the pane; 44 px when Touch is on |

## Styles

| Style | Target | States |
|---|---|---|
| `FmcButton.Primary`, `FmcButton.Secondary` | Button | rest, hover, pressed, disabled, busy (`c:Fmc.Busy`) |
| `FmcButton.Ai` | Button | as secondary, with the AI tag; needs key (`c:Fmc.NeedsKey`) |
| `FmcButton.Icon` | Button | icon only (close, help); label with `AutomationProperties.Name` |
| `FmcToggle` | CheckBox | on, off, locked (`c:Fmc.Locked`, padlock), disabled |
| `FmcSegmented` | ListBox | one selected |
| `FmcChip.Good` / `.Warn` / `.Bad` / `.Info` / `.Grey` | ContentControl | |
| `FmcCheckRow` | `c:FmcCheckRow` | ticked, not ticked, status chip (`Status`, `StatusKind`) |
| `FmcTextBox` | TextBox | empty (`c:Fmc.Placeholder`), filled, invalid (`c:Fmc.Invalid`), read-only, disabled |
| `FmcReadOnly` | TextBox | read-only value in Plex Mono, selectable |
| `FmcPasswordBox` | PasswordBox | as `FmcTextBox` |
| `FmcTable` | DataGrid | head row, hover, selected row, keyboard focus |
| `FmcDocBanner` | `c:FmcDocBanner` | `State`: Setup (green), Shared (amber), Live (red) |
| `FmcDialog` | `c:FmcDialog` | over the pane; Esc and the close button close it; focus moves in |
| `FmcNav.Group`, `FmcNav.Section` | RadioButton | rest, hover, selected |
| `FmcText.GroupTitle` / `.Body` / `.Hint`, `FmcGroup` | TextBlock, Border | |
| `Fmc.FocusVisual` | all | keyboard focus ring, on every control |
| `FmcToggleButton` | ToggleButton | header Settings and Admin: pressed while that page is open |
| `FmcStatusChip` | ToggleButton | the header's round Connected chip |
| `FmcButton.Pill` | Button | quick tools (Touch, Section Box, Tag Tidy) |
| `FmcTag` | ContentControl | small tag: module tags (`+Flow`, `+Model`, `+Build`), the quick tools' "Flow" |
| `FmcSearchBox` | TextBox | magnifier, placeholder ("Find…" when compact) |
| `Fmc.HideWhenCompact` | any | hidden below 400 px |
| `FmcChipToggle` | ToggleButton | round on/off chip ("Show these parts"), navy when on |

Controls (namespace `c:`): `FmcIcon` (a line icon from `Theme/FmcIcons.xaml` by `IconKey`, in the current Foreground),
`FmcStateButton` (shows a state from its binding, a click only runs Command: tabs, sections, header pages),
`FlexRow` (equal shares that never go below what a child needs, like the boards' `flex: 1`).
`c:Fmc.Compact` is set on the pane below 400 px and inherited, so any style can switch with a plain trigger.
Icons: `Theme/FmcIcons.xaml` holds the path data of `resources/icons/pane-*.svg`; tests keep the two the same.

`c:` is `clr-namespace:Formcraft.Shell.Controls;assembly=Formcraft.Shell`. Scroll bars inside the pane are styled
implicitly. Still to add when a step needs them: a drop-down (`FmcComboBox`, U05) and Touch sizes (U22).

## Seeing it

`dotnet run --project shell/Formcraft.Shell.Preview`, then **Kit gallery**: every style in every state, with the
Revit theme, pane theme and pane width (440 / 360 px) switches. `-- --snapshot <folder>` saves the gallery and the pane,
light and dark, as PNGs; CI uploads them as the `kit-snapshots` artifact.
