import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import type { RoomRead } from "./casework_place.js";
import { FMC_CASEWORK_SHAPE } from "./casework_shape.js";
import type { CaseworkIo, RevitSend } from "./casework_tool.js";
import { runFmcCasework } from "../tools/fmc_casework.js";

/** Shared by the casework tool tests (not a test itself): a kit in a temp folder, a stand-in Revit, the example kitchen. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIX = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../src/fmc/fixtures/cw_kitchen.json"), "utf8"));

export interface Kit { root: string; project: string; folder: string; store: string; log: string; config: { config: GuardConfig; problem: string } }

/** A kit with standards (revision "r7"), family and sheet registers, master data and the sheets rulebook; the project folder is the only write root. */
export function kit(standards: unknown = { revision: "r7", ...FIX.standards }): Kit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-cwkit-"));
  const md = path.join(root, "03_Master_Data");
  fs.mkdirSync(path.join(md, "FMC_Rulebook"), { recursive: true });
  fs.mkdirSync(path.join(root, "07_Materials"), { recursive: true });
  fs.writeFileSync(path.join(md, "FMC_Family_Specs.json"), "{}");
  fs.writeFileSync(path.join(root, "07_Materials", "FMC_Materials.json"), JSON.stringify({ materials: [] }));
  if (standards) fs.writeFileSync(path.join(md, "FMC_Casework_Standards.json"), JSON.stringify(standards));
  fs.writeFileSync(path.join(md, "FMC_Sheet_Register.csv"), [
    "Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed",
    "I,Interior Design,I-4001,Joinery: Kitchen,4xxx Enlarged plans and details,1:20,Core,TENDER+CONSTRUCTION,VT_I_Joinery",
    "I,Interior Design,I-5002,Joinery Cut List,5xxx Schedules,NTS,Optional,CONSTRUCTION,I11_Joinery_Cutlist",
  ].join("\n"));
  fs.writeFileSync(path.join(md, "FMC_Family_Register.csv"), [
    "Family,Category,Types,KeyParameters",
    "FMC_I_Casework_KitchenUnit,Casework,\"Base,Wall,Tall,Corner,Sink\",Width",
  ].join("\n"));
  fs.writeFileSync(path.join(md, "FMC_Master_Data.json"), JSON.stringify({ shared_parameters: [] }));
  fs.writeFileSync(path.join(md, "FMC_Rulebook", "FMC_Rulebook_Sheets.json"), JSON.stringify({ rules: [
    { id: "SHT-011", check: { params: { family: "FMC_TitleBlock", types: ["A0", "A1", "A3"] } } },
    { id: "SHT-013", check: { params: { margin_left_mm: 20, margin_other_mm: 10 } } },
    { id: "SHT-014", check: { params: { drawing_area_mm: [681, 574] } } },
    { id: "SHT-017", check: { params: { a3_scale: 0.5 } } },
  ] }));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const reports = path.join(root, "reports");
  const config: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [project], reports_dir: reports, specs_path: path.join(md, "FMC_Family_Specs.json"),
    rulebooks_dir: path.join(md, "FMC_Rulebook"), materials_file: path.join(root, "07_Materials", "FMC_Materials.json") };
  return { root, project, folder: path.join(project, "01_WIP", "_Casework"), store: path.join(root, "runs"),
    log: path.join(reports, "FMC_MCP_FileLog.csv"), config: { config, problem: "" } };
}

export const done = (k: Kit) => fs.rmSync(k.root, { recursive: true, force: true });
export const parse = (args: Record<string, unknown>) => z.object(FMC_CASEWORK_SHAPE).parse(args);

/** Calls the tool with the kit's config and store, and a stand-in Revit (none: any Revit call fails the test). */
export async function call(k: Kit, args: Record<string, unknown>, revit?: RevitSend, io: CaseworkIo = {}) {
  const r = await runFmcCasework(parse(args), { config: k.config, store: k.store, revit: revit ?? (async (c) => { throw new Error(`no Revit in this test (${c})`); }), ...io });
  return { body: JSON.parse(r.content[0].text), isError: r.isError };
}

/** Records every Revit call; answers from the given table (command → reply or function). */
export function fakeRevit(answers: Record<string, unknown | ((payload: any, dry: boolean) => unknown)>) {
  const calls: Array<{ command: string; payload: any; dry: boolean }> = [];
  const send: RevitSend = async (command, payload, dry) => {
    calls.push({ command, payload, dry });
    const a = answers[command];
    if (a === undefined) throw new Error(`no answer for ${command}`);
    return typeof a === "function" ? (a as (p: any, d: boolean) => unknown)(payload, dry) : a;
  };
  return { send, calls };
}

/** A 3600 × 3000 room read anticlockwise; wall 1 has the window, wall 3 the door (as in casework_place.test). */
export const ROOM: RoomRead = {
  room: { number: "G05", name: "Kitchen", level: "Ground" },
  walls: [
    { start: [0, 0], end: [3600, 0], wall_id: 11 }, { start: [3600, 0], end: [3600, 3000], wall_id: 12 },
    { start: [3600, 3000], end: [0, 3000], wall_id: 13 }, { start: [0, 3000], end: [0, 0], wall_id: 14 },
  ],
  openings: [
    { kind: "window", wall_id: 11, at: [1800, -115], width: 1200, sill: 850 },
    { kind: "door", wall_id: 13, at: [900, 3115], width: 900 },
  ],
  points: [
    { category: "Plumbing Fixtures", family: "FMC_P_PlumbFix_WastePoint", type: "40 mm", at: [2000, 60, 400] },
    { category: "Electrical Fixtures", family: "FMC_E_ElecFix_SocketDouble", type: "13 A", at: [3200, 30, 1100] },
  ],
};
