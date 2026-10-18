/**
 * The hub's Rhino connector (docs/PLAN_ENGINEERING_HUB.md, H1): the client for the Formcraft bridge inside Rhino 8
 * (connectors/rhino), and the check rules for family parts. One JSON request per line to 127.0.0.1:<port>, one JSON
 * reply per line; the bridge writes its port to %APPDATA%\Formcraft\apps\rhino.json.
 *
 * The bridge only reports facts about each part (closed, manifold, shortest edge, size, mesh weight); the rules that
 * decide whether a part may go into a Revit family live here, so CI tests them without Rhino.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";

export interface RhinoState { port: number; pid: number; started: string; rhino?: string; bridge?: string }

export function rhinoStateFile(): string {
  return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"), "Formcraft", "apps", "rhino.json");
}

export function readRhinoState(file = rhinoStateFile()): RhinoState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return Number.isInteger(s.port) && s.port > 0 ? s : null;
  } catch {
    return null;
  }
}

let nextId = 1;

/** One request to the bridge; rejects with the bridge's error text, or when Rhino doesn't answer in time. */
export function rhinoCall(port: number, method: string, params: object = {}, timeoutMs = 300000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const sock = net.connect({ host: "127.0.0.1", port });
    let buf = "";
    const done = (fn: () => void) => { clearTimeout(timer); sock.destroy(); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error(`Rhino didn't answer ${method} within ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        if (reply.error) done(() => reject(new Error(String(reply.error))));
        else done(() => resolve((reply.result ?? {}) as Record<string, any>));
      } catch {
        done(() => reject(new Error("The Rhino bridge's reply isn't JSON")));
      }
    });
    sock.on("error", (e) => done(() => reject(new Error(`Can't reach the Formcraft bridge in Rhino on port ${port}: ${e.message}`))));
  });
}

/** The parts vocabulary (the bridge checks each operation's values; this checks the shape before anything is sent). */
export const RHINO_OPS = ["box_rounded", "extrude", "revolve", "pipe", "loft", "torus", "sphere", "shell", "boolean", "fillet",
  "extrude_points", "revolve_loop", "sweep_path"] as const;
export const VISIBILITY = ["fine", "medium_fine", "all"] as const;

export const RHINO_PART = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "a part name is letters, digits and _ (it becomes the layer and the Revit form's name)"),
  op: z.enum(RHINO_OPS),
  subcategory: z.string().optional(),
  material: z.string().optional(),
  visibility: z.enum(VISIBILITY).optional(),
}).passthrough();
export type RhinoPart = z.infer<typeof RHINO_PART>;

/** What the bridge reports for one part. */
export interface PartFacts {
  name: string; op: string; subcategory: string; material: string; visibility: string;
  closed: boolean; manifold: boolean; valid: boolean;
  faces: number; edges: number; min_edge_mm: number;
  bbox_min: number[]; bbox_max: number[]; volume_mm3: number; mesh_faces: number;
  file?: string; bytes?: number;
}

/** Revit's short-curve tolerance is 0.00256 ft (0.78 mm); a part edge stays at 1 mm or more so it imports cleanly. */
export const MIN_PART_EDGE_MM = 1;
/** Above this many render-mesh faces in one family the 8 MB family budget is at risk. */
export const MESH_FACES_WARN = 150000;
export const FAMILY_BYTES_LIMIT = 8 * 1024 * 1024;
export const WARN = "warning:";

export function partSize(f: PartFacts): number[] {
  return [0, 1, 2].map((i) => Math.round(((f.bbox_max?.[i] ?? 0) - (f.bbox_min?.[i] ?? 0)) * 100) / 100);
}

/**
 * The check (docs/handoff/DETAILED_FAMILIES_RHINO.md, step 1, and Gate A for imported forms): every part a closed,
 * manifold, valid solid; no edge under 1 mm; on a subcategory with a material; within the type's envelope
 * (width, depth, height in mm) when one is given; and the family's mesh weight within budget. Errors stop the part
 * going to Revit; lines that start with "warning:" don't.
 */
export function partProblems(facts: PartFacts[], envelope?: number[]): string[] {
  const out: string[] = [];
  if (facts.length === 0) out.push("No parts: build them with action part first");
  for (const f of facts) {
    if (!f.closed) out.push(`${f.name}: not a closed solid (Revit makes a form only from a closed solid)`);
    if (!f.manifold) out.push(`${f.name}: not manifold (an edge is shared by more than two faces)`);
    if (!f.valid) out.push(`${f.name}: Rhino reports the solid as not valid`);
    if (f.edges > 0 && f.min_edge_mm < MIN_PART_EDGE_MM)
      out.push(`${f.name}: an edge of ${f.min_edge_mm} mm is under the ${MIN_PART_EDGE_MM} mm floor (Revit drops edges under 0.78 mm): use a larger fillet or none`);
    if (!f.subcategory) out.push(`${f.name}: no subcategory (Gate A: every imported form is on a subcategory)`);
    if (!f.material) out.push(`${f.name}: no material (Gate A: every imported form has a material)`);
    if (!(VISIBILITY as readonly string[]).includes(f.visibility)) out.push(`${f.name}: visibility is fine, medium_fine or all, not ${f.visibility}`);
    if (envelope && envelope.length === 3) {
      const size = partSize(f);
      const over = size.map((s, i) => (s > envelope[i] + 0.01 ? `${"XYZ"[i]} ${s} > ${envelope[i]}` : "")).filter(Boolean);
      if (over.length) out.push(`${f.name}: larger than the type's envelope (${over.join(", ")} mm)`);
    }
  }
  const mesh = facts.reduce((n, f) => n + (f.mesh_faces || 0), 0);
  if (mesh > MESH_FACES_WARN) out.push(`${WARN} ${mesh} render-mesh faces in all: the family may pass 8 MB; simplify the busiest parts`);
  const bytes = facts.reduce((n, f) => n + (f.bytes || 0), 0);
  if (bytes > FAMILY_BYTES_LIMIT * 0.75) out.push(`${WARN} the part files weigh ${(bytes / 1048576).toFixed(1)} MB: close to the 8 MB family limit`);
  return out;
}

export const isError = (p: string) => !p.startsWith(WARN);

/** A Formcraft family name (kit naming: FMC_<role letter>_…). */
export function familyNameProblem(name: string): string | null {
  return /^FMC_[A-Z]{1,2}_[A-Za-z0-9_]+$/.test(name) ? null : `"${name}" isn't a kit family name (FMC_<role>_<Category>_…)`;
}

/** Where a family's Rhino files go: <family_staging_root>\_Rhino. */
export function rhinoPaths(stagingRoot: string, family: string, view = "iso") {
  const dir = path.win32.join(stagingRoot, "_Rhino");
  return {
    dir,
    model: path.win32.join(dir, `${family}.3dm`),
    parts: path.win32.join(dir, family),
    manifest: path.win32.join(dir, family, "parts.json"),
    render: path.win32.join(dir, view === "iso" ? `${family}_3d.png` : `${family}_3d_${view}.png`),
  };
}
