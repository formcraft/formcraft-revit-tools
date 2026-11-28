import type { FabRead } from "./fabrication.js";

/** Shared by the fmc_fabrication tests (not a test itself): a model with a loaded configuration and a model without one. */
const anc = (id: number, name: string, usage: string, qty: number, type = "SupportRod") => ({ id, name, usage, type, code: `A${id}`, qty, length_mm: qty * 100 });
const part = (over: Record<string, unknown>) => ({
  id: 1, category: "MEP Fabrication Ductwork", level: "Level 1", service_id: 1, service: "Supply Air", spec_id: 1, spec: "Rect 1.0", material_id: 1, material: "Galvanised",
  insulation_id: 0, insulation: "", has_insulation: false, product: "Straight", size: "400x200", alias: "", item_number: "", length_mm: 1500, status_id: 0, status: "",
  validation: "Valid", iso_update: false, hanger: false, straight: true, bought_out: false, ends: 2, open_ends: 0, no_connections: false, anc: [], ...over,
});

export const LOADED: FabRead = {
  configured: true,
  config: { name: "FMC MEP Metric", description: "Test config", version: "7", product_version: "2025", path: "C:\\ProgramData\\Autodesk\\Fabrication\\FMC", guid: "00000000-0000-0000-0000-000000000001", unit_system: "Metric", is_cloud: false, is_locked: false, valid: true },
  services: [
    { id: 1, name: "Supply Air", abbreviation: "SA", loaded: true, used: true },
    { id: 2, name: "Extract Air", abbreviation: "EA", loaded: true, used: true },
    { id: 3, name: "Chilled Water", abbreviation: "CHW", loaded: false, used: false },
    { id: 4, name: "Heating Water", abbreviation: "HW", loaded: false, used: false },
  ],
  parts_total: 7, parts_truncated: false, notes: [],
  resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-M-0002_USER", path: "" },
  parts: [
    part({ id: 101, anc: [anc(1, "Rod M10", "Hanger", 2), anc(2, "Clip", "Stiffener", 1, "Clip")] }),
    part({ id: 102, level: "Level 2", service_id: 2, service: "Extract Air", has_insulation: true, insulation: "25mm Wrap", anc: [anc(1, "Rod M10", "Hanger", 2)] }),
    part({ id: 103, category: "MEP Fabrication Pipework", service_id: 3, service: "Chilled Water", spec: "", has_insulation: true, insulation: "19mm" }),
    part({ id: 104, service_id: 9, service: "Old Service", material: "", validation: "NoMaterial" }),
    part({ id: 105, service_id: 0, service: "", open_ends: 1 }),
    part({ id: 106, product: "Hanger", straight: false, hanger: true, ends: 0, anc: [anc(3, "Hanger kit", "Hanger", 1, "SupportRod")] }),
    part({ id: 107, level: "Level 2", iso_update: true, validation: "InvalidDimensions", open_ends: 2, anc: [anc(1, "Rod M10", "Hanger", 4)] }),
  ],
};

export const NONE: FabRead = { configured: false, message: "No fabrication configuration is loaded in this model.", fabrication_parts_in_model: 0, notes: [] };
export const NONE_WITH_PARTS: FabRead = { configured: false, message: "No fabrication configuration is loaded in this model. The model holds 12 FabricationPart(s).", fabrication_parts_in_model: 12, notes: [] };
