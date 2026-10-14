/**
 * The annotation standard and the model against it (board manage/PaneAnnotate, U19). Pure.
 *
 * The standard is the kit's FMC_Annotation_Standard.json (STD 6, MAN 9.14): pens, line patterns, text types, dimension
 * styles, tag naming, symbols and colours. One file drives the template builder, the audit, this pane and Tag Tidy.
 * A value marked "proposed" waits for the BIM Manager's approval and is shown amber, never enforced.
 */
export interface Pen { pen: number; width_mm: number; used_for: string; status: string }
export interface AnnotationStandard {
  version: string; source: string;
  pens: Pen[];
  line_patterns: string[];
  text_types: Array<{ name: string; font: string; size_mm: number | null }>;
  text_pattern: string;
  dimension_styles: Array<{ name: string; status: string }>;
  dimension_pattern: string;
  tag_pattern: string;
  symbols: string[];
  colours: Array<{ name: string; hex: string }>;
  problems: string[];
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export function parseStandard(json: any): AnnotationStandard {
  const problems: string[] = [];
  const pens = list(json?.pens).map((p: any) => ({ pen: Number(p.pen), width_mm: Number(p.width_mm ?? p.width), used_for: str(p.used_for ?? p.use), status: str(p.status || "standard") }))
    .filter((p) => !Number.isNaN(p.pen));
  if (!pens.length) problems.push("The standard lists no pens");
  return {
    version: str(json?.version), source: str(json?.source), pens,
    line_patterns: list(json?.line_patterns).map((x: any) => str(typeof x === "string" ? x : x.name)).filter(Boolean),
    text_types: list(json?.text_types).map((t: any) => ({ name: str(t.name), font: str(t.font), size_mm: t.size_mm == null ? null : Number(t.size_mm) })).filter((t) => t.name),
    text_pattern: str(json?.text_pattern),
    dimension_styles: list(json?.dimension_styles).map((d: any) => ({ name: str(typeof d === "string" ? d : d.name), status: str(d?.status || "standard") })).filter((d) => d.name),
    dimension_pattern: str(json?.dimension_pattern),
    tag_pattern: str(json?.tag_pattern) || "^FMC_TAG_[A-Z]{1,2}_[A-Za-z0-9]+$",
    symbols: list(json?.symbols).map(str).filter(Boolean),
    colours: list(json?.colours).map((c: any) => ({ name: str(c.name), hex: str(c.hex) })).filter((c) => c.name),
    problems,
  };
}

export interface AnnotationFacts {
  model: string;
  text_types: Array<{ id: number; name: string; font: string; size_mm: number }>;
  line_patterns: Array<{ id: number; name: string }>;
  dimension_types: Array<{ id: number; name: string }>;
  tag_families: Array<{ id: number; name: string; category: string }>;
}

export interface AnnotationCheck { check: string; found: number; state: "Pass" | "Fail" | "Proposed" | "Not checked"; items: string[]; ids: number[] }

function re(p: string): RegExp | null { try { return p ? new RegExp(p) : null; } catch { return null; } }

export function checkAnnotation(f: AnnotationFacts, s: AnnotationStandard | null): AnnotationCheck[] {
  const out: AnnotationCheck[] = [];
  const add = (check: string, bad: Array<{ id: number; name: string }>) =>
    out.push({ check, found: bad.length, state: bad.length ? "Fail" : "Pass", items: bad.map((b) => b.name).slice(0, 30), ids: bad.map((b) => b.id) });
  const notChecked = (check: string, why: string) => out.push({ check, found: 0, state: "Not checked", items: [why], ids: [] });
  if (!s) {
    for (const c of ["Text types", "Line patterns not FMC_", "Dimension types", "Tags not FMC_TAG_[Role]_[Subject]"]) notChecked(c, "The kit's annotation standard isn't readable");
    return out;
  }
  const textNames = new Set(s.text_types.map((t) => t.name));
  const textRe = re(s.text_pattern);
  if (!textNames.size && !textRe) notChecked("Text types", "The standard names no text types");
  else add(`Text types (${textNames.size ? "the standard's " + textNames.size : "pattern " + s.text_pattern} only)`,
    f.text_types.filter((t) => !textNames.has(t.name) && !(textRe && textRe.test(t.name))));

  const patterns = new Set(s.line_patterns);
  add("Line patterns not FMC_", f.line_patterns.filter((p) => !patterns.has(p.name) && !/^FMC_/.test(p.name) && !/^Solid$/i.test(p.name)));

  const dimNames = new Set(s.dimension_styles.map((d) => d.name));
  const dimRe = re(s.dimension_pattern) ?? /^FMC_/;
  const dimBad = f.dimension_types.filter((d) => !dimNames.has(d.name) && !dimRe.test(d.name));
  const dimProposed = !s.dimension_styles.length || s.dimension_styles.every((d) => d.status.toLowerCase() === "proposed");
  out.push({ check: "Dimension types not FMC_", found: dimBad.length, state: dimBad.length ? (dimProposed ? "Proposed" : "Fail") : "Pass",
    items: dimBad.map((d) => d.name).slice(0, 30), ids: dimBad.map((d) => d.id) });

  const tagRe = re(s.tag_pattern)!;
  add("Tags not FMC_TAG_[Role]_[Subject]", f.tag_families.filter((t) => !tagRe.test(t.name)));
  return out;
}
