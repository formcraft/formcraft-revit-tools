import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { legendPoint, loadLegendSpec, planLegend, type LegendSheet } from "./keynotelegend.js";
import { FMC_KEYNOTE_LEGEND_SHAPE, runFmcKeynoteLegend, type FmcKeynoteLegendArgs } from "../tools/fmc_keynote_legend.js";

function args(partial: Record<string, unknown>): FmcKeynoteLegendArgs {
  return z.object(FMC_KEYNOTE_LEGEND_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const sheets: LegendSheet[] = [
  {
    id: "s1", number: "A101", name: "Level 1 Plan", role: "plan", has_legend: false,
    titleblock_mm: { min_x: 0, min_y: 0, max_x: 800, max_y: 560 },
    legend_x_mm: 740, legend_y_mm: 40,
  },
  {
    id: "s2", number: "A201", name: "Level 2 Plan", role: "plan", has_legend: true,
    titleblock_mm: { min_x: 0, min_y: 0, max_x: 800, max_y: 560 },
  },
  {
    id: "s3", number: "A301", name: "Elevation", role: "elevation", has_legend: false,
    titleblock_mm: { min_x: 10, min_y: 10, max_x: 400, max_y: 280 },
  },
];

test("a title-block parameter wins, otherwise the spec inset, and plan sheets are the default", () => {
  const loaded = loadLegendSpec({ kitRoot: "", env: {} as NodeJS.ProcessEnv });
  assert.equal(loaded.source, "sample");
  assert.equal(loaded.provisional, true);
  assert.equal(loaded.spec.name, "FMC Keynotes");
  const fromParam = legendPoint(sheets[0], loaded.spec);
  assert.equal(fromParam.ok, true);
  if (fromParam.ok) {
    assert.equal(fromParam.point.source, "param");
    assert.equal(fromParam.point.x, 740);
  }
  const fromSpec = legendPoint(sheets[2], loaded.spec);
  assert.equal(fromSpec.ok, true);
  if (fromSpec.ok) {
    assert.equal(fromSpec.point.source, "spec");
    assert.equal(fromSpec.point.x, 370);
    assert.equal(fromSpec.point.y, 40);
  }
  const plan = planLegend(sheets, loaded.spec, { role: "plan", filter_by_sheet: true });
  assert.deepEqual(plan.placements.map((row) => row.number), ["A101"]);
  assert.equal(plan.filter_by_sheet, true);
  assert.ok(plan.skipped.some((row) => row.code === "FMC-KEYNOTE-LEGEND-ALREADY"));
  const missing = legendPoint({ id: "x", number: "A900" }, loaded.spec);
  assert.equal(missing.ok, false);
});

test("dry run does not apply, and a write returns legend and viewport ids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-kn-legend-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_KEYNOTE_LEGEND_DIR: path.join(dir, "out") } as NodeJS.ProcessEnv;
  const read = async () => ({ title: "A", path: "D:\\Jobs\\_Staging\\A.rvt", sheets });
  let applied = 0;
  const dry = textOf(await runFmcKeynoteLegend(args({ document: "A", role: "plan" }), { read, apply: async () => { applied += 1; return {}; }, env, guard, kitRoot: "" }));
  assert.equal(dry.dry_run, true);
  assert.equal(applied, 0);
  assert.equal(dry.can_pass, false);
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  assert.match(String(dry.plan_hash), /^[0-9a-f]{16}$/);
  const noHash = textOf(await runFmcKeynoteLegend(args({ document: "A", role: "plan", dry_run: false, batch_lease: "lease-1", references: refs }), { read, apply: async () => { applied += 1; return {}; }, env, guard, kitRoot: "" }));
  assert.equal(noHash.code, "FMC-PLAN-HASH");
  // the sheets changed since the dry run: the rebuilt plan differs, so the dry run's hash is refused
  const fewer = async () => ({ title: "A", path: "D:\\Jobs\\_Staging\\A.rvt", sheets: [] });
  const moved = textOf(await runFmcKeynoteLegend(args({ document: "A", role: "plan", dry_run: false, batch_lease: "lease-1", references: refs, plan_hash: String(dry.plan_hash) }), { read: fewer, apply: async () => { applied += 1; return {}; }, env, guard, kitRoot: "" }));
  assert.equal(moved.code, "FMC-PLAN-HASH");
  assert.equal(applied, 0);
  const done = textOf(await runFmcKeynoteLegend(args({ document: "A", role: "plan", dry_run: false, batch_lease: "lease-1", references: refs, plan_hash: String(dry.plan_hash) }), {
    read,
    apply: async (body) => {
      applied += 1;
      assert.equal(body.filter_by_sheet, true);
      return { ok: true, legend_id: "55", viewports: [{ sheet: "A101", viewport_id: "77" }] };
    },
    env, guard, kitRoot: "",
  }));
  assert.equal(applied, 1);
  assert.equal((done.legend as { id: string }).id, "55");
  assert.equal((done.viewports as Array<{ viewport_id: string }>)[0].viewport_id, "77");
});

test("the legend read is not a write and the apply is", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_keynote_legend"));
  assert.ok(WRITE_COMMANDS.has("fmc_keynote_legend_apply"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  assert.ok(names.has("fmc_keynote_legend") && names.has("fmc_keynote_legend_apply"));
});
