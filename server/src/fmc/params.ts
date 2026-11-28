/**
 * fmc_params (gap-analysis proposal 11): the project parameter manager. Pure planner and auditor.
 * bind    kit shared parameters to categories (GUID must match the kit; the kit file is never edited)
 * audit   project parameter bindings against the kit shared parameter file (read-only)
 * copy    values from one parameter to another on elements of a category or an id list
 * fill_csv  values from a CSV (element id column plus one column per parameter name)
 * Every write is planned first with a preview and a plan_hash; apply plans again and refuses a changed plan.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { parseSharedParameters, type SpParam } from "./specs.js";
import { decodeKeynoteFile } from "./library.js";

export const PARAMS_MAX_ROWS = 5000;
export const PARAMS_MAX_BIND = 100;

/** The kit shared parameter file, UTF-8 or UTF-16 (Revit writes UTF-16 when a person saves it from the dialog). */
export function readKitShared(file: string): Map<string, SpParam> | null {
  if (!file || !fs.existsSync(file)) return null;
  try { return parseSharedParameters(decodeKeynoteFile(fs.readFileSync(file))); } catch { return null; }
}

export interface Binding { name: string; guid: string; shared: boolean; datatype: string; binding: "instance" | "type"; categories: string[]; group?: string }

export type ParamStep =
  | { kind: "bind"; name: string; guid: string; binding: "instance" | "type"; categories: string[]; group: string; added_categories: string[]; existing: boolean }
  | { kind: "set"; target: string; key: string; name: string; storage: string; to: string | number | null; mode: "value" | "display"; was?: string; sentence?: string };

export function paramsHash(steps: ParamStep[], extra: Record<string, unknown> = {}): string {
  const canon = steps.map((s) => {
    const { sentence: _s, was: _w, ...rest } = s as Record<string, unknown>;
    return Object.keys(rest).sort().map((k) => [k, rest[k]]);
  });
  return createHash("sha256").update(JSON.stringify([canon, Object.keys(extra).sort().map((k) => [k, extra[k]])])).digest("hex").slice(0, 12);
}

// ---------- audit ----------

export interface AuditFinding { code: string; name: string; detail: string }
export interface AuditResult {
  kit_count: number;
  project_count: number;
  ok: number;
  findings: AuditFinding[];
  not_bound: string[];
  truncated: boolean;
}

const FINDING_CAP = 200;

export function auditParams(kit: Map<string, SpParam>, bound: Binding[], names: string[] = []): AuditResult {
  const wanted = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  const inScope = (n: string) => wanted.length === 0 || wanted.includes(n.toLowerCase());
  const byGuid = new Map<string, SpParam>();
  for (const p of kit.values()) byGuid.set(p.guid.toLowerCase(), p);
  const findings: AuditFinding[] = [];
  const boundKitGuids = new Set<string>();
  let ok = 0;
  for (const b of bound) {
    const kitByGuid = b.guid ? byGuid.get(b.guid.toLowerCase()) : undefined;
    const kitByName = kit.get(b.name);
    if (kitByGuid) {
      boundKitGuids.add(kitByGuid.guid.toLowerCase());
      if (!inScope(kitByGuid.name)) continue;
      if (kitByGuid.name !== b.name) { findings.push({ code: "FMC-PARAM-RENAMED", name: b.name, detail: `Bound under the name "${b.name}" but the kit calls GUID ${kitByGuid.guid} "${kitByGuid.name}".` }); continue; }
      if (b.datatype && kitByGuid.datatype && b.datatype.toUpperCase() !== kitByGuid.datatype.toUpperCase()) {
        findings.push({ code: "FMC-PARAM-TYPE-DIFFERS", name: b.name, detail: `Project data type ${b.datatype}, kit data type ${kitByGuid.datatype}.` });
        continue;
      }
      ok++;
    } else if (b.shared && b.guid) {
      if (!inScope(b.name)) continue;
      findings.push(kitByName
        ? { code: "FMC-PARAM-GUID-MISMATCH", name: b.name, detail: `Shared parameter "${b.name}" is bound with GUID ${b.guid}; the kit's GUID is ${kitByName.guid}. Values will not line up with kit families. Fix by a person; this tool does not rebind.` }
        : { code: "FMC-PARAM-NOT-IN-KIT", name: b.name, detail: `Shared parameter GUID ${b.guid} is not in the kit shared parameter file.` });
    } else if (kitByName && inScope(b.name)) {
      findings.push({ code: "FMC-PARAM-NAME-CLASH", name: b.name, detail: `A project parameter (not shared) has the kit name "${b.name}". Binding the kit parameter would be refused by Revit until it is removed by a person.` });
    }
  }
  const notBound = [...kit.values()].filter((p) => inScope(p.name) && !boundKitGuids.has(p.guid.toLowerCase())).map((p) => p.name).sort();
  const truncated = findings.length > FINDING_CAP;
  return { kit_count: kit.size, project_count: bound.length, ok, findings: findings.slice(0, FINDING_CAP), not_bound: notBound.slice(0, FINDING_CAP), truncated: truncated || notBound.length > FINDING_CAP };
}

// ---------- bind ----------

export interface BindPlan { ok: boolean; code: string; message: string; steps: ParamStep[]; preview: Array<Record<string, unknown>>; plan_hash: string }

function bad(code: string, message: string): BindPlan {
  return { ok: false, code, message: `[${code}] ${message}`, steps: [], preview: [], plan_hash: "" };
}

export function planBind(input: { kit: Map<string, SpParam> | null; kitFile: string; names: string[]; categories: string[]; binding: "instance" | "type"; group: string; bound: Binding[] }): BindPlan {
  if (!input.kit) return bad("FMC-PARAM-FILE", `The kit shared parameter file is not readable at ${input.kitFile || "(not set)"}. Nothing was invented.`);
  const names = [...new Set(input.names.map((n) => n.trim()).filter(Boolean))];
  const cats = [...new Set(input.categories.map((c) => c.trim()).filter(Boolean))];
  if (names.length === 0) return bad("FMC-PARAM-NAME", "bind needs names: kit shared parameter names.");
  if (names.length > PARAMS_MAX_BIND) return bad("FMC-PARAM-CAP", `At most ${PARAMS_MAX_BIND} parameters per call.`);
  if (cats.length === 0) return bad("FMC-PARAM-CATEGORY", "bind needs categories, for example OST_Walls.");
  const steps: ParamStep[] = [];
  const preview: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const k = input.kit.get(name);
    if (!k) return bad("FMC-PARAM-NOT-IN-KIT", `"${name}" is not in the kit shared parameter file. Kit change: add it to FMC_SharedParameters.txt. No definition was created.`);
    const same = input.bound.find((b) => b.name === name);
    const sameGuid = input.bound.find((b) => b.guid && b.guid.toLowerCase() === k.guid.toLowerCase());
    if (same && !(same.guid && same.guid.toLowerCase() === k.guid.toLowerCase())) {
      return bad("FMC-PARAM-GUID-MISMATCH", `"${name}" is already a project parameter ${same.shared ? `with GUID ${same.guid}` : "that is not shared"}; the kit GUID is ${k.guid}. The GUID must match the kit. A person must remove or rebind the old one.`);
    }
    const have = sameGuid ?? same;
    if (have && have.binding !== input.binding) {
      return bad("FMC-PARAM-BINDING-KIND", `"${name}" is bound as ${have.binding}; a bind would change it to ${input.binding}. Revit forbids switching with data in place. Not done.`);
    }
    const merged = [...new Set([...(have?.categories ?? []), ...cats])];
    const added = merged.filter((c) => !(have?.categories ?? []).includes(c));
    if (have && added.length === 0) { preview.push({ name, guid: k.guid, status: "already_bound", categories: merged }); continue; }
    steps.push({ kind: "bind", name, guid: k.guid, binding: input.binding, categories: merged, group: input.group || "data", added_categories: added, existing: !!have });
    preview.push({ name, guid: k.guid, datatype: k.datatype, status: have ? "add_categories" : "new_binding", binding: input.binding, added_categories: added, categories: merged });
  }
  return { ok: true, code: "", message: "", steps, preview, plan_hash: paramsHash(steps, { action: "bind" }) };
}

// ---------- values: copy and fill ----------

export interface ParamCell { key: string; name: string; storage: string; value: string | number | null; display?: string; readonly?: boolean }
export interface ValueRow { id: string; category?: string; editable?: boolean; owner?: string; params: ParamCell[] }
export interface ValuesPlan {
  ok: boolean; code: string; message: string; steps: ParamStep[];
  preview: Array<Record<string, unknown>>;
  totals: { rows: number; will_change: number; no_change: number; refused: number };
  plan_hash: string;
}

function vbad(code: string, message: string): ValuesPlan {
  return { ok: false, code: `${code}`, message: `[${code}] ${message}`, steps: [], preview: [], totals: { rows: 0, will_change: 0, no_change: 0, refused: 0 }, plan_hash: "" };
}

function cell(row: ValueRow, name: string): ParamCell | undefined {
  const n = name.trim().toLowerCase();
  return row.params.find((p) => p.name.toLowerCase() === n);
}

function empty(v: unknown): boolean { return v === null || v === undefined || v === "" ; }

function tally(preview: Array<Record<string, unknown>>, rows: number): ValuesPlan["totals"] {
  return {
    rows,
    will_change: preview.filter((p) => p.status === "will_change").length,
    no_change: preview.filter((p) => p.status === "no_change").length,
    refused: preview.filter((p) => p.status === "refused").length,
  };
}

export function planCopy(rows: ValueRow[], from: string, to: string, opts: { overwrite_empty?: boolean } = {}): ValuesPlan {
  if (!from.trim() || !to.trim()) return vbad("FMC-PARAM-NAME", "copy needs from and to: parameter names.");
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) return vbad("FMC-PARAM-NAME", "from and to are the same parameter.");
  if (rows.length === 0) return vbad("FMC-PARAM-NO-ELEMENTS", "No elements matched the category or ids.");
  if (rows.length > PARAMS_MAX_ROWS) return vbad("FMC-PARAM-CAP", `More than ${PARAMS_MAX_ROWS} elements. Narrow the category or id list.`);
  const steps: ParamStep[] = [];
  const preview: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const a = cell(row, from);
    const b = cell(row, to);
    const item: Record<string, unknown> = { id: row.id };
    if (row.editable === false) { preview.push({ ...item, status: "refused", reason: `Owned by ${row.owner || "another user"}.` }); continue; }
    if (!a) { preview.push({ ...item, status: "refused", reason: `No parameter "${from}" on this element.` }); continue; }
    if (!b) { preview.push({ ...item, status: "refused", reason: `No parameter "${to}" on this element.` }); continue; }
    if (b.readonly) { preview.push({ ...item, status: "refused", reason: `"${to}" is read-only.` }); continue; }
    if (empty(a.value) && !opts.overwrite_empty) { preview.push({ ...item, status: "no_change", reason: `"${from}" is empty; the target is left as it is.` }); continue; }
    let value: string | number | null = a.value;
    let mode: "value" | "display" = "value";
    if (a.storage !== b.storage) {
      if (b.storage === "String") { value = a.display ?? (a.value === null ? "" : String(a.value)); }
      else { preview.push({ ...item, status: "refused", reason: `Storage ${a.storage} cannot go into ${b.storage}. Only the same storage, or any into text, is copied.` }); continue; }
    }
    if (empty(value) && b.storage !== "String") { preview.push({ ...item, status: "no_change", reason: "Empty source." }); continue; }
    const same = typeof value === "number" && typeof b.value === "number" ? Math.abs(value - b.value) <= 1e-9 : String(b.value ?? "") === String(value ?? "");
    if (same) { preview.push({ ...item, status: "no_change", from: a.display ?? a.value, current: b.display ?? b.value }); continue; }
    steps.push({ kind: "set", target: row.id, key: b.key, name: b.name, storage: b.storage, to: value, mode, was: String(b.display ?? b.value ?? ""),
      sentence: `${b.name}: ${b.display ?? b.value ?? ""} → ${a.display ?? value ?? ""}` });
    preview.push({ ...item, status: "will_change", name: b.name, from: b.display ?? b.value, to: a.display ?? value });
  }
  return { ok: true, code: "", message: "", steps, preview, totals: tally(preview, rows.length), plan_hash: paramsHash(steps, { action: "copy", from, to }) };
}

/** Minimal RFC 4180 reader: quotes, doubled quotes, CRLF, a BOM. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim() !== "")) out.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== "")) out.push(row);
  return out;
}

const ID_COLUMNS = ["id", "elementid", "element id", "element_id"];

export function planFill(rows: ValueRow[], csv: string[][]): ValuesPlan {
  if (csv.length < 2) return vbad("FMC-PARAM-CSV", "The CSV needs a header row and at least one data row.");
  const header = csv[0].map((h) => h.trim());
  const idCol = header.findIndex((h) => ID_COLUMNS.includes(h.toLowerCase()));
  if (idCol < 0) return vbad("FMC-PARAM-CSV", "The CSV needs an Id (or ElementId) column with Revit element ids.");
  const cols = header.map((h, i) => ({ h, i })).filter((c) => c.i !== idCol && c.h);
  if (cols.length === 0) return vbad("FMC-PARAM-CSV", "The CSV has no parameter columns.");
  if (csv.length - 1 > PARAMS_MAX_ROWS) return vbad("FMC-PARAM-CAP", `More than ${PARAMS_MAX_ROWS} CSV rows. Split the file.`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const steps: ParamStep[] = [];
  const preview: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let line = 1;
  for (const rec of csv.slice(1)) {
    line++;
    const id = (rec[idCol] ?? "").trim();
    if (!/^\d+$/.test(id)) { preview.push({ line, id, status: "refused", reason: "Not an element id." }); continue; }
    if (seen.has(id)) { preview.push({ line, id, status: "refused", reason: "Id appears twice in the CSV." }); continue; }
    seen.add(id);
    const row = byId.get(id);
    if (!row) { preview.push({ line, id, status: "refused", reason: "Element not found in the document." }); continue; }
    if (row.editable === false) { preview.push({ line, id, status: "refused", reason: `Owned by ${row.owner || "another user"}.` }); continue; }
    for (const c of cols) {
      const raw = (rec[c.i] ?? "").trim();
      const p = cell(row, c.h);
      if (!p) { preview.push({ line, id, name: c.h, status: "refused", reason: `No writable parameter "${c.h}" on this element.` }); continue; }
      if (p.readonly) { preview.push({ line, id, name: c.h, status: "refused", reason: "Read-only." }); continue; }
      if (raw === "") { preview.push({ line, id, name: c.h, status: "no_change", reason: "Blank cell is left alone." }); continue; }
      let to: string | number = raw;
      let mode: "value" | "display" = "value";
      if (p.storage === "Integer") {
        const t = raw.toLowerCase();
        if (/^-?\d+$/.test(raw)) to = parseInt(raw, 10);
        else if (["yes", "true"].includes(t)) to = 1;
        else if (["no", "false"].includes(t)) to = 0;
        else { preview.push({ line, id, name: c.h, status: "refused", reason: `"${raw}" is not a whole number or yes/no.` }); continue; }
      } else if (p.storage === "Double") {
        // Revit parses the text in the parameter's display units (SetValueString), so "2100" means what the field shows.
        mode = "display";
        if (!/^[-+]?(\d+([.,]\d*)?|[.,]\d+)/.test(raw)) { preview.push({ line, id, name: c.h, status: "refused", reason: `"${raw}" does not start with a number.` }); continue; }
        const a = parseFloat(raw.replace(",", "."));
        const b = parseFloat(String(p.display ?? "").replace(",", "."));
        if (!Number.isNaN(a) && !Number.isNaN(b) && a === b) { preview.push({ line, id, name: c.h, status: "no_change", current: p.display }); continue; }
      } else if (p.storage === "ElementId") {
        if (!/^-?\d+$/.test(raw)) { preview.push({ line, id, name: c.h, status: "refused", reason: "An element-id parameter takes an element id." }); continue; }
      }
      if (mode === "value" && String(p.value ?? "") === String(to)) { preview.push({ line, id, name: c.h, status: "no_change", current: p.display ?? p.value }); continue; }
      steps.push({ kind: "set", target: id, key: p.key, name: p.name, storage: p.storage, to, mode, was: String(p.display ?? p.value ?? ""), sentence: `${p.name}: ${p.display ?? p.value ?? ""} → ${raw}` });
      preview.push({ line, id, name: p.name, status: "will_change", from: p.display ?? p.value, to: raw });
    }
  }
  return { ok: true, code: "", message: "", steps, preview, totals: tally(preview, csv.length - 1), plan_hash: paramsHash(steps, { action: "fill_csv" }) };
}

/** Why a plan can't be applied (empty: it can). */
export function paramsApplyProblems(plan: { ok: boolean; message: string; steps: ParamStep[]; plan_hash: string }, givenHash: string): string[] {
  if (!plan.ok) return [plan.message];
  const p: string[] = [];
  if (!givenHash.trim()) p.push("[FMC-PARAM-HASH] Apply needs plan_hash from the dry run the person saw.");
  else if (givenHash.trim() !== plan.plan_hash) p.push("[FMC-PARAM-PLAN-CHANGED] The plan changed since the dry run (the model moved on): run the dry run again and show the new preview.");
  if (plan.steps.length === 0) p.push("[FMC-PARAM-NOTHING] Nothing differs, so there is nothing to apply.");
  return p;
}
