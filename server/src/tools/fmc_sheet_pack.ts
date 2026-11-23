/**
 * fmc_sheets action pack. The read is fmc_sheets_layout. The write is fmc_sheets_layout_apply.
 * Both already take the batch lease. Overflow refuses the apply.
 */
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { SHEET_FIX, referenceProblems, resolveMargins, writeSheetReport } from "../fmc/sheetlayout.js";
import { packSheet, resolveZone, type PackView } from "../fmc/sheetpack.js";
import type { SheetLayoutIo } from "./fmc_sheet_layout.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export interface SheetPackArgs {
  document: string;
  sheet: string;
  views: string[];
  min_scale?: number;
  pair_small?: boolean;
  dry_run?: boolean;
  batch_lease?: string;
  references?: { kit?: string[]; standards?: string[]; rulebook?: string[] };
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_sheets",
    action: "pack",
    images: [] as [],
    saved: false,
    synced: false,
    cites: {
      kit: "FMC_TB_A0 FMC_TB_A1 drawing area",
      standards: "FMC-BIM-STD-002 sheets.margin_left_mm sheets.margin_other_mm sheets.gap_mm",
      rulebook: "Viewports stay inside the title block drawing area. Titles on a shelf share a baseline.",
    },
    ...extra,
  };
}

function asViews(raw: unknown): PackView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? "");
    const name = String(row.name ?? "");
    const modelW = Number(row.model_width_mm ?? row.width_mm ?? 0);
    const modelH = Number(row.model_height_mm ?? row.height_mm ?? 0);
    if (!id || !(modelW > 0) || !(modelH > 0)) return [];
    return [{
      id, name,
      sheet: typeof row.sheet === "string" ? row.sheet : typeof row.on_sheet === "string" ? row.on_sheet : undefined,
      model_width_mm: modelW,
      model_height_mm: modelH,
      title_mm: typeof row.title_mm === "number" ? row.title_mm : undefined,
      scale: typeof row.scale === "number" ? row.scale : undefined,
    }];
  });
}

export async function runSheetPack(args: SheetPackArgs, io: SheetLayoutIo = {}) {
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: SHEET_FIX["FMC-DOC-REQUIRED"] }, true);
    if (!args.sheet.trim()) return reply({ ...stamp(), refused: true, code: "FMC-SHEETS-SHEET", message: SHEET_FIX["FMC-SHEETS-SHEET"] }, true);
    const readBody = { document: args.document.trim(), action: "pack", sheet: args.sheet, views: args.views };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_sheets_layout", readBody, 180000));
    const payload = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (payload.refused === true) return reply({ ...stamp(), refused: true, code: String(payload.code ?? "FMC-SHEETS"), message: String(payload.message ?? "The read was refused.") }, true);
    const family = String(payload.family ?? "");
    const params = payload.params && typeof payload.params === "object" ? payload.params as Record<string, unknown> : {};
    const zoneChoice = payload.zone && typeof payload.zone === "object"
      ? { zone: payload.zone as { min_x: number; min_y: number; max_x: number; max_y: number }, source: "titleblock_param" as const, family, provisional: false }
      : resolveZone({ family, params });
    if ("code" in zoneChoice) return reply({ ...stamp(), refused: true, code: zoneChoice.code, message: zoneChoice.reason }, true);
    const margins = resolveMargins(null);
    const wanted = new Set(args.views.map((name) => name.trim().toLowerCase()).filter(Boolean));
    const onSheet = asViews(payload.views ?? payload.placed);
    const others = asViews(payload.others);
    const views = wanted.size
      ? onSheet.filter((view) => wanted.has(view.id.toLowerCase()) || wanted.has(view.name.toLowerCase()))
      : onSheet.filter((view) => !view.sheet || view.sheet === args.sheet);
    const packed = packSheet({
      views,
      others,
      zone: zoneChoice.zone,
      min_scale: args.min_scale,
      pair_small: args.pair_small,
      gap_mm: margins.gap_mm,
      sheet: args.sheet,
    });
    const moves = [
      ...packed.moves.map((move) => ({ ...move, from_other_sheet: false })),
      ...packed.proposed_pairs.map((move) => ({ ...move, from_other_sheet: true })),
    ];
    const overflow = packed.overflow.length > 0;
    const report = writeSheetReport(io.env ?? process.env, "pack", { sheet: args.sheet, zone: zoneChoice.zone, moves, overflow: packed.overflow }, io.reportDir);
    const dry = args.dry_run !== false;
    const summary = stamp({
      dry_run: dry,
      read_only: dry || overflow,
      document: String(payload.title ?? args.document),
      sheet: args.sheet,
      zone: zoneChoice.zone,
      zone_source: zoneChoice.source,
      family: zoneChoice.family,
      min_scale: args.min_scale,
      pair_small: args.pair_small,
      moves,
      overflow: packed.overflow,
      proposed_pairs: packed.proposed_pairs,
      report,
      ...(overflow ? { code: "FMC-SHEETS-OVERFLOW", message: SHEET_FIX["FMC-SHEETS-OVERFLOW"] } : {}),
    });
    if (dry) return reply({ ...summary, next: overflow ? "Apply is refused while a view overflows the drawing area." : "Nothing was moved. Apply with dry_run false, batch_lease, and references." });
    if (overflow) return reply({ ...summary, refused: true }, true);
    const lease = (args.batch_lease ?? "").trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: SHEET_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-SHEETS-REFERENCES", message: refsProblem }, true);
    if (!moves.length) return reply({ ...summary, refused: true, code: "FMC-SHEETS-VIEW", message: SHEET_FIX["FMC-SHEETS-VIEW"] }, true);
    const applyBody = { document: args.document.trim(), action: "pack", sheet: args.sheet, ops: moves, references: args.references ?? {} };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_sheets_layout_apply", applyBody, 180000)) as Record<string, unknown>;
    return reply({ ...summary, read_only: false, dry_run: false, applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-SHEETS";
    return reply({ ...stamp(), refused: true, code, message }, true);
  }
}
