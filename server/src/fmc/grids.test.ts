import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_GROUPS, NEVER } from "./aiuse.js";
import { documentRequired } from "./fairqueue.js";
import { explain } from "./explain.js";
import { gridsScript, planGrids, wireGrids } from "./grids.js";
import { WRITE_COMMANDS } from "./policy.js";
import { FMC_GRIDS_DESCRIPTION, runGridsFromLink } from "../tools/fmc_grids_from_link.js";

test("a quote in a grid name is refused and is not written into the script", () => {
  const bad = planGrids({ document: "Architecture", link: 12, names: ["A\"B"], dry_run: true });
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(" "), /quote/);
  assert.equal(bad.script, undefined);
  const missing = planGrids({ document: " ", link: 12 });
  assert.match(missing.reasons.join(" "), /active document is not used/);
  assert.equal(planGrids({ document: "Architecture", link: 0 }).ok, false);
  assert.equal(documentRequired("fmc_grids_from_link", ["Architecture"], undefined), "fmc_grids_from_link needs document: the host model. Refusing to use the active document.");
});

test("the fixed script copies lines and arcs by the link transform and does not monitor them", () => {
  const dry = planGrids({ document: "Architecture", link: "775979", names: ["A", "1"], dry_run: true });
  assert.equal(dry.ok, true, dry.reasons.join(" | "));
  const code = dry.script ?? "";
  assert.match(code, /long linkId = 775979;/);
  assert.match(code, /bool dry = true;/);
  assert.match(code, /bool filter = true;/);
  assert.match(code, /@"A", @"1"/);
  assert.match(code, /GetTotalTransform/);
  assert.match(code, /Grid\.Create/);
  assert.match(code, /already in the host/);
  assert.match(code, /name exists at a different position/);
  assert.match(code, /monitored = false/);
  assert.doesNotMatch(code, /CopyMonitor/);
  assert.equal(dry.params?.transactionMode, "read_only");
  const real = gridsScript(15, [], false);
  assert.match(real, /bool dry = false;/);
  assert.match(real, /bool filter = false;/);
  assert.equal(wireGrids(realParams(false)).params.transactionMode, "auto");
  assert.equal(wireGrids(realParams(true)).params.transactionMode, "read_only");
  assert.equal(wireGrids(realParams(true)).params.document, "Architecture");
  assert.match(FMC_GRIDS_DESCRIPTION, /not monitored/);
  assert.match(FMC_GRIDS_DESCRIPTION, /Copy\/Monitor/);
  assert.ok(WRITE_COMMANDS.has("fmc_grids_from_link"));
  assert.equal(COMMAND_GROUPS.fmc_grids_from_link, "levels_grids");
  assert.equal(NEVER.fmc_grids_from_link, undefined);
  assert.match(explain("fmc_grids_from_link", { document: "Architecture", link: 12, dry_run: true }).join(" "), /DRY RUN/);
  assert.match(explain("fmc_grids_from_link", { document: "Architecture", link: 12, dry_run: true }).join(" "), /not monitored/);
});

function realParams(dry: boolean): Record<string, unknown> {
  const plan = planGrids({ document: "Architecture", link: 15, dry_run: dry });
  return plan.params ?? {};
}

test("the reply is created and skipped counts plus ids", async () => {
  const sent: Record<string, unknown>[] = [];
  const ran = await runGridsFromLink({ document: "Architecture", link: 15, names: ["A"], dry_run: false }, async (params) => {
    sent.push(params);
    return {
      success: true,
      result: JSON.stringify({
        ok: true, dry_run: false, created: 1, skipped: 1, ids: [88], names: ["A"],
        skipped_names: [{ name: "1", reason: "already in the host" }], monitored: false,
      }),
    };
  });
  assert.equal(ran.isError, false);
  const body = JSON.parse(ran.content[0].text);
  assert.equal(body.created, 1);
  assert.equal(body.skipped, 1);
  assert.deepEqual(body.ids, [88]);
  assert.equal(body.monitored, false);
  assert.equal(body.skipped_names[0].reason, "already in the host");
  assert.equal(sent[0].document, "Architecture");
  assert.match(String(sent[0].code), /Grid\.Create/);
  assert.equal(sent[0].transactionMode, "auto");
});
