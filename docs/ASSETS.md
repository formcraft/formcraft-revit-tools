# fmc_assets: COBie-style asset register (read only)

Source: gap-analysis proposal 20 (Emlyn's 13:35 call, built locally). A register with COBie 2.4 sheet and column names,
not a certified COBie deliverable.

## Sheets
| sheet | from | key columns |
|---|---|---|
| Facility | Project Information | Name (building, else project), ProjectName, SiteName, LinearUnits millimeters, AreaUnits squaremeters |
| Space | placed rooms and MEP spaces | Name (number), Category (Room / MEP Space), FloorName, Description (name), GrossArea m2, Department |
| Type | element types in use by the components | Name "Family: Type", Category (OmniClass, else OST_), Manufacturer, ModelNumber, AssemblyCode, OmniClass, TypeMark, Count |
| Component | family instances of the asset categories (nested parts left out) | Name (Mark, else "Type-id"), TypeName, Space (room, else MEP space, last phase), SerialNumber, InstallationDate, TagNumber, FloorName |
| System | MEP systems | Name, Category (classification), ComponentNames (members in the register) |

## Safety
- `fmc_assets_read` has no transaction, saves nothing, syncs nothing (READ_VIA_SEND_COMMAND).
- No file is written. Existing read tools return data inline, so this one does too: `format rows` or `format csv`, at most
  `max_rows` rows per sheet (counts are always whole, `rows_cut` says which sheets were cut).
- Family documents are refused. Status PROVISIONAL, GAPS or READY; `can_pass` is always false (a person accepts it).

## Kit file (not in the kit yet)
`03_Master_Data/FMC_Assets.json`: `categories` (OST_ names), `required_type_fields`, `required_component_fields`,
`component_parameters` and `type_parameters` (Revit parameter names for SerialNumber, InstallationDate,
WarrantyStartDate, BarCode, WarrantyDurationParts, ExpectedLife). Without it the built-in sample is used: PROVISIONAL.

## Open items
- Kit spec does not exist: PROVISIONAL.
- Parameter names (Serial Number, Installation Date, Warranty...) are guesses until the kit names them; built-in fields
  (Manufacturer, Model, Description, Type Mark, Assembly Code, OmniClass) are read by BuiltInParameter, language-proof.
- Zone, Floor, Contact, Attribute, Document and Job sheets: not built.
- Live check (Revit Testing Bot): a small MEP sample model; counts against Revit schedules; a component in a room and one
  outside; an MEP system's ComponentNames.
