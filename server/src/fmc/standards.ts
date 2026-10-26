/**
 * Building standards (owner 26 Oct: "values of the project for a standard building, helpful when you don't have a
 * recipe"). The kit's FMC_Standards_Building.json holds typical values; a project's 01_WIP\FMC_Project_Standards.json
 * overrides them key by key. Recipes are found by words in the kit's recipe index; when none fits, the answer names the
 * recipe to write (Naming rulebook) and the values to build it from. Pure: the tool reads the files.
 */
export interface StandardEntry {
  value: unknown; range?: unknown[]; unit?: string; uses?: Record<string, unknown>; kit_code?: string; note?: string; status?: string;
}
export interface StandardsFile { version?: string; status?: string; standards: Record<string, StandardEntry>; recipes?: { disciplines?: Record<string, string> } }
export interface Resolved { key: string; value: unknown; unit: string; source: "project" | "kit"; status: string; range?: unknown[]; kit_code?: string; note?: string }

const unitOf = (key: string, e: StandardEntry) => e.unit ?? (/^rooms\.(?!corridor)/.test(key) ? "m²" : "mm");

/** Kit values with the project's on top; each says where it came from and whether it's approved. */
export function resolve(kit: StandardsFile | null, project: Record<string, StandardEntry | unknown> | null, use?: string): Resolved[] {
  const out = new Map<string, Resolved>();
  const put = (key: string, raw: StandardEntry | unknown, source: "project" | "kit", fileStatus: string) => {
    const e: StandardEntry = raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as object) ? (raw as StandardEntry) : { value: raw };
    const value = use && e.uses && use in e.uses ? e.uses[use] : e.value;
    out.set(key, { key, value, unit: unitOf(key, e), source, status: e.status ?? (source === "project" ? "project" : fileStatus),
      ...(e.range ? { range: e.range } : {}), ...(e.kit_code ? { kit_code: e.kit_code } : {}), ...(e.note ? { note: e.note } : {}) });
  };
  const kitStatus = /^approved/i.test(kit?.status ?? "") ? "approved" : "proposed";
  for (const [k, e] of Object.entries(kit?.standards ?? {})) put(k, e, "kit", kitStatus);
  for (const [k, e] of Object.entries(project ?? {})) put(k, e, "project", "project");
  return [...out.values()];
}

/** The values a topic names: "stairs", "doors.internal", "ceiling height", "parapet". */
export function lookup(all: Resolved[], topic?: string): Resolved[] {
  if (!topic?.trim()) return all;
  const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => w.replace(/s$/, ""));
  const exact = all.filter((r) => r.key === topic.trim().toLowerCase());
  if (exact.length) return exact;
  return all.filter((r) => { const k = r.key.toLowerCase(); return words.every((w) => k.includes(w)); });
}

/** Recipes whose family names share the most words with what's asked; best first. */
export function findRecipes(index: Map<string, string[]>, words: string, limit = 5): Array<{ family: string; file: string; score: number }> {
  const want = words.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (!want.length) return [];
  const hits: Array<{ family: string; file: string; score: number }> = [];
  for (const [family, files] of index) {
    // GrabRail is grab + rail; a staged copy (20261017_...) ranks below the kit's own recipe
    const parts = family.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
    const score = want.filter((w) => parts.some((p) => p.startsWith(w) || w.startsWith(p) && p.length > 2)).length;
    if (score > 0) hits.push({ family, file: files[0], score: score / want.length });
  }
  const staged = (f: string) => /^\d/.test(f) ? 1 : 0;
  return hits.sort((a, b) => b.score - a.score || staged(a.family) - staged(b.family) || a.family.length - b.family.length).slice(0, limit);
}

/** The recipe to write when none fits: FMC_<discipline>_<Category>_<Descriptor> (Naming rulebook). */
export function suggestRecipe(words: string, discipline = "A"): { name: string; folder: string } {
  const parts = words.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const [category = "Generic", ...rest] = parts;
  const name = `FMC_${discipline.toUpperCase()}_${category}${rest.length ? "_" + rest.join("") : ""}`;
  return { name, folder: `Recipes\\Families\\${discipline.toUpperCase()}` };
}

/** The standards a recipe for this kind of thing would be built from (a door recipe: doors.*, accessibility.*). */
export function relatedStandards(all: Resolved[], words: string): Resolved[] {
  const w = words.toLowerCase();
  const topics = ["door", "window", "stair", "wall", "ceiling", "roof", "slab", "guard", "rail", "room", "service", "structure", "site", "parking"]
    .filter((t) => w.includes(t));
  const map: Record<string, string[]> = { rail: ["guards", "stairs.handrail"], guard: ["guards"], parking: ["site.parking"], door: ["doors", "accessibility"] };
  const prefixes = topics.flatMap((t) => map[t] ?? [t + "s.", t + "."]);
  return all.filter((r) => prefixes.some((p) => r.key.startsWith(p)));
}
