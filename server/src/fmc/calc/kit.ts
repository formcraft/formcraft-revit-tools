/**
 * The kit's calculation values, read from FMC_Revit_Kit.xlsx (tabs Calculations, Electrical_Settings and the Calc_*
 * worksheets) with the server's own reader (readXlsxSheets, rowNumbers: true so rows[i] is sheet row i + 1). Data only:
 * nothing here writes to the kit, and nothing fills a gap: a value the kit doesn't have comes back null (TBC).
 */
import fs from "node:fs";
import path from "node:path";
import { readXlsxSheets } from "../xlsx.js";
import { num } from "./types.js";

const win = path.win32;

export type Tabs = Map<string, string[][]>;

/** The kit's numbers and text found by label, each with its cell. */
export interface KitNum { value: number; source: string }
export interface KitText { value: string; source: string }

export const KIT_WORKBOOK = "FMC_Revit_Kit.xlsx";

/** The kit workbook: <kit>\03_Master_Data\FMC_Revit_Kit.xlsx, or beside the guard's specs file. */
export function kitWorkbookPath(kitFolder: string, specsPath: string): string {
  return kitFolder.trim() ? win.join(kitFolder.trim(), "03_Master_Data", KIT_WORKBOOK) : win.join(win.dirname(specsPath), KIT_WORKBOOK);
}

export function readKitTabs(file: string): Tabs {
  return readXlsxSheets(fs.readFileSync(file), { rowNumbers: true });
}

/** Tabs from a JSON snapshot ({ tabs: { name: rows } }), as the tests use. */
export function tabsFromJson(json: { tabs: Record<string, string[][]> }): Tabs {
  return new Map(Object.entries(json.tabs));
}

export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** "kit:<tab>!<cell>" for a 0-based row index and column. */
export const kitRef = (tab: string, rowIndex: number, col: number) => `kit:${tab}!${colName(col)}${rowIndex + 1}`;

const cellOf = (rows: string[][] | undefined, r: number, c: number) => String(rows?.[r]?.[c] ?? "").trim();

/** The first row whose column A matches; its index, or -1. */
export function findRow(tabs: Tabs, tab: string, label: RegExp, col = 0): number {
  const rows = tabs.get(tab) ?? [];
  return rows.findIndex((r) => label.test(cellOf([r], 0, col)));
}

/** A number in the row labelled so (column A), at column col (B by default). */
export function labelled(tabs: Tabs, tab: string, label: RegExp, col = 1): KitNum | null {
  const r = findRow(tabs, tab, label);
  if (r < 0) return null;
  const v = num(cellOf(tabs.get(tab), r, col));
  return v === null ? null : { value: v, source: kitRef(tab, r, col) };
}

/** The numbers after the label in its row (a list of standard sizes). */
export function labelledList(tabs: Tabs, tab: string, label: RegExp): { values: number[]; source: string } | null {
  const r = findRow(tabs, tab, label);
  if (r < 0) return null;
  const row = tabs.get(tab)![r];
  const values = row.slice(1).map(num).filter((n): n is number => n !== null);
  return values.length ? { values, source: `kit:${tab}!B${r + 1}:${colName(row.length - 1)}${r + 1}` } : null;
}

/** A pattern searched for in the text of a cell: the first cell (column col) on the tab whose text matches. */
export function textMatch(tabs: Tabs, tab: string, re: RegExp, col?: number): { m: RegExpExecArray; source: string } | null {
  const rows = tabs.get(tab) ?? [];
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < (rows[r]?.length ?? 0); c++) {
      if (col !== undefined && c !== col) continue;
      const m = re.exec(cellOf(rows, r, c));
      if (m) return { m, source: kitRef(tab, r, c) };
    }
  return null;
}

/**
 * A table on a tab: the header row whose first cell matches, then the rows below it down to the first empty one, as
 * { cells, index } (index is the 0-based row).
 */
export function tableBelow(tabs: Tabs, tab: string, header: RegExp): Array<{ cells: string[]; index: number }> {
  const rows = tabs.get(tab) ?? [];
  const h = findRow(tabs, tab, header);
  if (h < 0) return [];
  const out: Array<{ cells: string[]; index: number }> = [];
  for (let r = h + 1; r < rows.length; r++) {
    const cells = (rows[r] ?? []).map((c) => String(c ?? "").trim());
    if (!cells.length || !cells[0] || /^total$/i.test(cells[0])) break;
    out.push({ cells, index: r });
  }
  return out;
}

/** The kit's Calculations register. */
export interface CalcRegisterRow { id: string; title: string; method: string; input: string; writes: string; tool: string; source: string }

export function calculationsRegister(tabs: Tabs): CalcRegisterRow[] {
  const rows = tabs.get("Calculations") ?? [];
  const out: CalcRegisterRow[] = [];
  rows.forEach((r, i) => {
    const id = String(r?.[0] ?? "").trim();
    if (!/^CA-/.test(id)) return;
    const c = (k: number) => String(r[k] ?? "").trim();
    out.push({ id, title: c(1), method: c(2), input: c(3), writes: c(4), tool: c(5), source: `kit:Calculations!A${i + 1}` });
  });
  return out;
}

/** Number words the kit writes in its rules ("at least two"). */
export function wordNumber(s: string): number | null {
  const n = num(s);
  if (n !== null) return n;
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const i = words.indexOf(s.toLowerCase());
  return i >= 0 ? i : null;
}
