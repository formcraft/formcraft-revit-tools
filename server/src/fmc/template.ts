import { SpParam } from "./specs.js";

/**
 * Template audit and brand pack (board manage/PaneTemplates, U14). Pure: the facts come from Revit
 * (fmc_template_audit), the reference from the kit (FMC_SharedParameters.txt, the brand pack the pane read from the kit).
 *
 * Severity follows the board's Show filter: Must (breaks a kit rule), Should (off the firm look), Advice (worth a look).
 * Only what the kit defines is a Must or a Should; counts with no kit threshold are Advice (rule 7: kit data from the kit).
 */
export type Severity = "Must" | "Should" | "Advice" | "Pass";

export interface AuditLine { area: string; severity: Severity; status: string; detail: string }

export interface TemplateFacts {
  title: string;
  size_mb: number;
  shared_parameters: Array<{ name: string; guid: string }>;
  view_templates: number;
  filters: number;
  text_types: Array<{ name: string; font: string }>;
  dimension_types: Array<{ name: string; font: string }>;
  title_blocks: number;
  schedules: number;
  browser_organisations: number;
  families: number;
  unused_families: number;
  warnings: number;
  // F-044: names from this build's add-in; an older add-in leaves them out and those lines say Not checked
  title_block_families?: string[];
  schedule_names?: string[];
  view_template_names?: string[];
  legend_names?: string[];
  panel_schedule_templates?: string[];
  materials?: Array<{ name: string; used: boolean; textures: string[] }>;
}

/**
 * F-044 (issue #145): what the kit says a template holds, read from the kit each time (rule 7). A source that couldn't
 * be read is null, with its reason in problems; its lines then say Not checked and why, never Pass.
 */
export interface TemplateRef {
  /** FMC_Master_Data.json params: the project parameters the base recipe binds (kit → template). */
  projectParameters?: string[] | null;
  /** FMC_Family_Register.csv, category Title Blocks: the kit's title block families and their priority. */
  titleBlocks?: Array<{ family: string; priority: string }> | null;
  /** FMC_Materials.json: the kit's material names. */
  materials?: string[] | null;
  /** LG_* legends the sheet register places, for the General role and this template's role. */
  legends?: string[] | null;
  /** FMC_Revit_Kit.xlsx Panel_Schedules: the kit's panel schedule templates. */
  panelTemplates?: string[] | null;
  /** FMC_Revit_Kit.xlsx Schedules and View_Templates: what the kit itself adds (anything else is stock or hand-made). */
  schedules?: string[] | null;
  viewTemplates?: string[] | null;
  /** Why the brand line can't run when no brand pack is given (the kit has none, or several to choose from). */
  brandNote?: string;
  /** Role copies: what the byte comparison with the Base template found (roleCopyLine). */
  roleCopy?: AuditLine | null;
  /** Texture paths on this PC. */
  exists?: (p: string) => boolean;
  problems?: Partial<Record<"projectParameters" | "titleBlocks" | "materials" | "legends" | "panelTemplates" | "schedules", string>>;
}

export interface BrandPack { name: string; main_font: string; title_font?: string }

export function fontFor(typeName: string, brand: BrandPack): string {
  return /title/i.test(typeName) ? (brand.title_font || brand.main_font) : brand.main_font;
}

const NOT_CHECKED = (area: string, detail: string): AuditLine => ({ area, severity: "Advice", status: "Not checked", detail });
const OLD_ADDIN = "This add-in doesn't report it: install this build's add-in";
const list = (names: string[], n = 8) => names.slice(0, n).join(", ") + (names.length > n ? `… (${names.length})` : "");
const lower = (names: Iterable<string>) => new Set([...names].map((n) => n.trim().toLowerCase()));

/** "Concrete (1)" beside "Concrete", or Revit's own "Default…" placeholders. */
function duplicateMaterial(name: string, names: Set<string>): boolean {
  const m = /^(.*?)\s*\(\d+\)$/.exec(name);
  return (!!m && names.has(m[1])) || /^Default(\b| )/i.test(name);
}

/**
 * F-044: a role template that is a byte-for-byte copy of the Base template carries none of its role's settings. The
 * kit has no role value tables yet (KCR 28), so this is Advice, not a failure of the build. files: the .rte files beside
 * the audited one with their hashes (FMC_<Base|Role>_Template_<version>.rte).
 */
export function roleCopyLine(target: string, files: Array<{ name: string; hash: string }>): AuditLine | null {
  const AREA = "Role templates vs Base";
  const parse = (n: string) => /^FMC_(Base|[A-Z]{1,2})_Template_(.+)\.rte$/i.exec(n);
  const me = parse(target);
  if (!me) return null;
  const version = me[2].toLowerCase();
  const same = files.filter((f) => parse(f.name)?.[2].toLowerCase() === version);
  const base = same.find((f) => /^base$/i.test(parse(f.name)![1]));
  const advice = "role settings not applied — kit has no role value tables, KCR 28";
  if (!base) return /^base$/i.test(me[1]) ? null : NOT_CHECKED(AREA, `No FMC_Base_Template_${me[2]}.rte beside it to compare with`);
  if (/^base$/i.test(me[1])) {
    const copies = same.filter((f) => f !== base && f.hash === base.hash).map((f) => f.name);
    return copies.length ? { area: AREA, severity: "Advice", status: `${copies.length} identical to Base`, detail: `${list(copies, 13)}: ${advice}` } : null;
  }
  const mine = same.find((f) => f.name.toLowerCase() === target.toLowerCase());
  return mine && mine.hash === base.hash
    ? { area: AREA, severity: "Advice", status: "Identical to Base", detail: `${target} is a byte-for-byte copy of ${base.name}: ${advice}` }
    : { area: AREA, severity: "Pass", status: "Pass", detail: `${target} differs from ${base.name}` };
}

export function auditTemplate(facts: TemplateFacts, kit: Map<string, SpParam> | null, brand: BrandPack | null, ref: TemplateRef = {}): AuditLine[] {
  const lines: AuditLine[] = [];
  const why = (k: keyof NonNullable<TemplateRef["problems"]>, fallback: string) => ref.problems?.[k] || fallback;

  if (!kit) lines.push({ area: "Shared parameters vs FMC_SharedParameters.txt", severity: "Advice", status: "Not checked",
    detail: "The kit's shared parameter file wasn't found (shared_parameter_file in fmc_guard.json)" });
  else {
    const byGuid = new Map([...kit.values()].map((p) => [p.guid.toLowerCase(), p]));
    const differ = facts.shared_parameters.filter((p) => {
      const k = byGuid.get(p.guid.toLowerCase());
      return !k ? kit.has(p.name) : k.name !== p.name;
    });
    const foreign = facts.shared_parameters.filter((p) => !byGuid.has(p.guid.toLowerCase()) && !kit.has(p.name));
    lines.push(differ.length
      ? { area: "Shared parameters vs FMC_SharedParameters.txt", severity: "Must", status: `${differ.length} differ`,
          detail: "Same name, different GUID (or renamed): " + differ.slice(0, 8).map((p) => p.name).join(", ") + (differ.length > 8 ? "…" : "") }
      : { area: "Shared parameters vs FMC_SharedParameters.txt", severity: "Pass", status: "Pass",
          detail: `${facts.shared_parameters.length} shared parameters, all matched by GUID` });
    if (foreign.length) lines.push({ area: "Shared parameters not in the kit", severity: "Should", status: `${foreign.length} extra`,
      detail: foreign.slice(0, 8).map((p) => p.name).join(", ") + (foreign.length > 8 ? "…" : "") + ". New parameters go through a change request." });
  }

  // F-044: the other way, kit → template: every project parameter the kit's base recipe binds must be in the template
  {
    const AREA = "Kit parameters in the template (FMC_Master_Data.json)";
    const want = ref.projectParameters;
    if (!want) lines.push(NOT_CHECKED(AREA, why("projectParameters", "The kit's master data (FMC_Master_Data.json params) wasn't read")));
    else {
      const haveGuid = lower(facts.shared_parameters.map((p) => p.guid)), haveName = lower(facts.shared_parameters.map((p) => p.name));
      const missing = want.filter((n) => { const g = kit?.get(n)?.guid; return !(g && haveGuid.has(g.toLowerCase())) && !haveName.has(n.toLowerCase()); });
      lines.push(missing.length
        ? { area: AREA, severity: "Must", status: `${missing.length} missing`, detail: `${want.length - missing.length} of ${want.length} present; missing ${list(missing, 12)}` }
        : { area: AREA, severity: "Pass", status: "Pass", detail: `all ${want.length} kit project parameters present${kit ? " (by GUID where the kit file has it)" : " (by name: the kit's parameter file wasn't read)"}` });
    }
  }

  lines.push(facts.view_templates > 0 && facts.filters > 0
    ? { area: "View templates and filters", severity: "Pass", status: "Pass", detail: `${facts.view_templates} view templates · ${facts.filters} filters` }
    : { area: "View templates and filters", severity: "Should", status: "Missing", detail: `${facts.view_templates} view templates · ${facts.filters} filters` });

  // F-044: stock Autodesk (or hand-made) view templates and schedules the kit doesn't add, left in the template
  const stock = (area: string, have: string[] | undefined, kitNames: string[] | null | undefined, problem: string, what: string) => {
    if (!have) return lines.push(NOT_CHECKED(area, OLD_ADDIN));
    if (!kitNames) return lines.push(NOT_CHECKED(area, problem));
    const k = lower(kitNames);
    const extra = have.filter((n) => !k.has(n.trim().toLowerCase()));
    lines.push(extra.length
      ? { area, severity: "Should", status: `${extra.length} not from the kit`, detail: `${list(extra)}: stock Autodesk or hand-made ${what} left in; the kit's own are named in FMC_Revit_Kit.xlsx` }
      : { area, severity: "Pass", status: "Pass", detail: `${have.length} ${what}, all from the kit` });
  };
  stock("View templates not from the kit", facts.view_template_names, ref.viewTemplates, why("schedules", "The kit's View_Templates table wasn't read"), "view templates");

  // F-044: fonts — Not checked with the reason when there is no brand pack, never left out
  if (brand) {
    const types = [...facts.text_types.map((t) => ({ ...t, kind: "Text" })), ...facts.dimension_types.map((t) => ({ ...t, kind: "Dimension" }))];
    const off = types.filter((t) => t.font && t.font.toLowerCase() !== fontFor(t.name, brand).toLowerCase());
    lines.push(off.length
      ? { area: `Fonts vs the brand pack (${brand.name})`, severity: "Should", status: `${off.length} off-brand`,
          detail: off.slice(0, 6).map((t) => `${t.kind} ${t.name}: ${t.font}`).join(" · ") + (off.length > 6 ? "…" : "") }
      : { area: `Fonts vs the brand pack (${brand.name})`, severity: "Pass", status: "Pass", detail: `${types.length} text and dimension types` });
  } else lines.push(NOT_CHECKED("Fonts vs the brand pack", ref.brandNote || "No brand pack was given (the pane passes the one chosen in Firm look)"));

  lines.push({ area: "Text and dimension styles", severity: "Advice", status: `${facts.text_types.length} + ${facts.dimension_types.length}`,
    detail: `${facts.text_types.length} text types, ${facts.dimension_types.length} dimension types` });

  // F-044: title blocks — the kit's FMC_TB_* (Family Register) must be loaded; a count of Revit's stock ones isn't a pass
  {
    const AREA = "Title blocks vs the Family Register";
    const have = facts.title_block_families;
    if (!have) lines.push(facts.title_blocks > 0 ? NOT_CHECKED(AREA, `${facts.title_blocks} title block types, but their families aren't named: ${OLD_ADDIN}`)
      : { area: AREA, severity: "Must", status: "No title block", detail: "The template has no title block at all" });
    else if (!ref.titleBlocks) lines.push(NOT_CHECKED(AREA, why("titleBlocks", "The kit's Family Register wasn't read")));
    else {
      const h = lower(have);
      const missing = ref.titleBlocks.filter((t) => !h.has(t.family.toLowerCase()));
      const must = missing.filter((t) => /^P1$/i.test(t.priority));
      const loadedKit = ref.titleBlocks.length - missing.length;
      const others = have.filter((n) => !ref.titleBlocks!.some((t) => t.family.toLowerCase() === n.toLowerCase()));
      lines.push(!missing.length
        ? { area: AREA, severity: "Pass", status: "Pass", detail: `all ${ref.titleBlocks.length} kit title blocks loaded: ${list(ref.titleBlocks.map((t) => t.family))}` }
        : { area: AREA, severity: must.length || !loadedKit ? "Must" : "Should", status: `${missing.length} kit title blocks missing`,
            detail: `missing ${list(missing.map((t) => `${t.family} (${t.priority})`))}${others.length ? `; loaded instead: ${list(others, 4)}` : ""}` });
    }
  }
  stock("Schedules not from the kit", facts.schedule_names, ref.schedules, why("schedules", "The kit's Schedules table wasn't read"), "schedules");

  // F-044: legends the sheet register places (LG_Z_Abbreviations, LG_Z_Symbols, …)
  {
    const AREA = "Legends vs the sheet register";
    if (!facts.legend_names) lines.push(NOT_CHECKED(AREA, OLD_ADDIN));
    else if (!ref.legends) lines.push(NOT_CHECKED(AREA, why("legends", "The kit's sheet register wasn't read")));
    else {
      const h = lower(facts.legend_names);
      const missing = ref.legends.filter((n) => !h.has(n.toLowerCase()));
      lines.push(missing.length
        ? { area: AREA, severity: "Should", status: `${missing.length} missing`, detail: `${ref.legends.length - missing.length} of ${ref.legends.length}; missing ${list(missing, 10)}` }
        : { area: AREA, severity: "Pass", status: "Pass", detail: `all ${ref.legends.length} legends the register places` });
    }
  }

  // F-044: panel schedule templates (FMC_DB_SPN, FMC_DB_TPN, FMC_MDB_Switchboard, FMC_Data_Panel)
  {
    const AREA = "Panel schedule templates vs the kit";
    if (!facts.panel_schedule_templates) lines.push(NOT_CHECKED(AREA, OLD_ADDIN));
    else if (!ref.panelTemplates) lines.push(NOT_CHECKED(AREA, why("panelTemplates", "The kit's Panel_Schedules table wasn't read")));
    else {
      const h = lower(facts.panel_schedule_templates);
      const missing = ref.panelTemplates.filter((n) => !h.has(n.toLowerCase()));
      lines.push(missing.length
        ? { area: AREA, severity: "Should", status: `${missing.length} missing`, detail: `missing ${list(missing)}` }
        : { area: AREA, severity: "Pass", status: "Pass", detail: `all ${ref.panelTemplates.length}: ${list(ref.panelTemplates)}` });
    }
  }

  // F-044: materials — the kit's FMC_ materials, broken texture paths, unused, duplicates and "Default…"
  if (!facts.materials) lines.push(NOT_CHECKED("Materials", OLD_ADDIN));
  else {
    const mats = facts.materials;
    if (!ref.materials) lines.push(NOT_CHECKED("Materials: the kit's FMC_ materials", why("materials", "The kit's material library (FMC_Materials.json) wasn't read")));
    else {
      const k = lower(ref.materials);
      const fromKit = mats.filter((m) => k.has(m.name.toLowerCase()));
      const fmcNotKit = mats.filter((m) => /^FMC_/i.test(m.name) && !k.has(m.name.toLowerCase()));
      lines.push(!fromKit.length
        ? { area: "Materials: the kit's FMC_ materials", severity: "Should", status: "None from the kit",
            detail: `${mats.length} materials, none of the kit's ${ref.materials.length}${fmcNotKit.length ? `; FMC_-named but not in the library: ${list(fmcNotKit.map((m) => m.name), 5)}` : ""}` }
        : { area: "Materials: the kit's FMC_ materials", severity: fmcNotKit.length ? "Should" : "Pass", status: fmcNotKit.length ? `${fmcNotKit.length} FMC_ not in the library` : "Pass",
            detail: `${fromKit.length} of the kit's ${ref.materials.length} materials; ${mats.length - fromKit.length} others${fmcNotKit.length ? `; FMC_-named but not in the library: ${list(fmcNotKit.map((m) => m.name), 5)}` : ""}` });
    }
    if (!ref.exists) lines.push(NOT_CHECKED("Materials: texture paths", "No way to look at this PC's files"));
    else {
      const broken = mats.filter((m) => m.textures.some((t) => t && !ref.exists!(t)));
      lines.push(broken.length
        ? { area: "Materials: texture paths", severity: "Should", status: `${broken.length} broken`, detail: `textures not found on this PC: ${list(broken.map((m) => m.name))}` }
        : { area: "Materials: texture paths", severity: "Pass", status: "Pass", detail: `${mats.filter((m) => m.textures.length).length} materials with textures, all found` });
    }
    const unused = mats.filter((m) => !m.used);
    lines.push({ area: "Materials: unused", severity: "Advice", status: `${unused.length} unused`, detail: unused.length ? list(unused.map((m) => m.name)) : "every material is used" });
    const names = new Set(mats.map((m) => m.name));
    const dups = mats.filter((m) => duplicateMaterial(m.name, names));
    lines.push(dups.length
      ? { area: "Materials: duplicates and Revit defaults", severity: "Should", status: `${dups.length} found`, detail: list(dups.map((m) => m.name)) }
      : { area: "Materials: duplicates and Revit defaults", severity: "Pass", status: "Pass", detail: "no \"(1)\" copies or \"Default…\" materials" });
  }

  if (ref.roleCopy) lines.push(ref.roleCopy);
  lines.push(facts.browser_organisations > 0
    ? { area: "Browser organisation", severity: "Pass", status: "Pass", detail: `${facts.browser_organisations} browser organisations` }
    : { area: "Browser organisation", severity: "Advice", status: "None", detail: "The project browser isn't organised" });
  lines.push({ area: "Size, unused families, warnings", severity: "Advice",
    status: `${facts.size_mb} MB · ${facts.unused_families} unused`,
    detail: `${facts.size_mb} MB · ${facts.unused_families} of ${facts.families} families unused · ${facts.warnings} warnings` });
  return lines;
}
