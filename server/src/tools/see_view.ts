import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { checkWritePath, loadConfig } from "../fmc/policy.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** A view or a close-up of elements as an image the AI sees (owner 26 Oct: "the MCP tool has to take images"). */
export async function viewImage(params: Record<string, unknown>): Promise<{ image?: Content; facts: any }> {
  const { save_to, ...rest } = params as Record<string, unknown> & { save_to?: string };
  const facts = await withRevitConnection((c) => c.sendCommand("fmc_view_image", rest));
  const file = String(facts?.file ?? "");
  if (!file || !fs.existsSync(file)) return { facts };
  // owner 27 Oct: a picture kept as a file too (a perspective for the person, a record of a detail)
  if (save_to) {
    const target = /\.png$/i.test(save_to) ? save_to : path.join(save_to, path.basename(file));
    // the hard rule: files go only to WIP and staging folders
    const v = checkWritePath(target, loadConfig().config, { checkName: false });
    if (!v.ok) throw new Error(`save_to refused: ${v.reasons.join("; ")}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    facts.saved_to = target;
  }
  const data = fs.readFileSync(file).toString("base64");
  try { fs.unlinkSync(file); } catch { /* temp folder is cleaned anyway */ }
  return { image: { type: "image", data, mimeType: "image/png" }, facts: { ...facts, file: undefined } };
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
  "(from inside: standing in it at eye height; eye_mm + target_mm place the camera). save_to: a folder or .png path to keep the " +
  "picture (a WIP or staging folder). view: a plan, section, 3D view or sheet by name or id (with ids, those are highlighted in it). selection true: " +
  "what the person has selected in Revit. size: pixels (default 1024; each picture costs tokens, so look when it " +
  "matters: after geometry changes, and at problems model_check finds). Nothing in the model changes.";

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
    "Formcraft (Ogala report), read-only: find elements with the same query modify_model's select takes: category (Walls " +
      "or OST_Walls, or a list), level, type_name and family (part of the name), comment (contains), mark, workset, phase " +
      "(created), view (visible in it; \"active\"), room (inside it), box (a section-box spec, inside? true), box_mm " +
      "[[x, y, z?], [x, y, z?]] (anything touching it), near {id | point_mm, within_mm}, hosted_by, host_of, param {name, " +
      "is: equals|contains|starts|gt|lt|empty|not_empty, value} (or a list), exclude, not {query}, types true; combine them. " +
      "Gives the count by category, the ids (up to limit, default 500) and the first 100 with type and level. Try a query " +
      "here before an edit uses it as select.",
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
    },
    async (args) => {
      try {
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
