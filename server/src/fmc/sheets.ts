/**
 * Sheets against the project's sheet register (board manage/PaneSheets, U19). Pure.
 *
 * The register is the project's list of sheets that should exist: number, name, role and the issue sets each sheet is
 * in (STD 2.4). Sheet numbers come from the register, never typed by hand. Columns are matched by header, tolerantly.
 */
export interface RegisterSheet { number: string; name: string; role: string; sets: string[] }
export interface ModelSheet { id: number; number: string; name: string; views: number; fields: Record<string, string> }

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * F-043 (issue #144): the issue sets in one register cell. The kit's register joins them with "+"
 * (PERMIT+TENDER+CONSTRUCTION); hand-made registers use ; , / | & or "and". Each set is matched on its own.
 */
export const SET_SEPARATORS = /\s*(?:[+;,/|&]|\band\b)\s*/i;

export function splitSets(cell: string): string[] {
  return [...new Set(cell.split(SET_SEPARATORS).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

export function parseRegister(rows: string[][]): { sheets: RegisterSheet[]; problems: string[] } {
  const problems: string[] = [];
  const headerAt = rows.findIndex((r) => r.some((c) => ["number", "sheetnumber", "sheetno"].includes(norm(c))));
  if (headerAt < 0) return { sheets: [], problems: ["The register has no 'Number' column"] };
  const header = rows[headerAt].map(norm);
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const cNum = col("number", "sheetnumber", "sheetno"), cName = col("name", "sheetname", "title");
  const cRole = col("role", "discipline"), cSets = col("issuesets", "issueset", "sets", "stage", "issue");
  const sheets: RegisterSheet[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(headerAt + 1)) {
    const number = (r[cNum] ?? "").trim();
    if (!number) continue;
    if (seen.has(number)) { problems.push(`${number} is in the register twice`); continue; }
    seen.add(number);
    sheets.push({
      number, name: cName >= 0 ? (r[cName] ?? "").trim() : "",
      role: (cRole >= 0 ? r[cRole] ?? "" : number.split("-")[0]).trim().toUpperCase(),
      sets: cSets >= 0 ? splitSets(r[cSets] ?? "") : [],
    });
  }
  return { sheets, problems };
}

/**
 * The sheets the register plans for this issue set and these roles, by membership: a sheet is in PERMIT when PERMIT is
 * one of its sets (PERMIT+TENDER+CONSTRUCTION is). An issue_set naming several ("PERMIT+TENDER") takes a sheet in any
 * of them. A sheet with no sets listed is in every set.
 */
export function planned(register: RegisterSheet[], issueSet: string, roles: string[]): RegisterSheet[] {
  const wanted = splitSets(issueSet);
  const r = new Set(roles.map((x) => x.toUpperCase()));
  return register.filter((s) => (!s.sets.length || !wanted.length || wanted.some((w) => s.sets.includes(w))) && (!r.size || r.has(s.role)));
}

export interface SheetDiff { number: string; difference: "Missing" | "Extra" | "Name differs"; register_name: string; model_name: string; id?: number }

export function compare(plan: RegisterSheet[], model: ModelSheet[], roles: string[]): SheetDiff[] {
  const byNumber = new Map(model.map((m) => [m.number, m]));
  const planned = new Set(plan.map((p) => p.number));
  const r = new Set(roles.map((x) => x.toUpperCase()));
  const out: SheetDiff[] = [];
  for (const p of plan) {
    const m = byNumber.get(p.number);
    if (!m) out.push({ number: p.number, difference: "Missing", register_name: p.name, model_name: "" });
    else if (p.name && m.name.trim() !== p.name) out.push({ number: p.number, difference: "Name differs", register_name: p.name, model_name: m.name, id: m.id });
  }
  for (const m of model)
    if (!planned.has(m.number) && (!r.size || r.has(m.number.split("-")[0].toUpperCase())))
      out.push({ number: m.number, difference: "Extra", register_name: "", model_name: m.name, id: m.id });
  return out.sort((a, b) => a.number.localeCompare(b.number));
}

export interface Completeness { number: string; name: string; views: number; filled: number; fields: number; status: "Done" | "In work" | "Due"; percent: number }

/** How far each planned sheet has come: views placed and title block fields filled (SHT-039). */
export function completeness(plan: RegisterSheet[], model: ModelSheet[]): Completeness[] {
  const byNumber = new Map(model.map((m) => [m.number, m]));
  return plan.map((p) => {
    const m = byNumber.get(p.number);
    if (!m) return { number: p.number, name: p.name, views: 0, filled: 0, fields: 0, status: "Due", percent: 0 };
    const values = Object.values(m.fields);
    const filled = values.filter((v) => v.trim()).length;
    const percent = Math.round(100 * ((m.views > 0 ? 0.5 : 0) + (values.length ? 0.5 * filled / values.length : 0.5)));
    const status = m.views > 0 && filled === values.length ? "Done" : m.views > 0 || filled > 0 ? "In work" : "Due";
    return { number: p.number, name: m.name, views: m.views, filled, fields: values.length, status, percent };
  });
}

/** Sheet numbers follow [Role]-[Series][Number], e.g. A-1001 (the register's series rule). */
export function numberOk(n: string) { return /^[A-Z]{1,2}-\d{4}$/.test(n); }
