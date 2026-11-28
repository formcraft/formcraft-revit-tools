/**
 * Revit .pat text for the kit's patterns (F59): one file per target (drafting or model), in mm. Each grid is a line
 * family "angle, x, y, shift, spacing" with no dashes (solid lines), which is what Revit's fill grids are.
 * Deterministic: the same designs give the same bytes, so a re-run sees "unchanged".
 */
import { PatternSpec, PatternTarget } from "./assemblies_spec.js";

const n = (v: number) => String(Math.round(v * 1e6) / 1e6);

export function patText(patterns: PatternSpec[], target: PatternTarget): string {
  const lines = [";%UNITS=MM", `;Formcraft ${target} patterns (F59, from the kit's FMC_Assemblies.json)`, ""];
  for (const p of patterns.filter((x) => x.target === target).sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`*${p.name}${p.description ? `, ${p.description.replace(/[\r\n,]+/g, " ").trim()}` : ""}`);
    lines.push(`;%TYPE=${target.toUpperCase()}`);
    for (const g of p.grids) {
      const [x, y] = g.origin ?? [0, 0];
      lines.push([g.angle, x, y, g.shift ?? 0, g.spacing].map(n).join(","));
    }
    lines.push("");
  }
  return lines.join("\r\n");
}

/** The file name for a target's patterns. */
export function patName(target: PatternTarget): string {
  return target === "drafting" ? "FMC_Patterns_Drafting.pat" : "FMC_Patterns_Model.pat";
}
