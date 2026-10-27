import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkWritePath, expandEnv, loadConfig } from "../fmc/policy.js";
import { exchangeRoot } from "../hub/exchange.js";
import { RENDER_SCRIPT, STATUS_SCRIPT, blenderRun, resultOf, withValues } from "../hub/blender.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const win = path.win32;

export const RENDER_IN_BLENDER_DESCRIPTION =
  "Formcraft engineering hub: Blender (owner 27 Oct: renders better than Revit's). render: Revit exports a 3D view " +
    "(view, default {3D}; a section box limits it) as OBJ with each face's Revit material, then the open Blender (with the MCP add-on started) builds a new " +
    "scene from it: Revit's materials become Formcraft Blender materials by name (glass, metal, wood, brick, concrete, " +
    "stone, tile, grass, water, fabric, paint...) coloured from Revit, sky and sun, a ground plane, a camera (aerial_front " +
    "by default: from the south, looking north; aerial_back|aerial_left|aerial_right|front|revit_view; elevation_deg, " +
    "azimuth_deg, lens_mm), and renders with Cycles on the GPU, denoised. Files only in <project>\\01_WIP\\_Exchange\\Renders " +
    "(or <reports>\\Exchange\\Renders): the OBJ, its facts, the PNG and a .blend copy. Gives back the picture. dry_run says " +
    "where it would write. status: Blender's version, scenes and GPU. The person's own Blender scenes are left alone.";

export const RENDER_IN_BLENDER_SHAPE = {
  action: z.enum(["render", "status"]).optional().default("render"),
  view: z.string().optional().describe("The Revit 3D view (name or id); default {3D}"),
  camera: z.enum(["aerial_front", "aerial_back", "aerial_left", "aerial_right", "front", "revit_view"]).optional().default("aerial_front"),
  elevation_deg: z.number().min(-10).max(89).optional(), azimuth_deg: z.number().min(-180).max(180).optional().default(0),
  lens_mm: z.number().min(10).max(200).optional().default(35),
  detail: z.number().int().min(0).max(15).optional().describe("Revit's tessellation, 0-15 (lower = fewer triangles, a smaller file; default 6 for aerial cameras, Revit's own for the rest)"),
  samples: z.number().int().min(8).max(4096).optional().default(128),
  width: z.number().int().min(160).max(7680).optional().default(1600), height: z.number().int().min(90).max(4320).optional().default(900),
  ground: z.boolean().optional().default(true),
  sun_elevation_deg: z.number().min(0).max(90).optional().default(40), sun_azimuth_deg: z.number().min(-360).max(360).optional().default(135),
  save_blend: z.boolean().optional().default(true),
  project_folder: z.string().optional().default("").describe("The project whose 01_WIP\\_Exchange keeps the renders (default <reports>\\Exchange)"),
  dry_run: z.boolean().optional().default(true),
};

type Args = z.infer<z.ZodObject<typeof RENDER_IN_BLENDER_SHAPE>>;
const text = (body: object, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });
const safe = (s: string) => s.replace(/[^A-Za-z0-9 _-]+/g, "_").trim().replace(/\s+/g, "_").slice(0, 60) || "view";

/** Where a render's files go: <exchange>\Renders\<stamp>_<view>. */
export function renderFolder(projectFolder: string, reportsDir: string, view: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return win.join(exchangeRoot(projectFolder ? expandEnv(projectFolder) : undefined, expandEnv(reportsDir)), "Renders", `${stamp}_${safe(view)}`);
}

export async function renderInBlender(args: Args) {
  if (args.action === "status") return text(resultOf(await blenderRun(withValues(STATUS_SCRIPT, {}), 60000)));
  const { config } = loadConfig();
  const view = args.view ?? "{3D}";
  const folder = renderFolder(args.project_folder, config.reports_dir, view);
  const verdict = checkWritePath(win.join(folder, "render.png"), config, { checkName: false });
  if (!verdict.ok) return text({ refused: verdict.reasons }, true);
  const plan = { folder, files: ["scene.obj", "scene.mtl", "scene.json", "render.png", ...(args.save_blend ? ["scene.blend"] : [])], view, camera: args.camera, samples: args.samples, size: `${args.width} x ${args.height}` };
  if (args.dry_run) return text({ dry_run: true, would: plan, then: "run again with dry_run false" });

  // Blender first, so a closed Blender doesn't cost a Revit export
  const status = resultOf(await blenderRun(withValues(STATUS_SCRIPT, {}), 60000));
  const exported = await withRevitConnection((c) => c.sendCommand("fmc_scene_export", { view: args.view, folder, name: "scene", format: "obj", detail: args.detail ?? (args.camera.startsWith("aerial") ? 6 : undefined) }, 900000));
  const png = win.join(folder, "render.png");
  const job = {
    obj: exported.obj ?? win.join(folder, "scene.obj"), json: win.join(folder, "scene.json"), scene: `FMC ${exported.model ?? "Revit"} - ${exported.view ?? view}`.slice(0, 60),
    out: png, blend: args.save_blend ? win.join(folder, "scene.blend") : "", samples: args.samples, width: args.width, height: args.height,
    camera: args.camera, elevation_deg: args.elevation_deg, azimuth_deg: args.azimuth_deg, lens_mm: args.lens_mm, ground: args.ground,
    sun_elevation_deg: args.sun_elevation_deg, sun_azimuth_deg: args.sun_azimuth_deg,
  };
  const done = resultOf(await blenderRun(withValues(RENDER_SCRIPT, job)));
  const facts = { revit: exported, blender: { ...done, gpu: status.gpu }, folder };
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: JSON.stringify(facts, null, 2) }];
  if (fs.existsSync(png)) content.unshift({ type: "image", data: fs.readFileSync(png).toString("base64"), mimeType: "image/png" });
  return { content };
}

export function registerFmcBlenderTool(server: McpServer) {
  server.tool("render_in_blender", RENDER_IN_BLENDER_DESCRIPTION, RENDER_IN_BLENDER_SHAPE, async (args) => {
    try { return await renderInBlender(args as Args); }
    catch (e) { return text({ error: e instanceof Error ? e.message : String(e) }, true); }
  });
}
