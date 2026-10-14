/**
 * Materials (board manage/PaneMaterials, U18). Pure: the database comes from the kit (07_Materials\FMC_Materials.json),
 * the facts from Revit (fmc_material_facts). Projects take materials from the database; they never invent their own.
 */
export interface MaterialMap { map: string; file: string; size_mm: number | null }
export interface DbMaterial {
  name: string; class: string; sub: string; keynote: string; cost_code: string; supplier: string;
  graphics: { shaded: string; surface: string; cut: string }; maps: MaterialMap[];
}
export interface MaterialDb { version: string; materials: DbMaterial[]; classes: string[]; problems: string[] }

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Reads FMC_Materials.json tolerantly ({version, materials:[…]} or a bare list). */
export function parseMaterialDb(json: any): MaterialDb {
  const problems: string[] = [];
  const list = Array.isArray(json) ? json : Array.isArray(json?.materials) ? json.materials : [];
  const seen = new Set<string>();
  const materials: DbMaterial[] = [];
  for (const m of list) {
    const name = str(m?.name).trim();
    if (!name) { problems.push("A material has no name"); continue; }
    if (seen.has(name)) { problems.push(`${name} is in the database twice`); continue; }
    seen.add(name);
    const g = m.graphics ?? {};
    materials.push({
      name, class: str(m.class), sub: str(m.sub ?? m.subclass), keynote: str(m.keynote), cost_code: str(m.cost_code ?? m.costcode), supplier: str(m.supplier),
      graphics: { shaded: str(g.shaded ?? g.colour ?? g.color), surface: str(g.surface ?? g.surface_pattern), cut: str(g.cut ?? g.cut_pattern) },
      maps: (Array.isArray(m.maps ?? m.textures) ? (m.maps ?? m.textures) : []).map((x: any) => ({ map: str(x.map ?? x.type), file: str(x.file), size_mm: x.size_mm == null ? null : Number(x.size_mm) })),
    });
  }
  const classes = [...new Set(materials.map((m) => m.class).filter(Boolean))].sort();
  return { version: str(json?.version), materials, classes, problems };
}

export function searchMaterials(db: MaterialDb, cls: string, query: string, limit = 200): DbMaterial[] {
  const q = query.trim().toLowerCase();
  return db.materials.filter((m) => (!cls || cls === "All" || m.class === cls) &&
    (!q || m.name.toLowerCase().includes(q) || m.keynote.toLowerCase().includes(q) || m.sub.toLowerCase().includes(q))).slice(0, limit);
}

export interface ModelMaterial { id: number; name: string; used: boolean; textures: string[] }

export interface AuditCheck { check: string; found: number; result: "Pass" | "Info" | "Warn" | "Fail"; items: string[]; ids: number[] }

/** "Concrete (1)", "Default", "Default Wall": a duplicate of another material, or Revit's own placeholder. */
export function duplicateOf(name: string, names: Set<string>): string | null {
  const m = /^(.*?)\s*\(\d+\)$/.exec(name);
  if (m && names.has(m[1])) return m[1];
  if (/^Default(\b| )/i.test(name)) return "Default";
  return null;
}

export function auditMaterials(model: ModelMaterial[], db: MaterialDb | null, exists: (path: string) => boolean): AuditCheck[] {
  const inDb = new Set((db?.materials ?? []).map((m) => m.name));
  const names = new Set(model.map((m) => m.name));
  const pick = (list: ModelMaterial[]) => ({ items: list.map((m) => m.name).slice(0, 50), ids: list.map((m) => m.id) });
  const notInDb = db ? model.filter((m) => !inDb.has(m.name)) : [];
  const dups = model.filter((m) => duplicateOf(m.name, names));
  const broken = model.filter((m) => m.textures.some((t) => t && !exists(t)));
  const unused = model.filter((m) => !m.used);
  const nonStandard = model.filter((m) => !/^FMC_[A-Za-z]+_[A-Za-z0-9]/.test(m.name));
  const level = (n: number, bad: AuditCheck["result"]): AuditCheck["result"] => (n === 0 ? "Pass" : bad);
  return [
    db ? { check: "Materials not in the database", found: notInDb.length, result: level(notInDb.length, "Warn"), ...pick(notInDb) }
       : { check: "Materials not in the database", found: 0, result: "Info", items: ["The kit's material database isn't readable"], ids: [] },
    { check: "Duplicates (\"Concrete (1)\", \"Default\")", found: dups.length, result: level(dups.length, "Warn"), ...pick(dups) },
    { check: "Broken texture paths", found: broken.length, result: level(broken.length, "Fail"), ...pick(broken) },
    { check: "Unused materials", found: unused.length, result: level(unused.length, "Info"), ...pick(unused) },
    { check: "Names not FMC_ standard", found: nonStandard.length, result: level(nonStandard.length, "Warn"), ...pick(nonStandard) },
  ];
}
