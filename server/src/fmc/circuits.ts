/**
 * fmc_systems create_circuits (KISIC_GAP_SCRIPTS 4.4), the pure part: the request checked and the payload for Revit's
 * fmc_circuits_create. Chosen devices are grouped into circuits on a named board; when the board has no distribution
 * system, the one named is taken from the kit's Electrical_Settings (rule 7: the kit decides, by name, never a value in
 * code). Rule 5: the payload carries no rating, wire size, demand factor or load: Revit's own values stand and the
 * engineer sizes.
 */
import { z } from "zod";

export interface KitVoltage { name: string; value: number; min: number; max: number }
export interface KitSystem { name: string; phase: "Three" | "Single"; config: string; wires: number; ll: string | null; lg: string | null }
export interface KitElectrical { voltages: KitVoltage[]; systems: KitSystem[]; loads: string[] }

export const CIRCUIT = z.object({
  elements: z.array(z.string().min(1)).min(1).describe("the devices on this circuit: unique ids or element ids"),
  load_name: z.string().optional().describe("the circuit's Load Name (text only)"),
});
export type CircuitRequest = z.infer<typeof CIRCUIT>;

export interface CreateCircuitsRequest {
  board: string;
  board_name: string;
  distribution_system: string;
  circuits: CircuitRequest[];
  dry_run: boolean;
}

/** Keys that would size or rate a circuit: never sent (rule 5). */
export const SIZING_KEYS = ["rating", "rating_a", "wire_size", "wire", "demand_factor", "apparent_load", "true_load", "frame", "poles"];

export function circuitsPayload(req: CreateCircuitsRequest, kit: KitElectrical | null, kitProblem = ""): { problems: string[]; payload?: Record<string, unknown> } {
  const problems: string[] = [];
  if (!req.board.trim()) problems.push("Name the board (its unique id, element id or panel name)");
  if (!req.circuits.length) problems.push("Give at least one circuit (the devices on it)");
  const seen = new Map<string, number>();
  req.circuits.forEach((c, i) => {
    for (const e of c.elements) {
      const k = e.trim();
      if (seen.has(k) && seen.get(k) !== i) problems.push(`${k} is on circuit ${seen.get(k)! + 1} and circuit ${i + 1}: a device goes on one circuit`);
      else seen.set(k, i);
    }
  });
  let spec: KitSystem | undefined;
  let voltages: KitVoltage[] = [];
  const ds = req.distribution_system.trim();
  if (ds) {
    if (!kit) problems.push(`The kit's Electrical_Settings isn't readable${kitProblem ? ` (${kitProblem})` : ""}: the distribution system comes from the kit`);
    else {
      spec = kit.systems.find((s) => s.name === ds);
      if (!spec) problems.push(`${ds} isn't a distribution system in the kit's Electrical_Settings (it has ${kit.systems.map((s) => s.name).join(", ") || "none"})`);
      else {
        const names = [spec.ll, spec.lg].filter((v): v is string => !!v);
        voltages = kit.voltages.filter((v) => names.includes(v.name));
        for (const n of names) if (!voltages.some((v) => v.name === n)) problems.push(`${ds} names voltage ${n}, which the kit's Electrical_Settings doesn't define`);
      }
    }
  }
  if (problems.length) return { problems };
  return {
    problems,
    payload: {
      dry_run: req.dry_run, board: req.board.trim(), board_name: req.board_name.trim(),
      ...(spec ? { distribution_system: spec, voltages } : {}),
      circuits: req.circuits.map((c) => ({ elements: c.elements.map((e) => e.trim()), ...(c.load_name?.trim() ? { load_name: c.load_name.trim() } : {}) })),
    },
  };
}
