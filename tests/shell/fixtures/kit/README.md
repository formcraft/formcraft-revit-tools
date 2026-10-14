# Sample kit (tests only)

The smallest folder the pane's kit check accepts: `FMC_Kit.json`, `01_Shared_Parameters/FMC_SharedParameters.txt`
and the two `_Staging` write folders. **This is not the Formcraft kit** and holds no kit data; the real kit is
`Z:\00_Standards`. The shell tests and the preview app use it so first-run setup can be tried on a PC without the kit.

`FMC_Kit.json` (kit and rulebook versions) is the U05 decision for where the kit check reads versions from. If the real
kit keeps them elsewhere, that is a kit change request or a change to `FolderKitService`.

`06_Templates` holds empty placeholder `.rte` files (two released, one in `_Staging`) and a sample `FMC_BrandPacks.json`,
so Setup › Templates can list a library, pick a brand pack and run its flows against the mock tools. They are not
templates; Revit can't open them.
