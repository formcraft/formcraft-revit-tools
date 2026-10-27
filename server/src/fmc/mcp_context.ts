/**
 * What any AI is told when it connects to the Formcraft MCP server (docs/AI_CONTEXT.md): the server's instructions,
 * the kit as MCP resources, two prompts, and a one-line nudge on the tools that make families or materials.
 * AI-agnostic: nothing here is specific to one model or app (docs/STATUS.md, "Core ribbon").
 */
import * as mcp from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "./policy.js";
import { readInstances } from "./connect.js";
import { ContextDeps, MAKES_FAMILY, REGISTERED_TOOLS, familyNamesIn, getItem, kitNoteFor, overview } from "./context.js";

type McpServer = mcp.McpServer;

/** The initialize result's instructions. Short and firm (under 400 words): the kit first, then the hard rules. */
export const FMC_INSTRUCTIONS = [
  "You are working inside the Formcraft plugin for Revit (Formcraft BIM Kit v2.2, Manual FMC-BIM-MAN-001). The kit is the source of truth (rule 7): its specs, recipes, profile sets, materials, keynotes, shared parameters, rulebooks and templates hold the answers.",
  "",
  "Before creating a family, material, keynote, parameter, sheet, schedule or template, call fmc_context action \"for_task\" with the task in plain words, and reuse what it returns (recipes via fmc_recipe check then build; library materials; keynote codes; shared parameters by GUID). Never invent values the kit holds; a missing price stays \"price needed\". A missing value is a kit change request: say so, don't guess. fmc_context \"overview\" once at the start shows the kit, the open Revits and the project.",
  "",
  "How to work on a model (owner 26 Oct):",
  "- Start: fmc_selftest, fmc_ai status (switch, mode, auto-approve, inbox_unread), then model_check.",
  "- Two or more Revits open: pass revit (the model's name) on every Revit call; never fmc_revit use (chats share this server). Unnamed changes are refused.",
  "- Edit with modify_model's typed ops first; send_code_to_revit only where no op fits, and name the missing op.",
  "- Geometry batches return a picture; see_view for anything else; select_by to pick exactly what to change.",
  "- Section boxes: section_box, see_view box. Undo: undo_ai_batch.",
  "- Sizes and types no brief or recipe gives: fmc_standards (say when a value is only proposed).",
  "- Fix the Revit warnings a batch reports before the next batch.",
  "- A batch waiting for approval: fmc_ai wait with its id, then go on; don't end your turn while work remains.",
  "- Your report: fmc_ai failures lists every failure with its exact reason. Models save themselves after changes (auto_save_minutes).",
  "- fmc_ai inbox: what the person sent from the pane.",
  "",
  "Hard rules (the server enforces them; never work around them):",
  "- Live-model lock: a project model changes only while its AI switch is On, and each change waits for approval unless auto-approve is on for testing. Dry run first for deletes; dry runs need no approval.",
  "- Files: writes go only to WIP and staging folders; nothing is deleted (archive moves a file to _Archive).",
  "- Never release a family or approve a gate: release is a person's act in the pane. Never decide for a professional (structural sizes, demand factors, signatures).",
  "- Never save or synchronise a workshared model: the person does it in Revit.",
  "- Activity is never used to rank people.",
].join("\n");

/** The options the server is created with (MCP SDK 1.x: new McpServer(info, { instructions })). */
export function serverOptions() {
  return { instructions: FMC_INSTRUCTIONS };
}

export const NUDGE = "First call fmc_context for_task to reuse the kit's spec/recipe. ";

/** Tools that make families or materials: their descriptions start with the nudge. */
export const NUDGED_TOOLS = new Set([
  "fmc_doc", "fmc_recipe", "fmc_family", "fmc_library", "fmc_material", "send_code_to_revit",
  "create_point_based_element", "create_line_based_element", "create_surface_based_element", "create_structural_framing_system",
  "create_level", "create_grid", "create_room", "create_dimensions",
]);

export function contextDeps(): ContextDeps {
  return { cfg: loadConfig().config, instances: () => readInstances() };
}

type Content = { content?: Array<{ type: string; text?: string }>; [k: string]: unknown };

/** After a call that made or saved a family, a short pointer to the kit's spec or recipe for that name (name lookup only). */
export function annotateResult(tool: string, args: Record<string, unknown>, result: Content, deps: () => ContextDeps = contextDeps): Content {
  try {
    let names: string[] = [];
    if (tool === "send_code_to_revit") {
      const code = String(args.code ?? "");
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      if (MAKES_FAMILY.test(code) || MAKES_FAMILY.test(text)) names = familyNamesIn(code + "\n" + text);
    } else if (tool === "fmc_doc" && args.action === "save" && typeof args.path === "string") {
      names = familyNamesIn(args.path.split(/[\\/]/).pop() ?? "");
    }
    if (!names.length) return result;
    const note = kitNoteFor(names, deps());
    if (!note) return result;
    return { ...result, content: [...(result.content ?? []), { type: "text", text: note }] };
  } catch { return result; }
}

/**
 * Wraps server.tool before the tools register: nudged tools get the one-line prefix, send_code_to_revit and fmc_doc
 * results get the kit note, and every registered name is recorded (fmc_context reports which engines are in the build).
 * Keeps the tool files themselves untouched.
 */
export function installContextNudges(server: McpServer, deps: () => ContextDeps = contextDeps) {
  const s = server as unknown as { tool: (...a: unknown[]) => unknown };
  const original = s.tool.bind(server);
  s.tool = (...a: unknown[]) => {
    if (typeof a[0] === "string") REGISTERED_TOOLS.add(a[0]);
    if (a.length === 4 && typeof a[0] === "string" && typeof a[1] === "string" && typeof a[3] === "function") {
      const name = a[0];
      const description = NUDGED_TOOLS.has(name) && !a[1].startsWith(NUDGE) ? NUDGE + a[1] : a[1];
      const handler = a[3] as (args: Record<string, unknown>, extra: unknown) => unknown;
      const wrapped = name === "send_code_to_revit" || name === "fmc_doc"
        ? async (args: Record<string, unknown>, extra: unknown) => annotateResult(name, args ?? {}, (await handler(args, extra)) as Content, deps)
        : handler;
      return original(name, description, a[2], wrapped);
    }
    return original(...a);
  };
}

const json = (uri: string, body: unknown) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body) }] });

/**
 * MCP resources (read-only, the same code as fmc_context): fmc://kit/overview and the family specs, materials and
 * rulebooks by name. Returns what was registered, or why nothing was (an SDK without resources).
 */
export function registerContextResources(server: McpServer, deps: () => ContextDeps = contextDeps): string[] {
  const s = server as unknown as { resource?: (...a: unknown[]) => unknown };
  const Template = (mcp as unknown as { ResourceTemplate?: new (uri: string, cb: { list: undefined }) => unknown }).ResourceTemplate;
  if (typeof s.resource !== "function" || !Template) return [];
  const done: string[] = [];
  s.resource("fmc-kit-overview", "fmc://kit/overview",
    { description: "The Formcraft kit, the open Revit documents and the project: counts, versions and which tool to use for what", mimeType: "application/json" },
    async (uri: URL) => json(uri.href, overview(deps())));
  done.push("fmc://kit/overview");
  const byName = (id: string, kind: string, about: string) => {
    s.resource!(id, new Template(`fmc://kit/${id}/{name}`, { list: undefined }), { description: about, mimeType: "application/json" },
      async (uri: URL, vars: Record<string, string | string[]>) => {
        const n = decodeURIComponent(String(Array.isArray(vars.name) ? vars.name[0] : vars.name ?? ""));
        return json(uri.href, getItem(`${kind}:${n}`, deps()));
      });
    done.push(`fmc://kit/${id}/{name}`);
  };
  byName("family-specs", "spec", "One family spec from FMC_Family_Specs.json, with its recipe, staged and released files");
  byName("materials", "material", "One material from the kit's library (07_Materials/FMC_Materials.json), with keynote and price status");
  byName("rulebooks", "rulebook", "One kit rulebook (FMC_Rulebook_<name>.json): its rules by id, severity and title");
  return done;
}

/** MCP prompts: build a family from the kit, and give types a library material. */
export function registerContextPrompts(server: McpServer): string[] {
  const s = server as unknown as { prompt?: (...a: unknown[]) => unknown };
  if (typeof s.prompt !== "function") return [];
  const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
  s.prompt("build-family", "Build a Formcraft family from the kit's spec and recipe (staging only, dry run first)",
    { family: z.string().describe("The family wanted, a kit name (FMC_A_Door_…) or plain words (a bi-fold aluminium door)") },
    ({ family }: { family: string }) => user(
      `Build this family the Formcraft way: ${family}.\n` +
      `1. Call fmc_context {"action":"for_task","task":${JSON.stringify("build family: " + family)}} and use what it returns.\n` +
      "2. If the kit has a recipe: fmc_recipe check, then fmc_recipe build with dry_run true; show me the dry run and wait for my yes before dry_run false. Then fmc_recipe gate.\n" +
      "3. If there is a spec but no recipe: write the recipe from the spec (template, category, types, shared parameters by GUID) and the nearest kit recipe, mark each value's source_status honestly (verified, EA, assumed, pending), then step 2.\n" +
      "4. If the kit has no spec: stop and draft a kit change request; don't invent sizes, GUIDs or keynotes.\n" +
      "Never release it: release is my act in the pane."));
  s.prompt("assign-material", "Give types a material from the kit's library (dry run first; refused on live projects)",
    { material: z.string().describe("The material wanted, a kit name or plain words (terrazzo floor)"), target: z.string().optional().describe("Which types: a category, the selection, or 'type name contains …'") },
    ({ material, target }: { material: string; target?: string }) => user(
      `Use the kit's material library for: ${material}${target ? ` on ${target}` : ""}.\n` +
      `1. Call fmc_context {"action":"for_task","task":${JSON.stringify(material + " material")}} and pick the library material it returns (with its keynote).\n` +
      "2. fmc_material assign with dry_run true; show me the dry run and wait for my yes before dry_run false.\n" +
      "If the library has no fitting material, draft fmc_material request instead; never make one up. A missing price stays \"price needed\"."));
  // B. the session prompts (owner 26 Oct): the instructions that used to be pasted, with the model filled in
  s.prompt("work-on-project", "Work on a project model with the AI: checks first, typed edits, pictures, standards, saved as you go",
    { model: z.string().describe("The model's name as Revit shows it, e.g. OGL_A_MainHouse_GF_LOD400"), task: z.string().optional().describe("What to do today; empty: carry on and fix what model_check finds") },
    ({ model, task }: { model: string; task?: string }) => user(
      `Work on ${model}${task ? `: ${task}` : ""}.\n` +
      `1. Pass revit: ${JSON.stringify(model)} on every Revit tool call; never use fmc_revit use.\n` +
      "2. fmc_selftest, fmc_ai status, then model_check; look at the top problems with see_view.\n" +
      "3. Edit with modify_model's typed ops (code only where no op fits). Take sizes from fmc_standards. Fix the warnings each batch reports before the next.\n" +
      "4. Keep going batch after batch while work remains; fmc_ai wait on any batch that waits for approval.\n" +
      "5. At the end: what you changed, what's left, and fmc_ai failures as a table (tool, op, exact reason)."));
  s.prompt("test-new-build", "Test the installed build's tools on a sandbox model, one by one, with a report",
    { model: z.string().describe("The sandbox model's name, e.g. OGL_TEST_Sandbox (never a live project)") },
    ({ model }: { model: string }) => user(
      `Test the installed build on ${model} only.\n` +
      `1. Pass revit: ${JSON.stringify(model)} on every Revit tool call; never use fmc_revit use. Change nothing in any other model.\n` +
      "2. fmc_selftest, then try every modify_model op once on small elements (walls, floors with holes, roofs with overhang, stairs from risers, place_family on \"$n\", duplicate_type with layers, rehost, edit_sketch, wall_profile, copy, mirror, join, cut, views, sheets, tags) and see_view, model_check, select_by, fmc_standards.\n" +
      "3. Report a table: tool, op, worked yes or no, the exact error; add fmc_ai failures."));
  return ["build-family", "assign-material", "work-on-project", "test-new-build"];
}
