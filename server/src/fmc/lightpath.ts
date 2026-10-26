/**
 * The owner's rule (19 Oct): lighting families show their light path. From each lens, a beam: the cone from the lens
 * to the light field at the working distance, on the Light Path subcategory (so a view can turn it off), in a
 * see-through material, on every level, with the instance switch Show Light Path (default Yes). The working distance
 * and the field diameter are values an engineer confirms (rule 5): they are recorded as assumed.
 * Pure: recipe ops in, ops out.
 */
type Op = Record<string, any>;

export interface Lens {
  /** The lens solid (a revolution about a vertical axis): the beam starts on its face and shares its axis. */
  solid: string;
  /** A switch the lens already depends on (e.g. Second Light Head): its beam needs it too. */
  with?: string;
}

export interface LightPath {
  lenses: Lens[];
  /** Which way the light leaves the lens in the family's own coordinates: +1 up (+z), -1 down. */
  dir: 1 | -1;
  /** Lens to the working plane, mm. */
  distance: number;
  /** The light field's diameter at the working plane, mm (0 for a spreading beam: then `spread_deg`). */
  field_d: number;
  spread_deg?: number;
  why: string;
}

/** The light-path ops for a recipe, and the value rows that record the assumed distance and field. */
export function lightPathOps(ops: Op[], lp: LightPath): { ops: Op[]; values: Record<string, any>; notes: string[] } {
  const out: Op[] = [], notes: string[] = [];
  if (ops.some((o) => o.op === "add_family_param" && o.name === "Show Light Path")) return { ops: [], values: {}, notes: ["Show Light Path is there already"] };
  const types = ops.filter((o) => o.op === "add_type").map((o) => String(o.name));
  const glass = ops.find((o) => o.op === "add_material" && /Glass_Clear|Polycarbonate_Clear/.test(String(o.name)));
  const matParam = glass?.param ?? "Light Path Material";
  out.push(
    { op: "add_subcategory", name: "Light Path", line_weight_projection: 1, line_weight_cut: 1, color: [150, 110, 0] },
    { op: "add_family_param", name: "Show Light Path", type: "YesNo", group: "Constraints", instance: true },
    ...types.map((t) => ({ op: "set_type_value", name: `${t}/Show Light Path`, type: t, param: "Show Light Path", value: true })),
    ...(glass ? [] : [{ op: "add_family_param", name: matParam, type: "Material", group: "Materials" }, { op: "add_material", name: "FMC_Glass_Clear", param: matParam }]),
  );
  for (const l of lp.lenses) {
    const lens = ops.find((o) => o.op === "revolution" && o.name === l.solid && (o.axis ?? "z") === "z");
    if (!lens) { notes.push(`${l.solid}: no vertical lens revolution, no beam`); continue; }
    const r0 = Math.max(...(lens.profile as number[][]).map((p) => p[0]));
    const zs = (lens.profile as number[][]).map((p) => p[1]);
    const face = lp.dir > 0 ? Math.max(...zs) : Math.min(...zs);
    const end = face + lp.dir * lp.distance;
    const r1 = lp.field_d > 0 ? lp.field_d / 2 : r0 + lp.distance * Math.tan(((lp.spread_deg ?? 60) * Math.PI) / 360);
    const name = `${l.solid} Light Path`;
    const prof = lp.dir > 0 ? [[0, face], [r0, face], [r1, end], [0, end]] : [[0, end], [r1, end], [r0, face], [0, face]];
    out.push(
      { op: "revolution", name, axis_at: lens.axis_at, profile: prof.map((p) => p.map((v) => Math.round(v * 10) / 10)) },
      { op: "set_subcategory", name, subcategory: "Light Path" },
      { op: "set_material_param", name, param: matParam },
      { op: "set_visibility", name, coarse: true, medium: true, fine: true },
    );
    if (l.with) {
      const sw = `Show Light Path ${l.with}`;
      out.push({ op: "add_family_param", name: sw, type: "YesNo", group: "Constraints", instance: true },
        { op: "set_formula", name: sw, formula: `and(Show Light Path, ${l.with})` },
        { op: "set_visible_param", name: `${name}/Visible`, solid: name, param: sw });
    } else out.push({ op: "set_visible_param", name: `${name}/Visible`, solid: name, param: "Show Light Path" });
    notes.push(`${name}: from the lens (${Math.round(r0 * 2)} mm) to a ${Math.round(r1 * 2)} mm field ${lp.distance} mm away`);
  }
  const values = {
    "Light Path Distance": { value: lp.distance, source_status: "assumed", source: lp.why },
    "Light Field Diameter": { value: lp.field_d || `${lp.spread_deg ?? 60}° spread`, source_status: "assumed", source: lp.why },
  };
  return { ops: out, values, notes };
}

/** The lighting families the sample has, and their beams. */
export const LIGHT_PATHS: Record<string, LightPath> = {
  FMC_E_LightFixture_OperatingLight_Ceiling_Detailed: {
    lenses: [{ solid: "Lens Main" }, { solid: "Lens Satellite", with: "Second Light Head" }],
    dir: 1, distance: 1000, field_d: 250,
    why: "IEC 60601-2-41 measures an operating light's field at 1 m; 250 mm field typical; confirm from the chosen product (engineer)",
  },
};
