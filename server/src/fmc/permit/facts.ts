/**
 * Model facts for fmc_permit_check, from installed read-only add-in commands (Phase A, no add-in change):
 * fmc_struct_facts (levels, floors, roofs, rooms, stairs), fmc_sheets_layout (sheets and their placed views;
 * action "pack" for every viewport's scale) and fmc_model_check (rooms not placed or not enclosed).
 */
export interface LevelFact { name: string; elevation_mm: number }
export interface RoomFact { id: string; number: string; name: string; level: string; area_m2: number; department: string; occupancy: string; at_mm: number[] | null }
export interface FloorFact { id: string; level: string; area_m2: number }
export interface RoofFact { id: string; level: string; top_mm: number | null }
export interface StairFact { id: string; type: string; bottom_mm: number | null; top_mm: number | null }
export interface SheetFact { id: string; number: string; name: string; views: string[] }
export interface ViewportFact { id: string; name: string; sheet: string; scale: number | null }
export interface RoomProblem { sentence: string; ids: string[] }

export interface PermitFacts {
  document: { title: string; path: string };
  levels: LevelFact[]; rooms: RoomFact[]; floors: FloorFact[]; roofs: RoofFact[]; stairs: StairFact[];
  sheets: SheetFact[] | null; viewports: ViewportFact[] | null; room_problems: RoomProblem[] | null;
  notes: string[];
}

type Obj = Record<string, unknown>;
const arr = (x: unknown): Obj[] => (Array.isArray(x) ? x.filter((v) => v && typeof v === "object") as Obj[] : []);
const str = (x: unknown): string => (x === null || x === undefined ? "" : String(x));
const n = (x: unknown): number | null => { const v = typeof x === "number" ? x : Number(x); return x !== null && x !== undefined && x !== "" && Number.isFinite(v) ? v : null; };
const point = (x: unknown): number[] | null => (Array.isArray(x) && x.length >= 3 && x.every((v) => typeof v === "number") ? (x as number[]) : null);

export function structFacts(raw: unknown): Pick<PermitFacts, "levels" | "rooms" | "floors" | "roofs" | "stairs"> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Obj;
  return {
    levels: arr(r.levels).map((l) => ({ name: str(l.name), elevation_mm: n(l.elevation_mm) ?? 0 })),
    rooms: arr(r.rooms).map((x) => ({
      id: str(x.id), number: str(x.number), name: str(x.name), level: str(x.level), area_m2: n(x.area_m2) ?? 0,
      department: str(x.department), occupancy: str(x.occupancy), at_mm: point(x.at_mm),
    })),
    floors: arr(r.floors).map((f) => ({ id: str(f.id), level: str(f.level), area_m2: n(f.area_m2) ?? 0 })),
    roofs: arr(r.roofs).map((f) => ({ id: str(f.id), level: str(f.level), top_mm: point(f.plan_max_mm)?.[2] ?? null })),
    stairs: arr(r.stairs).map((s) => {
      const box = Array.isArray(s.box_mm) ? s.box_mm : [];
      return { id: str(s.id), type: str(s.type), bottom_mm: point(box[0])?.[2] ?? null, top_mm: point(box[1])?.[2] ?? null };
    }),
  };
}

/** fmc_sheets_layout read with action "park" and an empty list: every sheet with its placed views. */
export function sheetFacts(raw: unknown): SheetFact[] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Obj;
  return arr(r.sheets).map((s) => ({ id: str(s.id), number: str(s.number), name: str(s.name), views: arr(s.placed).map((v) => str(v.name)) }));
}

/** fmc_sheets_layout read with action "pack": views (on that sheet) and others (on every other sheet), each with its scale. */
export function viewportFacts(raw: unknown): ViewportFact[] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Obj;
  return [...arr(r.views), ...arr(r.others)].map((v) => ({ id: str(v.id), name: str(v.name), sheet: str(v.sheet), scale: n(v.scale) }));
}

/** fmc_model_check with checks ["rooms"]: { rooms: { count, items: [{ sentence, ids }] } }. */
export function roomProblems(raw: unknown): RoomProblem[] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Obj;
  const rooms = (r.rooms && typeof r.rooms === "object" ? r.rooms : {}) as Obj;
  return arr(rooms.items).map((i) => ({ sentence: str(i.sentence), ids: Array.isArray(i.ids) ? i.ids.map(str) : [] }));
}
