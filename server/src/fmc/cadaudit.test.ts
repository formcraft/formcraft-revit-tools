import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { auditCad, type CadRead } from "./cadaudit.js";
import { FMC_CAD_AUDIT_SHAPE, runFmcCadAudit, type FmcCadAuditArgs } from "../tools/fmc_cad_audit.js";

const args = (partial: Record<string, unknown>): FmcCadAuditArgs => z.object(FMC_CAD_AUDIT_SHAPE).parse(partial);
const textOf = (r: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> =>
  ({ ...(JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: r.isError === true });

const READ: CadRead = {
  title: "A",
  imports: [
    { id: "1", name: "survey.dwg", is_linked: false, view_specific: false },
    { id: "2", name: "detail.dwg", is_linked: false, view_specific: true, owner_view: "Detail 1" },
    { id: "3", name: "site.dwg", is_linked: true, view_specific: false, pinned: false, link_status: "Loaded", link_path: "D:\\Jobs\\x\\site.dwg" },
    { id: "4", name: "old.dwg", is_linked: true, view_specific: true, link_status: "NotFound", owner_view: "Level 1" },
  ],
  import_categories: [{ name: "survey.dwg", subcategories: 12, used: true }, { name: "gone.dwg", subcategories: 40, used: false }],
  families: [{ name: "FMC_Sink", category: "Plumbing Fixtures", imports: 2, linked: 0 }, { name: "FMC_Door", imports: 0, linked: 0 }],
  families_scanned: 2,
  images: [
    { id: "9", name: "logo.png", source: "Import", instances: 3 },
    { id: "10", name: "scan.jpg", source: "Link", path: "D:\\x\\scan.jpg", instances: 0, file_found: false },
  ],
};

test("the audit sorts imported, linked, family CAD, line styles and images into a plan", () => {
  const audit = auditCad(READ);
  assert.equal(audit.status, "ACTION");
  assert.equal(audit.counts.imported_3d, 1);
  assert.equal(audit.counts.imported_2d, 1);
  assert.equal(audit.counts.linked_not_loaded, 1);
  assert.equal(audit.counts.families_with_cad, 1);
  assert.equal(audit.counts.unused_import_line_style_categories, 1);
  assert.equal(audit.counts.raster_instances, 3);
  assert.equal(audit.plan[0]?.priority, "high");
  assert.match(audit.plan[0]?.action ?? "", /fmc_wipe/);
  assert.ok(audit.plan.some((s) => /families/.test(s.what) && s.items[0]?.startsWith("FMC_Sink")));
  assert.ok(audit.plan.some((s) => /line styles/.test(s.what) && s.items[0]?.startsWith("gone.dwg")));
  assert.ok(audit.plan.some((s) => /missing/.test(s.what)));
  assert.equal(auditCad({ imports: [], import_categories: [], families: [], images: [] }).status, "CLEAN");
});

test("the tool is read only, needs a document, and deletes nothing", async () => {
  const none = textOf(await runFmcCadAudit(args({})));
  assert.equal(none.code, "FMC-DOC-REQUIRED");
  let sent: Record<string, unknown> = {};
  const r = textOf(await runFmcCadAudit(args({ document: "A", scan_families: false }), { read: async (b) => { sent = b; return READ; } }));
  assert.equal(sent.scan_families, false);
  assert.equal(r.read_only, true);
  assert.equal(r.deleted, 0);
  assert.equal(r.status, "ACTION");
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_cad_audit"));
  assert.ok(!WRITE_COMMANDS.has("fmc_cad_audit"));
});

test("the C# audit opens families without saving and has no transaction", () => {
  const cs = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "commandset", "Services", "Fmc", "FmcCadAudit.cs"), "utf8");
  assert.doesNotMatch(cs, /new Transaction\(/);
  assert.doesNotMatch(cs, /\.Delete\(/);
  assert.match(cs, /Close\(false\)/);
});
