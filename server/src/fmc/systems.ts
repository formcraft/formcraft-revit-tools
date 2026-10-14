/**
 * Engineer › Systems and Structural (U25, boards model/PaneModelSystems and PaneModelStructural): read-only checks on
 * the facts the add-in reads. Formcraft prepares and checks; sizing, load cases and design stay with the engineer
 * (CLAUDE.md rule 5): nothing here changes a member, a circuit or a board.
 */
export type State = "Pass" | "Warn" | "Fail" | "Engineer" | "Info";
export interface Check { check: string; found: string; state: State; ids: number[] }

/** Structural fields the check looks for, by kit name; only those the kit has are checked (rule 7). */
export const STRUCTURAL_FIELDS: Array<{ name: string; material: string }> = [
  { name: "FMC_Member_Mark", material: "" },
  { name: "FMC_Concrete_Grade", material: "Concrete" },
  { name: "FMC_Exposure_Class", material: "Concrete" },
  { name: "FMC_Steel_Grade", material: "Steel" },
  { name: "FMC_Timber_Grade", material: "Timber" },
];

export function structuralFields(kit: Record<string, { categories: string[] }>) {
  const known = STRUCTURAL_FIELDS.filter((f) => kit[f.name]);
  return {
    fields: known.map((f) => ({ ...f, categories: kit[f.name].categories.filter((c) => /Structural(Columns|Framing|Foundation)/.test(c)) })),
    not_in_kit: STRUCTURAL_FIELDS.filter((f) => !kit[f.name]).map((f) => f.name),
  };
}

const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);

export function structuralChecks(f: any): Check[] {
  const out: Check[] = [];
  const n = (k: string) => Number(f?.[k] ?? 0);
  out.push({ check: "Columns and beams without an analytical member", found: String(n("no_analytical_count")), state: n("no_analytical_count") ? "Warn" : "Pass", ids: ids(f?.no_analytical) });
  out.push({ check: "Physical and analytical out by more than 50 mm", found: String(n("offset_count")), state: n("offset_count") ? "Warn" : "Pass", ids: ids(f?.offset_over_50mm) });
  out.push(f?.free_ends_checked === false
    ? { check: "Members not joined at nodes", found: "Not checked", state: "Info", ids: [] }
    : { check: "Members not joined at nodes", found: String(n("free_end_count")), state: n("free_end_count") ? "Warn" : "Pass", ids: ids(f?.free_ends) });
  out.push({ check: "Columns with no footing, beam, slab or wall below", found: String(n("nothing_below_count")), state: n("nothing_below_count") ? "Fail" : "Pass", ids: ids(f?.nothing_below) });
  for (const x of (f?.fields ?? []) as any[]) {
    if (!x.applies) continue;
    if (!x.in_model) out.push({ check: `${x.name} not loaded in this model`, found: String(x.applies), state: "Warn", ids: [] });
    else out.push({ check: `Members missing ${x.name}`, found: String(x.missing), state: x.missing ? "Warn" : "Pass", ids: ids(x.ids) });
  }
  const cases = n("load_cases"), combos = n("load_combinations");
  out.push({ check: "Load cases and combinations", found: cases ? `${cases} cases, ${combos} combinations` : "None yet", state: "Engineer", ids: [] });
  return out;
}

export function electricalChecks(f: any): { boards: any[]; checks: Check[] } {
  const boards = ((f?.boards ?? []) as any[]).map((b) => ({
    ...b,
    check: (b.circuits ?? 0) === 0 ? "Warn" : "Pass",
    note: (b.circuits ?? 0) === 0 ? "No circuits on this board" : !b.fed_by ? "Fed by no other board (the main board?)" : "",
  }));
  const checks: Check[] = [];
  const unfed = boards.filter((b) => !b.fed_by);
  checks.push({ check: "Boards fed by no other board", found: String(unfed.length), state: unfed.length > 1 ? "Warn" : unfed.length === 1 ? "Info" : "Pass", ids: unfed.map((b) => b.id) });
  checks.push({ check: "Boards with no circuits", found: String(boards.filter((b) => b.check === "Warn").length), state: boards.some((b) => b.check === "Warn") ? "Warn" : "Pass",
    ids: boards.filter((b) => b.check === "Warn").map((b) => b.id) });
  for (const [cat, v] of Object.entries((f?.devices ?? {}) as Record<string, any>))
    checks.push({ check: `${cat.replace(/([a-z])([A-Z])/g, "$1 $2")} on no circuit`, found: `${v.on_no_circuit} of ${v.with_power_connector}`, state: v.on_no_circuit ? "Warn" : "Pass", ids: [] });
  checks.push({ check: "Circuits on no board", found: String(f?.circuits_without_board ?? 0), state: f?.circuits_without_board ? "Warn" : "Pass", ids: [] });
  return { boards, checks };
}

/** The saved list for the engineer (Markdown), from the same checks. */
export function systemsReport(kind: "electrical" | "structural", model: string, checks: Check[], extra: string[], now: Date): string {
  const lines = [`# ${kind === "electrical" ? "Electrical" : "Structural"} check · ${model}`, "", `${now.toISOString().slice(0, 16).replace("T", " ")} · read-only, nothing was changed`, "",
    "| Check | Found | Result |", "|---|---|---|", ...checks.map((c) => `| ${c.check} | ${c.found} | ${c.state} |`), ""];
  if (extra.length) lines.push(...extra, "");
  lines.push(kind === "structural"
    ? "Formcraft reports these; the engineer fixes or accepts them. Sizes, load cases and design are the engineer's decision."
    : "Formcraft reports these; sizing and design are the engineer's decision.");
  return lines.join("\n");
}
