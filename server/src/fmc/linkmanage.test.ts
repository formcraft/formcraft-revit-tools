import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { FMC_LINKS_DESCRIPTION, FMC_LINKS_SHAPE } from "../tools/fmc_links.js";
import { FMC_RELOAD_LINK_DESCRIPTION } from "../tools/fmc_reload_link.js";
import { WRITE_COMMANDS } from "./policy.js";
import {
  IDENTITY_LIMIT, LINK_CENTRAL, LINK_OPEN_AS_HOST, LINK_OPEN_FILE, LINK_PROTECTED, LINK_SAME_FILE,
  centralFolder, linkRole, publishedFileName, runLinkPlan, type LinkIo,
} from "./linkmanage.js";
import type { SessionDoc } from "./reloadlink.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const wip = "D:\\Ogala\\THE OGALA RESIDENCE\\01_WIP";
const centralA = "D:\\Ogala\\Centrals\\A-0002.rvt";
const centralP = "D:\\Ogala\\Centrals\\P-0001.rvt";
const centralE = "D:\\Ogala\\Centrals\\E-0001.rvt";
const structural = wip + "\\S\\S-0001.rvt";
const arch = wip + "\\A\\A-0002_USER.rvt";
const plumb = wip + "\\P\\P-0001_USER.rvt";
const elec = wip + "\\E\\E-0001_USER.rvt";
const cfg: GuardConfig = {
  ...DEFAULT_CONFIG,
  write_roots: ["D:\\Ogala\\*\\01_WIP"],
  protected_paths: ["D:\\Fomcraft"],
  protected_roots: [],
  save_exclude: ["HEBERT HOSTELS"],
  sync_exclude: [],
  blocked_segments: ["02_Shared", "03_Published", "04_Archive", "05_Incoming"],
};

const open: SessionDoc[] = [
  { title: "A-0002_USER", path: arch, isWorkshared: true, central: centralA, isFamily: false, isLinked: false },
  { title: "S-0001", path: structural, isWorkshared: false, isFamily: false, isLinked: false },
  { title: "P-0001_USER", path: plumb, isWorkshared: true, central: centralP, isFamily: false, isLinked: false },
  { title: "E-0001_USER", path: elec, isWorkshared: true, central: centralE, isFamily: false, isLinked: false },
];

const set = [
  { path: centralA, role: "A" },
  { path: structural, role: "S" },
  { path: centralP, role: "P" },
  { path: centralE, role: "E" },
];

function harness(docs: SessionDoc[] = open, linkResult = "linked by shared coordinates, pinned") {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let links = 0;
  const note = (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return args; };
  const io: LinkIo = {
    session: async () => ({ documents: docs }),
    facts: async (document) => {
      calls.push({ name: "facts", args: { document } });
      const doc = docs.find((item) => item.path === document || item.title === document);
      return { model: `${doc?.title ?? "model"}.rvt`, workshared: doc?.isWorkshared === true, central: doc?.central ?? "", links: [], worksets: [], coordinates: { site: "Internal" } };
    },
    centralOf: async (document) => { calls.push({ name: "central", args: { document } }); return ""; },
    transmissionRead: async (file) => note("transmissionRead", { file }),
    transmissionWrite: async (params) => note("transmissionWrite", params),
    publish: async (params) => note("publish", params),
    linkAdd: async (params) => {
      links += 1;
      note("linkAdd", params);
      const failSame = linkResult === "same-model-once" && links === 1;
      const text = failSame ? "not linked: SameModelAsHost" : linkResult;
      return { models: [{ name: "copy", result: text }] };
    },
    linkPin: async (params) => note("pin", params),
    reload: async (params) => note("reload", params),
    unload: async (params) => note("unload", params),
    copyFile: async (from, to) => { calls.push({ name: "copyFile", args: { from, to } }); },
    setReadOnly: async (file, on) => { calls.push({ name: "readOnly", args: { file, on } }); },
    removeFile: async (file) => { calls.push({ name: "remove", args: { file } }); },
    exists: () => true,
    listModels: () => [],
  };
  return { io, calls, names: () => calls.map((call) => call.name) };
}

test("dry_run defaults to true and does not copy or link", async () => {
  const parsed = z.object(FMC_LINKS_SHAPE).parse({ action: "apply", documents: ["S-0001"], link_set: [{ path: centralA, role: "A" }] });
  assert.equal(parsed.dry_run, true);
  const { io, names } = harness();
  const ran = await runLinkPlan({ action: "apply", documents: ["S-0001"], link_set: [{ path: centralA, role: "A" }] }, io, cfg);
  assert.equal(ran.isError, false);
  assert.equal(ran.body.dry_run, true);
  const would = ((ran.body.documents as Array<{ would: Array<Record<string, unknown>> }>)[0].would)[0];
  assert.equal(would.route, "published_copy");
  assert.equal(would.method, "detach-save");
  assert.equal(would.blocked_by, "A-0002_USER");
  assert.equal(would.workset, "Z_Links_A");
  assert.match(String(would.copy_to), /\\01_WIP\\_LinkCopies\\FMC_LinkCopy_A_/);
  assert.doesNotMatch(String(would.copy_to), /Centrals/i);
  assert.match(String(would.api_limit), /SameCentralModelAsHost/);
  assert.deepEqual(names().filter((name) => ["copyFile", "publish", "linkAdd", "reload", "transmissionWrite"].includes(name)), []);
});

test("a workshared source open as a host is published, not linked, and SameCentralModelAsHost stays a failure", async () => {
  const { io, calls } = harness(open, "not linked: SameCentralModelAsHost");
  const ran = await runLinkPlan({
    action: "apply", documents: ["S-0001"], link_set: [{ path: centralA, role: "A" }], dry_run: false, on_blocked: "published_copy",
  }, io, cfg);
  assert.equal(ran.isError, true);
  assert.equal(ran.body.code, LINK_OPEN_AS_HOST);
  assert.equal(ran.body.still_blocked, true);
  assert.equal(ran.body.blocked_by, "A-0002_USER");
  const copy = calls.find((call) => call.name === "copyFile");
  const publish = calls.find((call) => call.name === "publish");
  const link = calls.find((call) => call.name === "linkAdd");
  assert.equal(copy?.args.from, centralA);
  assert.match(String(copy?.args.to), /FMC_LinkStaging_/);
  assert.notEqual(copy?.args.to, centralA);
  assert.equal(publish?.args.source, centralA);
  assert.equal(publish?.args.method, "detach-save");
  assert.equal(publish?.args.dest, link && (link.args.models as Array<{ path: string }>)[0].path);
  assert.doesNotMatch(String(publish?.args.dest), /Centrals/i);
  assert.notEqual((link?.args.models as Array<{ path: string }>)[0].path, centralA);
  const row = (ran.body.documents as Array<{ results: Array<Record<string, unknown>> }>)[0].results[0];
  assert.equal(row.still_blocked, true);
  assert.match(String(row.hint ?? ran.body.api_limit), /SameCentralModelAsHost|open as a host|A-0002_USER|identity/i);
});

test("a published copy that loads is success and does not link the central", async () => {
  const { io, calls } = harness();
  const ran = await runLinkPlan({
    action: "apply", documents: ["S-0001"], link_set: [{ path: centralA, role: "A" }], dry_run: false,
  }, io, cfg);
  assert.equal(ran.isError, false, JSON.stringify(ran.body));
  assert.equal(ran.body.ok, true);
  const link = calls.find((call) => call.name === "linkAdd");
  assert.notEqual((link?.args.models as Array<{ path: string }>)[0].path, centralA);
  assert.match(String((ran.body.documents as Array<{ results: Array<{ result: string }> }>)[0].results[0].result), /^linked/);
});

test("on_blocked fail names the open document and does not publish", async () => {
  const { io, names } = harness();
  const ran = await runLinkPlan({
    action: "apply", documents: ["S-0001"], link_set: [{ path: centralA, role: "A" }], dry_run: false, on_blocked: "fail",
  }, io, cfg);
  assert.equal(ran.body.code, LINK_OPEN_AS_HOST);
  assert.match(String(ran.body.message), /A-0002_USER/);
  assert.ok(!names().includes("publish"));
  assert.ok(!names().includes("copyFile"));
  assert.ok(!names().includes("linkAdd"));
});

test("a non-workshared file that is open is file-copied, then Save As if Revit still says the same model", async () => {
  const { io, calls } = harness(open, "same-model-once");
  const ran = await runLinkPlan({
    action: "apply", documents: ["A-0002_USER"], link_set: [{ path: structural, role: "S" }], dry_run: false,
  }, io, cfg);
  assert.equal(ran.isError, false, JSON.stringify(ran.body));
  const publish = calls.filter((call) => call.name === "publish");
  assert.equal(publish.length, 1);
  assert.equal(publish[0].args.method, "save-as");
  assert.equal(publish[0].args.source, structural);
  assert.notEqual(publish[0].args.staging, structural);
  const links = calls.filter((call) => call.name === "linkAdd");
  assert.equal(links.length, 2);
  assert.notEqual((links[0].args.models as Array<{ path: string }>)[0].path, structural);
});

test("apply across the open Ogala documents skips each host itself", async () => {
  const { io } = harness();
  const ran = await runLinkPlan({ action: "apply", documents: ["A-0002_USER", "S-0001", "P-0001_USER", "E-0001_USER"], link_set: set }, io, cfg);
  assert.equal(ran.isError, false, JSON.stringify(ran.body));
  const rows = ran.body.documents as Array<{ document: { title: string }; would: Array<{ name: string; workset: string; route: string }> }>;
  assert.equal(rows.length, 4);
  const archRow = rows.find((row) => row.document.title === "A-0002_USER");
  assert.ok(archRow);
  const linked = archRow.would.filter((item) => item.route !== "skip");
  assert.equal(linked.length, 3);
  assert.equal(archRow.would.find((item) => /A-0002/i.test(item.name))?.route, "skip");
  assert.ok(linked.every((item) => !/A-0002/i.test(item.name)));
  assert.deepEqual(linked.map((item) => item.workset).sort(), ["Z_Links_E", "Z_Links_P", "Z_Links_S"]);
  const structuralRow = rows.find((row) => row.document.title === "S-0001");
  assert.equal(structuralRow?.would.find((item) => item.workset === "Z_Links_A")?.route, "published_copy");
});

test("document targeting refuses a missing title, an ambiguous title and a missing name", async () => {
  const { io, names } = harness();
  const missing = await runLinkPlan({ action: "link", document: "not-a-model", models: [structural] }, io, cfg);
  assert.equal(missing.body.code, "FMC-DOC-NOT-FOUND");
  const ambiguous = await runLinkPlan({
    action: "pin", document: "Shared",
  }, {
    ...io,
    session: async () => ({ documents: [
      { title: "Shared", path: arch, isFamily: false },
      { title: "Shared", path: structural, isFamily: false },
    ] }),
  }, cfg);
  assert.equal(ambiguous.body.code, "FMC-DOC-AMBIGUOUS");
  const required = await runLinkPlan({ action: "link", models: [centralA] }, io, cfg);
  assert.equal(required.body.code, "FMC-DOC-REQUIRED");
  assert.ok(!names().includes("linkAdd"));
});

test("protected paths, save_exclude, centrals and open files are not written", async () => {
  const { io, names } = harness();
  const protectedFile = "D:\\Fomcraft\\FMC_PROJECTS_27\\closed.rvt";
  const refused = await runLinkPlan({
    action: "offline", file: protectedFile, dry_run: false, edits: [{ from: centralA, to: structural, load: true }],
  }, io, cfg);
  assert.equal(refused.body.code, LINK_PROTECTED);
  assert.match(String(refused.body.message), /protected path/i);

  const hebert = wip + "\\A\\HEBERT HOSTELS_USER.rvt";
  const excluded = await runLinkPlan({
    action: "offline", file: hebert, dry_run: false, edits: [{ from: centralA, to: structural, load: false }],
  }, io, cfg);
  assert.equal(excluded.body.code, LINK_PROTECTED);
  assert.match(String(excluded.body.message), /save_exclude|HEBERT/i);

  const centralWrite = await runLinkPlan({
    action: "offline", file: "D:\\Ogala\\Centrals\\closed.rvt", dry_run: false, edits: [{ id: 12, load: false }],
  }, io, cfg);
  assert.equal(centralWrite.body.code, LINK_CENTRAL);

  const openWrite = await runLinkPlan({
    action: "offline", file: structural, dry_run: false, edits: [{ from: centralA, load: false }],
  }, io, cfg);
  assert.equal(openWrite.body.code, LINK_OPEN_FILE);
  assert.match(String(openWrite.body.message), /S-0001/);

  const badCopy = await runLinkPlan({
    action: "apply", documents: ["S-0001"], link_set: [{ path: centralA, role: "A" }], copy_folder: "D:\\Fomcraft\\copies", dry_run: false,
  }, io, cfg);
  assert.equal(badCopy.body.code, LINK_PROTECTED);
  assert.ok(!names().includes("transmissionWrite"));
  assert.ok(!names().includes("publish"));
  assert.ok(!names().includes("copyFile"));
});

test("offline dry_run does not write, and a closed audit does not open the file", async () => {
  const { io, names } = harness();
  const closed = wip + "\\Z\\closed.rvt";
  const dry = await runLinkPlan({
    action: "offline", file: closed, edits: [{ from: centralA, to: wip + "\\Z\\other.rvt", load: true }],
  }, io, cfg);
  assert.equal(dry.body.dry_run, true);
  assert.equal(dry.body.opened, false);
  const audit = await runLinkPlan({ action: "audit", file: closed }, io, cfg);
  assert.equal(audit.body.source, "transmission");
  assert.equal(audit.body.opened, false);
  assert.ok(names().includes("transmissionRead"));
  assert.ok(!names().includes("facts"));
  assert.ok(!names().includes("transmissionWrite"));
  const live = await runLinkPlan({ action: "audit", document: "S-0001" }, io, cfg);
  assert.equal(live.body.source, "open");
  assert.equal((live.body.resolved_document as { title: string }).title, "S-0001");
});

test("a link copy is never the source, and roles come from the container or the short name", () => {
  assert.equal(centralFolder(centralA), true);
  assert.equal(centralFolder(wip + "\\_LinkCopies\\FMC_LinkCopy_A_abcd.rvt"), false);
  assert.equal(linkRole(structural, "S"), "S");
  assert.equal(linkRole("D:\\Jobs\\A-0002_USER.rvt"), "A");
  assert.equal(publishedFileName(centralA, "A").startsWith("FMC_LinkCopy_A_"), true);
  assert.equal(publishedFileName(centralA, "A") === "A-0002.rvt", false);
  assert.match(IDENTITY_LIMIT, /SameCentralModelAsHost/);
  assert.equal(LINK_SAME_FILE, "FMC-LINK-SAME-FILE");
});

test("the tool text tells a bot the actions, and the add-in refuses the unsafe paths", () => {
  assert.match(FMC_LINKS_DESCRIPTION, /apply/);
  assert.match(FMC_LINKS_DESCRIPTION, /published_copy/);
  assert.match(FMC_LINKS_DESCRIPTION, /FMC-LINK-OPEN-AS-HOST/);
  assert.match(FMC_LINKS_DESCRIPTION, /dry_run defaults to true/);
  assert.match(FMC_RELOAD_LINK_DESCRIPTION, /fmc_links/);
  assert.ok(WRITE_COMMANDS.has("fmc_link_publish") && WRITE_COMMANDS.has("fmc_link_unload") && WRITE_COMMANDS.has("fmc_reload_link"));
  const session = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcLinkSession.cs"), "utf8");
  const links = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcLinkEventHandler.cs"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.match(session, /DetachAndDiscardWorksets/);
  assert.match(session, /opened_source"\] = false/);
  assert.match(session, /Close\(false\)/);
  assert.match(session, /FMC-LINK-ACTIVE-CHANGED/);
  assert.match(session, /FMC-LINK-CENTRAL/);
  assert.match(session, /FMC-LINK-PROTECTED/);
  assert.doesNotMatch(session, /OpenAndActivateDocument/);
  assert.doesNotMatch(session, /SynchronizeWithCentral/);
  assert.doesNotMatch(session, /new\s+Transaction\s*\(/);
  assert.match(links, /mayOpen: false/);
  assert.match(links, /\["type_id"\]/);
  for (const name of ["fmc_link_publish", "fmc_link_unload", "fmc_link_transmission", "fmc_reload_link"])
    assert.ok(manifest.commands.some((row) => row.commandName === name), name);
});

test("research 56: suggested link_set, coordinates agree line (origin offset not flagged), and a same-name copy that is not the open model", async () => {
  const { coordinatesAgree, notTheOpenModel, suggestLinkSet } = await import("./linkmanage.js");
  const agree = coordinatesAgree([
    { model: "architectural_USER.rvt", coordinates: { angle_deg: 0, easting_mm: -7358, northing_mm: 4152, crs: "" } },
    { model: "plumbing_USER.rvt", coordinates: { angle_deg: 0, easting_mm: 0, northing_mm: 0, crs: "" } },
  ]);
  assert.equal(agree.agree, true);
  assert.match(agree.line, /^Coordinates agree across 2 models: angle 0 deg; internal origins differ by up to 8\.4 m, which is normal and not flagged\.$/);
  const off = coordinatesAgree([{ model: "a", coordinates: { angle_deg: 0 } }, { model: "b", coordinates: { angle_deg: 12.5 } }]);
  assert.equal(off.agree, false);
  assert.match(String(off.next), /fmc_coord/);
  const copy = { id: 7, name: "A-0002.rvt", path: "C:\\FORMCRAFT WORKSHARE\\old\\A-0002.rvt", path_type: "Absolute", attachment: "Overlay", loaded: true, pinned: true, workset: "LINK ARCH" };
  assert.equal(notTheOpenModel(copy, open, open[2])?.title, "A-0002_USER");
  assert.equal(notTheOpenModel({ ...copy, path: centralA }, open, open[2]), undefined);
  const { io } = harness();
  const facts = io.facts;
  io.facts = async (document) => ({ ...(await facts(document)), links: document === plumb ? [copy] : [], coordinates: { angle_deg: 0, easting_mm: document === arch ? -7358 : 0, northing_mm: 0 } });
  io.listModels = () => ["D:\\Ogala\\02_Shared\\A-0002.rvt"];
  const ran = await runLinkPlan({ action: "audit", document: "P-0001_USER", documents: ["A-0002_USER"], link_from: "D:\\Ogala\\02_Shared", suggest: true }, io, cfg);
  assert.equal(ran.isError, false);
  const row = (ran.body.audit as Array<{ problems: string[]; state: string }>)[0];
  assert.equal(row.state, "Fix");
  assert.ok(row.problems.some((p) => /linked copy is not the open model A-0002_USER/.test(p)));
  const suggested = ran.body.suggested as ReturnType<typeof suggestLinkSet>;
  assert.deepEqual(suggested.link_set.map((item) => item.path), ["D:\\Ogala\\02_Shared\\A-0002.rvt"]);
  assert.deepEqual(suggested.documents, [plumb]);
  assert.equal((ran.body.coordinates_check as { agree: boolean }).agree, true);
});
