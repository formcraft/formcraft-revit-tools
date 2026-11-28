import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { FMC_FAMILY_PARAMS_SHAPE, runFmcFamilyParams, type FmcFamilyParamsArgs } from "../tools/fmc_family_params.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcFamilyParamsArgs {
  return z.object(FMC_FAMILY_PARAMS_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-params-"));
  const kit = path.join(dir, "FMC_SharedParameters.txt");
  fs.writeFileSync(kit, [
    "*META\tVERSION\tMINVERSION",
    "META\t2\t1",
    "*GROUP\tID\tNAME",
    "GROUP\t1\tIdentity Data",
    "*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE",
    "PARAM\taaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\tStatus\tTEXT\t\t1\t1\tSheet status\t1",
    "PARAM\tbbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee\tClear Height\tLENGTH\t\t1\t1\t\t1",
  ].join("\n"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-params-state-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG, protected_paths: ["D:\\Live"], save_exclude: ["HEBERT HOSTELS"], sync_exclude: [] };
  const env = { ...process.env, APPDATA: state, LOCALAPPDATA: state, FMC_FAMILY_PARAMS_DIR: path.join(state, "familyparams") } as NodeJS.ProcessEnv;
  return { kit, env, guard, reportDir: path.join(state, "familyparams") };
}

const project = {
  title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  path: "D:\\Jobs\\_Staging\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt",
  is_central: false,
  family: "FMC_A_Titleblock_A1",
  family_path: "Z:\\00_Standards\\04_Families\\A\\FMC_A_Titleblock_A1.rfa",
  parameters: [{ name: "Sheet Number", shared: true, instance: true, has_label: true }],
  resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: "D:\\Jobs\\_Staging\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt" },
};

const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["Do not save the kit family"] };

test("a shared parameter comes from the kit file, and a missing name is a kit change", async () => {
  const io = setup();
  const dry = textOf(await runFmcFamilyParams(args({
    action: "add", document: project.title, family: "FMC_A_Titleblock_A1", name: "Status", type: "text", group: "identity", shared: true, binding: "instance",
  }), { ...io, kitFile: io.kit, read: async () => project }));
  assert.equal(dry.isError, false);
  assert.equal(dry.dry_run, true);
  const plan = dry.plan as { guid: string; shared: boolean; binding: string };
  assert.equal(plan.guid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(plan.shared, true);
  assert.equal(plan.binding, "instance");

  const missing = textOf(await runFmcFamilyParams(args({
    action: "add", document: project.title, family: "FMC_A_Titleblock_A1", name: "Drawn By", type: "text",
  }), { ...io, kitFile: io.kit, read: async () => project }));
  assert.equal(missing.code, "FMC-PARAM-NOT-IN-KIT");
  assert.match(String(missing.message), /Kit change/);
  assert.equal(missing.plan, undefined);

  const mismatch = textOf(await runFmcFamilyParams(args({
    action: "add", document: project.title, family: "FMC_A_Titleblock_A1", name: "Clear Height", type: "text",
  }), { ...io, kitFile: io.kit, read: async () => project }));
  assert.equal(mismatch.code, "FMC-PARAM-TYPE");
});

test("label binds an existing parameter, bind names categories, and apply needs a lease", async () => {
  const io = setup();
  const noParam = textOf(await runFmcFamilyParams(args({
    action: "label", document: project.title, family: "FMC_A_Titleblock_A1", name: "Status",
  }), { ...io, kitFile: io.kit, read: async () => project }));
  assert.equal(noParam.code, "FMC-PARAM-MISSING");

  const withStatus = {
    ...project,
    parameters: [...project.parameters, { name: "Status", shared: true, instance: true, has_label: false }],
  };
  const label = textOf(await runFmcFamilyParams(args({
    action: "label", document: project.title, family: "FMC_A_Titleblock_A1", name: "Status", dry_run: true,
  }), { ...io, kitFile: io.kit, read: async () => withStatus }));
  // Revit 2025 has no label API: the dry run says so instead of planning a write that can only fail.
  assert.equal(label.isError, true);
  assert.equal(label.code, "FMC-NO-API-LABEL");
  assert.equal((label.plan as { action: string }).action, "label");

  const bind = textOf(await runFmcFamilyParams(args({
    action: "bind", document: project.title, name: "Status", categories: ["OST_Sheets"], binding: "instance",
  }), { ...io, kitFile: io.kit, read: async () => project }));
  assert.equal(bind.isError, false);
  assert.deepEqual((bind.plan as { categories: string[] }).categories, ["OST_Sheets"]);

  const locked = textOf(await runFmcFamilyParams(args({
    action: "add", document: project.title, family: "FMC_A_Titleblock_A1", name: "Status", type: "text", dry_run: false,
  }), { ...io, kitFile: io.kit, read: async () => project }));
  assert.equal(locked.code, "FMC-BATCH-LOCKED");

  const sent: { body: Record<string, unknown> | null } = { body: null };
  const applied = textOf(await runFmcFamilyParams(args({
    action: "add", document: project.title, family: "FMC_A_Titleblock_A1", name: "Status", type: "text",
    dry_run: false, batch_lease: "lease-1", references: refs,
  }), {
    ...io,
    kitFile: io.kit,
    read: async () => project,
    apply: async (body) => { sent.body = body; return { ok: true, kit_saved: false }; },
  }));
  assert.equal(applied.dry_run, false);
  assert.equal(applied.kit_saved, false);
  assert.equal(sent.body?.guid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(sent.body?.shared_parameter_file, io.kit);

  const kitDoc = textOf(await runFmcFamilyParams(args({
    action: "add", document: "FMC_A_Titleblock_A1", family: "FMC_A_Titleblock_A1", name: "Status", type: "text",
  }), {
    ...io,
    kitFile: io.kit,
    read: async () => ({
      ...project,
      path: "Z:\\00_Standards\\04_Families\\A\\FMC_A_Titleblock_A1.rfa",
      resolved_document: { title: "FMC_A_Titleblock_A1", path: "Z:\\00_Standards\\04_Families\\A\\FMC_A_Titleblock_A1.rfa" },
    }),
  }));
  assert.equal(kitDoc.code, "FMC-PARAM-GUARD");

  const apply = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcFamilyParamsApply.cs"), "utf8");
  assert.equal(apply.includes(".Save("), false);
  assert.equal(apply.includes("SaveAs"), false);
  assert.match(apply, /Close\(false\)/);
  assert.match(apply, /FMC-NO-API-LABEL/);
  assert.ok(WRITE_COMMANDS.has("fmc_family_params_apply"));
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_family_params"));
  assert.equal(WRITE_COMMANDS.has("fmc_family_params"), false);
});

test("research tool 41: the guard's never_write_titles adds protected names; HEBERT HOSTELS stays built in", async () => {
  const io = setup();
  const named = (title: string) => async () => ({ ...project, title, path: `D:\\Jobs\\_Staging\\${title}.rvt`, resolved_document: { title, path: `D:\\Jobs\\_Staging\\${title}.rvt` } });
  const call = (title: string, guard: GuardConfig) => runFmcFamilyParams(args({
    action: "add", document: title, family: "FMC_A_Titleblock_A1", name: "Status", type: "text", dry_run: false, batch_lease: "lease-1", references: refs,
  }), { ...io, guard, kitFile: io.kit, read: named(title), apply: async () => { throw new Error("must not apply"); } });
  const extraGuard = { ...io.guard, save_exclude: [], never_write_titles: ["Ogala Live"] } as GuardConfig;
  const ogala = textOf(await call("Ogala Live_USER", extraGuard));
  assert.equal(ogala.code, "FMC-PARAM-GUARD");
  assert.match(String(ogala.message), /Ogala Live is not written by fmc_family_params/);
  const hebert = textOf(await call("HEBERT HOSTELS_USER", { ...io.guard, save_exclude: [] } as GuardConfig));
  assert.match(String(hebert.message), /HEBERT HOSTELS is not written by fmc_family_params/);
});

test("research tool 41: list summary counts, and label (deprecated) names what to place by hand", async () => {
  const io = setup();
  const { paramSummary, unlabelledOf } = await import("../tools/fmc_family_params.js");
  const snap = { family: "FMC_A_Titleblock_A1", parameters: [
    { name: "Sheet Number", shared: true, instance: true, has_label: true },
    { name: "Status", shared: true, instance: true, has_label: false },
    { name: "Drawn By", shared: false, instance: false },
  ] };
  assert.deepEqual(paramSummary(snap), { titleblocks: 0, parameters: 3, shared: 2, instance: 2, labelled: 1, unlabelled: ["Status", "Drawn By"] });
  assert.match(String((paramSummary({ titleblocks: ["A1 metric"] }) as { note: string }).note), /Name a family/);
  assert.deepEqual(unlabelledOf({}), []);

  const listed = textOf(await runFmcFamilyParams(args({ action: "list", document: project.title, family: "FMC_A_Titleblock_A1", summary: true }), {
    ...io, kitFile: io.kit, read: async () => ({ ...project, parameters: snap.parameters }),
  }));
  assert.equal(listed.isError, false);
  assert.deepEqual((listed.summary as { unlabelled: string[] }).unlabelled, ["Status", "Drawn By"]);
  const plain = textOf(await runFmcFamilyParams(args({ action: "list", document: project.title, family: "FMC_A_Titleblock_A1" }), {
    ...io, kitFile: io.kit, read: async () => project,
  }));
  assert.equal(plain.summary, undefined, "summary only when asked");

  const label = textOf(await runFmcFamilyParams(args({ action: "label", document: project.title, family: "FMC_A_Titleblock_A1", name: "Status" }), {
    ...io, kitFile: io.kit, read: async () => ({ ...project, parameters: snap.parameters }),
  }));
  assert.equal(label.code, "FMC-NO-API-LABEL");
  assert.equal(label.deprecated, true);
  assert.deepEqual(label.place_by_hand, ["Status", "Drawn By"]);
});
