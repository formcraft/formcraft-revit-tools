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

## 18 Oct 2026: the engineering hub and the family LOD ladder (owner)
- One Formcraft MCP server for Revit, Navisworks, Robot, Rhino and Power BI that makes them work together as one
  application, with AI as the operator and the kit and rules in charge (docs/PLAN_ENGINEERING_HUB.md).
- Scripts first, AI second: repeatable work runs as saved flows from a button or a schedule, without AI; tables move
  between Excel and the kit by script.
- Every product is one family carrying all three LODs: LOD 200 on Coarse, LOD 300 on Medium, LOD 400 on Fine, with the
  LOD 400 parts modelled in Rhino through the hub.
