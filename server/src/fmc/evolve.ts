/**
 * fmc_family_evolve: evolve an existing family in place (tracker F127; owner GO, 28 Nov). Pure: the facts come from Revit through
 * fmc_library inspect and fmc_doc (report, flex, apply dry run), the reference from the kit (FMC_Family_Specs.json,
 * FMC_SharedParameters.txt, FMC_Keynotes.txt). Nothing here touches a file.
 *
 * Five quality gates: naming, kit shared parameters present and bound (by GUID), reference planes named, flex
 * (every type regenerates, sizes move the solids), keynote X.YYY_ZZ. Each failing finding is either a fix (fmc_doc
 * ops, or a new file name for the new version) or needs a person. check is a dry run that returns a confirm token;
 * apply needs that token, backs the original up byte for byte, and saves a NEW version: the original is never
 * overwritten unless replace_original is set, and then only after the backup is verified.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { familyKind, nameCheck, requiredParameters } from "./library.js";
import { FamilySpec, SpParam } from "./specs.js";
import { GateInputs, GateState, roleOf, sidesLine } from "./recipes.js";
import { GuardConfig, checkWritePath, isInside, nameProblems } from "./policy.js";

const win = path.win32;

export const EVOLVE_GATES = ["naming", "shared_parameters", "reference_planes", "flex", "keynote"] as const;
export type EvolveGate = (typeof EVOLVE_GATES)[number];

/** The founder's keynote format, X.YYY_ZZ (S.FND_01): the same rule as fmc_replace's KEYNOTE_RE. */
export const KEYNOTE_FORMAT = /^[A-Z]\.[A-Z0-9]{3}_[A-Z0-9]{2}$/;

export interface PlaneFact { name: string; axis: "x" | "y" | "z" | ""; at_mm: number; is_reference?: string }
export interface ParamFact { name: string; shared: boolean; guid: string; instance?: boolean; formula?: string }

/** What the gates read: the family's own facts, gathered by the tool (or a test). */
export interface EvolveFacts {
  file: string;
  family: string;
  category: string;
  parameters: ParamFact[];
  types: string[];
  type_keynotes: Array<{ type: string; keynote: string }> | null;
  reference_planes: string[];
  /** Name, axis and position of each plane (this add-in's fmc_doc report); null on an older add-in. */
  reference_planes_detail: PlaneFact[] | null;
  flex: GateInputs["flex"];
  flexError?: string;
}

export interface EvolveKit {
  /** The kit's dictionary, by name (FMC_SharedParameters.txt); null when it isn't readable. */
  dictionary: Map<string, SpParam> | null;
  specs: Map<string, FamilySpec>;
  /** Codes in the kit's keynote file; null when it isn't readable. */
  keynotes: Set<string> | null;
}

export interface EvolveOptions {
  /** The new version's family name (file name without .rfa), when the current one breaks the naming rule. */
  new_name?: string;
  /** One keynote for every type, or one per type. */
  keynote?: string | Record<string, string>;
  /** Names for unnamed planes, by axis and position. */
  plane_names?: Array<{ axis: "x" | "y" | "z"; at_mm: number; name: string }>;
  /** Name every other unnamed plane by its position (RP_X+450), so it can be dimensioned and locked. */
  auto_name_planes?: boolean;
  /** Kit shared parameters (by name) the family must carry beyond its spec. */
  required_parameters?: string[];
}

export interface GateResult { gate: EvolveGate; state: GateState; detail: string; findings: string[] }

/** One proposed improvement: a batch of fmc_doc ops, or a new name for the new version. */
export interface Fix {
  id: string; gate: EvolveGate; summary: string;
  ops: Array<Record<string, unknown>>;
  rename_to?: string;
  /** Names in this fix that are the tool's placeholder, not a kit rule: a person should replace them (RP_X+450). */
  provisional?: string[];
  /** The kit rule the names come from, when they do (FAM-008). */
  kit_rule?: string;
}

export interface Evaluation { gates: GateResult[]; fixes: Fix[]; needs_person: Array<{ gate: EvolveGate; detail: string }>; target_name: string; problems: string[] }

const UNNAMED = new Set(["", "reference plane"]);
/** A plane Revit gave no name: blank, or the default "Reference Plane". */
export function isUnnamedPlane(name: string | null | undefined): boolean {
  return UNNAMED.has(String(name ?? "").trim().toLowerCase());
}

/** A keynote close to X.YYY_ZZ made exact: case, spaces, hyphens and other separators. null when it can't be. */
export function normalizeKeynote(value: string): string | null {
  const v = String(value ?? "").trim().toUpperCase();
  if (!v) return null;
  if (KEYNOTE_FORMAT.test(v)) return v;
  const m = /^([A-Z])[\s.\-_/]*([A-Z0-9]{3})[\s.\-_/]+([A-Z0-9]{2})$/.exec(v);
  if (!m) return null;
  const out = `${m[1]}.${m[2]}_${m[3]}`;
  return KEYNOTE_FORMAT.test(out) ? out : null;
}

/** The kit's family-name rule, for this family's kind; a name the kit's register lists passes. */
export function familyNameOk(name: string, category: string, specs?: { has(n: string): boolean }): { ok: boolean; rule: string } {
  return nameCheck(name, familyKind(category, name), specs);
}

/**
 * A conforming name close to the current one: separators made underscores, words joined in PascalCase, FMC_ added to
 * <Role>_<Token>_<Description>. null when nothing close passes (a person names it).
 */
export function suggestFamilyName(name: string, category: string, specs?: { has(n: string): boolean }): string | null {
  const parts = String(name ?? "").trim().split(/[_\s\-.]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const pascal = (w: string) => (/^[A-Z0-9]+$/.test(w) && w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1)).replace(/[^A-Za-z0-9]/g, "");
  const tries: string[] = [];
  const body = parts[0].toUpperCase() === "FMC" ? parts.slice(1) : parts;
  if (body.length >= 3) {
    const role = body[0].toUpperCase(), token = pascal(body[1]), desc = body.slice(2).map(pascal).join("");
    tries.push(`FMC_${role}_${token}_${desc}`);
    tries.push(`FMC_${role}_${token}_${body.slice(2).map(pascal).join("_")}`);
  }
  for (const t of tries) if (t !== name && familyNameOk(t, category, specs).ok && !nameProblems(t + ".rfa").length) return t;
  return null;
}

/**
 * What the kit defines for reference plane names (searched 28 Nov: kit rulebook FAM-008 "Name the planes Center (Left/Right),
 * Front and Back, and mark them Strong" (STD 4.1), and docs/FAMILY_AUTHORING_STANDARD.md 1.2: Center (Left/Right),
 * Center (Front/Back), Left, Right, Front, Back, Top, Bottom). It is a fixed vocabulary, not a positional scheme. Only the
 * two centre planes follow from where a plane is: the origin planes, x = 0 and y = 0. Left, Right, Front, Back, Top and Bottom
 * are design choices (which unnamed plane is the left one?) and are never derived from a position.
 */
export const KIT_PLANE_NAMES: ReadonlyArray<{ axis: "x" | "y"; at_mm: number; name: string; rule: string }> = [
  { axis: "x", at_mm: 0, name: "Center (Left/Right)", rule: "FAM-008" },
  { axis: "y", at_mm: 0, name: "Center (Front/Back)", rule: "FAM-008" },
];
/** The kit's name for an unnamed plane square to x or y at the origin (within 0.5 mm); null for any other plane. */
export function kitPlaneName(p: { axis: string; at_mm: number }): string | null {
  const hit = KIT_PLANE_NAMES.find((k) => k.axis === p.axis && Math.abs(k.at_mm - p.at_mm) <= 0.5);
  return hit ? hit.name : null;
}
/** The words that mark an RP_ name as the tool's own: there is no kit rule for a position-based plane name. */
export const PROVISIONAL_PLANE_NOTE = "RP_ names are provisional: the kit has no positional plane naming rule (FAM-008 names only Center (Left/Right), Center (Front/Back), Left, Right, Front, Back, Top, Bottom); the owner should define one";

/** PROVISIONAL placeholder (no kit rule, see KIT_PLANE_NAMES): a plane name from its position, e.g. RP_X+450 or RP_Z-120.5. */
export function positionalPlaneName(p: { axis: string; at_mm: number }): string {
  const mm = Math.round(p.at_mm * 10) / 10;
  return `RP_${p.axis.toUpperCase()}${mm >= 0 ? "+" : ""}${mm}`;
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

function namingGate(f: EvolveFacts, kit: EvolveKit, o: EvolveOptions, out: Evaluation) {
  const now = familyNameOk(f.family, f.category, kit.specs);
  const wanted = (o.new_name ?? "").trim().replace(/\.rfa$/i, "");
  if (wanted) {
    const w = familyNameOk(wanted, f.category, kit.specs);
    const probs = nameProblems(wanted + ".rfa");
    if (!w.ok || probs.length) { out.problems.push(`new_name ${wanted} doesn't follow the kit's naming rule (${w.rule})${probs.length ? `: ${probs.join("; ")}` : ""}`); }
    else if (wanted !== f.family) {
      out.target_name = wanted;
      out.fixes.push({ id: "naming.rename", gate: "naming", summary: `Save the new version as ${wanted}.rfa (was ${f.family})`, ops: [], rename_to: wanted });
    }
  }
  if (now.ok) { out.gates.push({ gate: "naming", state: "Pass", detail: `${f.family} · ${now.rule}`, findings: [] }); return; }
  const finding = `${f.family} doesn't follow ${now.rule}`;
  if (out.target_name !== f.family) { out.gates.push({ gate: "naming", state: "Fail", detail: `${finding}; the new version is named ${out.target_name}`, findings: [finding] }); return; }
  const suggested = suggestFamilyName(f.family, f.category, kit.specs);
  if (suggested) {
    out.target_name = suggested;
    out.fixes.push({ id: "naming.rename", gate: "naming", summary: `Save the new version as ${suggested}.rfa (was ${f.family}); pass new_name to choose another`, ops: [], rename_to: suggested });
  } else out.needs_person.push({ gate: "naming", detail: `${finding}: give new_name (for example FMC_<Role>_<CategoryToken>_<Description>)` });
  out.gates.push({ gate: "naming", state: "Fail", detail: finding, findings: [finding] });
}

function sharedGate(f: EvolveFacts, kit: EvolveKit, o: EvolveOptions, out: Evaluation) {
  if (!kit.dictionary) { out.gates.push({ gate: "shared_parameters", state: "Not checked", detail: "The kit's shared parameter file isn't readable", findings: [] }); return; }
  const byGuid = new Map([...kit.dictionary.values()].map((p) => [p.guid.toLowerCase(), p]));
  // the spec of the name the new version will carry first, then the current name
  const specName = kit.specs.has(out.target_name) ? out.target_name : f.family;
  const spec = kit.specs.get(specName);
  const fromSpec = requiredParameters(specName, kit.specs, kit.dictionary) ?? [];
  const extra: SpParam[] = [];
  for (const n of o.required_parameters ?? []) {
    const p = kit.dictionary.get(n);
    if (!p) out.problems.push(`required parameter ${n} isn't in FMC_SharedParameters.txt (a kit change request)`);
    else if (!fromSpec.some((q) => q.guid.toLowerCase() === p.guid.toLowerCase())) extra.push(p);
  }
  const required = [...fromSpec, ...extra];
  const findings: string[] = [], warn: string[] = [];
  const add: Array<Record<string, unknown>> = [], bind: Array<Record<string, unknown>> = [];
  for (const p of required) {
    const binding = spec?.shared_parameters.find((s) => s.name === p.name)?.binding;
    const instance = binding ? /instance/i.test(binding) : false;
    const byG = f.parameters.find((x) => x.shared && x.guid.toLowerCase() === p.guid.toLowerCase());
    if (byG) continue;
    const byN = f.parameters.find((x) => x.name === p.name);
    if (!byN) { findings.push(`${p.name} missing`); add.push({ op: "add_shared_param", name: p.name, guid: p.guid, instance, group: "Data" }); }
    else if (!byN.shared) { findings.push(`${p.name} is a family parameter, not bound to the kit's GUID ${p.guid}`); bind.push({ op: "bind_shared_param", name: p.name, guid: p.guid, ...(byN.instance != null ? { instance: byN.instance } : {}) }); }
    else {
      findings.push(`${p.name} is shared with GUID ${byN.guid}, not the kit's ${p.guid}`);
      out.needs_person.push({ gate: "shared_parameters", detail: `${p.name} carries another shared GUID (${byN.guid}); the kit's is ${p.guid}: a person replaces it in the Family Editor (values held by that GUID would be lost)` });
    }
  }
  for (const x of f.parameters.filter((x) => x.shared)) {
    const k = byGuid.get(x.guid.toLowerCase());
    if (!k) warn.push(`${x.name} (${x.guid}) isn't in the kit's dictionary`);
    else if (k.name !== x.name) warn.push(`${x.name} carries the kit GUID of ${k.name}`);
  }
  if (bind.length) out.fixes.push({ id: "shared_parameters.bind", gate: "shared_parameters", summary: `Bind ${bind.length} family parameter(s) to the kit's shared GUID: ${bind.map((b) => b.name).join(", ")}`, ops: bind });
  if (add.length) out.fixes.push({ id: "shared_parameters.add", gate: "shared_parameters", summary: `Add ${add.length} kit shared parameter(s): ${add.map((b) => b.name).join(", ")}`, ops: add });
  if (!required.length) {
    // F-039: never a pass on 0
    out.gates.push({ gate: "shared_parameters", state: "Not checked", detail: spec ? `The kit spec for ${specName} names no shared parameter the dictionary has` : `The kit has no spec for ${specName}: pass required_parameters, or a person decides`, findings: warn });
    return;
  }
  const state: GateState = findings.length ? "Fail" : warn.length ? "Warn" : "Pass";
  out.gates.push({ gate: "shared_parameters", state, findings: [...findings, ...warn],
    detail: findings.length ? `${required.length - findings.length} of ${required.length} present and bound; ${findings.join("; ")}`
      : `${required.length} of ${required.length} present and bound by GUID${warn.length ? `; ${warn.join("; ")}` : ""}` });
}

function planesGate(f: EvolveFacts, o: EvolveOptions, out: Evaluation) {
  const names = f.reference_planes ?? [];
  const dup = [...new Set(names.filter((n, i) => !isUnnamedPlane(n) && names.indexOf(n) !== i))];
  if (!f.reference_planes_detail) {
    const unnamed = names.filter(isUnnamedPlane).length;
    out.gates.push({ gate: "reference_planes", state: unnamed ? "Fail" : dup.length ? "Warn" : names.length ? "Pass" : "Not checked",
      detail: unnamed ? `${unnamed} of ${names.length} planes unnamed; this add-in doesn't report where they are, so no fix is proposed (update the add-in)` : names.length ? `${names.length} planes, all named${dup.length ? `; duplicate names: ${dup.join(", ")}` : ""}` : "No planes reported",
      findings: unnamed ? [`${unnamed} unnamed`] : [] });
    if (unnamed) out.needs_person.push({ gate: "reference_planes", detail: `${unnamed} unnamed planes: update the add-in so their positions are reported, or name them by hand` });
    return;
  }
  const planes = f.reference_planes_detail;
  const unnamed = planes.filter((p) => isUnnamedPlane(p.name));
  const taken = new Set(planes.filter((p) => !isUnnamedPlane(p.name)).map((p) => p.name));
  const ops: Array<Record<string, unknown>> = [];
  const left: PlaneFact[] = [];
  const provisional: string[] = [], kitNamed: string[] = [];
  for (const p of unnamed) {
    const given = (o.plane_names ?? []).find((g) => g.axis === p.axis && near(g.at_mm, p.at_mm));
    // a name the person gave wins; then the kit's own (the two centre planes); then, only if asked, the provisional RP_ placeholder
    const candidates: Array<{ name: string; how: "given" | "kit" | "provisional" }> = [];
    if (given?.name?.trim()) candidates.push({ name: given.name.trim(), how: "given" });
    const kitName = p.axis ? kitPlaneName(p) : null;
    if (kitName) candidates.push({ name: kitName, how: "kit" });
    if (o.auto_name_planes && p.axis) candidates.push({ name: positionalPlaneName(p), how: "provisional" });
    // two unnamed planes at one spot can't be told apart by name_template_plane: a person names them
    const twin = unnamed.filter((q) => q !== p && q.axis === p.axis && near(q.at_mm, p.at_mm)).length > 0;
    const pick = p.axis && !twin ? candidates.find((c) => !taken.has(c.name)) : undefined;
    if (!pick) { left.push(p); continue; }
    taken.add(pick.name);
    if (pick.how === "provisional") provisional.push(pick.name);
    if (pick.how === "kit") kitNamed.push(pick.name);
    ops.push({ op: "name_template_plane", name: pick.name, axis: p.axis, at_mm: Math.round(p.at_mm * 10) / 10 });
  }
  if (ops.length) out.fixes.push({ id: "reference_planes.name", gate: "reference_planes",
    summary: `Name ${ops.length} unnamed plane(s): ${ops.map((x) => `${x.name} (${x.axis} = ${x.at_mm} mm)`).join(", ")}` +
      (kitNamed.length ? `; ${kitNamed.join(", ")} from the kit's FAM-008` : "") + (provisional.length ? `; ${PROVISIONAL_PLANE_NOTE}` : ""),
    ops, ...(provisional.length ? { provisional } : {}), ...(kitNamed.length ? { kit_rule: "FAM-008" } : {}) });
  for (const p of left) out.needs_person.push({ gate: "reference_planes", detail: `unnamed plane ${p.axis ? `square to ${p.axis} at ${Math.round(p.at_mm * 10) / 10} mm` : "at an angle"}: give its name in plane_names${p.axis ? ` (or auto_name_planes: ${positionalPlaneName(p)}, a provisional name: the kit has no rule for it)` : ""}` });
  const findings = unnamed.map((p) => `unnamed ${p.axis || "oblique"} plane at ${Math.round(p.at_mm * 10) / 10} mm`);
  out.gates.push({ gate: "reference_planes", state: unnamed.length ? "Fail" : dup.length ? "Warn" : planes.length ? "Pass" : "Not checked", findings,
    detail: unnamed.length ? `${unnamed.length} of ${planes.length} planes unnamed` : planes.length ? `${planes.length} planes, all named${dup.length ? `; duplicate names: ${dup.join(", ")}` : ""}` : "The family has no reference planes" });
}

function flexGate(f: EvolveFacts, out: Evaluation) {
  const flex = f.flex;
  const usable = !!flex && !flex.error && !flex.refused && (Array.isArray(flex.types) || flex.ok === true);
  const err = f.flexError || (flex && !usable ? String(flex.error ?? (flex.reasons ?? []).join("; ")) : "");
  if (!usable || !flex) { out.gates.push({ gate: "flex", state: "Not checked", detail: `Flex didn't run${err ? `: ${err}` : ""}`, findings: [] }); return; }
  const types = flex.types ?? [];
  const failing = types.filter((t) => !t.ok);
  const findings = failing.map((t) => `${t.type}${t.errors?.length ? `: ${t.errors[0]}` : " doesn't regenerate"}`);
  const sides = sidesLine(flex, usable, err, null);
  if (sides.state === "Fail") findings.push(sides.detail);
  const notMoved = (flex.follow?.params ?? []).filter((p) => !p.ok).map((p) => `${p.param} didn't move${p.error ? ` (${p.error})` : ""}`);
  const stuck = (flex.follow?.elements ?? []).filter((e) => !e.no_box && !e.moved.length && (flex.follow?.params ?? []).some((p) => p.ok)).map((e) => `${e.name} follows no size parameter`);
  findings.push(...notMoved);
  const state: GateState = failing.length || sides.state === "Fail" || notMoved.length ? "Fail" : flex.unfinished || stuck.length ? "Warn" : "Pass";
  for (const x of findings) out.needs_person.push({ gate: "flex", detail: `${x}: fix the constraints in the Family Editor (no tool decides geometry)` });
  out.gates.push({ gate: "flex", state, findings: [...findings, ...stuck],
    detail: (failing.length ? `${failing.length} of ${types.length} types fail: ${findings.slice(0, 3).join("; ")}` : `${types.length || "all"} types regenerate`) +
      (sides.state !== "Not checked" ? `; ${sides.detail}` : "") + (flex.follow ? `; ${(flex.follow.params ?? []).filter((p) => p.ok).length} size parameter(s) moved` : "") +
      (stuck.length ? `; ${stuck.slice(0, 3).join("; ")}` : "") + (flex.unfinished ? `; checked ${flex.unfinished.checked} of ${flex.unfinished.of} types before the time limit` : "") });
}

function keynoteGate(f: EvolveFacts, kit: EvolveKit, o: EvolveOptions, out: Evaluation) {
  const kind = familyKind(f.category, f.family);
  if (kind === "title block" || kind === "annotation") { out.gates.push({ gate: "keynote", state: "Pass", detail: `Not applied to ${kind}s: they carry no keynote`, findings: [] }); return; }
  if (!f.type_keynotes) { out.gates.push({ gate: "keynote", state: "Not checked", detail: "This add-in doesn't read type keynotes from the file: update the add-in", findings: [] }); return; }
  const given = (t: string) => typeof o.keynote === "string" ? o.keynote : o.keynote?.[t];
  const findings: string[] = [], warn: string[] = [];
  const ops: Array<Record<string, unknown>> = [];
  for (const t of f.type_keynotes) {
    const now = t.keynote.trim();
    const g = (given(t.type) ?? "").trim();
    if (g && !KEYNOTE_FORMAT.test(g)) { out.problems.push(`keynote ${g} for ${t.type} isn't X.YYY_ZZ (for example S.FND_01)`); continue; }
    const ok = KEYNOTE_FORMAT.test(now);
    if (!ok) findings.push(now ? `${t.type}: ${now} isn't X.YYY_ZZ` : `${t.type}: no keynote`);
    const want = g || (!ok && now ? normalizeKeynote(now) : null);
    if (want && want !== now) ops.push({ op: "set_type_value", name: `${t.type}/Keynote`, type: t.type, param: "Keynote", value: want });
    else if (!ok) out.needs_person.push({ gate: "keynote", detail: `${t.type}: ${now ? `${now} can't be read as X.YYY_ZZ` : "no keynote"}: pass keynote (the kit's code; fmc_library keynotes lists them)` });
    const final = want ?? (ok ? now : "");
    if (final && kit.keynotes && !kit.keynotes.has(final)) warn.push(`${t.type}: ${final} isn't in the kit's keynote file (fmc_library keynote_request)`);
  }
  if (ops.length) out.fixes.push({ id: "keynote.set", gate: "keynote", summary: `Set the keynote on ${ops.length} type(s): ${ops.map((x) => `${x.type} ${x.value}`).slice(0, 4).join(", ")}${ops.length > 4 ? ", …" : ""}`, ops });
  if (!f.type_keynotes.length) { out.gates.push({ gate: "keynote", state: "Not checked", detail: "The family has no types to keynote", findings: [] }); return; }
  out.gates.push({ gate: "keynote", state: findings.length ? "Fail" : warn.length ? "Warn" : "Pass", findings: [...findings, ...warn],
    detail: findings.length ? `${findings.length} of ${f.type_keynotes.length} types: ${findings.slice(0, 3).join("; ")}` : `${f.type_keynotes.length} types keynoted X.YYY_ZZ${warn.length ? `; ${warn.slice(0, 2).join("; ")}` : ""}` });
}

/** The five gates on the family's facts, with the fixes a tool may make and what only a person can decide. */
export function evaluateGates(f: EvolveFacts, kit: EvolveKit, o: EvolveOptions = {}): Evaluation {
  const out: Evaluation = { gates: [], fixes: [], needs_person: [], target_name: f.family, problems: [] };
  namingGate(f, kit, o, out);
  sharedGate(f, kit, o, out);
  planesGate(f, o, out);
  flexGate(f, out);
  keynoteGate(f, kit, o, out);
  return out;
}

/** The fixes' ops in apply order: planes, then bind, then add, then keynotes (a fix id keeps its own order). */
export function orderedOps(fixes: Fix[]): Array<Record<string, unknown>> {
  const rank = ["reference_planes.name", "shared_parameters.bind", "shared_parameters.add", "keynote.set"];
  return [...fixes].sort((a, b) => rank.indexOf(a.id) - rank.indexOf(b.id)).flatMap((x) => x.ops);
}

/** The confirm token: the same source bytes, target and ops give the same token; anything else a new one. */
export function proposalToken(source: string, sourceSha: string, targetName: string, ops: Array<Record<string, unknown>>): string {
  const h = createHash("sha256").update(JSON.stringify([win.normalize(source).toLowerCase(), sourceSha, targetName, ops])).digest("hex");
  return "EV-" + h.slice(0, 16);
}

/** Expected state of each gate once the chosen fixes are made (a preview: apply re-checks the saved version). */
export function expectedAfter(ev: Evaluation, accepted: Set<string>): Array<{ gate: EvolveGate; now: GateState; expected: GateState; why: string }> {
  return ev.gates.map((g) => {
    if (g.state === "Pass" || g.state === "Not checked") return { gate: g.gate, now: g.state, expected: g.state, why: "" };
    const fixes = ev.fixes.filter((x) => x.gate === g.gate && accepted.has(x.id));
    const people = ev.needs_person.filter((p) => p.gate === g.gate);
    if (!fixes.length) return { gate: g.gate, now: g.state, expected: g.state, why: people.length ? "needs a person" : "no fix chosen" };
    return { gate: g.gate, now: g.state, expected: people.length ? g.state : "Pass", why: people.length ? `${fixes.length} fix(es), and ${people.length} item(s) need a person` : fixes.map((x) => x.summary).join("; ") };
  });
}

/** Gate by gate, before against after: fixed, regressed, or the same. */
export function diffGates(before: GateResult[], after: GateResult[]): Array<{ gate: EvolveGate; before: GateState; after: GateState; change: "fixed" | "improved" | "regressed" | "same" }> {
  const rank: Record<GateState, number> = { "Fail": 0, "Not checked": 1, "Warn": 2, "Pass": 3 };
  return EVOLVE_GATES.map((gate) => {
    const b = before.find((g) => g.gate === gate)?.state ?? "Not checked", a = after.find((g) => g.gate === gate)?.state ?? "Not checked";
    const change = a === b ? "same" : a === "Pass" && b === "Fail" ? "fixed" : rank[a] > rank[b] ? "improved" : "regressed";
    return { gate, before: b, after: a, change };
  });
}

/** What changed in the family itself: name, parameters added or bound, planes named, keynotes. */
export function diffFacts(before: EvolveFacts, after: EvolveFacts) {
  const key = (p: ParamFact) => p.name;
  const added = after.parameters.filter((p) => !before.parameters.some((q) => key(q) === key(p))).map((p) => `${p.name}${p.shared ? ` (${p.guid})` : ""}`);
  const bound = after.parameters.filter((p) => p.shared && before.parameters.some((q) => q.name === p.name && !q.shared)).map((p) => `${p.name} → ${p.guid}`);
  const removed = before.parameters.filter((p) => !after.parameters.some((q) => q.name === p.name)).map((p) => p.name);
  const named = (after.reference_planes ?? []).filter((n) => !isUnnamedPlane(n) && !(before.reference_planes ?? []).includes(n));
  const keynotes = (after.type_keynotes ?? []).map((t) => ({ type: t.type, before: before.type_keynotes?.find((x) => x.type === t.type)?.keynote ?? "", after: t.keynote }))
    .filter((k) => k.before !== k.after);
  return { name: before.family === after.family ? null : { before: before.family, after: after.family }, parameters_added: added, parameters_bound: bound,
    parameters_removed: removed, planes_named: named, keynotes, types_before: before.types.length, types_after: after.types.length };
}

/** Types that regenerated before and fail now: the apply is stopped and nothing is saved. */
export function flexRegressions(before: GateInputs["flex"], after: GateInputs["flex"]): string[] {
  const ok = new Set((before?.types ?? []).filter((t) => t.ok).map((t) => t.type));
  return (after?.types ?? []).filter((t) => !t.ok && ok.has(t.type)).map((t) => `${t.type}${t.errors?.length ? `: ${t.errors[0]}` : ""}`);
}

// ---------- versions and backups ----------

export interface VersionEntry { n: number; file: string; sha256: string | null; backup: boolean }

export interface VersionPlan {
  /** <root>\_Evolve\<family>: every version of this family, v001 the original's backup. */
  dir: string;
  backup: { path: string; reuse: boolean; n: number };
  target: { path: string; n: number };
  problems: string[];
}

export const EVOLVE_FOLDER = "_Evolve";
/** A folder name the staging and library scanners leave out: evolve versions are history, not a family in staging (F127). */
export function isEvolveDir(name: string): boolean {
  return /^_Evolve$/i.test(String(name ?? "").trim());
}
/** True when a path has an _Evolve folder in it (a version tree, or a file inside one). */
export function underEvolveFolder(file: string): boolean {
  return file.replace(/\\/g, "/").split("/").some((s) => isEvolveDir(s));
}

export const vName = (n: number) => "v" + String(n).padStart(3, "0");

/**
 * Where the backup and the new version go. Beside the source when it is in a write root (staging); else in the
 * staging root under the family's role. The original's bytes are backed up once per content: a version folder that
 * already holds the same bytes (by sha256) is reused, else the next number. The new version takes the number after.
 */
export function planVersions(source: string, sourceSha: string, targetName: string, cfg: Pick<GuardConfig, "write_roots" | "library_roots" | "blocked_segments" | "family_staging_root">,
  existing: VersionEntry[]): VersionPlan {
  const family = win.basename(source).replace(/\.rfa$/i, "");
  const srcDir = win.dirname(source);
  const besideOk = cfg.write_roots.some((r) => isInside(source, r)) && cfg.library_roots.some((r) => isInside(source, r));
  // a released family's folder is its role (04_Families\<Role>), so a version keeps one place whatever it is named
  const folderRole = /^[A-Z]{1,2}$/.test(win.basename(srcDir)) ? win.basename(srcDir) : "";
  const root = besideOk ? srcDir : win.join(cfg.family_staging_root, roleOf(family) || folderRole || roleOf(targetName) || "_Unsorted");
  const dir = win.join(root, EVOLVE_FOLDER, family);
  const same = existing.find((e) => e.backup && e.sha256 && e.sha256 === sourceSha);
  const top = existing.reduce((m, e) => Math.max(m, e.n), 0);
  const backupN = same ? same.n : top + 1;
  const backupPath = same ? same.file : win.join(dir, vName(backupN), family + ".rfa");
  const targetN = Math.max(top, backupN) + 1;
  const targetPath = win.join(dir, vName(targetN), targetName + ".rfa");
  const problems: string[] = [];
  const cfgFull = { ...cfg } as GuardConfig;
  // the backup is a byte copy under the original's own name: the write roots and blocked folders hold, the name is the original's
  if (!same) problems.push(...checkWritePath(backupPath, cfgFull, { checkName: false }).reasons.map((r) => `backup: ${r}`));
  problems.push(...checkWritePath(targetPath, cfgFull).reasons.map((r) => `new version: ${r}`));
  if (!cfg.library_roots.some((r) => isInside(backupPath, r))) problems.push(`backup: ${backupPath} isn't in the library roots, so it can't be opened as a session`);
  if (win.normalize(targetPath).toLowerCase() === win.normalize(source).toLowerCase()) problems.push("the new version would be the original itself");
  return { dir, backup: { path: backupPath, reuse: !!same, n: backupN }, target: { path: targetPath, n: targetN }, problems: [...new Set(problems)] };
}

/** The version folders under an _Evolve family folder, from a directory listing: vNNN\<file>.rfa. */
export function readVersions(listing: Array<{ folder: string; files: string[] }>, dir: string, manifests: Map<string, { backup?: boolean; sha256?: string }>,
  sha: (file: string) => string | null): VersionEntry[] {
  const out: VersionEntry[] = [];
  for (const l of listing) {
    const m = /^v(\d{3,})$/.exec(l.folder);
    if (!m) continue;
    const rfa = l.files.find((f) => /\.rfa$/i.test(f) && !/\.\d{4}\.rfa$/i.test(f));
    if (!rfa) continue;
    const file = win.join(dir, l.folder, rfa);
    const man = manifests.get(l.folder);
    out.push({ n: Number(m[1]), file, sha256: man?.sha256 ?? sha(file), backup: man?.backup === true });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** apply's checks on a stored proposal before Revit is asked anything. */
export function applyProblems(p: { token: string; source: string; source_sha256: string; created: string; fixes: Fix[] } | null, token: string,
  currentSha: string | null, accept: string[] | undefined, now: Date, maxHours = 24): string[] {
  if (!token.trim()) return ["apply needs the token from check (a dry run first)"];
  if (!p) return [`No proposal ${token}: run check again`];
  if (p.token !== token.trim()) return [`The token ${token} doesn't match the proposal`];
  const out: string[] = [];
  const age = (now.getTime() - Date.parse(p.created)) / 3600000;
  if (!Number.isFinite(age) || age > maxHours) out.push(`The proposal is older than ${maxHours} h: run check again`);
  if (!currentSha) out.push(`${p.source} can't be read now`);
  else if (currentSha !== p.source_sha256) out.push(`${win.basename(p.source)} changed since check: run check again`);
  for (const id of accept ?? []) if (!p.fixes.some((f) => f.id === id)) out.push(`accept: ${id} isn't one of the proposal's fixes (${p.fixes.map((f) => f.id).join(", ") || "none"})`);
  if (!p.fixes.length) out.push("The proposal has no fixes: nothing to apply");
  return out;
}
