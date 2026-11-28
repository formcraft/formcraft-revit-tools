import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { loadConfig } from "../fmc/policy.js";
import { imageDir, keptImagePath } from "../fmc/images.js";
import { FilterTool, isEngineCall, ACTIONS, type FilterDeps } from "../fmc/filter.js";
import { kitPaths } from "../fmc/context.js";
import { configPath } from "../fmc/policy.js";
import { projectFolderOf } from "../fmc/aiuse.js";
import { batchBoard } from "../fmc/batchline.js";
import { currentClient } from "../fmc/fairqueue.js";
import { currentCaller } from "../fmc/caller.js";

/** The filter engine's arguments on select_by (FILTER_TOOL_SPEC.md 3.1). */
const FILTER_SHAPE = {
  action: z.enum(ACTIONS).optional().describe("preview | run | page | show | export | save_set | sets | delete_set | history | explain"),
  criteria: z.record(z.string(), z.any()).optional().describe("A criteria tree: {all:[...]}, {any:[...]}, {not:...} or a leaf"),
  scope: z.object({
    documents: z.union([z.enum(["target", "all_open"]), z.array(z.string())]).optional(),
    links: z.enum(["host", "links", "both"]).optional(),
    link_names: z.array(z.string()).optional(),
    nested_links: z.boolean().optional(),
    kind: z.enum(["instances", "types", "both"]).optional(),
    universe: z.record(z.string(), z.any()).optional(),
    include_view_specific: z.boolean().optional(),
    family_documents: z.boolean().optional(),
    dedupe: z.enum(["none", "by_unique_id"]).optional(),
  }).optional(),
  invert: z.boolean().optional(),
  missing: z.enum(["report", "no_match", "match"]).optional(),
  fields: z.array(z.string()).optional(),
  params: z.union([z.enum(["key", "all"]), z.array(z.string())]).optional(),
  page_size: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
  result_set: z.string().optional(),
  on_change: z.enum(["fail", "continue"]).optional(),
  allow_stale: z.boolean().optional(),
  show: z.object({ zoom: z.boolean().optional(), max: z.number().int().min(1).max(5000).optional() }).optional(),
  export: z.object({ format: z.enum(["csv", "json"]).optional(), path: z.string().optional(), params: z.union([z.enum(["key", "all"]), z.array(z.string())]).optional() }).optional(),
  set: z.union([z.string(), z.object({ name: z.string(), note: z.string().optional(), overwrite: z.boolean().optional(), share: z.boolean().optional() })]).optional(),
  history_id: z.string().optional(),
};

let tool: FilterTool | undefined;
function filterTool(): FilterTool {
  const deps: FilterDeps = {
    send: (command, params) => withRevitConnection((c) => c.sendCommand(command, params)),
    get config() { return loadConfig().config; },
    caller: () => currentCaller().client,
    client: () => currentClient(),
    leaseHolder: (document) => batchBoard().activeHolder(document),
    kit: () => {
      try {
        const file = path.win32.join(path.win32.dirname(kitPaths(loadConfig(configPath()).config).recipesDir), "FMC_Standards_Building.json");
        const kit = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { standards?: Record<string, unknown> };
        return kit.standards ?? null;
      } catch { return null; }
    },
    projectOf: (docPath) => projectFolderOf(docPath),
  };
  tool ??= new FilterTool(deps);
  return tool;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** A view or a close-up of elements as an image the AI sees (owner 26 Oct: "the MCP tool has to take images"). */
export async function viewImage(params: Record<string, unknown>): Promise<{ image?: Content; facts: any }> {
  const { save_to, ...rest } = params as Record<string, unknown> & { save_to?: string };
  const dir = imageDir(loadConfig().config);
  const facts = await withRevitConnection((c) => c.sendCommand("fmc_view_image", { ...rest, image_dir: dir }));
  const file = String(facts?.file ?? "");
  if (!file || !fs.existsSync(file)) return { facts };
  // A kept picture stays in the image folder. Never beside the model and never on D:.
  const target = keptImagePath(typeof save_to === "string" ? save_to : undefined, dir);
  if (target && path.resolve(target) !== path.resolve(file)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    facts.saved_to = target;
  }
  const data = fs.readFileSync(file).toString("base64");
  return { image: { type: "image", data, mimeType: "image/png" }, facts };
}

/** The ids a modify_model answer made or touched, for its after-picture. */
export function touchedIds(ops: Array<Record<string, any>>, answer: any): number[] {
  const ids = new Set<number>();
  for (const r of answer?.ops ?? []) for (const id of r?.created_ids ?? []) ids.add(Number(id));
  for (const o of ops) for (const id of o?.ids ?? []) if (/^\d+$/.test(String(id))) ids.add(Number(id));
  for (const o of ops) for (const k of ["host", "target", "wall", "id"]) if (/^\d+$/.test(String(o?.[k] ?? ""))) ids.add(Number(o[k]));
  return [...ids].slice(0, 200);
}

export const SEE_VIEW_DESCRIPTION =
  "Formcraft (owner 26 Oct): look at the model. Returns a picture you can see. ids: a 3D close-up around those elements " +
  "with them in red (from: iso, iso_nw, iso_ne, iso_sw, front, back, left, right, top; margin_mm; ghost true greys the " +
  "rest). select: a query in place of ids (modify_model's select: category, level, room, box, near, param...). box: a section box to look into (modify_model's BOX: room, level slice or cut_mm, cut_line_mm, slice, grow_mm, " +
  "top_mm...; with view, it boxes that 3D view, plan or section for this picture only). perspective true: a camera on the box " +
  "(from inside: standing in it at eye height; eye_mm + target_mm place the camera). save_to: a file name kept in the image " +
  "folder (%LOCALAPPDATA%\\Formcraft\\images, or image_dir in fmc_guard.json). Never beside the model and never on D:. " +
  "view: a plan, section, 3D view or sheet by name or id in the document you name " +
  "(with ids, those are highlighted in it). document: title or full path of an open model, including one that is not the " +
  "active window. The picture is fmc_view_image: ExportImage and SetOfViews. Revit can switch the active document " +
  "(a shot of S-0001 has left that model on screen). The previous document and view are restored after the temporary " +
  "transaction rolls back. " +
  "The answer names the document title, the path, and the view. selection true: what the person has selected, only when " +
  "that document is the active window. size: pixels (default 1024; each picture costs tokens, so look when it " +
  "matters: after every batch, and at problems model_check finds). A read: allowed while a batch lease is held. Nothing in the model changes.";

export function registerSeeViewTool(server: McpServer) {
  server.tool(
    "see_view",
    SEE_VIEW_DESCRIPTION,
    {
      ids: z.array(z.union([z.number(), z.string()])).max(500).optional(),
      select: z.record(z.string(), z.any()).optional(),
      view: z.string().optional(),
      selection: z.boolean().optional(),
      from: z.enum(["iso", "iso_nw", "iso_ne", "iso_sw", "front", "back", "left", "right", "top", "inside"]).optional(),
      box: z.record(z.string(), z.any()).optional(),
      perspective: z.boolean().optional(),
      eye_mm: z.array(z.number()).min(2).max(3).optional(),
      target_mm: z.array(z.number()).min(2).max(3).optional(),
      save_to: z.string().optional(),
      margin_mm: z.number().optional(),
      ghost: z.boolean().optional(),
      style: z.enum(["shaded", "hidden"]).optional(),
      size: z.number().int().min(400).max(2400).optional(),
    },
    async (args) => {
      try {
        const { image, facts } = await viewImage(args);
        const content: Content[] = [{ type: "text", text: JSON.stringify(facts, null, 2) }];
        if (image) content.unshift(image);
        return { content };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `see_view: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "select_by",
    "Formcraft, read-only: find elements. Flat keys (as modify_model's select takes): category (Walls or OST_Walls, or a " +
      "list), level, type_name and family (part of the name), comment, mark, workset, phase, view (\"active\"), room, box, " +
      "box_mm [[x, y, z?], [x, y, z?]], near {id | point_mm, within_mm}, hosted_by, host_of, param {name, is: " +
      "equals|contains|starts|gt|lt|empty|not_empty, value} (or a list), exclude, not {query}, types true; alone they give " +
      "the count by category, the ids (up to limit) and the first 100 rows, as before. " +
      "The filter engine (build plan item 32) with action: preview (counts only, a result_set, no rows), run (counts + first " +
      "page + cursor), page (cursor: follow it until null), explain (the compiled plan), show (put a result_set or ids into " +
      "Revit's selection: active document only, max 2000 (5000), refused while another bot holds the lease), export (CSV or " +
      "JSON of every parameter, into the reports folder or a write_roots path), save_set / sets / delete_set (named queries, " +
      "shared read-only with other bots through the project's 01_WIP\\_Exchange), history. criteria is a tree: {all:[...]}, " +
      "{any:[...]}, {not: node}, leaves {category}, {class}, {family, match}, {type, match}, {type_id}, {ids}, {level}, " +
      "{workset}, {phase_created}, {design_option}, {view}, {param|bip|guid, of: instance|type|either, op: = != > >= < <= " +
      "contains starts ends empty not_empty in between, value, unit}, {in_room: {room, mode: center|any_point|solid, z}}, " +
      "{in_boundary: {polygon_mm, level | z_mm, mode}}, {in_box: {min_mm, max_mm, inside}}, {near}, {hosted_by}, {host_of}, " +
      "{tagged_in_view, is}. Lengths in mm, areas m2, volumes m3, angles degrees. scope: documents target|all_open|[names] " +
      "(rows tagged with their doc), links host|links|both, link_names, kind instances|types|both, universe (for invert). " +
      "invert: the universe minus the matches. An element missing a criterion parameter is undetermined (listed with its " +
      "reason), never a silent no-match; every skip is listed with a reason. Preview before a big read; say \"no elements\" " +
      "when total is 0; report undetermined and skipped counts.",
    {
      category: z.union([z.string(), z.array(z.string())]).optional(), level: z.string().optional(), type_name: z.string().optional(), family: z.string().optional(),
      comment: z.string().optional(), mark: z.string().optional(), workset: z.string().optional(), phase: z.string().optional(),
      box_mm: z.array(z.array(z.number()).min(2).max(3)).length(2).optional(), view: z.string().optional(),
      room: z.union([z.string(), z.number()]).optional(), box: z.record(z.string(), z.any()).optional(),
      near: z.object({ id: z.union([z.string(), z.number()]).optional(), point_mm: z.array(z.number()).min(2).max(3).optional(), within_mm: z.number().optional() }).optional(),
      hosted_by: z.union([z.string(), z.number()]).optional(), host_of: z.union([z.string(), z.number()]).optional(),
      param: z.union([z.record(z.string(), z.any()), z.array(z.record(z.string(), z.any()))]).optional(),
      exclude: z.array(z.union([z.string(), z.number()])).optional(), not: z.record(z.string(), z.any()).optional(),
      ids: z.array(z.union([z.string(), z.number()])).optional(), types: z.boolean().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      ...FILTER_SHAPE,
    },
    async (args) => {
      try {
        if (isEngineCall(args as Record<string, unknown>)) {
          const r = await filterTool().run(args as Record<string, unknown>);
          return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }], ...(r.ok === false ? { isError: true } : {}) };
        }
        const r = await withRevitConnection((c) => c.sendCommand("fmc_select_by", args));
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `select_by: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "model_check",
    "Formcraft (owner 26 Oct): what is wrong in the model, in words and ids, read-only. checks (default all): " +
      "revit_warnings (Revit's own, grouped), duplicates (same category and type in the same place; keep says which to " +
      "keep), rooms (not placed, not enclosed, numbers used twice), unhosted (doors and windows without a wall), " +
      "wall_overlaps, free_wall_ends, wall_tops (walls stopping below a roof, not attached), clashes (structure, MEP, " +
      "furniture, stairs against the rest), blind_openings (doors and windows that don't cut their wall). level limits it to one level; limit the items per check (default 50). Then " +
      "look at a problem with see_view ids [...] and fix it with modify_model.",
    {
      checks: z.array(z.enum(["revit_warnings", "duplicates", "rooms", "unhosted", "wall_overlaps", "free_wall_ends", "wall_tops", "clashes", "blind_openings"])).optional(),
      level: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async (args) => {
      try {
        const r = await withRevitConnection((c) => c.sendCommand("fmc_model_check", args));
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `model_check: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );

  server.tool(
    "material_report",
    "Formcraft (owner 27 Oct, a slow model), read-only: what makes the model heavy to draw. Materials with their texture " +
      "files (found or missing, pixels, MB), model surface patterns, unused and duplicate materials, unused render " +
      "appearances, views in Realistic, the heaviest families (faces and mesh triangles x instances), CAD imports, and " +
      "advice in words. textures false skips reading the files, families false the families; limit per list (default 40). " +
      "Then modify_model display_mode navigate | render switches the views; purge clears the unused.",
    {
      textures: z.boolean().optional(), families: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional(),
    },
    async (args) => {
      try {
        const r = await withRevitConnection((c) => c.sendCommand("fmc_material_report", args));
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `material_report: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );
}
