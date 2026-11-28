/** Casework in the model: a room reading as a run's walls and services, and the coordination checks (rule 5). Part of casework_place.ts. */
import { RunWall, Standards, Unit } from "./casework.js";
import { wallFrame } from "./casework_place_plan.js";

// ---------------------------------------------------------------------------------------------------------------
// Room reading → a run's walls and the services

export interface RoomRead {
  room: { number: string; name: string; level: string };
  /** The room's outer boundary, anticlockwise, on the finish faces; mm */
  walls: Array<{ start: [number, number]; end: [number, number]; wall_id?: number }>;
  openings: Array<{ kind: "door" | "window"; wall_id?: number; at: [number, number]; width: number; sill?: number }>;
  points: Array<{ category: string; family: string; type: string; at: [number, number, number]; system?: string }>;
}

export type ServiceKind = "water" | "waste" | "gas" | "socket" | "other";
export interface Service { kind: ServiceKind; label: string; at: [number, number, number] }

/** What a point is, from its category and names (gas before waste before water: a "gas tap" is gas). */
export function serviceKind(p: { category: string; family: string; type: string; system?: string }): ServiceKind {
  const text = `${p.family} ${p.type} ${p.system ?? ""}`;
  if (/gas|lpg/i.test(text)) return "gas";
  if (/waste|soil|sanitary|drain|trap|sw\b/i.test(text)) return "waste";
  if (/water|dcw|dhw|cold|hot|tap|stop ?cock|valve/i.test(text)) return "water";
  if (/electrical fixture/i.test(p.category) || /socket|outlet|power/i.test(text)) return "socket";
  if (/plumbing fixture/i.test(p.category)) return "water";
  return "other";
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * The room as a run's walls (W1, W2, … in boundary order, each with its place in the model and its doors and windows)
 * and the services points. Modules, the corner, the sink and appliances are the person's to add: nothing is assumed.
 */
export function runFromRoom(read: RoomRead): { walls: RunWall[]; services: Service[]; sills: Array<{ wall: string; offset: number; width: number; sill: number }>; notes: string[] } {
  const notes: string[] = [];
  const walls: RunWall[] = read.walls.map((w, i) => ({ name: `W${i + 1}`, length: Math.round(dist(w.start, w.end)), start: w.start, end: w.end,
    ...(w.wall_id !== undefined ? { wall_id: w.wall_id } : {}), openings: [] }));
  const sills: Array<{ wall: string; offset: number; width: number; sill: number }> = [];
  for (const o of read.openings) {
    // the face this opening sits in: its own wall's face where the point projects inside it, else the nearest face
    let best: { w: RunWall; t: number; d: number } | null = null;
    for (const w of walls) {
      if (o.wall_id !== undefined && w.wall_id !== undefined && w.wall_id !== o.wall_id) continue;
      const L = w.length, dx = (w.end![0] - w.start![0]) / L, dy = (w.end![1] - w.start![1]) / L;
      const t = (o.at[0] - w.start![0]) * dx + (o.at[1] - w.start![1]) * dy;
      const d = Math.abs(-(o.at[0] - w.start![0]) * dy + (o.at[1] - w.start![1]) * dx);
      if (t < 0 || t > L) continue;
      if (!best || d < best.d) best = { w, t, d };
    }
    if (!best) { notes.push(`A ${o.kind} at ${o.at.map(Math.round).join(", ")} isn't on the room's boundary`); continue; }
    const offset = Math.round(best.t - o.width / 2);
    best.w.openings!.push({ kind: o.kind, offset, width: Math.round(o.width) });
    if (o.kind === "window" && typeof o.sill === "number") sills.push({ wall: best.w.name, offset, width: Math.round(o.width), sill: Math.round(o.sill) });
  }
  for (const w of walls) if (!w.openings!.length) delete w.openings;
  const services = read.points.map((p) => ({ kind: serviceKind(p), label: `${p.family} : ${p.type}`, at: p.at }));
  if (!services.some((x) => x.kind === "water" || x.kind === "waste")) notes.push("No water or waste point is modelled in the room");
  return { walls, services, sills, notes };
}

/** The run's name for each wall the room reading named (W1, W2, …), matched by where the wall face runs (within 5 mm). */
export function matchWalls(roomWalls: RunWall[], runWalls: RunWall[]): Map<string, string> {
  const near = (a?: [number, number], b?: [number, number]) => !!a && !!b && dist(a, b) <= 5;
  const out = new Map<string, string>();
  for (const r of roomWalls) {
    const w = runWalls.find((x) => near(x.start, r.start) && near(x.end, r.end));
    if (w) out.set(r.name, w.name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Coordination checks (board CW_Pane step 3): they flag with the rule, and never move a service or a unit

export interface CheckFlag { check: string; mark: string; state: "ok" | "flag" | "info"; detail: string; rule: string }

export const NO_KIT_RULE = "No kit rule yet (kit change request: casework coordination rules in FMC_Casework_Standards.json)";
const R5 = "rule 5: the professional decides";

/** Services on a wall within the casework depth, with how far along the wall they are. */
function onWall(services: Service[], w: RunWall, depth: number): Array<Service & { t: number }> {
  const f = wallFrame(w);
  if (typeof f === "string") return [];
  return services.flatMap((sv) => {
    const rx = sv.at[0] - f.origin[0], ry = sv.at[1] - f.origin[1];
    const t = rx * f.dir[0] + ry * f.dir[1];
    const d = rx * f.normal[0] + ry * f.normal[1];
    return t >= 0 && t <= f.length && d >= -depth && d <= depth ? [{ ...sv, t }] : [];
  });
}

export function coordinationChecks(units: Unit[], walls: RunWall[], services: Service[], sills: Array<{ wall: string; offset: number; width: number; sill: number }>, s: Standards): CheckFlag[] {
  const out: CheckFlag[] = [];
  const byWall = new Map(walls.map((w) => [w.name, onWall(services, w, s.base.depth)]));
  const within = (list: Array<Service & { t: number }>, u: Unit, kind: ServiceKind) => list.filter((x) => x.kind === kind && x.t >= u.offset && x.t <= u.offset + u.width);
  const span = (u: Unit) => `${u.wall} ${u.offset}–${u.offset + u.width}`;
  const anyGas = services.some((x) => x.kind === "gas");

  for (const u of units) {
    const list = byWall.get(u.wall) ?? [];
    if (u.kind === "sink" || u.kind === "basin") {
      for (const kind of ["waste", "water"] as const) {
        const here = within(list, u, kind);
        out.push(here.length
          ? { check: `${kind} at the sink`, mark: u.mark, state: "ok", detail: `${here.length} ${kind} point(s) behind ${u.mark} (${span(u)})`, rule: NO_KIT_RULE }
          : { check: `${kind} at the sink`, mark: u.mark, state: "flag", detail: `No ${kind} point behind ${u.mark} (${span(u)}): move the sink or route the ${kind}`, rule: `${NO_KIT_RULE}; ${R5}` });
      }
    }
    if (u.kind === "gap" && u.fronts === "cooker") {
      const gas = within(list, u, "gas");
      if (gas.length) out.push({ check: "gas at the cooker", mark: u.mark, state: "info", detail: `A gas point is behind the cooker space ${u.mark} (${span(u)}): its route, valve and clearances are the professional's`, rule: R5 });
      else if (anyGas) out.push({ check: "gas at the cooker", mark: u.mark, state: "flag", detail: `The room has a gas point, but not behind the cooker space ${u.mark} (${span(u)})`, rule: `${NO_KIT_RULE}; ${R5}` });
      else out.push({ check: "gas at the cooker", mark: u.mark, state: "info", detail: `No gas point in the model: whether ${u.mark} is gas or electric, and its supply, are the professional's`, rule: R5 });
      const sockets = within(list, u, "socket");
      if (sockets.length) out.push({ check: "socket over the cooker", mark: u.mark, state: "flag", detail: `${sockets.length} socket(s) within the cooker space ${u.mark} (${span(u)})`, rule: `${NO_KIT_RULE}; ${R5} (electrical)` });
    }
    if (u.kind === "tall") {
      const sockets = within(list, u, "socket");
      if (sockets.length) out.push({ check: "socket behind a tall unit", mark: u.mark, state: "flag", detail: `${sockets.length} socket(s) would be hidden behind tall unit ${u.mark} (${span(u)})`, rule: `${NO_KIT_RULE}; ${R5} (electrical)` });
    }
  }
  // windows whose sill is below the worktop line (carcass on its legs)
  const top = s.base.height + s.plinth;
  for (const w of sills) {
    const under = units.filter((u) => u.wall === w.wall && u.layer === "base" && u.kind !== "gap" && u.offset < w.offset + w.width && u.offset + u.width > w.offset);
    if (under.length && w.sill < top)
      out.push({ check: "window sill", mark: under.map((u) => u.mark).join(", "), state: "flag",
        detail: `The window on ${w.wall} at ${w.offset}–${w.offset + w.width} has its sill at ${w.sill}, below the carcass top at ${top} (base ${s.base.height} + plinth ${s.plinth}) before the worktop`, rule: NO_KIT_RULE });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Shop drawings: one front elevation per unit, laid out on the kit's A3 sheets
