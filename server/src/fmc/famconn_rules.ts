/**
 * fmc_fam_connector rules (pure, no Revit): which system classifications, flow directions, shapes and size-parameter
 * associations go with each connector domain. Used to validate what a family holds and to refuse a change before the
 * add-in is called. Names are Revit's enum names (DuctSystemType, PipeSystemType, ElectricalSystemType, FlowDirectionType).
 */
export type Domain = "duct" | "pipe" | "electrical" | "cable_tray" | "conduit";
export type Shape = "round" | "rectangular" | "oval";
export type Flow = "In" | "Out" | "Bidirectional";
export const DOMAINS: Domain[] = ["duct", "pipe", "electrical", "cable_tray", "conduit"];

export const SYSTEMS: Record<Domain, string[]> = {
  duct: ["SupplyAir", "ReturnAir", "ExhaustAir", "OtherAir", "Fitting", "Global"],
  pipe: ["SupplyHydronic", "ReturnHydronic", "DomesticHotWater", "DomesticColdWater", "Sanitary", "Vent", "Storm", "CondensateDrain", "Recirculation", "OtherPipe",
    "FireProtectWet", "FireProtectDry", "FireProtectPreaction", "FireProtectOther", "Fitting", "Global"],
  electrical: ["PowerBalanced", "PowerUnBalanced", "PowerCircuit", "Data", "DataCircuit", "Telephone", "Security", "FireAlarm", "NurseCall", "Controls", "Communication"],
  cable_tray: [],
  conduit: [],
};
const FITTING_SYSTEMS = new Set(["Fitting", "Global"]);
const FLOW_DOMAINS = new Set<Domain>(["duct", "pipe"]);
export const SHAPES: Record<Domain, Shape[]> = { duct: ["round", "rectangular", "oval"], pipe: ["round"], electrical: [], cable_tray: ["rectangular"], conduit: ["round"] };

/** Connector parameters a family parameter may drive, the spec it needs (substring of Revit's spec type id), and where it applies. */
export const SIZE_KEYS: Record<string, { need: string; spec: RegExp; domains: Domain[]; shapes?: Shape[]; revit: string }> = {
  diameter: { need: "length", spec: /length/i, domains: ["duct", "pipe", "conduit"], shapes: ["round"], revit: "Diameter" },
  radius: { need: "length", spec: /length/i, domains: ["duct", "pipe", "conduit"], shapes: ["round"], revit: "Radius" },
  width: { need: "length", spec: /length/i, domains: ["duct", "cable_tray"], shapes: ["rectangular", "oval"], revit: "Width" },
  height: { need: "length", spec: /length/i, domains: ["duct", "cable_tray"], shapes: ["rectangular", "oval"], revit: "Height" },
  duct_flow: { need: "air flow", spec: /air.?flow/i, domains: ["duct"], revit: "Duct Flow" },
  pipe_flow: { need: "pipe flow", spec: /pip.*flow|flow.*pip/i, domains: ["pipe"], revit: "Pipe Flow" },
  voltage: { need: "electrical potential (voltage)", spec: /potential|voltage/i, domains: ["electrical"], revit: "Voltage" },
  poles: { need: "integer", spec: /int|number/i, domains: ["electrical"], revit: "Number of Poles" },
  apparent_load: { need: "apparent power", spec: /apparent.?power/i, domains: ["electrical"], revit: "Apparent Load" },
  power_factor: { need: "power factor or number", spec: /power.?factor|number/i, domains: ["electrical"], revit: "Power Factor" },
};

export interface ConnectorRead {
  id: number;
  name?: string | null;
  domain: string;
  system?: string | null;
  shape?: string | null;
  flow_direction?: string | null;
  is_primary?: boolean;
  size?: Record<string, number>;
  /** size key → the family parameter that drives it (null: none) */
  associations?: Record<string, string | null>;
  linked_to?: number | null;
}
export interface FamParamRead { name: string; spec?: string; is_instance?: boolean; formula?: string | null }
export interface FamilyConnectors { family?: string; category?: string; connectors: ConnectorRead[]; parameters: FamParamRead[] }

export interface ConnectorReport { id: number; name: string; domain: string; system: string; flow_direction: string; shape: string; is_primary: boolean;
  associations: Record<string, string | null>; errors: string[]; warnings: string[] }

const isFittingCategory = (category = "") => /fitting|accessor/i.test(category);

/** Every rule for one connector; errors are combinations Revit or the systems would reject, warnings need a person. */
export function checkConnector(c: ConnectorRead, params: FamParamRead[], category = ""): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const label = `connector ${c.name || c.id}`;
  if (!DOMAINS.includes(c.domain as Domain)) {
    errors.push(`${label}: domain ${c.domain || "(none)"} isn't one of ${DOMAINS.join(", ")}`);
    return { errors, warnings };
  }
  const d = c.domain as Domain;
  const system = (c.system ?? "").trim();
  const allowed = SYSTEMS[d];
  if (allowed.length) {
    if (!system) errors.push(`${label}: a ${d} connector needs a system classification (${allowed.join(", ")})`);
    else if (!allowed.includes(system)) errors.push(`${label}: system classification ${system} isn't a ${d} system; use one of ${allowed.join(", ")}`);
    else if (FITTING_SYSTEMS.has(system) && !isFittingCategory(category))
      errors.push(`${label}: ${system} is for fittings and accessories; a ${category || "family"} connector needs a real system (${allowed.filter((s) => !FITTING_SYSTEMS.has(s)).join(", ")})`);
  } else if (system && !/^(undefined|none|cabletrayconduit)/i.test(system)) {
    errors.push(`${label}: a ${d} connector has no system classification (got ${system})`);
  }
  const flow = (c.flow_direction ?? "").trim();
  if (flow && !FLOW_DOMAINS.has(d)) errors.push(`${label}: flow direction is only for duct and pipe connectors, not ${d}`);
  else if (flow && !["In", "Out", "Bidirectional"].includes(flow)) errors.push(`${label}: flow direction ${flow} isn't In, Out or Bidirectional`);
  else if (!flow && FLOW_DOMAINS.has(d) && !FITTING_SYSTEMS.has(system)) warnings.push(`${label}: no flow direction set (In, Out or Bidirectional is the engineer's choice)`);
  const shape = (c.shape ?? "").trim().toLowerCase();
  const shapes = SHAPES[d];
  if (shapes.length && shape && !shapes.includes(shape as Shape)) errors.push(`${label}: a ${d} connector is ${shapes.join(" or ")}, not ${shape}`);
  if (!shapes.length && shape && d === "electrical") warnings.push(`${label}: an electrical connector has no profile (got ${shape})`);
  const byName = new Map(params.map((p) => [p.name.toLowerCase(), p]));
  for (const [key, param] of Object.entries(c.associations ?? {})) {
    if (!param) continue;
    const rule = SIZE_KEYS[key];
    if (!rule) { errors.push(`${label}: ${key} isn't a connector parameter the tool knows (${Object.keys(SIZE_KEYS).join(", ")})`); continue; }
    if (!rule.domains.includes(d)) { errors.push(`${label}: ${rule.revit} isn't a ${d} connector parameter, so ${param} can't drive it`); continue; }
    if (rule.shapes && shape && !rule.shapes.includes(shape as Shape)) { errors.push(`${label}: ${rule.revit} doesn't apply to a ${shape} connector (${param} is associated to it)`); continue; }
    const fp = byName.get(param.toLowerCase());
    if (!fp) { errors.push(`${label}: ${rule.revit} is associated to ${param}, which the family doesn't have`); continue; }
    if (!fp.spec) warnings.push(`${label}: ${param}'s data type wasn't read, so ${rule.revit} couldn't be checked`);
    else if (!rule.spec.test(fp.spec)) errors.push(`${label}: ${rule.revit} needs a ${rule.need} parameter; ${param} is ${fp.spec}`);
  }
  const has = (k: string) => !!c.associations?.[k];
  if (d === "duct" || d === "pipe" || d === "conduit") {
    if (shape === "round" && !has("diameter") && !has("radius")) warnings.push(`${label}: its diameter isn't driven by a family parameter (it stays fixed in every type)`);
    if ((shape === "rectangular" || shape === "oval") && (!has("width") || !has("height"))) warnings.push(`${label}: width and height aren't both driven by family parameters`);
  }
  if (has("diameter") && has("radius")) errors.push(`${label}: diameter and radius are both associated; associate one`);
  return { errors, warnings };
}

/** The whole family: each connector, plus primaries and linked pairs per domain. */
export function validateConnectors(f: FamilyConnectors): { ok: boolean; connectors: ConnectorReport[]; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reports: ConnectorReport[] = f.connectors.map((c) => {
    const r = checkConnector(c, f.parameters, f.category);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    return { id: c.id, name: c.name ?? "", domain: c.domain, system: c.system ?? "", flow_direction: c.flow_direction ?? "", shape: c.shape ?? "",
      is_primary: !!c.is_primary, associations: c.associations ?? {}, errors: r.errors, warnings: r.warnings };
  });
  for (const d of DOMAINS) {
    const list = f.connectors.filter((c) => c.domain === d);
    const primaries = list.filter((c) => c.is_primary);
    if (primaries.length > 1) errors.push(`${primaries.length} primary ${d} connectors (${primaries.map((c) => c.name || c.id).join(", ")}); a family has one per domain`);
    if (list.length > 1 && !primaries.length) warnings.push(`${list.length} ${d} connectors and none is primary; Revit takes the first`);
  }
  const byId = new Map(f.connectors.map((c) => [c.id, c]));
  for (const c of f.connectors) {
    if (c.linked_to == null) continue;
    const o = byId.get(c.linked_to);
    if (!o) { warnings.push(`connector ${c.name || c.id} links to ${c.linked_to}, which isn't in the family`); continue; }
    if (o.domain !== c.domain) errors.push(`connectors ${c.name || c.id} and ${o.name || o.id} are linked across domains (${c.domain}, ${o.domain})`);
    else if ((o.system ?? "") !== (c.system ?? "")) warnings.push(`linked connectors ${c.name || c.id} and ${o.name || o.id} have different systems (${c.system}, ${o.system})`);
  }
  if (!f.connectors.length) warnings.push("The family has no connectors");
  return { ok: errors.length === 0, connectors: reports, errors, warnings };
}
