import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { bboxClearMm, citeHeadroom, headroomHits, type HeadroomObstacle, type HeadroomZone } from "./headroom.js";
import { FMC_HEADROOM_SHAPE, runFmcHeadroom, type FmcHeadroomArgs } from "../tools/fmc_headroom.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcHeadroomArgs {
  return z.object(FMC_HEADROOM_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

const corridor: HeadroomZone = {
  id: "10", kind: "corridor", name: "Corridor 01", level: "Level 1", source: "host", floor_z_mm: 0,
  min: [0, 0, 0], max: [4000, 1800, 3000],
};
const stair: HeadroomZone = {
  id: "11", kind: "stair", name: "Stair 1", level: "Level 1", source: "host", floor_z_mm: 0,
  min: [5000, 0, 0], max: [8000, 2000, 3000],
};
const duct: HeadroomObstacle = { id: "20", kind: "duct", source: "host", min: [100, 100, 2000], max: [2000, 800, 2300] };
const beam: HeadroomObstacle = { id: "21", kind: "beam", source: "link", link: "S", min: [5200, 100, 2400], max: [7000, 500, 2800] };
const riser: HeadroomObstacle = { id: "22", kind: "pipe", source: "host", min: [100, 100, -500], max: [300, 300, 4000] };

test("2100 mm is provisional when the bank has no key, and a low duct is a hit", () => {
  const cited = citeHeadroom(null);
  assert.equal(cited.value, 2100);
  assert.equal(cited.source, "provisional");
  assert.equal(cited.can_pass, false);
  const hits = headroomHits([corridor, stair], [duct, beam, riser], cited.value, ["host", "link"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].obstacle_id, "20");
  assert.equal(hits[0].clear_mm, 2000);
  assert.equal(hits[0].zone_id, "10");
  assert.equal(hits[0].method, "bbox");
  assert.equal(bboxClearMm(corridor, riser), null);
  const clear = headroomHits([corridor], [duct], 2100, ["host"]);
  assert.equal(clear.length, 1);
  const ok = headroomHits([corridor], [{ ...duct, min: [100, 100, 2400], max: [2000, 800, 2700] }], 2100, ["host"]);
  assert.equal(ok.length, 0);
});

test("a standards clause can pass, a ray wins over the box, and links can be left out", () => {
  const cited = citeHeadroom({
    standards: { "headroom.min_clear_mm": { value: 2400, status: "approved", clause: "FMC-BIM-STD-002 4.2", unit: "mm" } },
  });
  assert.equal(cited.value, 2400);
  assert.equal(cited.can_pass, true);
  assert.equal(cited.source, "standards");
  const called = citeHeadroom({
    "headroom.min_clear_mm": { value: 2100, status: "provisional", clause: "not yet" },
  }, 2000);
  assert.equal(called.value, 2000);
  assert.equal(called.source, "provisional");
  assert.equal(called.can_pass, false);

  const rayZone: HeadroomZone = {
    ...corridor,
    samples: [{ x: 500, y: 400, z: 0, clear_mm: 1800, obstacle_id: "20", obstacle_kind: "duct" }],
  };
  const hits = headroomHits([rayZone], [duct], 2100, ["host"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, "ray");
  assert.equal(hits[0].clear_mm, 1800);
  const hostOnly = headroomHits([stair], [beam], 2100, ["host"]);
  assert.equal(hostOnly.length, 0);
  const withLink = headroomHits([stair], [beam], 2500, ["host", "link"]);
  assert.equal(withLink.length, 1);
  assert.equal(withLink[0].obstacle_source, "link");
});

test("the tool is read-only, names the document, and the add-in starts no transaction", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-headroom-"));
  const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, FMC_HEADROOM_DIR: path.join(dir, "headroom"), FMC_STANDARDS_FILE: path.join(dir, "missing.json") } as NodeJS.ProcessEnv;
  const missing = textOf(await runFmcHeadroom(args({}), { env, standards: null }));
  assert.equal(missing.code, "FMC-DOC-REQUIRED");

  const body = textOf(await runFmcHeadroom(args({
    document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    levels: ["Level 1"],
    sources: ["host", "link"],
  }), {
    env,
    standards: null,
    read: async () => ({
      resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: "D:\\Jobs\\_Staging\\A.rvt" },
      method: "bbox",
      view3d: "",
      notes: ["No 3D view is in the model. ReferenceIntersector needs one, and none was created. Clearance is from bounding boxes."],
      zones: [corridor, { ...stair, level: "Level 2" }],
      obstacles: [duct, beam],
    }),
  }));
  assert.equal(body.isError, false);
  assert.equal(body.read_only, true);
  assert.equal(body.transaction, false);
  assert.equal(body.status, "PROVISIONAL");
  assert.equal((body.min_clear as { value: number }).value, 2100);
  assert.equal(body.hit_count, 1);
  assert.equal(body.zones, 1);
  const source = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcHeadroom.cs"), "utf8");
  assert.equal(source.includes("new Transaction"), false);
  assert.equal(source.includes("TransactionGroup"), false);
  assert.equal(source.includes("RollBack"), false);
  assert.match(source, /ReferenceIntersector/);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_headroom"));
  assert.equal(WRITE_COMMANDS.has("fmc_headroom"), false);
});
