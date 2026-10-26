/**
 * What an approval lets AI do, in plain lines (owner 26 Oct: "they don't show me details that would tell me if I'm to
 * approve them"). Pure: the names come from Revit when the batch is queued (aigate), so the lines say "Basic Wall:
 * Brick 230" and "Rooms: F15 Bedroom (Level 1)" instead of ids.
 */
export interface Names {
  types: Record<string, string>;
  elements: Record<string, string>;
}

const MAX = 14;
type P = Record<string, any>;

const mm = (v: unknown) => (typeof v === "number" ? `${Math.round(v)} mm` : "?");
const xy = (p: any) => (Array.isArray(p) ? `(${p.slice(0, 2).map((n: number) => Math.round(n)).join(", ")})`
  : p && typeof p === "object" ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : "?");
const typeName = (n: Names, id: unknown, fallback = "") => (id == null ? fallback || "?" : n.types[String(id)] ?? `type ${id}`);
const elementName = (n: Names, id: unknown) => n.elements[String(id)] ?? `element ${id}`;
const made = (ref: unknown) => `what op ${String(ref).slice(1)} makes`;
const isRef = (x: unknown) => String(x).startsWith("$");

/** Counts of the same text, so 34 windows read "12 × Window: 1200 x 1500" rather than 34 lines. */
function tally(items: string[]): string[] {
  const m = new Map<string, number>();
  for (const s of items) m.set(s, (m.get(s) ?? 0) + 1);
  return [...m].map(([s, c]) => (c > 1 ? `${c} × ${s}` : s));
}

function cap(lines: string[]): string[] {
  return lines.length <= MAX ? lines : [...lines.slice(0, MAX - 1), `…and ${lines.length - MAX + 1} more`];
}

function named(n: Names, list: unknown): string[] {
  const a = Array.isArray(list) ? list : [];
  return tally(a.map((x) => (isRef(x) ? made(x) : elementName(n, x)))).map((s) => `   ${s}`);
}

function op(o: P, n: Names, i: number): string[] {
  const h = `${i}. `;
  const count = (o.ids ?? []).length;
  switch (o.op) {
    case "delete": return [`${h}DELETE ${count} elements (anything hosted on them goes too):`, ...named(n, o.ids)];
    case "move": return [`${h}Move ${count} elements by ${(o.vector_mm ?? []).map((v: number) => Math.round(v)).join(", ")} mm:`, ...named(n, o.ids)];
    case "set_param": {
      const v = o.value_mm != null ? mm(o.value_mm) : o.by_mm != null ? `${o.by_mm > 0 ? "+" : ""}${mm(o.by_mm)}` : JSON.stringify(o.value_text ?? o.value);
      return [`${h}Set ${o.param} to ${v} on ${count} elements${o.on_type ? " (ON THEIR TYPE: every element of that type changes)" : ""}:`, ...named(n, o.ids)];
    }
    case "change_type": return [`${h}Change ${count} elements to ${o.type_name ?? typeName(n, o.type_id)}:`, ...named(n, o.ids)];
    case "attach": return [`${h}Attach the ${o.side === "base" ? "base" : "top"} of ${count} walls to ${isRef(o.target) ? made(o.target) : elementName(n, o.target)}:`, ...named(n, o.ids)];
    case "duplicate_type": return [`${h}New type "${o.new_name}" copied from ${typeName(n, o.type)}` +
      (Array.isArray(o.layers) ? `, layers ${o.layers.map((l: P) => `${l.material ?? "?"} ${mm(l.width_mm)}`).join(" + ")}` : "") +
      (o.params ? `, ${Object.entries(o.params).map(([k, v]) => `${k} ${v}`).join(", ")}` : "")];
    case "create_roof": {
      const slopes = Array.isArray(o.slopes_deg) ? o.slopes_deg.map((s: number | null) => (s == null ? "end" : `${s}°`)).join(", ")
        : o.slope_deg != null ? `${o.slope_deg}° every edge` : "flat";
      return [`${h}Roof on ${o.level}${o.offset_mm != null ? ` +${mm(o.offset_mm)}` : ""}, ${o.type_name ?? "the first roof type"}, ` +
        `${(o.outline_mm ?? []).length} edges, slopes ${slopes}${o.overhang_mm ? `, overhang ${mm(o.overhang_mm)}` : ""}`];
    }
    case "create_railing": return [`${h}Railing ${o.type_name ?? "(first railing type)"} on ${o.level ?? "?"}` +
      (o.host ? ` on ${isRef(o.host) ? made(o.host) : elementName(n, o.host)}` : `, ${(o.path_mm ?? []).length} points from ${xy(o.path_mm?.[0])}`)];
    case "create_stair": return [`${h}Stair ${o.base_level} → ${o.top_level}, ${(o.runs ?? []).length} runs${o.risers ? `, ${o.risers} risers` : ""}` +
      (o.railings === false ? ", no railings" : ", with railings")];
    case "room_separation": return [`${h}${(o.lines_mm ?? []).length} room separation lines on ${o.level}`];
    case "opening": return [`${h}Cut a ${(o.outline_mm ?? []).length}-sided hole in ${isRef(o.host) ? made(o.host) : elementName(n, o.host)}`];
    case "shaft": return [`${h}Shaft opening ${o.base_level} → ${o.top_level}: cuts every floor between`];
    default: return [`${h}${o.op}`];
  }
}

/** The lines a person reads before approving. */
export function explain(command: string, params: unknown, names: Names = { types: {}, elements: {} }): string[] {
  const p = (params ?? {}) as P;
  const data: P[] = Array.isArray(p.data) ? p.data : [];
  switch (command) {
    case "fmc_model_edit": {
      const ops: P[] = Array.isArray(p.ops) ? p.ops : [];
      return cap([...(p.why ? [`Why: ${p.why}`] : []), ...(p.dry_run ? ["DRY RUN: nothing will change"] : []),
        ...ops.flatMap((o, i) => op(o, names, i + 1)), "All or nothing; one Undo takes it all back."]);
    }
    case "create_line_based_element":
      return cap(["New walls:", ...tally(data.map((d) => `${typeName(names, d.typeId, d.category)}, ${mm(d.height)} high` +
        (d.baseOffset ? `, base ${mm(d.baseOffset)}` : ""))), ...data.slice(0, 4).map((d) => `   ${xy(d.locationLine?.p0)} → ${xy(d.locationLine?.p1)}`)]);
    case "create_surface_based_element":
      return cap(["New floors / ceilings:", ...tally(data.map((d) => `${typeName(names, d.typeId, d.category)}${d.name ? ` "${d.name}"` : ""}`))]);
    case "create_point_based_element":
      return cap(["New doors / windows / components:", ...tally(data.map((d) => `${typeName(names, d.typeId, d.name)}${d.baseOffset ? `, sill ${mm(d.baseOffset)}` : ""}`))]);
    case "create_room":
      return cap(["New rooms:", ...data.map((d) => `${d.number ?? ""} ${d.name ?? ""} at ${xy(d.location)}`.trim())]);
    case "create_level":
      return cap(["New levels:", ...data.map((d) => `${d.name ?? "?"} at ${mm(d.elevation)}`)]);
    case "delete_element":
      return cap([`DELETE ${(p.elementIds ?? []).length} elements:`, ...named(names, p.elementIds)]);
    case "operate_element":
      return cap([`${p.data?.action ?? "?"} on ${(p.data?.elementIds ?? []).length} elements:`, ...named(names, p.data?.elementIds)]);
    case "send_code_to_revit": {
      const code = String(p.code ?? "").split(/\r?\n/).filter((l) => l.trim());
      return cap([`Runs Revit API code (${code.length} lines${p.transactionMode === "none" ? ", no transaction" : ", in one transaction"}):`,
        ...code.slice(0, MAX - 2).map((l) => `   ${l.trim().slice(0, 110)}`)]);
    }
    default: {
      const lists = Object.entries(p).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${(v as unknown[]).length} ${k}`);
      return [`${command}${lists.length ? ": " + lists.join(", ") : ""}`];
    }
  }
}

/** The type ids and element ids a batch names, to look up in Revit before it is queued. */
export function namesWanted(params: unknown): { typeIds: number[]; elementIds: string[] } {
  const p = (params ?? {}) as P;
  const typeIds = new Set<number>(); const elementIds = new Set<string>();
  for (const d of Array.isArray(p.data) ? p.data : []) if (typeof d?.typeId === "number") typeIds.add(d.typeId);
  for (const o of Array.isArray(p.ops) ? p.ops : []) {
    for (const x of Array.isArray(o?.ids) ? o.ids : []) if (!isRef(x)) elementIds.add(String(x));
    for (const k of ["target", "host"]) if (o?.[k] != null && !isRef(o[k])) elementIds.add(String(o[k]));
    if (typeof o?.type_id === "number") typeIds.add(o.type_id);
    if (o?.op === "duplicate_type" && o.type != null) typeIds.add(Number(o.type));
  }
  for (const x of p.elementIds ?? p.data?.elementIds ?? []) elementIds.add(String(x));
  return { typeIds: [...typeIds].slice(0, 100), elementIds: [...elementIds].slice(0, 200) };
}

/** Elements as fmc_element_geometry describes them, for the lines: "Rooms: F15 Bedroom (Level 1)". */
export function elementNames(elements: Array<P>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of elements ?? []) out[String(e.id)] = `${e.category || "?"}: ${e.type || e.name || ""}${e.level ? ` (${e.level})` : ""}`.replace(/: \(/, " (");
  return out;
}
