/**
 * fmc_context: the plugin's own context, handed to any AI that connects (docs/AI_CONTEXT.md).
 *
 * The owner, 15 Oct: "I want the MCP connection to route through the context in the app." An AI that connects (Claude,
 * ChatGPT, a local model) learns here that the kit and the plugin already hold the answers: family specs, recipes,
 * profile sets, the material library, keynotes, shared parameters, rulebooks, templates and staged families.
 *
 * Read-only and token-frugal: summaries and pointers, never dumps. Every value comes from the kit's files (rule 7);
 * this file holds only how to find and route them. Files are read once and kept until they change (mtime and size).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GuardConfig, expandEnv } from "./policy.js";
import { parseSharedParameters, SpParam } from "./specs.js";
import { Keynote, parseKeynotes } from "./library.js";
import { parseRulebook as parseQaRulebook } from "./rules.js";
import { parseConfig as parseAiConfig } from "./aiuse.js";
import type { RevitInstance } from "./connect.js";

// ---------- paths: Windows paths on the PC, POSIX paths in tests ----------

const looksWindows = (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p) || (p.includes("\\") && !p.includes("/"));
const P = (p: string) => (looksWindows(p) ? path.win32 : path.posix);
const pj = (base: string, ...parts: string[]) => P(base).join(base, ...parts);
const pdir = (p: string) => P(p).dirname(p);
const pbase = (p: string, ext?: string) => P(p).basename(p, ext);

export interface KitPaths {
  root: string; manifest: string; specs: string; register: string; profileSets: string; recipesDir: string;
  materials: string; keynotes: string; sharedParams: string; rulebooks: string; masterData: string;
  templatesDir: string; stagingRoot: string; familiesRoot: string; extraRecipeDirs: string[];
}

/** The repo's own recipes (tests/recipes), when the server runs from a checkout; absent in an installed build. */
export function repoRecipeDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "tests", "recipes");
}

/** Where everything is: the kit folder is two levels above specs_path (03_Master_Data\FMC_Family_Specs.json). */
export function kitPaths(cfg: GuardConfig, extraRecipeDirs: string[] = [repoRecipeDir()]): KitPaths {
  const specs = expandEnv(cfg.specs_path);
  const master = pdir(specs);
  const root = pdir(master);
  const staging = expandEnv(cfg.family_staging_root);
  return {
    root, specs, manifest: pj(root, "FMC_Kit.json"),
    register: pj(master, "FMC_Family_Register.csv"), profileSets: pj(master, "FMC_Profile_Sets.json"),
    recipesDir: pj(master, "Recipes"), masterData: pj(master, "FMC_Master_Data.json"),
    materials: expandEnv(cfg.materials_file), keynotes: expandEnv(cfg.keynote_file),
    sharedParams: expandEnv(cfg.shared_parameter_file), rulebooks: expandEnv(cfg.rulebooks_dir),
    templatesDir: pj(root, "06_Templates"), stagingRoot: staging, familiesRoot: pdir(staging.replace(/[\\/]+$/, "")),
    extraRecipeDirs,
  };
}

// ---------- cached readers ----------

const cache = new Map<string, { key: string; value: unknown }>();

/** One file read once per reader (kind) until its mtime or size changes. */
function cached<T>(file: string, parse: (raw: string) => T, kind = ""): T | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  const slot = `${kind}|${file}`;
  const hit = cache.get(slot);
  if (hit && hit.key === key) return hit.value as T;
  try {
    const value = parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    cache.set(slot, { key, value });
    return value;
  } catch { return null; }
}

const listDir = (dir: string): fs.Dirent[] => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };

export interface Spec {
  family: string; role: string; category: string; template: string; template_file: string | null; host: string;
  priority: string; why: string; types: string[]; packs: string[]; connectors: unknown[] | null;
  shared_parameters: Array<{ name: string; binding: string | null; guid: string | null }>;
  family_parameters: Array<{ name: string; level: string; rule: string }>; open_item: string;
}
interface SpecDb { version: string; families: Spec[]; byName: Map<string, Spec> }

export function loadSpecs(k: KitPaths): SpecDb | null {
  return cached(k.specs, (raw) => {
    const j = JSON.parse(raw);
    const families: Spec[] = (Array.isArray(j?.families) ? j.families : []).filter((f: any) => f && typeof f.family === "string");
    return { version: String(j?.version ?? ""), families, byName: new Map(families.map((f) => [f.family, f])) };
  });
}

export function loadRegister(k: KitPaths): Map<string, { role: string; category: string }> | null {
  return cached(k.register, (raw) => {
    const out = new Map<string, { role: string; category: string }>();
    for (const line of raw.split(/\r?\n/).slice(1)) {
      const c = line.split(",");
      if (c[1]) out.set(c[1], { role: c[0] ?? "", category: c[2] ?? "" });
    }
    return out;
  });
}

export interface ProfileRow { element: string; movement: string; token: string; index: number; family: string; kind: string; height: number; projection: number; source: string }

export function loadProfileSets(k: KitPaths): ProfileRow[] | null {
  return cached(k.profileSets, (raw) => (JSON.parse(raw) as any[]).map((r) => ({
    element: String(r.element ?? ""), movement: String(r.movement ?? ""), token: String(r.token ?? ""), index: Number(r.index ?? 0),
    family: String(r.family ?? ""), kind: String(r.kind ?? ""), height: Number(r.height ?? 0), projection: Number(r.projection ?? 0),
    source: String(r.source ?? ""),
  })));
}

/** The full row with its outline points, for get. */
function profileRowFull(k: KitPaths, family: string): Record<string, unknown> | null {
  const all = cached(k.profileSets, (raw) => JSON.parse(raw) as any[], "profile-full");
  return (all ?? []).find((r) => r.family === family) ?? null;
}

export interface Material {
  name: string; class: string; sub: string; keynote: string; cost_code: string; supplier: string; description: string;
  status: string; price: { ugx?: string; unit?: string; date?: string; source?: string } | null; maps: number; discipline: string;
}
export function loadMaterials(k: KitPaths): { version: string; materials: Material[]; raw: any[] } | null {
  return cached(k.materials, (raw) => {
    const j = JSON.parse(raw);
    const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.materials) ? j.materials : [];
    return {
      version: String(j?.version ?? ""), raw: list,
      materials: list.filter((m) => m && m.name).map((m) => ({
        name: String(m.name), class: String(m.class ?? ""), sub: String(m.sub ?? ""), keynote: String(m.keynote ?? ""),
        cost_code: String(m.cost_code ?? ""), supplier: String(m.supplier ?? ""), description: String(m.description ?? ""),
        status: String(m.status ?? ""), price: m.price && typeof m.price === "object" ? m.price : null,
        maps: Array.isArray(m.maps) ? m.maps.length : 0, discipline: String(m.discipline ?? ""),
      })),
    };
  });
}

export function loadKeynotes(k: KitPaths): Keynote[] | null { return cached(k.keynotes, parseKeynotes); }
export function loadDictionary(k: KitPaths): Map<string, SpParam> | null { return cached(k.sharedParams, parseSharedParameters); }
export function loadKitManifest(k: KitPaths): { kit?: string; revision?: string; date?: string; standard?: string } | null {
  return cached(k.manifest, (raw) => JSON.parse(raw));
}

/** Every recipe the plugin can build from: the kit's Recipes (all depths), recipes beside staged families, the repo's. */
let recipeMemo: { at: number; key: string; index: Map<string, string[]> } | null = null;
export function recipeIndex(k: KitPaths): Map<string, string[]> {
  const key = [k.recipesDir, k.stagingRoot, ...k.extraRecipeDirs].join("|");
  if (recipeMemo && recipeMemo.key === key && Date.now() - recipeMemo.at < 10_000) return recipeMemo.index;
  const index = new Map<string, string[]>();
  const walk = (dir: string, depth: number) => {
    for (const e of listDir(dir)) {
      const p = pj(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); }
      else if (/\.recipe\.json$/i.test(e.name)) {
        const fam = e.name.replace(/\.recipe\.json$/i, "");
        index.set(fam, [...(index.get(fam) ?? []), p]);
      }
    }
  };
  walk(k.recipesDir, 0);
  walk(k.stagingRoot, 0);
  for (const d of k.extraRecipeDirs) walk(d, 0);
  recipeMemo = { at: Date.now(), key, index };
  return index;
}

export interface RecipeSummary {
  file: string; family: string; template: string; ops: number; types: string[]; op_kinds: Record<string, number>;
  sources: Record<string, number>; about: string; checks: Record<string, unknown>; problems: string[];
}
export function summariseRecipe(file: string): RecipeSummary | null {
  return cached(file, (raw) => {
    const r = JSON.parse(raw);
    const ops: any[] = Array.isArray(r?.ops) ? r.ops : [];
    const kinds: Record<string, number> = {};
    for (const o of ops) kinds[String(o?.op)] = (kinds[String(o?.op)] ?? 0) + 1;
    const sources: Record<string, number> = {};
    for (const v of Object.values(r?.values ?? {}) as any[]) sources[String(v?.source_status)] = (sources[String(v?.source_status)] ?? 0) + 1;
    return {
      file, family: String(r?.family ?? ""), template: String(r?.template ?? ""), ops: ops.length,
      types: ops.filter((o) => o?.op === "add_type").map((o) => String(o.name)), op_kinds: kinds, sources,
      about: String(r?.about ?? "").slice(0, 240), checks: r?.checks ?? {},
      problems: typeof r?.schema === "string" && !/^fmc-recipe\/0\.\d+$/.test(r.schema) ? [`schema ${r.schema}`] : [],
    };
  });
}

/** Family files on disk: staging (04_Families\_Staging\<Role>) and released (04_Families\<Role>). */
export function familyFiles(k: KitPaths): { staged: Map<string, string>; released: Map<string, string> } {
  const staged = new Map<string, string>(), released = new Map<string, string>();
  const collect = (dir: string, into: Map<string, string>) => {
    for (const e of listDir(dir)) if (e.isFile() && /\.rfa$/i.test(e.name)) into.set(e.name.replace(/\.rfa$/i, ""), pj(dir, e.name));
  };
  for (const e of listDir(k.stagingRoot)) if (e.isDirectory()) collect(pj(k.stagingRoot, e.name), staged);
  for (const e of listDir(k.familiesRoot)) if (e.isDirectory() && /^[A-Z]{1,3}$/.test(e.name)) collect(pj(k.familiesRoot, e.name), released);
  return { staged, released };
}

export function rulebookFiles(k: KitPaths): string[] {
  return listDir(k.rulebooks).filter((e) => e.isFile() && /\.json$/i.test(e.name)).map((e) => pj(k.rulebooks, e.name)).sort();
}

function rulebookSummary(file: string) {
  return cached(file, (raw) => {
    const problems: string[] = [];
    const b = parseQaRulebook(pbase(file), JSON.parse(raw), problems);
    return { file, name: b.name, version: b.version, rules: b.rules.map((r) => ({ id: r.id, severity: r.severity, status: r.status, rule: r.rule, test: r.test, fix_hint: r.fix_hint, why: r.why })) };
  });
}

export function templateFiles(k: KitPaths): string[] {
  const out: string[] = [];
  for (const d of [k.templatesDir, pj(k.templatesDir, "_Staging")])
    for (const e of listDir(d)) if (e.isFile() && /\.(rte|rft)$/i.test(e.name)) out.push(pj(d, e.name));
  return out;
}

// ---------- the engine registry: engines in open PRs plug in by name, nothing depends on them ----------

export interface ContextEngine { id: string; intent: Intent; tool: string; about: string; calls: string[]; kit: string[] }

export const CONTEXT_ENGINES: ContextEngine[] = [
  { id: "line_diagram", intent: "line_diagram", tool: "fmc_diagram", about: "single-lines, risers and schematics drawn from the model; missing values print TBC",
    calls: ['fmc_diagram {"action":"scan"}', 'fmc_diagram {"action":"plan"}', 'fmc_diagram {"action":"draw","dry_run":true}'], kit: ["03_Master_Data/FMC_Diagram_Symbols.json"] },
  { id: "casework", intent: "casework", tool: "fmc_casework", about: "kitchen and joinery runs: units, parts, nesting, cut list, hardware, cost from the material library",
    calls: ['fmc_casework {"action":"units", ...run}', 'fmc_casework {"action":"summary", ...}', 'fmc_casework {"action":"pack","dry_run":true}'], kit: ["03_Master_Data/FMC_Casework_Standards.json", "07_Materials/FMC_Materials.json"] },
  { id: "ceiling", intent: "ceiling", tool: "fmc_ceiling", about: "ceiling designs, checks, set-out, quantities and BoQ from the kit's I.CLG keynotes and material prices",
    calls: ['fmc_ceiling {"action":"designs", ...}', 'fmc_ceiling {"action":"setout", ...}', 'fmc_ceiling {"action":"boq", ...}'], kit: ["03_Master_Data/FMC_Ceiling_Standard.json", "07_Materials/FMC_Materials.json"] },
];

/** An engine added later registers itself here (one call at import), so fmc_context routes to it. */
export function registerContextEngine(e: ContextEngine) {
  const i = CONTEXT_ENGINES.findIndex((x) => x.id === e.id);
  if (i >= 0) CONTEXT_ENGINES[i] = e; else CONTEXT_ENGINES.push(e);
}

/** Tool names the MCP server registered (filled by the server's wrapper); otherwise a tool file in the build counts. */
export const REGISTERED_TOOLS = new Set<string>();

function toolAvailable(name: string): boolean {
  if (REGISTERED_TOOLS.has(name)) return true;
  const tools = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");
  return exists(path.join(tools, name + ".js")) || exists(path.join(tools, name + ".ts"));
}

// ---------- words, intents, scoring ----------

const STOP = new Set(["a", "an", "the", "for", "to", "of", "with", "and", "or", "in", "on", "at", "by", "from", "i", "we", "me", "my", "our",
  "make", "create", "build", "new", "add", "want", "need", "please", "can", "you", "some", "type", "types", "family", "families", "rfa",
  "material", "materials", "kit", "formcraft", "fmc", "revit", "model", "draw", "design", "use", "using", "that", "this", "it", "is", "be", "set", "up"]);

/** "FMC_A_Door_AluSlidingFolding" → fmc a door alu sliding folding; "bi-fold" → bifold. */
export function words(s: string): string[] {
  return s.replace(/\bbi[- ]?fold/gi, "bifold").replace(/\bsingle[- ]line/gi, "singleline").replace(/\btake[- ]off/gi, "takeoff")
    .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const stem = (w: string) => (w.length > 4 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Related words, with how much a match on them counts (1 = the same word). */
const SYNONYMS: Record<string, Array<[string, number]>> = {
  bifold: [["folding", 1], ["fold", 1], ["sliding", 0.5]], folding: [["fold", 1], ["bifold", 1], ["sliding", 0.5]],
  aluminium: [["alu", 1], ["aluminum", 1]], aluminum: [["alu", 1], ["aluminium", 1]], alu: [["aluminium", 1]],
  sliding: [["slide", 1], ["folding", 0.3]], timber: [["wood", 1], ["hardwood", 1], ["softwood", 1]], wood: [["timber", 1], ["hardwood", 1]],
  glass: [["glazed", 1], ["glazing", 1]], glazed: [["glass", 1]], louvre: [["louvred", 1], ["louver", 1]], louver: [["louvre", 1], ["louvred", 1]],
  wc: [["toilet", 1], ["pan", 0.5]], toilet: [["wc", 1]], basin: [["washbasin", 1], ["lavatory", 1]], sink: [["basin", 0.5]],
  socket: [["outlet", 1], ["power", 0.5]], light: [["lighting", 1], ["luminaire", 1]], lamp: [["luminaire", 1], ["lighting", 0.5]],
  fanlight: [["fanlight", 1], ["vent", 0.5]], roller: [["shutter", 0.5]], fire: [["fp", 0.5], ["firerated", 1]],
};

/** Profile elements that "trim" means: the J.TRM joinery trims in the keynote file. */
const TRIM_ELEMENTS = ["Architrave", "Skirting", "DadoRail", "PictureRail", "PanelMould"];

export type Intent = "family" | "door" | "window" | "profile" | "material" | "keynote" | "parameter" | "sheet" | "schedule"
  | "casework" | "ceiling" | "line_diagram" | "template" | "qa";

const INTENT_WORDS: Record<Intent, string[]> = {
  door: ["door", "doorset", "bifold", "doorway", "shutter", "grille"],
  window: ["window", "casement", "louvre", "louver", "skylight", "hopper", "glazing"],
  profile: ["profile", "trim", "moulding", "molding", "architrave", "skirting", "cornice", "dado", "coping", "plinth", "quoin", "sill",
    "fascia", "lintel", "surround", "crown", "picture", "stringcourse", "drip", "mould", "movement", "sweep"],
  material: ["material", "finish", "texture", "paint", "render", "tile", "terrazzo", "screed", "cladding", "plaster", "marble", "granite",
    "timber", "concrete", "brick", "block", "stone", "gypsum", "board", "laminate", "vinyl", "carpet", "glass", "steel", "aluminium"],
  keynote: ["keynote", "keynotes", "spec", "specification"],
  parameter: ["parameter", "guid", "shared"],
  sheet: ["sheet", "titleblock", "title", "register", "drawing"],
  schedule: ["schedule", "quantity", "quantities", "boq", "takeoff", "bill"],
  casework: ["casework", "kitchen", "cabinet", "wardrobe", "vanity", "worktop", "cutlist", "joinery", "cupboard"],
  ceiling: ["ceiling", "soffit", "bulkhead"],
  line_diagram: ["diagram", "schematic", "riser", "singleline", "sld"],
  template: ["template", "rte", "rft", "viewtemplate"],
  qa: ["qa", "audit", "check", "rule", "rulebook", "compliance", "compliant", "gate"],
  family: ["family", "families", "rfa", "component", "fixture", "equipment", "fitting", "build", "create", "make", "door", "window", "profile"],
};

/** Strong words for material: words that are materials on their own, not when they qualify a family ("steel door"). */
const MATERIAL_ONLY = new Set(["material", "finish", "texture", "paint", "render", "terrazzo", "screed", "cladding", "plaster", "tile"]);

export function classify(task: string): Intent[] {
  const ws = new Set(words(task).map(stem));
  const out = new Set<Intent>();
  for (const [intent, list] of Object.entries(INTENT_WORDS) as Array<[Intent, string[]]>)
    if (list.some((w) => ws.has(stem(w)))) out.add(intent);
  // "aluminium door" is a door, not a material question; it stays a material question when a material word is there.
  if (out.has("material") && (out.has("door") || out.has("window") || out.has("profile")) && ![...ws].some((w) => MATERIAL_ONLY.has(w))) out.delete("material");
  if (out.has("door") || out.has("window") || out.has("profile") || out.has("casework")) out.add("family");
  if (/title ?block/i.test(task)) out.add("sheet");
  return [...out];
}

interface Term { w: string; weight: number }
function terms(task: string): Term[] {
  const base = words(task).filter((w) => !STOP.has(w)).map(stem);
  const out = new Map<string, number>();
  for (const w of base) {
    out.set(w, Math.max(out.get(w) ?? 0, 1));
    for (const [s, k] of SYNONYMS[w] ?? []) out.set(stem(s), Math.max(out.get(stem(s)) ?? 0, k));
  }
  return [...out].map(([w, weight]) => ({ w, weight }));
}

function match(term: string, tokens: string[]): number {
  let best = 0;
  for (const t of tokens) {
    if (t === term) return 1;
    if (term.length >= 4 && t.length >= 4 && (t.startsWith(term) || term.startsWith(t))) best = Math.max(best, 0.7);
  }
  return best;
}

const tokenCache = new Map<string, string[]>();
const toks = (s: string) => { let t = tokenCache.get(s); if (!t) { t = words(s).map(stem); if (tokenCache.size < 20000) tokenCache.set(s, t); } return t; };

const INTENT_CATEGORIES: Partial<Record<Intent, RegExp>> = {
  door: /^Doors$/, window: /^Windows$/, profile: /^Profiles$/, casework: /^Casework$/, ceiling: /Ceiling/,
};
const ANNOTATION = /Tags|Annotation|Detail Items|Title Blocks|Heads|Marks|View Titles/;

/** Rare words count more: "terrazzo" names one material, "floor" many (1 + ln(N / (1 + df)), at least 0.5). */
function rarity(ts: Term[], docs: string[][]): Map<string, number> {
  const n = docs.length || 1;
  const out = new Map<string, number>();
  for (const { w } of ts) {
    let df = 0;
    for (const d of docs) if (match(w, d) > 0) df++;
    out.set(w, Math.max(0.5, 1 + Math.log(n / (1 + df))));
  }
  return out;
}

const specDoc = (s: Spec) => [...toks(s.family), ...toks(s.category)];

export function scoreSpec(s: Spec, ts: Term[], intents: Intent[], wantsAnnotation: boolean, idf: Map<string, number> = new Map()): number {
  const name = toks(s.family), cat = toks(s.category);
  const rest = [...toks(s.why ?? ""), ...(s.types ?? []).flatMap((t) => toks(t))];
  let score = 0, hit = false;
  for (const { w, weight } of ts) {
    const n = match(w, name), c = match(w, cat), r = match(w, rest);
    if (n || c) hit = true;
    score += weight * (idf.get(w) ?? 1) * Math.max(3 * n, 2 * c, r);
  }
  if (!hit) return 0;
  if (intents.some((i) => INTENT_CATEGORIES[i]?.test(s.category))) score *= 1.5;
  if (ANNOTATION.test(s.category) && !wantsAnnotation) score *= 0.3;
  return Math.round(score * 10) / 10;
}

/** A material's words: its name; its class, sub-class and keynote text (with the keynote's group); its description. */
function materialDoc(m: Material, keynoteText: Map<string, string>) {
  return { name: toks(m.name), cls: [...toks(m.class), ...toks(m.sub), ...toks(keynoteText.get(m.keynote) ?? "")], desc: toks(m.description) };
}

function scoreMaterial(m: Material, ts: Term[], keynoteText: Map<string, string>, idf: Map<string, number>): number {
  const { name, cls, desc } = materialDoc(m, keynoteText);
  let score = 0, hit = false;
  for (const { w, weight } of ts) {
    const n = match(w, name), c = match(w, cls), d = match(w, desc);
    if (n || c) hit = true;
    score += weight * (idf.get(w) ?? 1) * Math.max(3 * n, 2 * c, d);
  }
  return hit ? Math.round(score * 10) / 10 : 0;
}

function scoreText(text: string, ts: Term[]): number {
  const t = toks(text);
  return ts.reduce((s, { w, weight }) => s + weight * match(w, t), 0);
}

// ---------- answers ----------

export interface ContextDeps {
  cfg: GuardConfig;
  /** The open Revits (from %APPDATA%\Formcraft\instances; no Revit call). */
  instances: () => RevitInstance[];
  /** Recipe folders beside the kit's (the repo's tests/recipes by default). */
  extraRecipeDirs?: string[];
}

export const MAX_ANSWER_BYTES = 6000;
export const MAX_GET_BYTES = 12000;

const priceStatus = (m: Material) => (m.price?.ugx ? `UGX ${m.price.ugx}${m.price.unit ? " " + m.price.unit : ""}${m.price.date ? ` (${m.price.date})` : ""}` : "price needed");

/** The project folder above 01_WIP, and its manifest if any. */
function projectOf(docPath: string): { folder: string; manifest: string } | null {
  if (!docPath) return null;
  const segs = docPath.split(/[\\/]/);
  const i = segs.findIndex((s) => s.toUpperCase() === "01_WIP");
  if (i <= 0) return null;
  const sep = looksWindows(docPath) ? "\\" : "/";
  const folder = segs.slice(0, i).join(sep);
  return { folder, manifest: [folder, "01_WIP", "FMC_Project.json"].join(sep) };
}

function aiUseState(k: KitPaths, cfg: GuardConfig) {
  const files = rulebookFiles(k).map((f) => pbase(f));
  const aiBook = files.find((f) => /^FMC_Rulebook_AIUse\.json$/i.test(f));
  const claudeBook = files.find((f) => /^FMC_Rulebook_ClaudeUse\.json$/i.test(f));
  const ai = parseAiConfig((cfg as unknown as { ai_modeller?: unknown }).ai_modeller);
  return {
    aiuse_rulebook: aiBook ?? "missing (AI modelling on projects stays Off)",
    claudeuse_rulebook: claudeBook ?? "missing",
    ai_modeller: !ai ? "off (no ai_modeller section in fmc_guard.json)" : ai.stop ? "stopped" : ai.on ? "on" : "off",
  };
}

export const TOOL_MAP: Record<string, string> = {
  "find the kit's data for a task": "fmc_context for_task, then get for one item",
  "build a family from a recipe": "fmc_recipe check → build (dry run) → build dry_run=false after a yes → gate",
  "data-shell families from the specs": "fmc_family plan → build",
  "family ops in a background session": "fmc_doc open → apply → flex → save (to staging)",
  "check or bring in families": "fmc_library scan / inspect / bring_in",
  "keynotes and shared parameters": "fmc_library keynotes / parameters",
  "materials": "fmc_material database → assign",
  "sheets": "fmc_sheets compare → create / rename",
  "quantities and schedules": "fmc_build quantities",
  "templates": "fmc_template recipe / audit / build",
  "QA and rules": "fmc_qa rules / run",
  "new project": "fmc_project plan → start",
  "which Revit": "fmc_revit list / use",
};

export function overview(deps: ContextDeps) {
  const k = kitPaths(deps.cfg, deps.extraRecipeDirs);
  const manifest = loadKitManifest(k);
  const specs = loadSpecs(k);
  const recipes = recipeIndex(k);
  const profilesN = [...recipes.keys()].filter((f) => f.startsWith("FMC_Profile_")).length;
  const sets = loadProfileSets(k);
  const mats = loadMaterials(k);
  const keys = loadKeynotes(k);
  const dict = loadDictionary(k);
  const books = rulebookFiles(k);
  const files = familyFiles(k);
  const register = loadRegister(k);
  const missing: string[] = [];
  const count = (label: string, v: number | null) => { if (v === null) missing.push(label); return v ?? 0; };

  let revits: RevitInstance[] = [];
  try { revits = deps.instances(); } catch { revits = []; }
  const docs = revits.flatMap((r) => r.documents.map((d) => ({ title: d.title, active: d.active, family: d.family, workshared: d.workshared, revit: r.port })));
  const active = revits.flatMap((r) => r.documents).find((d) => d.active && !d.family);
  const proj = active ? projectOf(active.path) : null;
  let project: unknown = null;
  if (proj) {
    const m = cached(proj.manifest, (raw) => JSON.parse(raw), "project");
    project = m ? { code: m.project, stage: m.stage, issue_set: m.issue_set, roles: m.roles, standard: m.standard, models: (m.models ?? []).length, manifest: proj.manifest }
      : { folder: proj.folder, manifest: "none yet (fmc_project plan writes 01_WIP\\FMC_Project.json)" };
  }

  return {
    kit: { found: !!manifest || !!specs, path: k.root, version: manifest?.kit ?? specs?.version ?? "", revision: manifest?.revision ?? "", date: manifest?.date ?? "" },
    counts: {
      family_specs: count("family specs", specs ? specs.families.length : null),
      family_register: count("family register", register ? register.size : null),
      recipes: recipes.size, profile_recipes: profilesN,
      profile_sets: count("profile sets", sets ? sets.length : null),
      profile_elements: sets ? new Set(sets.map((r) => r.element)).size : 0,
      design_movements: sets ? new Set(sets.map((r) => r.movement)).size : 0,
      materials: count("material library", mats ? mats.materials.length : null),
      keynotes: count("keynotes", keys ? keys.length : null),
      shared_parameters: count("shared parameters", dict ? dict.size : null),
      rulebooks: books.length, templates: templateFiles(k).length,
      staged_families: files.staged.size, released_families: files.released.size,
    },
    missing: missing.length ? missing.map((m) => `${m}: not readable (a kit change request, or a path in fmc_guard.json)`) : undefined,
    rulebooks: books.map((b) => pbase(b, ".json").replace(/^FMC_Rulebook_/, "")),
    revit: docs.length ? docs : "No Revit with the AI connection on (Formcraft tab › Core › \"AI: off\" switches it on)",
    project,
    ai_use: aiUseState(k, deps.cfg),
    engines: CONTEXT_ENGINES.map((e) => ({ id: e.id, tool: e.tool, available: toolAvailable(e.tool) })),
    use: TOOL_MAP,
    next: 'Before creating anything: fmc_context {"action":"for_task","task":"<what the person asked>"}',
  };
}

const q = (o: unknown) => JSON.stringify(o);

export function forTask(task: string, deps: ContextDeps) {
  const k = kitPaths(deps.cfg, deps.extraRecipeDirs);
  const intents = classify(task);
  const ts = terms(task);
  const wantsAnnotation = /\b(tag|tags|symbol|annotation|detail item|title ?block)\b/i.test(task);
  const out: Record<string, unknown> = { task, intents: intents.length ? intents : ["(none matched: searched specs, materials and keynotes)"] };
  const next: string[] = [];
  const notes: string[] = [];
  const recipes = recipeIndex(k);
  const files = familyFiles(k);
  const any = intents.length === 0;
  const recipeFor = (fam: string) => recipes.get(fam)?.[0] ?? null;

  // Profiles: the design-movement sets (16 elements × 20 movements; FMC_Design_Movement picks the slot by index).
  if (intents.includes("profile")) {
    const sets = loadProfileSets(k);
    if (!sets) notes.push("FMC_Profile_Sets.json not readable (03_Master_Data): a kit change request");
    else {
      const compact = task.toLowerCase().replace(/[^a-z0-9]/g, "");
      const moves = new Map<string, { movement: string; index: number; key: string }>();
      for (const r of sets) {
        if (moves.has(r.token)) continue;
        const keys = [r.token.toLowerCase(), ...r.movement.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5 && !["revival", "african"].includes(w))];
        const key = keys.find((x) => compact.includes(x));
        if (key) moves.set(r.token, { movement: r.movement, index: r.index, key });
      }
      // "greek revival" names Greek Revival, not Greek as well
      for (const [t, m] of [...moves]) if ([...moves.values()].some((o) => o !== m && o.key.length > m.key.length && o.key.includes(m.key))) moves.delete(t);
      const allEls = [...new Set(sets.map((r) => r.element))];
      const ws = new Set(words(task).map(stem));
      let els = allEls.filter((e) => toks(e).some((t) => ws.has(t)) || compact.includes(e.toLowerCase()));
      if (!els.length && ws.has("trim")) els = TRIM_ELEMENTS.filter((e) => allEls.includes(e));
      const rows = sets.filter((r) => (!moves.size || moves.has(r.token)) && (!els.length || els.includes(r.element)));
      const shown = rows.slice(0, moves.size ? 16 : els.length ? 20 : 0);
      out.profile_sets = {
        file: k.profileSets,
        movements: moves.size ? [...moves.values()].map((m) => `${m.index} ${m.movement}`) : "any (name one: Greek … Tropical/East African)",
        elements: els.length ? els : "all 16",
        design_movement_param: "FMC_Design_Movement = the movement's index picks the profile slot in host families",
        recipes_dir: pj(k.recipesDir, "Families", "_Profiles"),
        rows: shown.map((r) => ({ element: r.element, movement: r.movement, index: r.index, family: r.family, kind: r.kind, h: r.height, proj: r.projection, recipe: !!recipeFor(r.family) })),
        more: rows.length > shown.length ? `${rows.length - shown.length} more rows: name a movement or an element` : undefined,
        source: shown[0]?.source || undefined,
      };
      const first = shown.find((r) => recipeFor(r.family));
      if (first) {
        next.push(`fmc_recipe ${q({ action: "check", recipe_file: recipeFor(first.family) })}`);
        next.push(`fmc_recipe ${q({ action: "build", recipe_file: recipeFor(first.family), dry_run: true })} (one per profile; a person says yes before dry_run=false)`);
      }
    }
  }

  // Families: specs by name, category and words; their recipes, staged and released files.
  if (any || intents.some((i) => ["family", "door", "window", "casework", "ceiling", "profile"].includes(i)) || /title ?block/i.test(task)) {
    const specs = loadSpecs(k);
    if (!specs) notes.push(`Family specs not readable at ${k.specs} (specs_path in fmc_guard.json)`);
    else {
      const idf = rarity(ts, specs.families.map(specDoc));
      const scored = specs.families.map((s) => ({ s, score: scoreSpec(s, ts, intents, wantsAnnotation, idf) })).filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.s.family.localeCompare(b.s.family));
      const limit = intents.includes("profile") ? 3 : any ? 4 : 8;
      const top = scored.slice(0, limit);
      const dict = loadDictionary(k);
      out.family_specs = top.map(({ s, score }) => {
        const r = recipeFor(s.family);
        const sum = r ? summariseRecipe(r) : null;
        return {
          family: s.family, score, category: s.category, template: s.template_file ?? s.template, host: s.host, priority: s.priority,
          types: (s.types ?? []).slice(0, 6), why: (s.why ?? "").slice(0, 110) || undefined,
          shared_params: (s.shared_parameters ?? []).length ? (s.shared_parameters ?? []).slice(0, 5).map((p) => `${p.name} ${p.guid ?? dict?.get(p.name)?.guid ?? "(not in dictionary)"}`) : undefined,
          recipe: sum ? { file: r, ops: sum.ops, sources: sum.sources } : null,
          staged: files.staged.get(s.family) ?? undefined, released: files.released.get(s.family) ?? undefined,
          open_item: s.open_item || undefined,
        };
      });
      if (scored.length > top.length) out.more_specs = `${scored.length - top.length} more matched; fmc_context get spec:<name> for one in full`;
      const best = top[0]?.s;
      const profileRows = ((out.profile_sets as { rows?: Array<{ recipe: boolean }> } | undefined)?.rows ?? []).filter((r) => r.recipe).length;
      if (best && best.category === "Profiles" && profileRows) {
        // Profiles come one family per design movement (FMC_Profile_<Element>_<Token>, FMC_Design_Movement 1-20; the old
        // theme-typed single profiles are superseded): build from the profile set rows' recipes, don't write a new one.
        notes.push(`${best.family}: profiles are one family per design movement (the profile set rows above, picked by FMC_Design_Movement): build from their recipes`);
      } else if (best) {
        const r = recipeFor(best.family);
        const staged = files.staged.get(best.family);
        if (r) {
          next.push(`fmc_recipe ${q({ action: "check", recipe_file: r })}`);
          next.push(`fmc_recipe ${q({ action: "build", recipe_file: r, dry_run: true })} → show the dry run → dry_run=false after a yes`);
        } else {
          // No recipe for the best match: the nearest recipes of the same role and category token are the pattern to adapt.
          const prefix = best.family.split("_").slice(0, 3).join("_") + "_";
          const near = [...recipes.keys()].filter((f) => f.startsWith(prefix))
            .map((f) => ({ f, s: scoreText(f, ts) })).sort((a, b) => b.s - a.s || a.f.localeCompare(b.f)).slice(0, 4).map((x) => x.f);
          out.nearest_recipes = near.length ? near.map((f) => ({ family: f, file: recipeFor(f), ops: summariseRecipe(recipeFor(f)!)?.ops })) : undefined;
          next.push(`fmc_context ${q({ action: "get", ref: "spec:" + best.family })}`);
          if (near.length) next.push(`Write ${best.family}.recipe.json from the spec, adapting ${near[0]}'s ops (template ${best.template_file ?? best.template}, types ${q((best.types ?? []).slice(0, 3))}); then fmc_recipe check and build (dry run)`);
          else next.push(`fmc_family ${q({ action: "plan", families: [best.family] })} (a data-shell from the spec), or a recipe for full geometry`);
        }
        if (staged) next.push(`Already staged: fmc_recipe ${q({ action: "gate", file: staged })}`);
        if (files.released.get(best.family)) notes.push(`${best.family} is released in 04_Families: load it, don't rebuild it`);
      } else if (!any) notes.push("No family spec matches: if the kit should have this family, it is a kit change request (FMC_Family_Specs.json)");
    }
  }

  // Materials: the library, with keynote and price status (a missing price is "price needed", never a guess).
  if (any || intents.includes("material") || intents.includes("schedule")) {
    const mats = loadMaterials(k);
    const keys = loadKeynotes(k);
    const kn = new Map((keys ?? []).map((x) => [x.code, x.description]));
    // a material's keynote text includes its group's ("I.FLR_01" → "… terrazzo …" + "Floor finishes")
    const knText = new Map((keys ?? []).map((x) => [x.code, `${x.description} ${kn.get(x.parent) ?? ""}`]));
    if (!mats) notes.push(`Material library not readable at ${k.materials} (materials_file in fmc_guard.json)`);
    else {
      const idf = rarity(ts, mats.materials.map((m) => { const d = materialDoc(m, knText); return [...d.name, ...d.cls]; }));
      const top = mats.materials.map((m) => ({ m, score: scoreMaterial(m, ts, knText, idf) })).filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.m.name.localeCompare(b.m.name)).slice(0, any ? 3 : 5);
      out.materials = top.map(({ m }) => ({
        name: m.name, class: m.class, keynote: m.keynote, keynote_text: kn.get(m.keynote)?.slice(0, 90), price: priceStatus(m), status: m.status, textures: m.maps,
      }));
      if (top[0]) next.push(`fmc_material ${q({ action: "assign", material: top[0].m.name, dry_run: true })} (target category, selection or rule; refused on live projects)`);
      else if (intents.includes("material")) notes.push("No library material matches: request one (fmc_material request), never invent it");
    }
  }

  // Keynotes: codes from FMC_Keynotes.txt.
  if (any || intents.includes("keynote") || intents.includes("material") || intents.includes("profile")) {
    const keys = loadKeynotes(k);
    if (keys) {
      const list = keys.filter((x) => x.parent);
      const idf = rarity(ts, list.map((x) => toks(x.description)));
      const upper = task.toUpperCase();
      const scored = list.map((x) => ({ x, s: ts.reduce((s, t) => s + t.weight * (idf.get(t.w) ?? 1) * match(t.w, toks(x.description)), 0) + (upper.includes(x.code) ? 20 : 0) }));
      const topScore = Math.max(0, ...scored.map((h) => h.s));
      // the best matches only: a word every keynote shares ("profile", "floor") doesn't bring in the rest
      const hits = scored.filter((h) => h.s >= 1 && h.s >= topScore * 0.5).sort((a, b) => b.s - a.s || a.x.code.localeCompare(b.x.code)).slice(0, 5);
      if (hits.length) out.keynotes = hits.map((h) => `${h.x.code} ${h.x.description}`.slice(0, 100));
    }
  }

  if (intents.includes("parameter")) {
    const dict = loadDictionary(k);
    if (dict) {
      const hits = [...dict.values()].map((p) => ({ p, s: scoreText(p.name, ts) })).filter((h) => h.s >= 1).sort((a, b) => b.s - a.s).slice(0, 8);
      out.shared_parameters = hits.map((h) => `${h.p.name} ${h.p.guid} ${h.p.datatype} (${h.p.group})`);
      next.push(`fmc_library ${q({ action: "parameters", query: ts[0]?.w ?? "" })}`);
    }
  }

  if (intents.includes("sheet")) {
    out.sheets = { register: pj(pdir(k.specs), "FMC_Sheet_Register.csv"), project_register: "<project>\\00_Info\\FMC_Sheet_Register.xlsx or .csv" };
    next.push(`fmc_sheets ${q({ action: "compare" })} → create (dry run) for the missing ones`);
  }
  if (intents.includes("schedule")) next.push(`fmc_build ${q({ action: "quantities" })} (quantities by FMC_Keynote_Code; rates never in Revit)`);
  if (intents.includes("template")) {
    out.templates = templateFiles(k).map((f) => pbase(f)).slice(0, 10);
    next.push(`fmc_template ${q({ action: "recipe" })} then audit or build (dry run)`);
  }
  if (intents.includes("qa")) {
    out.rulebooks = rulebookFiles(k).map((f) => pbase(f, ".json"));
    next.push(`fmc_qa ${q({ action: "rules" })}, then fmc_qa ${q({ action: "run", gate: "wip_to_shared" })} (read-only)`);
  }

  // Engines: casework, ceilings, line diagrams; each plugs in by the registry.
  const engines = CONTEXT_ENGINES.filter((e) => intents.includes(e.intent));
  if (engines.length) {
    out.engines = engines.map((e) => ({ id: e.id, tool: e.tool, available: toolAvailable(e.tool), about: e.about, kit: e.kit,
      note: toolAvailable(e.tool) ? undefined : "not in this build yet: say so, don't improvise it" }));
    for (const e of engines) if (toolAvailable(e.tool)) next.push(...e.calls.slice(0, 2));
  }

  out.next = next.length ? next.slice(0, 6) : ["Nothing in the kit matches: ask the person, or raise a kit change request; don't invent values"];
  if (notes.length) out.notes = notes;
  out.rule = "Reuse these; never invent a value the kit holds; a missing value is a kit change request";
  return fit(out, MAX_ANSWER_BYTES);
}

/** Keeps an answer under the size cap: the longest lists are shortened first, and the answer says so. */
export function fit<T extends Record<string, unknown>>(body: T, max: number): T {
  const size = () => Buffer.byteLength(JSON.stringify(body));
  let guard = 0;
  while (size() > max && guard++ < 200) {
    let longest: { holder: any; key: string; len: number } | null = null;
    const visit = (o: any) => {
      if (!o || typeof o !== "object") return;
      for (const [key, v] of Object.entries(o)) {
        if (Array.isArray(v) && v.length > 1 && (!longest || JSON.stringify(v).length > longest.len)) longest = { holder: o, key, len: JSON.stringify(v).length };
        else if (v && typeof v === "object" && !Array.isArray(v)) visit(v);
      }
    };
    visit(body);
    if (!longest) break;
    const l = longest as { holder: any; key: string };
    l.holder[l.key] = l.holder[l.key].slice(0, -1);
    (body as any).trimmed = "Shortened to stay small: ask fmc_context get for one item in full";
  }
  return body;
}

function capText(o: unknown, max = MAX_GET_BYTES): unknown {
  const s = JSON.stringify(o);
  return Buffer.byteLength(s) <= max ? o : { truncated: true, first_bytes: s.slice(0, max) };
}

/** One item in full (a spec, recipe summary, material, rulebook, profile row, keynote or parameter), capped. */
export function getItem(ref: string, deps: ContextDeps): Record<string, unknown> {
  const k = kitPaths(deps.cfg, deps.extraRecipeDirs);
  const m = /^(spec|recipe|material|rulebook|profile|keynote|parameter|engine):(.*)$/i.exec(ref.trim());
  const kind = m ? m[1].toLowerCase() : "";
  const name = (m ? m[2] : ref).trim();
  const tryKinds = kind ? [kind] : ["spec", "material", "recipe", "profile", "keynote", "parameter", "rulebook", "engine"];
  for (const kd of tryKinds) {
    const r = getOne(kd, name, k);
    if (r) return capText({ kind: kd, ...r }) as Record<string, unknown>;
  }
  return { found: false, ref, hint: 'Refs: spec:<family>, recipe:<family or file>, material:<name>, rulebook:<name>[/<rule id>], profile:<family>, keynote:<code>, parameter:<name>, engine:<id>. fmc_context for_task finds names.' };
}

function getOne(kind: string, name: string, k: KitPaths): Record<string, unknown> | null {
  switch (kind) {
    case "spec": {
      const s = loadSpecs(k)?.byName.get(name);
      if (!s) return null;
      const dict = loadDictionary(k);
      const files = familyFiles(k);
      return {
        spec: { ...s, shared_parameters: (s.shared_parameters ?? []).map((p) => ({ ...p, guid: p.guid ?? dict?.get(p.name)?.guid ?? null, in_dictionary: !!dict?.get(p.name) })) },
        register: loadRegister(k)?.get(name) ?? null, recipes: recipeIndex(k).get(name) ?? [],
        staged: files.staged.get(name) ?? null, released: files.released.get(name) ?? null,
      };
    }
    case "recipe": {
      const file = exists(name) && /\.json$/i.test(name) ? name : recipeIndex(k).get(name)?.[0];
      if (!file) return null;
      const sum = summariseRecipe(file);
      if (!sum) return { file, problems: ["not readable as JSON"] };
      const raw = cached(file, (t) => JSON.parse(t), "recipe-raw") as any;
      return { recipe: sum, values: raw?.values ?? {}, other_copies: (recipeIndex(k).get(sum.family) ?? []).filter((f) => f !== file), next: [`fmc_recipe ${q({ action: "check", recipe_file: file })}`] };
    }
    case "material": {
      const mats = loadMaterials(k);
      const raw = mats?.raw.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
      if (!raw) return null;
      const kn = loadKeynotes(k)?.find((x) => x.code === raw.keynote);
      return { material: raw, keynote_text: kn?.description ?? null, price_status: raw.price?.ugx ? "priced" : "price needed" };
    }
    case "rulebook": {
      const [book, rule] = name.split("/");
      const file = rulebookFiles(k).find((f) => pbase(f, ".json").toLowerCase() === book.toLowerCase() || pbase(f, ".json").toLowerCase() === `fmc_rulebook_${book.toLowerCase()}`);
      if (!file) return null;
      const b = rulebookSummary(file);
      if (!b) return { file, problems: ["not readable as JSON"] };
      if (rule) { const r = b.rules.find((x) => x.id.toLowerCase() === rule.toLowerCase()); return r ? { file, book: b.name, rule: r } : null; }
      return { file, book: b.name, version: b.version, count: b.rules.length, rules: b.rules.map((r) => `${r.id} [${r.severity}] ${r.rule}`.slice(0, 140)) };
    }
    case "profile": {
      const row = profileRowFull(k, name);
      if (!row) return null;
      return { profile: row, recipe: recipeIndex(k).get(name)?.[0] ?? null };
    }
    case "keynote": {
      const keys = loadKeynotes(k) ?? [];
      const kn = keys.find((x) => x.code === name);
      if (!kn) return null;
      return { keynote: kn, children: keys.filter((x) => x.parent === kn.code).slice(0, 30).map((x) => `${x.code} ${x.description}`) };
    }
    case "parameter": {
      const p = loadDictionary(k)?.get(name);
      return p ? { parameter: p } : null;
    }
    case "engine": {
      const e = CONTEXT_ENGINES.find((x) => x.id === name || x.tool === name);
      return e ? { engine: e, available: toolAvailable(e.tool) } : null;
    }
  }
  return null;
}

// ---------- the nudge at the point of use ----------

/** Cheap name lookup: kit specs and recipes for family names a call made without using them. */
export function kitNoteFor(names: string[], deps: ContextDeps): string | null {
  const k = kitPaths(deps.cfg, deps.extraRecipeDirs);
  const specs = loadSpecs(k);
  const recipes = recipeIndex(k);
  const lines: string[] = [];
  for (const n of [...new Set(names)].slice(0, 5)) {
    const s = specs?.byName.get(n);
    const r = recipes.get(n)?.[0];
    if (!s && !r) continue;
    lines.push(`${n}: the kit has ${[s ? `a spec (template ${s.template_file ?? s.template}, ${s.types?.length ?? 0} types)` : "", r ? `a recipe ${r}` : ""].filter(Boolean).join(" and ")}. ` +
      (r ? `fmc_recipe check/build rebuilds it from kit data.` : `fmc_context get spec:${n} has its data.`));
  }
  return lines.length ? `Kit context: ${lines.join(" ")}` : null;
}

/** FMC family names in a code snippet or a result that makes or saves a family. */
export function familyNamesIn(text: string): string[] {
  return [...new Set((text.match(/\bFMC_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+/g) ?? []).map((n) => n.replace(/\.rfa$/i, "")))];
}

export const MAKES_FAMILY = /NewFamilyDocument|FamilyManager|\.rfa\b|SaveAs|EditFamily|FamilyCreate/;
