/**
 * fmc_fam_nested checks (pure, no Revit): swap a nested family's type, associate its parameters (or its type, through a
 * <Family Type> parameter) to the host family's parameters, and reload a nested family from an .rfa in the family roots.
 * Everything is checked against the add-in's read before Revit is asked to change anything.
 */
import path from "node:path";
import { GuardConfig, expandEnv, isInside } from "./policy.js";
import { familyRoots } from "./ops.js";

export interface NestedParam { name: string; spec?: string; associated?: string | null; can_associate?: boolean; read_only?: boolean }
export interface NestedRead { id: number; name?: string | null; family: string; type: string; category?: string; shared?: boolean; type_label?: string | null; parameters?: NestedParam[] }
export interface LoadedFamily { name: string; category?: string; shared?: boolean; types: string[]; nested_count?: number }
export interface HostParam { name: string; spec?: string; is_instance?: boolean; family_type_category?: string | null; formula?: string | null }
export interface NestedFamilyRead { family?: string; category?: string; nested: NestedRead[]; families: LoadedFamily[]; host_parameters: HostParam[] }

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Nested instances by id or name (an instance name is the fmc_doc label); a family name picks all its instances. */
export function pickNested(read: NestedFamilyRead, keys: Array<number | string>): { picked: NestedRead[]; missing: string[] } {
  const picked: NestedRead[] = [];
  const missing: string[] = [];
  for (const k of keys) {
    const hits = read.nested.filter((n) => n.id === Number(k) || (n.name && lc(n.name) === lc(String(k))) || lc(n.family) === lc(String(k)));
    if (!hits.length) missing.push(String(k));
    for (const h of hits) if (!picked.some((p) => p.id === h.id)) picked.push(h);
  }
  return { picked, missing };
}

export function checkSwap(read: NestedFamilyRead, keys: Array<number | string>, toFamily: string, toType: string, loading: boolean): { picked: NestedRead[]; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!keys.length) reasons.push("swap needs nested: the nested instances (ids, names, or a family name for all of its instances)");
  if (!toFamily.trim() || !toType.trim()) reasons.push("swap needs to_family and to_type");
  const { picked, missing } = pickNested(read, keys);
  if (missing.length) reasons.push(`No nested instance or family ${missing.join(", ")}; read lists them`);
  const fam = read.families.find((f) => lc(f.name) === lc(toFamily));
  if (!fam && !loading) reasons.push(`${toFamily} isn't loaded in this family: give load_path (an .rfa in the family roots) or load it with fmc_doc load_family`);
  if (fam && !fam.types.some((t) => lc(t) === lc(toType))) {
    if (loading) warnings.push(`${toFamily} has no type ${toType} yet; the load must bring it (the dry run shows whether it does)`);
    else reasons.push(`${toFamily} has no type ${toType} (it has ${fam.types.join(", ") || "none"})`);
  }
  for (const n of picked) {
    if (fam?.category && n.category && lc(fam.category) !== lc(n.category))
      reasons.push(`${n.name || n.id} is ${n.category}; ${toFamily} is ${fam.category}. A nested instance only swaps to a type of the same category`);
    if (n.type_label) reasons.push(`${n.name || n.id}'s type is driven by the <Family Type> parameter ${n.type_label}: change that parameter's value per type, or remove the association first (associate type_parameter: null)`);
    if (lc(n.family) === lc(toFamily) && lc(n.type) === lc(toType)) warnings.push(`${n.name || n.id} is already ${toFamily} : ${toType}`);
  }
  return { picked, reasons, warnings };
}

export function checkAssociate(read: NestedFamilyRead, key: number | string | undefined, map: Record<string, string | null>, typeParam: string | null | undefined, createTypeParam: boolean):
  { target?: NestedRead; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (key === undefined || key === "") return { reasons: ["associate needs nested: one nested instance (id or name)"], warnings };
  const hits = read.nested.filter((n) => n.id === Number(key) || (n.name && lc(n.name) === lc(String(key))));
  if (hits.length !== 1) return { reasons: [hits.length ? `${key} matches ${hits.length} instances; give the id` : `No nested instance ${key}; read lists them`], warnings };
  const target = hits[0];
  if (!Object.keys(map).length && typeParam === undefined) reasons.push("associate needs associate ({nested parameter: host parameter or null}) or type_parameter");
  const hostBy = new Map(read.host_parameters.map((p) => [lc(p.name), p]));
  for (const [np, hp] of Object.entries(map)) {
    const nested = (target.parameters ?? []).find((p) => lc(p.name) === lc(np));
    if (!nested) { reasons.push(`${target.name || target.id} has no instance parameter ${np} (a nested type parameter can't be associated; make it an instance parameter in the nested family)`); continue; }
    if (hp === null) { if (!nested.associated) warnings.push(`${np} isn't associated, nothing to remove`); continue; }
    if (nested.can_associate === false || nested.read_only) { reasons.push(`Revit can't associate ${np} (read-only or a built-in that isn't offered for association)`); continue; }
    const host = hostBy.get(lc(hp));
    if (!host) { reasons.push(`The family has no parameter ${hp}: add it first (fmc_doc add_family_param) with the same data type as ${np}`); continue; }
    if (host.family_type_category) { reasons.push(`${hp} is a <Family Type> parameter; use type_parameter for the nested type, not ${np}`); continue; }
    if (nested.spec && host.spec && nested.spec !== host.spec) reasons.push(`${np} is ${nested.spec} and ${hp} is ${host.spec}; Revit only associates parameters of the same data type`);
    if (nested.associated && lc(nested.associated) === lc(hp)) warnings.push(`${np} is already associated to ${hp}`);
    if (host.formula) warnings.push(`${hp} has a formula (${host.formula}); ${np} will follow it`);
  }
  if (typeParam) {
    const host = hostBy.get(lc(typeParam));
    if (!host && !createTypeParam) reasons.push(`The family has no <Family Type> parameter ${typeParam}: set create_type_parameter=true to make one of category ${target.category ?? "(the nested category)"}`);
    if (host && !host.family_type_category) reasons.push(`${typeParam} isn't a <Family Type> parameter (it is ${host.spec ?? "another type"})`);
    if (host?.family_type_category && target.category && lc(host.family_type_category) !== lc(target.category))
      reasons.push(`${typeParam} is a <Family Type> of ${host.family_type_category}; ${target.name || target.id} is ${target.category}`);
    if (!target.category) warnings.push("The nested instance's category wasn't read; the add-in checks it");
  }
  return { target, reasons, warnings };
}

/** Where a reload may read an .rfa from: the family staging root, 04_Families, the library roots and the write roots. */
export function reloadRoots(cfg: GuardConfig): string[] {
  return [...familyRoots(expandEnv(cfg.family_staging_root), cfg.library_roots.map((r) => expandEnv(r))), ...cfg.write_roots.map((r) => expandEnv(r))];
}

export function checkReload(read: NestedFamilyRead, family: string, file: string, cfg: GuardConfig, exists: (f: string) => boolean): { reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const fam = read.families.find((f) => lc(f.name) === lc(family));
  if (!family.trim()) reasons.push("reload needs family: the nested family's name");
  else if (!fam) reasons.push(`${family} isn't loaded in this family; reload only replaces a nested family that is there (load a new one with fmc_doc load_family)`);
  if (!/\.rfa$/i.test(file)) reasons.push("reload needs path: an .rfa file");
  else {
    const roots = reloadRoots(cfg);
    if (!roots.some((r) => r && isInside(file, r))) reasons.push(`${file} isn't inside the family roots (${roots.filter(Boolean).join("; ") || "none configured"})`);
    else if (!exists(file)) reasons.push(`No file ${file}`);
    const base = path.win32.basename(file, path.win32.extname(file));
    if (fam && lc(base) !== lc(fam.name)) reasons.push(`The file is ${base} and the nested family is ${fam.name}: Revit would load it as ${base}, a second family, not a reload. Rename the file, or load it and swap`);
  }
  if (fam?.nested_count === 0) warnings.push(`${family} is loaded but has no placed instance`);
  return { reasons, warnings };
}
