import { test } from "node:test";
import assert from "node:assert/strict";
import { planRoom, resolveRoomFamilies, roomFamilies } from "./room.js";
import { familyPlanLines, roomFamilyFiles } from "../tools/fmc_room.js";
import { DEFAULT_CONFIG } from "../fmc/policy.js";

const STAGING = "D:\\Kit\\04_Families\\_Staging";
const DOOR = "FMC_A_Door_FlushSingle_Hygienic_Detailed", BED = "FMC_I_MedEq_Bed_ICU_Electric_Detailed", LIGHT = "FMC_E_LightFixture_OperatingLight_Ceiling_Detailed";

const icu = () => planRoom({
  name: "ICU bay", level: "L1", origin_mm: [0, 0], width: 4200, depth: 5000, height: 3300,
  walls: { type: "Generic - 200mm", thickness: 200 }, ceiling: { type: "Generic", height: 2900 },
  openings: [{ kind: "door", family: DOOR, type: "1026x2100_S", wall: "south", along: 900, width: 1026 },
    { kind: "door", family: DOOR, type: "1026x2100_S", wall: "north", along: 900, width: 1026 }],
  items: [{ id: "Bed", family: BED, type: "1020x2200_Standard", at: { wall: "north", off: 150 }, size: [1020, 2200], clearance: 1200 },
    { id: "Light", family: LIGHT, type: "700_Single", at: { centre: true, dy: 600 }, host: "ceiling" }],
} as any);

test("F-073: the families a room places, each once, in plan order", () => {
  assert.deepEqual(roomFamilies(icu().ops), [DOOR, BED, LIGHT]);
});

test("F-073: a family resolves to <staging>\\<Role>\\<family>.rfa, then 04_Families, then the library roots", () => {
  const files = new Set([`${STAGING}\\A\\${DOOR}.rfa`, `D:\\Kit\\04_Families\\I\\${BED}.rfa`, `D:\\Lib\\${LIGHT}.rfa`, `D:\\Kit\\04_Families\\A\\${DOOR}.rfa`]);
  const r = resolveRoomFamilies([DOOR, BED, LIGHT], [STAGING, "D:\\Kit\\04_Families", "D:\\Lib"], (f) => files.has(f));
  assert.deepEqual(r.files, [
    { family: DOOR, path: `${STAGING}\\A\\${DOOR}.rfa`, found: true },
    { family: BED, path: `D:\\Kit\\04_Families\\I\\${BED}.rfa`, found: true },
    { family: LIGHT, path: `D:\\Lib\\${LIGHT}.rfa`, found: true },
  ]);
  assert.deepEqual(r.searched, [], "nothing missing, nothing to report");
});

test("F-073: a family not found names every folder searched; a blocked folder (02_Shared, 03_Published) is never read", () => {
  const shared = "Z:\\Projects\\P1\\02_Shared\\Families";
  const r = resolveRoomFamilies([DOOR], [STAGING, shared], (f) => f.startsWith(shared), ["02_Shared", "03_Published"]);
  assert.deepEqual(r.files, [{ family: DOOR, path: "", found: false }], "the copy in 02_Shared is not loaded");
  assert.deepEqual(r.searched, [`${STAGING}\\A`, STAGING]);
});

test("F-073: the dry run's lines: would load <family> from <path>, and a clear not-found naming the folders", () => {
  const cfg = { ...DEFAULT_CONFIG, family_staging_root: STAGING, library_roots: ["D:\\Kit\\04_Families\\_ChainTests"] };
  const r = roomFamilyFiles(icu().ops, cfg, (f) => f === `${STAGING}\\A\\${DOOR}.rfa` || f === `${STAGING}\\I\\${BED}.rfa`);
  const lines = familyPlanLines(r);
  assert.deepEqual(lines.would_load, [`would load: ${DOOR} from ${STAGING}\\A\\${DOOR}.rfa`, `would load: ${BED} from ${STAGING}\\I\\${BED}.rfa`]);
  assert.equal(lines.not_found.length, 1);
  assert.match(lines.not_found[0], new RegExp(`^${LIGHT}: no ${LIGHT}\\.rfa in `));
  for (const d of [`${STAGING}\\E`, STAGING, "D:\\Kit\\04_Families\\E", "D:\\Kit\\04_Families\\_ChainTests"])
    assert.ok(lines.not_found[0].includes(d), `names ${d}`);
});

test("F-073: with no roots configured, the not-found line says so", () => {
  const lines = familyPlanLines(roomFamilyFiles(icu().ops, { ...DEFAULT_CONFIG, family_staging_root: "", library_roots: [] }, () => false));
  assert.equal(lines.would_load.length, 0);
  assert.match(lines.not_found[0], /sets no family_staging_root or library_roots/);
});
