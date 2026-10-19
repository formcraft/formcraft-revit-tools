/**
 * Changes flow (docs/PLAN_ENGINEERING_HUB.md, X2): a change in one app flags what it affects in the others, as a dry-run
 * update. Nothing here changes anything: each flag says what changed, what it affects, why, and the exact tool call
 * (a dry run) that would bring the other side up to date, for a person or the AI to run.
 *
 *   Rhino → Revit     a part file changed after a family that imports it was built: rebuild the family
 *   recipe → Revit    a recipe changed after its family was staged: rebuild it
 *   tree → apps       the recipe tree changed since its last build, or since its Power BI data or Navisworks sets were sent
 *   app → app         an app's results are older than the last thing sent to it (Robot results older than the model sent
 *                     to Robot): run it again
 * Pure: the tool gathers the facts (file times, revisions, packages) and passes them in.
 */

export interface Change {
  kind: "part" | "recipe" | "tree" | "export" | "flow";
  /** What changed. */
  what: string;
  /** What it affects (families, apps, nodes). */
  affects: string[];
  why: string;
  /** The dry run that would bring the other side up to date. */
  update?: { tool: string; args: Record<string, unknown> };
}

export interface FamilyFact {
  family: string;
  /** When the staged .rfa was last written (ms); undefined if it isn't staged. */
  built?: number;
  /** The revision of the recipe beside the staged family, and of the recipe it should be built from (if one was given). */
  staged_revision?: string | null;
  source_revision?: string | null;
  /** The part files its recipe imports, with when each was last written (ms; undefined when missing). */
  parts: Array<{ file: string; modified?: number }>;
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const base = (f: string) => f.split(/[\\/]/).pop() ?? f;

/** Families whose parts or recipe changed after they were built. */
export function familyChanges(facts: FamilyFact[]): Change[] {
  const out: Change[] = [];
  const byPart = new Map<string, { modified?: number; families: string[] }>();
  for (const f of facts) {
    if (f.source_revision && f.staged_revision !== f.source_revision)
      out.push({ kind: "recipe", what: `${f.family}'s recipe (${f.source_revision})`, affects: [f.family],
        why: f.built === undefined ? "it isn't staged yet" : `the staged family was built from ${f.staged_revision ?? "an unknown revision"}`,
        update: { tool: "fmc_recipe", args: { action: "batch", rebuild: [f.family], dry_run: true } } });
    for (const p of f.parts) {
      if (p.modified === undefined) {
        out.push({ kind: "part", what: base(p.file), affects: [f.family], why: "the part file is missing: the family can't be rebuilt until it is exported again (fmc_rhino export_parts)" });
        continue;
      }
      if (f.built !== undefined && p.modified > f.built) {
        const e = byPart.get(p.file) ?? { modified: p.modified, families: [] };
        e.families.push(f.family);
        byPart.set(p.file, e);
      }
    }
  }
  // one flag per changed part, naming every family that uses it
  for (const [file, e] of byPart)
    out.push({ kind: "part", what: base(file), affects: e.families,
      why: `the part changed ${when(e.modified!)}, after ${e.families.length === 1 ? "the family was" : "these families were"} built`,
      update: { tool: "fmc_recipe", args: { action: "batch", rebuild: e.families, dry_run: true } } });
  return out;
}

export interface TreeFact {
  file: string;
  modified: number;
  last_build?: number;
  /** Nodes whose recipe changed since the last build (fmc_tree plan). */
  changed_nodes: string[];
  /** The newest exports from the tree, by app. */
  exports: Partial<Record<"powerbi" | "navisworks", number>>;
}

export function treeChanges(t: TreeFact | null): Change[] {
  if (!t) return [];
  const out: Change[] = [];
  if (t.changed_nodes.length)
    out.push({ kind: "tree", what: "the recipe tree", affects: t.changed_nodes, why: `${t.changed_nodes.length} node(s) changed since ${t.last_build ? `the build of ${when(t.last_build)}` : "it was made (never built)"}`,
      update: { tool: "fmc_tree", args: { action: "build", dry_run: true } } });
  for (const app of ["powerbi", "navisworks"] as const) {
    const sent = t.exports[app];
    if (sent !== undefined && t.modified > sent)
      out.push({ kind: "export", what: "the recipe tree", affects: [app], why: `the tree changed ${when(t.modified)}, after the last ${app === "powerbi" ? "Power BI data" : "Navisworks search sets"} (${when(sent)})`,
        update: { tool: "fmc_tree", args: { action: "export", to: app, dry_run: true } } });
  }
  return out;
}

export interface PackageFact { from: string; to: string; created: string; what: string }

const RESULT_APPS = new Set(["robot", "navisworks"]);

/**
 * App-to-app: when an app's latest package back is older than the latest package sent to it, its results describe an
 * older model (Robot's forces from before the last analytical model was sent).
 */
export function flowChanges(pkgs: PackageFact[]): Change[] {
  const latest = new Map<string, PackageFact>();
  for (const p of pkgs) {
    const k = `${p.from}>${p.to}`;
    if (!latest.has(k) || latest.get(k)!.created < p.created) latest.set(k, p);
  }
  const out: Change[] = [];
  for (const [k, sent] of latest) {
    const [from, to] = k.split(">");
    // only apps that work out results from a model sent to them (Revit and Rhino are where models come from)
    if (!RESULT_APPS.has(to)) continue;
    const back = latest.get(`${to}>${from}`);
    if (back && back.created < sent.created)
      out.push({ kind: "flow", what: `${sent.what} (${from} → ${to}, ${sent.created.slice(0, 16).replace("T", " ")})`, affects: [to],
        why: `${to}'s latest results (${back.what}, ${back.created.slice(0, 16).replace("T", " ")}) are older than what was last sent to it: run it again and bring the results back` });
  }
  return out;
}
