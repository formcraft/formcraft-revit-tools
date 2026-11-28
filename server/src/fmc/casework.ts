/**
 * Casework Assistant engine (Engineer › Casework, +Model; boards CW_Overview, CW_Pane, CW_Outputs). Pure: no Revit.
 *
 *   run (walls, openings, fixed sink and appliances, modules) → units → panels → cut list → sheet nesting
 *   → edge banding → hardware → worktop → cost from the kit's material library → workshop pack files.
 *
 * Every dimension is a design input (the workshop's standards) and every board is a kit material: nothing here has a
 * default size, board or price (CLAUDE.md rules 5 and 7). The reference maths is the example kitchen on the boards
 * (cw_kitchen.py): 12 units, 120 pieces, 15 sheets, 98.5 m of edge banding, 4.8 m of worktop, 28 hinges.
 */
//
// Split for the hub's 300-line rule; this file keeps every name in one place for the callers:
//   casework_standards.ts  standards     casework_layout.ts  units from a run
//   casework_parts.ts      panels, nesting, cut list, hardware     casework_cost.ts  prices, totals, pack files

export * from "./casework_standards.js";
export * from "./casework_layout.js";
export * from "./casework_fitted.js";
export * from "./casework_parts.js";
export * from "./casework_cost.js";
