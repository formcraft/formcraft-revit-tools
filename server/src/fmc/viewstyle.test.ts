import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { loadViewStyleSpec, planFilters, planRoomFill, planTemplates, specIsProvisional } from "./viewstyle.js";
import { FMC_VIEWSTYLE_SHAPE, runFmcViewStyle, type FmcViewStyleArgs } from "../tools/fmc_viewstyle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function args(partial: Record<string, unknown>): FmcViewStyleArgs {
  return z.object(FMC_VIEWSTYLE_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

test("the sample spec is provisional and the plans name templates, filters and room fills", () => {
  const loaded = loadViewStyleSpec({ kitRoot: "", env: {} as NodeJS.ProcessEnv });
  assert.equal(loaded.source, "sample");
  assert.equal(loaded.provisional, true);
  assert.equal(specIsProvisional(loaded.spec), true);
  assert.match(fs.readFileSync(path.join(root, "data", "FMC_ViewStyle.json"), "utf8"), /PROVISIONAL/);
  const templates = planTemplates(loaded.spec, []);
  assert.equal(templates.ops[0]?.name, "FMC_A_Plan");
  assert.equal(templates.ops[0]?.provisional, true);
  const taken = planTemplates(loaded.spec, ["FMC_A_Plan"]);
  assert.equal(taken.skipped[0]?.code, "FMC-VIEWSTYLE-NAME-TAKEN");
  const filters = planFilters(loaded.spec, []);
  assert.equal(filters.ops.length, 2);
  assert.deepEqual((filters.ops[0] as { color: number[] }).color, [160, 160, 160]);
  const rooms = planRoomFill(loaded.spec, [{ department: "Ward" }, { department: "Extra" }]);
  assert.equal(rooms.op?.by, "Department");
  assert.equal(rooms.provisional, true);
  assert.ok((rooms.op?.entries as Array<{ value: string }>).some((row) => row.value === "Ward"));
  assert.equal(rooms.op?.legend, true);
});

test("an approved kit spec can pass, and a write needs a lease", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-viewstyle-"));
  const kit = path.join(dir, "kit");
  fs.mkdirSync(path.join(kit, "03_Master_Data"), { recursive: true });
  const spec = {
    status: "approved",
    templates: [{ name: "FMC_A_Plan", from_view: "Level 1", scale: 100, status: "approved" }],
    filters: [],
    room_fill: { by: "Name", legend: false, status: "approved", entries: [{ value: "Bedroom", color: [1, 2, 3], status: "approved" }] },
  };
  fs.writeFileSync(path.join(kit, "03_Master_Data", "FMC_ViewStyle.json"), JSON.stringify(spec));
  const loaded = loadViewStyleSpec({ kitRoot: kit });
  assert.equal(loaded.source, "kit");
  assert.equal(loaded.provisional, false);
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_VIEWSTYLE_DIR: path.join(dir, "out") } as NodeJS.ProcessEnv;
  const read = async () => ({ title: "A", path: "D:\\Jobs\\_Staging\\A.rvt", templates: [], filters: [], rooms: [] });
  const dry = textOf(await runFmcViewStyle(args({ action: "templates", document: "A" }), { read, env, guard, kitRoot: kit }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.can_pass, true);
  assert.equal(dry.status, "PASS");
  const refused = textOf(await runFmcViewStyle(args({ action: "templates", document: "A", dry_run: false }), { read, env, guard, kitRoot: kit }));
  assert.equal(refused.code, "FMC-BATCH-LOCKED");
  let applied = 0;
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const done = textOf(await runFmcViewStyle(args({ action: "room_fill", document: "A", dry_run: false, batch_lease: "lease-1", references: refs }), {
    read, apply: async () => { applied += 1; return { ok: true, code: "FMC-VIEWSTYLE-SCHEME-PARAM" }; }, env, guard, kitRoot: kit,
  }));
  assert.equal(applied, 1);
  assert.equal((done.applied as { code: string }).code, "FMC-VIEWSTYLE-SCHEME-PARAM");
});

test("the view style read is not a write and the apply is", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_viewstyle"));
  assert.ok(WRITE_COMMANDS.has("fmc_viewstyle_apply"));
});
