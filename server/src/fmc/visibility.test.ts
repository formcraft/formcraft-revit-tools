import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_ORDER, deriveVisible, explain, normalizeIds, normalizeOptionalId, normalizeReply } from "./visibility.js";
import { runFmcVisibility, FMC_VISIBILITY_SHAPE, type FmcVisibilityArgs } from "../tools/fmc_visibility.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const reason = (check: string, status: string, text = check, fix = "fix " + check) => ({ check, status, reason: text, evidence: {}, fix });
const el = (id: string, visible: string, reasons: unknown[], extra: Record<string, unknown> = {}) => ({ id, found: true, name: "Basic Wall", category: "Walls", visible, reasons, passed: [], not_applicable: [], ...extra });
const view = { id: "10", name: "Level 1", view_type: "FloorPlan" };

function args(over: Partial<FmcVisibilityArgs> = {}): FmcVisibilityArgs {
  return { element_ids: ["101"], document: "", ...over } as FmcVisibilityArgs;
}

test("element ids: positive whole numbers, de-duplicated, at most 50", () => {
  assert.deepEqual(normalizeIds(["101", 102, "0101", "101"]).ids, ["101", "102"]);
  assert.match(normalizeIds([]).problem!, /required/);
  assert.match(normalizeIds(["12a"]).problem!, /not an element id/);
  assert.match(normalizeIds(["0"]).problem!, /not an element id/);
  assert.match(normalizeIds(["-5"]).problem!, /not an element id/);
  assert.match(normalizeIds(Array.from({ length: 51 }, (_, i) => String(i + 1))).problem!, /At most 50/);
  assert.equal(normalizeOptionalId(undefined, "view_id").id, "");
  assert.equal(normalizeOptionalId(" 77 ", "view_id").id, "77");
  assert.match(normalizeOptionalId("x", "view_id").problem!, /view_id/);
  assert.equal(FMC_VISIBILITY_SHAPE.element_ids.safeParse([]).success, false);
});

test("visible is derived from the reasons: hides beats everything, unknown or likely means unknown", () => {
  assert.equal(deriveVisible([]), "yes");
  assert.equal(deriveVisible([{ status: "info" }]), "yes");
  assert.equal(deriveVisible([{ status: "info" }, { status: "likely" }]), "unknown");
  assert.equal(deriveVisible([{ status: "unknown" }]), "unknown");
  assert.equal(deriveVisible([{ status: "unknown" }, { status: "hides" }]), "no");
});

test("a reply is checked: reasons sorted into the documented order and numbered, visible recomputed, nothing dropped", () => {
  const r = normalizeReply({
    view,
    elements: [
      el("101", "yes", [reason("phase", "hides"), reason("category", "hides"), reason("filter", "unknown"), reason("element_hidden", "hides")]),
    ],
  }, ["101", "102"]);
  assert.ok(r.ok);
  const rows = (r as any).reply.elements;
  assert.equal(rows.length, 2, "an asked id Revit did not answer still gets a row");
  assert.deepEqual(rows[0].reasons.map((x: any) => x.check), ["element_hidden", "category", "filter", "phase"]);
  assert.deepEqual(rows[0].reasons.map((x: any) => x.order), [1, 2, 3, 4]);
  assert.equal(rows[0].visible, "no");
  assert.match(rows[0].notes[0], /said visible="yes"/);
  assert.equal(rows[1].visible, "unknown");
  assert.equal(rows[1].reasons[0].status, "unknown");
  assert.deepEqual((r as any).reply.summary, { yes: 0, no: 1, unknown: 1 });
  assert.equal((r as any).reply.model_changed, false);
  assert.equal((r as any).reply.fixes_applied, false);
});

test("the explanation lists every reason with its status and fix, and marks fixes as not applied", () => {
  const r = normalizeReply({ view, elements: [el("101", "no", [reason("workset", "hides", "workset W is hidden", "make W visible"), reason("view_template", "info", "template T")])] }, ["101"]);
  const text = (r as any).reply.elements[0].explanation as string;
  assert.match(text, /NOT visible in "Level 1"/);
  assert.match(text, /2\. \[HIDES\] workset: workset W is hidden Fix \(not applied\): make W visible/);
  assert.match(text, /1\. \[note\] view_template: template T/);
  assert.doesNotMatch(text.split("\n")[1], /Fix/);
  assert.match(explain({ id: "5", found: true, name: "", category: "", visible: "yes", reasons: [], passed: [], not_applicable: [], unknown_checks: [], suggested_fixes: [] }, "V"), /is visible in "V"/);
});

test("a status the add-in does not know is treated as unknown, never as fine", () => {
  const r = normalizeReply({ view, elements: [el("101", "yes", [reason("category", "fine")])] }, ["101"]);
  const row = (r as any).reply.elements[0];
  assert.equal(row.visible, "unknown");
  assert.equal(row.reasons[0].status, "unknown");
});

test("an empty or malformed reply is an error, not 'visible'", () => {
  assert.equal(normalizeReply(undefined, ["1"]).ok, false);
  assert.equal(normalizeReply({ view }, ["1"]).ok, false);
});

test("the tool refuses bad input before asking Revit, and passes view, link and document through", async () => {
  let sent = 0;
  const send = async () => { sent += 1; return {}; };
  const bad = await runFmcVisibility(args({ element_ids: ["x"] }), { send });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /FMC-VIS-IDS/);
  const badView = await runFmcVisibility(args({ view_id: "abc" }), { send });
  assert.match(badView.content[0].text, /FMC-VIS-VIEW/);
  const badLink = await runFmcVisibility(args({ link_instance_id: "-1" }), { send });
  assert.match(badLink.content[0].text, /FMC-VIS-LINK/);
  assert.equal(sent, 0);

  let body: Record<string, unknown> = {};
  const ok = await runFmcVisibility(args({ element_ids: [101, "102"], view_id: 10, link_instance_id: "55", document: " M1 " }), {
    send: async (b) => { body = b; return { view, document: "M1", link_instance: { id: "55" }, elements: [el("101", "yes", []), el("102", "no", [reason("crop_region", "hides")])] }; },
  });
  assert.deepEqual(body, { element_ids: ["101", "102"], view_id: "10", link_instance_id: "55", document: "M1" });
  const out = JSON.parse(ok.content[0].text);
  assert.equal(ok.isError, false);
  assert.deepEqual(out.summary, { yes: 1, no: 1, unknown: 0 });
  assert.equal(out.elements[1].visible, "no");
});

test("a Revit error or a bad reply comes back as a refusal with its code", async () => {
  const thrown = await runFmcVisibility(args(), { send: async () => { throw new Error("fmc_visibility: [FMC-VIS-VIEW] \"Sheet\" is a DrawingSheet"); } });
  assert.equal(thrown.isError, true);
  assert.match(thrown.content[0].text, /FMC-VIS-VIEW/);
  const empty = await runFmcVisibility(args(), { send: async () => ({}) });
  assert.match(empty.content[0].text, /FMC-VIS-BAD-REPLY/);
});

test("registry: command.json, the policy read list and the docs know fmc_visibility; it is not a write", () => {
  const cmds = JSON.parse(read("command.json"));
  const list = (cmds.commands ?? cmds) as Array<{ commandName: string; assemblyPath: string }>;
  const entry = list.find((c) => c.commandName === "fmc_visibility");
  assert.ok(entry, "command.json has no fmc_visibility");
  assert.equal(entry!.assemblyPath, "RevitMCPCommandSet.dll");
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_visibility"));
  assert.ok(!WRITE_COMMANDS.has("fmc_visibility"));
  const doc = read("docs/tools/fmc_visibility.md");
  for (const c of CHECK_ORDER) assert.ok(doc.includes("`" + c + "`"), `docs do not mention ${c}`);
});

test("the Revit side (source): no transaction, nothing hidden or set, no writes; every check is reported", () => {
  const src = ["commandset/Services/Fmc/FmcVisibility.cs", "commandset/Services/Fmc/FmcVisibilityHandler.cs", "commandset/Commands/Fmc/FmcVisibilityCommand.cs"].map(read).join("\n");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/\/|\/\/)/.test(l)).join("\n");
  assert.doesNotMatch(code, /new\s+(Transaction|TransactionGroup|SubTransaction)\b|\.Start\(\)|\.Commit\(\)/);
  assert.doesNotMatch(code, /\b(SetHidden|HideElements|UnhideElements|HideCategoryTemporary|IsolateElementsTemporary|EnableTemporaryViewPropertiesMode|DisableTemporaryViewMode|SetCategoryHidden|SetFilterVisibility|SetFilterOverrides|SetElementOverrides|SetWorksetVisibility|SetLinkOverrides|SetViewRange|SetUnderlayBaseLevel|SetUnderlayRange)\b|\.CropBoxActive\s*=[^=]|CropBoxVisible\s*=|IsSectionBoxActive\s*=[^=]|\.DetailLevel\s*=[^=]|DisplayStyle\s*=|\.Phase\s*=|\.Regenerate\(|\.Delete\(|DeleteElements|\.SetParameter\(|\.Set\(\s*[^)]|SaveAs|Synchronize|File\.|StreamWriter|HttpClient|WebClient/);
  assert.doesNotMatch(code, /\.Pinned\s*=|\.Name\s*=[^=]|ViewTemplateId\s*=[^=]/);
  // the real checks are there
  for (const call of ["IsHidden(", "CanBeHidden(", "IsInTemporaryViewMode(", "GetCategoryHidden(", "GetFilterVisibility(", "GetFilterOverrides(", "GetWorksetVisibility(", "GetPhaseStatus(", "GetPhaseStatusPresentation(", "GetLinkOverrides(", "GetViewRange(", "GetSectionBox(", "GetNonControlledTemplateParameterIds(", "OwnerViewId", "FilteredElementCollector(c.Host, c.View.Id)"])
    assert.ok(code.includes(call), `the add-in never calls ${call}`);
  // every check named in the order is run by a Step
  for (const check of CHECK_ORDER) {
    if (check === "temporary_hide" || check === "element_hidden" || check === "revit_verdict" || true) assert.ok(code.includes(`Step(c, "${check}"`), `no Step for ${check}`);
  }
  // a check that throws is reported as unknown, and the visible rule matches the server's
  assert.match(code, /catch \(Exception e\) \{ Unknown\(c, check, "The check failed/);
  assert.match(code, /if \(s\.Contains\("hides"\)\) return "no";\s*if \(s\.Contains\("unknown"\) \|\| s\.Contains\("likely"\)\) return "unknown";\s*return "yes";/);
  // the order list in C# is the server's order
  const order = [...code.slice(code.indexOf("Order =")).split("};")[0].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, [...CHECK_ORDER]);
  // the handler needs ids, resolves a view, and refuses templates and schedules
  assert.match(code, /FMC-VIS-IDS/);
  assert.match(code, /FMC-VIS-VIEW/);
  assert.match(code, /view\.IsTemplate/);
  assert.match(code, /mayOpen:\s*false/);
  assert.match(code, /CommandName => "fmc_visibility"/);
});
