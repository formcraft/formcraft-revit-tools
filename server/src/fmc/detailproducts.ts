/**
 * QS03 for products whose curved parts are already true shapes, fixed per type (pgen v2: the generator, the fire pump
 * set): what opens gets the instance switch `Open`, the clearance gets its `Show Clearance` switch, and Fine becomes the
 * smooth Rhino twins (fmc_rhino twins on the result). Pure: recipes in, recipes out.
 */
import type { DetailResult, RecipeLike } from "./detailgen.js";
import { clearanceOps } from "./detailwindows.js";

type Op = Record<string, any>;
type Pt = number[];

/** A door drawn on the front face (sketch front: [x, z], depth toward -y from `start` to `end`), with what it carries. */
export interface FrontDoor { door: string; carried?: string[]; hinge: "left" | "right" }

const box = (pts: Pt[]) => ({ x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), z0: Math.min(...pts.map((p) => p[1])), z1: Math.max(...pts.map((p) => p[1])) });
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The open position of a front-face door and what it carries: turned 90° outward (toward -y) about its hinge edge on
 * the face. Drawn in plan (each part's outline seen from above, its height kept), fixed like the closed one.
 */
export function swungOpen(ops: Op[], d: FrontDoor): Op[] {
  const door = ops.find((o) => o.op === "extrusion" && o.name === d.door && o.sketch === "front" && Array.isArray(o.points));
  if (!door) throw new Error(`no front-face door ${d.door}`);
  const db = box(door.points);
  const face = -Number(door.start);              // the face the door sits on (y)
  const hx = d.hinge === "left" ? db.x0 : db.x1;
  const side = d.hinge === "left" ? 1 : -1;      // the door runs +x from a left hinge, -x from a right one
  const out: Op[] = [];
  for (const name of [d.door, ...(d.carried ?? [])]) {
    const o = ops.find((x) => x.op === "extrusion" && x.name === name && x.sketch === "front" && Array.isArray(x.points));
    if (!o) continue;
    const b = box(o.points);
    // along the door (distance from the hinge) becomes out from the face; out from the face becomes across the hinge
    const a0 = side * (b.x0 - hx), a1 = side * (b.x1 - hx);
    const along = [Math.min(a0, a1), Math.max(a0, a1)];
    const outFace = [Number(o.start) - Number(door.start), Number(o.end) - Number(door.start)];   // ≥ 0, toward -y
    const xs = [hx - side * outFace[1], hx - side * outFace[0]];
    const ys = [face - along[1], face - along[0]];
    const pts: Pt[] = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)], [Math.min(...xs), Math.max(...ys)]].map((p) => p.map(r2));
    out.push({ op: "extrusion", name: `${name} Open`, sketch: "plan", start: b.z0, end: b.z1, points: pts });
    for (const k of ["set_subcategory", "set_material_param"]) {
      const src = ops.find((x) => x.op === k && x.name === name);
      if (src) out.push({ ...src, name: `${name} Open` });
    }
    const vis = ops.find((x) => x.op === "set_visibility" && x.name === name);
    out.push(vis ? { ...vis, name: `${name} Open` } : { op: "set_visibility", name: `${name} Open`, coarse: false, medium: true, fine: true });
  }
  return out;
}

export interface ProductSpec { doors?: FrontDoor[] }

/** The product specs the sample needs (from the chat's detail lists and the recipes' own parts). */
export const PRODUCT_SPECS: Record<string, ProductSpec> = {
  FMC_E_EQ_Generator_Diesel_Standby: { doors: [
    { door: "Side Door 1", carried: ["Door Handle 1"], hinge: "left" },
    { door: "Side Door 2", carried: ["Door Handle 2"], hinge: "left" },
  ] },
  FMC_FP_MechEq_FirePump_Set: {},
};

export function detailProduct(std: RecipeLike, spec: ProductSpec = PRODUCT_SPECS[std.family] ?? {}): DetailResult {
  const types = std.ops.filter((o) => o.op === "add_type").map((o) => String(o.name));
  const notes: string[] = [];
  let ops = std.ops.slice();
  const add: Op[] = [];
  if (spec.doors?.length) {
    add.push(
      { op: "add_family_param", name: "Open", type: "YesNo", group: "Constraints", instance: true },
      ...types.map((t) => ({ op: "set_type_value", name: `${t}/Open`, type: t, param: "Open", value: false })),
      { op: "add_family_param", name: "Closed", type: "YesNo", group: "Constraints", instance: true },
      { op: "set_formula", name: "Closed", formula: "not(Open)" },
    );
    for (const d of spec.doors) {
      const open = swungOpen(std.ops, d);
      add.push(...open);
      for (const name of [d.door, ...(d.carried ?? [])]) {
        if (ops.some((o) => o.op === "set_visible_param" && o.solid === name)) { notes.push(`${name} has a switch already: left as it is`); continue; }
        add.push({ op: "set_visible_param", name: `${name}/Visible`, solid: name, param: "Closed" });
        add.push({ op: "set_visible_param", name: `${name} Open/Visible`, solid: `${name} Open`, param: "Open" });
      }
    }
    notes.push(`Open swings ${spec.doors.map((d) => d.door).join(" and ")} 90° outward with their handles`);
  }
  // clearance: a zone with no switch gets Show Clearance; a family with none gets a zone
  const zone = ops.find((o) => o.op === "extrusion" && /^Clearance/.test(String(o.name)));
  const hasSwitch = ops.some((o) => o.op === "add_family_param" && o.name === "Show Clearance");
  if (zone && !hasSwitch) {
    add.push({ op: "add_family_param", name: "Show Clearance", type: "YesNo", group: "Constraints", instance: true },
      ...types.map((t) => ({ op: "set_type_value", name: `${t}/Show Clearance`, type: t, param: "Show Clearance", value: true })));
    if (!ops.some((o) => o.op === "set_visible_param" && o.solid === zone.name))
      add.push({ op: "set_visible_param", name: `${zone.name}/Visible`, solid: zone.name, param: "Show Clearance" });
    notes.push(`${zone.name} gets the Show Clearance switch`);
  } else if (!zone) {
    const c = clearanceOps(std, { face: "Front", side: -1, from: "Left", to: "Right", depth: 1000, param: "Clearance Maintenance", why: "maintenance zone in front; confirm (owner or engineer)" });
    add.push(...c.ops);
    if (c.ops.length) notes.push("a 1000 mm maintenance zone in front, with Show Clearance");
  }
  const at = ops.map((o) => o.op).lastIndexOf("set_type_value") + 1;
  return {
    recipe: { ...std, family: `${std.family}_Detailed`, ops: [...ops.slice(0, at), ...add, ...ops.slice(at)],
      about: `Detailed product (QS03 generator, ${new Date().toISOString().slice(0, 10)}): ${std.family}${notes.length ? "; " + notes.join("; ") : ""}. Medium the native body; Fine its smooth Rhino twins (fmc_rhino twins).` },
    components: [],
    notes,
  };
}
