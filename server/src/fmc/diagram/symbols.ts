import fs from "node:fs";
import path from "node:path";
import { DIAGRAM_KINDS, DiagramKind, PARAM_KEYS, ParamKey, ScanEdge, ScanNode } from "./contract.js";

/**
 * Line diagrams (LD2-LD4): which kit symbol draws which scanned node, and the drawing styles.
 *
 * Rule 7: this is kit data. DEFAULT_DIAGRAM_KIT is the default; the kit can replace any part of it with
 * <kit>/03_Master_Data/FMC_Diagram_Symbols.json (the same shape; tests/fixtures/FMC_Diagram_Symbols.json is this default,
 * ready to copy into the kit). A node no rule matches is never given a guessed symbol: it is drawn as a plain box with
 * its name, and a warning asks for a kit rule.
 */

const win = path.win32;

export interface SymbolRule {
  /** Node kinds this rule covers; an empty list covers every kind. */
  kinds: string[];
  /** Only in these diagrams (all when absent). */
  diagrams?: DiagramKind[];
  /** Case-insensitive regular expression tested on "category family type name part-type" of the node. */
  match?: string;
  /** The kit symbol (a detail item family and type). Absent only with `drawn`. */
  family?: string;
  type?: string;
  /** Drawn with lines and text, no symbol: "supply" (the incoming supply), "spine" (a riser or stack drawn as the riser line). */
  drawn?: "supply" | "spine";
  /** Legend text. */
  label: string;
  /** Riser column for ELV (one backbone per system). */
  group?: string;
  /** Drawn in the base row (the panel, NVR or energiser at the foot of a riser). */
  base?: boolean;
  /** true: counted per level ("×12"); false: drawn one by one. Absent: the layout's default for the node kind. */
  counted?: boolean;
  /** A generic symbol (FMC_DI_P_Schematic): counts are split by the model's type name, which is printed beside it. */
  generic?: boolean;
}

export interface BreakerRule { match: string; type: string; label: string }

export interface DiagramStyle {
  /** Symbol centres and line vertices sit on this grid (paper mm). */
  grid_mm: number;
  text: { label: string; title: string };
  /** Text type -> height in paper mm (a text type not listed: the first number in its name). */
  text_height_mm: Record<string, number>;
  /** Conservative character width as a fraction of the text height (the collision check's text box). */
  char_width: number;
  /** Distance between lines as a fraction of the text height. */
  line_pitch: number;
  lines: { thin: string; medium: string; wide: string; dashed: string | null };
  /** View scale for the drafting views (paper mm × scale = model mm). */
  scale: number;
}

export interface DiagramLayoutConfig {
  sld_way_pitch_mm: number;
  sld_max_ways: number;
  band_min_height_mm: number;
  tree_row_mm: number;
  /** Node parameters printed under a node drawn one by one, when the node has them (null prints TBC). */
  label_params: string[];
  /** View name prefix per diagram kind; SLDs add the board name. */
  view_names: Record<DiagramKind, string>;
}

export interface DiagramKit {
  version: string;
  styles: DiagramStyle;
  layout: DiagramLayoutConfig;
  breaker_family: string;
  /** Used when the model doesn't say what the protective device is: the label then says "type TBC". */
  breaker_default: string;
  breakers: BreakerRule[];
  symbols: SymbolRule[];
  /** Symbol box in paper mm, [width, height], centred on the insertion point: "family:type", then "family", then "*". */
  sizes: Record<string, number[]>;
  /** The plain box drawn for a node with no kit symbol, [width, height]. */
  box: number[];
}

const S = (kinds: string[], family: string, label: string, extra: Partial<SymbolRule> = {}): SymbolRule =>
  ({ kinds, family, type: "Standard", label, ...extra });

export const DEFAULT_DIAGRAM_KIT: DiagramKit = {
  version: "1.0",
  styles: {
    grid_mm: 5,
    text: { label: "FMC_Arial_2.5", title: "FMC_Arial_3.5_Bold" },
    text_height_mm: { "FMC_Arial_2.5": 2.5, "FMC_Arial_3.5_Bold": 3.5 },
    char_width: 0.8,
    line_pitch: 1.7,
    lines: { thin: "FMC_Thin", medium: "FMC_Medium", wide: "FMC_Wide", dashed: null },
    scale: 50,
  },
  layout: {
    sld_way_pitch_mm: 20,
    sld_max_ways: 24,
    band_min_height_mm: 25,
    tree_row_mm: 35,
    label_params: ["size", "rating", "capacity", "resistance"],
    view_names: {
      e_sld: "E-SLD", e_power_riser: "E-Power-Riser", e_fa_riser: "E-FA-Riser", e_elv_riser: "E-ELV-Riser", fp_schematic: "FP-Schematic",
      p_water: "P-Water-Schematic", p_drainage: "P-Drainage-Schematic", m_refrigerant: "M-Refrigerant-Schematic",
      lp_schematic: "LP-Schematic",
    },
  },
  breaker_family: "FMC_DI_E_SLD_Breaker",
  breaker_default: "MCB",
  breakers: [
    { match: "\\bacb\\b|air circuit", type: "ACB", label: "Air circuit breaker (ACB)" },
    { match: "mccb|moulded case|molded case", type: "MCCB", label: "Moulded-case circuit breaker (MCCB)" },
    { match: "rcbo|\\brcd\\b|rccb|residual", type: "RCD", label: "Residual current device (RCD)" },
    { match: "\\bmcb\\b|miniature", type: "MCB", label: "Miniature circuit breaker (MCB)" },
  ],
  symbols: [
    // Electrical single-line (BS 7671 practice, IEC 60617)
    { kinds: ["supply"], drawn: "supply", label: "Incoming supply" },
    { kinds: ["board", "panel", "equipment"], diagrams: ["e_sld", "e_power_riser"], match: "\\bats\\b|transfer", family: "FMC_DI_E_SLD_Board", type: "ATS", label: "Automatic transfer switch (ATS)" },
    { kinds: ["meter"], diagrams: ["e_sld", "e_power_riser"], family: "FMC_DI_E_SLD_Board", type: "Meter", label: "Meter" },
    { kinds: ["board", "panel", "equipment"], diagrams: ["e_sld", "e_power_riser"], match: "meter", family: "FMC_DI_E_SLD_Board", type: "Meter", label: "Meter" },
    { kinds: ["board", "panel"], diagrams: ["e_sld", "e_power_riser"], match: "\\bmdb\\b|\\bmsb\\b|main ?(distribution|switch)|switchboard", family: "FMC_DI_E_SLD_Board", type: "MDB", label: "Main distribution board (MDB)" },
    { kinds: ["board", "panel"], diagrams: ["e_sld", "e_power_riser"], match: "\\bcu\\b|consumer", family: "FMC_DI_E_SLD_Board", type: "CU", label: "Consumer unit (CU)" },
    { kinds: ["board", "panel"], diagrams: ["e_sld", "e_power_riser"], family: "FMC_DI_E_SLD_Board", type: "DB", label: "Distribution board (DB)" },
    // Fire alarm (BS 5839)
    S(["panel", "equipment", "board", "device"], "FMC_SYM_E_FireAlarmPanel", "Fire alarm control panel", { match: "fire ?alarm ?(control )?panel|\\bfacp\\b|\\bcie\\b|fire ?panel", base: true }),
    S(["device", "equipment"], "FMC_SYM_E_LoopIsolator", "Loop isolator", { match: "isolator" }),
    S(["device", "equipment"], "FMC_SYM_E_InterfaceModule", "Interface module", { match: "interface|\\bmodule\\b|input.?output" }),
    S(["device"], "FMC_SYM_E_SmokeDetector", "Smoke detector", { match: "smoke|optical|ionisation|multi.?sensor" }),
    S(["device"], "FMC_SYM_E_HeatDetector", "Heat detector", { match: "heat|thermal|rate.?of.?rise" }),
    S(["device"], "FMC_SYM_E_ManualCallPoint", "Manual call point", { match: "manual ?call|\\bmcp\\b|break ?glass|call ?point" }),
    S(["device"], "FMC_SYM_E_VisualAlarmDeviceBeacon", "Visual alarm device (beacon)", { match: "beacon|\\bvad\\b|visual|strobe" }),
    S(["device"], "FMC_SYM_E_Sounder", "Sounder", { match: "sounder|\\bbell\\b|horn|siren" }),
    S(["device", "equipment", "valve"], "FMC_SYM_FP_FlowSwitch", "Flow switch", { match: "flow ?switch" }),
    // ELV and security
    S(["panel", "equipment", "device"], "FMC_SYM_E_NVR", "Network video recorder (NVR)", { match: "\\bnvr\\b|video ?recorder", base: true, group: "CCTV" }),
    S(["panel", "equipment", "device"], "FMC_SYM_E_ElectricFenceEnergiser", "Electric fence energiser", { match: "energi[sz]er", base: true, group: "Electric fence" }),
    S(["device", "equipment"], "FMC_SYM_E_FenceZone", "Electric fence zone", { match: "fence", group: "Electric fence" }),
    S(["device"], "FMC_SYM_E_CCTVCamera", "CCTV camera", { match: "cctv|camera", group: "CCTV" }),
    S(["device"], "FMC_SYM_E_WirelessAccessPoint", "Wireless access point", { match: "access ?point|\\bwap\\b|wi ?fi|wireless", group: "Data and TV" }),
    S(["device"], "FMC_SYM_E_AccessReader", "Access control reader", { match: "reader|keypad|biometric", group: "Access control" }),
    S(["device"], "FMC_SYM_E_DoorRelease", "Door release", { match: "door ?release|maglock|mag ?lock|electric ?strike", group: "Access control" }),
    S(["device"], "FMC_SYM_E_Intercom", "Intercom", { match: "intercom|door ?entry|video ?entry", group: "Intercom" }),
    S(["device"], "FMC_SYM_E_TVCoaxialOutlet", "TV coaxial outlet", { match: "\\btv\\b|coax|television", group: "Data and TV" }),
    S(["device"], "FMC_SYM_E_DataOutlet", "Data outlet", { match: "data|rj ?45|network", group: "Data and TV" }),
    // Fire fighting (BS EN 12845)
    S(["pump"], "FMC_SYM_FP_JockeyPump", "Jockey pump", { match: "jockey|pressure ?maint" }),
    S(["pump"], "FMC_SYM_FP_FirePump", "Fire pump", { diagrams: ["fp_schematic"] }),
    S(["tank"], "FMC_SYM_FP_FireWaterTank", "Fire water tank", { diagrams: ["fp_schematic"] }),
    S(["valve", "equipment"], "FMC_SYM_FP_AlarmValveSet", "Alarm valve set", { match: "alarm ?valve|installation ?valve|control ?valve ?set" }),
    S(["valve", "fixture", "equipment"], "FMC_SYM_FP_LandingValveRiserOutlet", "Landing valve (riser outlet)", { match: "landing ?valve|riser ?outlet", counted: true }),
    S(["valve"], "FMC_SYM_FP_DrainTestValve", "Drain and test valve", { diagrams: ["fp_schematic"], match: "drain|test" }),
    S(["valve"], "FMC_SYM_FP_CheckValve", "Check valve", { diagrams: ["fp_schematic"], match: "check|non.?return|\\bnrv\\b" }),
    S(["valve"], "FMC_SYM_FP_GateValve", "Gate valve", { diagrams: ["fp_schematic"], match: "gate|sluice" }),
    S(["hose_reel"], "FMC_SYM_FP_FireHoseReel", "Fire hose reel", { counted: true }),
    S(["hydrant"], "FMC_SYM_FP_ExternalFireHydrant", "External fire hydrant"),
    S(["inlet"], "FMC_SYM_FP_BreechingInlet", "Breeching inlet", { diagrams: ["fp_schematic"] }),
    S(["riser"], "FMC_SYM_FP_WetDryRiser", "Wet or dry riser", { diagrams: ["fp_schematic"] }),
    S(["sprinkler"], "FMC_SYM_FP_SprinklerHeadSidewall", "Sprinkler head, sidewall", { match: "side ?wall", counted: true }),
    S(["sprinkler"], "FMC_SYM_FP_SprinklerHeadUpright", "Sprinkler head, upright", { match: "upright", counted: true }),
    S(["sprinkler"], "FMC_SYM_FP_SprinklerHeadPendent", "Sprinkler head, pendent", { match: "pend[ae]nt", counted: true }),
    // Plumbing and drainage
    S(["tank", "equipment", "other"], "FMC_SYM_P_SepticTank", "Septic tank", { match: "septic" }),
    S(["equipment", "other", "fixture", "tank"], "FMC_SYM_P_Soakaway", "Soakaway", { match: "soak ?away|soak ?pit" }),
    S(["equipment", "other", "fixture"], "FMC_SYM_P_Manhole", "Manhole", { match: "manhole" }),
    S(["equipment", "other", "fixture"], "FMC_SYM_P_InspectionChamber", "Inspection chamber", { match: "inspection ?chamber|\\bic\\b" }),
    S(["tank"], "FMC_SYM_P_WaterStorageTank", "Water storage tank", { diagrams: ["p_water"] }),
    S(["pump"], "FMC_SYM_P_BoosterPumpSet", "Booster pump set", { diagrams: ["p_water"] }),
    S(["valve"], "FMC_SYM_P_NonReturnValve", "Non-return valve", { diagrams: ["p_water"], match: "check|non.?return|\\bnrv\\b" }),
    S(["valve"], "FMC_SYM_P_GateValve", "Gate valve", { diagrams: ["p_water"], match: "gate|sluice" }),
    S(["meter"], "FMC_SYM_P_WaterMeter", "Water meter", { diagrams: ["p_water", "fp_schematic"] }),
    S(["fixture"], "FMC_SYM_P_WC", "WC", { match: "\\bwc\\b|water ?closet|toilet", counted: true }),
    S(["fixture"], "FMC_SYM_P_WashHandBasin", "Wash hand basin", { match: "basin|lavatory|\\bwhb\\b|hand ?wash", counted: true }),
    S(["fixture"], "FMC_SYM_P_ShowerTray", "Shower tray", { match: "shower", counted: true }),
    S(["stack"], "FMC_SYM_P_SoilAndVentStackPlan", "Soil and vent stack", { diagrams: ["p_drainage"] }),
    { kinds: ["riser", "stack"], diagrams: ["p_water", "p_drainage"], drawn: "spine", label: "Riser or stack" },
    { kinds: ["tank"], diagrams: ["p_drainage"], family: "FMC_DI_P_Schematic", type: "Tank", label: "Tank", generic: true },
    { kinds: ["pump"], diagrams: ["p_drainage"], family: "FMC_DI_P_Schematic", type: "Pump", label: "Pump", generic: true },
    { kinds: ["valve"], diagrams: ["p_water", "p_drainage", "fp_schematic"], family: "FMC_DI_P_Schematic", type: "Valve", label: "Valve", generic: true },
    { kinds: ["fixture"], diagrams: ["p_water", "p_drainage"], family: "FMC_DI_P_Schematic", type: "Fixture", label: "Fixture", generic: true, counted: true },
    // Refrigerant
    S(["outdoor_unit"], "FMC_SYM_M_ACOutdoorUnit", "Air conditioning outdoor unit"),
    S(["indoor_unit"], "FMC_SYM_M_ACIndoorUnit", "Air conditioning indoor unit"),
    S(["equipment", "other"], "FMC_SYM_M_RefrigerantBranchJoint", "Refrigerant branch joint", { diagrams: ["m_refrigerant"], match: "branch|joint|refnet|header" }),
    S(["equipment", "other", "fixture"], "FMC_SYM_M_CondensatePipe", "Condensate drain point", { diagrams: ["m_refrigerant"], match: "condensate" }),
    // Lightning protection and earthing (BS EN 62305)
    S(["air_terminal"], "FMC_SYM_LP_AirTerminationRod", "Air termination rod"),
    S(["down_conductor"], "FMC_SYM_LP_DownConductor", "Down conductor"),
    S(["test_joint"], "FMC_SYM_LP_TestJoint", "Test joint"),
    S(["earth_pit"], "FMC_SYM_LP_EarthElectrodeAndPit", "Earth electrode and pit"),
    S(["earth_bar"], "FMC_SYM_LP_MainEarthingTerminal", "Main earthing terminal (MET)", { base: true }),
    S(["spd"], "FMC_SYM_LP_SurgeProtectiveDevice", "Surge protective device (SPD)"),
    S(["bond"], "FMC_SYM_LP_BondToMetalwork", "Bond to metalwork"),
  ],
  sizes: {
    "*": [6, 6],
    "FMC_DI_E_SLD_Breaker": [4, 8],
    "FMC_DI_E_SLD_Board": [10, 6],
    "FMC_DI_P_Schematic": [8, 8],
    "FMC_DI_P_Schematic:Tank": [12, 8],
    "FMC_SYM_E_FireAlarmPanel": [10, 8],
    "FMC_SYM_E_NVR": [10, 6],
    "FMC_SYM_E_ElectricFenceEnergiser": [10, 6],
    "FMC_SYM_FP_FirePump": [8, 8],
    "FMC_SYM_FP_JockeyPump": [8, 8],
    "FMC_SYM_FP_FireWaterTank": [12, 8],
    "FMC_SYM_FP_AlarmValveSet": [8, 10],
    "FMC_SYM_FP_WetDryRiser": [6, 10],
    "FMC_SYM_P_WaterStorageTank": [12, 8],
    "FMC_SYM_P_BoosterPumpSet": [10, 8],
    "FMC_SYM_P_SepticTank": [12, 8],
    "FMC_SYM_M_ACOutdoorUnit": [10, 8],
    "FMC_SYM_M_ACIndoorUnit": [10, 6],
    "FMC_SYM_LP_DownConductor": [4, 8],
    "FMC_SYM_LP_MainEarthingTerminal": [10, 6],
  },
  box: [10, 6],
};

// ---------------------------------------------------------------------------------------------------------------
// The kit override

export const KIT_FILE_NAME = "FMC_Diagram_Symbols.json";

/** <kit>/03_Master_Data/FMC_Diagram_Symbols.json */
export function kitDiagramFile(kitFolder: string): string {
  return win.join(kitFolder, "03_Master_Data", KIT_FILE_NAME);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function regexProblem(source: string): string | null {
  try { new RegExp(source, "i"); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/**
 * The default with the kit's file laid over it: `styles`, `layout`, `sizes` and `view_names` merge key by key;
 * `symbols` and `breakers` replace the default lists when given (a full copy, as in the fixture). Rules the kit gets
 * wrong (no family and no `drawn`, a bad regular expression, an unknown diagram) are dropped and reported.
 */
export function mergeKit(base: DiagramKit, override: unknown): { kit: DiagramKit; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(override)) return { kit: base, problems: ["FMC_Diagram_Symbols.json is not a JSON object: the default is used"] };
  const o = override;
  const styles = isObj(o.styles) ? o.styles : {};
  const layout = isObj(o.layout) ? o.layout : {};
  const kit: DiagramKit = {
    version: typeof o.version === "string" ? o.version : base.version,
    styles: {
      ...base.styles, ...(styles as Partial<DiagramStyle>),
      text: { ...base.styles.text, ...(isObj(styles.text) ? styles.text as object : {}) },
      text_height_mm: { ...base.styles.text_height_mm, ...(isObj(styles.text_height_mm) ? styles.text_height_mm as object : {}) },
      lines: { ...base.styles.lines, ...(isObj(styles.lines) ? styles.lines as object : {}) },
    },
    layout: {
      ...base.layout, ...(layout as Partial<DiagramLayoutConfig>),
      view_names: { ...base.layout.view_names, ...(isObj(layout.view_names) ? layout.view_names as object : {}) },
    },
    breaker_family: typeof o.breaker_family === "string" ? o.breaker_family : base.breaker_family,
    breaker_default: typeof o.breaker_default === "string" ? o.breaker_default : base.breaker_default,
    breakers: base.breakers,
    symbols: base.symbols,
    sizes: { ...base.sizes, ...(isObj(o.sizes) ? o.sizes as Record<string, number[]> : {}) },
    box: Array.isArray(o.box) && o.box.length === 2 ? o.box as number[] : base.box,
  };
  if (Array.isArray(o.breakers)) {
    kit.breakers = [];
    for (const [i, b] of (o.breakers as unknown[]).entries()) {
      if (!isObj(b) || typeof b.match !== "string" || typeof b.type !== "string") { problems.push(`breakers[${i}] needs match and type`); continue; }
      const bad = regexProblem(b.match);
      if (bad) { problems.push(`breakers[${i}].match: ${bad}`); continue; }
      kit.breakers.push({ match: b.match, type: b.type, label: typeof b.label === "string" ? b.label : b.type });
    }
  }
  if (Array.isArray(o.symbols)) {
    kit.symbols = [];
    for (const [i, r] of (o.symbols as unknown[]).entries()) {
      if (!isObj(r) || !Array.isArray(r.kinds) || typeof r.label !== "string") { problems.push(`symbols[${i}] needs kinds and label`); continue; }
      const rule = r as unknown as SymbolRule;
      if (!rule.drawn && (!rule.family || !rule.type)) { problems.push(`symbols[${i}] (${rule.label}) needs family and type, or drawn`); continue; }
      if (rule.match !== undefined) {
        const bad = regexProblem(String(rule.match));
        if (bad) { problems.push(`symbols[${i}].match: ${bad}`); continue; }
      }
      const unknown = (rule.diagrams ?? []).filter((d) => !(DIAGRAM_KINDS as readonly string[]).includes(d));
      if (unknown.length) { problems.push(`symbols[${i}] names unknown diagrams: ${unknown.join(", ")}`); continue; }
      kit.symbols.push(rule);
    }
  }
  for (const [k, v] of Object.entries(kit.sizes))
    if (!Array.isArray(v) || v.length !== 2 || v.some((n) => typeof n !== "number" || !(n > 0))) {
      problems.push(`sizes.${k} must be [width, height] in mm`);
      kit.sizes[k] = base.sizes[k] ?? base.sizes["*"];
    }
  return { kit, problems };
}

/** The kit's diagram table when the file exists, otherwise the default. Never throws. */
export function loadDiagramKit(file: string | null, reader: (p: string) => string = (p) => fs.readFileSync(p, "utf8")):
  { kit: DiagramKit; source: string; problems: string[] } {
  if (!file) return { kit: DEFAULT_DIAGRAM_KIT, source: "default", problems: [] };
  let raw: string;
  try { raw = reader(file); } catch { return { kit: DEFAULT_DIAGRAM_KIT, source: "default", problems: [] }; }
  try {
    const { kit, problems } = mergeKit(DEFAULT_DIAGRAM_KIT, JSON.parse(raw.replace(/^﻿/, "")));
    return { kit, source: file, problems };
  } catch (e) {
    return { kit: DEFAULT_DIAGRAM_KIT, source: "default", problems: [`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}): the default is used`] };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Parameters (contract PARAM_KEYS)

export type Value = string | number | null;

/** A parameter by its contract key or an alias: `present` false when the scan didn't send it at all. */
export function param(params: Record<string, Value> | undefined, key: ParamKey): { present: boolean; value: Value } {
  for (const k of PARAM_KEYS[key]) if (params && k in params) return { present: true, value: params[k] ?? null };
  return { present: false, value: null };
}

/** A non-empty value as text, or null. */
export function text(v: Value | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution

export type Mark =
  | { t: "symbol"; family: string; type: string; label: string; rule: SymbolRule }
  | { t: "drawn"; drawn: "supply" | "spine"; label: string; rule: SymbolRule }
  | { t: "box"; label: string; reason: string };

const compiled = new WeakMap<object, RegExp>();
function re(owner: object, source: string): RegExp {
  let r = compiled.get(owner);
  if (!r) { r = new RegExp(source, "i"); compiled.set(owner, r); }
  return r;
}

/** Words out of Revit names: FMC_E_TVCoaxialOutlet -> "FMC E TV Coaxial Outlet", so \b and "manual ?call" both work. */
export function words(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/[_\-.:/\\]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The text a rule's `match` is tested on. */
export function hintOf(node: ScanNode): string {
  const part = text(param(node.params, "part_type").value) ?? "";
  return words([node.category, node.family, node.type, node.name, part].filter(Boolean).join(" "));
}

/** The kit symbol for a node in a diagram: the first rule that fits. No rule: a plain box, never a guessed symbol. */
export function symbolFor(node: ScanNode, diagram: DiagramKind, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): Mark {
  const hint = hintOf(node);
  for (const rule of kit.symbols) {
    if (rule.kinds.length && !rule.kinds.includes(node.kind)) continue;
    if (rule.diagrams && !rule.diagrams.includes(diagram)) continue;
    if (rule.match && !re(rule, rule.match).test(hint)) continue;
    if (rule.drawn) return { t: "drawn", drawn: rule.drawn, label: rule.label, rule };
    return { t: "symbol", family: rule.family!, type: rule.type!, label: rule.label, rule };
  }
  const what = [node.kind, node.category, node.family].filter(Boolean).join(" / ");
  return { t: "box", label: node.name || node.family || node.category || node.kind,
    reason: `No kit symbol for ${what} in ${diagram}: drawn as a box. Add a rule to ${KIT_FILE_NAME}` };
}

/** The protective device on a way: only what the model says. Unknown: the kit default with `known` false (label says TBC). */
export function breakerFor(edge: ScanEdge, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): { family: string; type: string; known: boolean; label: string } {
  const said = [text(param(edge.params, "breaker").value), typeof param(edge.params, "rating").value === "string" ? text(param(edge.params, "rating").value) : null]
    .filter(Boolean).map((s) => words(s!)).join(" ");
  if (said) for (const b of kit.breakers) if (re(b, b.match).test(said)) return { family: kit.breaker_family, type: b.type, known: true, label: b.label };
  const def = kit.breakers.find((b) => b.type === kit.breaker_default);
  return { family: kit.breaker_family, type: kit.breaker_default, known: false, label: def?.label ?? kit.breaker_default };
}

/** Symbol box [width, height] in paper mm. */
export function symbolSize(family: string, type: string, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): [number, number] {
  const s = kit.sizes[`${family}:${type}`] ?? kit.sizes[family] ?? kit.sizes["*"] ?? [6, 6];
  return [s[0], s[1]];
}

/** Every symbol family and type the table can produce (for checks against the Family Register). */
export function tableSymbols(kit: DiagramKit = DEFAULT_DIAGRAM_KIT): Array<{ family: string; type: string }> {
  const seen = new Map<string, { family: string; type: string }>();
  for (const r of kit.symbols) if (r.family && r.type) seen.set(`${r.family}:${r.type}`, { family: r.family, type: r.type });
  for (const b of kit.breakers) seen.set(`${kit.breaker_family}:${b.type}`, { family: kit.breaker_family, type: b.type });
  seen.set(`${kit.breaker_family}:${kit.breaker_default}`, { family: kit.breaker_family, type: kit.breaker_default });
  return [...seen.values()].sort((a, b) => `${a.family}:${a.type}`.localeCompare(`${b.family}:${b.type}`));
}
