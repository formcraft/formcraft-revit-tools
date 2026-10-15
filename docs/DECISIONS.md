# Decisions

| ID | Decision | State |
|---|---|---|
| D1 | "Claude in shared models" is the user's toggle, default off; it opens Setup tools only | Decided |
| D2 | Retire the Dynamo and pyRevit scripts as each tool is proven, or keep them as a fallback | Open: keep them until decided |
| D3 | Naming rules for views and levels | Views and filters covered by Manual 4.6; levels open |
| D4 | Project families named `[Project]_[Role]_[CategoryToken]_[Description].rfa`, saved in `01_WIP\<Role>\Families\` | Decided |
| D5 | Project folder: the user creates it; the tree is built inside | Decided |
| D6 | Licence service behind sign-in, seats and trials (a licensing service, or Autodesk App Store entitlement if sold there) | Open: shell uses a mock until decided |
| D7 | Payment provider for the account website (card, mobile money, bank transfer) | Open |
| D8 | Delivery gate names (DG1–DG3 proposed) so they don't clash with geometry stages G1–G5 | Open |
| D9 | Theme or design movement: `FMC_Design_Movement` (Integer 1–20, global parameter *Design Movement*) is the one style switch; `FMC_Theme` is retired (deprecated in the kit, kept in the file) | Decided (owner, 15 Oct) |
