import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resetBatchBoard, batchBoard } from "./batchline.js";
import { BATCH_AUTH, BATCH_IDENTITY, BATCH_SCHEDULER, humanStart, identityVerdict, maintenanceVerdict, registeredClient, schedulerVerdict, type BotRegistry } from "./botauth.js";
import { runFmcBatch } from "../tools/fmc_batch.js";
import type { Caller } from "./caller.js";

const caller = (client: string, session = "s1"): Caller => ({ client, session, transport: "http" });
const reg: BotRegistry = {
  batch_admins: ["formcraft-ops"],
  batch_schedulers: ["Hostel Building Bot"],
  bot_identities: { "Hostel Building Bot": ["hostel-client"], "Revit Testing Bot": ["testing-client"] },
};
const references = { kit: ["FMC_Kit"], standards: ["structure.column.300"], rulebook: ["NAM-004"] };
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

before(() => { resetBatchBoard({ autoSweep: false }).close(); });
after(() => { resetBatchBoard({ autoSweep: false }).close(); });

test("drain and resume: a person is allowed", () => {
  for (const by of ["pane", "cli", "person"]) {
    assert.equal(humanStart(by), true, by);
    for (const action of ["drain", "resume"] as const) assert.equal(maintenanceVerdict(action, undefined, caller("claude-code"), by, reg).ok, true, `${by} ${action}`);
  }
});

test("drain and resume: a client in batch_admins is allowed, and so is a bot proven by bot_identities", () => {
  assert.equal(maintenanceVerdict("drain", undefined, caller("formcraft-ops"), "ai", reg).ok, true);
  assert.equal(maintenanceVerdict("resume", undefined, caller("FormCraft-Ops"), "ai", reg).ok, true, "case-insensitive");
  const withBot: BotRegistry = { ...reg, batch_admins: ["Revit Testing Bot"] };
  assert.equal(maintenanceVerdict("drain", "Revit Testing Bot", caller("testing-client"), "ai", withBot).ok, true);
});

test("drain and resume: an AI session, an unlisted client and an unnamed client are refused with FMC-BATCH-AUTH", () => {
  for (const by of ["ai", "job", "schedule", ""]) {
    for (const action of ["drain", "resume"] as const) {
      const v = maintenanceVerdict(action, undefined, caller("claude-code"), by, reg);
      assert.equal(v.ok, false, `${by} ${action}`);
      assert.equal(v.code, BATCH_AUTH);
      assert.equal(v.code, "FMC-BATCH-AUTH");
    }
  }
  assert.equal(maintenanceVerdict("drain", undefined, caller("unknown"), "ai", reg).ok, false);
  assert.equal(maintenanceVerdict("drain", undefined, caller("claude-code"), "ai", {}).ok, false, "no list: nobody");
  // naming an admin bot in the bot field does not make the caller one
  const spoof = maintenanceVerdict("drain", "Revit Testing Bot", caller("claude-code"), "ai", { ...reg, batch_admins: ["Revit Testing Bot"] });
  assert.equal(spoof.ok, false);
  assert.equal(spoof.code, BATCH_AUTH);
});

test("fmc_batch drain and resume through the tool: refused for an AI caller (the line is unchanged), allowed for a person", async () => {
  const board = batchBoard();
  assert.equal(board.snapshot().maintenance, false);
  const refusedDrain = await runFmcBatch({ action: "drain", reason: "test" }, "s1", { caller: caller("claude-code"), startedBy: "ai", config: reg });
  assert.equal(refusedDrain.isError, true);
  assert.match(text(refusedDrain), /FMC-BATCH-AUTH/);
  assert.equal(board.snapshot().maintenance, false, "nothing was drained");
  const ok = await runFmcBatch({ action: "drain", reason: "server update" }, "s1", { caller: caller("claude-code"), startedBy: "pane", config: reg });
  assert.equal(ok.isError, false);
  assert.equal(board.snapshot().maintenance, true);
  const refusedResume = await runFmcBatch({ action: "resume" }, "s1", { caller: caller("claude-code"), startedBy: "ai", config: reg });
  assert.equal(refusedResume.isError, true);
  assert.match(text(refusedResume), /FMC-BATCH-AUTH/);
  assert.equal(board.snapshot().maintenance, true, "an AI session can't lift a person's drain");
  const listed = await runFmcBatch({ action: "resume" }, "s1", { caller: caller("formcraft-ops"), startedBy: "ai", config: reg });
  assert.equal(listed.isError, false);
  assert.equal(board.snapshot().maintenance, false);
});

test("a scheduler is its registered client or a proven bot name; the bot field alone is refused (spoofed name)", () => {
  assert.equal(schedulerVerdict(undefined, caller("Hostel Building Bot"), reg).ok, true, "by registered client name");
  assert.equal(schedulerVerdict("Hostel Building Bot", caller("hostel-client"), reg).ok, true, "bot name proven by bot_identities");
  const spoof = schedulerVerdict("Hostel Building Bot", caller("claude-code"), reg);
  assert.equal(spoof.ok, false);
  assert.equal(spoof.code, BATCH_SCHEDULER);
  assert.equal(schedulerVerdict("Hostel Building Bot", caller("unknown"), reg).ok, false);
  assert.equal(schedulerVerdict("Hostel Building Bot", caller("testing-client"), reg).ok, false, "another registered bot's client");
  assert.equal(schedulerVerdict("Hostel Building Bot", caller("hostel-client"), { ...reg, batch_schedulers: [] }).ok, false, "an empty list is nobody");
});

test("a bot name on request or reserve must be the caller's own when it is a registered, scheduler or admin name", () => {
  assert.equal(identityVerdict(undefined, caller("claude-code"), reg).ok, true);
  assert.equal(identityVerdict("structure", caller("claude-code"), reg).ok, true, "an unregistered bot value is just a label");
  assert.equal(identityVerdict("Revit Testing Bot", caller("testing-client"), reg).ok, true);
  for (const bot of ["Revit Testing Bot", "revit testing bot", "Hostel Building Bot", "formcraft-ops"]) {
    const v = identityVerdict(bot, caller("claude-code"), reg);
    assert.equal(v.ok, false, bot);
    assert.equal(v.code, BATCH_IDENTITY);
    assert.equal(v.code, "FMC-BATCH-IDENTITY");
  }
  assert.equal(identityVerdict("Revit Testing Bot", caller("hostel-client"), reg).ok, false, "another bot's client");
  assert.equal(registeredClient(caller("unknown")), "");
  assert.equal(registeredClient(caller(" Claude ")), "claude");
});

test("fmc_batch reserve and request through the tool: a spoofed scheduler or bot name is refused, the real one works", async () => {
  const spoofReserve = await runFmcBatch({ action: "reserve", document: "Architecture", label: "walls", bot: "Hostel Building Bot", references }, "s9", { caller: caller("claude-code"), startedBy: "ai", config: reg });
  assert.equal(spoofReserve.isError, true);
  assert.match(text(spoofReserve), /FMC-BATCH-IDENTITY/);
  const spoofRequest = await runFmcBatch({ action: "request", document: "Architecture", label: "walls", bot: "Revit Testing Bot", references }, "s9", { caller: caller("claude-code"), startedBy: "ai", config: reg });
  assert.equal(spoofRequest.isError, true);
  assert.match(text(spoofRequest), /FMC-BATCH-IDENTITY/);
  const byLabel = await runFmcBatch({ action: "request", document: "Architecture", label: "Revit Testing Bot", references }, "s9", { caller: caller("claude-code"), startedBy: "ai", config: reg });
  assert.equal(byLabel.isError, true, "the bot defaults to the label, so a label naming a registered bot is checked too");
  assert.match(text(byLabel), /FMC-BATCH-IDENTITY/);
  const stranger = await runFmcBatch({ action: "reserve", document: "Site", label: "pads", bot: "site", references }, "s9", { caller: caller("claude-code"), startedBy: "ai", config: reg });
  assert.equal(stranger.isError, true);
  assert.match(text(stranger), /FMC-BATCH-SCHEDULER/);
  const real = await runFmcBatch({ action: "reserve", document: "Plumbing", label: "stacks", bot: "plumbing", references }, "s10", { caller: caller("Hostel Building Bot"), startedBy: "ai", config: reg });
  assert.equal(real.isError, false, text(real));
  const own = await runFmcBatch({ action: "reserve", document: "Electrical", label: "lights", bot: "Hostel Building Bot", references }, "s11", { caller: caller("hostel-client"), startedBy: "ai", config: reg });
  assert.equal(own.isError, false, text(own));
});
