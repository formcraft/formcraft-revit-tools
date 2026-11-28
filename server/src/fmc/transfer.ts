/**
 * GAP-13 fmc_transfer: copy view templates, filters, legends, revisions and sheets between two open documents of the
 * same project. The plan matches by name (sheets by number, revisions by description and date). A name already in the
 * target is a duplicate (same signature) or a conflict (different signature). Neither is overwritten.
 */
import path from "node:path";
import { sameName } from "./gapcommon.js";

const win = path.win32;

export const TRANSFER_KINDS = ["view_templates", "filters", "legends", "revisions", "sheets"] as const;
export type TransferKind = typeof TRANSFER_KINDS[number];

export interface TransferItem {
  id: string;
  kind: TransferKind;
  name: string;
  /** Match key: sheet number for sheets, "description|date" for revisions, else the name. */
  key?: string;
  /** What must agree for a same-key item to be a duplicate rather than a conflict (view type, sheet name, categories). */
  signature?: string;
  detail?: Record<string, unknown>;
}

export interface TransferDoc {
  title: string;
  path: string;
  is_central?: boolean;
  project_number?: string;
  items: TransferItem[];
}

export interface TransferOp { kind: TransferKind; source_id: string; name: string; key: string }
export interface TransferNote { kind: TransferKind; name: string; key: string; code: string; message: string; source_signature?: string; target_signature?: string }

export interface TransferPlan {
  ops: TransferOp[];
  duplicates: TransferNote[];
  conflicts: TransferNote[];
  warnings: TransferNote[];
  counts: Record<string, { source: number; copy: number; duplicate: number; conflict: number }>;
}

export const TRANSFER_FIX: Record<string, string> = {
  "FMC-TRANSFER-DOCS": "fmc_transfer needs source and target, the titles or full paths of two documents already open.",
  "FMC-TRANSFER-PROJECT": "Source and target must be two different saved documents in the same project folder, with the same Project Number when both have one.",
  "FMC-TRANSFER-DUPLICATE": "The target already has this item with the same name and signature. It is not copied again.",
  "FMC-TRANSFER-CONFLICT": "The target has an item with this name or number that differs. It is not overwritten. Rename one side by hand, then plan again.",
  "FMC-TRANSFER-SOURCE-DUPLICATE": "The source has two items with this name. Neither is copied until one is renamed.",
  "FMC-TRANSFER-SHEET-NAME": "A target sheet already has this name under another number. The sheet is copied, but check the register.",
};

/** The project folder: the path above the first 0N_ folder (01_WIP, 02_Shared, 03_Published...). */
export function projectFolder(docPath: string): string {
  if (!docPath.trim()) return "";
  const segs = win.normalize(docPath.trim()).split("\\");
  const i = segs.findIndex((s, k) => k > 0 && /^0\d_/.test(s));
  return i > 0 ? segs.slice(0, i).join("\\") : "";
}

export function sameProject(a: TransferDoc, b: TransferDoc): { same: boolean; reason: string; folder: string } {
  if (!a.path.trim() || !b.path.trim()) return { same: false, reason: "A document has never been saved, so its project folder is unknown.", folder: "" };
  if (win.normalize(a.path).toLowerCase() === win.normalize(b.path).toLowerCase()) return { same: false, reason: "Source and target are the same document.", folder: "" };
  const fa = projectFolder(a.path);
  const fb = projectFolder(b.path);
  if (!fa || !fb) return { same: false, reason: "A document is not under a project folder (no 01_WIP, 02_Shared or similar folder in its path).", folder: "" };
  if (fa.toLowerCase() !== fb.toLowerCase()) return { same: false, reason: `Different project folders: ${fa} and ${fb}.`, folder: "" };
  const na = (a.project_number ?? "").trim();
  const nb = (b.project_number ?? "").trim();
  if (na && nb && na.toLowerCase() !== nb.toLowerCase()) return { same: false, reason: `Project Information numbers differ: ${na} and ${nb}.`, folder: "" };
  return { same: true, reason: "", folder: fa };
}

const keyOf = (item: TransferItem) => (item.key ?? item.name).trim();

export function planTransfer(source: TransferDoc, target: TransferDoc, kinds: readonly TransferKind[], names: string[] = []): TransferPlan {
  const wanted = new Set(kinds);
  const filter = names.map((n) => n.trim()).filter(Boolean);
  const plan: TransferPlan = { ops: [], duplicates: [], conflicts: [], warnings: [], counts: {} };
  for (const kind of kinds) plan.counts[kind] = { source: 0, copy: 0, duplicate: 0, conflict: 0 };
  const picked = source.items.filter((item) => wanted.has(item.kind)
    && (!filter.length || filter.some((n) => sameName(n, item.name) || sameName(n, keyOf(item)))));
  for (const item of picked) {
    const key = keyOf(item);
    const count = plan.counts[item.kind];
    count.source += 1;
    const twins = picked.filter((other) => other.kind === item.kind && sameName(keyOf(other), key));
    if (twins.length > 1) {
      plan.conflicts.push({ kind: item.kind, name: item.name, key, code: "FMC-TRANSFER-SOURCE-DUPLICATE", message: TRANSFER_FIX["FMC-TRANSFER-SOURCE-DUPLICATE"] });
      count.conflict += 1;
      continue;
    }
    const hit = target.items.find((t) => t.kind === item.kind && sameName(keyOf(t), key));
    if (hit) {
      const same = (hit.signature ?? "") === (item.signature ?? "");
      const note: TransferNote = {
        kind: item.kind, name: item.name, key,
        code: same ? "FMC-TRANSFER-DUPLICATE" : "FMC-TRANSFER-CONFLICT",
        message: TRANSFER_FIX[same ? "FMC-TRANSFER-DUPLICATE" : "FMC-TRANSFER-CONFLICT"],
        ...(same ? {} : { source_signature: item.signature ?? "", target_signature: hit.signature ?? "" }),
      };
      if (same) { plan.duplicates.push(note); count.duplicate += 1; } else { plan.conflicts.push(note); count.conflict += 1; }
      continue;
    }
    if (item.kind === "sheets") {
      const named = target.items.find((t) => t.kind === "sheets" && sameName(t.name, item.name));
      if (named) plan.warnings.push({ kind: "sheets", name: item.name, key, code: "FMC-TRANSFER-SHEET-NAME", message: `${TRANSFER_FIX["FMC-TRANSFER-SHEET-NAME"]} Target sheet ${keyOf(named)}.` });
    }
    plan.ops.push({ kind: item.kind, source_id: item.id, name: item.name, key });
    count.copy += 1;
  }
  return plan;
}
