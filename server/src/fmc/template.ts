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
}

export interface BrandPack { name: string; main_font: string; title_font?: string }

export function fontFor(typeName: string, brand: BrandPack): string {
  return /title/i.test(typeName) ? (brand.title_font || brand.main_font) : brand.main_font;
}

export function auditTemplate(facts: TemplateFacts, kit: Map<string, SpParam> | null, brand: BrandPack | null): AuditLine[] {
  const lines: AuditLine[] = [];

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

  lines.push(facts.view_templates > 0 && facts.filters > 0
    ? { area: "View templates and filters", severity: "Pass", status: "Pass", detail: `${facts.view_templates} view templates · ${facts.filters} filters` }
    : { area: "View templates and filters", severity: "Should", status: "Missing", detail: `${facts.view_templates} view templates · ${facts.filters} filters` });

  if (brand) {
    const types = [...facts.text_types.map((t) => ({ ...t, kind: "Text" })), ...facts.dimension_types.map((t) => ({ ...t, kind: "Dimension" }))];
    const off = types.filter((t) => t.font && t.font.toLowerCase() !== fontFor(t.name, brand).toLowerCase());
    lines.push(off.length
      ? { area: `Fonts vs the brand pack (${brand.name})`, severity: "Should", status: `${off.length} off-brand`,
          detail: off.slice(0, 6).map((t) => `${t.kind} ${t.name}: ${t.font}`).join(" · ") + (off.length > 6 ? "…" : "") }
      : { area: `Fonts vs the brand pack (${brand.name})`, severity: "Pass", status: "Pass", detail: `${types.length} text and dimension types` });
  }

  lines.push({ area: "Text and dimension styles", severity: "Advice", status: `${facts.text_types.length} + ${facts.dimension_types.length}`,
    detail: `${facts.text_types.length} text types, ${facts.dimension_types.length} dimension types` });
  lines.push(facts.title_blocks > 0
    ? { area: "Title blocks and schedules", severity: "Pass", status: "Pass", detail: `${facts.title_blocks} title block types · ${facts.schedules} schedules` }
    : { area: "Title blocks and schedules", severity: "Should", status: "No title block", detail: `${facts.schedules} schedules` });
  lines.push(facts.browser_organisations > 0
    ? { area: "Browser organisation", severity: "Pass", status: "Pass", detail: `${facts.browser_organisations} browser organisations` }
    : { area: "Browser organisation", severity: "Advice", status: "None", detail: "The project browser isn't organised" });
  lines.push({ area: "Size, unused families, warnings", severity: "Advice",
    status: `${facts.size_mb} MB · ${facts.unused_families} unused`,
    detail: `${facts.size_mb} MB · ${facts.unused_families} of ${facts.families} families unused · ${facts.warnings} warnings` });
  return lines;
}
