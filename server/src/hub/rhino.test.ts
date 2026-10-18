import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PartFacts, RHINO_PART, WARN, familyNameProblem, isError, partProblems, readRhinoState, rhinoCall, rhinoPaths } from "./rhino.js";

/** A stand-in for the bridge in Rhino: one JSON line in, one JSON line out. */
function fakeBridge(answer: (req: { id: number; method: string; params: Record<string, unknown> }) => object): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl));
        sock.write(JSON.stringify({ id: req.id, ...answer(req) }) + "\n");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
  });
}

const part = (over: Partial<PartFacts> = {}): PartFacts => ({
  name: "Castor_Wheel", op: "revolve", subcategory: "FMC_Castors", material: "FMC_Rubber_Black", visibility: "fine",
  closed: true, manifold: true, valid: true, faces: 9, edges: 14, min_edge_mm: 3.1,
  bbox_min: [-16, -62.5, 0], bbox_max: [16, 62.5, 125], volume_mm3: 350000, mesh_faces: 2400, ...over,
});

test("H1: a call to Rhino's bridge sends one line and returns the result, or the bridge's error", async () => {
  const b = await fakeBridge((req) => (req.method === "rhino_part" ? { error: "Too_Round: radius 6 must be under half the smallest side (5)" } : { result: { method: req.method, family: req.params.family } }));
  try {
    assert.deepEqual(await rhinoCall(b.port, "rhino_facts", { family: "FMC_I_X" }), { method: "rhino_facts", family: "FMC_I_X" });
    await assert.rejects(rhinoCall(b.port, "rhino_part", {}), /radius 6 must be under half/);
  } finally { b.close(); }
});

test("H1: the bridge's state file gives its port; a missing or broken one means no bridge", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-rhino-"));
  const f = path.join(dir, "rhino.json");
  assert.equal(readRhinoState(f), null);
  fs.writeFileSync(f, "\uFEFF{\"port\":8191,\"pid\":42,\"started\":\"x\"}");
  assert.equal(readRhinoState(f)?.port, 8191);
  fs.writeFileSync(f, "{\"port\":0}");
  assert.equal(readRhinoState(f), null);
});

test("H1: a good part passes the check", () => {
  assert.deepEqual(partProblems([part()], [1020, 2200, 1000]), []);
});

test("H1: the check stops open, non-manifold, invalid and short-edged parts, and parts without subcategory or material", () => {
  const p = partProblems([part({ name: "A", closed: false }), part({ name: "B", manifold: false }), part({ name: "C", valid: false }),
    part({ name: "D", min_edge_mm: 0.4 }), part({ name: "E", subcategory: "", material: "" }), part({ name: "F", visibility: "coarse" })]);
  assert.equal(p.filter(isError).length, 7);
  assert.match(p[0], /A: not a closed solid/);
  assert.match(p.find((x) => x.startsWith("D:"))!, /0.4 mm is under the 1 mm floor/);
  assert.ok(p.some((x) => /E: no subcategory/.test(x)) && p.some((x) => /E: no material/.test(x)));
  assert.ok(p.some((x) => /F: visibility is fine, medium_fine or all/.test(x)));
});

test("H1: a part larger than the type's envelope is an error; a heavy family is a warning only", () => {
  const big = partProblems([part({ bbox_min: [0, 0, 0], bbox_max: [1100, 50, 50] })], [1020, 2200, 1000]);
  assert.deepEqual(big, ["Castor_Wheel: larger than the type's envelope (X 1100 > 1020 mm)"]);
  const heavy = partProblems([part({ mesh_faces: 200000 })]);
  assert.equal(heavy.length, 1);
  assert.ok(heavy[0].startsWith(WARN) && !isError(heavy[0]));
  assert.deepEqual(partProblems([]), ["No parts: build them with action part first"]);
});

test("H1: parts are checked for shape before they reach Rhino; family names follow the kit", () => {
  assert.equal(RHINO_PART.safeParse({ name: "Grip_Rail", op: "pipe", path: [[0, 0, 0], [0, 0, 80]], radius: 14 }).success, true);
  assert.equal(RHINO_PART.safeParse({ name: "Grip Rail", op: "pipe" }).success, false, "no spaces: the name is a layer and a Revit form");
  assert.equal(RHINO_PART.safeParse({ name: "X", op: "script" }).success, false, "named operations only");
  assert.equal(familyNameProblem("FMC_I_MedEq_Bed_ICU_Electric_Detailed"), null);
  assert.match(familyNameProblem("bed")!, /isn't a kit family name/);
  assert.equal(familyNameProblem("FMC_FP_MechEq_FirePump_Set"), null, "two-letter roles (FP) are kit roles too");
});

test("H1: Rhino files live in <staging>\\_Rhino, one folder of parts per family", () => {
  const w = rhinoPaths("D:\\Kit\\04_Families\\_Staging", "FMC_I_Bed");
  assert.equal(w.model, "D:\\Kit\\04_Families\\_Staging\\_Rhino\\FMC_I_Bed.3dm");
  assert.equal(w.manifest, "D:\\Kit\\04_Families\\_Staging\\_Rhino\\FMC_I_Bed\\parts.json");
  assert.equal(w.render, "D:\\Kit\\04_Families\\_Staging\\_Rhino\\FMC_I_Bed_3d.png");
  assert.equal(rhinoPaths("D:\\S", "FMC_I_Bed", "front").render, "D:\\S\\_Rhino\\FMC_I_Bed_3d_front.png");
});
