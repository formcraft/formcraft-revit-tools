# One engineering hub: Formcraft's own MCP server for every app

**Status:** plan, for the owner's yes (18 Oct 2026). The owner asked for one professional MCP server that connects
Revit, Navisworks, Robot Structural Analysis, Rhino and Power BI. It replaces track RH, which was going to use
McNeel's Rhino MCP.

## The idea
Formcraft has **one MCP server**, and it reaches every engineering application through a **connector** per app. Every
app gets the same treatment:

- **one set of rules:** the live-model lock, writes only to staging and WIP, a dry run first, kit data only, the AI
  involvement policy, nothing ranks people;
- **one job system:** heartbeats, the queue, keep-awake, results the app keeps itself (#175, #176);
- **one log, one self-test, one list of apps** (`fmc_apps`);
- **work that crosses apps in one conversation:** a Rhino facade checked against the Revit model, a frame sent to
  Robot, Navisworks clashes traced back to Revit elements, project data out to Power BI.

Connectors expose **named operations**, never "run any code" (the open-source servers for Rhino and Blender do run
arbitrary scripts; our Revit `send_code` stays the one exception, behind the AI policy).

## The apps on the pilot PC (18 Oct)
| App | Installed | Connector today | Kind |
|---|---|---|---|
| Revit 2025 | Yes | Add-in with a local socket, one per Revit (8080–8089) | Add-in bridge |
| Navisworks Manage 2025 | Yes | Add-in with a local socket (8190) and a pane, read-only (#94) | Add-in bridge |
| Robot Structural Analysis 2025 | Yes | `fmc-robot.exe`, started per call (#93) | Process |
| **Rhino 8** | **Yes** (licence state to confirm) | None yet | Add-in bridge (RhinoCommon plug-in) |
| **Power BI Desktop** | **Yes** | None yet | **Gateway** to Microsoft's Power BI Modeling MCP server, plus Formcraft's data |

## Three kinds of connector, one contract
1. **Add-in bridge:** a plug-in inside the app listens on `127.0.0.1` only and writes
   `%APPDATA%\Formcraft\apps\<app>.json` (port, process id, app version, connector version, started). Revit,
   Navisworks, Rhino.
2. **Process:** a program the server starts per call, JSON in and out. Robot (later build123d).
3. **Gateway:** the hub starts another vendor's MCP server as a child and passes on only the operations Formcraft
   allows, through the same policy and log. Power BI: Microsoft's Modeling MCP server (official, preview, local) edits a
   semantic model's tables, measures and relationships; it doesn't edit report pages or visuals. Formcraft doesn't
   rebuild what the vendor already maintains.

Every connector answers **`status`** (installed, running, versions, health) and **`describe`** (its operations).
Long operations use the shared job system. No connector writes outside staging and WIP, or into a live model.

## A professional server: what that means here
- **Discovery:** `fmc_apps` lists each app (installed, running, connector version, health, which tools it brings) and
  `fmc_selftest` reports the same. Every connector reports its version, and a mismatch with the server is named.
- **Tokens:** each app's tools load only when the app is switched on (Settings › Apps, saved per PC; the existing
  `FMC_TOOL_PROFILE` still works), so a person who never uses Rhino never pays for its tool descriptions.
- **Isolation:** each connector runs outside the server (in its app, or as its own process), so one app crashing or
  hanging never takes down the others. Calls to one app queue; calls to two apps run side by side.
- **Errors:** stable codes per connector (`FMC-<APP>-…`), in English, saying what to do.
- **Security:** connectors listen on `127.0.0.1` only. A gateway passes on only an allow-list of the vendor's tools.
- **Tests:** each connector has a stand-in for CI (as the e2e harness has a stand-in Revit), so CI never needs the apps.
- **Install:** connectors build where the app is installed and travel with the build (as Robot and Navisworks do now).

## Steps (one PR each, the owner's yes before each)
| # | Step | Delivers |
|---|---|---|
| H0 | **The hub's foundation** | The connector contract; `apps\<app>.json`; `fmc_apps` (list, status, switch on/off); per-app tool loading; Revit, Navisworks and Robot reporting through it; Rhino and Power BI detected; `fmc_selftest` lines |
| H1 | **Rhino connector** | A RhinoCommon plug-in bridge and `fmc_rhino`: status, open a staging file, list layers and objects, massing and surface operations, export (3DM, IFC, SAT) to staging; read-only first |
| H2 | **Power BI gateway** | Formcraft's project data as a tidy model (QA, reviews, issues, quantities, activity counts, never per person); the hub passes allowed Modeling-MCP operations on to Microsoft's server for that model |
| H3 | **Cross-app operations** | Rhino geometry into a Revit staging project (DirectShape) or a recipe part; a Rhino or Revit frame to Robot; Navisworks clash → the Revit elements |
| H4 | **Navisworks, next steps** | Federate, clash tests from the kit's clash matrix (a kit change request), results back to Revit elements |
| H5 | **Pane: Settings › Apps** | Which apps are on, their health and versions, switched on or off by a person |
| Later | build123d (exact parts as code, free) and Blender (free) as extra connectors; Speckle for live exchange | — |

## Rules that don't change
Geometry from Rhino or any other app reaches Revit as fixed shape, only in staging. Parametric families keep coming
from the recipe engine and Gate A. Release, publish, sync, issue and sign stay with people. Power BI shows counts and
states, never a ranking of people.

## For the owner to decide
1. A yes on the hub and on **H0 first**.
2. The order after H0: **Rhino (H1)** then **Power BI (H2)** is recommended, since both are installed.
3. Rhino 8's licence on the pilot PC: licensed, or the 90-day evaluation (enough to build and test the connector).
4. Power BI: Microsoft's Modeling MCP server is in **preview**, so it may change before release; publishing to the
   Power BI service needs a Pro or Fabric licence (Desktop alone is free).
