import { projectFamily, ROLE_CODES } from "./policy.js";
import { FamilySpec, SpParam } from "./specs.js";

/**
 * Families against the kit (board manage/PaneFamilies, U15). Pure: the facts come from Revit (fmc_family_scan,
 * fmc_family_inspect), the reference from the kit (FMC_Family_Specs.json, FMC_SharedParameters.txt, FMC_Keynotes.txt).
 *
 * A family is compliant when every check that applies passes; fixable when only what a tool can fix fails (name,
 * parameters, keynote); otherwise it needs a person (type names, a family the kit has no spec for, CAD, size).
 */
export type CheckState = "pass" | "fail" | "na";
/** applies: false when the family's kind leaves the check out (F-045: no keynote on a title block), not a gap. */
export interface FamilyCheck { check: string; state: CheckState; detail: string; fixable: boolean; applies?: boolean }
export interface FamilyVerdict {
  name: string; category: string; from: string; score: number;
  state: "Compliant" | "Fixable" | "Needs a person"; checks: FamilyCheck[]; next: string;
}

export interface ScannedFamily {
  name: string; category: string; placed?: number;
  types: Array<{ name: string; keynote: string }>;
  shared_guids: string[];
  /** Only known for a file opened on its own (inspect): size, imported CAD, nested families. */
  size_mb?: number; imported_cad?: number; nested?: number;
}

export const CHECKS = [
  "Name follows FMC_[Role]_[Category]_[Description]",
  "Required FMC parameters present (by GUID)",
  "Keynote set",
  "File size under 2 MB, no imported CAD",
  "Type names [KeySize]_[Variant]",
];

const LIBRARY_NAME = /^FMC_([A-Z]{1,2})_([A-Za-z0-9]+)_([A-Za-z0-9]+(_[A-Za-z0-9]+)*)$/;
const TYPE_NAME = /^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$/;
/** The kit register's own naming for the families that aren't model families (FMC_Family_Register.csv). */
const PROFILE_NAME = /^FMC_Profile_[A-Za-z0-9]+(_[A-Za-z0-9]+)*$/;
const TITLE_BLOCK_NAME = /^FMC_(TitleBlock|TB_[A-Za-z0-9]+)(_[A-Za-z0-9]+)*$/;
const ANNOTATION_NAME = /^FMC_(SYM|TAG|GA)_[A-Za-z0-9]+(_[A-Za-z0-9]+)*$/;

/**
 * F-045 (issue #146): a family's kind decides which Gate A rules apply. Profiles (FMC_Profile_<Element>…, keynoted with
 * the trim and ornament codes), title blocks (FMC_TitleBlock, FMC_TB_*) and annotations (FMC_SYM_*, FMC_TAG_*, FMC_GA_*)
 * are named and typed by the register's own rules, not FMC_[Role]_[Token]_[Description] and [KeySize]_[Variant].
 * Read from the family's Revit category; the name decides only when the category isn't known.
 */
export type FamilyKind = "model" | "profile" | "title block" | "annotation";

export function familyKind(category: string, name = ""): FamilyKind {
  const c = category.toLowerCase().replace(/\(.*?\)/g, "").trim();
  if (c) {
    if (/^profiles?$/.test(c)) return "profile";
    if (/^title blocks?$/.test(c)) return "title block";
    if (/annotation|\btags?$|\bheads?$|\bmarks?$|\bsymbols?$|^view titles?$|^view reference|\btails?$/.test(c)) return "annotation";
    return "model";
  }
  if (PROFILE_NAME.test(name)) return "profile";
  if (/^FMC_(TitleBlock|TB_)/.test(name)) return "title block";
  if (ANNOTATION_NAME.test(name)) return "annotation";
  return "model";
}

const MODEL_RULE = "FMC_[Role]_[CategoryToken]_[Description]";
const KIND_RULE: Record<FamilyKind, string> = {
  "model": MODEL_RULE,
  "profile": `FMC_Profile_<Element>[_<Token>] (or ${MODEL_RULE})`,
  "title block": "FMC_TitleBlock or FMC_TB_<Name>",
  "annotation": "FMC_SYM_ / FMC_TAG_ / FMC_GA_<…> (or FMC_TB_ when nested in a title block)",
};

/** The model-family rule: a library name with a kit role code, or a project family (D4). */
export function nameOk(name: string): boolean {
  const lib = LIBRARY_NAME.exec(name);
  if (lib) return ROLE_CODES.includes(lib[1]);
  return projectFamily(name + ".rfa") != null;
}

/** The naming rule for this kind; a name the kit's Family Register (the specs) lists is the kit's own and passes. */
export function nameCheck(name: string, kind: FamilyKind, kitNames?: { has(n: string): boolean }): { ok: boolean; rule: string } {
  if (kitNames?.has(name)) return { ok: true, rule: "named in the kit's Family Register" };
  const rule = KIND_RULE[kind];
  switch (kind) {
    case "profile": return { ok: PROFILE_NAME.test(name) || nameOk(name), rule };
    case "title block": return { ok: TITLE_BLOCK_NAME.test(name), rule };
    case "annotation": return { ok: ANNOTATION_NAME.test(name) || TITLE_BLOCK_NAME.test(name), rule };
    default: return { ok: nameOk(name), rule };
  }
}

/** The required shared parameters for a family: from its spec in FMC_Family_Specs.json, with GUIDs from the kit's file. */
export function requiredParameters(name: string, specs: Map<string, FamilySpec>, kit: Map<string, SpParam>): SpParam[] | null {
  const spec = specs.get(name);
  if (!spec) return null;
  return spec.shared_parameters.map((p) => kit.get(p.name)).filter((p): p is SpParam => !!p);
}

export function checkFamily(f: ScannedFamily, specs: Map<string, FamilySpec>, kit: Map<string, SpParam>, from = "Loaded"): FamilyVerdict {
  const checks: FamilyCheck[] = [];
  const kind = familyKind(f.category, f.name);
  const kindNote = kind === "model" ? "" : ` (${kind} family)`;
  const named = nameCheck(f.name, kind, specs);
  checks.push({ check: CHECKS[0], state: named.ok ? "pass" : "fail", fixable: true,
    detail: named.ok ? `${f.name}${kind === "model" && named.rule === MODEL_RULE ? "" : ` · ${named.rule}${kindNote}`}` : `${f.name} doesn't follow the kit's naming rule for this kind: ${named.rule}${kindNote}` });

  const required = requiredParameters(f.name, specs, kit);
  if (!required) checks.push({ check: CHECKS[1], state: "na", detail: "The kit has no spec for this family, so a person decides its parameters", fixable: false });
  else if (!required.length) {
    // F-039: never Pass on 0. The spec names no parameter the kit's dictionary has, so nothing was checked.
    const named = specs.get(f.name)?.shared_parameters.map((p) => p.name) ?? [];
    checks.push({ check: CHECKS[1], state: "fail", fixable: false,
      detail: `0 required: the kit spec for ${f.name} names ${named.length ? `${named.length} that FMC_SharedParameters.txt doesn't have (${named.slice(0, 5).join(", ")})` : "no shared parameters"}, a kit change request; the file carries ${f.shared_guids.length} shared parameters` });
  } else {
    const have = new Set(f.shared_guids.map((g) => g.toLowerCase()));
    const missing = required.filter((p) => !have.has(p.guid.toLowerCase()));
    checks.push({ check: CHECKS[1], state: missing.length ? "fail" : "pass",
      detail: missing.length ? `Missing ${missing.length}: ${missing.slice(0, 5).map((p) => p.name).join(", ")}${missing.length > 5 ? "…" : ""}` : `${required.length} present`,
      fixable: true });
  }

  // F-045: title blocks and annotations carry no keynote; profiles do (the trim, ornament and moulding codes)
  const noKeynote = f.types.filter((t) => !t.keynote.trim());
  if (kind === "title block" || kind === "annotation")
    checks.push({ check: CHECKS[2], state: "na", applies: false, fixable: false, detail: `Not applied to ${kind}s: they carry no keynote` });
  else checks.push({ check: CHECKS[2], state: f.types.length && !noKeynote.length ? "pass" : "fail",
    detail: noKeynote.length ? `${noKeynote.length} of ${f.types.length} types have no keynote${kindNote}` : `${f.types.length} types`, fixable: true });

  if (f.size_mb == null) checks.push({ check: CHECKS[3], state: "na", detail: "Checked when the family file is opened (Bring in)", fixable: false });
  else {
    const bad = f.size_mb >= 2 || (f.imported_cad ?? 0) > 0;
    checks.push({ check: CHECKS[3], state: bad ? "fail" : "pass", detail: `${f.size_mb} MB · ${f.imported_cad ?? 0} imported CAD`, fixable: false });
  }

  // F-045: profiles are typed by design movement or size (Greek, 300), title blocks by sheet size (A1)
  const badTypes = f.types.filter((t) => !TYPE_NAME.test(t.name));
  if (kind !== "model")
    checks.push({ check: CHECKS[4], state: "na", applies: false, fixable: false, detail: `Not applied to ${kind}s: the register names their types (theme, size or sheet)` });
  else checks.push({ check: CHECKS[4], state: badTypes.length ? "fail" : "pass",
    detail: badTypes.length ? `${badTypes.length} don't: ${badTypes.slice(0, 3).map((t) => t.name).join(", ")}` : `${f.types.length} types`, fixable: false });

  const applicable = checks.filter((c) => c.state !== "na");
  const failed = applicable.filter((c) => c.state === "fail");
  const score = applicable.length ? Math.round((100 * (applicable.length - failed.length)) / applicable.length) : 0;
  const unknown = checks.some((c) => c.state === "na" && c.applies !== false && !c.check.startsWith("File size"));
  const state = failed.length === 0 && !unknown ? "Compliant" : failed.every((c) => c.fixable) && !unknown ? "Fixable" : "Needs a person";
  const next = state === "Compliant" ? "Nothing: it meets the Families rulebook"
    : state === "Fixable" ? "Bring it in again: rename, add the kit's parameters and set the keynote in one pass"
    : failed.find((c) => !c.fixable)?.detail ?? checks.find((c) => c.state === "na")?.detail ?? "A person decides";
  return { name: f.name, category: f.category, from, score, state, checks, next };
}

export function summarise(verdicts: FamilyVerdict[]) {
  return {
    scanned: verdicts.length,
    compliant: verdicts.filter((v) => v.state === "Compliant").length,
    fixable: verdicts.filter((v) => v.state === "Fixable").length,
    need_a_person: verdicts.filter((v) => v.state === "Needs a person").length,
    // F-010: a check that couldn't run (no kit spec) is counted apart, so zero failures never reads as a pass.
    by_check: CHECKS.map((c) => {
      const n = (state: CheckState, applies = true) => verdicts.filter((v) => v.checks.some((x) => x.check === c && x.state === state && (x.applies !== false) === applies)).length;
      return { check: c, fail: n("fail"), pass: n("pass"), not_checked: n("na"), not_applied: n("na", false) };
    }),
  };
}

/** Category token per Revit category, learned from the kit's own family names (FMC_<Role>_<Token>_…). */
export function categoryTokens(specs: FamilySpec[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of specs) {
    const m = LIBRARY_NAME.exec(s.family);
    if (m && !map.has(s.category)) map.set(s.category, m[2]);
  }
  return map;
}

/** The standard name for a brought-in family: FMC_<Role>_<CategoryToken>_<Description>. */
export function standardName(role: string, token: string, description: string): string {
  const desc = description.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join("");
  return `FMC_${role.toUpperCase()}_${token}_${desc}`;
}

// ---------- keynotes ----------

export interface Keynote { code: string; description: string; parent: string }

/** A Revit keynote table: one entry per line, tab-separated code, description, parent. */
export function parseKeynotes(text: string): Keynote[] {
  return text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split("\t"))
    .filter((f) => f.length >= 2 && f[0].trim() && !f[0].startsWith("#"))
    .map((f) => ({ code: f[0].trim(), description: (f[1] ?? "").trim(), parent: (f[2] ?? "").trim() }));
}

export function searchKeynotes(all: Keynote[], query: string, limit = 50): Keynote[] {
  const q = query.trim().toLowerCase();
  const hits = q ? all.filter((k) => k.code.toLowerCase().includes(q) || k.description.toLowerCase().includes(q)) : all;
  return hits.slice(0, limit);
}

/** The next free code in a group: E.SOC with E.SOC_00..E.SOC_03 taken gives E.SOC_04. */
export function nextKeynoteCode(all: Keynote[], group: string): string {
  const taken = all.map((k) => new RegExp(`^${group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)$`).exec(k.code)).filter(Boolean)
    .map((m) => parseInt(m![1], 10));
  const next = taken.length ? Math.max(...taken) + 1 : 0;
  return `${group}_${String(next).padStart(2, "0")}`;
}
