/**
 * Offline gbXML check for fmc_energy (GAP-23). No Revit dependency and no XML library: gbXML from Revit is flat enough
 * for a tag scan. Counts Campus, Building, Space, Zone, Surface, Opening and Construction, and flags surfaces with no
 * AdjacentSpaceId, AdjacentSpaceId refs to a Space that is not in the file, zero or negative areas, and missing or
 * undefined Construction refs. Areas are in the file's own units (lengthUnit on the root).
 */

export interface GbxmlSurface {
  id: string;
  type: string;
  construction_ref: string;
  adjacent: string[];
  area: number | null;
  openings: number;
}

export interface GbxmlOpening { id: string; type: string; surface_id: string; area: number | null }

export interface GbxmlFinding {
  code: "NOT_GBXML" | "NO_SURFACES" | "SURFACE_NO_ADJACENT_SPACE" | "ADJACENT_SPACE_MISSING" | "SURFACE_ZERO_AREA" | "OPENING_ZERO_AREA" | "CONSTRUCTION_REF_MISSING" | "CONSTRUCTION_NOT_DEFINED";
  id?: string;
  type?: string;
  ref?: string;
  value?: number | null;
  message: string;
}

export interface GbxmlReport {
  valid_root: boolean;
  version: string;
  length_unit: string;
  area_unit: string;
  counts: { campus: number; building: number; space: number; zone: number; surface: number; opening: number; construction: number; window_type: number };
  surface_types: Record<string, number>;
  findings_by_code: Record<string, number>;
  findings: GbxmlFinding[];
  findings_truncated: boolean;
  area_unknown: number;
  status: "PASS" | "FAIL" | "EMPTY" | "INVALID";
}

/** Surfaces that need no space and no construction: shading and air openings. */
const SHADE = /shade/i;
const NO_CONSTRUCTION = /shade|air/i;

function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
}

export function attrsOf(startTag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(startTag))) out[m[1]] = m[3] ?? m[4] ?? "";
  return out;
}

/** Elements named `name`, not nested in themselves. A name boundary keeps <Space> apart from <SpaceBoundary>. */
export function elementsOf(xml: string, name: string): Array<{ attrs: Record<string, string>; body: string }> {
  const out: Array<{ attrs: Record<string, string>; body: string }> = [];
  const re = new RegExp(`<${name}(?=[\\s/>])([^>]*?)(/>|>([\\s\\S]*?)</${name}\\s*>)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ attrs: attrsOf(m[1]), body: m[3] ?? "" });
  return out;
}

export function countTags(xml: string, name: string): number {
  return (xml.match(new RegExp(`<${name}(?=[\\s/>])`, "g")) ?? []).length;
}

function numbersIn(text: string): number[] {
  return (text.match(/<Coordinate[^>]*>\s*([^<]+?)\s*<\/Coordinate>/g) ?? [])
    .map((c) => Number(c.replace(/<[^>]+>/g, "").trim()));
}

/** Area of a planar polygon in 3D (Newell's method). */
export function polygonArea(points: number[][]): number {
  if (points.length < 3) return 0;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1, z1] = points[i];
    const [x2, y2, z2] = points[(i + 1) % points.length];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  return Math.hypot(nx, ny, nz) / 2;
}

/** PlanarGeometry PolyLoop first, else RectangularGeometry Width x Height. null when neither is there. */
export function geometryArea(body: string): number | null {
  const planar = /<PlanarGeometry\b[\s\S]*?<\/PlanarGeometry\s*>/.exec(body)?.[0];
  if (planar) {
    const points = (planar.match(/<CartesianPoint\b[\s\S]*?<\/CartesianPoint\s*>/g) ?? []).map((p) => {
      const n = numbersIn(p);
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
    });
    if (points.length && points.every((p) => p.every(Number.isFinite))) return polygonArea(points);
  }
  const rect = /<RectangularGeometry\b[\s\S]*?<\/RectangularGeometry\s*>/.exec(body)?.[0];
  if (rect) {
    const w = Number(/<Width[^>]*>\s*([^<]+)</.exec(rect)?.[1]);
    const h = Number(/<Height[^>]*>\s*([^<]+)</.exec(rect)?.[1]);
    if (Number.isFinite(w) && Number.isFinite(h)) return w * h;
  }
  return null;
}

export function parseGbxml(raw: string): { root: Record<string, string> | null; spaces: string[]; constructions: string[]; surfaces: GbxmlSurface[]; openings: GbxmlOpening[]; xml: string } {
  const xml = stripComments(raw.replace(/^\uFEFF/, ""));
  const rootTag = /<gbXML(?=[\s>])([^>]*)>/.exec(xml);
  const spaces = elementsOf(xml, "Space").map((s) => s.attrs.id ?? "").filter(Boolean);
  const constructions = elementsOf(xml, "Construction").map((c) => c.attrs.id ?? "").filter(Boolean);
  const surfaces: GbxmlSurface[] = [];
  const openings: GbxmlOpening[] = [];
  for (const s of elementsOf(xml, "Surface")) {
    const own = s.body.replace(/<Opening(?=[\s/>])[\s\S]*?<\/Opening\s*>/g, "");
    const adjacent = elementsOf(own, "AdjacentSpaceId").map((a) => a.attrs.spaceIdRef ?? "");
    const ops = elementsOf(s.body, "Opening");
    const id = s.attrs.id ?? "";
    for (const o of ops) openings.push({ id: o.attrs.id ?? "", type: o.attrs.openingType ?? "", surface_id: id, area: geometryArea(o.body) });
    surfaces.push({ id, type: s.attrs.surfaceType ?? "", construction_ref: s.attrs.constructionIdRef ?? "", adjacent, area: geometryArea(own), openings: ops.length });
  }
  return { root: rootTag ? attrsOf(rootTag[1]) : null, spaces, constructions, surfaces, openings, xml };
}

export function checkGbxml(raw: string, sampleLimit = 200): GbxmlReport {
  const p = parseGbxml(raw);
  const findings: GbxmlFinding[] = [];
  const spaceIds = new Set(p.spaces);
  const constructionIds = new Set(p.constructions);
  const types: Record<string, number> = {};
  let areaUnknown = 0;
  if (!p.root) findings.push({ code: "NOT_GBXML", message: "There is no <gbXML> root element." });
  for (const s of p.surfaces) {
    types[s.type || "(none)"] = (types[s.type || "(none)"] ?? 0) + 1;
    const shade = SHADE.test(s.type);
    if (!shade && s.adjacent.length === 0) {
      findings.push({ code: "SURFACE_NO_ADJACENT_SPACE", id: s.id, type: s.type, message: `Surface ${s.id} (${s.type || "no type"}) has no AdjacentSpaceId.` });
    }
    for (const ref of s.adjacent) {
      if (!ref || !spaceIds.has(ref)) findings.push({ code: "ADJACENT_SPACE_MISSING", id: s.id, type: s.type, ref, message: `Surface ${s.id} points at space ${ref || "(blank)"}, which is not in the file.` });
    }
    if (s.area == null) areaUnknown++;
    else if (!(s.area > 1e-9)) findings.push({ code: "SURFACE_ZERO_AREA", id: s.id, type: s.type, value: s.area, message: `Surface ${s.id} has area ${s.area}.` });
    if (!NO_CONSTRUCTION.test(s.type)) {
      if (!s.construction_ref) findings.push({ code: "CONSTRUCTION_REF_MISSING", id: s.id, type: s.type, message: `Surface ${s.id} (${s.type || "no type"}) has no constructionIdRef.` });
      else if (!constructionIds.has(s.construction_ref)) findings.push({ code: "CONSTRUCTION_NOT_DEFINED", id: s.id, type: s.type, ref: s.construction_ref, message: `Surface ${s.id} refers to construction ${s.construction_ref}, which is not defined.` });
    }
  }
  for (const o of p.openings) {
    if (o.area == null) areaUnknown++;
    else if (!(o.area > 1e-9)) findings.push({ code: "OPENING_ZERO_AREA", id: o.id, type: o.type, value: o.area, message: `Opening ${o.id} in surface ${o.surface_id} has area ${o.area}.` });
  }
  if (p.root && p.surfaces.length === 0) findings.push({ code: "NO_SURFACES", message: "The file has no <Surface> elements." });
  const byCode: Record<string, number> = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  const status: GbxmlReport["status"] = !p.root ? "INVALID" : p.surfaces.length === 0 ? "EMPTY" : findings.length ? "FAIL" : "PASS";
  return {
    valid_root: !!p.root,
    version: p.root?.version ?? "",
    length_unit: p.root?.lengthUnit ?? "",
    area_unit: p.root?.areaUnit ?? "",
    counts: {
      campus: countTags(p.xml, "Campus"), building: countTags(p.xml, "Building"), space: p.spaces.length, zone: countTags(p.xml, "Zone"),
      surface: p.surfaces.length, opening: p.openings.length, construction: p.constructions.length, window_type: countTags(p.xml, "WindowType"),
    },
    surface_types: types,
    findings_by_code: byCode,
    findings: findings.slice(0, sampleLimit),
    findings_truncated: findings.length > sampleLimit,
    area_unknown: areaUnknown,
    status,
  };
}
