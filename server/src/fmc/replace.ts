import { z } from "zod";

/**
 * Preview-only structural replacement. Keep this text identical to
 * FmcReplacePreview.TransactionReason in commandset/Services/Fmc/FmcReplace.cs.
 */
export const REPLACE_TRANSACTION_MODEL = "sequential";
export const REPLACE_DELETION_PASS = "after_all_rows_pass";
export const REPLACE_TRANSACTION_REASON =
  "Rows run as sequential sub-transactions inside one transaction, inside one TransactionGroup. " +
  "Each sub-transaction commits into that transaction, so a later row sees earlier rows' new elements. " +
  "That is required because some B7 pedestals depend on an earlier foundation and some B3 beams meet at a joint with an earlier beam. " +
  "A failed row rolls back only its own sub-transaction, so it does not undo earlier rows or drop the group report. " +
  "Deletion is a second pass: it runs only after every row's create, verify and rebind gates have passed. " +
  "The outer transaction and the group are always rolled back and never committed. There is no apply mode.";

/** Founder directive: a keynote filled at creation, X.YYY_ZZ (for example S.FND_01). */
export const KEYNOTE_RE = /^[A-Z]\.[A-Z0-9]{3}_[A-Z0-9]{2}$/;

const point = z.array(z.number()).min(2).max(3);
const point3 = z.array(z.number()).min(3).max(3);
const loop = z.array(point).min(3);

const param = z.object({
  name: z.string().min(1),
  value_mm: z.number().optional(),
  value: z.number().optional(),
  value_text: z.string().optional(),
  element_id: z.number().int().optional(),
}).refine((p) => [p.value_mm, p.value, p.value_text, p.element_id].filter((v) => v !== undefined).length === 1, "a parameter needs exactly one of value_mm, value, value_text, element_id");

const expectParam = param.and(z.object({ tolerance_mm: z.number().positive().optional() }));

export const REPLACE_ROW = z.object({
  id: z.string().min(1).describe("Row id, for example B7:NEW-01 or B3:1666251. Later rows refer to it with depends_on and join_to."),
  kind: z.enum(["foundation_slab", "isolated_foundation", "beam", "column"]),
  old_ids: z.array(z.number().int().positive()).optional().default([]).describe("Exact element ids to delete after every row has been created, verified and rebound. Empty for an add."),
  expected_deleted_ids: z.array(z.number().int().positive()).optional().describe("Ids Revit may also delete with the old ones (a known cascade). Anything else Revit deletes fails the row. Defaults to old_ids only."),
  type_id: z.number().int().positive().describe("Exact type element id. A type name is not accepted."),
  level_id: z.number().int().positive().describe("Exact level element id."),
  top_level_id: z.number().int().positive().optional().describe("column: exact top level id."),
  keynote: z.string().regex(KEYNOTE_RE, "keynote must be X.YYY_ZZ, for example S.FND_01"),
  boundary_mm: loop.optional().describe("foundation_slab: plan loop [x, y] in millimetres. The tool closes it."),
  point_mm: point.optional().describe("isolated_foundation or column: [x, y] or [x, y, z] in millimetres."),
  start_mm: point3.optional().describe("beam: location-curve start [x, y, z] in millimetres. For a top-justified beam this is the top."),
  end_mm: point3.optional().describe("beam: location-curve end [x, y, z] in millimetres."),
  top_mm: z.number().optional().describe("foundation_slab: absolute Z of the top face, in millimetres. Sets Height Offset From Level to top_mm minus the level elevation, which is right when the type builds downward. Verify checks the solid."),
  z_justification: z.enum(["top", "center", "origin", "bottom"]).optional().describe("beam: required. top means the location curve is the top of the beam."),
  y_justification: z.enum(["left", "center", "origin", "right"]).optional().describe("beam: lateral justification. Omit to leave the family default."),
  material_id: z.number().int().positive().optional().describe("Family instance structural material id. Refused on a foundation slab, because that would change the type."),
  parameters: z.array(param).optional().describe("Instance parameters to set after creation, by name."),
  depends_on: z.array(z.string().min(1)).optional().describe("Earlier row ids this row needs. A later id is rejected: rows are sequential."),
  join_to: z.array(z.union([z.string().min(1), z.number().int().positive()])).optional().describe("Row ids (earlier rows) or element ids to join to the new element."),
  expect: z.object({
    type_id: z.number().int().positive().optional(),
    level_id: z.number().int().positive().optional(),
    keynote: z.string().regex(KEYNOTE_RE).optional(),
    tolerance_mm: z.number().positive().max(50).optional(),
    boundary_mm: loop.optional(),
    size_mm: z.array(z.number().positive()).min(2).max(3).optional().describe("[width, height] for a beam, or [x, y, thickness] for a slab or footing, in millimetres."),
    top_mm: z.number().optional(),
    underside_mm: z.number().optional(),
    start_mm: point3.optional(),
    end_mm: point3.optional(),
    point_mm: point.optional(),
    material_id: z.number().int().positive().optional(),
    parameters: z.array(expectParam).optional(),
  }).optional(),
});

export type ReplaceRow = z.infer<typeof REPLACE_ROW>;

/** Problems that make the whole call invalid before Revit is asked. */
export function replaceProblems(rows: ReplaceRow[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const olds = new Set<number>();
  rows.forEach((row, index) => {
    if (ids.has(row.id)) problems.push(`Two rows use the id ${row.id}.`);
    ids.add(row.id);
    for (const id of row.old_ids ?? []) {
      if (olds.has(id)) problems.push(`Old id ${id} is listed on more than one row.`);
      olds.add(id);
    }
    const earlier = new Set(rows.slice(0, index).map((r) => r.id));
    for (const dep of row.depends_on ?? []) {
      if (!ids.has(dep) || !earlier.has(dep)) problems.push(`${row.id} depends_on ${dep}, which is not an earlier row. Rows are sequential; put ${dep} first.`);
    }
    for (const join of row.join_to ?? []) {
      if (typeof join === "string" && !earlier.has(join)) problems.push(`${row.id} join_to ${join} is not an earlier row.`);
    }
    if (row.expected_deleted_ids) {
      const have = new Set(row.expected_deleted_ids);
      for (const id of row.old_ids ?? []) if (!have.has(id)) problems.push(`${row.id} expected_deleted_ids must include old id ${id}.`);
    }
    if (row.kind === "foundation_slab" && !(row.boundary_mm && row.boundary_mm.length >= 3)) problems.push(`${row.id} foundation_slab needs boundary_mm.`);
    if ((row.kind === "isolated_foundation" || row.kind === "column") && !row.point_mm) problems.push(`${row.id} ${row.kind} needs point_mm.`);
    if (row.kind === "beam") {
      if (!row.start_mm || !row.end_mm) problems.push(`${row.id} beam needs start_mm and end_mm.`);
      if (!row.z_justification) problems.push(`${row.id} beam needs z_justification (top, center, origin or bottom).`);
    }
    if (row.kind === "foundation_slab" && row.material_id) problems.push(`${row.id} foundation_slab refuses material_id. Pass a type_id that already has the material.`);
  });
  return problems;
}

export const REPLACE_ROWS = z.array(REPLACE_ROW).min(1).max(64).superRefine((rows, ctx) => {
  for (const problem of replaceProblems(rows)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

/** One B7 foundation row and one B3 beam row, in the shape the manifests map onto. Type and level ids are placeholders until a read of the copy. */
export const B7_NEW_CF1_ROW = {
  id: "B7:NEW-01",
  kind: "foundation_slab" as const,
  old_ids: [1666458, 1666478],
  type_id: 100001,
  level_id: 200001,
  keynote: "S.FND_01",
  boundary_mm: [[6800, -9000], [10800, -9000], [10800, -4200], [6800, -4200]],
  top_mm: -500,
  expect: {
    top_mm: -500,
    underside_mm: -1400,
    size_mm: [4000, 4800, 900],
    boundary_mm: [[6800, -9000], [10800, -9000], [10800, -4200], [6800, -4200]],
  },
};

export const B3_BEAM_1666251_ROW = {
  id: "B3:1666251",
  kind: "beam" as const,
  old_ids: [1666251],
  type_id: 100002,
  level_id: 200002,
  keynote: "S.FRM_01",
  start_mm: [3700, -8000, 4175],
  end_mm: [3700, -4000, 4175],
  z_justification: "top" as const,
  y_justification: "origin" as const,
  expect: {
    start_mm: [3700, -8000, 4175],
    end_mm: [3700, -4000, 4175],
    size_mm: [300, 750],
    top_mm: 4175,
    underside_mm: 3425,
  },
};

export const B7_PEDESTAL_ROW = {
  id: "B7:NEW-03",
  kind: "isolated_foundation" as const,
  old_ids: [] as number[],
  type_id: 100003,
  level_id: 200001,
  keynote: "S.FND_02",
  point_mm: [9200, -8000],
  depends_on: ["B7:NEW-01"],
  parameters: [{ name: "Height Offset From Level", value_mm: -500 }],
  expect: { top_mm: -250, underside_mm: -500, size_mm: [450, 450, 250], point_mm: [9200, -8000] },
};
