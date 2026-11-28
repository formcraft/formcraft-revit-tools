import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FIX, call, done, fakeRevit, kit } from "./casework_testkit.js";

/** pack and shop_drawings apply only with confirm=true; the dry run needs none; a refusal writes and sends nothing. */

const PACK = { action: "pack", run: FIX.run, label: "K-01 Kitchen", project_code: "F26901" };
const SHOP = { action: "shop_drawings", run: FIX.run, label: "K-01 Kitchen", project_code: "F26901", sheets: ["I-4001"] };

test("pack: dry run needs no confirm; dry_run=false without confirm is refused and writes nothing; with confirm it writes", async () => {
  const k = kit();
  try {
    const dry = await call(k, { ...PACK, project_folder: k.project });
    assert.equal(dry.body.dry_run, true);
    assert.match(dry.body.next, /confirm=true/);
    const refused = await call(k, { ...PACK, project_folder: k.project, dry_run: false });
    assert.equal(refused.isError, true);
    assert.ok(refused.body.reasons.some((r: string) => /confirm=true/.test(r)));
    assert.equal(fs.existsSync(k.folder), false, "nothing written");
    const no = await call(k, { ...PACK, project_folder: k.project, dry_run: false, confirm: false });
    assert.equal(no.isError, true);
    const yes = await call(k, { ...PACK, project_folder: k.project, dry_run: false, confirm: true });
    assert.equal(yes.body.done, true);
    assert.equal(fs.readdirSync(k.folder).length, 5);
  } finally { done(k); }
});

test("pack through run_id still needs its own confirm (a saved run carries no yes)", async () => {
  const k = kit();
  try {
    const first = await call(k, { ...PACK, project_folder: k.project, dry_run: false, confirm: true });
    const again = await call(k, { action: "pack", run_id: first.body.run_id, label: "K-01 Kitchen", project_code: "F26901", project_folder: k.project, dry_run: false });
    assert.equal(again.isError, true);
    assert.ok(again.body.reasons.some((r: string) => /confirm=true/.test(r)));
  } finally { done(k); }
});

test("shop_drawings: dry_run=false without confirm is refused before Revit is called; with confirm it goes", async () => {
  const k = kit();
  try {
    const rv = fakeRevit({ fmc_casework_pack: (p: any) => {
      if (p.export) fs.writeFileSync(`${p.export.folder}/${p.export.file}.pdf`, "PDF");
      return { exported: p.export ? { result: "exported" } : null };
    } });
    const dry = await call(k, { ...SHOP, project_folder: k.project }, rv.send);
    assert.equal(dry.body.dry_run, true);
    assert.equal(rv.calls.length, 1);
    assert.equal(rv.calls[0].dry, true);
    const refused = await call(k, { ...SHOP, project_folder: k.project, dry_run: false }, rv.send);
    assert.equal(refused.isError, true);
    assert.ok(refused.body.reasons.some((r: string) => /confirm=true/.test(r)));
    assert.equal(rv.calls.length, 1, "Revit wasn't called");
    assert.equal(fs.existsSync(k.folder), false);
    const yes = await call(k, { ...SHOP, project_folder: k.project, dry_run: false, confirm: true }, rv.send);
    assert.equal(yes.isError, false, JSON.stringify(yes.body));
    assert.equal(rv.calls.length, 2);
    assert.equal(rv.calls[1].dry, false);
  } finally { done(k); }
});

test("confirm alone does nothing: dry_run stays true unless set", async () => {
  const k = kit();
  try {
    const r = await call(k, { ...PACK, project_folder: k.project, confirm: true });
    assert.equal(r.body.dry_run, true);
    assert.equal(fs.existsSync(k.folder), false);
  } finally { done(k); }
});
