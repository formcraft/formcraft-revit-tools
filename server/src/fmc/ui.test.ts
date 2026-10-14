import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { FMC_UI_SHAPE, FmcUiArgs, runFmcUi, uiRequest } from "./ui.js";
import { PANE_COMMANDS, WRITE_COMMANDS } from "./policy.js";

const parse = (a: object) => z.object(FMC_UI_SHAPE).parse(a) as FmcUiArgs;
const text = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

test("fmc_ui is a pane command, never a model-changing one", () => {
  assert.ok(PANE_COMMANDS.has("fmc_ui"));
  for (const c of PANE_COMMANDS) assert.ok(!WRITE_COMMANDS.has(c), `${c} must not be behind the live-model lock`);
});

test("get_state sends only the action", () => {
  assert.deepEqual(uiRequest(parse({ action: "get_state" })), { params: { action: "get_state" }, problems: [] });
});

test("open_section needs a section and trims it", () => {
  assert.deepEqual(uiRequest(parse({ action: "open_section" })).problems, ["open_section needs section (see get_state groups)"]);
  assert.deepEqual(uiRequest(parse({ action: "open_section", section: "  Setup › Templates " })).params,
    { action: "open_section", section: "Setup › Templates" });
});

test("set_mock_licence takes a preset, modules or both", () => {
  assert.equal(uiRequest(parse({ action: "set_mock_licence" })).problems.length, 1);
  assert.deepEqual(uiRequest(parse({ action: "set_mock_licence", preset: "grace_over", modules: { Build: "Active" } })).params,
    { action: "set_mock_licence", preset: "grace_over", modules: { Build: "Active" } });
});

test("the schema refuses unknown presets and module statuses", () => {
  assert.throws(() => parse({ action: "set_mock_licence", preset: "forever" }));
  assert.throws(() => parse({ action: "set_mock_licence", modules: { Build: "Free" } }));
  assert.throws(() => parse({ action: "set_mock_licence", modules: { Core: "Active" } }));
});

test("a refused call never reaches Revit", async () => {
  let sent = false;
  const r = await runFmcUi(parse({ action: "open_section" }), async () => { sent = true; return {}; });
  assert.equal(sent, false);
  assert.equal(r.isError, true);
  assert.equal(text(r).refused, true);
});

test("results and Revit errors come back as JSON", async () => {
  const ok = await runFmcUi(parse({ action: "get_state" }), async (command, params) => ({ command, params, screen: "Main" }));
  assert.deepEqual(text(ok).state, { command: "fmc_ui", params: { action: "get_state" }, screen: "Main" });
  const shot = await runFmcUi(parse({ action: "screenshot_pane" }), async () => ({ path: "C:\\r\\FMC_Pane.png" }));
  assert.deepEqual(text(shot).saved, { path: "C:\\r\\FMC_Pane.png" });
  const bad = await runFmcUi(parse({ action: "set_mock_licence", preset: "offline" }), async () => {
    throw new Error("fmc_ui: set_mock_licence works in test builds only");
  });
  assert.equal(bad.isError, true);
  assert.match(text(bad).error, /test builds only/);
});

test("close_revit is an fmc_ui action (F-021); the add-in decides whether it may close", () => {
  assert.equal(z.object(FMC_UI_SHAPE).safeParse({ action: "close_revit" }).success, true);
});
